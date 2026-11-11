/// <reference types="node" />
import { createHash } from "node:crypto";
import { FirestoreError, type Fields, type Store, type Write } from "../store/firestore.js";
import type { RecordingObjects } from "../replays/abandonRecording.js";
import type { MountHandler } from "../server.js";
import { identityDisplay, nameState } from "../identity/retention.js";
import { publicWaitingName } from "../live/queue-catalog.js";
import { createWatchRegistry } from "../live/watch-registry.js";
import { CORRECTION_KIND, firestoreWrites, verify, type Verification } from "./unrateNeverJoined.js";
import {
  EMPTY_RECORD, encodeRating, glickoFields, letterFor, lobbySeats, matchTime, MAX_PAGE_SIZE, NATURAL_OUTCOMES, rateMatch, ratingCollection,
  recordFields, storedRecord, storedState, withResult, type PlayerState, type RatingChange, type RatingRecord, type Winner,
} from "./ratings.js";

/**
 * One-off rating corrections. planCorrections works out, reading only, every write that two owed corrections need.
 * The never-joined correction ships first, on its own: at start the entry-point server plans only it (planNeverJoined),
 * logs each write's operation and path and a SHA-256 digest of those writes alone, and serves the plan's public facts at PLAN_PATH.
 * That correction was applied by an earlier release and reads applied from what it wrote (neverJoinedApplied); its apply
 * is removed, so the server writes nothing for either correction. Once it reads applied, the Sol move is planned at
 * start read-only and served at SOL_PLAN_PATH; nothing applies it.
 *
 * 1. Ranked lobby NEVER_JOINED, which one seat never joined, becomes abandoned and unrated with its rating effect
 *    removed: unrateNeverJoined.ts's verify and Firestore writes, without its recording rewrite.
 * 2. Two 2026-11-01 house-1v1 matches move from the standard Sol handles to the -fast handles that played them
 *    (SOL_MOVES), and house-1v1 ratings are recomputed with rateMatch, in the order they were applied, from each
 *    player's state before the first moved match. Ratings are applied when a match ends, so that order is the
 *    createTime of each match's stored change record. The pass refuses unless the same replay without the move
 *    reproduces every stored change and row.
 *
 * Names are published as the public Waiting view shows them (live/queue-catalog.ts): a released owner's placeholder,
 * which embeds its owner id, becomes a fixed name, so the plan holds no identity id.
 *
 * Any failed check refuses the whole plan: PLAN_PATH says "refused" with only a fixed code naming the check
 * (RefusalCode), never an id, a name or a stored figure, and the log says only that it refused, with that code (a
 * stored value can be malformed, so no error text is logged).
 * CORRECTION_MARKER is to be created by a later Sol apply in the same transaction as its writes: { planDigest, appliedAt }.
 * Nothing writes it today. While it exists nothing is planned.
 */
export const NEVER_JOINED = { lobbyId: "f14ece51-223b-4c40-9817-b365d9f7415d", replayId: "2026-11-09T13-26-59-840Z-160375822867893" };
export const SOL_MOVES: readonly { readonly replayId: string; readonly lobbyId?: string; readonly from: string; readonly to: string }[] = [
  { replayId: "2026-11-01T21-29-08-783Z-4247401107838", from: "antwars/gpt-6-1-sol-high", to: "antwars/gpt-6-1-sol-high-fast" },
  { replayId: "2026-11-01T21-35-14-507Z-201306744279384", lobbyId: "f551a02d-0985-4739-afff-b20b596b292f",
    from: "antwars/gpt-6-1-sol-xhigh", to: "antwars/gpt-6-1-sol-xhigh-fast" },
];
export const CORRECTION_MARKER = "migrations/ratingCorrection";
export const PLAN_PATH = "/rating-correction";
const MODE = "house-1v1";
const ROWS = ratingCollection(MODE);
const SAME = 1e-9;
/** Re-reads allowed when a house-1v1 match ends while the history is being read. */
const HISTORY_ATTEMPTS = 5;

