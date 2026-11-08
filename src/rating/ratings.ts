/// <reference types="node" />
import { FirestoreError, type Fields, type QueryResult, type Store, type TransactionRead, type TransactionStep, type Write } from "../store/firestore.js";
import { createIdentities, type Identities } from "../identity/identities.js";
import { placeholder } from "../identity/retention.js";
import { HOUSE_USERNAME, houseOwnedAmong } from "../identity/houseOwnership.js";
import { houseLabel } from "./houseLabels.js";
import { logUnlistedHouse } from "./unlistedHouse.js";
import { isReplayId } from "../replays/access.js";
import { INITIAL_RD, glickoUpdate, inflatedRd, teamAsOpponent } from "./glicko.js";

/**
 * Per-identity ratings and the public leaderboard.
 * Every identity has a separate
 * rating in each ranked mode
 * and starts at 1500 with RD 350 in each. A rated result names its mode and moves
 * only that mode's ratings, by Glicko-1 (glicko.ts): each player against
 * one opponent at the other team's mean rating and root-mean-square RD, by its own
 * RD, after growing that RD by the time since its previous rated match in the mode
 * (the lobby's match time, so a replay computes the same numbers). Which matches
 * are rated, and keeping the house planner out, belong to the caller.
 *
 * Documents, under the store's namespace:
 *   ratings/{identityId}         { rating, rd, ratedAt?, ratedMatches, displayName, houseRating? }  1v1, from the first rated result on
 *   ratings-{mode}/{identityId}  likewise, every other ranked mode
 *   ratedMatches/{matchId}       { changes }                                          a result applies once per match, in any mode
 *
 * rd is stored like rating; a row without it is malformed. ratedAt (milliseconds, the
 * match time of the row's latest rated result) is absent when that result named no
 * match time. A change record's entries carry rdBefore and rdAfter, except on records
 * stored before the Glicko switch.
 *   migrations/ratingRecordFill  { completedAt, filled, unreconciled, skipped }       the record fill-in has run
 *
 * 1v1 keeps the collection of the single rating that came before modes, so an
 * identity rated before then has that rating and count as its 1v1 rating and count,
 * and starts fresh in every other mode.
 * A rating row also carries the identity's record in that mode: wins,
 * losses and draws, which add up to ratedMatches, and form, its up to five newest
 * rated results newest first as space-separated "W|L|D:{matchId}". A row rated
 * before the record existed has none of these until fillRatingRecords reconciles it
 * from the ended rated lobbies; until then a rated result leaves them absent, so a
 * record is never partial.
 * houseRating, a copy of rating present only on the rows of identities the antwars
 * username owns (src/identity/houseOwnership.ts), is the house marker: ordering by it reads the house
 * rankings alone, because a query ordered by a field never returns a document
 * without that field.
 *
 * The store keeps strings only, so a rating is stored as an order-preserving hex
 * form of its exact float64: string order is numeric order, and nothing is rounded.
 */

export const INITIAL_RATING = 1500;
export { INITIAL_RD };
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** everyone: every identity rated in the mode, house agents included. house: only identities the antwars username owns. */
export type LeaderboardScope = "everyone" | "house";
export const LEADERBOARD_SCOPES: readonly LeaderboardScope[] = ["everyone", "house"];

const HOUSE_RATING = "houseRating";

export type Winner = "a" | "b" | "draw";

/** The modes rated separately. Every rating read and write accepts exactly these. */
export type RankedMode = "1v1" | "2v2" | "3v3" | "4v4" | "house-1v1" | "house-2v2" | "house-3v3" | "house-4v4";
export const RANKED_MODES: readonly RankedMode[] = ["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"];
export const isRankedMode = (mode: unknown): mode is RankedMode => RANKED_MODES.includes(mode as RankedMode);

/** Where a mode's rating rows live: `ratings` for 1v1, `ratings-{mode}` for every other mode. */
export function ratingCollection(mode: RankedMode): string {
  if (!isRankedMode(mode)) throw new Error(`unknown ranked mode: ${String(mode)}`);
  return mode === "1v1" ? "ratings" : `ratings-${mode}`;
}

/** Recorded level of an identity's canonical seat (seat 1); absent entries mean not recorded. */
export type ThinkingLevels = Readonly<Record<string, string | null>>;
/** Self-reported service tier of an identity's canonical seat (seat 1); absent entries mean not recorded. */
export type ServiceTiers = Readonly<Record<string, string | null>>;
/** Self-reported model label of an identity's canonical seat (seat 1); absent entries mean not recorded. Stored on the
 * rating row only, replaced by each rated match; the leaderboard does not serve it. */
export type ModelLabels = Readonly<Record<string, string | null>>;

