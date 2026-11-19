import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { captureMatchAccess, type MatchAccess } from "../../src/live/match-access.ts";
import { historyRoutes, type RecordingLobby } from "../../src/replays/history-routes.ts";
import type { HistorySummary } from "../../src/replays/history-source.ts";
import { lobbyMatchType } from "../../src/replays/recorded-match-type.ts";
import { createTestRecordings, testRecordingPath } from "../../src/replays/test-recordings.ts";
import { startServer } from "../../src/server.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";
import { playable } from "../playable.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function listen(handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void handle(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Opens a stream, checks it serves, and closes it. */
async function serves(url: string): Promise<number> {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  abort.abort();
  return response.status;
}

describe("a test match's type", () => {
  it("is test from its lobby, whatever else the lobby is", () => {
    expect(lobbyMatchType({ mode: null, size: 1, test: true })).toEqual({ kind: "test", size: 1 });
    expect(lobbyMatchType({ mode: null, size: 2, challenge: { kind: "house" }, test: true })).toEqual({ kind: "test", size: 2 });
    expect(lobbyMatchType({ mode: null, size: 1 })).toEqual({ kind: "unranked", size: 1 });
    expect(lobbyMatchType({ mode: null, size: 1, challenge: { kind: "house" } })).toEqual({ kind: "challenge", size: 1 });
  });

  it("is carried by match access and the watch registry, and a test match gets no public listing row", async () => {
    expect(captureMatchAccess({ lobbyId: "l", visibility: "public", rated: false, test: true })).toMatchObject({ test: true });
    expect(captureMatchAccess({ lobbyId: "l", visibility: "public", rated: false })).not.toHaveProperty("test");
    const { store, docs } = memoryWatchStore(), registry = createWatchRegistry(store);
    const test = "00000000-0000-4000-8000-00000000000a", ordinary = "00000000-0000-4000-8000-00000000000b";
    const match = { visibility: "public" as const, rated: false, startedAt: 1, slot: "public-0", runId: "run", origin: "http://slot.test" };
    await registry.register({ ...match, lobbyId: test, test: true });
    await registry.register({ ...match, lobbyId: ordinary });
    expect(await registry.read(test)).toMatchObject({ test: true });
    expect(await registry.read(ordinary)).not.toHaveProperty("test");
    expect(docs.has(`watchPublic/${test}`)).toBe(false);
    expect(docs.has(`watchPublic/${ordinary}`)).toBe(true);
    // The same match registered again without its test type is a different match.
    await expect(registry.register({ ...match, lobbyId: test })).rejects.toThrow("identity changed");
  });
});

async function world() {
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const tester = await identities.claimUsername("Tester"), player = await identities.claimUsername("Player123");
  if (!tester.ok || !player.ok) throw new Error("fixture claim failed");
  const lobbies = createLobbies(store, identities), ratings = createRatings(store, identities), registry = createWatchRegistry(store);
  await ratings.houseBackfill;
  return { store, docs, identities, lobbies, ratings, registry, tester: tester.value, player: player.value };
}

