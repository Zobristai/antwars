/// <reference types="node" />
import { createHash } from "node:crypto";
import type { Fields, Store, Write } from "../store/firestore.js";
import type { RecordingObjects } from "../replays/abandonRecording.js";
import type { MountHandler } from "../server.js";
import { createIdentities } from "../identity/identities.js";
import { createWatchRegistry } from "../live/watch-registry.js";
import { describe, firestoreWrites, verify } from "./unrateNeverJoined.js";
import {
  EMPTY_RECORD, encodeRating, glickoFields, letterFor, lobbySeats, matchTime, MAX_PAGE_SIZE, NATURAL_OUTCOMES, rateMatch, ratingCollection,
  recordFields, storedRecord, storedState, withResult, type PlayerState, type RatingChange, type RatingRecord, type Winner,
} from "./ratings.js";

/**
 * One-off rating corrections, read-only pass. At start the entry-point server works out every write that two owed
 * corrections need, logs one line per write and a SHA-256 digest of the plan, and serves the plan's public facts at
 * PLAN_PATH. It writes nothing: it only reads Firestore and the two objects of one public recording.
 *
 * 1. Ranked lobby NEVER_JOINED, which one seat never joined, becomes abandoned and unrated with its rating effect
 *    removed: unrateNeverJoined.ts's verify and Firestore writes, without its recording rewrite.
 * 2. Two 2026-11-01 house-1v1 matches move from the standard Sol handles to the -fast handles that played them
 *    (SOL_MOVES), and house-1v1 ratings are recomputed with rateMatch, in the order they were applied, from each
 *    player's state before the first moved match. Ratings are applied when a match ends, so that order is read from
 *    the stored change records: each player's next match starts from the rating its previous one left. The pass
 *    refuses unless the same replay without the move reproduces every stored change and row.
 *
 * Any failed check refuses the whole plan: the reason is logged and PLAN_PATH says only "refused".
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
/** Every planned change in public terms: one entry per changed match (by recording id), one per changed rating row. */
export interface PublicPlan {
  readonly digest: string;
  readonly matches: readonly { readonly match: string | null; readonly startedAt: string; readonly before: MatchState; readonly after: MatchState }[];
  readonly ratings: readonly { readonly handle: string; readonly mode: string; readonly before: Standing | null; readonly after: Standing | null }[];
}
export interface Plan { readonly writes: readonly Write[]; readonly summary: PublicPlan }
export type PlanState = { readonly state: "computing" | "applied" | "refused" } | ({ readonly state: "planned" } & PublicPlan);

const refuse = (reason: string): never => { throw new Error(reason); };
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

interface Lobby { readonly id: string; readonly at: number; readonly winner: Winner; readonly seats: readonly { id: string; displayName: string; colony: 0 | 1 }[] }
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
      lobbies.push({ id: path.slice("lobbies/".length), at: at!, winner, seats: seats! });
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
    if (JSON.stringify(await houseLobbies(store)) === JSON.stringify(lobbies)) return { lobbies, docs };
    if (attempt === HISTORY_ATTEMPTS) refuse(`${MODE} history changed during each of ${HISTORY_ATTEMPTS} reads`);
  }
}

