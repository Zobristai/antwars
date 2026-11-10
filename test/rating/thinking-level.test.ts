import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLobbies, type Lobby, type MatchOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings, encodeRating, INITIAL_RD, RANKED_MODES, ratingCollection, type LeaderboardPage, type RankedMode } from "../../src/rating/ratings.ts";
import { startServer } from "../../src/server.ts";
import { startSlotRunner } from "../../src/slots/slotServer.ts";
import type { Store } from "../../src/store/firestore.ts";
import { loadLeaderboard } from "../../web/src/leaderboard.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { connect, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { FIRST_LOSS, FIRST_WIN } from "./glicko-values.ts";
import { harnessPhaseAt, isIndexMode } from "../../src/rating/harnessPhase.ts";

/**
 * Real identity, lobby and rating services; only the external storage port is in memory. The handles belong to a
 * public username: self-reported levels are shown only on rows the antwars username does not own.
 */
async function world() {
  const w = retentionWorld(Date.now());
  const owner = value(await w.ids.claimUsername("kite"));
  const first = value(await w.ids.createHandle(owner.key, "model-a"));
  const second = value(await w.ids.createHandle(owner.key, "model-b"));
  const a = first.identity, b = second.identity;
  const ratings = createRatings(w.store, w.ids);
  await ratings.houseBackfill;
  const lobbies = createLobbies(w.store, w.ids, { now: w.now, countdownMs: 0 });
  return { ...w, a, b, keyA: first.key, keyB: second.key, ratings, lobbies };
}
type World = Awaited<ReturnType<typeof world>>;
async function board(w: World, mode: RankedMode = "1v1", scope?: "house"): Promise<LeaderboardPage> {
  return value(await w.ratings.leaderboard({ mode, scope }));
}
async function queued(w: World, mode: RankedMode = "1v1", lobbies = w.lobbies): Promise<Lobby> {
  const size = Number(mode.match(/[1-4]/)![0]);
  return w.store.transaction(async read => {
    const made = await lobbies.queuedMatchWrites(read, { mode, colonies: [
      Array.from({ length: size }, () => w.a), Array.from({ length: size }, () => w.b),
    ] }, w.now());
    return { result: made.lobby, writes: made.writes };
  });
}
async function begin(w: World, lobby: Lobby, runId = "run") {
  await w.lobbies.registerInstance(lobby.slot!, { runId, mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
  value(await w.lobbies.beginMatch(lobby.id, lobby.slot!, runId));
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("latest rated thinking level with a portable storage adapter", () => {
  it.each(RANKED_MODES)("%s replaces and clears each identity's level without changing Elo/count calculations or another mode", async mode => {
    const w = await world();
    const teams = [[w.a.id], [w.b.id]] as const;
    for (const other of RANKED_MODES.filter(each => each !== mode)) {
      await w.ratings.applyResult({ matchId: `prior-${other}`, teams, winner: "draw", mode: other, thinkingLevels: { [w.a.id]: "low", [w.b.id]: "medium" } });
    }
    await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", thinkingLevels: { [w.a.id]: "max", [w.b.id]: "high" } });
    const row = async (id: string) => (await board(w, mode)).entries.find(entry => entry.identityId === id)!;
    expect(await row(w.a.id)).toMatchObject({ ...FIRST_WIN, ratedMatches: 1, thinkingLevel: "max" });
    expect(await row(w.b.id)).toMatchObject({ ...FIRST_LOSS, ratedMatches: 1, thinkingLevel: "high" });
    expect((await board(w, mode, "house")).entries).toEqual([]);
    // A replayed old result cannot replace the latest metadata or rate a second time.
    await w.ratings.applyResult({ matchId: "second", teams, mode, winner: "draw", thinkingLevels: { [w.a.id]: "xhigh", [w.b.id]: null } });
    const beforeRetry = await board(w, mode);
    expect(await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", thinkingLevels: { [w.a.id]: "low" } })).toEqual({ status: "already_applied" });
    expect(await board(w, mode)).toEqual(beforeRetry);
    expect(await row(w.a.id)).toMatchObject({ ratedMatches: 2, thinkingLevel: "xhigh" });
    expect(await row(w.b.id)).toMatchObject({ ratedMatches: 2, thinkingLevel: null });
    await w.ratings.applyResult({ matchId: "third", teams, mode, winner: "draw" });
    expect(await row(w.a.id)).toMatchObject({ ratedMatches: 3, thinkingLevel: null });
    expect(w.docs.get(`${ratingCollection(mode)}/${w.a.id}`)?.thinkingLevel).toBe("");
    for (const other of RANKED_MODES.filter(each => each !== mode)) {
      expect((await board(w, other)).entries.find(entry => entry.identityId === w.a.id)).toMatchObject({ rating: 1500, ratedMatches: 1, thinkingLevel: "low" });
    }
    const control = await world();
    for (const [matchId, winner] of [["first", "a"], ["second", "draw"], ["third", "draw"]] as const) {
      await control.ratings.applyResult({ matchId, teams: [[control.a.id], [control.b.id]], mode, winner });
    }
    expect(await w.ratings.readRating(w.a.id, mode)).toEqual(await control.ratings.readRating(control.a.id, mode));
    expect(await w.ratings.readRating(w.b.id, mode)).toEqual(await control.ratings.readRating(control.b.id, mode));
  });

  it("normalizes historical rows and pins thinking levels with the rating snapshot across pages", async () => {
    const w = await world();
    w.docs.set(`ratings/${w.a.id}`, { rating: encodeRating(1516), rd: encodeRating(INITIAL_RD), ratedMatches: "4", displayName: w.a.displayName });
    w.docs.set(`ratings/${w.b.id}`, { rating: encodeRating(1484), rd: encodeRating(INITIAL_RD), ratedMatches: "4", displayName: w.b.displayName, thinkingLevel: "high" });
    const first = value(await w.ratings.leaderboard({ limit: 1 }));
    expect(first.entries[0]).toMatchObject({ identityId: w.a.id, thinkingLevel: null, rating: 1516, ratedMatches: 4 });
    await w.ratings.applyResult({ matchId: "later", teams: [[w.a.id], [w.b.id]], winner: "draw", thinkingLevels: { [w.b.id]: "max" } });
    const second = value(await w.ratings.leaderboard({ limit: 1, cursor: first.next }));
    expect(second.entries[0]).toMatchObject({ identityId: w.b.id, thinkingLevel: "high", rating: 1484, ratedMatches: 4 });
    expect((await board(w)).entries.find(entry => entry.identityId === w.b.id)?.thinkingLevel).toBe("max");
  });

  it.each(RANKED_MODES)("%s natural lobby completion stores metadata atomically, once per identity rather than per seat", async mode => {
    const w = await world(), lobby = await queued(w, mode);
    await begin(w, lobby);
    value(await w.lobbies.endMatch(lobby.id, "run", "colony_0_won", { [w.a.id]: "max", [w.b.id]: "low" }));
    // In a Model Index mode each form entry also carries its harness phase by the lobby's match time (this world's fixed clock).
    const phase = isIndexMode(mode) ? { harnessPhase: harnessPhaseAt(w.now()) } : {};
    expect((await board(w, mode)).entries).toEqual([
      { identityId: w.a.id, displayName: w.a.displayName, ...FIRST_WIN, ratedMatches: 1, thinkingLevel: "max", serviceTier: null, benchmark: false, wins: 1, losses: 0, draws: 0, form: [{ result: "W", replayId: null, ...phase }] },
      { identityId: w.b.id, displayName: w.b.displayName, ...FIRST_LOSS, ratedMatches: 1, thinkingLevel: "low", serviceTier: null, benchmark: false, wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null, ...phase }] },
    ]);
    expect(await w.lobbies.endMatch(lobby.id, "run", "colony_0_won", { [w.a.id]: "high" })).toEqual({ ok: false, reason: "not_holding" });
    expect((await board(w, mode)).entries[0]?.thinkingLevel).toBe("max");
  });

  it.each(["stopped", "not_played", "abandoned"] as const)("%s never changes a stored level", async outcome => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "prior", teams: [[w.a.id], [w.b.id]], winner: "draw", thinkingLevels: { [w.a.id]: "max", [w.b.id]: "high" } });
    const before = await board(w), lobby = await queued(w);
    await begin(w, lobby);
    value(await w.lobbies.endMatch(lobby.id, "run", outcome, { [w.a.id]: "low" }));
    expect(await board(w)).toEqual(before);
  });

  it("a player-created unrated lobby's natural result leaves the stored level untouched", async () => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "prior", teams: [[w.a.id], [w.b.id]], winner: "draw", thinkingLevels: { [w.a.id]: "max", [w.b.id]: "high" } });
    const before = await board(w);
    const created = value(await w.lobbies.createLobby(w.keyA, "public", 1));
    value(await w.lobbies.join(created.lobby.id, w.keyA));
    const lobby = value(await w.lobbies.join(created.lobby.id, w.keyB));
    expect(lobby.rated).toBe(false);
    await begin(w, lobby);
    value(await w.lobbies.endMatch(lobby.id, "run", "draw", { [w.a.id]: "low", [w.b.id]: "medium" }));
    expect(await board(w)).toEqual(before);
  });

  it("a failed slot completion retries the same frozen levels, not later mutable metadata", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    let fail = true;
    const store: Store = { ...w.store, transaction: step => w.store.transaction(async read => {
      const result = await step(read);
      if (fail && result.writes.some(write => write.path.startsWith("ratings/"))) { fail = false; throw new Error("injected commit outage"); }
      return result;
    }) };
    const lobbies = createLobbies(store, w.ids, { now: w.now, countdownMs: 0 });
    const lobby = await queued(w, "1v1", lobbies);
    const starts: MatchOutcome[] = [];
    const runner = await startSlotRunner({ slot: lobby.slot!, lobbies, now: w.now, pollMs: 10,
      mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/",
      host: { seat() {}, start() { starts.push("draw"); return true; }, handOver: async () => false, abandon() {}, notPlayed() {} } });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(starts).toEqual(["draw"]);
      const levels = { [w.a.id]: "max", [w.b.id]: "low" };
      runner.ended("draw", levels); levels[w.a.id] = "high";
      await vi.advanceTimersByTimeAsync(10);
      expect((await board(w)).entries).toHaveLength(0);
      expect(value(await lobbies.readLobby(lobby.id)).state).toBe("holding");
      await vi.advanceTimersByTimeAsync(10);
      expect((await board(w)).entries.find(entry => entry.identityId === w.a.id)).toMatchObject({ thinkingLevel: "max", ratedMatches: 1 });
      expect(value(await lobbies.readLobby(lobby.id)).state).toBe("ended");
    } finally { runner.close(); }
  });

  it("exposes the level through the real HTTP and MCP leaderboard transports and browser reader", async () => {
    const w = await world(), dataDir = tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, mcpConfig: TEST_MCP_CONFIG,
      accounts: { identities: w.ids, lobbies: w.lobbies, ratings: w.ratings } });
    const client = await connect(server.port);
    try {
      await w.ratings.applyResult({ matchId: "api", teams: [[w.a.id], [w.b.id]], winner: "a", thinkingLevels: { [w.a.id]: "max" } });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/leaderboard`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body).toEqual(await board(w));
      const mcp = await client.call("leaderboard");
      expect(mcp.isError).toBe(false); expect(mcp.data).toEqual(body);
      const page = await loadLeaderboard(undefined, undefined, (input, init) => fetch(`http://127.0.0.1:${server.port}${input}`, init));
      expect(page.entries.map(row => row.thinkingLevel)).toEqual(["max", null]);
      expect(page.entries.map(row => [row.rating, row.ratedMatches])).toEqual([[FIRST_WIN.rating, 1], [FIRST_LOSS.rating, 1]]);
    } finally { await client.close(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
