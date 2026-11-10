import { addAbortListener } from "node:events";
import { pipeline } from "node:stream/promises";
import { peek } from "../net/relay.js";
import type { MountHandler } from "../server.js";
import { isReplayId } from "./access.js";
import { validHistoryPageToken, type HistoryPage, type HistorySource, type HistorySummary } from "./history-source.js";
import { logUnlistedHouse } from "../rating/unlistedHouse.js";
import type { RankedMode } from "../rating/ratings.js";
import { harnessPhaseAt, type HarnessPhase } from "../rating/harnessPhase.js";
import { recordedMatchType, type RecordingMatchType } from "./recorded-match-type.js";
import { noteField } from "./matchNotes.js";

type LobbySeat = { readonly id: string; readonly displayName: string };
/**
 * The lobby a recording was played in (src/lobby/lobbies.ts Lobby): its kind, agents per colony, ranked mode (null for a
 * player-created lobby), house challenge label where it has one, and seated identities by colony.
 */
export interface RecordingLobby {
  /** The lobby id, which keys a match's public note (src/replays/matchNotes.ts). */
  readonly id?: string;
  readonly kind: "public" | "private";
  readonly size: 1 | 2 | 3 | 4;
  readonly mode: RankedMode | null;
  readonly challenge?: { readonly kind: "house" };
  readonly colonies: readonly [readonly LobbySeat[], readonly LobbySeat[]];
  /** The lobby's match time in milliseconds: startsAt, else createdAt. */
  readonly startsAt?: number | null;
  readonly createdAt?: number;
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
 * The lookup with each replay id's settled answer cached, so the handle fill and the match type share one store read: a
 * recording's lobby never changes, so a found lobby and no lobby are kept. A failed lookup (a throw) and "pending" are not,
 * and are looked up again on a later listing. Concurrent callers share one in-flight lookup.
 */
export function cachedLobbyLookup(lookup: RecordingLobbyLookup): RecordingLobbyLookup {
  const cache = new Map<string, Promise<RecordingLobby | null | "pending">>();
  return replayId => {
    const hit = cache.get(replayId);
    if (hit) return hit;
    const forget = () => { if (cache.get(replayId) === work) cache.delete(replayId); };
    const work = lookup(replayId).then(lobby => { if (lobby === "pending") forget(); return lobby; });
    cache.set(replayId, work);
    work.catch(forget);
    return work;
  };
}

export type { RecordingMatchKind, RecordingMatchType } from "./recorded-match-type.js";
/** harnessPhase is present only on a Model Index row (src/rating/harnessPhase.ts); note only on a row whose lobby has a
 * public note (src/replays/matchNotes.ts). */
export type TypedHistorySummary = HistorySummary & { readonly matchType: RecordingMatchType | null; readonly harnessPhase?: HarnessPhase;
  readonly note?: string };

/**
 * A recording's match type, from its lobby where one was read (undefined: pending or failed this listing; null: it has
 * none). Lobby: a house-* mode is the Antwars Model Index, any other mode the ranked queue, a modeless lobby a house
 * challenge or else a player-made (unranked) lobby. Without a lobby, the record's own facts (recordedMatchType), the
 * same rule a replay applies to its opening snapshot.
 */
export function recordingMatchType(row: Pick<HistorySummary, "seats" | "rated" | "modelIndex">,
  lobby: RecordingLobby | null | undefined): RecordingMatchType | null {
  if (lobby) {
    const kind = lobby.mode !== null ? (lobby.mode.startsWith("house-") ? "index" : "ranked")
      : lobby.challenge?.kind === "house" ? "challenge" : "unranked";
    return { kind, size: lobby.size };
  }
  return recordedMatchType(row);
}

/**
 * Each listed row with its match type (recordingMatchType), and a Model Index row with its harness phase by match time
 * (recordingMatchTime), and a row whose lobby has a public note with that note. A pending or failed lookup types the row from its record for
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
    const typed = matchType?.kind === "index" ? { ...row, matchType, harnessPhase: harnessPhaseAt(recordingMatchTime(row, lobby)) } : { ...row, matchType };
    return { ...typed, ...noteField(lobby?.id) };
  })) });
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
  const cached = lobbies === undefined ? undefined : cachedLobbyLookup(lobbies);
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
        const page = handles === undefined ? typed : await handles(typed);
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
          res.writeHead(200, { "content-type": "application/json", "cache-control": complete ? IMMUTABLE : SHORT });
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
