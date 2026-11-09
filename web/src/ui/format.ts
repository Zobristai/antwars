// The broadcast HUD: pure rules shared by its three pages. No DOM, no requests, no clock.
import { COLONY_NAMES } from "../../../src/sim/config.ts";
import type { StreamResult } from "../../../src/live/format.ts";
import { resultHow } from "../story.ts";
import { replayDate } from "../replay.ts";
import { returnTo3dUrl, clear3dRetryUrl } from "../3d-recovery.ts";
import type { LiveMatch, MatchesView, Recording } from "../matches-page/data.ts";

// ---------------------------------------------------------------- colony details: two drawers

/**
 * Each colony's drawer: pinned by a tap, click, Enter or Space on its half of the plate; previewed while pointed at or
 * focused. There is no lock: pinning each half keeps both open.
 */
export interface Drawers {
  readonly pinned: readonly [boolean, boolean];
  readonly preview: readonly [boolean, boolean];
}
export type DrawerEvent =
  | { kind: "point"; colony: 0 | 1 }
  | { kind: "leave" }
  | { kind: "focus"; colony: 0 | 1 }
  | { kind: "blur"; colony: 0 | 1 }
  | { kind: "toggle"; colony: 0 | 1 }
  | { kind: "close" };

export const CLOSED: Drawers = { pinned: [false, false], preview: [false, false] };

const set = (pair: readonly [boolean, boolean], colony: 0 | 1, value: boolean): [boolean, boolean] =>
  colony === 0 ? [value, pair[1]] : [pair[0], value];

export function drawers(state: Drawers, event: DrawerEvent): Drawers {
  switch (event.kind) {
    case "point": return { pinned: state.pinned, preview: set([false, false], event.colony, true) };
    case "leave": return { pinned: state.pinned, preview: [false, false] };
    case "focus": return { pinned: state.pinned, preview: set(state.preview, event.colony, true) };
    case "blur": return { pinned: state.pinned, preview: set(state.preview, event.colony, false) };
    // Its own control pins a drawer, previewed or closed, and lets a pinned one go.
    case "toggle": {
      const pinned = state.pinned[event.colony];
      return { pinned: set(state.pinned, event.colony, !pinned), preview: set(state.preview, event.colony, false) };
    }
    case "close": return CLOSED;
  }
}
export const isShown = (state: Drawers, colony: 0 | 1): boolean => state.pinned[colony] || state.preview[colony];

// ---------------------------------------------------------------- the score plate: progress toward each way to win

/** Each side's share of a split bar, in percent from its own end; null when neither has any. */
export function shares(a: number, b: number): readonly [number, number] | null {
  const total = a + b;
  if (!(total > 0)) return null;
  const first = (100 * a) / total;
  return [first, 100 - first];
}

/** Where a leader's share must reach for a ratio-to-one lead (6000 permille: 6/7 of the bar), in percent from its end. */
export const leadLine = (ratioPermille: number): number => (100 * ratioPermille) / (ratioPermille + 1000);

/**
 * How far a qualifying territory lead is through its hold, 0..1, in simulation steps as the stream counts them: the
 * win is due once playback reaches winTick + 1 (src/sim/territory.ts sustainedTerritoryWin; web/src/overlays.ts).
 */
export function holdProgress(win: { readonly startTick: number; readonly winTick: number } | undefined, tick: number): number | null {
  if (win === undefined) return null;
  const span = win.winTick + 1 - win.startTick;
  return span > 0 ? Math.max(0, Math.min(1, (tick - win.startTick) / span)) : null;
}

/**
 * The spawn ring's fill, 0..1, toward the next hatch: the share of the hatch interval
 * already waited; empty while the colony needs food, as drawn; full once eligible or at the cap. A wait longer than the
 * interval given counts from the wait itself.
 */
export function spawnFill(next: { readonly kind: string }, nextHatchTick: number, intervalTicks: number, tick: number): number {
  if (next.kind === "ready" || next.kind === "full") return 1;
  if (next.kind !== "waiting") return 0;
  const wait = Math.max(0, nextHatchTick - tick);
  return Math.max(0, Math.min(1, 1 - wait / Math.max(intervalTicks, wait, 1)));
}

/** The page's next-hatch words (overlays.ts scoreHatchStatus) without their caste glyph, which the spawn chip draws. */
export const withoutCasteGlyph = (text: string): string => text.replace(/^(?:⛏|⚔)\s/u, "");

