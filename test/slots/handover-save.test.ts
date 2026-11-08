/// <reference types="node" />
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeGameSave, encodeGameSave } from "../../src/handover/matchSave.ts";
import { createMatchSaves, type SaveObjects } from "../../src/handover/saveStore.ts";
import type { SpectatorSave } from "../../src/live/handover.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type Lobbies } from "../../src/lobby/lobbies.ts";
import { Game, NOT_APPLIED_RETRY_MS } from "../../src/mcp/game.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { SLOT_READY_PATH, startServer, type GameServer, type MatchFeed, type SlotWiring } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { KEEP_ALIVE_PATH } from "../../src/slots/keepAlive.ts";
import { startSpectatedServer, type HandoverHub } from "../../src/spectator.ts";
import { memoryObjects, testFirestore } from "../handover/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, type Agent } from "../server/helpers.ts";

// A server superseded by a same-release server while it plays its
// begun match, or sent Cloud Run's shutdown signal, stops the match at a tick, answers the
// calls it had not applied not_applied with a retry hint, saves the match with one save step,
// answers every request 503, and exits only once the save has finished or failed.
//
// The save path is production code throughout: the slot runner (src/slots/slotServer.ts)
// dispatches the handover when another instance takes the slot, Game.saveMatch captures the
// match, and createMatchSaves writes it through the repository's Firestore client (on the
// emulator when FIRESTORE_EMULATOR_HOST is set) into an in-memory record-input bucket, whose
// object writes these tests hold back or fail. The lobbies use the serialized in-memory store of
// live-owner.test.ts. The spectator side of the save is a feed double: Spectator save wiring
// owns it.

/** Two ticks a second: a call made just after a tick waits half a second for the next. */
const SLOW = playable(shortConfig(60_000, { ticksPerSecond: 2, queenFounding: PUBLIC_CONFIG.queenFounding }));
const ROOT = join(import.meta.dirname, "..", "..");

const servers: GameServer[] = [];
const agents: Agent[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** One shared store with a rated 1v1 queue match holding public-0, its countdown countdownMs. */
async function world(countdownMs = 300) {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("SaveA")), b = value(await w.ids.claimUsername("SaveB"));
  const lobbies = createLobbies(w.store, w.ids, { countdownMs });
  const lobby = await w.store.transaction(async (read) => {
    const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  return { w, lobbies, lobby, keys: [a.key, b.key] as const, identities: [a.identity.id, b.identity.id] as const };
}

/**
 * The handover save store (createMatchSaves) over the test Firestore and an in-memory bucket.
 * Every object write waits until release() (or fails with release(failure)); begun() counts the
 * saves begun, one game object each.
 */
function saveStore() {
  const bucket = memoryObjects();
  const names: string[] = [];
  let release!: (failure?: Error) => void;
  const released = new Promise<Error | undefined>((resolve) => { release = resolve; });
  const objects: SaveObjects = {
    async put(name, body) {
      names.push(name);
      const failure = await released;
      if (failure !== undefined) throw failure;
      await bucket.put(name, body);
    },
    get: (name) => bucket.get(name),
  };
  const saves = createMatchSaves(testFirestore().store, objects);
  return { saves, release, begun: () => names.filter((name) => name.endsWith("/game")).length };
}

/** A spectator feed double recording when the save step asks for its part. */
function feedDouble(server: () => GameServer | undefined) {
  const spectator: SpectatorSave = { meta: JSON.stringify({ viewers: 1 }), parts: new Map([["stream", new Uint8Array([1, 2, 3])]]) };
  const asked: { seq: number; tick: number | undefined }[] = [];
  const feed: MatchFeed = {
    matchStarted() {}, ticked() {},
    async saveSpectator(seq) {
      asked.push({ seq, tick: server()?.game.match?.state.tick });
      return spectator;
    },
  };
  return { feed, spectator, asked };
}

type Wiring = Partial<Pick<SlotWiring, "revision" | "heartbeatMs" | "staleMs" | "saves" | "onRetired">>;

async function slotServer(w: Awaited<ReturnType<typeof world>>, name: string, wiring: Wiring, feed?: MatchFeed, startPickWindowMs = 100) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir, simConfig: SLOW, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs,
    ...(feed === undefined ? {} : { feed }),
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: w.lobbies, identities: w.w.ids, pollMs: 20, ...wiring },
  });
  servers.push(server);
  return server;
}

/** The run that began the slot's match: the lobby's matchRunId. */
const begun = (lobbies: Lobbies) => until(async () => (await lobbies.slotHolder("public-0"))?.matchRunId ?? undefined);
const status = async (port: number, path: string, init?: RequestInit) => (await fetch(`http://127.0.0.1:${port}${path}`, init)).status;
const mcpInitialize = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "handover-test", version: "0" } } }) };

