import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import {
  createRatings, decodeRating, encodeRating, INITIAL_RD, markHouseRatings, RANKED_MODES, ratingCollection, type ApplyOutcome, type LeaderboardEntry,
  type LeaderboardOutcome, type LeaderboardScope, type MatchResult, type RankedMode, type Rating, type RatingChange, type Ratings,
  type Winner,
} from "../../src/rating/ratings.ts";
import { createFirestore, FirestoreError, type Fields, type Store } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT. Skipped only when the variable is
// unset; when it is set, an unreachable emulator fails every test.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const RACE_TIMEOUT = 60_000; // the emulator reports a lock conflict after about 2 s
const SLOW = 30_000;
/** Record fields of a row with one rated result, or of a row seeded without a record. */
const WON_ONE = { wins: 1, losses: 0, draws: 0, form: [{ result: "W", replayId: null }] } as const;
const LOST_ONE = { wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null }] } as const;
const NO_RECORD = { wins: null, losses: null, draws: null, form: [] } as const;

let counter = 0;
const freshNamespace = () => `r${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string, request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, request });
const ratingsFor = (namespace: string, request?: typeof fetch) => createRatings(storeFor(namespace, request));

/** Claims usernames and returns their identity ids by name. */
async function claim(namespace: string, ...names: string[]): Promise<Record<string, string>> {
  const ids = createIdentities(storeFor(namespace));
  const out: Record<string, string> = {};
  for (const name of names) {
    const claimed = await ids.claimUsername(name);
    if (!claimed.ok) throw new Error(`claim ${name}: ${claimed.reason}`);
    out[name] = claimed.value.identity.id;
  }
  return out;
}

function issued<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** Creates documents directly, as data written before this code or by hand would be. */
async function createDocs(store: Store, docs: Readonly<Record<string, Fields>>): Promise<void> {
  await store.transaction(async () => ({ result: undefined, writes: Object.entries(docs).map(([path, fields]) => ({ op: "create" as const, path, fields })) }));
}

/**
 * The antwars username with two handles; another owner, with a handle of the
 * same name; plain usernames; and an identity displayed as "antwars/impostor" that
 * antwars does not own. Claims cannot make that name, so its document is written
 * directly; a display-name split would count it as a house agent.
 */
async function rankingWorld(namespace: string) {
  const store = storeFor(namespace);
  const ids = createIdentities(store);
  const antwars = issued(await ids.claimUsername("antwars"));
  const scout = issued(await ids.createHandle(antwars.key, "scout")).identity.id;
  const worker = issued(await ids.createHandle(antwars.key, "worker")).identity.id;
  const kay = issued(await ids.claimUsername("Kite"));
  const kayScout = issued(await ids.createHandle(kay.key, "scout")).identity.id;
  const { bob, carol, dave } = await claim(namespace, "bob", "carol", "dave");
  const impostor = randomUUID();
  await createDocs(store, { [`identities/${impostor}`]: { kind: "username", displayName: "antwars/impostor", claimedAt: String(Date.now()), hasJoinedMatch: "true" } });
  const house = { antwars: antwars.identity.id, scout, worker };
  const others = { kite: kay.identity.id, kiteScout: kayScout, bob: bob!, carol: carol!, dave: dave!, impostor };
  return { store, house, others };
}

/** Records the path of every row a query returns. */
function recordingQueries(store: Store): { store: Store; rows: string[] } {
  const rows: string[] = [];
  return {
    rows,
    store: { ...store, async query(collectionId, options) {
      const result = await store.query(collectionId, options);
      rows.push(...result.rows.map((row) => row.path));
      return result;
    } },
  };
}

const cursorParts = (cursor: string): unknown[] => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

function applied(outcome: ApplyOutcome): readonly RatingChange[] {
  if (outcome.status !== "applied") throw new Error("expected the result to apply");
  return outcome.changes;
}

function page(outcome: LeaderboardOutcome) {
  if (!outcome.ok) throw new Error(`expected a page, got ${outcome.reason}`);
  return outcome.value;
}

type Rankings = { readonly mode?: RankedMode; readonly scope?: LeaderboardScope };

/** Every page, following cursors, with the given page size. */
async function allPages(ratings: Ratings, limit: number, between?: () => Promise<void>, rankings: Rankings = {}): Promise<LeaderboardEntry[]> {
  const entries: LeaderboardEntry[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    const current = page(await ratings.leaderboard({ ...rankings, limit, cursor }));
    entries.push(...current.entries);
    if (pages === 0 && between) await between();
    if (current.next === undefined) return entries;
    expect(current.entries).toHaveLength(limit);
    cursor = current.next;
  }
}

type Glicko = { readonly rating: number; readonly rd: number };
const START: Glicko = { rating: 1500, rd: 350 };

/**
 * The rule, written out independently (Glickman, "The Glicko system", 1995), one
 * match per rating period: the opponent is the other team's mean rating and
 * root-mean-square RD; E = 1 / (1 + 10^(-g(RDj)(r - rj)/400)); RD' = (1/RD^2 + 1/d^2)^-1/2;
 * r' = r + q RD'^2 g(RDj)(s - E). These results carry no match time, so no RD growth.
 */
function glickoAfter(own: Glicko, opponents: readonly Glicko[], score: number): Glicko {
  const q = Math.log(10) / 400;
  const rj = opponents.reduce((sum, o) => sum + o.rating, 0) / opponents.length;
  const rdj = Math.sqrt(opponents.reduce((sum, o) => sum + o.rd ** 2, 0) / opponents.length);
  const g = 1 / Math.sqrt(1 + (3 * q ** 2 * rdj ** 2) / Math.PI ** 2);
  const e = 1 / (1 + 10 ** ((-g * (own.rating - rj)) / 400));
  const d2 = 1 / (q ** 2 * g ** 2 * e * (1 - e));
  const rd = Math.sqrt(1 / (1 / own.rd ** 2 + 1 / d2));
  return { rating: own.rating + q * rd ** 2 * g * (score - e), rd };
}

/** Applies a result to plain numbers, as the store should. */
function simulate(ratings: Map<string, Glicko>, [teamA, teamB]: readonly [readonly string[], readonly string[]], winner: Winner) {
  const now = (id: string) => ratings.get(id) ?? START;
  const scoreA = winner === "a" ? 1 : winner === "b" ? 0 : 0.5;
  const a = teamA.map(now), b = teamB.map(now);
  teamA.forEach((id, i) => ratings.set(id, glickoAfter(a[i]!, b, scoreA)));
  teamB.forEach((id, i) => ratings.set(id, glickoAfter(b[i]!, a, 1 - scoreA)));
}

/** The independent model agrees with the store to float rounding, never more loosely. */
function near(actual: { readonly rating: number; readonly rd: number }, expected: Glicko, label?: string) {
  expect(Math.abs(actual.rating - expected.rating), label).toBeLessThan(1e-9);
  expect(Math.abs(actual.rd - expected.rd), label).toBeLessThan(1e-9);
}

/** The first rated result from 1500 / 350 against an equal opponent: a win and a loss. */
const WON = glickoAfter(START, [START], 1), LOST = glickoAfter(START, [START], 0);

/** Leaderboard order: rating descending, then identity id descending. */
const byRank = (a: LeaderboardEntry, b: LeaderboardEntry) => b.rating - a.rating || (a.identityId < b.identityId ? 1 : a.identityId > b.identityId ? -1 : 0);

/**
 * Forces two operations to overlap: each contender's first commit is held until
 * both have reached one, so both have read before either writes. Retries pass
 * through unheld. (As in test/identity/identities.test.ts.)
 */
function overlap() {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  return (): typeof fetch => {
    let held = false;
    return async (input, init) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith(":commit") && !held) {
        held = true;
        if (++arrived === 2) release();
        await Promise.race([both, sleep(15_000, undefined, { ref: false }).then(() => {
          throw new Error("barrier: both contenders did not reach a commit within 15 s");
        })]);
      }
      return fetch(input, init);
    };
  };
}

describe.skipIf(!host)("ratings against the Firestore emulator", () => {
  it("reads an identity with no rated result as 1500 ± 350, and an empty leaderboard as one empty page", async () => {
    const namespace = freshNamespace();
    const { Kite: Kay } = await claim(namespace, "Kite");
    const ratings = ratingsFor(namespace);
    expect(await ratings.readRating(Kay!)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    expect(await ratings.leaderboard({ limit: 2 })).toEqual({ ok: true, value: { entries: [] } });
  });

  it("moves each player by Glicko-1 against the other team's mean rating and RD, by its own RD, for a win, a loss and a draw", async () => {
    const namespace = freshNamespace();
    const { a1, a2, b1, b2 } = await claim(namespace, "a1", "a2", "b1", "b2");
    const ratings = ratingsFor(namespace);
    const model = new Map<string, Glicko>();
    const results: MatchResult[] = [
      { matchId: "m0", teams: [[a1!], [b1!]], winner: "a" },
      { matchId: "m1", teams: [[a1!, a2!], [b1!, b2!]], winner: "b" },
      { matchId: "m2", teams: [[a1!, a2!], [b1!, b2!]], winner: "draw" },
    ];
    for (const result of results) {
      const before = new Map(model);
      simulate(model, result.teams, result.winner);
      const changes = applied(await ratings.applyResult(result));
      const members = [...result.teams[0], ...result.teams[1]];
      expect(changes.map((change) => change.identityId)).toEqual(members);
      for (const change of changes) {
        near({ rating: change.before, rd: change.rdBefore! }, before.get(change.identityId) ?? START, change.identityId);
        near({ rating: change.after, rd: change.rdAfter! }, model.get(change.identityId)!, change.identityId);
        const stored = await ratings.readRating(change.identityId);
        expect([stored.rating, stored.rd]).toEqual([change.after, change.rdAfter]);
      }
    }
    // a1 and a2 entered m1 with different RDs, so the same result moved them differently.
    expect(model.get(a1!)!.rating).not.toBe(model.get(a2!)!.rating);
    expect((await ratings.readRating(a1!)).ratedMatches).toBe(3);
    expect((await ratings.readRating(b2!)).ratedMatches).toBe(2);
  });

  it("moves each participant's rating and rated-match count in the result's mode only, leaving every other mode unchanged", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const { pa, pb, pc, pd } = await claim(namespace, "pa", "pb", "pc", "pd");
    const everyone = [pa!, pb!, pc!, pd!];
    const ratings = ratingsFor(namespace);
    // An independent model per mode: ratings and rated-match counts.
    const models = new Map(RANKED_MODES.map((mode) => [mode, { ratings: new Map<string, Glicko>(), counts: new Map<string, number>() }]));
    const expectAllModes = async () => {
      for (const mode of RANKED_MODES) {
        const model = models.get(mode)!;
        for (const id of everyone) {
          const stored = await ratings.readRating(id, mode);
          near(stored, model.ratings.get(id) ?? START, `${mode} ${id}`);
          expect(stored.ratedMatches, `${mode} ${id}`).toBe(model.counts.get(id) ?? 0);
        }
      }
    };
    // Every mode in turn, twice, so each later result starts from ratings that other modes have already moved.
    const winners: readonly Winner[] = ["a", "b", "draw", "a", "a", "draw", "b", "b"];
    const results: MatchResult[] = [...RANKED_MODES, ...RANKED_MODES].map((mode, n) => ({
      matchId: `m${n}`, mode,
      teams: mode === "1v1" ? [[pa!], [pc!]] : [[pa!, pb!], [pc!, pd!]],
      winner: winners[n % winners.length]!,
    }));
    for (const result of results) {
      const model = models.get(result.mode!)!;
      simulate(model.ratings, result.teams, result.winner);
      for (const id of [...result.teams[0], ...result.teams[1]]) model.counts.set(id, (model.counts.get(id) ?? 0) + 1);
      applied(await ratings.applyResult(result));
      await expectAllModes();
    }
    // The same identity's ratings really did diverge between modes.
    expect(new Set(RANKED_MODES.map((mode) => models.get(mode)!.ratings.get(pa!)!.rating)).size).toBeGreaterThan(1);
  });

  it("keeps a rating recorded before ratings were per mode as the 1v1 rating and count, with 1500 ± 350 and no matches in 2v2, 3v3 and 4v4", async () => {
    const namespace = freshNamespace();
    const { veteran, rival } = await claim(namespace, "veteran", "rival");
    const store = storeFor(namespace);
    // A row exactly as written before modes existed: ratings/{identityId} { rating, ratedMatches, displayName }.
    await store.transaction(async () => ({
      result: undefined,
      writes: [{ op: "create", path: `ratings/${veteran}`, fields: { rating: encodeRating(1543.25), rd: encodeRating(INITIAL_RD), ratedMatches: "7", displayName: "veteran" } }],
    }));
    const ratings = createRatings(store);
    // It has no RD: it reads as 350, and its next result starts from 1543.25 ± 350.
    const earlier: Rating = { rating: 1543.25, rd: 350, ratedMatches: 7 };
    expect(await ratings.readRating(veteran!)).toEqual(earlier);
    expect(await ratings.readRating(veteran!, "1v1")).toEqual(earlier);
    for (const mode of ["2v2", "3v3", "4v4"] as const) expect(await ratings.readRating(veteran!, mode)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });

    // A team-mode result starts from 1500 and leaves the carried-over 1v1 rating alone.
    const team = applied(await ratings.applyResult({ matchId: "team", mode: "2v2", teams: [[veteran!], [rival!]], winner: "a" }));
    expect(team.find((change) => change.identityId === veteran)).toEqual({ identityId: veteran, before: 1500, after: WON.rating, rdBefore: 350, rdAfter: WON.rd });
    expect(await ratings.readRating(veteran!)).toEqual(earlier);
    // A 1v1 result continues from it.
    const solo = applied(await ratings.applyResult({ matchId: "solo", teams: [[veteran!], [rival!]], winner: "b" }));
    const after = glickoAfter({ rating: 1543.25, rd: 350 }, [START], 0);
    const change = solo.find((c) => c.identityId === veteran)!;
    expect([change.before, change.rdBefore]).toEqual([1543.25, 350]);
    near({ rating: change.after, rd: change.rdAfter! }, after);
    expect(await ratings.readRating(veteran!, "1v1")).toEqual({ rating: change.after, rd: change.rdAfter, ratedMatches: 8 });
    expect(await ratings.readRating(veteran!, "2v2")).toEqual({ rating: WON.rating, rd: WON.rd, ratedMatches: 1 });
  });

  it("applies a result in one commit holding every rating and the match marker", async () => {
    const namespace = freshNamespace();
    const { xx: x, yy: y, zz: z } = await claim(namespace, "xx", "yy", "zz");
    const commits: { writes: { update?: { name: string }; currentDocument?: unknown }[] }[] = [];
    const recording: typeof fetch = async (input, init) => {
      if (String(input).endsWith(":commit")) commits.push(JSON.parse(String(init!.body)));
      return fetch(input, init);
    };
    applied(await ratingsFor(namespace, recording).applyResult({ matchId: "m", teams: [[x!, y!], [z!]], winner: "a" }));
    expect(commits).toHaveLength(1);
    const prefix = `projects/${projectId}/databases/(default)/documents/namespaces/${namespace}/`;
    expect(commits[0]!.writes.map((write) => write.update?.name).sort()).toEqual(
      [`ratings/${x}`, `ratings/${y}`, `ratings/${z}`, "ratedMatches/m"].map((path) => prefix + path).sort());
    for (const write of commits[0]!.writes) expect(write.currentDocument).toEqual({ exists: false });
    // Another mode's result writes that mode's rows and its own marker, in one commit.
    applied(await ratingsFor(namespace, recording).applyResult({ matchId: "m3", mode: "3v3", teams: [[x!], [y!, z!]], winner: "b" }));
    expect(commits).toHaveLength(2);
    expect(ratingCollection("3v3")).toBe("ratings-3v3");
    expect(commits[1]!.writes.map((write) => write.update?.name).sort()).toEqual(
      [`ratings-3v3/${x}`, `ratings-3v3/${y}`, `ratings-3v3/${z}`, "ratedMatches/m3"].map((path) => prefix + path).sort());
    for (const write of commits[1]!.writes) expect(write.currentDocument).toEqual({ exists: false });
  });

  it("changes nothing when the commit fails or an identity is unknown", async () => {
    const namespace = freshNamespace();
    const { pp: p, qq: q, rr: r } = await claim(namespace, "pp", "qq", "rr");
    const store = storeFor(namespace);
    const ratings = createRatings(store);
    applied(await ratings.applyResult({ matchId: "m0", teams: [[p!], [q!]], winner: "a" }));
    const snapshot = async () => Promise.all([`ratings/${p}`, `ratings/${q}`, `ratings/${r}`, "ratedMatches/m0", "ratedMatches/m1", "ratedMatches/m2"].map((path) => store.get(path)));
    const before = await snapshot();
    expect(before[2]).toBeNull();

    // The commit fails: the emulator's transaction is rolled back (so its locks go)
    // and the caller sees INTERNAL.
    const failingCommit: typeof fetch = async (input, init) => {
      if (!String(input).endsWith(":commit")) return fetch(input, init);
      const { transaction } = JSON.parse(String(init!.body)) as { transaction: string };
      await fetch(String(input).replace(/:commit$/, ":rollback"), { ...init, body: JSON.stringify({ transaction }) });
      return new Response(JSON.stringify({ error: { code: 500, status: "INTERNAL" } }), { status: 500 });
    };
    await expect(ratingsFor(namespace, failingCommit).applyResult({ matchId: "m1", teams: [[p!, r!], [q!]], winner: "b" })).rejects.toThrow(/INTERNAL/);
    expect(await snapshot()).toEqual(before);

    await expect(ratings.applyResult({ matchId: "m2", teams: [[p!, r!], ["no-such-identity"]], winner: "a" })).rejects.toThrow(/unknown identity/);
    expect(await snapshot()).toEqual(before);
    expect(await ratings.readRating(r!)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
  });

  it("applies a match's result once: applying it again leaves every rating unchanged", async () => {
    const namespace = freshNamespace();
    const { aa: a, bb: b, cc: c } = await claim(namespace, "aa", "bb", "cc");
    const ratings = ratingsFor(namespace);
    applied(await ratings.applyResult({ matchId: "m", teams: [[a!], [b!]], winner: "a" }));
    const after = await Promise.all([a!, b!, c!].map((id) => ratings.readRating(id)));
    expect(await ratings.applyResult({ matchId: "m", teams: [[a!], [b!]], winner: "a" })).toEqual({ status: "already_applied" });
    expect(await ratings.applyResult({ matchId: "m", teams: [[c!], [a!]], winner: "draw" })).toEqual({ status: "already_applied" });
    expect(await Promise.all([a!, b!, c!].map((id) => ratings.readRating(id)))).toEqual(after);
  });

  it("takes effect for both of two simultaneous results that share an identity", { timeout: RACE_TIMEOUT }, async () => {
    for (let round = 0; round < 3; round++) {
      const namespace = freshNamespace();
      const { ss: s, xx: x, yy: y, zz: z } = await claim(namespace, "ss", "xx", "yy", "zz");
      const first: MatchResult = { matchId: "m1", teams: [[s!], [x!]], winner: "a" };
      const second: MatchResult = { matchId: "m2", teams: [[s!, y!], [z!]], winner: "b" };
      const serial = (order: MatchResult[]) => {
        const model = new Map<string, Glicko>();
        for (const result of order) simulate(model, result.teams, result.winner);
        return model;
      };
      const firstThenSecond = serial([first, second]), secondThenFirst = serial([second, first]);
      expect(firstThenSecond.get(s!)!.rating).not.toBe(secondThenFirst.get(s!)!.rating);

      const wrap = overlap();
      const [one, two] = await Promise.all([
        ratingsFor(namespace, wrap()).applyResult(first),
        ratingsFor(namespace, wrap()).applyResult(second),
      ]);
      const sOne = applied(one).find((change) => change.identityId === s)!;
      const sTwo = applied(two).find((change) => change.identityId === s)!;
      // Whichever committed second started from the other's result.
      expect(sOne.before === sTwo.after || sTwo.before === sOne.after).toBe(true);

      const ratings = ratingsFor(namespace);
      const actual = new Map<string, Rating>();
      for (const id of [s!, x!, y!, z!]) actual.set(id, await ratings.readRating(id));
      const matches = (model: Map<string, Glicko>) => [s!, x!, y!, z!].every((id) =>
        Math.abs(actual.get(id)!.rating - model.get(id)!.rating) < 1e-9 && Math.abs(actual.get(id)!.rd - model.get(id)!.rd) < 1e-9);
      expect(matches(firstThenSecond) || matches(secondThenFirst)).toBe(true);
      expect((await ratings.readRating(s!)).ratedMatches).toBe(2);
      expect(await ratings.applyResult(first)).toEqual({ status: "already_applied" });
      expect(await ratings.applyResult(second)).toEqual({ status: "already_applied" });
    }
  });

  it("lists rated identities only, highest first, with display names, across pages that include ties", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const ids = createIdentities(storeFor(namespace));
    const kay = await ids.claimUsername("Kite");
    if (!kay.ok) throw new Error(kay.reason);
    const scout = await ids.createHandle(kay.value.key, "scout");
    if (!scout.ok) throw new Error(scout.reason);
    const named = await claim(namespace, "bob", "carol", "dave", "erin", "idle");
    const ratings = ratingsFor(namespace);
    // Three winners tie at WON and three losers at LOST; "idle" never plays.
    applied(await ratings.applyResult({ matchId: "m1", teams: [[kay.value.identity.id], [named.bob!]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m2", teams: [[named.carol!], [scout.value.identity.id]], winner: "b" }));
    applied(await ratings.applyResult({ matchId: "m3", teams: [[named.dave!], [named.erin!]], winner: "a" }));

    const expected: LeaderboardEntry[] = [
      { identityId: kay.value.identity.id, displayName: "Kite", rating: WON.rating, rd: WON.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...WON_ONE },
      { identityId: scout.value.identity.id, displayName: "Kite/scout", rating: WON.rating, rd: WON.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...WON_ONE },
      { identityId: named.dave!, displayName: "dave", rating: WON.rating, rd: WON.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...WON_ONE },
      { identityId: named.bob!, displayName: "bob", rating: LOST.rating, rd: LOST.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...LOST_ONE },
      { identityId: named.carol!, displayName: "carol", rating: LOST.rating, rd: LOST.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...LOST_ONE },
      { identityId: named.erin!, displayName: "erin", rating: LOST.rating, rd: LOST.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...LOST_ONE },
    ].sort(byRank);
    for (const limit of [1, 2, 4, 6, 100]) expect(await allPages(ratings, limit)).toEqual(expected);
    expect(page(await ratings.leaderboard({ limit: 6 })).next).toBeUndefined();
  });

  it("lists each identity once, with first-page values, while ratings move across the cursor both ways", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const named = await claim(namespace, "w1", "w2", "w3", "l1", "l2", "l3", "o1", "o2", "o3", "o4", "o5", "o6");
    const ratings = ratingsFor(namespace);
    for (const n of [1, 2, 3]) {
      applied(await ratings.applyResult({ matchId: `seed${n}`, teams: [[named[`w${n}`]!], [named[`l${n}`]!]], winner: "a" }));
    }
    const snapshot = page(await ratings.leaderboard({ limit: 100 })).entries;
    expect(snapshot).toHaveLength(6);

    let down = "", up = "";
    const pages = await allPages(ratings, 2, async () => {
      // After page 1: page 1's first entry falls to the bottom, and the last entry
      // (not yet listed) rises to the top, each through three results against
      // newcomers, who themselves become rated.
      down = snapshot[0]!.identityId;
      up = snapshot.at(-1)!.identityId;
      for (const n of [1, 2, 3]) {
        applied(await ratings.applyResult({ matchId: `down${n}`, teams: [[down], [named[`o${n}`]!]], winner: "b" }));
        applied(await ratings.applyResult({ matchId: `up${n}`, teams: [[up], [named[`o${n + 3}`]!]], winner: "a" }));
      }
    });
    expect(pages).toEqual(snapshot);

    const current = page(await ratings.leaderboard({ limit: 100 })).entries;
    expect(current).toHaveLength(12);
    // The moves crossed the cursor: among the six first listed, up now ranks first and down last.
    const listed = new Set(snapshot.map((entry) => entry.identityId));
    const listedNow = current.map((entry) => entry.identityId).filter((id) => listed.has(id));
    expect(listedNow[0]).toBe(up);
    expect(listedNow.at(-1)).toBe(down);
    // Glicko moves the newcomers who met them further still (o1 beat down, o4 lost to up),
    // so the whole order is the independent model's over the same results.
    const model = new Map<string, Glicko>();
    for (const n of [1, 2, 3]) simulate(model, [[named[`w${n}`]!], [named[`l${n}`]!]], "a");
    for (const n of [1, 2, 3]) {
      simulate(model, [[down], [named[`o${n}`]!]], "b");
      simulate(model, [[up], [named[`o${n + 3}`]!]], "a");
    }
    const modelOrder = [...model].map(([identityId, { rating }]) => ({ identityId, rating }) as LeaderboardEntry).sort(byRank);
    expect(current.map((entry) => entry.identityId)).toEqual(modelOrder.map((entry) => entry.identityId));
    for (const entry of current) near(entry, model.get(entry.identityId)!, entry.identityId);
  });

  it("lists a mode's everyone rankings with house agents included, and its house rankings by ownership alone, each paging to its last entry on its own", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const { store, house, others } = await rankingWorld(namespace);
    const { store: recorded, rows } = recordingQueries(store);
    const ratings = createRatings(recorded);
    await ratings.houseBackfill;
    // House agents and others interleave in rating order, with ties.
    applied(await ratings.applyResult({ matchId: "m1", teams: [[house.antwars], [others.bob]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m2", teams: [[others.impostor], [house.scout]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m3", teams: [[house.worker], [others.kiteScout]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m4", teams: [[others.kite], [others.carol]], winner: "b" }));
    applied(await ratings.applyResult({ matchId: "m5", teams: [[house.antwars], [others.kite]], winner: "draw" }));

    // Each identity's results above, newest first.
    const forms: Record<string, string> = { [house.antwars]: "DW", [others.kite]: "DL", [house.scout]: "L", [others.bob]: "L", [others.kiteScout]: "L",
      [house.worker]: "W", [others.impostor]: "W", [others.carol]: "W" };
    const entryOf = async (identityId: string, displayName: string): Promise<LeaderboardEntry> => {
      const letters = [...forms[identityId]!] as ("W" | "L" | "D")[];
      const tally = (letter: string) => letters.filter((each) => each === letter).length;
      return { identityId, displayName, ...(await ratings.readRating(identityId)), thinkingLevel: null, serviceTier: null,
        benchmark: (Object.values(house) as string[]).includes(identityId),
        wins: tally("W"), losses: tally("L"), draws: tally("D"), form: letters.map((result) => ({ result, replayId: null })) };
    };
    const houseEntries = (await Promise.all([
      entryOf(house.antwars, "antwars"), entryOf(house.scout, "antwars/scout"), entryOf(house.worker, "antwars/worker"),
    ])).sort(byRank);
    const everyone = [...houseEntries, ...await Promise.all([
      entryOf(others.bob, "bob"), entryOf(others.impostor, "antwars/impostor"), entryOf(others.kiteScout, "Kite/scout"),
      entryOf(others.kite, "Kite"), entryOf(others.carol, "carol"),
    ])].sort(byRank);
    expect(everyone).toHaveLength(8); // dave was never rated

    for (const limit of [1, 2, 3, 100]) {
      expect(await allPages(ratings, limit, undefined, { mode: "1v1" })).toEqual(everyone);
      expect(await allPages(ratings, limit, undefined, { mode: "1v1", scope: "everyone" })).toEqual(everyone);
      rows.length = 0;
      expect(await allPages(ratings, limit, undefined, { mode: "1v1", scope: "house" })).toEqual(houseEntries);
      // The house rankings never read another identity's row.
      expect(new Set(rows)).toEqual(new Set(houseEntries.map((entry) => `ratings/${entry.identityId}`)));
    }
    const housePage = page(await ratings.leaderboard({ mode: "1v1", scope: "house", limit: 3 }));
    expect(housePage).toEqual({ entries: houseEntries });
    // Every other mode is unrated so far.
    for (const mode of ["2v2", "3v3", "4v4"] as const) {
      expect(await ratings.leaderboard({ mode })).toEqual({ ok: true, value: { entries: [] } });
      expect(await ratings.leaderboard({ mode, scope: "house" })).toEqual({ ok: true, value: { entries: [] } });
    }
  });

  it("keeps each mode's rankings to the identities rated in that mode", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const { store, house, others } = await rankingWorld(namespace);
    const ratings = ratingsFor(namespace);
    await ratings.houseBackfill;
    applied(await ratings.applyResult({ matchId: "solo", teams: [[house.antwars], [others.bob]], winner: "a" }));
    // Team-mode rows as rating writes leave them, the house marker on house-owned rows only.
    const seeded: Record<"2v2" | "3v3" | "4v4", [string, number, boolean][]> = {
      "2v2": [[house.scout, 1540, true], [others.impostor, 1530, false], [house.worker, 1490, true], [others.carol, 1470, false]],
      "3v3": [[others.kite, 1525, false], [house.antwars, 1525, true], [others.kiteScout, 1480, false]],
      "4v4": [[others.dave, 1510, false], [others.bob, 1505, false]],
    };
    const display = new Map([[house.antwars, "antwars"], [house.scout, "antwars/scout"], [house.worker, "antwars/worker"],
      [others.kite, "Kite"], [others.kiteScout, "Kite/scout"], [others.bob, "bob"], [others.carol, "carol"], [others.dave, "dave"],
      [others.impostor, "antwars/impostor"]]);
    const isHouse = new Set(Object.values(house));
    const docs: Record<string, Fields> = {};
    for (const [mode, rows] of Object.entries(seeded) as [RankedMode, [string, number, boolean][]][]) {
      for (const [id, rating, marked] of rows) {
        const key = encodeRating(rating);
        docs[`${ratingCollection(mode)}/${id}`] = { rating: key, rd: encodeRating(INITIAL_RD), ratedMatches: "2", displayName: display.get(id)!, ...(marked ? { houseRating: key } : {}) };
      }
    }
    await createDocs(store, docs);

    for (const [mode, rows] of Object.entries(seeded) as [RankedMode, [string, number, boolean][]][]) {
      const everyone = rows.map(([identityId, rating, marked]) => ({ identityId, displayName: display.get(identityId)!, rating, rd: 350, ratedMatches: 2, thinkingLevel: null, serviceTier: null, benchmark: marked, ...NO_RECORD })).sort(byRank);
      const houseOnly = everyone.filter((entry) => isHouse.has(entry.identityId));
      for (const limit of [1, 2, 100]) {
        expect(await allPages(ratings, limit, undefined, { mode })).toEqual(everyone);
        expect(await allPages(ratings, limit, undefined, { mode, scope: "house" })).toEqual(houseOnly);
      }
    }
    expect(await allPages(ratings, 1, undefined, { mode: "1v1" })).toEqual([
      { identityId: house.antwars, displayName: "antwars", rating: WON.rating, rd: WON.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...WON_ONE },
      { identityId: others.bob, displayName: "bob", rating: LOST.rating, rd: LOST.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...LOST_ONE },
    ]);
    expect(await allPages(ratings, 1, undefined, { mode: "1v1", scope: "house" })).toEqual([
      { identityId: house.antwars, displayName: "antwars", rating: WON.rating, rd: WON.rd, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...WON_ONE },
    ]);
  });

  it("serves the 1v1 everyone rankings, in today's request, entry and cursor form, when called without a mode", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const { store, house, others } = await rankingWorld(namespace);
    const ratings = ratingsFor(namespace);
    await ratings.houseBackfill;
    applied(await ratings.applyResult({ matchId: "m1", teams: [[house.scout], [others.bob]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m2", teams: [[others.carol], [others.dave]], winner: "b" }));
    await createDocs(store, { [`${ratingCollection("2v2")}/${others.kite}`]: { rating: encodeRating(1600), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "Kite" } });

    const solo = page(await ratings.leaderboard({ mode: "1v1", limit: 100 })).entries;
    expect(solo.map((entry) => entry.identityId).sort()).toEqual([house.scout, others.bob, others.carol, others.dave].sort());
    expect(page(await ratings.leaderboard()).entries).toEqual(solo);
    expect(await allPages(ratings, 1)).toEqual(solo);
    for (const entry of solo) expect(Object.keys(entry).sort()).toEqual(["benchmark", "displayName", "draws", "form", "identityId", "losses", "ratedMatches", "rating", "rd", "serviceTier", "thinkingLevel", "wins"]);

    // A no-mode cursor keeps today's three-part form and serves explicit 1v1 everyone pages alike.
    const first = page(await ratings.leaderboard({ limit: 2 }));
    expect(cursorParts(first.next!)).toHaveLength(3);
    const viaDefault = page(await ratings.leaderboard({ limit: 2, cursor: first.next }));
    expect(page(await ratings.leaderboard({ mode: "1v1", scope: "everyone", limit: 2, cursor: first.next }))).toEqual(viaDefault);
    expect([...first.entries, ...viaDefault.entries]).toEqual(solo);
  });

  it("accepts a cursor only with the mode and scope that issued it", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const { store, house, others } = await rankingWorld(namespace);
    const ratings = ratingsFor(namespace);
    await ratings.houseBackfill;
    applied(await ratings.applyResult({ matchId: "m1", teams: [[house.antwars], [others.bob]], winner: "a" }));
    applied(await ratings.applyResult({ matchId: "m2", teams: [[house.scout], [others.carol]], winner: "b" }));
    const key = encodeRating(1520);
    await createDocs(store, {
      [`${ratingCollection("2v2")}/${house.worker}`]: { rating: key, rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "antwars/worker", houseRating: key },
      [`${ratingCollection("2v2")}/${house.scout}`]: { rating: encodeRating(1480), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "antwars/scout", houseRating: encodeRating(1480) },
      [`${ratingCollection("2v2")}/${others.dave}`]: { rating: encodeRating(1500), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "dave" },
    });
    const queries: Rankings[] = [{}, { mode: "1v1", scope: "house" }, { mode: "2v2" }, { mode: "2v2", scope: "house" }];
    for (const issuer of queries) {
      const { next } = page(await ratings.leaderboard({ ...issuer, limit: 1 }));
      expect(next).toBeDefined();
      for (const other of queries) {
        const sameRankings = (issuer.mode ?? "1v1") === (other.mode ?? "1v1") && (issuer.scope ?? "everyone") === (other.scope ?? "everyone");
        const outcome = await ratings.leaderboard({ ...other, limit: 1, cursor: next });
        if (sameRankings) expect(outcome.ok).toBe(true);
        else expect(outcome).toEqual({ ok: false, reason: "invalid_cursor" });
      }
    }
  });

  it("marks house-owned 1v1 rows rated before the house marker when the ratings store is created, once and idempotently", { timeout: SLOW }, async () => {
    const namespace = freshNamespace();
    const store = storeFor(namespace);
    const ids = createIdentities(store);
    const antwars = issued(await ids.claimUsername("antwars"));
    const scout = issued(await ids.createHandle(antwars.key, "scout")).identity.id;
    const { bob } = await claim(namespace, "bob");
    // Rows as servers before the marker wrote them: none marked, one with a stale
    // marker; a full first page of others ranks above them, so the scan pages.
    const docs: Record<string, Fields> = {
      [`ratings/${antwars.identity.id}`]: { rating: encodeRating(1490), rd: encodeRating(INITIAL_RD), ratedMatches: "3", displayName: "antwars" },
      [`ratings/${scout}`]: { rating: encodeRating(1530), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "antwars/scout", houseRating: encodeRating(1400) },
      [`ratings/${bob}`]: { rating: encodeRating(1510), rd: encodeRating(INITIAL_RD), ratedMatches: "2", displayName: "bob" },
    };
    for (let n = 0; n < 100; n++) docs[`ratings/filler${n}`] = { rating: encodeRating(1600 + n), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: `filler${n}` };
    await createDocs(store, docs);

    const ratings = createRatings(store);
    await ratings.houseBackfill;
    expect(page(await ratings.leaderboard({ mode: "1v1", scope: "house" })).entries).toEqual([
      { identityId: scout, displayName: "antwars/scout", rating: 1530, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
      { identityId: antwars.identity.id, displayName: "antwars", rating: 1490, rd: 350, ratedMatches: 3, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
    ]);
    expect((await store.get(`ratings/${bob}`))?.houseRating).toBeUndefined();
    expect(await markHouseRatings(store)).toBe(0);
    // A later rated result keeps the marker current.
    applied(await ratings.applyResult({ matchId: "m", teams: [[antwars.identity.id], [bob!]], winner: "a" }));
    const after = await ratings.readRating(antwars.identity.id);
    // From 1490 ± 350 a win over 1510 ± 350 moves it past the scout's 1530.
    expect(after.rating).toBeGreaterThan(1530);
    expect(page(await ratings.leaderboard({ mode: "1v1", scope: "house" })).entries).toEqual([
      { identityId: antwars.identity.id, displayName: "antwars", ...after, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
      { identityId: scout, displayName: "antwars/scout", rating: 1530, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
    ]);
    expect(await markHouseRatings(store)).toBe(0);
  });

  /** House-owned 1v1 rows as servers before the marker wrote them, and the house rankings they make once marked. */
  async function unmarkedHouseRows() {
    const namespace = freshNamespace();
    const store = storeFor(namespace);
    const ids = createIdentities(store);
    const antwars = issued(await ids.claimUsername("antwars"));
    const scout = issued(await ids.createHandle(antwars.key, "scout")).identity.id;
    const { bob } = await claim(namespace, "bob");
    await createDocs(store, {
      [`ratings/${antwars.identity.id}`]: { rating: encodeRating(1490), rd: encodeRating(INITIAL_RD), ratedMatches: "3", displayName: "antwars" },
      [`ratings/${scout}`]: { rating: encodeRating(1530), rd: encodeRating(INITIAL_RD), ratedMatches: "1", displayName: "antwars/scout" },
      [`ratings/${bob}`]: { rating: encodeRating(1510), rd: encodeRating(INITIAL_RD), ratedMatches: "2", displayName: "bob" },
    });
    const houseEntries: LeaderboardEntry[] = [
      { identityId: scout, displayName: "antwars/scout", rating: 1530, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
      { identityId: antwars.identity.id, displayName: "antwars", rating: 1490, rd: 350, ratedMatches: 3, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD },
    ];
    return { store, houseEntries };
  }

  it("answers a house read made while the house marker backfill runs only once it has finished, with the complete rankings", { timeout: SLOW }, async () => {
    const { store, houseEntries } = await unmarkedHouseRows();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The backfill starts by looking up the antwars username; hold it there.
    const gated: Store = { ...store, async get(path) { if (path === "usernames/antwars") await held; return store.get(path); } };
    const ratings = createRatings(gated);
    let answered = false;
    const houseRead = ratings.leaderboard({ mode: "1v1", scope: "house" }).finally(() => { answered = true; });
    // The everyone rankings do not wait for the backfill.
    expect(page(await ratings.leaderboard({ mode: "1v1" })).entries).toHaveLength(3);
    await sleep(200);
    expect(answered).toBe(false);
    release();
    expect(page(await houseRead).entries).toEqual(houseEntries);
  });

  it("answers house reads house_unavailable after a failed house marker backfill, and serves them once its single rerun succeeds", { timeout: SLOW }, async () => {
    const { store, houseEntries } = await unmarkedHouseRows();
    let lookups = 0;
    const flaky: Store = { ...store, async get(path) {
      if (path === "usernames/antwars" && lookups++ === 0) throw new Error("UNAVAILABLE: scripted backfill failure");
      return store.get(path);
    } };
    const ratings = createRatings(flaky);
    await ratings.houseBackfill;
    expect(lookups).toBe(1);
    // The everyone rankings are unaffected; the house rankings refuse rather than serve the unmarked rows as none.
    expect(page(await ratings.leaderboard({ mode: "1v1" })).entries).toHaveLength(3);
    const refused = await Promise.all([ratings.leaderboard({ mode: "1v1", scope: "house" }), ratings.leaderboard({ mode: "1v1", scope: "house" })]);
    expect(refused).toEqual([{ ok: false, reason: "house_unavailable" }, { ok: false, reason: "house_unavailable" }]);
    await ratings.houseBackfill;
    expect(lookups).toBe(2); // one rerun, however many reads were refused
    expect(page(await ratings.leaderboard({ mode: "1v1", scope: "house" })).entries).toEqual(houseEntries);
  });
});

describe("ratings without the emulator", () => {
  it("imports under Node's own TypeScript stripping, as npm start runs it", async () => {
    const script = 'await import("./src/rating/ratings.ts");';
    await promisify(execFile)(process.execPath, ["--import", "./src/ts-resolve.mjs", "--input-type=module", "-e", script]);
  });

  /** Creating ratings first looks for the antwars username, to mark house rows; these scripts have none. */
  const houseClaimAbsent = (input: string | URL | Request, init?: RequestInit): Response | undefined =>
    init?.method === "GET" && String(input).endsWith("/usernames/antwars")
      ? new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 })
      : undefined;

  /** Scripted Firestore replies, in order; records each request's URL and body. */
  function scripted(replies: { status?: number; body: unknown }[]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const request: typeof fetch = async (input, init) => {
      const absent = houseClaimAbsent(input, init);
      if (absent) return absent;
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected request ${String(input)}`);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    };
    const store = createFirestore({ projectId: "demo-antwar", namespace: "scripted", emulatorHost: "scripted:1", request });
    // Query/cursor transport fixture: identity projection has separate retention
    // integration coverage, and must not consume this scripted query response stream.
    return { calls, ratings: createRatings(store, { findById: async id => ({ id, kind: "username", displayName: id }) }) };
  }
  const prefix = "projects/demo-antwar/databases/(default)/documents/namespaces/scripted/";
  const failed = (status: string, code: number) => ({ status: code, body: { error: { code, status } } });
  const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const readTime = "2026-10-19T07:50:09.556609123Z";
  const goodCursor = cursorOf([readTime, encodeRating(1516), "abc"]);
  const row = (id: string, rating: number) => ({
    readTime,
    document: { name: `${prefix}ratings/${id}`, fields: { rating: { stringValue: encodeRating(rating) }, rd: { stringValue: encodeRating(INITIAL_RD) }, ratedMatches: { stringValue: "1" }, displayName: { stringValue: id } } },
  });

  it("keeps the first page's readTime verbatim and sends it, with the cursor, for every later page", async () => {
    const { calls, ratings } = scripted([
      { body: [row("c", 1516), row("b", 1500), row("a", 1484)] },
      { body: [row("a", 1484)] },
    ]);
    const first = page(await ratings.leaderboard({ limit: 2 }));
    expect(first.entries.map((entry) => entry.identityId)).toEqual(["c", "b"]);
    expect(calls[0]!.body).not.toHaveProperty("readTime");
    const second = page(await ratings.leaderboard({ limit: 2, cursor: first.next }));
    expect(second).toEqual({ entries: [{ identityId: "a", displayName: "a", rating: 1484, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: false, ...NO_RECORD }] });
    expect(calls[1]!.body.readTime).toBe(readTime);
    expect((calls[1]!.body.structuredQuery as { startAt: unknown }).startAt).toEqual({
      values: [{ stringValue: encodeRating(1500) }, { referenceValue: `${prefix}ratings/b` }], before: false,
    });
  });

  it("pins later pages to the last readTime of the first page's stream, including a progress-only element", async () => {
    // Firestore may raise readTime along one stream; B could have moved between
    // the first and last readTime, so pinning to the first could list B again.
    // The database answers each later page as of the readTime it is sent: at the
    // first time T1, B had not yet been read at 1506 and still sorts below the
    // cursor at 1490 (so it is listed again); at the stream's last time T4 it is not.
    const at = (time: string, element: object) => ({ ...element, readTime: time });
    const times = ["2026-10-19T08:00:00.000001Z", "2026-10-19T08:00:00.000002Z", "2026-10-19T08:00:00.000003Z", "2026-10-19T08:00:00.000004009Z"];
    const sent: unknown[] = [];
    const request: typeof fetch = async (input, init) => {
      const absent = houseClaimAbsent(input, init);
      if (absent) return absent;
      const body = JSON.parse(String(init!.body)) as { readTime?: string };
      sent.push(body.readTime);
      const reply = body.readTime === undefined
        ? [at(times[0]!, row("a", 1516)), at(times[1]!, row("b", 1506)), at(times[2]!, row("c", 1500)), { readTime: times[3], done: true }]
        : body.readTime === times[0]
          ? [at(times[0]!, row("c", 1500)), at(times[0]!, row("b", 1490))]
          : [at(body.readTime!, row("c", 1500))];
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    const ratings = createRatings(createFirestore({ projectId: "demo-antwar", namespace: "scripted", emulatorHost: "scripted:1", request }),
      { findById: async id => ({ id, kind: "username", displayName: id }) });
    const listed = (await allPages(ratings, 2)).map((entry) => entry.identityId);
    expect(listed).toEqual(["a", "b", "c"]);
    expect(sent).toEqual([undefined, times[3]]);
  });

  it("refuses a cursor it did not issue without reading anything", async () => {
    const { calls, ratings } = scripted([]);
    const bad = [
      "", "not a cursor!", Buffer.from("{").toString("base64url"),
      cursorOf([readTime, encodeRating(1516)]), cursorOf({ readTime }),
      cursorOf(["2026-10-19", encodeRating(1516), "abc"]), cursorOf([readTime, "zz", "abc"]),
      cursorOf([readTime, encodeRating(1516), "a/b"]), cursorOf([readTime, encodeRating(1516), "__x__"]),
      cursorOf([readTime, encodeRating(1516), ""]), cursorOf([readTime, encodeRating(1516), 7]),
      cursorOf([readTime, encodeRating(1516), "abc", "2v2"]), cursorOf([readTime, encodeRating(1516), "abc", "5v5", "everyone"]),
      cursorOf([readTime, encodeRating(1516), "abc", "2v2", "staff"]), cursorOf([readTime, encodeRating(1516), "abc", "2v2", "house", 1]),
    ];
    for (const cursor of bad) expect(await ratings.leaderboard({ limit: 2, cursor })).toEqual({ ok: false, reason: "invalid_cursor" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a later page Firestore will not read at the cursor's time, keeping its error and never reading the current state", async () => {
    for (const status of ["INVALID_ARGUMENT", "FAILED_PRECONDITION"]) {
      const { calls, ratings } = scripted([failed(status, 400)]);
      const outcome = await ratings.leaderboard({ limit: 2, cursor: goodCursor });
      expect(outcome).toMatchObject({ ok: false, reason: "cursor_expired" });
      const cause = (outcome as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(FirestoreError);
      expect((cause as FirestoreError).status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.readTime).toBe(readTime);
    }
    const unavailable = scripted([failed("UNAVAILABLE", 503)]);
    await expect(unavailable.ratings.leaderboard({ limit: 2, cursor: goodCursor })).rejects.toThrow(/UNAVAILABLE/);
    expect(unavailable.calls).toHaveLength(1);
    const firstPage = scripted([failed("INVALID_ARGUMENT", 400)]);
    await expect(firstPage.ratings.leaderboard({ limit: 2 })).rejects.toThrow(/INVALID_ARGUMENT/);
  });

  it("refuses malformed results, ids and page sizes before any request", async () => {
    const { calls, ratings } = scripted([]);
    const ok = (teams: MatchResult["teams"], matchId = "m", winner: Winner = "a") => ({ matchId, teams, winner });
    const malformed: MatchResult[] = [
      ok([[], ["b"]]), ok([["a"], []]),
      ok([["a", "a"], ["b"]]), ok([["a"], ["b", "a"]]),
      ok([["a/b"], ["c"]]), ok([[""], ["c"]]), ok([["__a__"], ["c"]]), ok([["x".repeat(129)], ["c"]]),
      ok([["a"], ["b"]], "m/1"), ok([["a"], ["b"]], ""), ok([["a"], ["b"]], "__m__"), ok([["a"], ["b"]], "m".repeat(129)),
      ok([["a"], ["b"]], "m", "c" as Winner),
      { matchId: "m", teams: [["a"], ["b"], ["c"]] as unknown as MatchResult["teams"], winner: "a" },
      ...["5v5", "", "1V1", "ratings"].map((mode) => ({ ...ok([["a"], ["b"]]), mode: mode as RankedMode })),
    ];
    for (const result of malformed) await expect(ratings.applyResult(result)).rejects.toThrow();
    await expect(ratings.readRating("a/b")).rejects.toThrow();
    for (const mode of ["5v5", "", "1V1", "ratings"]) {
      await expect(ratings.readRating("a", mode as RankedMode)).rejects.toThrow(/unknown ranked mode/);
      expect(() => ratingCollection(mode as RankedMode)).toThrow(/unknown ranked mode/);
    }
    for (const limit of [0, 101, 1.5]) await expect(ratings.leaderboard({ limit })).rejects.toThrow(RangeError);
    await expect(ratings.leaderboard({ mode: "5v5" as RankedMode })).rejects.toThrow(RangeError);
    await expect(ratings.leaderboard({ scope: "staff" as LeaderboardScope })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("reads a mode's house rankings ordered by the house marker in that mode's collection, and its everyone rankings by rating", async () => {
    const houseRow = (id: string, rating: number) => ({
      readTime,
      document: { name: `${prefix}ratings-2v2/${id}`, fields: {
        rating: { stringValue: encodeRating(rating) }, houseRating: { stringValue: encodeRating(rating) },
        rd: { stringValue: encodeRating(INITIAL_RD) }, ratedMatches: { stringValue: "1" }, displayName: { stringValue: id },
      } },
    });
    const { calls, ratings } = scripted([{ body: [houseRow("h2", 1516), houseRow("h1", 1500)] }, { body: [houseRow("h1", 1500)] }, { body: [{ readTime }] }]);
    const first = page(await ratings.leaderboard({ mode: "2v2", scope: "house", limit: 1 }));
    expect(first.entries).toEqual([{ identityId: "h2", displayName: "h2", rating: 1516, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD }]);
    expect(cursorParts(first.next!)).toEqual([readTime, encodeRating(1516), "h2", "2v2", "house"]);
    expect(page(await ratings.leaderboard({ mode: "2v2", scope: "house", limit: 1, cursor: first.next }))).toEqual({
      entries: [{ identityId: "h1", displayName: "h1", rating: 1500, rd: 350, ratedMatches: 1, thinkingLevel: null, serviceTier: null, benchmark: true, ...NO_RECORD }],
    });
    expect(calls.map((call) => call.body.structuredQuery)).toEqual([
      expect.objectContaining({ from: [{ collectionId: "ratings-2v2" }], orderBy: [
        { field: { fieldPath: "houseRating" }, direction: "DESCENDING" }, { field: { fieldPath: "__name__" }, direction: "DESCENDING" },
      ] }),
      expect.objectContaining({ from: [{ collectionId: "ratings-2v2" }], startAt: {
        values: [{ stringValue: encodeRating(1516) }, { referenceValue: `${prefix}ratings-2v2/h2` }], before: false,
      } }),
    ]);
    page(await ratings.leaderboard({ mode: "3v3" }));
    expect(calls[2]!.body.structuredQuery).toMatchObject({ from: [{ collectionId: "ratings-3v3" }], orderBy: [{ field: { fieldPath: "rating" } }, {}] });
  });

  it("encodes ratings so string order is numeric order, exactly and reversibly", () => {
    const values = [-1e300, -1500, -1, -Number.MIN_VALUE, 0, Number.MIN_VALUE, 1, 1484, 1500, 1500.0000000000002, 1516, 1e300];
    const keys = values.map(encodeRating);
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
    for (const [i, key] of keys.entries()) {
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(decodeRating(key)).toBe(values[i]);
    }
    expect(encodeRating(-0)).toBe(encodeRating(0));
    expect(Object.is(decodeRating(encodeRating(-0)), 0)).toBe(true);
    for (const value of [Number.NaN, Infinity, -Infinity]) expect(() => encodeRating(value)).toThrow(RangeError);
    for (const key of ["zz", "ffffffffffffffff", "0000000000000000", encodeRating(1).toUpperCase()]) expect(() => decodeRating(key)).toThrow();
  });
});
