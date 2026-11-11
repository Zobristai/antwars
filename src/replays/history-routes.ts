import { addAbortListener } from "node:events";
import { pipeline } from "node:stream/promises";
import { peek } from "../net/relay.js";
import type { MountHandler } from "../server.js";
import { isReplayId } from "./access.js";
import { validHistoryPageToken, type HistoryPage, type HistorySource, type HistorySummary } from "./history-source.js";
import { logUnlistedHouse } from "../rating/unlistedHouse.js";
import { NATURAL_OUTCOMES, type RankedMode } from "../rating/ratings.js";
import type { MatchOutcome } from "../lobby/lobbies.js";
import { harnessPhaseAt, type HarnessPhase } from "../rating/harnessPhase.js";
import { lobbyMatchType, recordedMatchType, type RecordingMatchType } from "./recorded-match-type.js";
import { CORRECTED_REPLAY_IDS } from "./correctedRecordings.js";

type LobbySeat = { readonly id: string; readonly displayName: string };
/**
 * The lobby a recording was played in (src/lobby/lobbies.ts Lobby): its kind, agents per colony, ranked mode (null for a
 * player-created lobby), house challenge label where it has one, seated identities by colony, and how its match ended.
 */
export interface RecordingLobby {
  readonly kind: "public" | "private";
  readonly size: 1 | 2 | 3 | 4;
  readonly mode: RankedMode | null;
  readonly challenge?: { readonly kind: "house" };
  readonly colonies: readonly [readonly LobbySeat[], readonly LobbySeat[]];
  /** The lobby's match time in milliseconds: startsAt, else createdAt. */
  readonly startsAt?: number | null;
  readonly createdAt?: number;
  /** How its match ended once its slot was released; null or absent before then. */
  readonly outcome?: MatchOutcome | null;
}
/**
 * Replay id -> the lobby that recording came from; null when it has none (a scheduled match); "pending" when its lobby
 * match is registered but the replay link has not published yet. A throw is a failed lookup.
 */
export type RecordingLobbyLookup = (replayId: string) => Promise<RecordingLobby | null | "pending">;
type ColonyHandles = readonly [string | null, string | null];

/**
 * Older history rows carry no seat handle (rows record it from now on). For a row with a seat lacking one, take each
 * colony's handle from the public lobby the recording came from when that colony's seats hold one identity: one distinct
 * stored seat id, however many seats (a queue-made 4v4 can seat one identity four times). A colony with two or more
 * identities stays null. Recorded handles win, and a fully recorded row does no lookup. Display only: nothing stored is
 * rewritten. A recording's lobby and seats never change, so each replay id's answer is cached: a found lobby, and no
 * lobby. Two answers are not cached and are looked up again on a later listing: a failed lookup, and "pending".
 * A slot publishes a match's registration (at its start) and then its replay link (once saved) through one in-order
 * retry queue (src/live/watch-controller.ts publish), so a record listed before its link lands reads "pending".
 * Accepted residual: a lobby recording listed while its match registration itself has not yet published (the slot's
 * store failing since that match began) reads as no lobby and stays unfilled on this server until it restarts.
 */
export function lobbySeatHandles(lookup: RecordingLobbyLookup): (page: HistoryPage) => Promise<HistoryPage> {
  const cache = new Map<string, Promise<ColonyHandles | null>>();
  function colonyHandles(replayId: string): Promise<ColonyHandles | null> {
    const hit = cache.get(replayId);
    if (hit) return hit;
    const one = (seats: readonly LobbySeat[]) => new Set(seats.map(seat => seat.id)).size === 1 ? seats[0]!.displayName : null;
    const forget = () => { if (cache.get(replayId) === work) cache.delete(replayId); };
    const work = lookup(replayId).then((lobby): ColonyHandles | null => {
      if (lobby === "pending") { forget(); return null; }
      return lobby === null || lobby.kind !== "public" ? null : [one(lobby.colonies[0]), one(lobby.colonies[1])];
    });
    cache.set(replayId, work);
    work.catch(forget);
    return work;
  }
  async function fill(row: HistorySummary): Promise<HistorySummary> {
    if (row.seats.every(seat => seat.handle !== null)) return row;
    let handles: ColonyHandles | null;
    try { handles = await colonyHandles(row.id); } catch { return row; }
    if (handles === null) return row;
    return { ...row, seats: row.seats.map(seat => seat.handle !== null ? seat : { ...seat, handle: handles[seat.colony] }) };
  }
  return async page => ({ ...page, matches: await Promise.all(page.matches.map(fill)) });
}