/** A same-release server that starts and takes the slot: the owner's heartbeat is older than its staleness window. */
const takeSlot = (w: Awaited<ReturnType<typeof world>>) => slotServer(w, "newcomer", { revision: "r1", staleMs: 200 });

/**
 * The owner plays its begun match with a seated agent; just after a tick, the agent's order
 * waits for the next one when a same-release newcomer takes the slot.
 */
async function supersededWithPendingOrder(wiring: Wiring) {
  const w = await world();
  let owner: GameServer | undefined;
  const spectator = feedDouble(() => owner);
  owner = await slotServer(w, "owner", { revision: "r1", ...wiring }, spectator.feed);
  const matchRunId = await begun(w.lobbies);
  const agent = await connect(owner.port);
  agents.push(agent);
  await until(async () => !(await agent.call("join", { key: w.keys[0] })).isError);
  // Seated during the pick window, the agent enters the match on its first tick.
  await until(() => (owner.game.match?.state.agents.length ?? 0) > 0);
  const from = owner.game.match!.state.tick;
  await until(() => owner.game.match!.state.tick > from);
  const order = agent.call("order", { kind: "forage" });
  await until(() => (owner.game as Game).pendingInputs > 0);
  await takeSlot(w);
  return { ...w, owner, matchRunId, agent, order: await order, spectator };
}

describe("a server superseded by a same-release server while it plays its begun match", { timeout: 30_000 }, () => {
  it("stops the match at a tick, answers the call it had not applied not_applied with a retry hint, and saves the match", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = saveStore();
    let retired = 0;
    const { owner, lobby, matchRunId, order, spectator } = await supersededWithPendingOrder({ saves: store.saves, onRetired: () => { retired += 1; } });

    // The order reached the owner before its next tick and was not applied.
    expect(order.isError).toBe(true);
    const stoppedAt = owner.game.match!.state.tick;
    expect(order.data).toMatchObject({ error: { code: "not_applied" }, retryAfterMs: NOT_APPLIED_RETRY_MS, tick: stoppedAt });
    expect(order.data.retryAfterMs).toBeGreaterThan(0);
    expect(order.data.error.howToFix).toContain(`Wait ${NOT_APPLIED_RETRY_MS} ms (retryAfterMs)`);

    // One save, at the tick it stopped at, naming this run as the last to advance the match; the
    // spectator part is taken after the stop, at that same tick. Read back through the store, it
    // holds the match exactly as the stopped game captures it.
    await until(() => store.begun() === 1);
    expect(spectator.asked).toEqual([{ seq: owner.game.match!.seq, tick: stoppedAt }]);
    store.release();
    await until(() => retired === 1);
    const saved = await store.saves.read(lobby.id);
    expect(saved).toMatchObject({ format: 1, lobbyId: lobby.id, revision: "r1", savedByRunId: matchRunId, tick: stoppedAt, spectator: spectator.spectator });
    expect(saved!.game.tick).toBe(stoppedAt);
    expect(saved!.game).toEqual(decodeGameSave(encodeGameSave((owner.game as Game).saveMatch())));
    expect(store.begun()).toBe(1);
    expect(owner.game.match!.state.tick).toBe(stoppedAt);
  });

  it("neither advances the match nor answers any request but 503 while it saves, and exits only after the save has finished", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = saveStore();
    let retired = 0;
    const { owner, lobby } = await supersededWithPendingOrder({ saves: store.saves, onRetired: () => { retired += 1; } });
    await until(() => store.begun() === 1);
    const stoppedAt = owner.game.match!.state.tick;

    // Three tick periods later, the save still in flight: no tick, no exit, and every route answers 503.
    await sleep(1500);
    expect(owner.game.match!.state.tick).toBe(stoppedAt);
    expect(owner.game.match!.result).toBeNull();
    expect(retired).toBe(0);
    for (const path of [SLOT_READY_PATH, "/wake", `/lobbies/${lobby.id}/match`, KEEP_ALIVE_PATH, "/"]) expect(await status(owner.port, path)).toBe(503);
    expect(await status(owner.port, "/mcp", mcpInitialize)).toBe(503);

    // The save finishes: only then does the server close and signal retirement, once.
    store.release();
    await until(() => retired === 1);
    expect(await store.saves.read(lobby.id)).toMatchObject({ lobbyId: lobby.id, tick: stoppedAt });
    await expect(fetch(`http://127.0.0.1:${owner.port}/wake`)).rejects.toThrow();
    await sleep(600);
    expect(retired).toBe(1);
    expect(owner.game.match!.state.tick).toBe(stoppedAt);
  });

  it("exits only after a failed save has failed, still without advancing the match", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failures = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = saveStore();
    let retired = 0;
    const { owner, lobby } = await supersededWithPendingOrder({ saves: store.saves, onRetired: () => { retired += 1; } });
    await until(() => store.begun() === 1);
    const stoppedAt = owner.game.match!.state.tick;
    await sleep(600);
    expect(retired).toBe(0);

    store.release(new Error("bucket unavailable"));
    await until(() => retired === 1);
    expect(failures.mock.calls.some(([line]) => String(line).includes("failed") && String(line).includes("bucket unavailable"))).toBe(true);
    expect(await store.saves.read(lobby.id)).toBeNull();
    expect(owner.game.match!.state.tick).toBe(stoppedAt);
  });

  it("saves a begun match still in its nest-pick start at tick 0, with no spectator side, and starts no match here", async () => {
    // Its resume by the next same-release server: test/slots/nest-pick-handover.test.ts.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = await world();
    const store = saveStore();
    store.release();
    let retired = 0;
    const owner = await slotServer(w, "owner", { revision: "r1", saves: store.saves, onRetired: () => { retired += 1; } }, undefined, 60_000);
    await begun(w.lobbies);
    await until(() => owner.game.startWindowConfig !== null);
    expect(owner.game.nextStart?.kind).toBe("scheduled");

    await takeSlot(w);
    await until(() => retired === 1);
    expect(owner.game.match).toBeNull();
    expect(store.begun()).toBe(1);
    const save = await store.saves.read(w.lobby.id);
    expect(save).toMatchObject({ lobbyId: w.lobby.id, revision: "r1", tick: 0, spectator: null });
    expect(save!.game.phase).toBe("start");
  });
});