export interface MatchResult {
  readonly matchId: string;
  /** Identity ids of the two teams; every identity appears once in the match. */
  readonly teams: readonly [readonly string[], readonly string[]];
  readonly winner: Winner;
  /** The ranked mode whose ratings the result moves; 1v1 when omitted. */
  readonly mode?: RankedMode;
  /** The match's time in milliseconds (the lobby's startsAt, else createdAt): Glicko grows RD by the time between a player's matches. */
  readonly at?: number;
  readonly thinkingLevels?: ThinkingLevels;
  readonly serviceTiers?: ServiceTiers;
  readonly modelLabels?: ModelLabels;
}

export interface RatingChange {
  readonly identityId: string;
  readonly before: number;
  readonly after: number;
  /** The stored RD before the match (before inactivity growth) and after it; absent on change records stored before the Glicko switch. */
  readonly rdBefore?: number;
  readonly rdAfter?: number;
}

export type ApplyOutcome =
  | { readonly status: "applied"; readonly changes: readonly RatingChange[] }
  | { readonly status: "already_applied" };

export interface Rating {
  readonly rating: number;
  /** Rating deviation: 350 before the first rated result in the mode. */
  readonly rd: number;
  readonly ratedMatches: number;
}

export interface LeaderboardEntry extends Rating {
  readonly identityId: string;
  /** The username, or owner/handle. */
  readonly displayName: string;
  /**
   * A Benchmark row: its handle's fixed level (HOUSE_LABELS), never a seat's report; null for an unlisted handle.
   * Any other row: the self-reported level in the latest rated match in this mode; null for missing or historical data.
   */
  readonly thinkingLevel: string | null;
  /** Likewise: a Benchmark row's fixed tier, otherwise the self-reported service tier in the latest rated match in this mode. */
  readonly serviceTier: string | null;
  /** Owned by the antwars username, from the row's house marker (stored owner), never from the name. */
  readonly benchmark: boolean;
  /** Rated results in this mode; wins + losses + draws = ratedMatches. All three null while the row's record is not yet reconciled. */
  readonly wins: number | null;
  readonly losses: number | null;
  readonly draws: number | null;
  /** Up to five newest rated results in this mode, newest first; empty while the record is not yet reconciled. */
  readonly form: readonly FormEntry[];
}

export type MatchResultLetter = "W" | "L" | "D";

export interface FormEntry {
  readonly result: MatchResultLetter;
  /** The match's stored replay id, or null when none is stored (matches from before replay ids were stored, or playback not finished). */
  readonly replayId: string | null;
}

export const FORM_LENGTH = 5;

/** One identity's stored record in one mode. */
export interface RatingRecord {
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  /** Newest first, at most FORM_LENGTH. */
  readonly form: readonly { readonly result: MatchResultLetter; readonly matchId: string }[];
}

export interface LeaderboardPage {
  readonly entries: readonly LeaderboardEntry[];
  /** Present only when more entries follow; pass it back for the next page. */
  readonly next?: string;
}

/**
 * A cursor's pages all read the database as of its first page. invalid_cursor: not
 * a cursor this module issued for the same mode and scope. cursor_expired: Firestore refused to read at the
 * cursor's time (cause kept for diagnosis); start again from the first page.
 * house_unavailable: the house marker backfill has not succeeded, so the house
 * rankings could be incomplete; nothing is served until it has.
 */
export type LeaderboardOutcome =
  | { readonly ok: true; readonly value: LeaderboardPage }
  | { readonly ok: false; readonly reason: "invalid_cursor" }
  | { readonly ok: false; readonly reason: "cursor_expired"; readonly cause: FirestoreError }
  | { readonly ok: false; readonly reason: "house_unavailable" };

export interface Ratings {
  /** The rating, RD and rated-match count in one mode, 1v1 when omitted; 1500, 350 and 0 before the identity's first rated result there. */
  readRating(identityId: string, mode?: RankedMode): Promise<Rating>;
  /** Actual committed deltas, never inferred from a player's later account rating. null until recorded. */
  readMatchChanges(matchId: string): Promise<readonly RatingChange[] | null>;
  applyResult(result: MatchResult): Promise<ApplyOutcome>;
  /** One ranked mode's rankings, highest first; mode defaults to 1v1 and scope to everyone. */
  leaderboard(options?: {
    readonly mode?: RankedMode; readonly scope?: LeaderboardScope; readonly limit?: number; readonly cursor?: string;
  }): Promise<LeaderboardOutcome>;
}

/** Identity and match ids: document IDs Firestore accepts, without path characters. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_ID = /^__.*__$/;
export const isValidId = (id: unknown): id is string => typeof id === "string" && ID.test(id) && !RESERVED_ID.test(id);

const RATING_KEY = /^[0-9a-f]{16}$/;
const READ_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SIGN = 0x8000000000000000n;
const ALL = 0xffffffffffffffffn;

/** Order-preserving hex of a finite float64; -0 is stored as 0. */
export function encodeRating(rating: number): string {
  if (!Number.isFinite(rating)) throw new RangeError(`rating must be finite: ${rating}`);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, rating === 0 ? 0 : rating);
  const bits = view.getBigUint64(0);
  return ((bits & SIGN) !== 0n ? ~bits & ALL : bits | SIGN).toString(16).padStart(16, "0");
}

