/// <reference types="node" />
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMatchSaves, type MatchSave } from "../../src/handover/saveStore.ts";
import type { SpectatorSave } from "../../src/live/handover.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type Lobbies } from "../../src/lobby/lobbies.ts";
import type { Game } from "../../src/mcp/game.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { SHUTDOWN_SAVE_MS, startServer, type GameServer, type SlotWiring } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { memoryObjects } from "../handover/helpers.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

// Save and resume for a begun match still in its nest-pick window, before its first tick,
// through real slot servers: superseded by a same-release server, or sent the
// shutdown signal, the server saves the open start at tick 0 with the handover's save step (no
// spectator side: no match stream exists yet). The next same-release server restores it, seats its
// lobby with the feed, adopts it, and finishes the window when the time it had left runs out, with
// the picks made so far; the match then plays to its natural result, rated once. A restored start
// that cannot be resumed ends not played.

const servers: GameServer[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
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

/** A 12 s match (120 ticks at 10 per second) that reaches its natural result. */
const MATCH = playable(shortConfig(120, { queenFounding: PUBLIC_CONFIG.queenFounding }));
/** The nest-pick window: long enough that every handover below happens inside it. */
const WINDOW_MS = 6000;
const ROOT = join(import.meta.dirname, "..", "..");

/**
 * One in-memory store and save store; a rated 1v1 queue match holding public-0. Adoption waits while
 * held; settled without committing, every adoption made while it was held is refused as superseded.
 */
async function world() {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("PickA")), b = value(await w.ids.claimUsername("PickB"));
  const real = createLobbies(w.store, w.ids, { countdownMs: 300 });
  const ratings = createRatings(w.store, w.ids);
  const lobby = await w.store.transaction(async (read) => {
    const paired = await real.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  expect(lobby.slot).toBe("public-0");
  let adoption: Promise<boolean> = Promise.resolve(true);
  const lobbies: Lobbies = {
    ...real,
    async adoptMatch(lobbyId, slot, runId, fromRunId) {
      if (!(await adoption)) return { ok: false, reason: "superseded" } as const;
      return real.adoptMatch(lobbyId, slot, runId, fromRunId);
    },
  };
  return {
    w, lobbies, lobby, keys: [a.key, b.key] as const, saves: createMatchSaves(w.store, memoryObjects()), watchRegistry: createWatchRegistry(w.store),
    holdAdoption() {
      let settle!: (commit: boolean) => void;
      adoption = new Promise((resolve) => { settle = resolve; });
      return (commit: boolean) => {
        settle(commit);
        adoption = Promise.resolve(true);
      };
    },
    matchRunId: async () => (await lobbies.slotHolder("public-0"))?.matchRunId ?? undefined,
    outcome: async () => value(await real.readLobby(lobby.id)).outcome,
    rated: async () => Promise.all([a, b].map(async (key) => (await ratings.readRating(key.identity.id, "1v1")).ratedMatches)),
  };
}
type World = Awaited<ReturnType<typeof world>>;

const SPECTATOR: SpectatorSave = { meta: JSON.stringify({ test: "spectator" }), parts: new Map([["stream", new Uint8Array([1])]]) };

/** A slot server of revision r1 for public-0 with the handover save store; its feed records every hook it is told of. */
async function slotServer(t: World, name: string, wiring: Partial<SlotWiring> = {}, options: { readonly failSeat?: true } = {}) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const told: string[] = [];
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir, simConfig: MATCH, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: WINDOW_MS,
    feed: {
      matchStarted: (_seq, state) => { told.push(`matchStarted@${state.tick}`); },
      lobbySeated: async () => {
        told.push("lobbySeated");
        if (options.failSeat) throw new Error("spectator side not seated");
      },
      ticked: () => {},
      saveSpectator: async () => { told.push("saveSpectator"); return SPECTATOR; },
      matchResumed: async () => { told.push("matchResumed"); },
    },
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: t.lobbies, identities: t.w.ids, pollMs: 20, revision: "r1", saves: t.saves, ...wiring },
  });
  servers.push(server);
  return { server, told };
}

/**
 * A slot server of revision r1 for public-0 started as main.ts starts one, through startSpectatedServer
 * with its real spectator feed: lobbySeated runs WatchController.prepare, matchStarted registers the
 * lobby's watch entry. Its hooks are not recorded, so told stays empty.
 */
