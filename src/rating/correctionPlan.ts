/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Fields, Store, Write } from "../store/firestore.js";
import {
  binaryName, HoldUnknownError, RecordingChangedError, RecordingHeldError, recordName, type HeldObject, type RecordingHolds, type RecordingObjects,
} from "../replays/abandonRecording.js";
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
 * logs each write's operation and path and a SHA-256 digest of those writes alone, serves the plan's public facts at PLAN_PATH, and
 * applies it only when that digest is NEVER_JOINED_APPLY_DIGEST (applyNeverJoined). The Sol move is not run at start.
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
 * Any failed check refuses the whole plan: PLAN_PATH says only "refused", and the log says only that it refused (a stored
 * value can be malformed, so no error text is logged).
 * CORRECTION_MARKER is created by the apply in the same transaction as these writes: { planDigest, appliedAt }.
 * While it exists nothing is planned.
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
export type PlanState = { readonly state: "computing" | "applied" | "refused" } | ({ readonly state: "planned" } & PublicPlan);

const refuse = (reason: string): never => { throw new Error(reason); };
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
      if (at === null || seats === null) refuse(`unreadable rated ${MODE} lobby ${path}`);
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
    if (attempt === HISTORY_ATTEMPTS) refuse(`${MODE} history changed during each of ${HISTORY_ATTEMPTS} reads`);
  }
}

const refusedNeverJoined = (v: Verification) =>
  refuse(`${NEVER_JOINED.lobbyId}: ${v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") || `stage ${v.stage}`}`);

/**
 * The never-joined lobby, verified as still rated: exactly the existing correction's Firestore writes, without its
 * recording rewrite, and their public facts. names gains each player's published name. Throws (refuses) on any failed check.
 */
