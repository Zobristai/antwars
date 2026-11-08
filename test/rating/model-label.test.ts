import { describe, expect, it } from "vitest";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings, RANKED_MODES, ratingCollection, type LeaderboardPage, type RankedMode } from "../../src/rating/ratings.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { FIRST_LOSS, FIRST_WIN } from "./glicko-values.ts";

/**
 * Each rated identity's rating row stores the model label its seat 1 self-reported in its latest rated match in
 * that mode; the leaderboard does not serve it. Real identity, lobby and rating services over in-memory storage.
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
/** The label stored on the identity's rating row in that mode: "" when its latest rated match reported none, undefined before any. */
const stored = (w: World, id: string, mode: RankedMode = "1v1") => w.docs.get(`${ratingCollection(mode)}/${id}`)?.modelLabel;
/** The leaderboard entry shape is today's: no entry carries a model label. */
const unserved = async (w: World, mode: RankedMode = "1v1") => { for (const entry of (await board(w, mode)).entries) expect(entry).not.toHaveProperty("modelLabel"); };

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

describe("latest rated match's self-reported model label", () => {
  it.each(RANKED_MODES)("%s: each rated match replaces or clears the stored label without changing Elo, counts, order or another mode", async mode => {
    const w = await world();
    const teams = [[w.a.id], [w.b.id]] as const;
    const other: RankedMode = mode === "1v1" ? "2v2" : "1v1";
    await w.ratings.applyResult({ matchId: "other", teams, winner: "draw", mode: other, modelLabels: { [w.a.id]: "lab/elsewhere" } });
    await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", modelLabels: { [w.a.id]: "lab/one", [w.b.id]: "lab/two" } });
    expect((await board(w, mode)).entries.map(entry => entry.identityId)).toEqual([w.a.id, w.b.id]);
    expect(await row(w, w.a.id, mode)).toMatchObject({ ...FIRST_WIN, ratedMatches: 1 });
    expect(await row(w, w.b.id, mode)).toMatchObject({ ...FIRST_LOSS, ratedMatches: 1 });
    expect([stored(w, w.a.id, mode), stored(w, w.b.id, mode)]).toEqual(["lab/one", "lab/two"]);
    await unserved(w, mode);
    // The identity switched models: the newer report wins; a match that reported none clears it.
    await w.ratings.applyResult({ matchId: "second", teams, mode, winner: "draw", modelLabels: { [w.a.id]: null, [w.b.id]: "lab/three" } });
    expect(await w.ratings.applyResult({ matchId: "first", teams, mode, winner: "a", modelLabels: { [w.a.id]: "lab/one" } })).toEqual({ status: "already_applied" });
    expect(await row(w, w.a.id, mode)).toMatchObject({ ratedMatches: 2 });
    expect([stored(w, w.a.id, mode), stored(w, w.b.id, mode)]).toEqual(["", "lab/three"]);
    await w.ratings.applyResult({ matchId: "third", teams, mode, winner: "draw" });
    expect(await row(w, w.b.id, mode)).toMatchObject({ ratedMatches: 3 });
    expect(stored(w, w.b.id, mode)).toBe("");
    expect(stored(w, w.a.id, other)).toBe("lab/elsewhere");
    await unserved(w, mode);
  });

  it("stores the label on Benchmark rows too, serves it on none, and leaves rows last rated before labels were stored without one (no backfill)", async () => {
    const w = await world("antwars");
    await w.ratings.applyResult({ matchId: "m", teams: [[w.a.id], [w.pub.id]], winner: "a", modelLabels: { [w.a.id]: "lab/house", [w.pub.id]: "lab/pub" } });
    expect([stored(w, w.a.id), stored(w, w.pub.id)]).toEqual(["lab/house", "lab/pub"]);
    // A row last rated before labels were stored has no modelLabel field at all, and gains none until its next rated match.
    const { modelLabel: _stored, ...historical } = w.docs.get(`ratings/${w.pub.id}`)!;
    w.docs.set(`ratings/${w.pub.id}`, historical);
    expect(stored(w, w.pub.id)).toBeUndefined();
    expect(stored(w, w.b.id)).toBeUndefined();
    await unserved(w);
  });

  it("a rated lobby ending stores the reported labels; stopped or not-played endings leave them untouched", async () => {
    const w = await world();
    await w.ratings.applyResult({ matchId: "prior", teams: [[w.a.id], [w.b.id]], winner: "draw", modelLabels: { [w.a.id]: "lab/prior" } });
    const before = await board(w);
    for (const outcome of ["stopped", "not_played"] as const) {
      const lobby = await queued(w);
      await begin(w, lobby);
      value(await w.lobbies.endMatch(lobby.id, "run", outcome, undefined, undefined, { [w.a.id]: "lab/ignored" }));
      expect(await board(w)).toEqual(before);
      expect([stored(w, w.a.id), stored(w, w.b.id)]).toEqual(["lab/prior", ""]);
    }
    const lobby = await queued(w);
    await begin(w, lobby);
    value(await w.lobbies.endMatch(lobby.id, "run", "colony_0_won", { [w.a.id]: "max" }, { [w.a.id]: "fast" }, { [w.a.id]: "lab/now", [w.b.id]: "local/" }));
    expect(await row(w, w.a.id)).toMatchObject({ ratedMatches: 2, thinkingLevel: "max", serviceTier: "fast" });
    // Any label the join accepts is stored as reported, one ending in "/" included.
    expect([stored(w, w.a.id), stored(w, w.b.id)]).toEqual(["lab/now", "local/"]);
    await unserved(w);
  });
});