/** The plan, or "applied" while CORRECTION_MARKER exists. Throws (refuses) on any failed check. Reads only. */
export async function planCorrections(store: Store, recordings: RecordingObjects): Promise<Plan | "applied"> {
  if (await store.get(CORRECTION_MARKER) !== null) return "applied";
  const identities = createIdentities(store);
  const names = new Map<string, string>();
  const handle = async (id: string) => names.get(id) ?? (await identities.findById(id))?.displayName ?? refuse(`unknown identity ${id}`);
  const named = (changes: readonly RatingChange[]) => changes.map(c => ({ handle: names.get(c.identityId)!, before: c.before, after: c.after }));

  // 1. The never-joined lobby: verified as still rated, then exactly the existing correction's Firestore writes.
  const v = await verify({ store, recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId);
  if (!v.ok || v.stage !== "rated") refuse(`${NEVER_JOINED.lobbyId}: ${v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") || `stage ${v.stage}`}`);
  const writes: Write[] = firestoreWrites(v, new Date());
  for (const id of v.identities) names.set(id, await handle(id));
  const unrated = v.identities.map(id => names.get(id)!);
  const matches: PublicPlan["matches"][number][] = [{ match: NEVER_JOINED.replayId, startedAt: new Date(Number(v.snapshot.get(`lobbies/${NEVER_JOINED.lobbyId}`)!.startsAt)).toISOString(),
    before: { status: "rated", seats: unrated, ratingChanges: named(JSON.parse(v.snapshot.get(`ratedMatches/${NEVER_JOINED.lobbyId}`)!.changes!)) },
    after: { status: "abandoned, unrated", seats: unrated, ratingChanges: [] } }];
  const ratings: PublicPlan["ratings"][number][] = v.identities.map(id => ({ handle: names.get(id)!, mode: v.mode!,
    before: standing(id, v.snapshot.get(`${ratingCollection(v.mode!)}/${id}`)), after: null }));

  // 2. The Sol move. Each moved match's lobby, found by its recording, and the two handles of its move.
  const registry = createWatchRegistry(store);
  const moves = await Promise.all(SOL_MOVES.map(async move => {
    const lobbyId = await registry.findByReplay(move.replayId);
    if (lobbyId === null || (move.lobbyId !== undefined && lobbyId !== move.lobbyId)) refuse(`recording ${move.replayId}: lobby ${lobbyId}`);
    const [from, to] = await Promise.all([identities.findByDisplayName(move.from), identities.findByDisplayName(move.to)]);
    if (!from || !to) refuse(`${move.from} or ${move.to} not found`);
    names.set(from!.id, move.from).set(to!.id, move.to);
    return { ...move, lobbyId: lobbyId!, fromId: from!.id, toId: to!.id };
  }));
  const movers = moves.flatMap(move => [move.fromId, move.toId]);
  const { lobbies, docs } = await houseHistory(store, movers);
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

  // The order ratings were applied: each player's matches chained by rating, merged by match time where unchained.
  const after = new Map<string, Set<string>>(lobbies.map(lobby => [lobby.id, new Set()]));
  const waits = new Map(lobbies.map(lobby => [lobby.id, 0]));
  for (const id of new Set(lobbies.flatMap(lobby => teamsOf(lobby).flat()))) {
    const mine = lobbies.filter(lobby => plays(lobby, id));
    const ends = new Set(mine.map(lobby => change(lobby, id).after));
    const starts = mine.filter(lobby => !ends.has(change(lobby, id).before));
    const chain = starts.length === 1 ? [starts[0]!] : [];
    while (chain.length > 0 && chain.length < mine.length) {
      const last = chain.at(-1)!;
      const next = mine.filter(lobby => !chain.includes(lobby) && change(lobby, id).before === change(last, id).after);
      if (next.length !== 1) break;
      after.get(last.id)!.add(next[0]!.id);
      chain.push(next[0]!);
    }
    if (chain.length !== mine.length) refuse(`order of ${names.get(id)}'s ${MODE} matches not established from their stored ratings`);
  }
  for (const next of after.values()) for (const id of next) waits.set(id, waits.get(id)! + 1);
  const order: Lobby[] = [];
  const ready = lobbies.filter(lobby => waits.get(lobby.id) === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const lobby = ready.shift()!;
    order.push(lobby);
    for (const id of after.get(lobby.id)!) if (waits.set(id, waits.get(id)! - 1).get(id) === 0) ready.push(lobbies.find(each => each.id === id)!);
  }
  if (order.length !== lobbies.length) refuse(`order of ${MODE} matches not established: their stored ratings form a cycle`);
  const moved = order.map(lobby => {
    const move = moves.find(each => each.lobbyId === lobby.id);
    if (!move) return lobby;
    if (!plays(lobby, move.fromId) || plays(lobby, move.toId)) refuse(`lobby ${lobby.id} seats do not match its move`);
    return { ...lobby, seats: lobby.seats.map(seat => seat.id === move.fromId ? { ...seat, id: move.toId, displayName: move.to } : seat) };
  });
  const first = Math.min(...moves.map(move => order.findIndex(lobby => lobby.id === move.lobbyId)));
  if (first < 0) refuse(`a moved lobby is not a rated ${MODE} match`);
  const window = order.slice(first);
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
    for (const c of check.changes.get(lobby.id)!) {
      const kept = change(lobby, c.identityId);
      if (!near(c.after, kept.after) || !near(c.rdAfter!, kept.rdAfter)) refuse(`stored history not reproduced: ${names.get(c.identityId)} in lobby ${lobby.id}`);
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
    matches.push({ match: docs.get(`watchMatches/${lobby.id}`)?.replayId ?? null, startedAt: new Date(lobby.at).toISOString(),
      before: { status: "rated", seats: was.seats.map(seat => seat.displayName), ratingChanges: named(stored.get(lobby.id)!), ...(relabelled ? { labels } : {}) },
      after: { status: "rated", seats: lobby.seats.map(seat => seat.displayName), ratingChanges: named(result.changes.get(lobby.id)!),
        ...(relabelled ? { labels: relabelled } : {}) } });
  }
  for (const id of players) {
    const [now, next, fields] = [storedState(id, row(id)), result.state.get(id)!, row(id)];
    if (next.rating === now.rating && next.rd === now.rd && next.ratedMatches === now.ratedMatches && !movers.includes(id)) continue;
    if (!fields) refuse(`no ${MODE} row for ${names.get(id)}`);
    const rating = encodeRating(next.rating);
    const updated: Fields = { rating, ratedMatches: String(next.ratedMatches), ...glickoFields(next),
      ...(movers.includes(id) ? recordFields(records(moved, id)) : {}), ...(fields!.houseRating !== undefined ? { houseRating: rating } : {}) };
    writes.push({ op: "update", path: `${ROWS}/${id}`, fields: updated });
    ratings.push({ handle: names.get(id)!, mode: MODE, before: standing(id, fields), after: standing(id, { ...fields!, ...updated }) });
  }
  return { writes, summary: { digest: planDigest(writes), matches, ratings } };
}

/**
 * The read-only pass as the entry point runs it at start, in the background: logged, never thrown. serve answers
 * GET PLAN_PATH with the plan's public facts while it is pending.
 */
export function startCorrectionPlan(store: Store, recordings: RecordingObjects): { readonly serve: MountHandler } {
  let current: PlanState = { state: "computing" };
  void planCorrections(store, recordings).then(plan => {
    if (plan === "applied") { current = { state: "applied" }; return; }
    for (const write of plan.writes) console.info(`antwar rating correction planned: ${describe(write)}`);
    console.info("antwar rating correction plan", { digest: plan.summary.digest, writes: plan.writes.length });
    current = { state: "planned", ...plan.summary };
  }, (error: unknown) => {
    console.warn(`antwar rating correction plan refused: ${error instanceof Error ? error.message : String(error)}`);
    current = { state: "refused" };
  });
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
