import { agreedHandles, attributeRoster, type CurrentRosterSeats } from "./roster-ownership.js";
import { isValidId } from "../rating/ratings.js";
import { joinReads } from "../store/join-reads.js";
import { needsUsersCheck, snapshotContributions, usersRevision } from "./users-snapshot.js";
import { neverJoined } from "./listed-colonies.js";
import { publicUsers, type UserMatch } from "./public-users.js";
import type { Ratings } from "../rating/ratings.js";
import { publiclyVisible, type PublicVisibility } from "../identity/publicVisibility.js";
import { setTimeout as sleep } from "node:timers/promises";
import { addAbortListener } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { peek } from "../net/relay.js";
import type { MountHandler } from "../server.js";
import { isReplayId } from "./access.js";
import { validHistoryPageToken, type HistoryPage, type HistorySource, type HistorySummary } from "./history-source.js";
import { logUnlistedHouse } from "../rating/unlistedHouse.js";
import type { MatchOutcome } from "../lobby/lobbies.js";
import type { QueueMode } from "../lobby/queue.js";
import { harnessPhaseAt, type HarnessPhase } from "../rating/harnessPhase.js";
import { isHouseHandle, lobbyMatchType, recordedMatchType, type RecordingMatchType } from "./recorded-match-type.js";
import { CORRECTED_REPLAY_IDS } from "./correctedRecordings.js";
import type { TestRecordings } from "./test-recordings.js";
import { sharedRead, shippedTopMatchList } from "./top-matches.js";

type LobbySeat = { readonly id: string; readonly displayName: string };
/**
 * The lobby a recording was played in (src/lobby/lobbies.ts Lobby): its kind, agents per colony, queue mode (a ranked mode
 * or quadrants; null for a player-created lobby), house challenge label where it has one, seated identities by colony (two
 * colonies, or four in a quadrants lobby), and how its match ended.
 */
export interface RecordingLobby {
  readonly kind: "public" | "private";
  readonly size: 1 | 2 | 3 | 4;
  readonly mode: QueueMode | null;
  readonly challenge?: { readonly kind: "house" };
  readonly colonies: readonly (readonly LobbySeat[])[];
  /** The lobby's match time in milliseconds: startsAt, else createdAt. */
  readonly startsAt?: number | null;
  readonly createdAt?: number;
  /** How its match ended once its slot was released; null or absent before then. */
  readonly outcome?: MatchOutcome | null;
  /** The lobby's rated flag; an ended match its rating step refused is left rated false (src/lobby/lobbies.ts endMatch). */
  readonly rated?: boolean | null;
  /** Present, true, only on a test lobby (src/lobby/lobbies.ts Lobby.test): its recording is never listed. */
  readonly test?: true;
}
/**
 * Replay id -> the lobby that recording came from; null when it has none (a scheduled match); "pending" when its lobby
 * match is registered but the replay link has not published yet. A throw is a failed lookup.
 */