interface Standing { readonly rating: number; readonly rd: number; readonly record: string }
interface MatchState {
  readonly status: "rated" | "abandoned, unrated";
  readonly seats: readonly string[];
  readonly ratingChanges: readonly { readonly handle: string; readonly before: number; readonly after: number }[];
  /** Each seat's self-reported model label, where the plan changes them. */
  readonly labels?: Readonly<Record<string, string>>;
}
/** Every planned change in public terms: one entry per changed match (by recording id, else public lobby id), one per changed rating row. */
export interface PublicPlan {
  readonly digest: string;
  readonly matches: readonly { readonly match: string; readonly startedAt: string; readonly before: MatchState; readonly after: MatchState }[];
  readonly ratings: readonly { readonly handle: string; readonly mode: string; readonly before: Standing | null; readonly after: Standing | null }[];
}
export interface Plan { readonly writes: readonly Write[]; readonly summary: PublicPlan }
/** Every check that can refuse, as PLAN_PATH serves it; store-error and error are a failed read and any other throw. */
export const REFUSAL_CODES = [
  "never-joined-lobby", "never-joined-correction-marker", "never-joined-change-record", "never-joined-only-rated-match",
  "never-joined-watch-entry", "never-joined-match-record", "never-joined-never-joined", "never-joined-recording-rewrite", "never-joined-stage",
  "never-joined-rating-change",
  "unknown-identity", "sol-lobby", "sol-handle", "no-commit-times", "unreadable-lobby", "history-unstable", "no-change-record",
  "no-change-record-time", "moved-seats", "moved-not-rated", "shared-commit-time", "no-glicko-change", "not-reproduced-players",
  "not-reproduced-change", "not-reproduced-rating", "not-reproduced-rd", "not-reproduced-rated-at", "not-reproduced-rated-matches",
  "not-reproduced-record", "no-public-match-id", "no-row", "never-joined-not-applied", "store-error", "error",
] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];
export type PlanState = { readonly state: "computing" | "applied" } | { readonly state: "refused"; readonly reason: RefusalCode }
  | ({ readonly state: "refused"; readonly reason: RefusalCode } & RefusalFigures) | ({ readonly state: "planned" } & PublicPlan);

/**
 * Where a not-reproduced history deviates most, for the server log only: the largest finite difference between a replayed
 * and a stored rating or RD, each value compared on its own (null when no differing value has one: a missing value, a
 * count, a time or a record), the handle it is on and the change record or rating row it came from, and how many values,
 * not entries, were not reproduced. A missing value counts as one and never hides another value's deviation.
 */
export interface Deviation { readonly deviation: number | null; readonly handle: string; readonly source: string; readonly count: number }

/** The kind of a compared value: a change record's before, after, rdBefore or rdAfter, or a rating row's rating or rd. */
export type ValueKind = "before" | "after" | "rdBefore" | "rdAfter" | "rating" | "rd";

/**
 * A not-reproduced refusal's public figures, numbers and kinds only: the largest deviation and how many values fail (as
 * in Deviation), the kind of the value the largest deviation is in (null whenever that deviation is null: a missing value,
 * the players, a count, a time or a record), and the UTC day (YYYY-MM-DD) of the earliest commit among the failing change records, null
 * when only rating rows fail. Never a handle, identity, row, lobby, match or record name.
 */
export interface RefusalFigures {
  readonly deviation: number | null; readonly count: number; readonly kind: ValueKind | null; readonly earliestChangeDay: string | null;
}

class PlanRefused extends Error {
  // Explicit fields, not parameter properties, which Node's type stripping refuses (store/firestore.ts).
  readonly code: RefusalCode;
  readonly deviation?: Deviation;
  readonly figures?: RefusalFigures;
  constructor(code: RefusalCode, reason: string, deviation?: Deviation, figures?: RefusalFigures) {
    super(reason); this.code = code; if (deviation) this.deviation = deviation; if (figures) this.figures = figures;
  }
}
const refuse = (code: RefusalCode, reason: string): never => { throw new PlanRefused(code, reason); };
/** A not-reproduced refusal's largest deviation; undefined for any other refusal. */
export const refusalDeviation = (error: unknown): Deviation | undefined => error instanceof PlanRefused ? error.deviation : undefined;
/**
 * The UTC day (YYYY-MM-DD) of a strict RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SS, optional fractional seconds, then
 * Z) that is a real instant, taken from the parsed instant; null for anything else, so no other text can be served.
 */
const utcDay = (time: string): string | null => {
  const at = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(time);
  if (!at) return null;
  const [y, mo, d, h, mi, s] = at.slice(1).map(Number) as [number, number, number, number, number, number];
  const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (instant.getUTCFullYear() !== y || instant.getUTCMonth() !== mo - 1 || instant.getUTCDate() !== d || instant.getUTCHours() !== h
    || instant.getUTCMinutes() !== mi || instant.getUTCSeconds() !== s) return null;
  return instant.toISOString().slice(0, 10);
};
/** A not-reproduced refusal's public figures; undefined for any other refusal. */
export const refusalFigures = (error: unknown): RefusalFigures | undefined => error instanceof PlanRefused ? error.figures : undefined;
/** The served code of a refusal: its check's code, store-error for a failed store read, error for anything else. */
export const refusalCode = (error: unknown): RefusalCode =>
  error instanceof PlanRefused ? error.code : error instanceof FirestoreError ? "store-error" : "error";
