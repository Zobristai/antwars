/**
 * Live or recorded: one line at the top of the header says which the
 * page is showing. Live with no agent in the match it says so and offers a
 * recorded agent match (?replay); the recording always says it is not live and
 * links back. The line is always there, so the header keeps its height and the
 * board fitted below it never moves when an agent joins or leaves.
 *
 * A recording is a stored match, played from its immutable id. The page's own words claim nothing
 * about how the agents play together; what the agents themselves said is shown as they said it.
 *
 * This module words the line (modeCopy); each HUD draws it from HudView.mode. The line is the page's one
 * "RECORDING": the board carries no badge of its own.
 */

import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";

export type Mode = "live" | "replay";

export interface ModeCopy {
  /** Always shown in full. */
  label: string;
  /** Descriptive tail; the only part that may be cut short on a narrow screen. */
  detail: string;
  link: { text: string; href: string } | null;
}

export const LIVE_LABEL = "LIVE";
/** Live with no agent in the match: a label, no commentary (formerly "No active agents — colonies on autopilot"). */
export const AUTOPILOT_DETAIL = "No agents";
/** The delay disclosure, kept in view once the waiting panel has gone, from the stream's own default. */
export const DELAY_DETAIL = `${DEFAULT_LIVE_CONFIG.delaySeconds} s behind the match`;
export const OFFER_TEXT = "Watch a recorded agent match";
export const RECORDING_LABEL = "RECORDING · not live";
export const BACK_TEXT = "Back to live";
/** The live view from the page's path: the bare front page is the landing, so live is ?watch=1. */
export const liveHref = (path: string): string => `${path}?watch=1`;

/**
 * Why the live page is playing a stored recording instead of a live match: the server has
 * no match; a match has started but its delayed stream has not reached the page yet; or the live feed failed. One
 * short label in the recording's line, no sentence.
 */
export type Fallback = "idle" | "starting" | "failed";
export const FALLBACK_LABEL: Record<Fallback, string> = {
  idle: "no live match",
  starting: "live match starting",
  failed: "live feed unavailable",
};
/** Set by openSource (source.ts) on the live page while the recording stands in; null everywhere else. */
let fallback: Fallback | null = null;
export function setFallback(reason: Fallback | null): void {
  fallback = reason;
}

/** A tag that never breaks across lines: no-break spaces, and a word joiner after each hyphen ("rounds 11-25" stays whole). */
export const unbrokenTag = (tag: string): string => tag.replace(/ /g, "\u00a0").replace(/-/g, "-\u2060");

/**
 * What the line says. livePath is the page without its query; its live view is liveHref(livePath). While the recording
 * plays, its agent count, from the data, is part of its label, so a narrow screen never cuts it
 * (its detail the recording's date alone:
 * "RECORDING · not live · 4 agents", "15 Oct 2026"); once it has ended the detail is
 * "· recording ended", and
 * the masthead shows the count again. Live, the detail keeps the
 * delay disclosed, after "No active agents — colonies on autopilot" while no agent is in the match.
 * Standing in for the live page (source.ts), the recording's line
 * says why in place of "not live": "RECORDING · no live match · rated match · 4 agents".
 * A stored Model Index recording's harness phase tags follow its detail: "15 Oct 2026 · Harness: rounds 26-30".
 */
export function modeCopy(mode: Mode, agents: number, ended: boolean, livePath: string, storedId: string | null = null, rated?: boolean, delaySeconds?: number,
  harnessPhase: readonly string[] = []): ModeCopy {
  const rating = rated === undefined ? "" : rated ? " · rated match" : " · unrated match";
  const delay = delaySeconds === undefined
    ? rated === undefined ? DELAY_DETAIL : `${rated ? 300 : 60} s behind the match`
    : `${delaySeconds} s behind the match`;
  if (mode === "replay") {
    // The live page's stand-in: one label line, a recording and why, with no Back to live (the page goes live by itself).
    // A Model Index recording's harness phase tags follow the detail, each kept whole on the line.
    const phase = harnessPhase.map(unbrokenTag).join(" · ");
    const after = (text: string) => phase === "" ? text : text === "" ? phase : `${text} · ${phase}`;
    const detail = after(storedId === null ? "" : recordedDateLabel(storedId));
    if (fallback !== null) return { label: `RECORDING · ${FALLBACK_LABEL[fallback]}${rating} · ${agents} agents`, detail, link: null };
    const link = { text: BACK_TEXT, href: liveHref(livePath) };
    const label = RECORDING_LABEL + rating;
    return ended ? { label, detail: after("· recording ended"), link } : { label: `${label} · ${agents} agents`, detail, link };
  }
  if (agents === 0) return { label: LIVE_LABEL + rating, detail: `${AUTOPILOT_DETAIL} · ${delay}`, link: { text: OFFER_TEXT, href: "?replay" } };
  return { label: LIVE_LABEL + rating, detail: delay, link: null };
}