describe("Cloud Run's shutdown signal while the server owns a begun match", { timeout: 30_000 }, () => {
  it("stops the match and saves it with the same save step before the process exits, within the 10 s shutdown period", async () => {
    const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/slots/handover-shutdown-child.ts"], {
      cwd: ROOT, env: { ...process.env, SAVE_MS: "500" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const line = (prefix: string) => output.split("\n").find((l) => l.startsWith(`${prefix} `))?.slice(prefix.length + 1);
    try {
      const running = JSON.parse(await until(() => line("RUNNING"), 20_000));
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      const elapsed = Date.now() - signalledAt;

      const saved = JSON.parse(line("SAVED") ?? "null") as { lobbyId: string; revision: string; savedByRunId: string; tick: number; gameTick: number } | null;
      const exit = JSON.parse(line("EXIT") ?? "null") as { code: number; tick: number } | null;
      expect(saved, output).toMatchObject({ lobbyId: running.lobbyId, revision: "r1", savedByRunId: running.matchRunId });
      // Saved, and read back from the store, before exiting, at the tick the match stopped at: it
      // did not advance after the save step stopped it.
      expect(output.indexOf("SAVED ")).toBeLessThan(output.indexOf("EXIT "));
      expect(exit).toEqual({ code: 0, tick: saved!.tick });
      expect(saved!.gameTick).toBe(saved!.tick);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("waits for a supersession save already under way rather than saving again, then closes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = saveStore();
    const { owner } = await supersededWithPendingOrder({ saves: store.saves });
    await until(() => store.begun() === 1);
    let shutDown = false;
    const shutdown = owner.shutdown(5000).then(() => { shutDown = true; });
    await sleep(300);
    expect(shutDown).toBe(false);
    store.release();
    await shutdown;
    expect(store.begun()).toBe(1);
    await expect(fetch(`http://127.0.0.1:${owner.port}/wake`)).rejects.toThrow();
  });

  it("shares its save with a supersession that arrives while it saves, and retires only after the save has finished", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = await world();
    const store = saveStore();
    let retired = 0;
    const owner = await slotServer(w, "owner", { revision: "r1", saves: store.saves, onRetired: () => { retired += 1; } });
    const matchRunId = await begun(w.lobbies);
    await until(() => (owner.game.match?.state.tick ?? 0) > 0);
    const shutdown = owner.shutdown(5000);
    await until(() => store.begun() === 1);
    // Superseded mid-save, the runner hands the match over: the server keeps the save under way.
    await takeSlot(w);
    await sleep(300);
    expect(retired).toBe(0);
    store.release();
    await shutdown;
    await until(() => retired === 1);
    expect(store.begun()).toBe(1);
    expect(await store.saves.read(w.lobby.id)).toMatchObject({ savedByRunId: matchRunId, tick: owner.game.match!.state.tick });
  });

  it("closes once its time for the save is up, even while the save is still writing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = await world();
    const store = saveStore();
    const owner = await slotServer(w, "owner", { revision: "r1", saves: store.saves });
    await begun(w.lobbies);
    await until(() => (owner.game.match?.state.tick ?? 0) > 0);
    const startedAt = Date.now();
    await owner.shutdown(300);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(store.begun()).toBe(1);
    await expect(fetch(`http://127.0.0.1:${owner.port}/wake`)).rejects.toThrow();
  });

  it("without a begun match, closes at once and saves nothing, as before", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // A 60 s countdown: the lobby is seated but its match has not begun.
    const w = await world(60_000);
    const store = saveStore();
    const owner = await slotServer(w, "owner", { revision: "r1", saves: store.saves });
    await until(() => owner.game.nextStart?.kind === "scheduled");
    await owner.shutdown(5000);
    expect(store.begun()).toBe(0);
    await expect(fetch(`http://127.0.0.1:${owner.port}/wake`)).rejects.toThrow();
  });
});