/** The fill reduced motion shows: whole quarters, so the ring moves in a few clear steps rather than a sweep. */
export const stepped = (progress: number, steps = 4): number => Math.floor(progress * steps + 1e-9) / steps;

/** A colony's queens on the plate: the standing ones, outermost first in founding order. A lost queen drops off. */
export function liveQueens<Q extends { readonly colony: number; readonly foundedTick: number; readonly id: number }>(
  queens: readonly Q[], colony: number, fallen: (q: Q) => boolean,
): Q[] {
  return queens.filter(q => q.colony === colony && !fallen(q)).sort((a, b) => a.foundedTick - b.foundedTick || a.id - b.id);
}

// ---------------------------------------------------------------- links

/** The chosen board follows the visitor between the three pages. */
export const KEPT_PARAMS = ["board"] as const;
export function keep(href: string, search: string): string {
  const from = new URLSearchParams(search);
  const url = new URL(href, "http://antwars.invalid/");
  for (const name of KEPT_PARAMS) {
    const value = from.get(name);
    if (value !== null && !url.searchParams.has(name)) url.searchParams.set(name, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export const PAGES = [["watch", "Watch", "/?watch=1"], ["matches", "Matches", "/?page=matches"], ["leaderboard", "Leaderboard", "/?page=leaderboard"]] as const;
export type PageName = (typeof PAGES)[number][0];

/** The board choice, both ways: 3D keeps the existing manual-attempt marker, 2D drops it. Every other parameter stays. */
export function boardHref(board: "2d" | "3d", href: string): string {
  if (board === "3d") return returnTo3dUrl(href);
  const url = new URL(clear3dRetryUrl(href));
  url.searchParams.set("board", "2d");
  return url.toString();
}

/** The visible live/replay HUD headline, separate from its reason and rating lines: the winning model(s) by name,
 * "GPT-6.1 Sol wins", a team "Claude Opus 5.5 & Grok 4.7 win"; the colony's name only where no seat names a model. */
export function resultHeadline(result: Pick<StreamResult, "winner" | "reason">, winners: readonly string[] = []): string {
  if (result.reason === "abandoned") return "Abandoned";
  if (result.winner === null) return "Draw";
  return winners.length === 0 ? `${COLONY_NAMES[result.winner]} wins` : `${winners.join(" & ")} ${winners.length > 1 ? "win" : "wins"}`;
}

// ---------------------------------------------------------------- the matches page

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A UTC calendar stamp from an ISO instant or epoch ms; null when the input is not a real instant. */
export function utcStamp(at: string | number): string | null {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm} UTC`;
}

export interface RecordingRow {
  readonly id: string;
  readonly href: string;
  readonly when: string;
  readonly result: string;
  readonly how: string | null;
  readonly models: string;
  readonly record: string;
  /** The match-type badge, such as "Index · 2v2"; null where the record and its lobby cannot tell it (no badge). */
  readonly type: string | null;
}

/** Known only from the record; null stays unknown, and a null winner is a draw only where the record says so. */
export function recordingResult(r: Pick<Recording, "winner" | "reason" | "decidedBy">): { result: string; how: string | null } {
  const how = r.reason !== null && r.decidedBy !== null ? resultHow({ reason: r.reason, decidedBy: r.decidedBy }, true) : null;
  if (r.reason === "abandoned") return { result: "Abandoned", how };
  if (r.winner !== null) return { result: `${COLONY_NAMES[r.winner]} won`, how };
  if (r.decidedBy === "draw") return { result: "Draw", how };
  return { result: "Result unknown", how: null };
}

/** Recorded model labels by colony; an empty seat list is unrecorded seats, never a match without agents. */
export function recordingModels(seats: Recording["seats"]): string {
  if (seats.length === 0) return "Seats not recorded";
  return ([0, 1] as const).flatMap(colony => {
    const labels = seats.filter(s => s.colony === colony).sort((a, b) => a.seat - b.seat).map(s => s.modelLabel ?? "model unknown");
    return labels.length ? [`${COLONY_NAMES[colony]}: ${labels.join(", ")}`] : [];
  }).join(" · ");
}

/** Record fidelity, worded as the record's, not as playability. */
export const RECORD_LABEL: Record<Recording["status"], string> = { complete: "Record complete", partial: "Record partial", unavailable: "Record unavailable" };

/** Each match type's word on the Recordings badge; never a mode slug. */
export const MATCH_TYPE_WORDS: Record<NonNullable<Recording["matchType"]>["kind"], string> = {
  index: "Index", ranked: "Ranked", unranked: "Lobby", challenge: "Challenge", unrated: "Unrated",
};
/** "Ranked · 2v2"; the word alone where the size is unknown; null for no type, or none sent. */
export function recordingType(type: Recording["matchType"]): string | null {
  if (type == null) return null;
  return type.size === null ? MATCH_TYPE_WORDS[type.kind] : `${MATCH_TYPE_WORDS[type.kind]} · ${type.size}v${type.size}`;
}

export function recordingRow(r: Recording, search: string): RecordingRow {
  const { result, how } = recordingResult(r);
  return {
    id: r.id, href: keep(`/?replay=${encodeURIComponent(r.id)}`, search),
    when: utcStamp(r.startedAt) ?? utcStamp(replayDate(r.id) ?? "") ?? "Start unknown",
    result, how, models: recordingModels(r.seats), record: RECORD_LABEL[r.status], type: recordingType(r.matchType),
  };
}

/** Saved history only, deduplicated by immutable id, newest first by start. */
export function recordingRows(view: Pick<MatchesView, "recordings">, search: string): RecordingRow[] {
  const rows = new Map<string, { row: RecordingRow; at: number }>();
  for (const r of view.recordings.rows) rows.set(r.id, { row: recordingRow(r, search), at: Date.parse(r.startedAt) || Date.parse(replayDate(r.id) ?? "") || 0 });
  return [...rows.values()].sort((a, b) => b.at - a.at || (a.row.id < b.row.id ? 1 : -1)).map(entry => entry.row);
}

/** A figure keeps its unit on its line: "4 s" never breaks between the number and the "s". */
export const withUnits = (s: string): string => s.replace(/(\d) (?=(?:s|ms|min|h|HP)\b)/g, "$1 ");

export interface LiveRow { readonly id: string; readonly href: string; readonly title: string; readonly detail: string }
export function liveRow(m: LiveMatch, search: string): LiveRow {
  const params = new URLSearchParams(search);
  const href = new URLSearchParams({ lobby: m.lobbyId, watch: "1" });
  for (const name of ["board", "tilt"]) { const value = params.get(name); if (value !== null) href.set(name, value); }
  return {
    id: m.lobbyId, href: `/?${href}`, title: withUnits(`${m.rated ? "Rated" : "Unrated"} match · ${m.delaySeconds} s behind`),
    detail: `Started ${utcStamp(m.startedAt) ?? "at an unknown time"} · lobby ${m.lobbyId}`,
  };
}

export type Tone = "loading" | "partial" | "complete" | "empty" | "error";
export interface SectionState { readonly tone: Tone; readonly text: string }

/** How a failure recovers, said once on the page's line however many lists failed. */
export const RETRY = "Refresh to try again.";

/** The live section's line: only the catalog determines whether public matches are live. */
export function liveState(view: Pick<MatchesView, "live">): SectionState {
  const { status, rows } = view.live;
  if (status === "loading") return { tone: "loading", text: rows.length ? "Refreshing live matches…" : "Loading live matches…" };
  if (status === "error") return { tone: "error", text: rows.length ? "Live list unavailable · showing the last list loaded" : "Live list unavailable" };
  return rows.length ? { tone: "complete", text: `${rows.length} public match${rows.length === 1 ? "" : "es"} in the catalog` } : { tone: "empty", text: "No public match in the catalog right now" };
}

/** History is complete only after a successful page with no continuation token. */
export function recordingsState(view: Pick<MatchesView, "recordings" | "next">, shown: number): SectionState {
  const { status } = view.recordings;
  const n = `${shown} recording${shown === 1 ? "" : "s"}`;
  if (status === "loading") return { tone: "loading", text: shown ? `Loading more · ${n} loaded so far` : "Loading recordings…" };
  if (status === "error") return { tone: "error", text: shown ? `Recordings unavailable · ${n} loaded before the error` : "Recordings unavailable" };
  if (view.next !== null) return { tone: "partial", text: shown ? `${n} loaded, newest first · more remain` : "None in the pages loaded so far · more remain" };
  return shown ? { tone: "complete", text: `All ${n}, newest first` } : { tone: "empty", text: "No recordings yet" };
}