export function decodeRating(key: string): number {
  if (!RATING_KEY.test(key)) throw new Error(`invalid stored rating: ${key}`);
  const ordered = BigInt(`0x${key}`);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, (ordered & SIGN) !== 0n ? ordered & ~SIGN : ~ordered & ALL);
  const rating = view.getFloat64(0);
  if (!Number.isFinite(rating)) throw new Error(`invalid stored rating: ${key}`);
  return rating;
}

/** One identity's rating state in one mode as stored: ratedAt null where the row has none (never rated, or no match time). */
export interface PlayerState {
  readonly rating: number;
  readonly rd: number;
  readonly ratedAt: number | null;
  readonly ratedMatches: number;
}

export const UNRATED: PlayerState = { rating: INITIAL_RATING, rd: INITIAL_RD, ratedAt: null, ratedMatches: 0 };
const MILLISECONDS = /^(0|[1-9]\d{0,15})$/;

/** A row's stored state; a malformed row throws. */
export function storedState(identityId: string, fields: Fields | null): PlayerState {
  if (!fields) return UNRATED;
  const ratedMatches = Number(fields.ratedMatches);
  if (!Number.isSafeInteger(ratedMatches) || ratedMatches < 1) throw new Error(`invalid rated-match count for ${identityId}`);
  const rd = fields.rd ? decodeRating(fields.rd) : NaN;
  if (!(rd > 0)) throw new Error(`invalid stored rd for ${identityId}`);
  if (fields.ratedAt && !MILLISECONDS.test(fields.ratedAt)) throw new Error(`invalid stored ratedAt for ${identityId}`);
  return { rating: decodeRating(fields.rating ?? ""), rd, ratedAt: fields.ratedAt ? Number(fields.ratedAt) : null, ratedMatches };
}

function storedRating(identityId: string, fields: Fields | null): Rating {
  const { rating, rd, ratedMatches } = storedState(identityId, fields);
  return { rating, rd, ratedMatches };
}

/** The rd and ratedAt fields a result writes. */
export function glickoFields(state: PlayerState): Fields {
  return { rd: encodeRating(state.rd), ...(state.ratedAt === null ? {} : { ratedAt: String(state.ratedAt) }) };
}

/**
 * One rated result's changes and every player's next state, in team order (team a's
 * members, then team b's), by Glicko-1.
 */
export function rateMatch(
  teams: readonly [readonly string[], readonly string[]], winner: Winner, at: number | null,
  current: (identityId: string) => PlayerState,
): { readonly changes: readonly RatingChange[]; readonly next: ReadonlyMap<string, PlayerState> } {
  const scoreA = winner === "a" ? 1 : winner === "b" ? 0 : 0.5;
  const changes: RatingChange[] = [];
  const next = new Map<string, PlayerState>();
  const entering = teams.map((team) => team.map((id) => {
    const state = current(id);
    const rd = inflatedRd(state.rd, at !== null && state.ratedAt !== null ? at - state.ratedAt : null);
    return { id, state, rating: state.rating, rd };
  }));
  teams.forEach((_, side) => {
    const opponent = teamAsOpponent(entering[1 - side]!);
    const score = side === 0 ? scoreA : 1 - scoreA;
    for (const player of entering[side]!) {
      const after = glickoUpdate(player, [{ ...opponent, score }]);
      changes.push({ identityId: player.id, before: player.state.rating, after: after.rating, rdBefore: player.state.rd, rdAfter: after.rd });
      next.set(player.id, { rating: after.rating, rd: after.rd, ratedAt: at ?? player.state.ratedAt, ratedMatches: player.state.ratedMatches + 1 });
    }
  });
  return { changes, next };
}

const COUNT = /^(0|[1-9]\d{0,15})$/;
const FORM_ITEM = /^([WLD]):(.+)$/;

/** A row's record, or null for a row rated before records existed (no wins field). A malformed record throws. */
export function storedRecord(identityId: string, fields: Fields | null): RatingRecord | null {
  if (!fields || fields.wins === undefined) return null;
  const counts = [fields.wins, fields.losses, fields.draws].map((value) => COUNT.test(value ?? "") ? Number(value) : NaN);
  if (!counts.every(Number.isSafeInteger) || counts[0]! + counts[1]! + counts[2]! !== Number(fields.ratedMatches)) {
    throw new Error(`invalid stored record for ${identityId}`);
  }
  const form = (fields.form ?? "").split(" ").filter(Boolean).map((item) => {
    const match = FORM_ITEM.exec(item);
    if (!match || !isValidId(match[2])) throw new Error(`invalid stored form for ${identityId}`);
    return { result: match[1] as MatchResultLetter, matchId: match[2] };
  });
  if (form.length === 0 || form.length > FORM_LENGTH) throw new Error(`invalid stored form for ${identityId}`);
  return { wins: counts[0]!, losses: counts[1]!, draws: counts[2]!, form };
}