describe("a failed spectator save on a spectated slot server", { timeout: 60_000 }, () => {
  // If saving the stream or recording state fails, the match ends not_played with no
  // rating writes, as for any failed save. End to end through
  // startSpectatedServer's own spectator hooks (Spectator save wiring) and the real save
  // step. The live hub's save of the match's stream and recording state is made to reject on the superseded owner's hub.
  it("ends the match not played with no rating writes, and leaves no save", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failures = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    const accounts = { identities: w.w.ids, lobbies: w.lobbies, ratings: createRatings(w.w.store, w.w.ids) };
    const watchRegistry = createWatchRegistry(w.w.store);
    const store = saveStore();
    store.release();
    const spectated = async (name: string, wiring: Wiring) => {
      const dataDir = tempDir();
      dirs.push(dataDir);
      const server = await startSpectatedServer({
        port: 0, host: "127.0.0.1", dataDir, simConfig: SLOW, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100, accounts, watchRegistry,
        slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: w.lobbies, identities: w.w.ids, pollMs: 20, revision: "r1", saves: store.saves, ...wiring },
      });
      servers.push(server);
      return server;
    };
    let retired = 0;
    const owner = await spectated("owner", { onRetired: () => { retired += 1; } });
    await begun(w.lobbies);
    await until(() => (owner.game.match?.state.tick ?? 0) > 0 && owner.hub.hasLobby(w.lobby.id));
    const failure = new Error("stream and recording state not saved");
    (owner.hub as typeof owner.hub & HandoverHub).saveMatch = async () => { throw failure; };

    await spectated("newcomer", { staleMs: 200 });
    await until(() => retired === 1);
    expect(failures.mock.calls.some(([line]) => String(line).includes("failed") && String(line).includes(failure.message))).toBe(true);
    expect(store.begun()).toBe(0);
    expect(await store.saves.read(w.lobby.id)).toBeNull();

    // No valid save: the successor ends the match not played, unrated.
    expect(await until(async () => value(await w.lobbies.readLobby(w.lobby.id)).outcome ?? undefined, 40_000)).toBe("not_played");
    const rated = await Promise.all(w.identities.map(async (id) => (await accounts.ratings.readRating(id, "1v1")).ratedMatches));
    expect(rated).toEqual([0, 0]);
    expect(w.w.commits.flat().filter((write) => /^ratings(-[^/]+)?\//.test(write.path))).toEqual([]);
  });
});

describe("a match stopped for a handover save", () => {
  it("takes no further tick or call on this server: a call reaching it later is answered not_applied at once", async () => {
    const game = new Game({ simConfig: SLOW, mcpConfig: TEST_MCP_CONFIG });
    const joined = await game.join({});
    game.startMatch(1);
    game.tick();
    const waiting = game.call(joined.agentId!, { type: "observe", agentId: joined.agentId! });
    const tick = game.match!.state.tick;
    expect(game.stopForSave()).toBe(tick);
    expect(await waiting).toMatchObject({ kind: "error", code: "not_applied", timing: { tick, retryAfterMs: NOT_APPLIED_RETRY_MS } });
    expect(game.tick()).toBeNull();
    expect(await game.call(joined.agentId!, { type: "order", agentId: joined.agentId!, order: { kind: "forage" } }))
      .toMatchObject({ kind: "error", code: "not_applied" });
    expect(game.pendingInputs).toBe(0);
    expect(game.match!.state.tick).toBe(tick);
  });

  it("keeps a queued seat's start join, which no call waits on, for the save", async () => {
    const game = new Game({ simConfig: SLOW, mcpConfig: TEST_MCP_CONFIG });
    await game.join({});
    game.startMatch(1);
    expect(game.stopForSave()).toBe(0);
    expect(game.pendingInputs).toBe(1);
    expect(game.tick()).toBeNull();
    const save = game.saveMatch();
    expect(save.phase).toBe("match");
    expect(save.phase === "match" ? save.startJoins : null).toHaveLength(1);
  });
});