export type RecordingLobbyLookup = (replayId: string, signal?: AbortSignal) => Promise<RecordingLobby | null | "pending">;
/** One handle (or null) per colony, by colony. */
type ColonyHandles = readonly (string | null)[];

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
export function lobbySeatHandles(lookup: RecordingLobbyLookup): <Row extends HistorySummary>(page: Omit<HistoryPage, "matches"> & { matches: Row[] }) =>
  Promise<Omit<HistoryPage, "matches"> & { matches: Row[] }> {
  const cache = new Map<string, Promise<ColonyHandles | null>>();
  function colonyHandles(replayId: string): Promise<ColonyHandles | null> {
    const hit = cache.get(replayId);
    if (hit) return hit;
    const one = (seats: readonly LobbySeat[]) => new Set(seats.map(seat => seat.id)).size === 1 ? seats[0]!.displayName : null;
    const forget = () => { if (cache.get(replayId) === work) cache.delete(replayId); };
    const work = lookup(replayId).then((lobby): ColonyHandles | null => {
      if (lobby === "pending") { forget(); return null; }
      return lobby === null || lobby.kind !== "public" ? null : lobby.colonies.map(one);
    });
    cache.set(replayId, work);
    work.catch(forget);
    return work;
  }
  async function fill<Row extends HistorySummary>(row: Row): Promise<Row> {
    if (row.seats.every(seat => seat.handle !== null)) return row;
    let handles: ColonyHandles | null;
    try { handles = await colonyHandles(row.id); } catch { return row; }
    if (handles === null) return row;
    return { ...row, seats: row.seats.map(seat => seat.handle !== null ? seat : { ...seat, handle: handles[seat.colony] ?? null }) };
  }
  return async page => ({ ...page, matches: await joinReads(page.matches.map(row => fill(row))) });
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
type ServedPage = Omit<HistoryPage, "matches"> & { matches: TypedHistorySummary[] };

/**
 * A recording's match type, from its lobby where one was read (undefined: pending or failed this listing; null: it has
 * none). Lobby: the quadrants mode is Quadrants, a house-* mode the Antwars Model Index, any other mode the ranked queue,
 * a modeless lobby a house challenge or else a player-made (unranked) lobby. Without a lobby, the record's own facts
 * (recordedMatchType), the same rule a replay applies to its opening snapshot.
 */
export function recordingMatchType(row: Pick<HistorySummary, "seats" | "rated" | "modelIndex" | "colonyNames">,
  lobby: RecordingLobby | null | undefined): RecordingMatchType | null {
  if (lobby) return lobbyMatchType(lobby);
  return recordedMatchType(row);
}

/**
 * Each listed row with its match type (recordingMatchType), its rated flag as its lobby's outcome decides (recordingRated),
 * and a Model Index row with its harness phase by match time (recordingMatchTime). A pending or failed lookup types the row from its record for
 * this listing only; the lookup is not cached as no lobby (cachedLobbyLookup), so the next listing reads it again. A failed
 * lookup is logged.
 */
export function recordingMatchTypes(lookup: RecordingLobbyLookup | undefined,
  log: (message: string, detail: object) => void = console.warn, signal?: AbortSignal): (page: HistoryPage) => Promise<Omit<HistoryPage, "matches"> & { matches: TypedHistorySummary[] }> {
  async function lobbyOf(replayId: string): Promise<RecordingLobby | null | undefined> {
    if (lookup === undefined) return null;
    try { const lobby = await lookup(replayId); return lobby === "pending" ? undefined : lobby; } catch (error) {
      signal?.throwIfAborted();
      // The row is typed from its record for this listing (a challenge then lists only once a later lookup succeeds).
      log("antwar recording lobby lookup failed", { replayId, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
  return async page => ({ ...page, matches: await joinReads(page.matches.map(async row => {
    const lobby = await lobbyOf(row.id);
    const matchType = recordingMatchType(row, lobby);
    const rated = recordingRated(row, lobby);
    const listed = rated === row.rated ? row : { ...row, rated };
    return matchType?.kind === "index" ? { ...listed, matchType, harnessPhase: harnessPhaseAt(recordingMatchTime(row, lobby)) } : { ...listed, matchType };
  })) });
}

/**
/** A match result a rating step rates: a draw or a colony's win, of two colonies or a Free-for-all's four (src/lobby/lobbies.ts endMatch). */
const RATED_RESULT = /^(?:draw|colony_[0-3]_won)$/;

/**
 * Whether a recording lists as rated: its record's flag, except that a lobby whose match ended with no result a rating
 * step rates (a stopped, abandoned or unplayed match), or whose match ended with the lobby left unrated (a Free-for-all
 * result its rating step refused), lists unrated, so the Recordings list counts the same rated matches as the ratings.
 * Only ever clears the flag; a row with no lobby read, or a lobby with no recorded outcome, keeps its record's flag.
 * Display only: nothing stored is rewritten.
 */
export function recordingRated(row: Pick<HistorySummary, "rated">, lobby: RecordingLobby | null | undefined): HistorySummary["rated"] {
  const outcome = lobby?.outcome;
  if (row.rated !== true || outcome == null) return row.rated;
  return !RATED_RESULT.test(outcome) || lobby?.rated === false ? false : row.rated;
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
  readonly currentRosterSeats?: CurrentRosterSeats;
  readonly lobbyById?: RecordingLobbyLookup;
  readonly ratings?: Pick<Ratings, "leaderboard">;
  readonly usersDeadlineMs?: number;
  readonly usersNow?: () => number;
  readonly usersPolicy?: () => { digest: string; visibility?: PublicVisibility };
  readonly publicVisibility?: PublicVisibility;
  /** Longest a record download may go without handing the client a chunk; past it the download is dropped. */
  readonly recordIdleMs?: number;
  /** How long a lobby answer that can still change is kept (cachedLobbyLookup); defaults to UNSETTLED_LOBBY_MS. */
  readonly unsettledLobbyMs?: number;
  /** The recording-level test markers (test-recordings.ts); a marked recording is never listed. */
  readonly testRecordings?: TestRecordings;
  /** The top matches list (top-matches.ts topMatchIds); defaults to the list shipped with the build. */
  readonly topMatches?: { readonly ids: readonly string[]; readonly leftOff: readonly string[] };
}

/** Rows on one public listing page: a full storage page (history-source.ts list). */
const PAGE_ROWS = 20;
/**
 * The most storage pages one listing request reads. Each storage page holds at most PAGE_ROWS rows and each row is looked up
 * once (the type and the handle fill share cachedLobbyLookup), so one request does at most MAX_LISTING_STORAGE_PAGES *
 * PAGE_ROWS lobby lookups and hide-list reads. A request that reaches the cap returns the rows it has, short, with a
 * continuation that resumes after the last row it read.
 */
export const MAX_LISTING_STORAGE_PAGES = 5;
/** The prefix of a continuation sealed by this process (listingContinuations). */
const SEALED_PREFIX = "sealed-v1:";

/** An unreadable sealed continuation: refused as a bad request, never retried as unavailable. */
class InvalidContinuation extends Error {}

/**
 * Continuations that point past a row a listing leaves out (one the hide list hides), sealed with a key of this process so
 * the caller can neither read nor forge one and the left-out row's id is never in list data. A restart voids them: such a
 * continuation is refused (400) and the list is loaded again from its first page.
 */
function listingContinuations() {
  const key = randomBytes(32), aad = Buffer.from("antwar public listing continuation v1");
  return {
    seal(storageToken: string): string {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(storageToken, "utf8"), cipher.final()]);
      return `${SEALED_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
    },
    /** The storage continuation a listing token stands for: a sealed one opened, any other passed to storage as it is. */
    open(token: string | undefined): string | undefined {
      if (token === undefined || !token.startsWith(SEALED_PREFIX)) return token;
      try {
        const encoded = token.slice(SEALED_PREFIX.length), raw = Buffer.from(encoded, "base64url");
        if (raw.length < 29 || raw.toString("base64url") !== encoded) throw new InvalidContinuation();
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      } catch { throw new InvalidContinuation(); }
    },
  };
}
type ListingContinuations = ReturnType<typeof listingContinuations>;

/** Work the request stops waiting for when it ends: shared lookups run on for other callers, but this request no longer waits. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const listener = addAbortListener(signal, () => reject(signal.reason));
    work.then(value => { listener[Symbol.dispose](); resolve(value); }, error => { listener[Symbol.dispose](); reject(error); });
  });
}

/** GET /matches/top: the Watch page's hand-picked top matches (top-matches.ts), in GET /matches row shape. */
export const TOP_PATH = "/matches/top";

/**
 * One public listing page. Each storage page's rows pass the hide list (when configured), then serve leaves out test
 * matches and gives the rest their served values (type, handles, corrections). Every recording of any other match type,
 * rated or not, is listed unless the hide list leaves it out. Storage pages are read until PAGE_ROWS rows are listed, storage ends, or MAX_LISTING_STORAGE_PAGES have
 * been read; so a page comes back short only at the end of the history or at that cap. A page that stops at a storage
 * boundary it served up to, without the hide list, keeps the storage continuation; a full page continues after its last
 * served row; a page stopped by the cap continues after the last row it read, sealed (listingContinuations). So no
 * left-out or unserved row's id is in the listing.
 */
async function publicHistoryPage(source: HistorySource, token: string | undefined, signal: AbortSignal,
  visibility: PublicVisibility | undefined, continuations: ListingContinuations,
  serveVisible: (page: HistoryPage) => Promise<ServedPage>): Promise<ServedPage> {
  token = continuations.open(token);
  const seen = new Set<string>();
  if (token !== undefined) seen.add(token);
  const listed: TypedHistorySummary[] = [];
  for (let pages = 1; ; pages++) {
    signal.throwIfAborted();
    const raw = await source.list(token, signal);
    const served = await untilAborted(serveVisible(raw), signal);
    listed.push(...served.matches);
    if (raw.nextPageToken === null && listed.length <= PAGE_ROWS) return { ...served, matches: listed, nextPageToken: null };
    if (listed.length >= PAGE_ROWS) {
      const matches = listed.slice(0, PAGE_ROWS), last = matches.at(-1)!.id;
      if (visibility === undefined && listed.length === PAGE_ROWS && last === raw.matches.at(-1)?.id && raw.nextPageToken !== null) {
        return { ...served, matches, nextPageToken: raw.nextPageToken };
      }
      if (source.continuationAfter === undefined) throw new Error("Public history continuation unavailable");
      return { ...served, matches, nextPageToken: source.continuationAfter(last) };
    }
    // Storage continues and the page is not yet full: read on, never disclosing this storage boundary.
    if (seen.has(raw.nextPageToken!)) throw new Error("Invalid history continuation");
    seen.add(raw.nextPageToken!);
    token = raw.nextPageToken!;
    if (pages >= MAX_LISTING_STORAGE_PAGES) return { ...served, matches: listed, nextPageToken: continuations.seal(token) };
  }
}

/**
 * Anonymous, read-only history backed by storage rather than this process.
 * GET /matches?pageToken=<URL-encoded nextPageToken> -> {matches,nextPageToken}: every recording, rated or unrated, that
 * the hide list (when configured) does not leave out, except a test match's, which is never listed; GET /matches/<id> still
 * serves it.
 * Follow continuations even after an empty page. GET /matches/<id> -> full JSON.
 * GET /matches/top -> {matches}: the Watch page's hand-picked top matches (top-matches.ts) in list order, each served as
 * GET /matches serves it, and only where its record exists, the public visibility check GET /matches applies passes it and it
 * is not a test match; a complete record is read once and kept, any other is read again on each request.
 * These paths are independent of /live/* and /replays/*.
 * A listing page is bounded as a whole (60 s) and reads at most MAX_LISTING_STORAGE_PAGES storage pages. A record download has no total-time bound, so a slow but steady
 * client always gets the complete record; it is dropped only after 30 s in which no chunk was handed to the
 * response (a stalled client stops taking chunks under backpressure).
 */
export function historyRoutes(source: HistorySource, lobbies?: RecordingLobbyLookup,
  options: HistoryRouteOptions = {}): MountHandler {
  const recordIdleMs = options.recordIdleMs ?? RECORD_IDLE_MS;
  // A whole-history build uses a fresh projection per page; it never populates the route's long-lived row caches.
  function projection(policy: PublicVisibility | undefined, buildSignal?: AbortSignal, originals?: WeakMap<TypedHistorySummary, TypedHistorySummary>) {
    const cached = lobbies === undefined ? undefined : cachedLobbyLookup(buildSignal ? id => lobbies(id, buildSignal) : lobbies, { unsettledMs: options.unsettledLobbyMs });
    const handles = cached === undefined ? undefined : lobbySeatHandles(cached);
    const types = recordingMatchTypes(cached, undefined, buildSignal);

    /** Test status and the served type come from the same sources in both public lists. */
    async function nonTest(listed: HistoryPage): Promise<ServedPage> {
      const [all, marked] = await joinReads([types(listed), options.testRecordings?.marked(listed.matches.map(row => row.id), buildSignal, !!buildSignal)]);
      return { ...all, matches: all.matches.filter(row => row.matchType?.kind !== "test" && !marked?.has(row.id)) };
    }
    async function serve(listed: HistoryPage, signal: AbortSignal): Promise<ServedPage> {
      const typed = await nonTest(listed);
      // A request that has ended starts no further lookups.
      signal.throwIfAborted();
      const filled = handles === undefined ? typed : await handles(typed);
      // Last, so a source's correction (correctedRecordings.ts) sees the handles the lobby filled in.
      const rows = source.listed === undefined ? filled.matches : await source.listed(filled.matches, buildSignal);
      if (!rows.length || !options.currentRosterSeats) {
        if (rows.length && buildSignal) throw new Error("Roster ownership unavailable");
        return { ...filled, matches: rows };
      }
      const attributed = await attributeRoster(rows, cached, options.currentRosterSeats, signal, buildSignal ? "directory" : "archive");
      if (originals) attributed.forEach((row, i) => originals.set(row, rows[i]!));
      return { ...filled, matches: attributed };
    }
    async function visibleRows<T extends { id: string }>(rows: T[], signal: AbortSignal, lobbyLimit = 20) {
      signal.throwIfAborted();
      if (buildSignal && policy?.replaysVisibleEach) {
        const ids = await policy.replaysVisibleEach(rows.map(row => row.id), buildSignal, lobbyLimit);
        return rows.filter(row => ids.has(row.id));
      }
      return policy ? publiclyVisible(rows, row => policy.replayVisible(row.id, buildSignal), signal) : rows;
    }
    async function serveVisible(raw: HistoryPage, signal: AbortSignal) {
      return serve({ ...raw, matches: await visibleRows(raw.matches, signal) }, signal);
    }
    return { serve, serveVisible, visibleRows };
  }
  const { serve, serveVisible } = projection(options.publicVisibility);
  const continuations = listingContinuations();
  const listPage = (token: string | undefined, signal: AbortSignal) =>
    publicHistoryPage(source, token, signal, options.publicVisibility, continuations, raw => serveVisible(raw, signal));

  async function scanContributions(signal: AbortSignal, policy: PublicVisibility | undefined, facts: ReturnType<typeof snapshotContributions>) {
    if (!source.scan) throw new Error("History scan unavailable");
    const stop = new AbortController(), reading = AbortSignal.any([signal, stop.signal]);
    const iterator = source.scan(reading)[Symbol.asyncIterator]();
    // Two pages at most, including the next body read. Its owner checks can start as soon as the
    // bodies arrive while the current page finishes checking claims. Yield in discovery order.
    const pages: Promise<TypedHistorySummary[]>[] = [];
    const originals = new WeakMap<TypedHistorySummary, TypedHistorySummary>();
    function remember(rows: TypedHistorySummary[]) {
      for (const row of rows) if (!neverJoined(row) && row.seats.some(s => s.handle && !isHouseHandle(s.handle.toLowerCase()))) facts.add(originals.get(row)!);
    }
    async function project(matches: HistorySummary[]) {
      const page = projection(policy, reading, originals);
      const visible = await page.visibleRows(matches, reading);
      const rows: TypedHistorySummary[] = [];
      // A wider storage read must not fan out an entire window of individual lobby lookups.
      for (let i = 0; i < visible.length; i += PAGE_ROWS) {
        reading.throwIfAborted();
        const served = await page.serve({ matches: visible.slice(i, i + PAGE_ROWS), nextPageToken: null }, reading);
        rows.push(...served.matches);
      }
      return rows;
    }
    try {
      for (;;) {
        const batch = await iterator.next();
        if (batch.done) break;
        reading.throwIfAborted();
        const work = project(structuredClone(batch.value));
        pages.push(work);
        void work.catch(error => stop.abort(error)); // cancel the sibling; both are drained below
        if (pages.length === 2) remember(await pages.shift()!);
      }
      if (pages.length) remember(await pages.shift()!);
    } finally {
      stop.abort();
      await Promise.allSettled(pages);
      await iterator.return?.();
    }
  }
  const policyNow = options.usersPolicy ?? (() => ({ digest: "static", visibility: options.publicVisibility }));
  const usersDeadline = options.usersDeadlineMs ?? 120_000, usersNow = options.usersNow ?? Date.now;
  type Facts = ReturnType<typeof snapshotContributions>;
  type Policy = ReturnType<typeof policyNow>;
  type Answer = { body: Buffer; revision: number; expires: number };
  type Snapshot = { answer?: Answer; expires: number; digest: string; facts?: Facts };
  let snapshot: Snapshot | undefined;
  type Flight = { answer(): Promise<Buffer>; background: boolean; settled: Promise<void>; stop: AbortController; signal: AbortSignal; digest: string; waiters: number };
  const readerLeft = new Error("Users reader disconnected");
  const invalidated = new Error("Users listing invalidated");
  let flight: Flight | undefined, admissions = 0;

  // Use the same fresh database reads for both an expired answer and publication. An ownership
  // write or hide on another instance doesn't advance our process-local revision.
  async function checked(facts: Facts, policy: Policy, signal: AbortSignal, width: 1 | 4) {
    // A remote change cannot advance our revision. Bound the oldest database read, not the publication time.
    const expires = usersNow() + 60_000, revision = usersRevision();
    const page = projection(policy.visibility, signal);
    async function verify(rows: UserMatch[], lobbyLimit: number) {
      const [visible, marked] = await joinReads([page.visibleRows(rows, signal, lobbyLimit),
        options.testRecordings?.marked(rows.map(row => row.id), signal, true)]);
      const allowed = visible.filter(row => !marked?.has(row.id));
      if (!allowed.length) return [];
      if (!options.currentRosterSeats) throw new Error("Roster ownership unavailable");
      return attributeRoster(allowed, lobbies, options.currentRosterSeats, signal, "directory", lobbyLimit);
    }
    async function* batches() {
      const iterator = facts.batches();
      for (;;) {
        signal.throwIfAborted();
        const group: UserMatch[][] = [];
        while (group.length < width) {
          const batch = iterator.next();
          if (batch.done) break;
          group.push(batch.value);
        }
        if (!group.length) return;
        // Verification phases run in order inside a batch. Share the lobby budget across
        // both legacy visibility and attribution; drain the whole group before reading more.
        const limit = Math.min(20, Math.floor(40 / group.length));
        yield* await joinReads(group.map(rows => verify(rows, limit)));
      }
    }
    const users = await publicUsers(batches(), options.ratings, signal);
    return { body: Buffer.from(JSON.stringify({ users })), revision, expires };
  }

  function begin(policy: Policy, prior?: Facts): Flight {
    const stop = new AbortController(), signal = AbortSignal.any([stop.signal, AbortSignal.timeout(usersDeadline)]);
    const started = usersNow();
    // One admitted check at a time, shared even while waiting out the cooldown. When the
    // full scan finishes, give its verification the next slot rather than extending the build.
    const earlyStop = new AbortController(), earlySignal = AbortSignal.any([signal, earlyStop.signal]);
    let closing = false, nextCheck = 0, early: Promise<Answer | undefined> | undefined;
    function checkPrior() {
      if (!prior || closing) return early;
      return early ??= (async () => {
        const delay = nextCheck - performance.now();
        if (delay > 0) await sleep(delay, undefined, { signal: earlySignal });
        return checked(prior, policy, earlySignal, 1);
      })().catch(() => { closing = true; return undefined; }).finally(() => {
        nextCheck = performance.now() + 1000; early = undefined;
      });
    }
    const work = (async () => {
      const facts = snapshotContributions();
      await scanContributions(signal, policy.visibility, facts);
      closing = true;
      // An active early check may still give its visitors a faster answer; a waiting timer
      // must not hold up publication. Drain its reads before starting the final check.
      if (nextCheck > performance.now()) earlyStop.abort();
      await early;
      let answer: Answer;
      do {
        signal.throwIfAborted();
        answer = await checked(facts, policy, signal, 4);
      } while (needsUsersCheck(answer.revision, facts)); // retry the database check, never the storage scan
      signal.throwIfAborted();
      const published = usersNow();
      if (policy.digest !== policyNow().digest) throw invalidated;
      if (published >= answer.expires || published - started >= usersDeadline) throw new Error("Listing expired");
      if (!facts.retainable) console.warn("Users listing exceeds the contribution limit; expiry will wait for a full build");
      snapshot = { answer, facts: facts.retainable ? facts : undefined, digest: policy.digest, expires: answer.expires };
      return answer;
    })().catch(error => {
      if (error !== invalidated && signal.reason !== invalidated && signal.reason !== readerLeft) snapshot = { digest: policy.digest, expires: usersNow() + 10_000 };
      throw error;
    }).finally(async () => { closing = true; earlyStop.abort(); await early; flight = undefined; });
    async function answer(): Promise<Buffer> {
      const pending = checkPrior();
      if (pending) {
        const first = await Promise.race([pending, work]);
        if (first && usersNow() < first.expires && !needsUsersCheck(first.revision, prior)) return first.body;
      }
      const final = await work;
      if (usersNow() >= final.expires || needsUsersCheck(final.revision, snapshot?.facts)) throw invalidated;
      return final.body;
    }
    const build: Flight = { answer: sharedRead(answer), background: !!prior, settled: work.then(() => {}, () => {}), signal, stop, digest: policy.digest, waiters: 0 };
    return build;
  }
  async function users(signal: AbortSignal, admit: () => void): Promise<Buffer> {
    for (;;) {
      signal.throwIfAborted();
      const policy = policyNow();
      if (snapshot?.digest !== policy.digest) snapshot = undefined;
      if (snapshot && usersNow() < snapshot.expires) {
        if (!snapshot.answer) throw new Error("Users listing temporarily unavailable");
        if (!needsUsersCheck(snapshot.answer.revision, snapshot.facts)) return snapshot.answer.body;
      }
      admit();
      const build = flight ??= begin(policy, snapshot?.facts);
      if (build.digest !== policy.digest) {
        build.stop.abort(invalidated);
        await untilAborted(build.settled, signal);
        continue;
      }
      // The departing visitor cancelled the work, not the listing. Join cleanup before starting its replacement.
      if (build.signal.reason === readerLeft) { await untilAborted(build.settled, signal); continue; }
      build.signal.throwIfAborted();
      build.waiters++;
      try {
        const waiting = AbortSignal.any([build.signal, signal]);
        const body = await untilAborted(build.answer(), waiting);
        if (build.digest === policyNow().digest) return body;
      } catch (error) {
        // Rejoin under the new revision, keeping this visitor's original deadline/disconnect signal.
        if (error !== invalidated) throw error;
      }
      finally { if (--build.waiters === 0 && !build.background && flight === build) build.stop.abort(signal.reason); }
    }
  }
  const picks = options.topMatches ?? shippedTopMatchList();
  /** The listed records' complete summaries: a complete record is never replaced (records/record-store.ts save), so it is kept. */
  const complete = new Map<string, HistorySummary>();
  /** The listed records' summaries, shared by the requests waiting on one read. A record that is missing or not complete is
   * read again on each later request, so one created or replaced since is served; a failed read is not kept. */
  const topSummaries = sharedRead(async () => {
    const signal = AbortSignal.timeout(LIST_DEADLINE_MS);
    try {
      const unread = picks.ids.filter(id => !complete.has(id));
      const found = source.summary === undefined ? [] : await Promise.all(unread.map(id => source.summary!(id, signal)));
      const fresh = new Map(found.filter(row => row !== null).map(row => [row.id, row]));
      for (const row of fresh.values()) if (row.status === "complete") complete.set(row.id, row);
      return picks.ids.flatMap(id => complete.get(id) ?? fresh.get(id) ?? []);
    } catch (error) {
      console.warn(`antwar top matches unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      throw error;
    }
  });
  let loggedLeftOff = "";
  /** The hand-picked list in its order, each match served as GET /matches serves it, kept only where its record exists,
   * the public visibility check passes it and it is not a test match, exactly as GET /matches lists it. */
  async function topMatches(signal: AbortSignal): Promise<TypedHistorySummary[]> {
    // The shared read outlives this request; the request stops waiting at its deadline or disconnect.
    const stored = await untilAborted(topSummaries(), signal);
    // Hide list and served values on every request, so a newly hidden match drops off without a restart.
    // Like a listing page, the request stops waiting for the hide list and the served values at its deadline or disconnect.
    const visible = options.publicVisibility ? await untilAborted(publiclyVisible(stored, row => options.publicVisibility!.replayVisible(row.id), signal), signal) : stored;
    const served = (await untilAborted(serve({ matches: visible, nextPageToken: null }, signal), signal)).matches;
    const shown = new Set(served.map(row => row.id));
    const leftOff = [...picks.leftOff, ...picks.ids.filter(id => !shown.has(id))].join(", ");
    // Ids only, and only when they change: every one is the list's own entry.
    if (leftOff !== loggedLeftOff) { loggedLeftOff = leftOff; if (leftOff !== "") console.info(`antwar top matches left off: ${leftOff}`); }
    return picks.ids.flatMap(id => served.filter(row => row.id === id));
  }
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // The HUD needs only current usernames for its own confirmed seats, not the whole directory.
    const hud = /^\/matches\/users\/links\/(replay|lobby)\/([^/]+)$/.exec(url.pathname);
    const list = url.pathname === "/matches";
    const usersList = url.pathname === "/matches/users";
    const topList = url.pathname === TOP_PATH;
    const id = url.pathname.startsWith("/matches/") && !topList ? url.pathname.slice("/matches/".length) : "";
    if (!list && !topList && !usersList && !hud && !isReplayId(id)) { res.writeHead(404).end(); return; }
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
    const deadline = setTimeout(() => abort.abort(), usersList || hud ? usersDeadline : list || topList ? LIST_DEADLINE_MS : recordIdleMs);
    deadline.unref();
    const cancel = () => abort.abort(usersList || hud ? readerLeft : undefined);
    res.once("close", cancel);
    try {
      if (hud) {
        const [, kind, key] = hud;
        if (!(kind === "replay" ? isReplayId(key!) : isValidId(key))) { res.writeHead(404).end(); return; }
        const signal = abort.signal, policy = policyNow();
        let handles: [string, string][] = [];
        const visible = !policy.visibility || (kind === "replay" ? await policy.visibility.replayVisible(key!, signal) : await policy.visibility.lobbyVisible(key!));
        if (visible && options.currentRosterSeats) {
          const marked = kind === "replay" && (await options.testRecordings?.marked([key!], signal, true))?.has(key!);
          const lobby = !marked && await (kind === "replay" ? lobbies : options.lobbyById)?.(key!, signal);
          if (lobby && lobby !== "pending" && !lobby.test && lobby.kind === "public") {
            const seats = lobby.colonies.flat();
            const current = await options.currentRosterSeats(seats, signal);
            handles = [...agreedHandles(seats, current)].flatMap(([label, handle]) => handle ? [[label, handle]] : []);
          }
        }
        if (policy.digest !== policyNow().digest) throw new Error("Roster policy changed");
        const body = Buffer.from(JSON.stringify({ handles }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
      } else if (usersList) {
        // One slot per unfinished response, across retries. Finishing or disconnecting
        // releases it even if other requests still need the background refresh.
        let admitted = false;
        const release = () => { --admissions; res.off("finish", release); res.off("close", release); };
        const body = await users(abort.signal, () => {
          if (admitted) return;
          if (admissions >= 128) throw new Error("Listing busy");
          admitted = true; ++admissions;
          res.once("finish", release); res.once("close", release);
        });
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
      } else if (topList) {
        const matches = await topMatches(abort.signal);
        if (res.destroyed) return;
        const body = Buffer.from(JSON.stringify({ matches }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) });
        res.end(req.method === "HEAD" ? undefined : body);
      } else if (list) {
        const page = await listPage(token, abort.signal);
        if (res.destroyed) return;
        // Recordings show an unlisted house seat handle as "Unlisted model"; the server logs it.
        logUnlistedHouse("recordings", page.matches.flatMap(row => row.seats.map(seat => seat.handle)));
        const body = Buffer.from(JSON.stringify(page));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) });
        res.end(req.method === "HEAD" ? undefined : body);
      } else {
        if (options.publicVisibility && !await options.publicVisibility.replayVisible(id)) {
          res.writeHead(404, { "cache-control": "no-store" }).end(); return;
        }
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
          res.writeHead(200, { "content-type": "application/json", "cache-control": options.publicVisibility ? "no-store" : complete && !CORRECTED_REPLAY_IDS.has(id) ? IMMUTABLE : SHORT });
          if (req.method === "HEAD") { res.end(); return; }
          res.write(start);
          // Each chunk the response takes is progress; under backpressure a stalled client takes none.
          await pipeline(rest, async function* (chunks: AsyncIterable<Uint8Array | string>) {
            for await (const chunk of chunks) { deadline.refresh(); yield chunk; }
          }, res, { signal: abort.signal });
        } finally { cancellation[Symbol.dispose](); body.destroy(); }
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof InvalidContinuation) { res.writeHead(400, { "cache-control": "no-store" }).end(); return; }
      if (usersList) console.warn("Users listing unavailable (503)");
      const body = Buffer.from(JSON.stringify({ error: "Match history temporarily unavailable. Please try again." }));
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "content-length": String(body.length) });
      res.end(req.method === "HEAD" ? undefined : body);
    } finally { clearTimeout(deadline); res.off("close", cancel); }
  };
}