/** The record with one more result, newest first. */
export function withResult(record: RatingRecord, result: MatchResultLetter, matchId: string): RatingRecord {
  return {
    wins: record.wins + (result === "W" ? 1 : 0), losses: record.losses + (result === "L" ? 1 : 0), draws: record.draws + (result === "D" ? 1 : 0),
    form: [{ result, matchId }, ...record.form].slice(0, FORM_LENGTH),
  };
}

export const recordFields = (record: RatingRecord): Fields => ({
  wins: String(record.wins), losses: String(record.losses), draws: String(record.draws),
  form: record.form.map(({ result, matchId }) => `${result}:${matchId}`).join(" "),
});

export const EMPTY_RECORD: RatingRecord = { wins: 0, losses: 0, draws: 0, form: [] };

/** The letter a result gives team side 0 (colony 0, "a") or side 1. */
export const letterFor = (winner: Winner, side: number): MatchResultLetter => winner === "draw" ? "D" : (winner === "a") === (side === 0) ? "W" : "L";

function validateResult({ matchId, teams, winner, mode = "1v1" }: MatchResult): void {
  if (!isValidId(matchId)) throw new Error("invalid match id");
  if (!isRankedMode(mode)) throw new Error("invalid ranked mode");
  if (winner !== "a" && winner !== "b" && winner !== "draw") throw new Error("invalid winner");
  if (!Array.isArray(teams) || teams.length !== 2) throw new Error("a result needs exactly two teams");
  const seen = new Set<string>();
  for (const team of teams) {
    if (!Array.isArray(team) || team.length === 0) throw new Error("every team needs at least one identity");
    for (const id of team) {
      if (!isValidId(id)) throw new Error("invalid identity id");
      if (seen.has(id)) throw new Error(`identity ${id} appears more than once in the match`);
      seen.add(id);
    }
  }
}

interface Cursor {
  readonly readTime: string;
  readonly ratingKey: string;
  readonly identityId: string;
  readonly mode: RankedMode;
  readonly scope: LeaderboardScope;
}

const isScope = (scope: unknown): scope is LeaderboardScope => (LEADERBOARD_SCOPES as readonly unknown[]).includes(scope);

/**
 * Cursor: base64url JSON [readTime, ordered key, identity id] of the last entry
 * served, then [mode, scope] unless they are 1v1 and everyone, whose cursors keep
 * the form they had before modes existed.
 */
function encodeCursor({ readTime, ratingKey, identityId, mode, scope }: Cursor): string {
  const fields = mode === "1v1" && scope === "everyone" ? [readTime, ratingKey, identityId] : [readTime, ratingKey, identityId, mode, scope];
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 3 && parsed.length !== 5)) return undefined;
  const [readTime, ratingKey, identityId, mode = "1v1", scope = "everyone"] = parsed as unknown[];
  if (typeof readTime !== "string" || !READ_TIME.test(readTime)) return undefined;
  if (typeof ratingKey !== "string" || !RATING_KEY.test(ratingKey)) return undefined;
  if (!isValidId(identityId) || !isRankedMode(mode) || !isScope(scope)) return undefined;
  return { readTime, ratingKey, identityId, mode, scope };
}

/**
 * One rated result's reads and writes inside the caller's transaction, so a lobby
 * release can record its outcome and rate it atomically. applyResult is
 * this in a transaction of its own; already_applied writes nothing.
 */