/** The served code of a verify check, by its name before any ":" (an "only rated match" check names its identity after it). */
const NEVER_JOINED_CHECKS: Readonly<Record<string, RefusalCode>> = {
  "lobby": "never-joined-lobby", "correction marker": "never-joined-correction-marker", "rating change record": "never-joined-change-record",
  "only rated match": "never-joined-only-rated-match", "watch entry": "never-joined-watch-entry", "match record": "never-joined-match-record",
  "never joined": "never-joined-never-joined", "recording rewrite": "never-joined-recording-rewrite",
};
/** A name as the plan publishes it: a released owner's placeholder, which embeds its owner id, becomes a fixed name. */
const shown = publicWaitingName;
const shownKeys = (labels: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(labels).map(([name, label]) => [shown(name), label]));

/**
 * An identity's current display name, as findById projects it, from reads alone: findById would also record an expired
 * name's new state and drop its username index, a write. Undefined for a missing or purged identity.
 */
async function currentName(store: Store, id: string, at: number): Promise<string | undefined> {
  return store.transaction(async read => {
    const fields = (await read([`identities/${id}`])).get(`identities/${id}`);
    const ownerId = fields?.ownerId ?? id;
    const owner = !fields ? null : ownerId === id ? fields : (await read([`identities/${ownerId}`])).get(`identities/${ownerId}`);
    const state = owner ? nameState(owner, at) : "purged";
    return { result: fields && owner && state !== "purged" ? identityDisplay(id, fields, ownerId, { ...owner, nameState: state }) : undefined, writes: [] };
  });
}

/**
 * A house handle's identity id ("antwars/<handle>"), by the indexes findByDisplayName reads (identities.ts), from reads
 * alone. The house account's name never expires (retention.ts), so there is no expiry to account for.
 */
async function houseHandleId(store: Store, displayName: string): Promise<string | undefined> {
  const [owner, handle] = displayName.toLowerCase().split("/");
  return store.transaction(async read => {
    const ownerId = (await read([`usernames/${owner}`])).get(`usernames/${owner}`)?.identityId;
    const index = `identityHandles/${ownerId}-${handle}`;
    const id = ownerId ? (await read([index])).get(index)?.identityId : undefined;
    const fields = id ? (await read([`identities/${id}`])).get(`identities/${id}`) : null;
    return { result: id && fields?.ownerId === ownerId ? id : undefined, writes: [] };
  });
}
const standing = (id: string, fields: Fields | null | undefined): Standing | null => {
  if (!fields) return null;
  const { rating, rd } = storedState(id, fields);
  const r = storedRecord(id, fields);
  return { rating, rd, record: r ? `${r.wins}-${r.losses}-${r.draws}` : "" };
};

