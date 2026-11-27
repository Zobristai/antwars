/** One source contract shared by 3D, 2D and boardless spectator playback. */
import type { StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { openPreparedFeed, type PreparedFeed } from "./feed.ts";
import type { Arrival } from "./inbox.ts";
import type { PreparedTick } from "./buffer.ts";
import { wallClockNow } from "./clock.ts";
import { openRecording, type Recording } from "./recording.ts";
import { newestStoredReplay, noStoredReplays, recordingError, replayDate, replayPath, replayWaiting, setFallback, type Fallback } from "./replay.ts";
import { LOCAL_STREAM_PATH, loadRecording, streamPath, type LinkState } from "./stream.ts";
import { storeFeatureEnabled } from "./store-capabilities.ts";
import { randomMatch, watchMatchStatus, type MatchStatus } from "./match-status.ts";
import { openInviteStream } from "./invite-stream.ts";
import { inviteRecordingRequest, lobbyRecordingPath } from "./invite-recording.ts";
import { restateRatings, storedReplayRatings } from "./replay-ratings.ts";
import { liveStarting } from "./waiting.ts";
import { keep } from "./ui/format.ts";
import { boardMode, type BoardMode } from "./webgl2.ts";
import { MANUAL_3D_PARAM, RETRY_3D_PARAM } from "./3d-recovery.ts";

/** Bound discovery and the initial stream wait while a recording can stand in. */
export const CONNECT_MS = 2000;
/** Keep the confirmed live selection across its recording-to-live reload. */
export const HANDOVER_KEY = "antwar-live-handover";
/** One renderer reload, not a fresh visit: preserve the selected live lobby even if it just ended. */
export const FALLBACK_HANDOVER_KEY = "antwar-renderer-handover";
export const FALLBACK_HANDOVER_MS = 60_000;
interface RendererHandover { lobbyId: string; route: string; at: number; delaySeconds?: number }
function fallbackRoute(params: URLSearchParams, pathname: string): string {
  const copy = new URLSearchParams(params);
  copy.delete("board"); copy.sort();
  return `${pathname}?${copy}`;
}
function consumeRendererHandover(view: Window | null, params: URLSearchParams): RendererHandover | null {
  try {
    const raw = view?.sessionStorage.getItem(FALLBACK_HANDOVER_KEY);
    view?.sessionStorage.removeItem(FALLBACK_HANDOVER_KEY);
    if (!raw || params.get("board") !== "2d" || params.has("replay") || params.has("recording")) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null ||
      !("lobbyId" in value) || typeof value.lobbyId !== "string" || !value.lobbyId || value.lobbyId.length > 256 ||
      !("route" in value) || value.route !== fallbackRoute(params, view?.location.pathname ?? "") ||
      !("at" in value) || typeof value.at !== "number" || !Number.isFinite(value.at) ||
      wallClockNow() < value.at || wallClockNow() - value.at > FALLBACK_HANDOVER_MS ||
      (params.has("lobby") && params.get("lobby") !== value.lobbyId)) return null;
    const delaySeconds = "delaySeconds" in value && typeof value.delaySeconds === "number" && Number.isFinite(value.delaySeconds) && value.delaySeconds >= 0 ? value.delaySeconds : undefined;
    return { lobbyId: value.lobbyId, route: value.route, at: value.at, delaySeconds };
  } catch { return null; }
}