export async function ratingWrites(read: TransactionRead, result: MatchResult): Promise<TransactionStep<ApplyOutcome>> {
  validateResult(result);
  const { matchId, teams, winner } = result;
  const collection = ratingCollection(result.mode ?? "1v1");
  const marker = `ratedMatches/${matchId}`;
  const members = [...teams[0], ...teams[1]];
  const docs = await read([marker, ...members.flatMap((id) => [`${collection}/${id}`, `identities/${id}`])]);
  if (docs.get(marker)) return { result: { status: "already_applied" }, writes: [] };
  const house = await houseOwnedAmong(read, members);
  const current = new Map<string, PlayerState>();
  const records = new Map<string, RatingRecord | null>();
  for (const id of members) {
    if (!docs.get(`identities/${id}`)) throw new Error(`unknown identity ${id}`);
    const row = docs.get(`${collection}/${id}`) ?? null;
    current.set(id, storedState(id, row));
    // A first result starts the record; a row rated before records existed keeps none until fillRatingRecords reconciles it.
    records.set(id, row ? storedRecord(id, row) : EMPTY_RECORD);
  }
  const { changes, next } = rateMatch(teams, winner, result.at ?? null, (id) => current.get(id)!);
  const writes: Write[] = [];
  teams.forEach((team, side) => {
    for (const id of team) {
      const { ratedMatches } = current.get(id)!;
      const after = next.get(id)!;
      const rating = encodeRating(after.rating);
      const record = records.get(id)!;
      // The store accepts strings only. An empty string clears a previously recorded level, tier or model label.
      const fields = { rating, ratedMatches: String(ratedMatches + 1), ...glickoFields(after),
        thinkingLevel: result.thinkingLevels?.[id] ?? "",
        serviceTier: result.serviceTiers?.[id] ?? "",
        modelLabel: result.modelLabels?.[id] ?? "",
        ...(record ? recordFields(withResult(record, letterFor(winner, side), matchId)) : {}),
        ...(house.has(id) ? { [HOUSE_RATING]: rating } : {}) };
      writes.push(ratedMatches === 0
        ? { op: "create", path: `${collection}/${id}`, fields: { ...fields, displayName: docs.get(`identities/${id}`)!.displayName! } }
        : { op: "update", path: `${collection}/${id}`, fields });
    }
  });
  writes.push({ op: "create", path: marker, fields: { changes: JSON.stringify(changes) } });
  return { result: { status: "applied", changes }, writes };
}

/**
 * Marks the house-owned 1v1 rows that lack a current house marker: rows rated before
 * the marker existed, or last written by a server that predates it. Idempotent: a
 * row whose houseRating equals its rating is never written. It reads every 1v1 row
 * as of its first page; a row a current server writes later is marked by
 * ratingWrites itself. Returns the number of rows marked.
 */
export async function markHouseRatings(store: Store): Promise<number> {
  if (!(await store.get(`usernames/${HOUSE_USERNAME}`))) return 0;
  const collection = ratingCollection("1v1");
  let marked = 0;
  let readTime: string | undefined;
  let startAfter: { value: string; path: string } | undefined;
  for (;;) {
    const page = await store.query(collection, { orderBy: "rating", direction: "DESCENDING", limit: MAX_PAGE_SIZE, startAfter, readTime });
    readTime ??= page.readTime;
    const unmarked = page.rows.filter(({ fields }) => fields[HOUSE_RATING] !== fields.rating).map(({ path }) => path.slice(collection.length + 1));
    if (unmarked.length > 0) {
      marked += await store.transaction(async (read): Promise<TransactionStep<number>> => {
        const house = [...await houseOwnedAmong(read, unmarked)];
        if (house.length === 0) return { result: 0, writes: [] };
        const rows = await read(house.map((id) => `${collection}/${id}`));
        const writes: Write[] = [];
        for (const id of house) {
          const fields = rows.get(`${collection}/${id}`);
          if (fields?.rating && fields[HOUSE_RATING] !== fields.rating) {
            writes.push({ op: "update", path: `${collection}/${id}`, fields: { [HOUSE_RATING]: fields.rating } });
          }
        }
        return { result: writes.length, writes };
      });
    }
    const last = page.rows.at(-1);
    if (page.rows.length < MAX_PAGE_SIZE || !last) return marked;
    startAfter = { value: last.fields.rating!, path: last.path };
  }
}

export const NATURAL_OUTCOMES: Readonly<Record<string, Winner>> = { colony_0_won: "a", colony_1_won: "b", draw: "draw" };

/** A lobby's match time in milliseconds: its startsAt, else createdAt; null when neither reads as a finite number. */
export function matchTime(fields: Fields): number | null {
  const at = Number(fields.startsAt || fields.createdAt);
  return fields.startsAt || fields.createdAt ? (Number.isFinite(at) ? at : null) : null;
}
export const RECORD_FILL_ATTEMPTS = 3;

/** Rows in every ranked mode that have no record yet, as mode and identity id. */
async function unrecordedRows(store: Store): Promise<{ readonly mode: RankedMode; readonly identityId: string }[]> {
  const rows: { mode: RankedMode; identityId: string }[] = [];
  for (const mode of RANKED_MODES) {
    const collection = ratingCollection(mode);
    let readTime: string | undefined;
    let startAfter: { value: string; path: string } | undefined;
    for (;;) {
      const page = await store.query(collection, { orderBy: "rating", direction: "DESCENDING", limit: MAX_PAGE_SIZE, startAfter, readTime });
      readTime ??= page.readTime;
      for (const { path, fields } of page.rows) if (fields.wins === undefined) rows.push({ mode, identityId: path.slice(collection.length + 1) });
      const last = page.rows.at(-1);
      if (page.rows.length < MAX_PAGE_SIZE || !last) break;
      startAfter = { value: last.fields.rating!, path: last.path };
    }
  }
  return rows;
}