async function spectatedServer(t: World, name: string, wiring: Partial<SlotWiring> = {}) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const server = await startSpectatedServer({
    port: 0, host: "127.0.0.1", dataDir, simConfig: MATCH, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: WINDOW_MS,
    accounts: { identities: t.w.ids, lobbies: t.lobbies, ratings: createRatings(t.w.store, t.w.ids) }, watchRegistry: t.watchRegistry,
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: t.lobbies, identities: t.w.ids, pollMs: 20, revision: "r1", saves: t.saves, ...wiring },
  });
  servers.push(server);
  return { server, told: [] as string[] };
}
type Started = Awaited<ReturnType<typeof slotServer>>;

async function seatSession(server: GameServer) {
  const client = new Client({ name: "antwar-nest-pick-handover-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent as any;
}

/**
 * The seat with `key` joins on the server, through its own session, once the server's restored lobby has
 * loaded: a ranked seat that never joins ends the match abandoned, unrated, at its natural end.
 */
async function joinSeat(server: GameServer, key: string) {
  const call = await seatSession(server);
  const joined = await until(async () => {
    const reply = await call("join", { key });
    return reply.error?.code === "lobby_loading" ? undefined : reply;
  });
  expect(joined.agentId, JSON.stringify(joined)).toEqual(expect.any(String));
  return joined.agentId as string;
}

/** The server's Game: openStart and nestSelection are not on its LiveGame view. */
const gameOf = (server: GameServer): Game => server.game as Game;

/** A free tile of the agent's start box on the server's open window. */
function freeTile(server: GameServer, agentId: string): { tileX: number; tileY: number } {
  const view = gameOf(server).nestSelection(agentId, true)!;
  for (const [dy, row] of view.terrain!.rows.entries()) {
    const dx = [...row].indexOf(".");
    if (dx >= 0) return { tileX: view.box.x + dx, tileY: view.box.y + dy };
  }
  throw new Error("no free tile");
}

/**
 * The owner begins the lobby's match and opens its nest-pick window; seat 0 joins during the window
 * (queued for the first tick) and picks its nest there.
 */
async function ownerInWindow(t: World, start: (t: World, name: string, wiring: Partial<SlotWiring>) => Promise<Started> = slotServer) {
  const owner = await start(t, "owner", { heartbeatMs: 600_000 });
  const ownerRun = await until(t.matchRunId);
  const open = await until(() => gameOf(owner.server).openStart ?? undefined);
  expect(open.lobbyId).toBe(t.lobby.id);
  const call = await seatSession(owner.server);
  const joined = await call("join", { key: t.keys[0] });
  expect(joined.agentId, JSON.stringify(joined)).toEqual(expect.any(String));
  const tile = freeTile(owner.server, joined.agentId);
  const picked = await call("pick_nest", tile);
  expect(picked.error, JSON.stringify(picked)).toBeUndefined();
  expect(owner.server.game.match).toBeNull();
  return { owner, ownerRun, open, agentId: joined.agentId as string, tile, mapId: owner.server.game.startWindowConfig?.terrain?.mapId };
}

/** The start save the owner's save step wrote, read back through the real save store. */
async function startSave(t: World, ownerRun: string): Promise<MatchSave> {
  const save = await until(async () => (await t.saves.read(t.lobby.id)) ?? undefined);
  expect(save).toMatchObject({ format: 1, lobbyId: t.lobby.id, revision: "r1", savedByRunId: ownerRun, tick: 0, spectator: null });
  expect(save.game.phase).toBe("start");
  return save;
}

/**
 * The successor has restored and adopted the saved start: the feed seated its lobby and was told of no
 * match; the window runs on for the time it had left, with the seat's pick; the seat rejoins its record;
 * once the window closes the match starts at tick 0 and plays to its natural result, rated once.
 */
async function resumesAndPlays(t: World, successor: Awaited<ReturnType<typeof slotServer>>, owner: Awaited<ReturnType<typeof ownerInWindow>>, save: MatchSave) {
  const successorRun = (await t.lobbies.resolveSlot("public-0"))!.runId;
  expect(successorRun).not.toBe(owner.ownerRun);
  await until(async () => (await t.matchRunId()) === successorRun);
  const open = gameOf(successor.server).openStart!;
  expect(open).toMatchObject({ lobbyId: t.lobby.id, seed: owner.open.seed });
  expect(successor.server.game.startWindowConfig?.terrain?.mapId).toBe(owner.mapId);
  // The handover's pause takes none of the pick time: the window reopened after the save with the time it had left.
  if (save.game.phase !== "start") throw new Error("not a start save");
  expect(save.game.start.remainingMs).toBeGreaterThan(0);
  expect(open.closesAt).toBeGreaterThanOrEqual(save.savedAt + save.game.start.remainingMs);
  expect(open.closesAt).toBeGreaterThanOrEqual(owner.open.closesAt);
  expect(successor.told).toEqual(["lobbySeated"]);

  const call = await seatSession(successor.server);
  const back = await until(async () => {
    const reply = await call("join", { key: t.keys[0] });
    return reply.error?.code === "lobby_loading" ? undefined : reply;
  });
  expect(back.agentId, JSON.stringify(back)).toBe(owner.agentId);
  expect(gameOf(successor.server).nestSelection(owner.agentId)!.picks.filter((pick) => pick.mine))
    .toEqual([expect.objectContaining(owner.tile)]);
  // The other seat joins in the window, so both seats play the match.
  await joinSeat(successor.server, t.keys[1]);
  expect(successor.server.game.match).toBeNull();

  await until(() => successor.server.game.match !== null, WINDOW_MS + 5000);
  expect(Date.now()).toBeGreaterThanOrEqual(open.closesAt);
  expect(successor.told).toEqual(["lobbySeated", "matchStarted@0"]);
  await until(() => successor.server.game.match!.state.agents.some((agent) => agent.id === owner.agentId));
  expect(await until(async () => (await t.outcome()) ?? undefined, 30_000)).toMatch(/^(colony_[01]_won|draw)$/);
  expect(await t.rated()).toEqual([1, 1]);
}

describe("a begun match handed over in its nest-pick window, through real slot servers", { timeout: 60_000 }, () => {
  it("superseded by a same-release server: saved at tick 0 without a spectator side, resumed in its window with its picks, then played and rated once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t);
    // The owner's last beat was its begin, so the newcomer takes the slot once 300 ms have passed.
    const successor = await slotServer(t, "successor", { staleMs: 300 });
    const save = await startSave(t, owner.ownerRun);
    // The owner saved without asking its feed for a spectator side, and started no match.
    expect(owner.owner.told).toEqual(["lobbySeated"]);
    expect(owner.owner.server.game.match).toBeNull();
    await resumesAndPlays(t, successor, owner, save);
  });

  it("sent the shutdown signal: saved at tick 0 within the shutdown period, then resumed by the next same-release server, played and rated once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t);
    const signalledAt = Date.now();
    // What src/main.ts's signal handler runs (exitOnShutdownSignal); the subprocess test below sends the signal itself.
    await owner.owner.server.shutdown(SHUTDOWN_SAVE_MS);
    expect(Date.now() - signalledAt).toBeLessThan(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(owner.owner.server), 1);
    const save = await startSave(t, owner.ownerRun);
    expect(owner.owner.told).toEqual(["lobbySeated"]);
    const successor = await slotServer(t, "successor", { staleMs: 300 });
    await resumesAndPlays(t, successor, owner, save);
  });

  it("a restored start not yet adopted is not saved again by its shutdown, so the next server still resumes the first save", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t);
    await owner.owner.server.shutdown(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(owner.owner.server), 1);
    const save = await startSave(t, owner.ownerRun);
    const settleAdoption = t.holdAdoption();
    const restoring = await slotServer(t, "restoring", { staleMs: 300 });
    await until(() => restoring.told.includes("lobbySeated"));
    expect(gameOf(restoring.server).openStart?.lobbyId).toBe(t.lobby.id);
    await restoring.server.shutdown(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(restoring.server), 1);
    // Its adoption, in flight as it shut down, never commits.
    settleAdoption(false);
    expect(await t.saves.read(t.lobby.id)).toMatchObject({ savedByRunId: owner.ownerRun, savedAt: save.savedAt });
    const successor = await slotServer(t, "successor", { staleMs: 300 });
    await resumesAndPlays(t, successor, owner, save);
  });

  it("a successor whose adoption outlasts the pick time the window had left still gives the seats all of it, from adoption", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t);
    await owner.owner.server.shutdown(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(owner.owner.server), 1);
    const save = await startSave(t, owner.ownerRun);
    if (save.game.phase !== "start") throw new Error("not a start save");
    const remainingMs = save.game.start.remainingMs;
    const settleAdoption = t.holdAdoption();
    const successor = await slotServer(t, "successor", { staleMs: 300 });
    await until(() => successor.told.includes("lobbySeated"));
    // Restored, its seats answered lobby_loading, while its adoption takes longer than the window had left.
    await sleep(remainingMs + 1000);
    expect(successor.server.game.match).toBeNull();
    const adoptedFrom = Date.now();
    settleAdoption(true);
    // Once adopted, the window runs for the whole of the time it had left when saved.
    await until(() => (gameOf(successor.server).openStart?.closesAt ?? 0) >= adoptedFrom + remainingMs, 5000);
    await resumesAndPlays(t, successor, owner, save);
  });

  it("a restored start whose lobby the feed cannot seat is dropped: it ends not played and unrated, and no match starts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t);
    await owner.owner.server.shutdown(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(owner.owner.server), 1);
    await startSave(t, owner.ownerRun);
    const successor = await slotServer(t, "successor", { staleMs: 300 }, { failSeat: true });
    expect(await until(async () => (await t.outcome()) ?? undefined)).toBe("not_played");
    expect(successor.told).toEqual(["lobbySeated"]);
    expect(gameOf(successor.server).openStart).toBeNull();
    await sleep(WINDOW_MS);
    expect(successor.server.game.match).toBeNull();
    expect(await t.rated()).toEqual([0, 0]);
    const call = await seatSession(successor.server);
    expect((await call("join", { key: t.keys[0] })).error.code).toBe("match_not_played");
  });
});

