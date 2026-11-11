/** One source contract shared by 3D, 2D and boardless spectator playback. */
import type { StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { openPreparedFeed, type PreparedFeed } from "./feed.ts";
import type { Arrival } from "./inbox.ts";
import type { PreparedTick } from "./buffer.ts";
import { openRecording, type Recording } from "./recording.ts";
import { newestStoredReplay, noStoredReplays, recordingError, replayPath, replayWaiting, setFallback, type Fallback } from "./replay.ts";
import { loadRecording, streamPath, type LinkState } from "./stream.ts";
import { randomMatch, watchMatchStatus, type MatchStatus } from "./match-status.ts";
import { openInviteStream } from "./invite-stream.ts";
import { inviteRecordingRequest, lobbyRecordingPath } from "./invite-recording.ts";
import { restateRatings, storedReplayRatings } from "./replay-ratings.ts";
import { liveStarting } from "./waiting.ts";

/** Bound discovery and the initial stream wait while a recording can stand in. */
export const CONNECT_MS = 2000;
/** Keep the confirmed live selection across its recording-to-live reload. */
export const HANDOVER_KEY = "antwar-live-handover";
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

/** What a lobby link shows while its lobby has no live match: the Leaderboard page, loaded only when needed. */
export interface LobbyScreens { leaderboard(doc: Document): void }
const LOBBY_SCREENS: LobbyScreens = {
  leaderboard(doc) {
    const view = doc.defaultView;
    if (view) void import("./leaderboard-page/page.ts").then(({ mountLeaderboardPage }) => mountLeaderboardPage(doc, view), error => console.error(error));
  },
};

export async function openSource(params: URLSearchParams, clock: { now(): number }, doc: Document, reject: (error: Error) => void, liveOptions: Parameters<typeof openPreparedFeed>[3] = {}, screens: LobbyScreens = LOBBY_SCREENS): Promise<SpectatorSource | null> {
  const replay = params.has("replay");
  let storedId = replay ? params.get("replay") || null : null;
  const name = replay ? null : params.get("recording");
  // Numeric main-match links now enter ordinary Watch discovery, never a retired route.
  const automatic = !replay && !name && !params.has("lobby");
  const view = doc.defaultView;
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
  // The newest stored recording stands in for a live page with no live match. Without one the page shows why:
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
  view?.addEventListener("pagehide", close, { once: true });
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
      delaySeconds = selected?.delaySeconds;
    } else if (!replay && !name && params.has("lobby")) {
      // A lobby link reloaded to hand over from the Leaderboard gets the longer bound, as automatic Watch does.
      try {
        handedOver = view?.sessionStorage.getItem(HANDOVER_KEY) === params.get("lobby");
        view?.sessionStorage.removeItem(HANDOVER_KEY);
      } catch { /* Optional. */ }
    }
    if (abort.signal.aborted) return null;
    const replayParams = storedId ? new URLSearchParams({ replay: storedId }) : params;
    const path = replay ? (lobbyRecording ? lobbyRecordingPath(params) : replayPath(replayParams))
      : name ? `recordings/${encodeURIComponent(name)}.bin`
      : automatic ? selected ? streamPath(new URLSearchParams({ lobby: selected.lobbyId })) : null : streamPath(params);
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
      if (!automatic) {
        if (!feed) throw new Error("This watch link has no lobby id.");
        // Connecting is bounded by the server sending anything at all; once it has, the link opens as before,
        // however slowly this page decodes. A lobby link never plays another match's recording.
        const sending = await Promise.race([arrival, limit(handedOver ? 10_000 : CONNECT_MS)]);
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
        // sends its final snapshot at once. The Leaderboard; the live subscription stays open, so a running snapshot
        // (a match that starts here) takes over (reload).
        if (opening === null || opening.full?.result != null) {
          if (abort.signal.aborted) return null;
          lobbyIdle = true;
          void firstRunning!.then(() => reload(true));
          screens.leaderboard(doc);
          return null;
        }
        head = opening;
      } else {
        // Handover is still bounded: a server failure after reload must not leave Connecting forever.
        const first = firstRunning ? await Promise.race([firstRunning, limit(handedOver ? 10_000 : CONNECT_MS)]) : null;
        clearTimeout(connectTimer);
        if (abort.signal.aborted) return null;
        if (first) { live = true; head = first; }
        else {
          const confirmed = latestCatalog();
          setFallback(fallback = confirmed === null ? "failed" : confirmed.length ? "starting" : "idle");
          if (firstRunning) void firstRunning.then(() => {
            if (catalog?.some(match => match.lobbyId === selected?.lobbyId)) reload(true);
          });
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
        lobbyId: automatic ? selected?.lobbyId ?? null : params.get("lobby"),
      }),
      linkState: () => state,
      take(realMs) {
        if (recording) {
          const arrivals = recording.take(realMs).map(arrival => ({ ...arrival, kind: "recorded" as const }));
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