describe("signed out, a test match is absent from every public list and its direct links still serve", () => {
  async function fixture() {
    const w = await world();
    const made = await w.lobbies.createLobby(w.tester.key, "public", 1, { test: true });
    const other = await w.lobbies.createLobby(w.player.key, "public", 1);
    if (!made.ok || !other.ok) throw new Error("fixture lobby failed");
    const id = made.value.lobby.id, shown = other.value.lobby.id;
    expect(made.value.lobby.test).toBe(true);
    expect(other.value.lobby).not.toHaveProperty("test");
    if (!(await w.lobbies.join(id, w.tester.key)).ok || !(await w.lobbies.join(shown, w.player.key)).ok) throw new Error("fixture seating failed");
    const testRecordings = createTestRecordings(w.store);
    const hub = new LiveHub({ testRecordings }); cleanup.push(() => hub.close());
    const state = () => createMatch(7, playable(rulesConfig("redesign")));
    const testAccess: MatchAccess = { lobbyId: id, visibility: "public", rated: false, test: true };
    hub.startMatch(1, state(), testAccess);
    const routes = watchRoutes({ accounts: { identities: w.identities, lobbies: w.lobbies, ratings: w.ratings }, registry: w.registry, hub });
    const origin = await listen((req, res) => req.url?.startsWith("/live") ? hub.handle(req, res) : routes(req, res));
    w.docs.set("instances/public-0", { runId: "run", mcpUrl: origin, spectatorUrl: origin });
    await w.registry.register({ ...testAccess, startedAt: 1, slot: "public-0", runId: "run", origin });
    return { ...w, origin, id, shown, hub, testRecordings, testAccess, state };
  }

  it("Waiting, Live now and the lobby list leave it out; an ordinary unrated lobby stays", async () => {
    const f = await fixture();
    const catalog = await (await fetch(`${f.origin}/watch/catalog`)).json();
    expect(catalog.matches).toEqual([]);
    expect(catalog.lobbies.map((row: { id: string }) => row.id)).toEqual([f.shown]);
    const queue = await (await fetch(`${f.origin}/watch/queue`)).json();
    expect(JSON.stringify(queue)).not.toContain("Tester");
    expect(JSON.stringify(queue)).toContain("Player123");
    expect((await f.lobbies.listPublic()).map(lobby => lobby.id)).toEqual([f.shown]);
    expect((await f.lobbies.listUnstarted()).flatMap(lobby => lobby.colonies.flat().map(seat => seat.displayName))).toEqual(["Player123"]);
  });

  it("the default Watch stream never selects it, while its own links serve", async () => {
    const f = await fixture();
    expect((await fetch(`${f.origin}/live/current`)).status).toBe(404);
    expect(await (await fetch(`${f.origin}/live/status`)).json()).toEqual({ kind: "idle", match: null });
    expect(await serves(`${f.origin}/live/1`)).toBe(200);
    expect(await serves(`${f.origin}/watch/live/${f.id}`)).toBe(200);
    expect((await fetch(`${f.origin}/watch/status/${f.id}`)).status).toBe(200);
    expect((await f.lobbies.readLobby(f.id)).ok).toBe(true);
    // An ordinary public match beside it is the one the default stream shows.
    f.hub.startMatch(2, f.state(), { lobbyId: f.shown, visibility: "public", rated: false });
    const status = await (await fetch(`${f.origin}/live/status`)).json();
    expect(status.kind).toBe("playing");
    const abort = new AbortController();
    const current = await fetch(`${f.origin}/live/current`, { signal: abort.signal });
    abort.abort();
    expect(current.headers.get("x-antwar-match")).toBe("2");
  });

  it("/live/replays leaves out a test match's recording and a marked recording, and lists an ordinary one", async () => {
    const f = await fixture();
    const testReplay = "2026-11-01T10-00-00-000Z-1", marked = "2026-11-01T11-00-00-000Z-2", ordinary = "2026-11-01T12-00-00-000Z-3";
    f.hub.savedReplay(1, 1, testReplay, f.testAccess);
    f.hub.savedReplay(2, 2, marked, { lobbyId: f.shown, visibility: "public", rated: false });
    f.hub.savedReplay(3, 3, ordinary, { lobbyId: f.shown, visibility: "public", rated: false });
    await f.testRecordings.mark(marked);
    const listed = await (await fetch(`${f.origin}/live/replays`)).json();
    expect(listed.replays.map((row: { replayId: string }) => row.replayId)).toEqual([ordinary]);
  });

  it("the slot marks a test match's recording before it is published, and not an ordinary one's", async () => {
    const f = await fixture();
    const controller = createWatchController({ accounts: { identities: f.identities, lobbies: f.lobbies, ratings: f.ratings }, registry: f.registry,
      slot: "public-0", origin: f.origin, testRecordings: f.testRecordings });
    cleanup.push(() => controller.close());
    const testReplay = "2026-11-01T10-00-00-000Z-1", ordinary = "2026-11-01T12-00-00-000Z-3";
    await controller.hubOptions.beforeRecordingPublication!(f.testAccess, testReplay);
    await controller.hubOptions.beforeRecordingPublication!({ lobbyId: f.shown, visibility: "public", rated: false }, ordinary);
    expect(f.docs.has(testRecordingPath(testReplay))).toBe(true);
    expect(f.docs.has(testRecordingPath(ordinary))).toBe(false);
    expect(f.docs.has(`replayOwnership/${testReplay}`)).toBe(true);
  });
});