/** SHA-256 of the writes by path, each with sorted fields; the apply-time `at` of the never-joined marker is left out. */
export function planDigest(writes: readonly Write[]): string {
  const canonical = [...writes].sort((a, b) => a.path < b.path ? -1 : 1).map(write => {
    if (write.op === "delete") return [write.op, write.path];
    const fields = Object.entries(write.fields).filter(([key]) => !(key === "at" && write.path.startsWith("ratingCorrections/")));
    return [write.op, write.path, fields.sort(([a], [b]) => a < b ? -1 : 1)];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

interface Lobby {
  readonly id: string; readonly at: number; readonly winner: Winner; readonly seats: readonly { id: string; displayName: string; colony: 0 | 1 }[];
  /** A public lobby, whose id the watch listing already publishes. */
  readonly listed: boolean;
}
const teamsOf = (lobby: Lobby): [string[], string[]] =>
  [0, 1].map(colony => [...new Set(lobby.seats.filter(seat => seat.colony === colony).map(seat => seat.id))]) as [string[], string[]];
const plays = (lobby: Lobby, id: string) => lobby.seats.some(seat => seat.id === id);

/** Every ended rated house-1v1 lobby, by match time; one that cannot be read refuses. */
async function houseLobbies(store: Store): Promise<Lobby[]> {
  const lobbies: Lobby[] = [];
  let readTime: string | undefined;
  let startAfter: { value: string; path: string } | undefined;
  for (;;) {
    const page = await store.query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: MAX_PAGE_SIZE, startAfter, readTime });
    readTime ??= page.readTime;
    for (const { path, fields } of page.rows) {
      const winner = NATURAL_OUTCOMES[fields.outcome ?? ""];
      if (fields.state !== "ended" || fields.rated !== "true" || winner === undefined || fields.mode !== MODE) continue;
      const at = matchTime(fields);
      const seats = lobbySeats(fields.seats) as Lobby["seats"] | null;
      if (at === null || seats === null) refuse("unreadable-lobby", `unreadable rated ${MODE} lobby ${path}`);
      lobbies.push({ id: path.slice("lobbies/".length), at: at!, winner, seats: seats!, listed: fields.kind === "public" });
    }
    const last = page.rows.at(-1);
    if (page.rows.length < MAX_PAGE_SIZE || !last) break;
    startAfter = { value: last.fields.createdAt!, path: last.path };
  }
  return lobbies.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/**
 * The house-1v1 lobbies with their change records, watch entries and players' rows. A match that ends during the reads
 * shows up in the second lobby scan, and the whole history is read again.
 */
async function houseHistory(store: Store, extra: readonly string[]) {
  for (let attempt = 1; ; attempt++) {
    const lobbies = await houseLobbies(store);
    const players = [...new Set([...extra, ...lobbies.flatMap(lobby => lobby.seats.map(seat => seat.id))])];
    const paths = [...lobbies.flatMap(lobby => [`ratedMatches/${lobby.id}`, `watchMatches/${lobby.id}`]), ...players.map(id => `${ROWS}/${id}`)];
    const docs = new Map<string, Fields | null>();
    for (let i = 0; i < paths.length; i += 100) {
      for (const entry of await store.transaction(async read => ({ result: await read(paths.slice(i, i + 100)), writes: [] }))) docs.set(...entry);
    }
    const created = await store.createTimes!(lobbies.map(lobby => `ratedMatches/${lobby.id}`));
    if (JSON.stringify(await houseLobbies(store)) === JSON.stringify(lobbies)) return { lobbies, docs, created };
    if (attempt === HISTORY_ATTEMPTS) refuse("history-unstable", `${MODE} history changed during each of ${HISTORY_ATTEMPTS} reads`);
  }
}

const refusedNeverJoined = (v: Verification) => {
  const failed = v.checks.find(c => !c.ok);
  return refuse(failed ? NEVER_JOINED_CHECKS[failed.name.split(":")[0]!] ?? "error" : "never-joined-stage",
    `${NEVER_JOINED.lobbyId}: ${v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") || `stage ${v.stage}`}`);
};

/**
 * The never-joined lobby, verified as still rated: exactly the existing correction's Firestore writes, without its
 * recording rewrite, and their public facts. names gains each player's published name. Throws (refuses) on any failed check.
 */
async function neverJoinedPart(store: Store, v: Verification, names: Map<string, string>, at: number) {
  if (!v.ok || v.stage !== "rated") refusedNeverJoined(v);
  const writes: Write[] = firestoreWrites(v, new Date(at));
  for (const id of v.identities) names.set(id, names.get(id) ?? await currentName(store, id, at) ?? refuse("unknown-identity", `unknown identity ${id}`));
  const unrated = v.identities.map(id => shown(names.get(id)!));
  // Served as built here, from checked values only: each change's player must be the lobby's and its ratings finite numbers.
  const stored = JSON.parse(v.snapshot.get(`ratedMatches/${NEVER_JOINED.lobbyId}`)!.changes!) as unknown[];
  const ratingChanges = stored.map(change => {
    const { identityId, before, after } = (change ?? {}) as Record<string, unknown>;
    if (typeof identityId !== "string" || !v.identities.includes(identityId) || !Number.isFinite(before) || !Number.isFinite(after)) {
      refuse("never-joined-rating-change", `${NEVER_JOINED.lobbyId}: unreadable rating change`);
    }
    return { handle: shown(names.get(identityId as string)!), before: before as number, after: after as number };
  });
  const matches: PublicPlan["matches"][number][] = [{ match: NEVER_JOINED.replayId, startedAt: new Date(Number(v.snapshot.get(`lobbies/${NEVER_JOINED.lobbyId}`)!.startsAt)).toISOString(),
    before: { status: "rated", seats: unrated, ratingChanges },
    after: { status: "abandoned, unrated", seats: unrated, ratingChanges: [] } }];
  const ratings: PublicPlan["ratings"][number][] = v.identities.map(id => ({ handle: shown(names.get(id)!), mode: v.mode!,
    before: standing(id, v.snapshot.get(`${ratingCollection(v.mode!)}/${id}`)), after: null }));
  return { writes, matches, ratings };
}

/** The never-joined correction's plan, with what its checks verified: the documents read and the recording's objects. */
export interface NeverJoinedPlan extends Plan { readonly verification: Verification }

/**
 * Whether the never-joined correction is applied, read from what its one transaction wrote and nothing a later match
 * changes: its correction record names this lobby, its recording and the lobby's run, the lobby is abandoned and unrated,
 * its watch entry unrated, and its change record gone. The players' rating rows are not read, so either player may have
 * played since. Reads only.
 */
export async function neverJoinedApplied(store: Store): Promise<boolean> {
  const id = NEVER_JOINED.lobbyId;
  const paths = [`lobbies/${id}`, `watchMatches/${id}`, `ratedMatches/${id}`, `ratingCorrections/${id}`];
  const docs = await store.transaction(async read => ({ result: await read(paths), writes: [] }));
  const [lobby, watch, change, record] = paths.map(path => docs.get(path) ?? null);
  return !!lobby && !!watch && !!record && change === null && lobby.rated === "false" && lobby.outcome === "abandoned"
    && watch.rated === "false" && watch.replayId === NEVER_JOINED.replayId && record.kind === CORRECTION_KIND && record.lobbyId === id
    && record.replayId === NEVER_JOINED.replayId && !!lobby.matchRunId && record.runId === lobby.matchRunId;
}

/**
 * The never-joined correction alone, its digest over its writes alone; "applied" once neverJoinedApplied reads it
 * committed. Throws (refuses) on any failed check. Reads only.
 */
export async function planNeverJoined(store: Store, recordings: RecordingObjects): Promise<NeverJoinedPlan | "applied"> {
  if (await neverJoinedApplied(store)) return "applied";
  const v = await verify({ store, recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId);
  const { writes, matches, ratings } = await neverJoinedPart(store, v, new Map(), Date.now());
  return { writes, summary: { digest: planDigest(writes), matches, ratings }, verification: v };
}

/**
 * Both corrections, or "applied" while CORRECTION_MARKER exists; an applied never-joined correction is skipped, so the
 * plan is then the Sol move alone. Throws (refuses) on any failed check. Reads only. Run at start only once the
 * never-joined correction is applied, so there it is the Sol move alone.
 */
export async function planCorrections(store: Store, recordings: RecordingObjects): Promise<Plan | "applied"> {
  if (await store.get(CORRECTION_MARKER) !== null) return "applied";
  const names = new Map<string, string>();
  const at = Date.now();

  // 1. The never-joined lobby, unless its correction is already applied.
  const { writes, matches, ratings } = await neverJoinedApplied(store)
    ? { writes: [] as Write[], matches: [] as PublicPlan["matches"][number][], ratings: [] as PublicPlan["ratings"][number][] }
    : await neverJoinedPart(store, await verify({ store, recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId), names, at);
  const named = (changes: readonly RatingChange[]) => changes.map(c => ({ handle: shown(names.get(c.identityId)!), before: c.before, after: c.after }));

  // 2. The Sol move. Each moved match's lobby, found by its recording, and the two handles of its move.
  const registry = createWatchRegistry(store);
  const moves = await Promise.all(SOL_MOVES.map(async move => {
    const lobbyId = await registry.findByReplay(move.replayId);
    if (lobbyId === null || (move.lobbyId !== undefined && lobbyId !== move.lobbyId)) refuse("sol-lobby", `recording ${move.replayId}: lobby ${lobbyId}`);
    const [fromId, toId] = await Promise.all([houseHandleId(store, move.from), houseHandleId(store, move.to)]);
    if (!fromId || !toId) refuse("sol-handle", `${move.from} or ${move.to} not found`);
    names.set(fromId!, move.from).set(toId!, move.to);
    return { ...move, lobbyId: lobbyId!, fromId: fromId!, toId: toId! };
  }));
  const movers = moves.flatMap(move => [move.fromId, move.toId]);
  if (!store.createTimes) refuse("no-commit-times", "the store cannot read commit times");
  const { lobbies, docs, created } = await houseHistory(store, movers);
  for (const seat of lobbies.flatMap(lobby => lobby.seats)) names.set(seat.id, seat.displayName);
  const row = (id: string) => docs.get(`${ROWS}/${id}`) ?? null;
  const stored = new Map(lobbies.map(lobby => {
    let changes: unknown = null;
    try { changes = JSON.parse(docs.get(`ratedMatches/${lobby.id}`)?.changes ?? "null"); } catch { /* refused below */ }
    if (!Array.isArray(changes) || !teamsOf(lobby).flat().every(id => (changes as RatingChange[]).some(c => c.identityId === id))) {
      refuse("no-change-record", `lobby ${lobby.id}: no change record`);
    }
    return [lobby.id, changes as RatingChange[]] as const;
  }));
  const change = (lobby: Lobby, id: string) => stored.get(lobby.id)!.find(c => c.identityId === id)!;
  /** A createTime with its fraction padded to nanoseconds, so that text order is time order. */
  const createdAt = (lobby: Lobby) => {
    const at = /^(.+?)(?:\.(\d{1,9}))?Z$/.exec(created.get(`ratedMatches/${lobby.id}`) ?? "");
    return at ? `${at[1]}.${(at[2] ?? "").padEnd(9, "0")}Z` : refuse("no-change-record-time", `lobby ${lobby.id}: no change record time`);
  };

  // The order ratings were applied: each match's change record is created in the commit that rated it, so its
  // createTime (never its updateTime, which a later write moves) orders the ratings.
  const order = [...lobbies].sort((a, b) => createdAt(a) < createdAt(b) ? -1 : createdAt(a) > createdAt(b) ? 1 : 0);
  const moved = order.map(lobby => {
    const move = moves.find(each => each.lobbyId === lobby.id);
    if (!move) return lobby;
    if (!plays(lobby, move.fromId) || plays(lobby, move.toId)) refuse("moved-seats", `lobby ${lobby.id} seats do not match its move`);
    return { ...lobby, seats: lobby.seats.map(seat => seat.id === move.fromId ? { ...seat, id: move.toId, displayName: move.to } : seat) };
  });
  const first = Math.min(...moves.map(move => order.findIndex(lobby => lobby.id === move.lobbyId)));
  if (first < 0) refuse("moved-not-rated", `a moved lobby is not a rated ${MODE} match`);
  const window = order.slice(first);
  // Sorted, so equal times are neighbours; the match just before the window counts too.
  for (let i = Math.max(first, 1); i < order.length; i++) {
    const [a, b] = [order[i - 1]!, order[i]!];
    if (createdAt(a) === createdAt(b)) refuse("shared-commit-time", `order of lobbies ${a.id} and ${b.id} not established: their ratings share a commit time`);
  }
  const players = [...new Set([...window, ...moved.slice(first)].flatMap(lobby => teamsOf(lobby).flat()))];

  // Each player's state entering the window: as its first stored match in the window found it, else its row.
  const entering = new Map<string, PlayerState>(players.map(id => {
    const mine = window.filter(lobby => plays(lobby, id));
    const state = storedState(id, row(id));
    if (mine.length === 0) return [id, state];
    const { before, rdBefore } = change(mine[0]!, id);
    if (rdBefore === undefined) refuse("no-glicko-change", `lobby ${mine[0]!.id}: no Glicko change for ${names.get(id)}`);
    const previous = order.slice(0, first).filter(lobby => plays(lobby, id)).at(-1);
    return [id, { rating: before, rd: rdBefore!, ratedAt: previous?.at ?? null, ratedMatches: state.ratedMatches - mine.length }];
  }));
  const replay = (sequence: readonly Lobby[]) => {
    const state = new Map(entering);
    const changes = new Map<string, readonly RatingChange[]>();
    for (const lobby of sequence.slice(first)) {
      const rated = rateMatch(teamsOf(lobby), lobby.winner, lobby.at, id => state.get(id)!);
      for (const [id, next] of rated.next) state.set(id, next);
      changes.set(lobby.id, rated.changes);
    }
    return { state, changes };
  };
  const records = (sequence: readonly Lobby[], id: string): RatingRecord => sequence.filter(lobby => plays(lobby, id))
    .reduce((record, lobby) => withResult(record, letterFor(lobby.winner, teamsOf(lobby)[0].includes(id) ? 0 : 1), lobby.id), EMPTY_RECORD);

  // The replay without the move must reproduce what is stored, or the recompute is not the history it corrects.
  // Every value not reproduced is collected, one entry per value; the refusal names the first, in check order, and
  // carries the count of values and the largest finite deviation among them.
  const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) <= SAME;
  /** |replayed - stored| for one value; null when either is missing or not a finite number (still a difference). */
  const gap = (a: number | undefined, b: number | undefined) => {
    const value = a === undefined || b === undefined ? NaN : Math.abs(a - b);
    return Number.isFinite(value) ? value : null;
  };
  /** committedAt: the change record's commit time (createTime) for a failure in one, else null. */
  const failures: { code: RefusalCode; reason: string; deviation: number | null; handle: string; source: string;
    kind: ValueKind | null; committedAt: string | null }[] = [];
  /** One entry for each of the pairs that is not reproduced, each with its own deviation and kind. */
  const compare = (code: RefusalCode, reason: string, handle: string, source: string, committedAt: string | null,
    pairs: readonly (readonly [ValueKind, number | undefined, number | undefined])[]) => {
    for (const [kind, a, b] of pairs) if (!near(a, b)) failures.push({ code, reason, deviation: gap(a, b), handle, source, kind, committedAt });
  };
  const check = replay(order);
  for (const lobby of window) {
    const [replayed, kept] = [check.changes.get(lobby.id)!, stored.get(lobby.id)!];
    const source = `ratedMatches/${lobby.id}`;
    const ids = (changes: readonly RatingChange[]) => JSON.stringify(changes.map(c => c.identityId).sort());
    if (replayed.length !== kept.length || ids(replayed) !== ids(kept)) {
      failures.push({ code: "not-reproduced-players", reason: `stored history not reproduced: the players of lobby ${lobby.id}`, deviation: null, handle: "", source,
        kind: null, committedAt: createdAt(lobby) });
      continue;
    }
    for (const c of replayed) {
      const k = change(lobby, c.identityId);
      compare("not-reproduced-change", `stored history not reproduced: ${names.get(c.identityId)} in lobby ${lobby.id}`,
        shown(names.get(c.identityId) ?? ""), source, createdAt(lobby),
        [["before", c.before, k.before], ["rdBefore", c.rdBefore, k.rdBefore], ["after", c.after, k.after], ["rdAfter", c.rdAfter, k.rdAfter]]);
    }
  }
  for (const id of players) {
    const [now, replayed] = [storedState(id, row(id)), check.state.get(id)!];
    const [reason, handle, source] = [`stored history not reproduced: ${names.get(id)}`, shown(names.get(id) ?? ""), `${ROWS}/${id}`];
    compare("not-reproduced-rating", reason, handle, source, null, [["rating", replayed.rating, now.rating]]);
    compare("not-reproduced-rd", reason, handle, source, null, [["rd", replayed.rd, now.rd]]);
    const other = (code: RefusalCode, differs: boolean) => {
      if (differs) failures.push({ code, reason, deviation: null, handle, source, kind: null, committedAt: null });
    };
    other("not-reproduced-rated-at", replayed.ratedAt !== now.ratedAt);
    other("not-reproduced-rated-matches", replayed.ratedMatches !== now.ratedMatches);
    other("not-reproduced-record", movers.includes(id) && JSON.stringify(storedRecord(id, row(id))) !== JSON.stringify(records(order, id)));
  }
  if (failures.length > 0) {
    // The largest finite deviation over every value; a missing value counts but never masks one; the first wins a tie.
    const most = failures.reduce((a, b) => (b.deviation ?? -1) > (a.deviation ?? -1) ? b : a);
    const first = failures[0]!;
    // kind names where the largest numeric deviation is, so it is null whenever there is none (a missing value only).
    // Only strict UTC timestamps that are real instants count; padded alike, so text order is time order among them.
    const earliest = failures.flatMap(f => f.committedAt !== null && utcDay(f.committedAt) !== null ? [f.committedAt] : []).sort()[0];
    throw new PlanRefused(first.code, first.reason, { deviation: most.deviation, handle: most.handle, source: most.source, count: failures.length },
      { deviation: most.deviation, count: failures.length, kind: most.deviation === null ? null : most.kind, earliestChangeDay: earliest === undefined ? null : utcDay(earliest) });
  }

  // The move: lobbies' seats, watch-entry labels, changed change records and rating rows.
  const result = replay(moved);
  for (const [i, lobby] of moved.entries()) {
    if (i < first) continue;
    const was = order[i]!;
    const move = moves.find(each => each.lobbyId === lobby.id);
    const labels = JSON.parse(docs.get(`watchMatches/${lobby.id}`)?.modelLabels ?? "{}") as Record<string, string>;
    const relabelled = move && move.from in labels ? Object.fromEntries(Object.entries(labels).map(([k, l]) => [k === move.from ? move.to : k, l])) : null;
    const changes = JSON.stringify(result.changes.get(lobby.id));
    const rechanged = changes !== JSON.stringify(stored.get(lobby.id));
    if (move) writes.push({ op: "update", path: `lobbies/${lobby.id}`, fields: { seats: JSON.stringify(lobby.seats) } });
    if (relabelled) writes.push({ op: "update", path: `watchMatches/${lobby.id}`, fields: { modelLabels: JSON.stringify(relabelled) } });
    if (rechanged) writes.push({ op: "update", path: `ratedMatches/${lobby.id}`, fields: { changes } });
    if (!move && !rechanged) continue;
    // A match is named by its recording, or by its public lobby id until a recording is published.
    const match = docs.get(`watchMatches/${lobby.id}`)?.replayId || (lobby.listed ? lobby.id : refuse("no-public-match-id", `lobby ${lobby.id}: no public match id`));
    matches.push({ match, startedAt: new Date(lobby.at).toISOString(),
      before: { status: "rated", seats: was.seats.map(seat => shown(seat.displayName)), ratingChanges: named(stored.get(lobby.id)!), ...(relabelled ? { labels: shownKeys(labels) } : {}) },
      after: { status: "rated", seats: lobby.seats.map(seat => shown(seat.displayName)), ratingChanges: named(result.changes.get(lobby.id)!),
        ...(relabelled ? { labels: shownKeys(relabelled) } : {}) } });
  }
  for (const id of players) {
    const [now, next, fields] = [storedState(id, row(id)), result.state.get(id)!, row(id)];
    if (next.rating === now.rating && next.rd === now.rd && next.ratedMatches === now.ratedMatches && !movers.includes(id)) continue;
    if (!fields) refuse("no-row", `no ${MODE} row for ${names.get(id)}`);
    const rating = encodeRating(next.rating);
    const updated: Fields = { rating, ratedMatches: String(next.ratedMatches), ...glickoFields(next),
      ...(movers.includes(id) ? recordFields(records(moved, id)) : {}), ...(fields!.houseRating !== undefined ? { houseRating: rating } : {}) };
    writes.push({ op: "update", path: `${ROWS}/${id}`, fields: updated });
    ratings.push({ handle: shown(names.get(id)!), mode: MODE, before: standing(id, fields), after: standing(id, { ...fields!, ...updated }) });
  }
  return { writes, summary: { digest: planDigest(writes), matches, ratings } };
}

/** Where the house-1v1 move's read-only plan is served, under PLAN_PATH's mount. */
export const SOL_PLAN_PATH = `${PLAN_PATH}/house-1v1`;

/**
 * The house-1v1 move, read-only: planned, logged and served once the never-joined correction is applied, never applied
 * here. A refusal logs its code and, where the stored history is not reproduced, its largest deviation (refusalDeviation);
 * it serves the code, and for a not-reproduced history also its public figures (refusalFigures), never a name or id.
 */
async function planSol(store: Store, recordings: RecordingObjects): Promise<PlanState> {
  let plan: Plan | "applied";
  try { plan = await planCorrections(store, recordings); } catch (error) {
    const reason = refusalCode(error);
    const deviation = refusalDeviation(error);
    console.warn("antwar house-1v1 rating correction plan refused", { reason, ...(deviation ? { deviation } : {}) });
    const figures = refusalFigures(error);
    return figures ? { state: "refused", reason, ...figures } : { state: "refused", reason };
  }
  if (plan === "applied") return { state: "applied" };
  for (const write of plan.writes) console.info(`antwar house-1v1 rating correction planned: ${write.op} ${write.path}`);
  console.info("antwar house-1v1 rating correction plan", { digest: plan.summary.digest, writes: plan.writes.length });
  return { state: "planned", ...plan.summary };
}

/**
 * The corrections as the entry point runs them at start, in the background, reading only: logged, never thrown. It plans
 * the never-joined correction and logs the plan; it never applies it. Once that correction reads applied, it plans the
 * house-1v1 move read-only (planSol); while it does not, that plan is refused as never-joined-not-applied. serve answers
 * GET PLAN_PATH with the never-joined plan's public facts while it is pending, "applied" once it reads applied, or
 * "refused" with its code, and GET SOL_PLAN_PATH likewise with the house-1v1 plan.
 */
export function startCorrectionPlan(store: Store, recordings: RecordingObjects): { readonly serve: MountHandler } {
  let current: PlanState = { state: "computing" };
  let sol: PlanState = { state: "computing" };
  const notApplied: PlanState = { state: "refused", reason: "never-joined-not-applied" };
  void (async () => {
    let plan: NeverJoinedPlan | "applied";
    try { plan = await planNeverJoined(store, recordings); } catch (error) {
      // The code alone, from REFUSAL_CODES: never the error text, which can quote a stored value.
      const reason = refusalCode(error);
      console.warn("antwar rating correction plan refused", { reason });
      current = { state: "refused", reason };
      sol = notApplied;
      return;
    }
    if (plan === "applied") { current = { state: "applied" }; sol = await planSol(store, recordings); return; }
    // A safe projection of each write: its operation and path, every path a constant or a checked identity id.
    for (const write of plan.writes) console.info(`antwar rating correction planned: ${write.op} ${write.path}`);
    console.info("antwar rating correction plan", { digest: plan.summary.digest, writes: plan.writes.length });
    current = { state: "planned", ...plan.summary };
    sol = notApplied;
  })();
  return {
    serve(req, res) {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== PLAN_PATH && path !== SOL_PLAN_PATH) { res.writeHead(404).end(); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      const body = Buffer.from(JSON.stringify(path === PLAN_PATH ? current : sol));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    },
  };
}