describe("a begun match handed over in its nest-pick window, through startSpectatedServer's real spectator feed", { timeout: 60_000 }, () => {
  it("the successor seats the lobby with the watch controller under its own run while the lobby holds, and registers the watch entry under that run once the match starts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await world();
    const owner = await ownerInWindow(t, spectatedServer);
    await owner.owner.server.shutdown(SHUTDOWN_SAVE_MS);
    servers.splice(servers.indexOf(owner.owner.server), 1);
    await startSave(t, owner.ownerRun);
    // No match started on the owner, so no watch entry exists yet.
    expect(await t.watchRegistry.read(t.lobby.id)).toBeNull();

    const successor = await spectatedServer(t, "successor", { staleMs: 300 });
    const successorRun = (await t.lobbies.resolveSlot("public-0"))!.runId;
    expect(successorRun).not.toBe(owner.ownerRun);
    // Adopted: the resume ran lobbySeated (WatchController.prepare refuses a lobby that does not
    // hold), the lobby still holds, and the slot names the successor's run as its match run.
    await until(async () => (await t.matchRunId()) === successorRun);
    expect(value(await t.lobbies.readLobby(t.lobby.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(gameOf(successor.server).openStart).toMatchObject({ lobbyId: t.lobby.id, seed: owner.open.seed });
    expect(successor.server.game.match).toBeNull();
    expect(await t.watchRegistry.read(t.lobby.id)).toBeNull();
    // Both seats join in the window, so both play the match.
    for (const key of t.keys) await joinSeat(successor.server, key);

    // The window closes; matchStarted registers the lobby's watch entry under the successor's run and origin.
    await until(() => successor.server.game.match !== null, WINDOW_MS + 5000);
    const entry = await until(async () => (await t.watchRegistry.read(t.lobby.id)) ?? undefined);
    expect(entry).toMatchObject({ lobbyId: t.lobby.id, slot: "public-0", runId: successorRun, origin: "http://successor.test" });
    expect(await until(async () => (await t.outcome()) ?? undefined, 30_000)).toMatch(/^(colony_[01]_won|draw)$/);
    expect(await t.rated()).toEqual([1, 1]);
  });
});

describe("Cloud Run's shutdown signal in the nest-pick window", { timeout: 30_000 }, () => {
  it("saves the open start at tick 0 through the real save store before the process exits, within the 10 s shutdown period", async () => {
    const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/slots/nest-pick-shutdown-child.ts"], {
      cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const line = (prefix: string) => output.split("\n").find((l) => l.startsWith(`${prefix} `))?.slice(prefix.length + 1);
    try {
      const picking = JSON.parse(await until(() => line("PICKING"), 20_000));
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      expect(await exited, output).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(10_000);
      const saved = JSON.parse(line("SAVED") ?? "null");
      expect(saved, output).toEqual({ lobbyId: picking.lobbyId, savedByRunId: picking.matchRunId, revision: "r1", tick: 0, phase: "start",
        spectator: null, seed: picking.seed, picks: 1, remainingMs: expect.any(Number) });
      expect(saved.remainingMs).toBeGreaterThan(0);
      expect(output.indexOf("SAVED ")).toBeLessThan(output.indexOf("EXIT "));
      expect(JSON.parse(line("EXIT") ?? "null")).toEqual({ code: 0, match: null });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