async function neverJoinedPart(store: Store, v: Verification, names: Map<string, string>, at: number) {
  if (!v.ok || v.stage !== "rated") refusedNeverJoined(v);
  const writes: Write[] = firestoreWrites(v, new Date(at));
  for (const id of v.identities) names.set(id, names.get(id) ?? await currentName(store, id, at) ?? refuse(`unknown identity ${id}`));
  const unrated = v.identities.map(id => shown(names.get(id)!));
  // Served as built here, from checked values only: each change's player must be the lobby's and its ratings finite numbers.
  const stored = JSON.parse(v.snapshot.get(`ratedMatches/${NEVER_JOINED.lobbyId}`)!.changes!) as unknown[];
  const ratingChanges = stored.map(change => {
    const { identityId, before, after } = (change ?? {}) as Record<string, unknown>;
    if (typeof identityId !== "string" || !v.identities.includes(identityId) || !Number.isFinite(before) || !Number.isFinite(after)) {
      refuse(`${NEVER_JOINED.lobbyId}: unreadable rating change`);
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
 * The digest of the one never-joined plan the apply may write: set, in a reviewed commit, to the digest the plan
 * published. A placeholder until then: it is not a SHA-256, so it matches no plan and nothing is applied.
 */
export const NEVER_JOINED_APPLY_DIGEST = "placeholder: not yet set, matches no plan";
export type ApplyOutcome = "applied" | "digest differs" | "changed since planned" | "already claimed" | "recording already held";

/** The one apply's claim on the never-joined correction: created only where absent, so only one apply runs at a time. */
export const NEVER_JOINED_CLAIM = `ratingCorrectionClaims/${NEVER_JOINED.lobbyId}`;

/**
 * Applies the never-joined plan only when its digest is `digest`, writing nothing if anything it depends on changed
 * since the plan: the Firestore documents its checks read, or either recording object.
 *
 * Exclusive: the apply first creates NEVER_JOINED_CLAIM where it is absent, naming its own token, the digest and both
 * recording objects it may hold. Another apply (a concurrent start) finds the claim and touches nothing. The claim is
 * deleted only once every hold this apply set is confirmed cleared; otherwise it stays, naming the objects to check.
 *
 * The recording: the writes depend on it through what the checks read from it (which colony never joined), and only
 * the recording holds that. So both objects are then held at the generations the checks read, before the transaction.
 * A hold is set only on an unheld object at that generation, conditioned on its metadata, so an object replaced or
 * deleted since the plan, or already held, fails it, and nothing is written; a hold this apply did not set is never
 * cleared. Only a reply confirming a hold counts as set, and only one confirming it cleared as cleared: after an
 * error, lost or unconfirmed hold reply, a refusal on its conditions (412 or 404) included, the hold is undetermined
 * (the request, or an earlier attempt of it, may have landed), so the apply stops,
 * writing nothing, releases only the holds confirmed set, and keeps its claim, which names both objects to release by
 * hand. While held, Cloud Storage refuses to replace or delete either object, so both
 * stay at those generations until the commit. Then one transaction re-reads every document the checks read and the
 * claim, and commits the writes only while every one is unchanged and the claim is this apply's. Both holds are
 * released once the transaction's outcome is known. If the transaction throws, its commit may still land, so the holds
 * and the claim are kept and must be released by hand. The recording itself is never rewritten. The writes create the
 * correction record (ratingCorrections/<lobbyId>): a later plan reads the correction as applied (neverJoinedApplied),
 * even after either player has played again, so it is written once.
 */
export async function applyNeverJoined(store: Store, recordings: RecordingObjects & RecordingHolds, plan: NeverJoinedPlan,
  digest = NEVER_JOINED_APPLY_DIGEST): Promise<ApplyOutcome> {
  if (plan.summary.digest !== digest) return "digest differs";
  const { snapshot, recording, replayId } = plan.verification;
  const objects = [{ name: binaryName(replayId!), generation: recording!.binary.generation }, { name: recordName(replayId!), generation: recording!.record.generation }];
  const token = randomUUID();
  const claimed = await store.transaction(async read => (await read([NEVER_JOINED_CLAIM])).get(NEVER_JOINED_CLAIM)
    ? { result: false, writes: [] }
    : { result: true, writes: [{ op: "create" as const, path: NEVER_JOINED_CLAIM, fields: { token, digest, objects: JSON.stringify(objects), at: String(Date.now()) } }] });
  if (!claimed) return "already claimed";

  const held: HeldObject[] = [];
  /** Clears this apply's holds; the claim is deleted only once every one is confirmed cleared. */
  const finish = async () => {
    let cleared = true;
    for (const hold of held.splice(0)) if (!await recordings.release(hold)) cleared = false;
    if (!cleared) { console.warn("antwar rating correction recording hold kept; its claim names the objects"); return; }
    try {
      await store.transaction(async read => ({ result: undefined,
        writes: (await read([NEVER_JOINED_CLAIM])).get(NEVER_JOINED_CLAIM)?.token === token ? [{ op: "delete" as const, path: NEVER_JOINED_CLAIM }] : [] }));
    } catch { console.warn("antwar rating correction claim not released"); }
  };
  try {
    for (const object of objects) held.push(await recordings.hold(object.name, object.generation));
  } catch (error) {
    if (error instanceof HoldUnknownError) {
      // This hold may yet be set, by this apply or not: it is never released here, and the claim stays, naming both objects.
      for (const hold of held.splice(0)) await recordings.release(hold);
      console.warn("antwar rating correction recording hold undetermined; its claim names the objects");
      throw error;
    }
    await finish();
    if (error instanceof RecordingChangedError) return "changed since planned";
    if (error instanceof RecordingHeldError) return "recording already held";
    throw error;
  }
  const paths = [...snapshot.keys()];
  const outcome = await store.transaction(async read => {
    const now = await read([...paths, NEVER_JOINED_CLAIM]);
    if (now.get(NEVER_JOINED_CLAIM)?.token !== token) return { result: "already claimed" as const, writes: [] };
    if (!paths.every(path => isDeepStrictEqual(now.get(path) ?? null, snapshot.get(path) ?? null))) return { result: "changed since planned" as const, writes: [] };
    return { result: "applied" as const, writes: [...plan.writes] };
  });
  await finish();
  return outcome;
}

/**
 * Both corrections, or "applied" while CORRECTION_MARKER exists; an applied never-joined correction is skipped, so the
 * plan is then the Sol move alone. Throws (refuses) on any failed check. Reads only. Not run at start.
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
    if (lobbyId === null || (move.lobbyId !== undefined && lobbyId !== move.lobbyId)) refuse(`recording ${move.replayId}: lobby ${lobbyId}`);
    const [fromId, toId] = await Promise.all([houseHandleId(store, move.from), houseHandleId(store, move.to)]);
    if (!fromId || !toId) refuse(`${move.from} or ${move.to} not found`);
    names.set(fromId!, move.from).set(toId!, move.to);
    return { ...move, lobbyId: lobbyId!, fromId: fromId!, toId: toId! };
  }));
  const movers = moves.flatMap(move => [move.fromId, move.toId]);
  if (!store.createTimes) refuse("the store cannot read commit times");
  const { lobbies, docs, created } = await houseHistory(store, movers);
  for (const seat of lobbies.flatMap(lobby => lobby.seats)) names.set(seat.id, seat.displayName);
  const row = (id: string) => docs.get(`${ROWS}/${id}`) ?? null;
  const stored = new Map(lobbies.map(lobby => {
    let changes: unknown = null;
    try { changes = JSON.parse(docs.get(`ratedMatches/${lobby.id}`)?.changes ?? "null"); } catch { /* refused below */ }
    if (!Array.isArray(changes) || !teamsOf(lobby).flat().every(id => (changes as RatingChange[]).some(c => c.identityId === id))) {
      refuse(`lobby ${lobby.id}: no change record`);
    }
    return [lobby.id, changes as RatingChange[]] as const;
  }));
  const change = (lobby: Lobby, id: string) => stored.get(lobby.id)!.find(c => c.identityId === id)!;
  /** A createTime with its fraction padded to nanoseconds, so that text order is time order. */
  const createdAt = (lobby: Lobby) => {
    const at = /^(.+?)(?:\.(\d{1,9}))?Z$/.exec(created.get(`ratedMatches/${lobby.id}`) ?? "");
    return at ? `${at[1]}.${(at[2] ?? "").padEnd(9, "0")}Z` : refuse(`lobby ${lobby.id}: no change record time`);
  };

  // The order ratings were applied: each match's change record is created in the commit that rated it, so its
  // createTime (never its updateTime, which a later write moves) orders the ratings.
  const order = [...lobbies].sort((a, b) => createdAt(a) < createdAt(b) ? -1 : createdAt(a) > createdAt(b) ? 1 : 0);
  const moved = order.map(lobby => {
    const move = moves.find(each => each.lobbyId === lobby.id);
    if (!move) return lobby;
    if (!plays(lobby, move.fromId) || plays(lobby, move.toId)) refuse(`lobby ${lobby.id} seats do not match its move`);
    return { ...lobby, seats: lobby.seats.map(seat => seat.id === move.fromId ? { ...seat, id: move.toId, displayName: move.to } : seat) };
  });
  const first = Math.min(...moves.map(move => order.findIndex(lobby => lobby.id === move.lobbyId)));
  if (first < 0) refuse(`a moved lobby is not a rated ${MODE} match`);
  const window = order.slice(first);
  // Sorted, so equal times are neighbours; the match just before the window counts too.
  for (let i = Math.max(first, 1); i < order.length; i++) {
    const [a, b] = [order[i - 1]!, order[i]!];
    if (createdAt(a) === createdAt(b)) refuse(`order of lobbies ${a.id} and ${b.id} not established: their ratings share a commit time`);
  }
  const players = [...new Set([...window, ...moved.slice(first)].flatMap(lobby => teamsOf(lobby).flat()))];

  // Each player's state entering the window: as its first stored match in the window found it, else its row.
  const entering = new Map<string, PlayerState>(players.map(id => {
    const mine = window.filter(lobby => plays(lobby, id));
    const state = storedState(id, row(id));
    if (mine.length === 0) return [id, state];
    const { before, rdBefore } = change(mine[0]!, id);
    if (rdBefore === undefined) refuse(`lobby ${mine[0]!.id}: no Glicko change for ${names.get(id)}`);
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
  const near = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= SAME;
  const check = replay(order);
  for (const lobby of window) {
    const [replayed, kept] = [check.changes.get(lobby.id)!, stored.get(lobby.id)!];
    const ids = (changes: readonly RatingChange[]) => JSON.stringify(changes.map(c => c.identityId).sort());
    if (replayed.length !== kept.length || ids(replayed) !== ids(kept)) refuse(`stored history not reproduced: the players of lobby ${lobby.id}`);
    for (const c of replayed) {
      const k = change(lobby, c.identityId);
      if (!near(c.before, k.before) || !near(c.rdBefore!, k.rdBefore) || !near(c.after, k.after) || !near(c.rdAfter!, k.rdAfter)) {
        refuse(`stored history not reproduced: ${names.get(c.identityId)} in lobby ${lobby.id}`);
      }
    }
  }
  for (const id of players) {
    const [now, replayed] = [storedState(id, row(id)), check.state.get(id)!];
    if (!near(replayed.rating, now.rating) || !near(replayed.rd, now.rd) || replayed.ratedAt !== now.ratedAt || replayed.ratedMatches !== now.ratedMatches
      || (movers.includes(id) && JSON.stringify(storedRecord(id, row(id))) !== JSON.stringify(records(order, id)))) {
      refuse(`stored history not reproduced: ${names.get(id)}`);
    }
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
    const match = docs.get(`watchMatches/${lobby.id}`)?.replayId || (lobby.listed ? lobby.id : refuse(`lobby ${lobby.id}: no public match id`));
    matches.push({ match, startedAt: new Date(lobby.at).toISOString(),
      before: { status: "rated", seats: was.seats.map(seat => shown(seat.displayName)), ratingChanges: named(stored.get(lobby.id)!), ...(relabelled ? { labels: shownKeys(labels) } : {}) },
      after: { status: "rated", seats: lobby.seats.map(seat => shown(seat.displayName)), ratingChanges: named(result.changes.get(lobby.id)!),
        ...(relabelled ? { labels: shownKeys(relabelled) } : {}) } });
  }
  for (const id of players) {
    const [now, next, fields] = [storedState(id, row(id)), result.state.get(id)!, row(id)];
    if (next.rating === now.rating && next.rd === now.rd && next.ratedMatches === now.ratedMatches && !movers.includes(id)) continue;
    if (!fields) refuse(`no ${MODE} row for ${names.get(id)}`);
    const rating = encodeRating(next.rating);
    const updated: Fields = { rating, ratedMatches: String(next.ratedMatches), ...glickoFields(next),
      ...(movers.includes(id) ? recordFields(records(moved, id)) : {}), ...(fields!.houseRating !== undefined ? { houseRating: rating } : {}) };
    writes.push({ op: "update", path: `${ROWS}/${id}`, fields: updated });
    ratings.push({ handle: shown(names.get(id)!), mode: MODE, before: standing(id, fields), after: standing(id, { ...fields!, ...updated }) });
  }
  return { writes, summary: { digest: planDigest(writes), matches, ratings } };
}

/**
 * The never-joined correction as the entry point runs it at start, in the background: logged, never thrown. It plans,
 * logs the plan, and applies it when its digest is applyDigest. serve answers GET PLAN_PATH with the plan's public facts
 * while it is pending, "applied" once it is, or "refused".
 */
export function startCorrectionPlan(store: Store, recordings: RecordingObjects & RecordingHolds, applyDigest = NEVER_JOINED_APPLY_DIGEST): { readonly serve: MountHandler } {
  let current: PlanState = { state: "computing" };
  void (async () => {
    let plan: NeverJoinedPlan | "applied";
    try { plan = await planNeverJoined(store, recordings); } catch {
      console.warn("antwar rating correction plan refused");
      current = { state: "refused" };
      return;
    }
    if (plan === "applied") { current = { state: "applied" }; return; }
    // A safe projection of each write: its operation and path, every path a constant or a checked identity id.
    for (const write of plan.writes) console.info(`antwar rating correction planned: ${write.op} ${write.path}`);
    console.info("antwar rating correction plan", { digest: plan.summary.digest, writes: plan.writes.length });
    current = { state: "planned", ...plan.summary };
    try {
      const outcome = await applyNeverJoined(store, recordings, plan, applyDigest);
      if (outcome === "applied") current = { state: "applied" };
      console.info(`antwar rating correction ${outcome === "applied" ? "applied" : `not applied: ${outcome}`}`, { digest: plan.summary.digest, writes: plan.writes.length });
    } catch {
      console.warn("antwar rating correction apply failed");
    }
  })();
  return {
    serve(req, res) {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== PLAN_PATH) { res.writeHead(404).end(); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      const body = Buffer.from(JSON.stringify(current));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    },
  };
}