describe("create_lobby and request_challenge take test: true", () => {
  it.each(["HTTP", "MCP"] as const)("%s: a test lobby is typed test, left out of list_lobbies and read by its id; an unrated lobby lists", async transport => {
    const w = await world();
    const dataDir = mkdtempSync(join(tmpdir(), "test-matches-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, accounts: { identities: w.identities, lobbies: w.lobbies, ratings: w.ratings } });
    cleanup.push(() => server.close());
    const origin = `http://127.0.0.1:${server.port}`;
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "test-matches", version: "1" });
    if (transport === "MCP") { await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`))); cleanup.push(() => client.close()); }
    const call = async (name: string, args: Record<string, unknown>): Promise<{ lobby: Lobby; lobbies: Lobby[] }> => {
      if (transport === "HTTP") {
        const response = await fetch(`${origin}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
        expect(response.ok, name).toBe(true);
        return await response.json();
      }
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      return (result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text)) as { lobby: Lobby; lobbies: Lobby[] };
    };
    const test = (await call("create_lobby", { key: w.tester.key, kind: "public", size: 1, test: true })).lobby;
    const ordinary = (await call("create_lobby", { key: w.player.key, kind: "public", size: 1 })).lobby;
    expect(test.test).toBe(true);
    expect(ordinary).not.toHaveProperty("test");
    expect((await call("list_lobbies", {})).lobbies.map(lobby => lobby.id)).toEqual([ordinary.id]);
    const read = (await call("read_lobby", { key: w.tester.key, lobbyId: test.id })).lobby;
    expect(read).toMatchObject({ id: test.id, test: true });
    expect(lobbyMatchType(read)).toEqual({ kind: "test", size: 1 });
    expect(lobbyMatchType(ordinary)).toEqual({ kind: "unranked", size: 1 });
  });

  it("a test challenge's lobby is a test lobby; an ordinary challenge's is not", async () => {
    const w = await world();
    const house = await w.identities.claimUsername("antwars");
    if (!house.ok) throw new Error("fixture house claim failed");
    const handle = await w.identities.createHandle(house.value.key, "glm-5-3");
    if (!handle.ok) throw new Error("fixture handle failed");
    const tested = await w.lobbies.requestChallenge(w.tester.key, "antwars/glm-5-3", undefined, { test: true });
    const ordinary = await w.lobbies.requestChallenge(w.player.key, "antwars/glm-5-3");
    if (!tested.ok || !ordinary.ok) throw new Error(`challenge refused: ${tested.ok ? "" : tested.reason} ${ordinary.ok ? "" : ordinary.reason}`);
    const testLobby = await w.lobbies.readLobby(tested.value.lobbyId), ordinaryLobby = await w.lobbies.readLobby(ordinary.value.lobbyId);
    if (!testLobby.ok || !ordinaryLobby.ok) throw new Error("challenge lobby unreadable");
    expect(testLobby.value).toMatchObject({ test: true, challenge: { kind: "house" } });
    expect(ordinaryLobby.value).not.toHaveProperty("test");
    expect(lobbyMatchType(testLobby.value)).toEqual({ kind: "test", size: 1 });
    expect(lobbyMatchType(ordinaryLobby.value)).toEqual({ kind: "challenge", size: 1 });
    expect((await w.lobbies.listPublic()).map(lobby => lobby.id)).toEqual([ordinary.value.lobbyId]);
  });
});