export type LobbySeat = { readonly id: string; readonly colony: 0 | 1 };

/** A lobby's stored seats, or null when they do not parse as [{id, colony: 0 | 1}] with valid ids. */
export function lobbySeats(stored: string | undefined): readonly LobbySeat[] | null {
  let seats: unknown;
  try { seats = JSON.parse(stored ?? ""); } catch { return null; }
  const isSeat = (seat: unknown): seat is LobbySeat => typeof seat === "object" && seat !== null
    && isValidId((seat as { id?: unknown }).id) && ((seat as { colony?: unknown }).colony === 0 || (seat as { colony?: unknown }).colony === 1);
  return Array.isArray(seats) && seats.every(isSeat) ? seats : null;
}

/**
 * Every rated result recorded on an ended lobby, aggregated per mode and identity:
 * a lobby counts when rated "true" with a natural outcome, exactly the lobbies
 * whose release rated them (lobbies.ts). Form is newest first by match time (the
 * lobby's startsAt, else createdAt), never scan order. A rated lobby whose id, seats
 * or match time cannot be read is left out and its id returned in skipped,
 * so one unreadable lobby never stops the others from counting.
 */
async function ratedLobbyRecords(store: Store): Promise<{ readonly records: Map<string, RatingRecord>; readonly skipped: readonly string[] }> {
  const results = new Map<string, { at: number; matchId: string; result: MatchResultLetter }[]>();
  const skipped: string[] = [];
  let readTime: string | undefined;
  let startAfter: { value: string; path: string } | undefined;
  for (;;) {
    const page = await store.query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: MAX_PAGE_SIZE, startAfter, readTime });
    readTime ??= page.readTime;
    for (const { path, fields } of page.rows) {
      const winner = NATURAL_OUTCOMES[fields.outcome ?? ""];
      const mode = fields.mode || "1v1";
      if (fields.state !== "ended" || fields.rated !== "true" || winner === undefined || !isRankedMode(mode)) continue;
      const matchId = path.slice("lobbies/".length);
      const at = matchTime(fields);
      const seats = lobbySeats(fields.seats);
      if (!isValidId(matchId) || at === null || seats === null) {
        skipped.push(matchId);
        continue;
      }
      [0, 1].forEach((side) => {
        for (const id of new Set(seats.filter((seat) => seat.colony === side).map((seat) => seat.id))) {
          const key = `${mode}/${id}`;
          if (!results.has(key)) results.set(key, []);
          results.get(key)!.push({ at, matchId, result: letterFor(winner, side) });
        }
      });
    }
    const last = page.rows.at(-1);
    if (page.rows.length < MAX_PAGE_SIZE || !last) break;
    startAfter = { value: last.fields.createdAt!, path: last.path };
  }
  const records = new Map<string, RatingRecord>();
  for (const [key, list] of results) {
    list.sort((x, y) => y.at - x.at || (x.matchId < y.matchId ? 1 : x.matchId > y.matchId ? -1 : 0));
    records.set(key, list.reduceRight((record, { result, matchId }) => withResult(record, result, matchId), EMPTY_RECORD));
  }
  return { records, skipped };
}

export interface RecordFill {
  readonly filled: number;
  /** Rows whose rated-match count the ended rated lobbies do not account for; they keep no record and are logged. */
  readonly unreconciled: readonly { readonly mode: RankedMode; readonly identityId: string; readonly ratedMatches: number; readonly found: number }[];
  /** Ids of rated lobbies left out because their stored data could not be read; each is logged. */
  readonly skipped: readonly string[];
}

/**
 * Gives every row rated before records existed its record from the ended rated
 * lobbies. Each row is written in a transaction that re-reads it and
 * writes only while it still has no record and its ratedMatches still equals the
 * lobbies' total, so a result rated meanwhile is never lost or counted twice; such
 * a row is retried with a fresh scan, up to RECORD_FILL_ATTEMPTS scans. Idempotent:
 * a row with a record is never written, and with none left nothing is scanned. A
 * rated lobby whose stored data cannot be read is skipped, never fatal.
 */
