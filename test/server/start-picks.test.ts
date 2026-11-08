import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { COUNTDOWN_MS, createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { createFirestore } from "../../src/store/firestore.js";
import { startServer, type GameServer } from "../../src/server.js";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG } from "../../src/sim/config.js";
import { playable } from "../playable.js";
import { connect, tempDir, type Agent } from "./helpers.js";

// Every match plays at grid scale 2: main's templates are built through the one constructor.
const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
let server: GameServer | undefined;
let agent: Agent | undefined;
// The slot server's public origin must answer: its self-probe (GET /wake) and the
// keep-alive (GET /keep-alive) request it, and either logs console.error when it fails.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
afterEach(async () => {
  await agent?.close(); agent = undefined;
  await server?.close(); server = undefined;
  vi.restoreAllMocks();
});

// Real store seating and beginMatch, real Game, real HTTP MCP and feed boundary.
// Capture the configured timer and advance the clock instead of sleeping.
// The unset case exercises the production two-minute window; the explicit case exercises the test seam.
describe.skipIf(!emulatorHost)("lobby queen window on the slot server", () => {
  it("keeps the production lobby countdown at ten seconds", () => {
    expect(COUNTDOWN_MS).toBe(10_000);
  });
  it.each([
    ...[undefined, 2_000].flatMap(startPickWindowMs => ["early", "on-time", "late"].map(timing => ({ startPickWindowMs, timing, completion: "start" }))),
    { startPickWindowMs: 2_000, timing: "early", completion: "close" },
    { startPickWindowMs: 2_000, timing: "early", completion: "supersede" },
  ])("keeps picks through $timing callbacks and $completion (duration $startPickWindowMs)", async ({ startPickWindowMs, timing, completion }) => {
    const windowMs = startPickWindowMs ?? 120_000;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const namespace = `pick-${process.pid}-${Date.now()}`;
    const store = () => createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
    const identities = createIdentities(store());
    const lobbies = createLobbies(store(), identities, { countdownMs: 100 });
    const ratings = createRatings(store());
    const keys = [];
    for (let i = 0; i < 8; i++) {
      const claimed = await identities.claimUsername(`Player-${i}`);
      if (!claimed.ok) throw new Error(claimed.reason);
      keys.push(claimed.value);
    }
    const created = await lobbies.createLobby(keys[0]!.key, "public", 4);
    if (!created.ok) throw new Error(created.reason);
    for (const key of keys) {
      const joined = await lobbies.join(created.value.lobby.id, key.key);
      if (!joined.ok) throw new Error(joined.reason);
    }
    let controlledNow: number | undefined;
    const realNow = Date.now;
    let lastClockRead = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (lastClockRead = controlledNow ?? realNow()));
    let closeWindow: { fire: () => void; delay: number; handle: NodeJS.Timeout } | undefined;
    let captureRetry = false;
    let rebuiltDeadline = 0;
    let schedulingSkew = 0;
    const realTimeout = globalThis.setTimeout;
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const initial = closeWindow === undefined && delay !== undefined && delay > windowMs - 1_000 && delay <= windowMs;
      if (initial || captureRetry) {
        if (initial) {
          // The server just read the clock to compute closesAt - Date.now().
          // Time can advance before this spy observes the timer being armed.
          const delayComputedAt = lastClockRead;
          const timerArmedAt = Date.now();
          schedulingSkew = timerArmedAt - delayComputedAt;
          rebuiltDeadline = timerArmedAt + delay!;
        }
        // Return a real cancellable handle without running the captured callback.
        const handle = realTimeout(() => {}, 120_000);
        closeWindow = { handle, delay: delay!, fire: () => { clearTimeout(handle); callback(...args); } };
        return handle;
      }
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const starts: { tick: number; queens: number[] }[] = [];
    const ticks: number[] = [];
    const port = await freePort();
    server = await startServer({ port, host: "127.0.0.1", dataDir: tempDir(), seed: 7001,
      simConfig: PUBLIC_CONFIG, startPickWindowMs, accounts: { identities, lobbies, ratings },
      feed: { matchStarted: (_seq, state) => starts.push({ tick: state.tick, queens: state.colonies.map(c => c.queens!.length) }),
        ticked: (_seq, out) => ticks.push(out.state.tick) },
      slot: { slot: "public-0", publicUrl: `http://127.0.0.1:${port}`, lobbies, identities, pollMs: 10 },
    });
    const waitUntil = realNow() + 20_000;
    while (!closeWindow) {
      if (realNow() > waitUntil) throw new Error("No pick window was scheduled");
      await sleep(10);
    }
    const scheduled = server.game.nextStart;
    if (scheduled?.kind !== "scheduled") throw new Error("No authoritative pick deadline");
    const deadline = scheduled.at.getTime();
    expect(schedulingSkew).toBeGreaterThanOrEqual(0);
    expect(rebuiltDeadline).toBeGreaterThanOrEqual(deadline);
    expect(rebuiltDeadline - deadline).toBeLessThanOrEqual(schedulingSkew);
    expect(deadline - Date.now()).toBeGreaterThan(windowMs - 1_000);
    expect(server.game.match).toBeNull(); expect(starts).toEqual([]); expect(ticks).toEqual([]);
    agent = await connect(server.port);
    const joined = await agent.call("join", { key: keys[0]!.key });
    expect(joined.isError).toBe(false);
    expect(Date.parse(joined.data.matchStarts)).toBe(deadline);
    const picked = await agent.call("pick_nest", { tileX: 9, tileY: 24 });
    expect(picked.isError).toBe(false);
    const read = await lobbies.readLobby(created.value.lobby.id);
    expect(read.ok).toBe(true);
    const assertNoLayout = (value: unknown): void => {
      const text = JSON.stringify(value);
      for (const field of ["nestSelection", "initialQueens", "startBoxes", "startingQueenIds", "tileX", "tileY", "queenX", "queenY"]) {
        expect(text).not.toContain(`"${field}"`);
      }
    };
    assertNoLayout(read);
    for (const [name, args] of [["list_lobbies", {}], ["read_lobby", { lobbyId: created.value.lobby.id, key: keys[1]!.key }], ["leaderboard", {}]] as const) {
      const http = await fetch(`http://127.0.0.1:${server.port}/api/${name}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
      expect(http.status).toBe(200); assertNoLayout(await http.json());
      const mcp = await agent.call(name, args);
      expect(mcp.isError).toBe(false); assertNoLayout(mcp.data);
    }
    expect(server.game.match).toBeNull(); expect(starts).toEqual([]);
    if (timing === "early") {
      // Fire twice with the wall clock frozen 1 ms before the authoritative
      // deadline: the original bug discarded the lobby on the first callback.
      controlledNow = deadline - 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        const previous = closeWindow!;
        captureRetry = true;
        try { previous.fire(); } finally { captureRetry = false; }
        expect(server.game.match).toBeNull(); expect(starts).toEqual([]); expect(ticks).toEqual([]);
        expect(server.game.nextStart).toEqual({ kind: "scheduled", at: new Date(deadline) });
        expect(errors).not.toHaveBeenCalled();
        expect(closeWindow).not.toBe(previous);
        expect(closeWindow!.delay).toBe(1);
      }
      const pendingLobby = await lobbies.readLobby(created.value.lobby.id);
      expect(pendingLobby.ok && pendingLobby.value.outcome).toBeNull();
    }
    if (completion !== "start") {
      const pending = closeWindow!.handle;
      clearTimer.mockClear();
      if (completion === "close") {
        await agent.close(); agent = undefined;
        await server.close(); server = undefined;
      } else {
        await lobbies.registerInstance("public-0", { runId: "successor", mcpUrl: "http://successor.test/mcp", spectatorUrl: "http://successor.test/" });
        const abandonBy = realNow() + 20_000;
        while (server!.game.nextStart !== null) {
          if (realNow() > abandonBy) throw new Error("Pending start was not abandoned");
          await sleep(10);
        }
      }
      expect(clearTimer).toHaveBeenCalledWith(pending);
      controlledNow = deadline;
      expect(starts).toEqual([]); expect(ticks).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      return;
    }
    controlledNow = deadline + (timing === "late" ? 10 : 0);
    const tooLate = await agent.call("pick_nest", { tileX: 10, tileY: 24 });
    expect(tooLate.data.error.code).toBe("nest_window_closed");
    closeWindow!.fire();
    expect(errors).not.toHaveBeenCalled();
    expect(starts).toEqual([{ tick: 0, queens: [4, 4] }]);
    expect(ticks).toEqual([1]);
    expect(server.game.match!.state.tick).toBe(1);
    expect(server.game.match!.state.config.initialQueens!.map(team => team.length)).toEqual([4, 4]);
    expect(server.game.match!.state.config.initialQueens![0][0]).toEqual({ tileX: 9, tileY: 24 });
  }, 30_000);
});