describe("Recordings leave out test matches", () => {
  const seat = (colony: number, handle: string | null, modelLabel: string | null) =>
    ({ seat: colony + 1, colony, modelLabel, thinkingLevel: null, serviceTier: null, handle });
  const row = (id: string, seats = [seat(0, "alpha", "m/a"), seat(1, "beta", "m/b")], rated: boolean | null = false): HistorySummary =>
    ({ id, startedAt: "2026-11-01T10:00:00Z", endedAt: null, simulationEndedAt: null, winner: null, reason: null, decidedBy: null, seats,
      status: "complete", unavailable: [], rated });
  const lobby = (test: boolean): RecordingLobby => ({ kind: "public", size: 1, mode: null, colonies: [[], []], outcome: "colony_0_won", rated: false,
    ...(test ? { test: true as const } : {}) });

  it("by its lobby or its recording's marker, with or without a lobby record, while a direct link still serves", async () => {
    const { store } = memoryWatchStore(), testRecordings = createTestRecordings(store);
    const testLobby = "2026-11-01T10-00-00-000Z-1", markedNoLobby = "2026-11-01T11-00-00-000Z-2", markedWithLobby = "2026-11-01T11-30-00-000Z-5";
    const unrated = "2026-11-01T12-00-00-000Z-3", scriptedSeat = "2026-11-01T13-00-00-000Z-4", rated = "2026-11-01T14-00-00-000Z-6";
    await testRecordings.mark(markedNoLobby);
    await testRecordings.mark(markedWithLobby);
    const rows = [row(testLobby), row(markedNoLobby), row(markedWithLobby), row(unrated),
      // A seat with no model label (a scripted seat) does not make a match a test match.
      row(scriptedSeat, [seat(0, "Scripted bot", null), seat(1, "beta", "m/b")]), row(rated, [seat(0, "Scripted bot", null), seat(1, "beta", "m/b")], true)];
    const lobbies: Record<string, RecordingLobby | null> = { [testLobby]: lobby(true), [markedNoLobby]: null, [markedWithLobby]: lobby(false),
      [unrated]: lobby(false), [scriptedSeat]: null, [rated]: null };
    const routes = historyRoutes({
      list: async () => ({ matches: rows, nextPageToken: null }),
      open: async id => Readable.from([`{"format":"antwar.match","version":1,"id":${JSON.stringify(id)},"source":"match-log","status":"complete","events":[]}`]),
    }, async id => lobbies[id] ?? null, { testRecordings });
    const origin = await listen((req, res) => routes(req, res, undefined as never));
    const page = await (await fetch(`${origin}/matches`)).json();
    expect(page.matches.map((match: HistorySummary) => match.id)).toEqual([unrated, scriptedSeat, rated]);
    expect(JSON.stringify(page)).not.toContain(testLobby);
    expect(JSON.stringify(page)).not.toContain(markedNoLobby);
    for (const id of [testLobby, markedNoLobby]) {
      const direct = await fetch(`${origin}/matches/${id}`);
      expect(direct.status).toBe(200);
      expect((await direct.json()).id).toBe(id);
    }
  });
});

describe("leaderboards", () => {
  it("a marked rated match keeps its result and the rating, and its form entry links no recording", async () => {
    const { store, docs } = memoryWatchStore(), identities = createIdentities(store), testRecordings = createTestRecordings(store);
    const alice = await identities.claimUsername("alice"), bruno = await identities.claimUsername("bruno");
    if (!alice.ok || !bruno.ok) throw new Error("fixture claim failed");
    const ratings = createRatings(store, identities, undefined, testRecordings);
    await ratings.houseBackfill;
    const lobbies = createLobbies(store, identities, { countdownMs: 0 });
    const ids: string[] = [];
    for (const outcome of ["colony_0_won", "colony_1_won"] as const) {
      const made: Lobby = await store.transaction(async read => {
        const queued = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[alice.value.identity], [bruno.value.identity]] }, Date.now());
        return { result: queued.lobby, writes: queued.writes };
      });
      const runId = `run-${ids.length}`;
      await lobbies.registerInstance(made.slot!, { runId, mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
      if (!(await lobbies.beginMatch(made.id, made.slot!, runId)).ok || !(await lobbies.endMatch(made.id, runId, outcome)).ok) throw new Error("fixture match failed");
      ids.push(made.id);
    }
    const kept = "2026-11-01T10-00-00-000Z-1", testReplay = "2026-11-01T11-00-00-000Z-2";
    docs.set(`watchMatches/${ids[0]}`, { replayId: kept });
    docs.set(`watchMatches/${ids[1]}`, { replayId: testReplay });
    await testRecordings.mark(testReplay);
    const board = await ratings.leaderboard();
    if (!board.ok) throw new Error("leaderboard failed");
    const entry = board.value.entries.find(row => row.identityId === alice.value.identity.id)!;
    expect(entry).toMatchObject({ ratedMatches: 2, wins: 1, losses: 1 });
    expect(entry.form).toEqual([{ result: "L", replayId: null }, { result: "W", replayId: kept }]);
  });
});
