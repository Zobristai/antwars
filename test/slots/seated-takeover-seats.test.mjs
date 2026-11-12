// A house match whose seats are seated but whose match has not begun, when a second
// instance of the same revision takes the slot: both seats still join, pick and play, and
// the result is rated as usual. The seats are the real seat client (packages/antwars-seat),
// which is plain JavaScript and so is tested from this .mjs file. Both seats reach the slot
// through one address, as players do: a small front proxy sends every request to the slot's
// registered instance, so once the newcomer registers every request reaches it, sessions
// opened on the earlier instance included.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { joinSeat, matchClient } from "../../packages/antwars-seat/lib/match.mjs";
import { errorCode } from "../../packages/antwars-seat/lib/mcp.mjs";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/** A 4 s match (80 ticks at 20 per second) that reaches its natural time-up result. */
const MATCH = playable(shortConfig(80, { ticksPerSecond: 20, queenFounding: PUBLIC_CONFIG.queenFounding }));
/** The lobby's countdown: long enough that the takeover below happens before its match begins. */
const COUNTDOWN_MS = 4000;
/** The nest-pick window: every seat must pick in it, as in every index match. */
const WINDOW_MS = 3000;
const MODE = "house-1v1";

const servers = [];
const proxies = [];
const dirs = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) await new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()); });
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function until(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** One shared store; a rated house-1v1 queue match already holding public-0. */
async function world() {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("SeatA")), b = value(await w.ids.claimUsername("SeatB"));
  const lobbies = createLobbies(w.store, w.ids, { countdownMs: COUNTDOWN_MS });
  const ratings = createRatings(w.store, w.ids);
  const lobby = await w.store.transaction(async (read) => {
    const paired = await lobbies.queuedMatchWrites(read, { mode: MODE, colonies: [[a.identity], [b.identity]] }, Date.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  expect(lobby.slot).toBe("public-0");
  return {
    w, lobbies, lobby, keys: [a.key, b.key],
    outcome: async () => value(await lobbies.readLobby(lobby.id)).outcome,
    rated: async () => Promise.all([a, b].map(async (key) => (await ratings.readRating(key.identity.id, MODE)).ratedMatches)),
  };
}

/** A slot server of revision r1 for public-0 named `name`; resolves once it holds the slot. */
async function slotServer(t, name) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir, simConfig: MATCH, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: WINDOW_MS,
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: t.lobbies, identities: t.w.ids, pollMs: 20, revision: "r1" },
  });
  servers.push(server);
  return server;
}

/**
 * The slot's one address. Each request goes to the instance the store names as the slot's,
 * by its public name in `ports`. holdNextInitialized(run) holds the next initialized
 * notification until run() resolves, then sends it on to the instance registered by then.
 */