/** Carry a replay position across a board switch or an explicit 2D recovery reload, not an ordinary refresh. */
export const REPLAY_POSITION_KEY = "antwar-replay-position";
interface ReplayPosition { recover2d?: true; route: string; board: BoardMode; positionMs: number; at: number }
function rememberReplayPosition(view: Window | null, params: URLSearchParams, positionMs: number, recover2d: boolean): void {
  if (!view || !(positionMs > 0)) return;
  try {
    view.sessionStorage.setItem(REPLAY_POSITION_KEY, JSON.stringify({
      route: fallbackRoute(params, view.location.pathname), board: recover2d ? "2d" : boardMode(params), ...(recover2d && { recover2d: true }), positionMs, at: wallClockNow(),
    } satisfies ReplayPosition));
  } catch { /* Storage is optional: without it the other board starts the replay from its beginning. */ }
}
/** The stored position this page would resume: this replay, recent and past the start, from a board switch or recovery. */
function pendingReplayPosition(raw: string | null | undefined, view: Window | null, params: URLSearchParams): ReplayPosition | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null ||
    !("route" in value) || value.route !== fallbackRoute(params, view?.location.pathname ?? "") ||
    !("board" in value) || (value.board !== "2d" && value.board !== "3d") ||
    (value.board === boardMode(params) && !(value.board === "2d" && "recover2d" in value && value.recover2d === true)) ||
    !("at" in value) || typeof value.at !== "number" || !Number.isFinite(value.at) ||
    wallClockNow() < value.at || wallClockNow() - value.at > FALLBACK_HANDOVER_MS ||
    !("positionMs" in value) || typeof value.positionMs !== "number" || !Number.isFinite(value.positionMs) || value.positionMs <= 0) return null;
  return { route: value.route, board: value.board, positionMs: value.positionMs, at: value.at };
}
function consumeReplayPosition(view: Window | null, params: URLSearchParams): number | null {
  try {
    const raw = view?.sessionStorage.getItem(REPLAY_POSITION_KEY);
    view?.sessionStorage.removeItem(REPLAY_POSITION_KEY);
    return pendingReplayPosition(raw, view, params)?.positionMs ?? null;
  } catch { return null; }
}
/**
 * The 3D board is giving up before its source opened (a failed start, failed module loading, no WebGL2), so it never
 * took the position a board change passed it. Pass that position on to the 2D board as the 3D board's own.
 * Call on the 3D page, just before it becomes the 2D board; anything else is left as it is.
 */
export function carryReplayPositionToFallback(view: Window | null, params: URLSearchParams): void {
  if (!view || boardMode(params) !== "3d") return;
  const own = new URLSearchParams(params);
  own.delete(RETRY_3D_PARAM); own.delete(MANUAL_3D_PARAM);
  try {
    const pending = pendingReplayPosition(view.sessionStorage.getItem(REPLAY_POSITION_KEY), view, own);
    if (pending) view.sessionStorage.setItem(REPLAY_POSITION_KEY, JSON.stringify({ ...pending, board: "3d" } satisfies ReplayPosition));
  } catch { /* Storage is optional: without it the 2D board starts the replay from its beginning. */ }
}

/** A dropped feed changes source only after repeated confirmed catalog absence. */
export const DROP_CHECKS = 2;

/** Live ticks normally carry worker-prepared state; inline fallback uses the existing synchronous playback route. */
export type SourceArrival = Arrival & (
  | { kind: "recorded" | "inline" }
  | { kind: "prepared"; prepared: PreparedTick; workerMs: number; deliveryMs: number }
);

export interface SpectatorSource {
  readonly replay: boolean;
  readonly storedId: string | null;
  /** Immutable delay from the selected catalog entry or explicit lobby status. */
  readonly delaySeconds?: number;
  readonly head: StreamMessage;
  readonly source: string;
  readonly recorded: boolean;
  readonly recording: Recording | null;
  readonly feed: PreparedFeed | null;
  readonly lastTick: number;
  /** The link the result's Share on X names (watchUrl); null for a private match or a bundled recording. */
  readonly share: string | null;
  linkState(): LinkState;
  take(realMs: number): SourceArrival[];
  now(realMs: number): number;
  /** After the displayed result, automatic Watch chooses again; explicit links stay pinned. */
  nextMatch(): void;
  /** Preserve the live selection for an imminent recovery reload as 2D. */
  prepareFallback(): void;
  close(): void;
}

/**
 * The public link to what this page plays, for sharing: the stored replay when the page plays one, else the
 * live lobby's watch link. A private match (an invite, or a lobby's own recording) has none, as has a bundled recording.
 */
export function watchUrl(origin: string, o: { private: boolean; replayId: string | null; lobbyId: string | null }): string | null {
  if (o.private) return null;
  if (o.replayId) return `${origin}/?replay=${encodeURIComponent(o.replayId)}`;
  return o.lobbyId ? `${origin}/?lobby=${encodeURIComponent(o.lobbyId)}` : null;
}

/** Optional public metadata; never transfer a private recording's invite to history.
 * Full history may be large: refuse oversized metadata instead of retaining event arrays. */