/**
 * How long an answer that can still change is kept before it is looked up again: no lobby, and a lobby whose match has no
 * recorded outcome yet. A slot publishes a match's registration and replay link through a retrying queue, and records its
 * outcome when it releases the slot, so a recording can be listed before either has landed. Kept for good, such an answer
 * would hold the row's handles, type and rated flag (recordingRated) at the record's own until the server restarts.
 */
export const UNSETTLED_LOBBY_MS = 60_000;

export interface CachedLobbyLookupOptions {
  /** How long an answer that can still change is kept (UNSETTLED_LOBBY_MS); 0 keeps none. */
  readonly unsettledMs?: number;
  readonly now?: () => number;
}

/**
 * The lookup with each replay id's answer cached, so the handle fill and the match type share one store read. A found lobby
 * with its match's outcome is final and kept. No lobby (a scheduled match, or a lobby match whose registration has not yet
 * published) and a lobby with no outcome yet are kept for unsettledMs, then looked up again on a later listing. A failed
 * lookup (a throw) and "pending" are not kept. Concurrent callers share one in-flight lookup.
 */
export function cachedLobbyLookup(lookup: RecordingLobbyLookup, options: CachedLobbyLookupOptions = {}): RecordingLobbyLookup {
  const unsettledMs = options.unsettledMs ?? UNSETTLED_LOBBY_MS, now = options.now ?? Date.now;
  const cache = new Map<string, { readonly work: Promise<RecordingLobby | null | "pending">; until: number }>();
  return replayId => {
    const hit = cache.get(replayId);
    if (hit && hit.until > now()) return hit.work;
    const forget = () => { if (cache.get(replayId) === entry) cache.delete(replayId); };
    const work = lookup(replayId).then(lobby => {
      if (lobby === "pending") forget();
      else if (lobby === null || lobby.outcome == null) entry.until = now() + unsettledMs;
      return lobby;
    });
    // In flight: shared until it settles, whatever its answer.
    const entry = { work, until: Infinity };
    cache.set(replayId, entry);
    work.catch(forget);
    return work;
  };
}

export type { RecordingMatchKind, RecordingMatchType } from "./recorded-match-type.js";
/** harnessPhase is present only on a Model Index row (src/rating/harnessPhase.ts). */
export type TypedHistorySummary = HistorySummary & { readonly matchType: RecordingMatchType | null; readonly harnessPhase?: HarnessPhase };

/**
 * A recording's match type, from its lobby where one was read (undefined: pending or failed this listing; null: it has
 * none). Lobby: a house-* mode is the Antwars Model Index, any other mode the ranked queue, a modeless lobby a house
 * challenge or else a player-made (unranked) lobby. Without a lobby, the record's own facts (recordedMatchType), the
 * same rule a replay applies to its opening snapshot.
 */
export function recordingMatchType(row: Pick<HistorySummary, "seats" | "rated" | "modelIndex">,
  lobby: RecordingLobby | null | undefined): RecordingMatchType | null {
  if (lobby) return lobbyMatchType(lobby);
  return recordedMatchType(row);
}

/**
 * Each listed row with its match type (recordingMatchType), its rated flag as its lobby's outcome decides (recordingRated),
 * and a Model Index row with its harness phase by match time (recordingMatchTime). A pending or failed lookup types the row from its record for
 * this listing only; the lookup is not cached as no lobby (cachedLobbyLookup), so the next listing reads it again.
 */