export async function fillRatingRecords(store: Store): Promise<RecordFill> {
  let filled = 0;
  let unreconciled: RecordFill["unreconciled"] = [];
  const skipped = new Set<string>();
  for (let attempt = 0; attempt < RECORD_FILL_ATTEMPTS; attempt++) {
    const pending = await unrecordedRows(store);
    if (pending.length === 0) return { filled, unreconciled: [], skipped: [...skipped] };
    const scan = await ratedLobbyRecords(store);
    for (const id of scan.skipped) skipped.add(id);
    const records = scan.records;
    const missed: { mode: RankedMode; identityId: string; ratedMatches: number; found: number }[] = [];
    for (const { mode, identityId } of pending) {
      const record = records.get(`${mode}/${identityId}`) ?? EMPTY_RECORD;
      const found = record.wins + record.losses + record.draws;
      const path = `${ratingCollection(mode)}/${identityId}`;
      // The step may run more than once (an aborted transaction reruns it), so it only returns what it saw.
      const outcome = await store.transaction(async (read): Promise<TransactionStep<"filled" | "skipped" | number>> => {
        const row = (await read([path])).get(path);
        if (!row || row.wins !== undefined) return { result: "skipped", writes: [] };
        const ratedMatches = Number(row.ratedMatches);
        if (found === 0 || ratedMatches !== found) return { result: ratedMatches, writes: [] };
        return { result: "filled", writes: [{ op: "update", path, fields: recordFields(record) }] };
      });
      if (outcome === "filled") filled++;
      else if (outcome !== "skipped") missed.push({ mode, identityId, ratedMatches: outcome, found });
    }
    unreconciled = missed;
    if (missed.length === 0) break;
  }
  return { filled, unreconciled, skipped: [...skipped] };
}

/** Written once a fill-in run completes; while present, a server start scans nothing. */
export const RECORD_FILL_MARKER = "migrations/ratingRecordFill";

/**
 * fillRatingRecords as the server runs it at start, once: with RECORD_FILL_MARKER
 * present it reads nothing else. Otherwise it fills, logs the outcome (each skipped
 * lobby and each unreconciled row by id), then writes the marker, so a later start
 * never rescans. A row it cannot reconcile keeps no record (an empty record and
 * Last 5, never a partial one) and is not retried. A run that fails is logged, never
 * thrown, and writes no marker, so the next start tries again.
 */
export async function startRecordFill(store: Store): Promise<void> {
  try {
    if (await store.get(RECORD_FILL_MARKER) !== null) return;
    const { filled, unreconciled, skipped } = await fillRatingRecords(store);
    if (filled > 0) console.info("antwar rating records filled", { filled });
    for (const lobbyId of skipped) console.warn("antwar rating record fill skipped unreadable lobby", { lobbyId });
    for (const row of unreconciled) console.warn("antwar rating record not reconciled", row);
    const fields: Fields = {
      completedAt: new Date().toISOString(), filled: String(filled), unreconciled: String(unreconciled.length), skipped: String(skipped.length),
    };
    await store.transaction(async (read): Promise<TransactionStep<void>> => {
      const done = (await read([RECORD_FILL_MARKER])).get(RECORD_FILL_MARKER);
      return { result: undefined, writes: done ? [] : [{ op: "create", path: RECORD_FILL_MARKER, fields }] };
    });
  } catch (error) {
    console.warn("antwar rating record backfill failed", error);
  }
}

/**
 * The server's ratings store. Creating it starts markHouseRatings, and the house
 * rankings are served only once that has succeeded: a house read waits for a
 * backfill in progress, and after a failed one answers house_unavailable and starts
 * the backfill again in the background. houseBackfill settles when the current
 * attempt has finished or failed; a failure is logged, never thrown.
 */