export async function recordedEndTick(id: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<number | null> {
  const response = await request(`/matches/${encodeURIComponent(id)}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error", credentials: "omit",
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) return null;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const record: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof record !== "object" || record === null || !("format" in record) || record.format !== "antwar.match" ||
      !("version" in record) || record.version !== 1 || !("id" in record) || record.id !== id || !("result" in record)) return null;
  const result = record.result;
  if (typeof result !== "object" || result === null || !("tick" in result) || typeof result.tick !== "number" ||
      !Number.isSafeInteger(result.tick) || result.tick < 0 || result.tick >= Number.MAX_SAFE_INTEGER) return null;
  // Result ticks name the simulation step; the final spectator message is its completed tick.
  return result.tick + 1;
}

/** Optional disclosure only: a missing status must not interrupt playback or expose an invite in a URL. */
export async function liveLobbyDelay(lobbyId: string, invite: string | null, signal: AbortSignal, request: typeof fetch = fetch): Promise<number | undefined> {
  return (await liveLobbyStatus(lobbyId, invite, signal, request))?.delaySeconds;
}

/** The explicit lobby's delay, and whether it exists with its match not yet finished, started or not (the waiting panel, else the Leaderboard). */
export async function liveLobbyStatus(lobbyId: string, invite: string | null, signal: AbortSignal, request: typeof fetch = fetch): Promise<{ delaySeconds: number; awaiting: boolean } | undefined> {
  try {
    const response = await request(`/watch/status/${encodeURIComponent(lobbyId)}`, {
      headers: invite ? { "x-antwar-invite": invite } : {},
      credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (signal.aborted || typeof value !== "object" || value === null || !("lobbyId" in value) || value.lobbyId !== lobbyId ||
      !("delaySeconds" in value) || typeof value.delaySeconds !== "number" || !Number.isFinite(value.delaySeconds) || value.delaySeconds < 0) return undefined;
    const awaiting = !("playbackFinished" in value && value.playbackFinished === true);
    return { delaySeconds: value.delaySeconds, awaiting };
  } catch { return undefined; }
}

/** How often a lobby link waiting in the panel re-reads its status. */
export const LOBBY_STATUS_RECHECK_MS = 15_000;

/** Settles once a waiting lobby's status reads finished (for example ended or expired before any match); an unavailable read keeps waiting. */
function lobbyFinished(lobbyId: string, invite: string | null, signal: AbortSignal): Promise<null> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => void liveLobbyStatus(lobbyId, invite, signal).then(status => {
        if (signal.aborted) return;
        if (status && !status.awaiting) resolve(null); else next();
      }), LOBBY_STATUS_RECHECK_MS);
    };
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    next();
  });
}

/** The stored replay of a lobby whose match has finished playing, or null: none recorded, not finished, or no answer. */
export async function finishedLobbyReplay(lobbyId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await request(`/watch/recording/${encodeURIComponent(lobbyId)}`, {
      credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (signal.aborted || typeof value !== "object" || value === null || !("replayId" in value)) return null;
    const id = value.replayId;
    return typeof id === "string" && replayDate(id) !== null ? id : null;
  } catch { return null; }
}

/** How many times a lobby link standing in with the Leaderboard re-reads its finished match's replay id,
 * LOBBY_STATUS_RECHECK_MS apart: a just-saved replay's id reaches the lobby's record shortly after its playback ends. */
export const FINISHED_REPLAY_RECHECKS = 8;

/** Settles with the lobby's replay id once the server names one, or null after FINISHED_REPLAY_RECHECKS reads or on abort. */
function laterFinishedReplay(lobbyId: string, signal: AbortSignal): Promise<string | null> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>, left = FINISHED_REPLAY_RECHECKS;
    const next = () => {
      if (left-- <= 0) { resolve(null); return; }
      timer = setTimeout(() => void finishedLobbyReplay(lobbyId, signal).then(id => {
        if (signal.aborted) return;
        if (id !== null) resolve(id); else next();
      }), LOBBY_STATUS_RECHECK_MS);
    };
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(null); }, { once: true });
    next();
  });
}

/** What a lobby link shows while its lobby has no live match: its finished match's replay, else the Leaderboard page, loaded only when needed. */
export interface LobbyScreens {
  leaderboard(doc: Document): void;
  replay(doc: Document, replayId: string): void;
  /** Automatic Watch with no live match to show: the top recorded matches, saying why; returns how to say a new reason. */
  topMatches(doc: Document, reason: Fallback): (reason: Fallback) => void;
}
export const LOBBY_SCREENS: LobbyScreens = {
  leaderboard(doc) {
    const view = doc.defaultView;
    if (view) void import("./leaderboard-page/page.ts").then(({ mountLeaderboardPage }) => mountLeaderboardPage(doc, view), error => console.error(error));
  },
  topMatches(doc, reason) {
    const view = doc.defaultView;
    let latest = reason, page: { setState(next: Fallback): void } | null = null;
    if (view) void import("./pages/top-matches.ts").then(({ mountTopMatchesPage }) => { page = mountTopMatchesPage(doc, view, { state: latest }); }, error => console.error(error));
    return next => { latest = next; page?.setState(next); };
  },
  replay(doc, replayId) {
    const view = doc.defaultView;
    const url = view && watchUrl(view.location.origin, { private: false, replayId, lobbyId: null });
    // The chosen board (board=2d, picked or fallen back to) follows the viewer to the replay, as on the site's links.
    if (url) view.location.replace(keep(url, view.location.search));
  },
};

type SourceOptions = NonNullable<Parameters<typeof openPreparedFeed>[3]> & {
  /** The active 2D renderer is replacing this document after context loss, even if discovery is still pending. */
  isRecoveryReload?: () => boolean;
};

export async function openSource(params: URLSearchParams, clock: { now(): number }, doc: Document, reject: (error: Error) => void, { isRecoveryReload, ...liveOptions }: SourceOptions = {}, screens: LobbyScreens = LOBBY_SCREENS): Promise<SpectatorSource | null> {
  const replay = params.has("replay");
  let storedId = replay ? params.get("replay") || null : null;
  const name = replay ? null : params.get("recording");
  // A local match's server has no catalog: its page plays that one match, pinned like an explicit link.
  const local = !replay && !name && !params.has("lobby") && !params.has("capture") && storeFeatureEnabled(doc, "local-match");
  // Numeric main-match links now enter ordinary Watch discovery, never a retired route.
  const automatic = !replay && !name && !params.has("lobby") && !local;
  const view = doc.defaultView;
  const rendererHandover = consumeRendererHandover(view, params);
  let resumeAt = replay ? consumeReplayPosition(view, params) : null;
  let resumeGeneration: number | null = null;
  let feed: PreparedFeed | null = null;
  let recording: Recording | null = null;
  let closeStatus: (() => void) | undefined;
  const abort = new AbortController();
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let recordingTimer: ReturnType<typeof setTimeout> | undefined;
  let delaySeconds: number | undefined;
  let legacy: StreamMessage[] | null = null;
  let state: LinkState = "connecting";
  let next = 0;
  let fallback: Fallback | null = null;
  let selected: MatchStatus[number] | null = null;
  let catalog: MatchStatus | null = null;
  const latestCatalog = () => catalog;
  const closeRecording = () => recording?.close();
  let live = false, ended = false, dropped = 0, reloading = false, handedOver = false, lobbyIdle = false;
  /** Says a new reason on the top-matches page, once automatic Watch shows it. */
  let topReason: ((reason: Fallback) => void) | null = null;
  const close = () => {
    abort.abort(); clearTimeout(connectTimer); clearTimeout(recordingTimer);
    closeStatus?.(); recording?.close(); feed?.link.close();
  };
  const reload = (handover = false) => {
    // Explicit links stay pinned; a lobby link reloads only while the Leaderboard stands in for its lobby.
    if (reloading || abort.signal.aborted || (!automatic && fallback === null && !lobbyIdle)) return;
    reloading = true;
    const handoverId = automatic ? selected?.lobbyId : params.get("lobby");
    if (handover && handoverId) {
      try { view?.sessionStorage.setItem(HANDOVER_KEY, handoverId); } catch { /* Storage is optional. */ }
    }
    view?.location.reload();
  };
  const limit = (ms = CONNECT_MS) => new Promise<null>(resolve => {
    connectTimer = setTimeout(() => resolve(null), ms);
    abort.signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const fail = (error: Error) => { if (!abort.signal.aborted) { recordingError(doc, error); reject(error); } };
  // Only startup is timed out, not a large recording's paced, backpressured download.
  const standIn = async (path: string, replayId: string | null) => {
    const startup = new AbortController();
    recordingTimer = setTimeout(() => startup.abort(), 10_000);
    let ready = false;
    const request: typeof fetch = (url, options) => fetch(url, { ...options,
      signal: AbortSignal.any([abort.signal, startup.signal, ...(options?.signal ? [options.signal] : [])]),
    });
    // A stored stand-in is a past match's public replay: its stored rating record restates it, as on a
    // replay page. The bundled excerpt has no stored id and plays as recorded.
    recording = openRecording(path, error => { if (ready) fail(error); }, request,
      replayId === null ? {} : { restate: storedReplayRatings(replayId, null, abort.signal).then(stored => stored && restateRatings(stored)) });
    try { const head = await recording.first; ready = true; return head; }
    finally { clearTimeout(recordingTimer); }
  };
  // On a capture route, the newest stored recording stands in for a live page with no live match. Without one the page shows why:
  // no stored match, unreadable or incomplete history, or that recording's own failure before its first snapshot.
  // Those screens return null without closing, so the live subscriptions still hand over to a live match (reload).
  const standInRecording = async (): Promise<StreamMessage | null> => {
    replayWaiting(doc);
    try { storedId = await newestStoredReplay(fetch, abort.signal); }
    catch (error) {
      storedId = null;
      fail(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
    if (abort.signal.aborted) return null;
    if (storedId === null) { noStoredReplays(doc); return null; }
    try { return await standIn(replayPath(new URLSearchParams({ replay: storedId })), storedId); }
    catch (error) {
      closeRecording(); storedId = null;
      fail(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  };
  // Leaving an explicit replay keeps its position for a board switch or a recovery reload;
  // a position not yet resumed is passed on as it was.
  view?.addEventListener("pagehide", () => {
    if (replay) rememberReplayPosition(view, params, resumeAt ?? recording?.position ?? 0, isRecoveryReload?.() ?? false);
    close();
  }, { once: true });
  setFallback(null);
  try {
    const invite = new URLSearchParams(view?.location?.hash.slice(1)).get("invite");
    const lobbyRecording = replay && params.has("lobby") && storedId !== null;
    if (replay) replayWaiting(doc);
    if (replay && storedId === null) {
      storedId = await newestStoredReplay(fetch, abort.signal);
      if (storedId === null) { close(); noStoredReplays(doc); return null; }
    }
    if (automatic && !params.has("capture")) {
      let firstCatalog!: (matches: MatchStatus) => void;
      const first = new Promise<MatchStatus>(resolve => { firstCatalog = resolve; });
      closeStatus = watchMatchStatus(matches => {
        catalog = matches;
        firstCatalog(matches);
        if (fallback !== null) {
          setFallback(fallback = matches.length ? "starting" : "idle");
          topReason?.(fallback);
          // Keep the selected delayed connection until it delivers a running snapshot. Merely listing
          // another lobby says nothing about its readiness and must not cause repeated random reloads.
          if (matches.length && (!selected || !matches.some(match => match.lobbyId === selected!.lobbyId))) reload();
        }
        const present = selected !== null && matches.some(match => match.lobbyId === selected!.lobbyId);
        dropped = live && !present && state !== "open" && !ended ? dropped + 1 : 0;
        if (dropped >= DROP_CHECKS) reload();
      });
      const matches = await Promise.race([first, limit()]);
      clearTimeout(connectTimer);
      selected = randomMatch(matches ?? []);
      let handover: string | null = null;
      try { handover = view?.sessionStorage.getItem(HANDOVER_KEY) ?? null; view?.sessionStorage.removeItem(HANDOVER_KEY); } catch { /* Optional. */ }
      selected = matches?.find(match => match.lobbyId === handover) ?? selected;
      handedOver = selected !== null && selected.lobbyId === handover;
      delaySeconds = rendererHandover?.delaySeconds ?? selected?.delaySeconds;
    } else if (!replay && !name && params.has("lobby")) {
      // A lobby link reloaded to hand over from the Leaderboard gets the longer bound, as automatic Watch does.
      try {
        handedOver = view?.sessionStorage.getItem(HANDOVER_KEY) === params.get("lobby");
        view?.sessionStorage.removeItem(HANDOVER_KEY);
      } catch { /* Optional. */ }
    }
    if (abort.signal.aborted) return null;
    const replayParams = storedId ? new URLSearchParams({ replay: storedId }) : params;
    const liveLobbyId = rendererHandover?.lobbyId ?? (automatic ? selected?.lobbyId : params.get("lobby"));
    const path = replay ? (lobbyRecording ? lobbyRecordingPath(params) : replayPath(replayParams))
      : name ? `recordings/${encodeURIComponent(name)}.bin`
      : local ? LOCAL_STREAM_PATH
      : liveLobbyId ? streamPath(new URLSearchParams({ lobby: liveLobbyId })) : null;
    let head: StreamMessage;
    if (replay) {
      recording = openRecording(path!, fail, lobbyRecording ? inviteRecordingRequest(path!, invite) : undefined, {
        controls: true,
        endTick: lobbyRecording ? undefined : signal => recordedEndTick(storedId!, signal),
        // A stored match's rating figures come from its stored change record; the bundled excerpt has none.
        ...(storedId === null ? {} : { restate: storedReplayRatings(storedId, lobbyRecording ? invite : null, abort.signal).then(stored => stored && restateRatings(stored)) }),
      });
      head = await recording.first;
    } else if (name) {
      legacy = await loadRecording(path!);
      head = legacy[0]!;
    } else {
      let firstRunning: Promise<StreamMessage> | null = null;
      let heard!: () => void;
      const arrival = new Promise<true>(resolve => { heard = () => resolve(true); });
      let lobbyStatus: ReturnType<typeof liveLobbyStatus> = Promise.resolve(undefined);
      if (path) {
        const lobbyId = params.get("lobby");
        if (lobbyId) lobbyStatus = liveLobbyStatus(lobbyId, invite, abort.signal).then(status => {
          delaySeconds = status?.delaySeconds;
          return status;
        });
        let runningSeen!: (m: StreamMessage) => void;
        firstRunning = new Promise(resolve => { runningSeen = resolve; });
        const onMessage = (m: StreamMessage) => {
          if (m.full) ended = m.full.result !== null;
          if (m.events.some(e => e.kind === "end")) ended = true;
          if (m.full && !ended) runningSeen(m);
        };
        const privateSource = invite && params.has("lobby") ? (url: string) => openInviteStream(url, invite) : undefined;
        feed = openPreparedFeed(path, () => clock.now(), value => { state = value; }, {
          measure: view?.__antwarRealNow, ...liveOptions, onMessage, onArrival: heard, source: liveOptions.source ?? privateSource,
        });
      }
      if (local) {
        // Until every agent has joined and the stream's delay has passed there is nothing to send: say the match is
        // starting, and wait for its first frame, or the final one of a match that has already ended.
        if (!await Promise.race([arrival, limit()])) liveStarting(doc);
        clearTimeout(connectTimer);
        head = await feed!.first;
      } else if (!automatic) {
        if (!feed) throw new Error("This watch link has no lobby id.");
        // Renderer handovers wait for the snapshot with the same bound as automatic Watch, even if status
        // already says finished. Ordinary links still open once the server sends anything, however slowly
        // this page decodes. A lobby link never plays another match's recording.
        const sending = rendererHandover
          ? await Promise.race([feed.first, limit(10_000)])
          : await Promise.race([arrival, limit(handedOver ? 10_000 : CONNECT_MS)]);
        clearTimeout(connectTimer);
        if (abort.signal.aborted) return null;
        let opening: StreamMessage | null = null;
        if (sending) opening = await feed.first;
        else {
          const status = await lobbyStatus;
          if (abort.signal.aborted) return null;
          if (status?.awaiting) {
            // Not yet started, or started with nothing released yet by its delayed stream: the waiting panel says so until it does.
            // A lobby that ends or expires without a match while the panel shows takes the Leaderboard path below.
            liveStarting(doc);
            const waiting = new AbortController();
            const stop = () => waiting.abort();
            abort.signal.addEventListener("abort", stop, { once: true });
            try { opening = await Promise.race([feed.first, lobbyFinished(params.get("lobby")!, invite, waiting.signal)]); }
            finally { stop(); abort.signal.removeEventListener("abort", stop); }
          }
        }
        // No match to wait for (ended, unknown, or no status), or a finished one: a just-ended lobby's retained stream
        // sends its final snapshot at once. A public lobby whose match finished playing opens that match's replay.
        // Otherwise the Leaderboard; the live subscription stays open, so a running snapshot (a match that starts
        // here) takes over (reload), and a replay whose id the server names a little later still opens. A private lobby's
        // replay needs its invite, so it keeps the Leaderboard.
        if (opening === null || (opening.full?.result != null && !rendererHandover)) {
          if (abort.signal.aborted) return null;
          const replayId = invite ? null : await finishedLobbyReplay(params.get("lobby")!, abort.signal);
          if (abort.signal.aborted) return null;
          if (replayId !== null) { close(); screens.replay(doc, replayId); return null; }
          lobbyIdle = true;
          void firstRunning!.then(() => reload(true));
          screens.leaderboard(doc);
          if (!invite) void laterFinishedReplay(params.get("lobby")!, abort.signal).then(id => {
            if (id === null || reloading || abort.signal.aborted) return;
            close(); screens.replay(doc, id);
          });
          return null;
        }
        head = opening;
      } else {
        // Handover is still bounded: a server failure after reload must not leave Connecting forever.
        // A renderer handover continues an already selected match, including its final snapshot.
        const first = rendererHandover && feed
          ? await Promise.race([feed.first, limit(10_000)])
          : firstRunning ? await Promise.race([firstRunning, limit(handedOver ? 10_000 : CONNECT_MS)]) : null;
        clearTimeout(connectTimer);
        if (abort.signal.aborted) return null;
        if (first) { live = true; head = first; }
        else {
          const confirmed = latestCatalog();
          setFallback(fallback = confirmed === null ? "failed" : confirmed.length ? "starting" : "idle");
          if (firstRunning) void firstRunning.then(() => {
            if (catalog?.some(match => match.lobbyId === selected?.lobbyId)) reload(true);
          });
          // A visitor's page shows the top recorded matches; the live subscriptions stay open, so a live match still takes
          // over (reload). A capture route keeps playing the newest stored recording.
          if (!params.has("capture")) { topReason = screens.topMatches(doc, fallback); return null; }
          const standing = await standInRecording();
          if (standing === null) return null;
          head = standing;
        }
      }
    }
    if (abort.signal.aborted) return null;
    let shown = -1;
    return {
      get delaySeconds() { return delaySeconds; },
      replay: replay || fallback !== null, storedId, head,
      source: replay ? `replay ${path}` : fallback ? `replay ${replayPath(new URLSearchParams({ replay: storedId! }))} (no live match: ${fallback})` : name ? `recording ${name}` : path!,
      recorded: replay || legacy !== null || fallback !== null,
      recording, feed: fallback ? null : feed,
      get lastTick() { return recording?.lastTick ?? legacy?.at(-1)?.tick ?? Number.POSITIVE_INFINITY; },
      share: name ? null : watchUrl(view?.location?.origin ?? "", {
        private: !!invite || lobbyRecording,
        replayId: replay || fallback !== null ? storedId : null,
        lobbyId: liveLobbyId ?? null,
      }),
      linkState: () => state,
      take(realMs) {
        if (recording) {
          // Resume a board change's position once the scrubber can seek (the recording's length is known). The target is
          // kept until that seek has landed, so leaving mid-seek (another board change) passes it on, not the start.
          if (resumeAt !== null && resumeGeneration === null && recording.duration !== null) {
            recording.seek(resumeAt);
            resumeGeneration = recording.generation;
          }
          const arrivals = recording.take(realMs).map(arrival => ({ ...arrival, kind: "recorded" as const }));
          // Landed, or replaced by the visitor's own seek: the recording's position stands from here.
          if (resumeGeneration !== null && (!recording.seeking || recording.generation !== resumeGeneration)) resumeAt = resumeGeneration = null;
          shown = arrivals.at(-1)?.m.tick ?? shown;
          if (fallback && shown >= recording.lastTick) reload();
          return arrivals;
        }
        if (legacy) {
          const out: SourceArrival[] = [];
          while (next < legacy.length && next * TICK_MS <= realMs) {
            out.push({ kind: "recorded", m: legacy[next]!, at: next * TICK_MS }); next++;
          }
          return out;
        }
        return feed!.take().map(arrival => arrival.kind === "inline" ? arrival : { ...arrival, m: arrival.prepared.m });
      },
      now: realMs => recording?.time ?? realMs,
      nextMatch: () => reload(),
      prepareFallback() {
        if (replay || legacy || fallback || !liveLobbyId || abort.signal.aborted) return;
        try {
          view?.sessionStorage.setItem(FALLBACK_HANDOVER_KEY, JSON.stringify({
            lobbyId: liveLobbyId, route: fallbackRoute(params, view.location.pathname), at: wallClockNow(), delaySeconds,
          } satisfies RendererHandover));
        } catch { /* Storage is optional; retain ordinary navigation if unavailable. */ }
      },
      close,
    };
  } catch (cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Explicit replay discovery still settles its caller's readiness promise on cancellation.
    if (abort.signal.aborted && replay) reject(error);
    else fail(error);
    close();
    return null;
  }
}
