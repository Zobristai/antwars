// The Matches page's data: the live catalog, saved recordings, with no invented rows.
import { z } from "zod";
// A seated player: the stream's seat name, and the rating, RD and rated-match count in the match's ranked mode,
// all three null for an unrated match.
// The model label a seat self-reported when it joined; null before it joins or where it reported none, absent from a
// server that sends none.
const seatLabel = z.string().nullable().optional();
const liveSeat = z.union([
  z.object({ displayName: z.string().min(1), modelLabel: seatLabel, rating: z.number().finite(), rd: z.number().finite(), ratedMatches: z.number().int().nonnegative() }),
  z.object({ displayName: z.string().min(1), modelLabel: seatLabel, rating: z.null(), rd: z.null(), ratedMatches: z.null() }),
]);
// What kind of match a row is and agents per colony, as GET /matches and GET /watch/catalog both type it
// (src/replays/recorded-match-type.ts); null where the server could not tell, absent from a server that sends none. A value
// this page does not know reads null rather than failing the page: the badge is display only.
const matchType = z.object({
  kind: z.enum(["index", "ranked", "unranked", "challenge", "unrated"]),
  size: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]),
}).nullable().optional().catch(null);
const liveRow = z.object({
  lobbyId: z.string().min(1), startedAt: z.number().finite(), rated: z.boolean(), delaySeconds: z.union([z.literal(0), z.literal(60), z.literal(300)]),
  colonies: z.tuple([z.array(liveSeat), z.array(liveSeat)]),
  matchType,
});
// A rating as a list row shows it: the figure, its RD and rated-match count. A malformed one reads null (no badge).
const shownRating = z.object({ rating: z.number().finite(), rd: z.number().finite(), ratedMatches: z.number().int().nonnegative() })
  .nullable().optional().catch(null);
export type LiveSeat = z.infer<typeof liveSeat>;
export type ShownRating = NonNullable<z.infer<typeof shownRating>>;
const recordingRow = z.object({
  id: z.string().min(1), startedAt: z.string(), endedAt: z.string().nullable(), simulationEndedAt: z.string().nullable(),
  winner: z.union([z.literal(0), z.literal(1), z.null()]), reason: z.string().nullable(), decidedBy: z.string().nullable(),
  // Each seat's self-reported thinking level and service tier, and its seated identity's owner/handle, as recorded; a row
  // from before any of them was recorded reads null.
  seats: z.array(z.object({ seat: z.number().int().nonnegative(), colony: z.union([z.literal(0), z.literal(1)]), modelLabel: z.string().nullable(),
    thinkingLevel: z.string().nullable().optional().transform(value => value ?? null),
    serviceTier: z.string().nullable().optional().transform(value => value ?? null),
    handle: z.string().nullable().optional().transform(value => value ?? null),
    // The seat's rating as of the match's start, stored on records made from this build on; null on older records.
    startRating: shownRating })),
  status: z.enum(["complete", "partial", "unavailable"]), unavailable: z.array(z.string()),
  matchType,
});
const historyPage = z.object({ matches: z.array(recordingRow), nextPageToken: z.string().min(1).max(2048).nullable() });
// An agent waiting in a ranked queue (GET /watch/queue): its public name, the queue's mode, whole seconds waited
// when the server read it, when its wait began (epoch ms; a server that sends none leaves the page to work it out from the
// seconds waited) and its rating in that mode (null where it shows none).
const waitingRow = z.object({
  displayName: z.string().min(1),
  mode: z.enum(["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"]),
  waitingSeconds: z.number().int().nonnegative(),
  since: z.number().finite().optional(),
  rating: shownRating,
});
// A public lobby whose match has not begun (GET /watch/queue lobbies): a queue pairing's mode, or null for a
// player-created lobby, agents per colony, seats taken, each colony's seated names and their ratings, whole seconds since
// it was made and when that was (epoch ms).
const waitingLobby = z.object({
  mode: waitingRow.shape.mode.nullable(),
  size: z.number().int().min(1).max(4),
  seated: z.number().int().nonnegative(),
  colonies: z.tuple([z.array(z.string().min(1)), z.array(z.string().min(1))]),
  // Each seated name's rating, in the order of colonies; absent from a server that sends none.
  ratings: z.tuple([z.array(shownRating), z.array(shownRating)]).optional().catch(undefined),
  waitingSeconds: z.number().int().nonnegative(),
  since: z.number().finite().optional(),
  // Present only on an unrated house challenge, which the Waiting card labels.
  challenge: z.literal("house").optional(),
});
export type LiveMatch = z.infer<typeof liveRow>;
export type Recording = z.infer<typeof recordingRow>;
/** When a wait began is always known on the page: sent, or worked out from the seconds waited at the read. */
export type WaitingAgent = z.infer<typeof waitingRow> & { readonly since: number };
export type WaitingLobby = z.infer<typeof waitingLobby> & { readonly since: number };
/** A Waiting card row: an agent in a ranked queue, or a public lobby or queue pairing not yet begun. */
export type WaitingRow = WaitingAgent | WaitingLobby;
export type Collection<T> =
  | { readonly status: "loading"; readonly rows: readonly T[] }
  | { readonly status: "ready"; readonly rows: readonly T[] }
  | { readonly status: "error"; readonly rows: readonly T[] };
