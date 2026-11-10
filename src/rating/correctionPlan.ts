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
 *    (SOL_MOVES), and house-1v1 ratings are recomputed in order with rateMatch from each player's state before the
 *    first moved match. The pass refuses unless the same replay without the move reproduces every stored change and row.
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
const SAME = 1e-9;

interface Standing { readonly rating: number; readonly rd: number; readonly record: string }
export interface PublicPlan {
  readonly digest: string;
  readonly matches: readonly { readonly match: string; readonly before: MatchStatus; readonly after: MatchStatus }[];
  readonly ratings: readonly { readonly handle: string; readonly mode: string; readonly before: Standing | null; readonly after: Standing | null }[];
}
interface MatchStatus { readonly status: "rated" | "abandoned, unrated"; readonly seats: readonly string[] }
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

/** Every ended rated house-1v1 lobby, oldest match first; one that cannot be read refuses. */
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

/** The whole plan, or "applied" while CORRECTION_MARKER exists. Throws (refuses) on any failed check. Reads only. */
export async function planCorrections(store: Store, recordings: RecordingObjects): Promise<Plan | "applied"> {
  if (await store.get(CORRECTION_MARKER) !== null) return "applied";
  const identities = createIdentities(store);
  const handle = async (id: string) => (await identities.findById(id))?.displayName ?? refuse(`unknown identity ${id}`);

  // 1. The never-joined lobby: verified as still rated, then exactly the existing correction's Firestore writes.
  const v = await verify({ store, recordings }, NEVER_JOINED.lobbyId, NEVER_JOINED.replayId);
  if (!v.ok || v.stage !== "rated") refuse(`${NEVER_JOINED.lobbyId}: ${v.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") || `stage ${v.stage}`}`);
  const writes: Write[] = firestoreWrites(v, new Date());
  const unratedSeats = await Promise.all(v.identities.map(handle));
  const matches: PublicPlan["matches"][number][] = [{ match: NEVER_JOINED.replayId,
    before: { status: "rated", seats: unratedSeats }, after: { status: "abandoned, unrated", seats: unratedSeats } }];
  const ratings: PublicPlan["ratings"][number][] = await Promise.all(v.identities.map(async id => ({ handle: await handle(id), mode: v.mode!,
    before: standing(id, v.snapshot.get(`${ratingCollection(v.mode!)}/${id}`)), after: null })));

  // 2. The Sol move. Each moved match's lobby, found by its recording, and the two handles of its move.
  const registry = createWatchRegistry(store);
  const moves = await Promise.all(SOL_MOVES.map(async move => {
    const lobbyId = await registry.findByReplay(move.replayId);
    if (lobbyId === null || (move.lobbyId !== undefined && lobbyId !== move.lobbyId)) refuse(`recording ${move.replayId}: lobby ${lobbyId}`);
    const [from, to] = await Promise.all([identities.findByDisplayName(move.from), identities.findByDisplayName(move.to)]);
    if (!from || !to) refuse(`${move.from} or ${move.to} not found`);
    return { ...move, lobbyId: lobbyId!, fromId: from!.id, toId: to!.id };
  }));
  const all = await houseLobbies(store);
  const moved = all.map(lobby => {
    const move = moves.find(each => each.lobbyId === lobby.id);
    if (!move) return lobby;
    if (!lobby.seats.some(seat => seat.id === move.fromId) || lobby.seats.some(seat => seat.id === move.toId)) refuse(`lobby ${lobby.id} seats do not match its move`);
    return { ...lobby, seats: lobby.seats.map(seat => seat.id === move.fromId ? { ...seat, id: move.toId, displayName: move.to } : seat) };
  });
  const start = Math.min(...moves.map(move => all.find(lobby => lobby.id === move.lobbyId)?.at ?? refuse(`lobby ${move.lobbyId} is not a rated ${MODE} match`)));
  const first = all.findIndex(lobby => lobby.at >= start);
  const window = all.slice(first);
  const players = [...new Set([...window, ...moved.slice(first)].flatMap(lobby => lobby.seats.map(seat => seat.id)))];
  const docs = await store.transaction(async read => ({ writes: [], result: await read([...window.map(lobby => `ratedMatches/${lobby.id}`),
    ...players.map(id => `${ratingCollection(MODE)}/${id}`), ...moves.map(move => `watchMatches/${move.lobbyId}`)]) }));
  const row = (id: string) => docs.get(`${ratingCollection(MODE)}/${id}`) ?? null;
  const stored = new Map(window.map(lobby => {
    let changes: RatingChange[] | null = null;
    try { changes = JSON.parse(docs.get(`ratedMatches/${lobby.id}`)?.changes ?? "null"); } catch { /* refused below */ }
    if (!Array.isArray(changes) || changes.some(change => typeof change.rdBefore !== "number")) refuse(`lobby ${lobby.id}: no Glicko change record`);
    return [lobby.id, changes!] as const;
  }));

  // Each player's state entering the window: as its first stored match in the window found it, else its row.
  const entering = new Map<string, PlayerState>(players.map(id => {
    const mine = window.filter(lobby => teamsOf(lobby).flat().includes(id));
    const state = storedState(id, row(id));
    if (mine.length === 0) return [id, state];
    const change = stored.get(mine[0]!.id)!.find(each => each.identityId === id) ?? refuse(`lobby ${mine[0]!.id}: no change for ${id}`);
    const previous = all.slice(0, first).filter(lobby => teamsOf(lobby).flat().includes(id)).at(-1);
    return [id, { rating: change.before, rd: change.rdBefore!, ratedAt: previous?.at ?? null, ratedMatches: state.ratedMatches - mine.length }];
  }));
  const replay = (lobbies: readonly Lobby[]) => {
    const state = new Map(entering);
    const changes = new Map<string, readonly RatingChange[]>();
    for (const lobby of lobbies.slice(first)) {
      const rated = rateMatch(teamsOf(lobby), lobby.winner, lobby.at, id => state.get(id)!);
      for (const [id, next] of rated.next) state.set(id, next);
      changes.set(lobby.id, rated.changes);
    }
    return { state, changes };
  };
  const records = (lobbies: readonly Lobby[], id: string): RatingRecord => lobbies.filter(lobby => teamsOf(lobby).flat().includes(id))
    .reduce((record, lobby) => withResult(record, letterFor(lobby.winner, teamsOf(lobby)[0].includes(id) ? 0 : 1), lobby.id), EMPTY_RECORD);

  // The replay without the move must reproduce what is stored, or the recompute is not the history it corrects.
  const near = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= SAME;
  const check = replay(all);
  for (const lobby of window) {
    for (const change of check.changes.get(lobby.id)!) {
      const kept = stored.get(lobby.id)!.find(each => each.identityId === change.identityId);
      if (!kept || !near(change.after, kept.after) || !near(change.rdAfter!, kept.rdAfter)) {
        refuse(`stored history not reproduced: ${await handle(change.identityId)} in lobby ${lobby.id}`);
      }
    }
  }
  const movers = moves.flatMap(move => [move.fromId, move.toId]);
  for (const id of players) {
    const [now, replayed] = [storedState(id, row(id)), check.state.get(id)!];
    const record = storedRecord(id, row(id));
    if (!near(replayed.rating, now.rating) || !near(replayed.rd, now.rd) || replayed.ratedAt !== now.ratedAt || replayed.ratedMatches !== now.ratedMatches
      || (movers.includes(id) && JSON.stringify(record) !== JSON.stringify(records(all, id)))) refuse(`stored history not reproduced: ${await handle(id)}`);
  }

  // The move: lobbies' seats, watch-entry labels, changed change records and rating rows.
  const result = replay(moved);
  for (const move of moves) {
    const lobby = moved.find(each => each.id === move.lobbyId)!;
    writes.push({ op: "update", path: `lobbies/${lobby.id}`, fields: { seats: JSON.stringify(lobby.seats) } });
    const labels = JSON.parse(docs.get(`watchMatches/${lobby.id}`)?.modelLabels ?? "{}") as Record<string, string>;
    if (move.from in labels) {
      const { [move.from]: label, ...rest } = labels;
      writes.push({ op: "update", path: `watchMatches/${lobby.id}`, fields: { modelLabels: JSON.stringify({ ...rest, [move.to]: label }) } });
    }
    const before = all.find(each => each.id === lobby.id)!;
    matches.push({ match: move.replayId, before: { status: "rated", seats: before.seats.map(seat => seat.displayName) },
      after: { status: "rated", seats: lobby.seats.map(seat => seat.displayName) } });
  }
  for (const lobby of window) {
    const changes = JSON.stringify(result.changes.get(lobby.id));
    if (changes !== JSON.stringify(stored.get(lobby.id))) writes.push({ op: "update", path: `ratedMatches/${lobby.id}`, fields: { changes } });
  }
  for (const id of players) {
    const [now, next, fields] = [storedState(id, row(id)), result.state.get(id)!, row(id)];
    if (next.rating === now.rating && next.rd === now.rd && next.ratedMatches === now.ratedMatches && !movers.includes(id)) continue;
    if (!fields) refuse(`no ${MODE} row for ${await handle(id)}`);
    const rating = encodeRating(next.rating);
    const after: Fields = { rating, ratedMatches: String(next.ratedMatches), ...glickoFields(next),
      ...(movers.includes(id) ? recordFields(records(moved, id)) : {}), ...(fields!.houseRating !== undefined ? { houseRating: rating } : {}) };
    writes.push({ op: "update", path: `${ratingCollection(MODE)}/${id}`, fields: after });
    ratings.push({ handle: await handle(id), mode: MODE, before: standing(id, fields), after: standing(id, { ...fields!, ...after }) });
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
