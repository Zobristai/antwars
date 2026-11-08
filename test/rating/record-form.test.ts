import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLobbies, type Lobby, type MatchOutcome } from "../../src/lobby/lobbies.ts";
import {
  createRatings, encodeRating, fillRatingRecords, INITIAL_RD, startRecordFill, RANKED_MODES, RECORD_FILL_MARKER, ratingCollection, type LeaderboardEntry, type RankedMode,
} from "../../src/rating/ratings.ts";
import type { Store } from "../../src/store/firestore.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";

/** Real identity, lobby and rating services; only the storage port is in memory. */
async function world() {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("alice")).identity, b = value(await w.ids.claimUsername("bruno")).identity;
  const ratings = createRatings(w.store, w.ids);
  await ratings.houseBackfill;
  const lobbies = createLobbies(w.store, w.ids, { now: w.now, countdownMs: 0 });
  return { ...w, a, b, ratings, lobbies };
}
type World = Awaited<ReturnType<typeof world>>;

let runs = 0;
/** One queue-made match in mode, alice in colony 0 and bruno in colony 1 (every seat of a team mode), ended with outcome. */
async function play(w: World, mode: RankedMode, outcome: MatchOutcome): Promise<string> {
  const size = Number(mode.match(/[1-4]/)![0]);
  const lobby: Lobby = await w.store.transaction(async read => {
    const made = await w.lobbies.queuedMatchWrites(read, { mode, colonies: [
      Array.from({ length: size }, () => w.a), Array.from({ length: size }, () => w.b),
    ] }, w.now());
    return { result: made.lobby, writes: made.writes };
  });
  const runId = `run-${runs++}`;
  await w.lobbies.registerInstance(lobby.slot!, { runId, mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" });
  value(await w.lobbies.beginMatch(lobby.id, lobby.slot!, runId));
  value(await w.lobbies.endMatch(lobby.id, runId, outcome));
  w.advance(1000);
  return lobby.id;
}

async function row(w: World, identityId: string, mode: RankedMode = "1v1"): Promise<LeaderboardEntry | undefined> {
  return value(await w.ratings.leaderboard({ mode })).entries.find(entry => entry.identityId === identityId);
}

/** Removes the record fields, leaving the row as an older server wrote it. */
function forgetRecord(w: World, mode: RankedMode, identityId: string) {
  const path = `${ratingCollection(mode)}/${identityId}`;
  const { wins: _w, losses: _l, draws: _d, form: _f, ...legacy } = w.docs.get(path)!;
  w.docs.set(path, legacy);
}

/** An ended lobby written directly, as an older server left it. */
function endedLobby(w: Pick<World, "docs" | "a" | "b">, fields: { mode?: string; outcome: string; rated?: string; createdAt: number; startsAt?: number; colonies?: [string, string] }): string {
  const id = randomUUID();
  const [zero, one] = fields.colonies ?? [w.a.id, w.b.id];
  w.docs.set(`lobbies/${id}`, {
    kind: "public", state: "ended", rated: fields.rated ?? "true", outcome: fields.outcome, mode: fields.mode ?? "", size: "1",
    createdAt: String(fields.createdAt), startsAt: fields.startsAt === undefined ? "" : String(fields.startsAt),
    seats: JSON.stringify([{ id: zero, displayName: "x", colony: 0 }, { id: one, displayName: "y", colony: 1 }]),
  });
  return id;
}
const legacyRow = (w: Pick<World, "docs">, mode: RankedMode, identityId: string, ratedMatches: number, rating = 1500) =>
  w.docs.set(`${ratingCollection(mode)}/${identityId}`, { rating: encodeRating(rating), rd: encodeRating(INITIAL_RD), ratedMatches: String(ratedMatches), displayName: "x" });

afterEach(() => { vi.restoreAllMocks(); });

describe("leaderboard record and last-5 form", () => {
  it.each(RANKED_MODES)("%s counts wins, losses and draws of rated results only, adding up to rated matches, in that mode alone", async mode => {
    const w = await world();
    for (const outcome of ["colony_0_won", "draw", "stopped", "colony_1_won", "not_played", "abandoned", "colony_0_won"] as const) {
      if (outcome === "not_played") continue; // never begins, so it never reaches a slot release with a result
      await play(w, mode, outcome);
    }
    const alice = (await row(w, w.a.id, mode))!, bruno = (await row(w, w.b.id, mode))!;
    expect(alice).toMatchObject({ ratedMatches: 4, wins: 2, losses: 1, draws: 1 });
    expect(bruno).toMatchObject({ ratedMatches: 4, wins: 1, losses: 2, draws: 1 });
    expect(alice.form.map(letter => letter.result)).toEqual(["W", "L", "D", "W"]);
    expect(bruno.form.map(letter => letter.result)).toEqual(["L", "W", "D", "L"]);
    for (const other of RANKED_MODES.filter(each => each !== mode)) expect(value(await w.ratings.leaderboard({ mode: other })).entries).toEqual([]);
  });

  it("keeps the five newest results, newest first, and links each one only when its replay id is stored", async () => {
    const w = await world();
    const ids: string[] = [];
    for (const outcome of ["colony_0_won", "colony_0_won", "colony_1_won", "draw", "colony_1_won", "colony_0_won"] as const) ids.push(await play(w, "1v1", outcome));
    w.docs.set(`watchMatches/${ids[5]}`, { replayId: "2026-10-26T08-00-00-000Z-1" });
    w.docs.set(`watchMatches/${ids[3]}`, { replayId: "2026-10-26T07-50-00-000Z-2" });
    w.docs.set(`watchMatches/${ids[4]}`, { rated: "true" }); // registered, playback not finished
    const alice = (await row(w, w.a.id))!;
    expect(alice).toMatchObject({ ratedMatches: 6, wins: 3, losses: 2, draws: 1 });
    expect(alice.form).toEqual([
      { result: "W", replayId: "2026-10-26T08-00-00-000Z-1" }, { result: "L", replayId: null }, { result: "D", replayId: "2026-10-26T07-50-00-000Z-2" },
      { result: "L", replayId: null }, { result: "W", replayId: null },
    ]);
  });

  it("fills rows rated before records existed from ended rated lobbies, newest first by match time, and a second fill writes nothing", async () => {
    const w = await world();
    // Created in one order, played in another: the form follows match time, never scan order.
    endedLobby(w, { outcome: "colony_0_won", createdAt: 1000, startsAt: 9000 });
    endedLobby(w, { outcome: "draw", createdAt: 2000, startsAt: 7000 });
    endedLobby(w, { outcome: "colony_1_won", createdAt: 3000, startsAt: 8000 });
    endedLobby(w, { outcome: "colony_1_won", createdAt: 4000 }); // no startsAt: its creation time
    // Never rated, or another mode: not counted in 1v1.
    endedLobby(w, { outcome: "colony_0_won", rated: "false", createdAt: 5000, startsAt: 9500 });
    endedLobby(w, { outcome: "abandoned", rated: "false", createdAt: 5100 });
    endedLobby(w, { outcome: "stopped", createdAt: 5200 });
    endedLobby(w, { outcome: "colony_0_won", mode: "2v2", createdAt: 6000, startsAt: 6000 });
    legacyRow(w, "1v1", w.a.id, 4); legacyRow(w, "1v1", w.b.id, 4); legacyRow(w, "2v2", w.a.id, 1);

    expect(await fillRatingRecords(w.store)).toEqual({ filled: 3, unreconciled: [], skipped: [] });
    const alice = (await row(w, w.a.id))!;
    expect(alice).toMatchObject({ ratedMatches: 4, wins: 1, losses: 2, draws: 1 });
    expect(alice.form.map(letter => letter.result)).toEqual(["W", "L", "D", "L"]);
    expect((await row(w, w.b.id))!.form.map(letter => letter.result)).toEqual(["L", "W", "D", "W"]);
    expect(await row(w, w.a.id, "2v2")).toMatchObject({ ratedMatches: 1, wins: 1, losses: 0, draws: 0 });

    const commits = w.commits.length;
    expect(await fillRatingRecords(w.store)).toEqual({ filled: 0, unreconciled: [], skipped: [] });
    expect(w.commits.length).toBe(commits);
  });

  it("a filled row then counts later results; a result rated on an unfilled row leaves it unfilled rather than partial", async () => {
    const w = await world();
    await play(w, "1v1", "colony_0_won");
    await play(w, "1v1", "colony_1_won");
    forgetRecord(w, "1v1", w.a.id); forgetRecord(w, "1v1", w.b.id);
    await play(w, "1v1", "draw");
    expect(await row(w, w.a.id)).toMatchObject({ ratedMatches: 3, wins: null, losses: null, draws: null, form: [] });
    expect(await fillRatingRecords(w.store)).toEqual({ filled: 2, unreconciled: [], skipped: [] });
    await play(w, "1v1", "colony_0_won");
    const alice = (await row(w, w.a.id))!;
    expect(alice).toMatchObject({ ratedMatches: 4, wins: 2, losses: 1, draws: 1 });
    expect(alice.form.map(letter => letter.result)).toEqual(["W", "D", "L", "W"]);
  });

  it("re-reads each row: a result rated during the scan is picked up by a fresh scan, never lost or counted twice", async () => {
    const w = await world();
    endedLobby(w, { outcome: "colony_0_won", createdAt: 1000 });
    legacyRow(w, "1v1", w.a.id, 1); legacyRow(w, "1v1", w.b.id, 1);
    let landed = false;
    const store: Store = { ...w.store, async query(collection, options) {
      const page = await w.store.query(collection, options);
      if (collection === "lobbies" && !landed) {
        // A result commits after the scan's snapshot: lobby ended and rows counted, record fields still absent.
        landed = true;
        endedLobby(w, { outcome: "colony_1_won", createdAt: 2000 });
        legacyRow(w, "1v1", w.a.id, 2); legacyRow(w, "1v1", w.b.id, 2);
      }
      return page;
    } };
    expect(await fillRatingRecords(store)).toEqual({ filled: 2, unreconciled: [], skipped: [] });
    const alice = (await row(w, w.a.id))!;
    expect(alice).toMatchObject({ ratedMatches: 2, wins: 1, losses: 1, draws: 0 });
    expect(alice.form.map(letter => letter.result)).toEqual(["L", "W"]);
  });

  it("leaves a row the lobbies do not account for without a record, shows it empty and logs its identity and mode", async () => {
    const w = retentionWorld(Date.now());
    const a = value(await w.ids.claimUsername("alice")).identity, b = value(await w.ids.claimUsername("bruno")).identity;
    endedLobby({ docs: w.docs, a, b }, { outcome: "colony_0_won", createdAt: 1000 });
    w.docs.set(`ratings/${a.id}`, { rating: encodeRating(1520), rd: encodeRating(INITIAL_RD), ratedMatches: "3", displayName: "alice" });
    w.docs.set(`ratings/${b.id}`, { rating: encodeRating(1480), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "bruno" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startRecordFill(w.store);
    const ratings = createRatings(w.store, w.ids);
    expect(warn).toHaveBeenCalledWith("antwar rating record not reconciled", { mode: "1v1", identityId: a.id, ratedMatches: 3, found: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    const entries = value(await ratings.leaderboard()).entries;
    expect(entries.find(entry => entry.identityId === a.id)).toMatchObject({ ratedMatches: 3, wins: null, losses: null, draws: null, form: [] });
    expect(entries.find(entry => entry.identityId === b.id)).toMatchObject({ ratedMatches: 1, wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null }] });

    // The run completed, so the unreconciled row is not retried: a later start scans nothing and it stays empty.
    expect(w.docs.get(RECORD_FILL_MARKER)).toMatchObject({ filled: "1", unreconciled: "1", skipped: "0" });
    const later = counting(w.store);
    await startRecordFill(later.store);
    expect(later.queried).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(value(await ratings.leaderboard()).entries.find(entry => entry.identityId === a.id)).toMatchObject({ wins: null, losses: null, draws: null, form: [] });
  });

  it("skips and logs an unreadable rated lobby beside readable ones: the other rows fill in the same run and the fill-in is recorded done", async () => {
    const w = await world();
    endedLobby(w, { outcome: "colony_0_won", createdAt: 1000 });
    endedLobby(w, { outcome: "draw", createdAt: 3000 });
    const corrupt = (seats: string, createdAt = "1500") => {
      const id = endedLobby(w, { outcome: "colony_1_won", createdAt: 1500 });
      w.docs.set(`lobbies/${id}`, { ...w.docs.get(`lobbies/${id}`)!, seats, createdAt });
      return id;
    };
    const unparsable = corrupt("{not json");
    const noSeatId = corrupt(JSON.stringify([{ displayName: "x", colony: 0 }, { id: w.b.id, displayName: "y", colony: 1 }]));
    const noMatchTime = corrupt(JSON.stringify([{ id: w.a.id, colony: 0 }, { id: w.b.id, colony: 1 }]), "soon");
    legacyRow(w, "1v1", w.a.id, 2); legacyRow(w, "1v1", w.b.id, 2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startRecordFill(w.store);
    for (const lobbyId of [unparsable, noSeatId, noMatchTime]) {
      expect(warn).toHaveBeenCalledWith("antwar rating record fill skipped unreadable lobby", { lobbyId });
    }
    expect(warn).toHaveBeenCalledTimes(3);
    const alice = (await row(w, w.a.id))!, bruno = (await row(w, w.b.id))!;
    expect(alice).toMatchObject({ ratedMatches: 2, wins: 1, losses: 0, draws: 1 });
    expect(alice.form.map(letter => letter.result)).toEqual(["D", "W"]);
    expect(bruno).toMatchObject({ ratedMatches: 2, wins: 0, losses: 1, draws: 1 });
    expect(w.docs.get(RECORD_FILL_MARKER)).toMatchObject({ filled: "2", unreconciled: "0", skipped: "3" });
  });

  it("once recorded done, a start reads only the marker: no lobby or rating-row query and no write, even with unfilled rows left", async () => {
    const w = await world();
    endedLobby(w, { outcome: "colony_0_won", createdAt: 1000 });
    legacyRow(w, "1v1", w.a.id, 1); legacyRow(w, "1v1", w.b.id, 1);
    await startRecordFill(w.store);
    expect((await row(w, w.a.id))!).toMatchObject({ wins: 1, losses: 0, draws: 0 });

    // Work a fresh run would find: an ended rated lobby and a row without a record.
    endedLobby(w, { outcome: "colony_0_won", mode: "2v2", createdAt: 2000 });
    legacyRow(w, "2v2", w.a.id, 1);
    const commits = w.commits.length;
    const later = counting(w.store);
    await startRecordFill(later.store);
    expect(later.queried).toEqual([]);
    expect(later.read).toEqual([RECORD_FILL_MARKER]);
    expect(w.commits.length).toBe(commits);
    expect(await row(w, w.a.id, "2v2")).toMatchObject({ ratedMatches: 1, wins: null, form: [] });
  });

  it("a run that fails is logged and writes no marker, so the next start runs the fill-in", async () => {
    const w = await world();
    endedLobby(w, { outcome: "colony_0_won", createdAt: 1000 });
    legacyRow(w, "1v1", w.a.id, 1); legacyRow(w, "1v1", w.b.id, 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: Store = { ...w.store, async query(collection, options) {
      if (collection === "lobbies") throw new Error("injected lobby scan failure");
      return w.store.query(collection, options);
    } };
    await startRecordFill(failing);
    expect(warn).toHaveBeenCalledWith("antwar rating record backfill failed", expect.objectContaining({ message: "injected lobby scan failure" }));
    expect(w.docs.has(RECORD_FILL_MARKER)).toBe(false);

    await startRecordFill(w.store);
    expect((await row(w, w.a.id))!).toMatchObject({ wins: 1, losses: 0, draws: 0 });
    expect(w.docs.get(RECORD_FILL_MARKER)).toMatchObject({ filled: "2" });
  });
});

/** base, recording every collection queried and every document read through it. */
function counting(base: Store) {
  const queried: string[] = [], read: string[] = [];
  const store: Store = {
    ...base,
    async get(path) { read.push(path); return base.get(path); },
    transaction: step => base.transaction(source => step(async paths => { read.push(...paths); return source(paths); })),
    async query(collection, options) { queried.push(collection); return base.query(collection, options); },
  };
  return { store, queried, read };
}