export interface MatchesView {
  /** The agents waiting in the ranked queues, then the public lobbies and queue pairings not yet begun;
   * read only where createMatchesData is given waiting: true. */
  readonly waiting: Collection<WaitingRow>;
  readonly live: Collection<LiveMatch>;
  readonly recordings: Collection<Recording>;
  /** null only means complete when recordings.status is ready. Empty pages may still have a token. */
  readonly next: string | null;
}
export interface MatchesDataOptions {
  /** Read GET /watch/queue on each refresh: the Matches page's Waiting card. Off by default, so other pages sharing this
   * data (the landing page) make no queue request. */
  readonly waiting?: boolean;
}
export function createMatchesData(request: typeof fetch, publish: (view: MatchesView) => void, options: MatchesDataOptions = {}) {
  let view: MatchesView = { waiting: { status: "loading", rows: [] }, live: { status: "loading", rows: [] }, recordings: { status: "loading", rows: [] }, next: null };
  const abort = new AbortController();
  let historyBusy = false, overviewBusy = false, refreshBusy = false, waitingBusy = false;
  const seen = new Set<string>();
  const emit = () => { if (!abort.signal.aborted) publish(view); };
  const json = async (path: string) => {
    const response = await request(path, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw new Error("Matches unavailable");
    return response.json() as Promise<unknown>;
  };
  async function history(reset: boolean) {
    if (historyBusy || abort.signal.aborted || (!reset && view.next === null)) return;
    historyBusy = true;
    const token = reset ? null : view.next;
    view = { ...view, recordings: { status: "loading", rows: view.recordings.rows } }; emit();
    try {
      const page = historyPage.parse(await json(`/matches${token ? `?pageToken=${encodeURIComponent(token)}` : ""}`));
      if (abort.signal.aborted) return;
      if (reset) seen.clear();
      if (page.nextPageToken !== null && (page.nextPageToken === token || seen.has(page.nextPageToken))) throw new Error("Repeated continuation");
      if (token) seen.add(token);
      const rows = new Map((reset ? [] : view.recordings.rows).map(row => [row.id, row]));
      for (const row of page.matches) rows.set(row.id, row);
      view = { ...view, recordings: { status: "ready", rows: [...rows.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) }, next: page.nextPageToken };
    } catch { view = { ...view, recordings: { status: "error", rows: view.recordings.rows } }; }
    finally { historyBusy = false; emit(); }
  }
  async function overview() {
    if (overviewBusy || abort.signal.aborted) return;
    overviewBusy = true;
    view = { ...view, live: { status: "loading", rows: view.live.rows } }; emit();
    try { const data = z.object({ matches: z.array(liveRow) }).parse(await json("/watch/catalog")); view = { ...view, live: { status: "ready", rows: data.matches } }; }
    catch { view = { ...view, live: { status: "error", rows: view.live.rows } }; }
    emit();
    overviewBusy = false;
  }
  async function waiting() {
    if (waitingBusy || abort.signal.aborted) return;
    waitingBusy = true;
    view = { ...view, waiting: { status: "loading", rows: view.waiting.rows } }; emit();
    try {
      const data = z.object({ waiting: z.array(waitingRow), lobbies: z.array(waitingLobby).optional() }).parse(await json("/watch/queue"));
      const at = Date.now();
      const timed = <T extends { readonly waitingSeconds: number; readonly since?: number }>(row: T) => ({ ...row, since: row.since ?? at - row.waitingSeconds * 1000 });
      view = { ...view, waiting: { status: "ready", rows: [...data.waiting.map(timed), ...(data.lobbies ?? []).map(timed)] } };
    }
    catch { view = { ...view, waiting: { status: "error", rows: view.waiting.rows } }; }
    emit();
    waitingBusy = false;
  }
  async function refresh() {
    if (refreshBusy || historyBusy || abort.signal.aborted) return;
    refreshBusy = true;
    // The queue read runs beside the refresh, never inside its lock: a slow /watch/queue never holds Live now or
    // Recordings' next Refresh. It serializes itself (waitingBusy).
    if (options.waiting) void waiting();
    try {
      await Promise.all([overview(), history(true)]);
    } finally { refreshBusy = false; }
  }
  return {
    get view() { return view; },
    refresh() { void refresh(); },
    // history() serializes itself; refresh() starts its reset synchronously, so a pending catalog read must not drop this click.
    more() { void history(false); },
    destroy() { abort.abort(); },
  };
}