export function createRatings(
  store: Store, identities: Pick<Identities, "findById"> = createIdentities(store),
): Ratings & { readonly houseBackfill: Promise<void> } {
  const backfill = (): Promise<boolean> => markHouseRatings(store).then(
    (marked) => { if (marked > 0) console.info("antwar house ratings marked", { marked }); return true; },
    (error: unknown) => { console.warn("antwar house rating backfill failed", error); return false; },
  );
  let houseMarked = backfill();
  /** The replay id stored for each match (watchMatches), read in one batch; a match without one is absent. */
  async function storedReplayIds(matchIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(matchIds)];
    if (unique.length === 0) return new Map();
    // A transaction with no writes is rolled back: this is one batched read.
    const docs = await store.transaction(async (read) => ({ result: await read(unique.map((id) => `watchMatches/${id}`)), writes: [] }));
    const replayIds = new Map<string, string>();
    for (const id of unique) {
      const replayId = docs.get(`watchMatches/${id}`)?.replayId;
      if (replayId !== undefined && isReplayId(replayId)) replayIds.set(id, replayId);
    }
    return replayIds;
  }
  return {
    get houseBackfill() { return houseMarked.then(() => undefined); },
    async readRating(identityId, mode = "1v1") {
      if (!isValidId(identityId)) throw new Error("invalid identity id");
      return storedRating(identityId, await store.get(`${ratingCollection(mode)}/${identityId}`));
    },

    async readMatchChanges(matchId) {
      if (!isValidId(matchId)) throw new Error("invalid match id");
      const fields = await store.get(`ratedMatches/${matchId}`);
      if (!fields?.changes) return null; // Historical empty markers cannot prove their original deltas.
      const value: unknown = JSON.parse(fields.changes);
      if (!Array.isArray(value)) throw new Error("invalid stored rating changes");
      const seen = new Set<string>();
      return value.map((change: unknown) => {
        if (typeof change !== "object" || change === null) throw new Error("invalid stored rating changes");
        const row = change as Record<string, unknown>;
        if (!isValidId(row.identityId) || seen.has(row.identityId) || typeof row.before !== "number" || !Number.isFinite(row.before) ||
          typeof row.after !== "number" || !Number.isFinite(row.after)) throw new Error("invalid stored rating changes");
        const rds = row.rdBefore === undefined && row.rdAfter === undefined ? null : [row.rdBefore, row.rdAfter];
        if (rds !== null && !rds.every((rd) => typeof rd === "number" && Number.isFinite(rd) && rd > 0)) throw new Error("invalid stored rating changes");
        seen.add(row.identityId);
        return { identityId: row.identityId, before: row.before, after: row.after,
          ...(rds === null ? {} : { rdBefore: rds[0] as number, rdAfter: rds[1] as number }) };
      });
    },

    async applyResult(result) {
      validateResult(result);
      return store.transaction<ApplyOutcome>((read) => ratingWrites(read, result));
    },

    async leaderboard(options = {}) {
      const { mode = "1v1", scope = "everyone" } = options;
      if (!isRankedMode(mode)) throw new RangeError(`unknown ranked mode: ${String(mode)}`);
      if (!isScope(scope)) throw new RangeError(`unknown leaderboard scope: ${String(scope)}`);
      const limit = options.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new RangeError(`limit must be 1-${MAX_PAGE_SIZE}`);
      const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
      if (options.cursor !== undefined && (!cursor || cursor.mode !== mode || cursor.scope !== scope)) return { ok: false, reason: "invalid_cursor" };
      if (scope === "house") {
        const attempt = houseMarked;
        if (!(await attempt)) {
          if (houseMarked === attempt) houseMarked = backfill();
          return { ok: false, reason: "house_unavailable" };
        }
      }
      const collection = ratingCollection(mode);
      const idOf = (path: string) => path.slice(collection.length + 1);
      // The house rankings order by the house marker, so they never read another identity's row.
      const orderBy = scope === "house" ? HOUSE_RATING : "rating";
      let page: QueryResult;
      try {
        page = await store.query(collection, {
          orderBy,
          direction: "DESCENDING",
          limit: limit + 1,
          startAfter: cursor && { value: cursor.ratingKey, path: `${collection}/${cursor.identityId}` },
          readTime: cursor?.readTime,
        });
      } catch (error) {
        // A later page reads at its first page's time or not at all: never at the current time.
        if (cursor && error instanceof FirestoreError && (error.status === "INVALID_ARGUMENT" || error.status === "FAILED_PRECONDITION")) {
          return { ok: false, reason: "cursor_expired", cause: error };
        }
        throw error;
      }
      const rows = page.rows.slice(0, limit);
      // Rating ordering/counts stay pinned to the cursor's readTime. Names are
      // deliberately current: an old cursor must not attribute a former owner's
      // history to whoever has since claimed that name.
      const records = new Map(rows.map(({ path, fields }) => [path, storedRecord(idOf(path), fields)]));
      const replayIds = await storedReplayIds([...records.values()].flatMap((record) => record?.form.map(({ matchId }) => matchId) ?? []));
      const entries = await Promise.all(rows.map(async ({ path, fields }): Promise<LeaderboardEntry> => {
        const identityId = idOf(path);
        const identity = await identities.findById(identityId);
        const record = records.get(path) ?? null;
        const displayName = identity?.displayName ?? placeholder(identityId);
        const benchmark = fields[HOUSE_RATING] !== undefined;
        // A Benchmark row's level and tier belong to its handle; the seat-reported values stored on the row are not shown.
        const label = benchmark ? houseLabel(displayName) : { thinkingLevel: fields.thinkingLevel || null, serviceTier: fields.serviceTier || null };
        return { identityId, displayName, ...storedRating(identityId, fields), ...label, benchmark,
          wins: record?.wins ?? null, losses: record?.losses ?? null, draws: record?.draws ?? null,
          form: record?.form.map(({ result, matchId }) => ({ result, replayId: replayIds.get(matchId) ?? null })) ?? [] };
      }));
      // A Benchmark row whose handle HOUSE_LABELS does not list shows "Unlisted model"; the server logs it.
      logUnlistedHouse("leaderboard", entries.filter(entry => entry.benchmark).map(entry => entry.displayName));
      const last = rows.at(-1);
      const next = page.rows.length > limit && last
        ? encodeCursor({ readTime: cursor?.readTime ?? page.readTime, ratingKey: last.fields[orderBy]!, identityId: idOf(last.path), mode, scope })
        : undefined;
      return { ok: true, value: next === undefined ? { entries } : { entries, next } };
    },
  };
}