export function recordingMatchTypes(lookup: RecordingLobbyLookup | undefined): (page: HistoryPage) => Promise<Omit<HistoryPage, "matches"> & { matches: TypedHistorySummary[] }> {
  async function lobbyOf(replayId: string): Promise<RecordingLobby | null | undefined> {
    if (lookup === undefined) return null;
    try { const lobby = await lookup(replayId); return lobby === "pending" ? undefined : lobby; } catch { return undefined; }
  }
  return async page => ({ ...page, matches: await Promise.all(page.matches.map(async row => {
    const lobby = await lobbyOf(row.id);
    const matchType = recordingMatchType(row, lobby);
    const rated = recordingRated(row, lobby);
    const listed = rated === row.rated ? row : { ...row, rated };
    return matchType?.kind === "index" ? { ...listed, matchType, harnessPhase: harnessPhaseAt(recordingMatchTime(row, lobby)) } : { ...listed, matchType };
  })) });
}

/**
 * Whether a recording lists as rated: its record's flag, except that a lobby whose match ended with an outcome the rating
 * table does not rate (src/rating/ratings.ts NATURAL_OUTCOMES: a stopped, abandoned or unplayed match) lists unrated, so the
 * Recordings list counts the same rated matches as the leaderboard. Only ever clears the flag; a row with no lobby read, or
 * a lobby with no recorded outcome, keeps its record's flag. Display only: nothing stored is rewritten.
 */
export function recordingRated(row: Pick<HistorySummary, "rated">, lobby: RecordingLobby | null | undefined): HistorySummary["rated"] {
  const outcome = lobby?.outcome;
  return row.rated === true && outcome != null && !Object.hasOwn(NATURAL_OUTCOMES, outcome) ? false : row.rated;
}

/** A recording's match time: its lobby's startsAt, else createdAt, where the lobby was read; else the recorded start. */
export function recordingMatchTime(row: Pick<HistorySummary, "startedAt">, lobby: RecordingLobby | null | undefined): number | null {
  const at = lobby ? lobby.startsAt ?? lobby.createdAt : undefined;
  if (typeof at === "number" && Number.isFinite(at)) return at;
  const started = Date.parse(row.startedAt);
  return Number.isFinite(started) ? started : null;
}

/**
 * The opening bytes every complete record has: the record writer serializes the MatchRecord that unavailableRecord
 * (src/replays/history.ts) builds, whose first keys are format, version, id, source and status, and a complete record
 * is the match-log source (src/records/record-store.ts recordStatus). A complete record is never replaced, so only it
 * may be cached as immutable; an unavailable record is replaced by its complete one, and a partial one is not final.
 */
function completePrefix(id: string): Buffer {
  return Buffer.from(`{"format":"antwar.match","version":1,"id":${JSON.stringify(id)},"source":"match-log","status":"complete",`);
}
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Unavailable, partial or unrecognised: a misread only loses caching, never holds a replaced record. */
const SHORT = "public, max-age=60";

/** The whole-request bound on one listing page. */
const LIST_DEADLINE_MS = 60_000;
/**
 * The no-progress bound on one record download: the upstream record read's idle timeout (history-source.ts
 * openWithToken), which is also /replays/<id>'s (access.ts).
 */
const RECORD_IDLE_MS = 30_000;

export interface HistoryRouteOptions {
  /** Longest a record download may go without handing the client a chunk; past it the download is dropped. */
  readonly recordIdleMs?: number;
  /** How long a lobby answer that can still change is kept (cachedLobbyLookup); defaults to UNSETTLED_LOBBY_MS. */
  readonly unsettledLobbyMs?: number;
}

/**
 * Anonymous, read-only history backed by storage rather than this process.
 * GET /matches?pageToken=<URL-encoded nextPageToken> -> {matches,nextPageToken}.
 * Follow continuations even after an empty page. GET /matches/<id> -> full JSON.
 * These paths are independent of /live/* and /replays/*.
 * A listing page is bounded as a whole (60 s). A record download has no total-time bound, so a slow but steady
 * client always gets the complete record; it is dropped only after 30 s in which no chunk was handed to the
 * response (a stalled client stops taking chunks under backpressure).
 */