async function routingProxy(t, ports) {
  let hold = null;
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (hold !== null && body.length > 0 && JSON.parse(body.toString("utf8")).method === "notifications/initialized") {
      const run = hold;
      hold = null;
      await run();
    }
    const instance = await t.lobbies.resolveSlot("public-0");
    const port = ports.get(new URL(instance.mcpUrl).hostname);
    const upstream = request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.once("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    upstream.end(body);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  proxies.push(proxy);
  return {
    url: `http://127.0.0.1:${proxy.address().port}/mcp`,
    holdNextInitialized(run) {
      hold = run;
    },
  };
}

/** A seat as the seat client's go builds it: its own state folder, its key, seat 1. */
function seat(key, url) {
  const dir = mkdtempSync(join(tmpdir(), "antwars-seat-takeover-"));
  dirs.push(dir);
  const env = { ANTWARS_SEAT_STATE: join(dir, "state") };
  const ctx = { config: { seat: 1 }, env, key, limiter: async () => {},
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } };
  const steps = () => readFileSync(join(dir, "state", "progress.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).step);
  return { ctx, client: matchClient(ctx, url), steps };
}

/** The seat's join, through the seat client; it fails as the seat client's go does. */
async function joined(s) {
  const reply = await joinSeat(s.client, s.ctx);
  if (!reply.ok) throw new Error(`join refused: ${errorCode(reply.data)}`);
  return reply.data;
}

/** observe until the nest window is open on the seat's server: its nestSelection, with terrain. */
async function nestWindow(s) {
  return until(async () => {
    const seen = await s.client.callTool("observe", {});
    return seen.ok && seen.data.nestSelection ? seen.data.nestSelection : undefined;
  }, COUNTDOWN_MS + 10_000);
}

/** The first free tile of the seat's start box. */
function freeTile(selection) {
  for (const [dy, row] of selection.terrain.rows.entries()) {
    const dx = [...row].indexOf(".");
    if (dx >= 0) return { tileX: selection.box.x + dx, tileY: selection.box.y + dy };
  }
  throw new Error("no free tile");
}

describe("a seated house match whose slot a same-revision instance takes before the match begins", { timeout: 60_000 }, () => {
  it("is still played: a seat whose handshake the takeover splits and a seat that joined before it both join the newcomer, pick, and the result is rated", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const ports = new Map();
    const owner = await slotServer(t, "owner");
    ports.set("owner.test", owner.port);
    const ownerRun = (await t.lobbies.resolveSlot("public-0")).runId;
    await until(() => owner.game.nextStart?.kind === "scheduled");
    const proxy = await routingProxy(t, ports);

    // Seat B joins the owner's seated lobby before the takeover.
    const seatB = seat(t.keys[1], proxy.url);
    expect((await joined(seatB)).agentId).toEqual(expect.any(String));

    // Seat A's initialize reaches the owner; before its initialized notification arrives, a newcomer
    // of the same revision starts and takes the slot, so the notification reaches the newcomer.
    let newcomer = null;
    proxy.holdNextInitialized(async () => {
      newcomer = await slotServer(t, "next");
      ports.set("next.test", newcomer.port);
    });
    const seatA = seat(t.keys[0], proxy.url);
    const joinedA = await joined(seatA);
    expect(joinedA.agentId).toEqual(expect.any(String));
    expect(newcomer).not.toBeNull();
    const nextRun = (await t.lobbies.resolveSlot("public-0")).runId;
    expect(nextRun).not.toBe(ownerRun);
    expect(seatA.steps()).toContain("session_gone");

    // Seat B's session was on the owner: its next call reaches the newcomer, which does not know it,
    // so the seat client initializes again there and rejoins its seat.
    const windowB = await nestWindow(seatB);
    expect(seatB.steps()).toEqual(expect.arrayContaining(["session_gone", "rejoined"]));
    const windowA = await nestWindow(seatA);
    // The match began on the newcomer, which opened the window both seats now see.
    expect(await t.lobbies.slotHolder("public-0")).toMatchObject({ lobbyId: t.lobby.id, matchRunId: nextRun });
    expect(windowB.required).toBe(true);

    // Both seats pick after the takeover, and both picks count in the newcomer's window.
    for (const [s, selection] of [[seatA, windowA], [seatB, windowB]]) {
      const tile = freeTile(selection);
      const picked = await s.client.callTool("pick_nest", tile);
      expect(picked.ok, JSON.stringify(picked.data)).toBe(true);
      const seen = await s.client.callTool("observe", {});
      expect(seen.data.nestSelection.picks.filter((pick) => pick.mine)).toEqual([expect.objectContaining(tile)]);
    }

    // The match starts once the window closes and plays to its natural result, rated once for each seat.
    await until(() => newcomer.game.match !== null, WINDOW_MS + 10_000);
    expect(await until(async () => (await t.outcome()) ?? undefined, 30_000)).toMatch(/^(colony_[01]_won|draw)$/);
    expect(await t.rated()).toEqual([1, 1]);
    expect(owner.game.match).toBeNull();
  });
});