/** The recording has ended once playback shows its last tick. */
export function excerptEnded(playbackTick: number, lastTick: number): boolean {
  return playbackTick >= lastTick;
}

/** In replay mode the waiting panel and the tab say a recording is loading, not the live stream: its state line says so and the live delay's paragraph goes. */
export function replayWaiting(doc: Document): void {
  doc.title = "Antwars — recording";
  const panel = doc.getElementById("aw-waiting");
  const [heading, state, delay] = panel ? [...panel.querySelectorAll("p")] : [];
  if (heading) heading.textContent = "Antwars";
  if (state) state.textContent = "Connecting…";
  delay?.remove();
}

/** Browser-only validation of the server's immutable replay-id format. Never import its Node/GCS adapter. */
export function replayDate(id: string): string | null {
  if (id.length > 41) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([1-9]\d*)$/.exec(id);
  if (m === null || !Number.isSafeInteger(Number(m[6]))) return null;
  const [year, month, day] = m[1]!.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

const RECORDED_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Calendar text from the immutable UTC id, independent of every animation clock and wall clock. */
function recordedDateLabel(id: string): string {
  const iso = replayDate(id)!;
  return `${Number(iso.slice(8, 10))} ${RECORDED_MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** An id is loaded directly, not looked up in the process-local recent-match list.
 * A bare replay resolves the newest stored id in openSource first; there is no bundled recording. */
export function replayPath(params: URLSearchParams): string {
  const id = params.get("replay");
  if (id === null || id === "") throw new Error("This replay link has no match id.");
  if (replayDate(id) === null) throw new Error("This replay link has an invalid match id.");
  return `/replays/${encodeURIComponent(id)}`;
}

/** Resolve once across the complete stored history, never the restart-local live list.
 * A deadline/page bound is an incomplete discovery, not permission to use a partial newest. */
export async function newestStoredReplay(request: typeof fetch = fetch, signal?: AbortSignal): Promise<string | null> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 60_000);
  const abort = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const seen = new Set<string>();
  let path = "/matches";
  let newest: ReplayLink | null = null;
  try {
    for (let pages = 0; pages < 1000; pages++) {
      abort.throwIfAborted();
      const response = await request(path, { cache: "no-store", signal: abort });
      if (!response.ok) throw new Error(`History returned HTTP ${response.status}.`);
      const page: unknown = await response.json();
      abort.throwIfAborted();
      if (typeof page !== "object" || page === null || !("matches" in page) || !Array.isArray(page.matches) || !("nextPageToken" in page)) {
        throw new Error("Invalid history page.");
      }
      for (const value of page.matches) {
        const replay = historyReplay(value);
        if (!replay) throw new Error("Invalid stored match identity.");
        const at = replayDate(replay.replayId)!;
        const previous = newest ? replayDate(newest.replayId)! : "";
        if (!newest || at > previous || (at === previous && replay.seq > newest.seq)) newest = replay;
      }
      const token = page.nextPageToken;
      if (token === null) return newest?.replayId ?? null;
      if (typeof token !== "string" || token.length === 0 || token.length > 2048 || !/^[\x21-\x7e]+$/.test(token) || seen.has(token)) {
        throw new Error("Invalid history continuation.");
      }
      seen.add(token);
      path = `/matches?pageToken=${encodeURIComponent(token)}`;
    }
    throw new Error("History page limit reached.");
  } catch (cause) {
    throw new Error("Stored match history is unavailable or incomplete. Please try again.", { cause });
  } finally { clearTimeout(timer); }
}

/** A complete empty history is not a recording failure. */
export function noStoredReplays(doc: Document): void {
  doc.title = "Antwars — no stored matches";
  const panel = doc.getElementById("aw-waiting");
  const state = doc.querySelector(".aw-wait-state");
  if (state) state.textContent = "No stored matches available";
  panel?.querySelector(".aw-byoa")?.remove();
  if (panel) {
    const back = doc.createElement("a");
    back.textContent = BACK_TEXT;
    back.href = liveHref(doc.defaultView?.location.pathname ?? "/");
    back.style.cssText = "display:inline-flex;align-items:center;min-width:44px;min-height:44px";
    panel.append(back);
  }
}

/** Startup and mid-download failures remain visible, including after the waiting panel has gone. */
export function recordingError(doc: Document, error: Error): void {
  let notice = doc.getElementById("aw-recording-error");
  if (!notice) {
    notice = doc.createElement("p");
    notice.id = "aw-recording-error";
    notice.setAttribute("role", "alert");
    doc.body.append(notice);
  }
  notice.textContent = error.message;
  const state = doc.querySelector(".aw-wait-state");
  if (state) state.textContent = error.message;
}


interface ReplayLink { seq: number; replayId: string }

/** History exposes immutable ids, not this instance's live match numbers. */
function historyReplay(value: unknown): ReplayLink | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || replayDate(value.id) === null) return null;
  return { seq: Number(value.id.slice(value.id.lastIndexOf("-") + 1)), replayId: value.id };
}