export function historyRoutes(source: HistorySource, lobbies?: RecordingLobbyLookup,
  options: HistoryRouteOptions = {}): MountHandler {
  const recordIdleMs = options.recordIdleMs ?? RECORD_IDLE_MS;
  const cached = lobbies === undefined ? undefined : cachedLobbyLookup(lobbies, { unsettledMs: options.unsettledLobbyMs });
  const handles = cached === undefined ? undefined : lobbySeatHandles(cached);
  const types = recordingMatchTypes(cached);
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const list = url.pathname === "/matches";
    const id = url.pathname.startsWith("/matches/") ? url.pathname.slice("/matches/".length) : "";
    if (!list && !isReplayId(id)) { res.writeHead(404).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    const token = url.searchParams.get("pageToken") ?? undefined;
    if ((!list && url.search.length > 0) || [...url.searchParams.keys()].some(key => key !== "pageToken") ||
        url.searchParams.getAll("pageToken").length > 1 || (token !== undefined && !validHistoryPageToken(token))) {
      res.writeHead(400).end(); return;
    }
    const abort = new AbortController();
    // A listing is bounded as a whole as well as each upstream read: a progressing
    // page must not accumulate twenty independent network/worker deadlines.
    // A record download is bounded only by no progress: refreshed on each step below.
    const deadline = setTimeout(() => abort.abort(), list ? LIST_DEADLINE_MS : recordIdleMs);
    deadline.unref();
    const cancel = () => abort.abort();
    res.once("close", cancel);
    try {
      if (list) {
        const listed = await source.list(token, abort.signal);
        const typed = await types(listed);
        const filled = handles === undefined ? typed : await handles(typed);
        // Last, so a source's correction (correctedRecordings.ts) sees the handles the lobby filled in.
        const page = source.listed === undefined ? filled : { ...filled, matches: await source.listed(filled.matches) };
        if (res.destroyed) return;
        // Recordings show an unlisted house seat handle as "Unlisted model"; the server logs it.
        logUnlistedHouse("recordings", page.matches.flatMap(row => row.seats.map(seat => seat.handle)));
        const body = Buffer.from(JSON.stringify(page));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) });
        res.end(req.method === "HEAD" ? undefined : body);
      } else {
        const body = await source.open(id, abort.signal);
        deadline.refresh();
        if (res.destroyed) { body?.destroy(); return; }
        if (body === null) { res.writeHead(404, { "cache-control": "no-store" }).end(); return; }
        // The deadline and a client disconnect also end the wait for the record's opening bytes.
        const cancellation = addAbortListener(abort.signal, () => body.destroy());
        try {
          const prefix = completePrefix(id);
          const { head, rest } = await peek(body, prefix.length);
          deadline.refresh();
          if (res.destroyed) return;
          const start = Buffer.concat(head);
          const complete = start.subarray(0, prefix.length).equals(prefix);
          // A record a rating correction may change (correctedRecordings.ts) is never cached as immutable.
          res.writeHead(200, { "content-type": "application/json", "cache-control": complete && !CORRECTED_REPLAY_IDS.has(id) ? IMMUTABLE : SHORT });
          if (req.method === "HEAD") { res.end(); return; }
          res.write(start);
          // Each chunk the response takes is progress; under backpressure a stalled client takes none.
          await pipeline(rest, async function* (chunks: AsyncIterable<Uint8Array | string>) {
            for await (const chunk of chunks) { deadline.refresh(); yield chunk; }
          }, res, { signal: abort.signal });
        } finally { cancellation[Symbol.dispose](); body.destroy(); }
      }
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const body = Buffer.from(JSON.stringify({ error: "Match history temporarily unavailable. Please try again." }));
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) });
      res.end(req.method === "HEAD" ? undefined : body);
    } finally { clearTimeout(deadline); res.off("close", cancel); }
  };
}
