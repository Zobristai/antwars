import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings, encodeRating, INITIAL_RD, RANKED_MODES, ratingCollection, type LeaderboardPage, type RankedMode } from "../../src/rating/ratings.ts";
import { startServer } from "../../src/server.ts";
import { loadLeaderboard } from "../../web/src/leaderboard.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { connect, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { FIRST_LOSS, FIRST_WIN } from "./glicko-values.ts";

/**
 * Two handles of `owner` and one public username; real identity, lobby and rating services over in-memory storage.
 * Self-reported tiers are shown only on rows the antwars username does not own, so those tests use a public owner.
 */
async function world(ownerName: "antwars" | "kite" = "kite") {
  const w = retentionWorld(Date.now());
  const owner = value(await w.ids.claimUsername(ownerName));
  const a = value(await w.ids.createHandle(owner.key, "model-a")).identity;
  const b = value(await w.ids.createHandle(owner.key, "model-b")).identity;
  const pub = value(await w.ids.claimUsername("pub")).identity;
  const ratings = createRatings(w.store, w.ids);
  await ratings.houseBackfill;
  const lobbies = createLobbies(w.store, w.ids, { now: w.now, countdownMs: 0 });
  return { ...w, a, b, pub, ratings, lobbies };
}
type World = Awaited<ReturnType<typeof world>>;
const board = async (w: World, mode: RankedMode = "1v1"): Promise<LeaderboardPage> => value(await w.ratings.leaderboard({ mode }));
const row = async (w: World, id: string, mode: RankedMode = "1v1") => (await board(w, mode)).entries.find(entry => entry.identityId === id)!;

async function queued(w: World): Promise<Lobby> {
  return w.store.transaction(async read => {
    const made = await w.lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[w.a], [w.b]] }, w.now());
    return { result: made.lobby, writes: made.writes };
  });
}
async function begin(w: World, lobby: Lobby) {
  await w.lobbies.registerInstance(lobby.slot!, { runId: "run", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
  value(await w.lobbies.beginMatch(lobby.id, lobby.slot!, "run"));
}

describe("latest rated service tier and the Benchmark flag", () => {
  it.each(RANKED_MODES)("%s replaces and clears each identity's tier without changing Elo, counts or another mode", async mode => {
    const w = await world();
    const teams = [[w.a.id], [w.b.id]] as const;
    const other: RankedMode = mode === "1v1" ? "2v2" : "1v1";
    await w.ratings.applyResult({ matchId: "other", teams, winner: "draw", mode: other, serviceTiers: { [w.a.id]: "standard" } });
    await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", serviceTiers: { [w.a.id]: "fast", [w.b.id]: "standard" } });
    expect(await row(w, w.a.id, mode)).toMatchObject({ ...FIRST_WIN, ratedMatches: 1, serviceTier: "fast", benchmark: false });
    expect(await row(w, w.b.id, mode)).toMatchObject({ ...FIRST_LOSS, ratedMatches: 1, serviceTier: "standard", benchmark: false });
    await w.ratings.applyResult({ matchId: "second", teams, mode, winner: "draw", serviceTiers: { [w.a.id]: null, [w.b.id]: "fast" } });
    expect(await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", serviceTiers: { [w.a.id]: "fast" } })).toEqual({ status: "already_applied" });
    expect(await row(w, w.a.id, mode)).toMatchObject({ ratedMatches: 2, serviceTier: null });
    expect(await row(w, w.b.id, mode)).toMatchObject({ ratedMatches: 2, serviceTier: "fast" });
    expect(w.docs.get(`${ratingCollection(mode)}/${w.a.id}`)?.serviceTier).toBe("");
    await w.ratings.applyResult({ matchId: "third", teams, mode, winner: "draw" });
    expect(await row(w, w.b.id, mode)).toMatchObject({ ratedMatches: 3, serviceTier: null });
    expect(await row(w, w.a.id, other)).toMatchObject({ ratedMatches: 1, serviceTier: "standard" });
  });

  it("marks Benchmark rows by stored owner, not name, and reads historical rows as no tier", async () => {
    const w = await world("antwars");
    const impostor = value(await w.ids.claimUsername("antwarsfan")).identity;
    await w.ratings.applyResult({ matchId: "m", teams: [[w.a.id], [w.pub.id]], winner: "a", serviceTiers: { [w.a.id]: "fast", [w.pub.id]: "fast" } });
    await w.ratings.applyResult({ matchId: "n", teams: [[impostor.id], [w.b.id]], winner: "a", serviceTiers: { [impostor.id]: "fast" } });
    // A row last rated before tiers were recorded has no serviceTier field at all.
    const { serviceTier: _recorded, ...historical } = w.docs.get(`ratings/${impostor.id}`)!;
    w.docs.set(`ratings/${impostor.id}`, historical);
    const flags = Object.fromEntries((await board(w)).entries.map(entry => [entry.displayName, [entry.benchmark, entry.serviceTier]]));
    // model-a and model-b have no fixed tier, so a seat's reported fast is not shown.
    expect(flags).toEqual({
      "antwars/model-a": [true, null], "antwars/model-b": [true, null], pub: [false, "fast"], antwarsfan: [false, null],
    });
  });

  it("an unrated, stopped or not-played lobby ending leaves the stored tier untouched", async () => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "prior", teams: [[w.a.id], [w.b.id]], winner: "draw", serviceTiers: { [w.a.id]: "fast" } });
    const before = await board(w);
    for (const outcome of ["stopped", "not_played"] as const) {
      const lobby = await queued(w);
      await begin(w, lobby);
      value(await w.lobbies.endMatch(lobby.id, "run", outcome, undefined, { [w.a.id]: "standard" }));
      expect(await board(w)).toEqual(before);
    }
    const lobby = await queued(w);
    await begin(w, lobby);
    value(await w.lobbies.endMatch(lobby.id, "run", "colony_0_won", { [w.a.id]: "max" }, { [w.a.id]: "standard", [w.b.id]: "fast" }));
    expect(await row(w, w.a.id)).toMatchObject({ ratedMatches: 2, thinkingLevel: "max", serviceTier: "standard" });
    expect(await row(w, w.b.id)).toMatchObject({ ratedMatches: 2, thinkingLevel: null, serviceTier: "fast" });
  });

  it("returns the tier and Benchmark flag through the HTTP and MCP leaderboards and the browser reader", async () => {
    const w = await world(), dataDir = tempDir();
    // Below the first loss by Glicko (FIRST_LOSS, about 1338), so it ranks last.
    w.docs.set(`ratings/${w.pub.id}`, { rating: encodeRating(1300), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "pub" });
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, mcpConfig: TEST_MCP_CONFIG,
      accounts: { identities: w.ids, lobbies: w.lobbies, ratings: w.ratings } });
    const client = await connect(server.port);
    try {
      await w.ratings.applyResult({ matchId: "api", teams: [[w.a.id], [w.b.id]], winner: "a", thinkingLevels: { [w.a.id]: "max" }, serviceTiers: { [w.a.id]: "fast" } });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/leaderboard`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json();
      expect(body).toEqual(await board(w));
      const mcp = await client.call("leaderboard");
      expect(mcp.isError).toBe(false); expect(mcp.data).toEqual(body);
      const page = await loadLeaderboard(undefined, undefined, (input, init) => fetch(`http://127.0.0.1:${server.port}${input}`, init));
      expect(page.entries.map(entry => [entry.displayName, entry.serviceTier, entry.benchmark])).toEqual([
        ["kite/model-a", "fast", false], ["kite/model-b", null, false], ["pub", null, false],
      ]);
    } finally { await client.close(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });
});
