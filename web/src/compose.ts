/**
 * Composition rules of the spectator board:
 * the ants, the front and territory lead; text explains without
 * covering the board. Pure helpers, shared by the board layers, the overlays
 * and the tests.
 */

import type { StreamAgent, StreamResult } from "../../src/live/format.ts";
import { HOUSE_USERNAME } from "../../src/identity/houseOwnership.ts";
import { houseLabel } from "../../src/rating/houseLabels.ts";
import { nameParts, recordedIdentity, type NameParts } from "./pages/model.ts";

/** "name #seat": one identity holding several seats (src/live/watch-controller.ts seatIdentities). Names hold no space or "#". */
export const SEAT = /^(.+) #(\d+)$/;

/** A Benchmark handle: the reserved antwars owner's (src/identity/houseOwnership.ts), whose level and tier are fixed per handle. */
const BENCHMARK = `${HOUSE_USERNAME}/`;
export const isBenchmark = (name: string): boolean => name.toLowerCase().startsWith(BENCHMARK);

export interface RowName { readonly name: string; readonly benchmark: boolean; readonly badges: readonly string[]; readonly quiet: string }
/**
 * A name as the Leaderboard names it, through its own nameParts: a Benchmark handle shows its house
 * display name with its fixed level and Fast badges, as the Leaderboard's server substitutes them (houseLabel); any other
 * identity its own name with the stream's thinking level quiet after. A seat's "#n" stays with the name. Every shown
 * agent name goes through here, so no antwars/ handle is ever shown.
 */
export function rowName(name: string, thinkingLevel: string | undefined): RowName {
  const seat = SEAT.exec(name);
  const base = seat ? seat[1]! : name;
  const benchmark = isBenchmark(base);
  const parts = benchmark
    ? nameParts({ displayName: base, ...houseLabel(base), benchmark: true })
    : nameParts({ displayName: base, thinkingLevel: thinkingLevel || null, serviceTier: null, benchmark: false });
  return { name: seat ? `${parts.name} #${seat[2]}` : parts.name, benchmark, badges: parts.badges, quiet: parts.quiet ?? "" };
}

/**
 * The HUD's model for an agent: the display name plus its level and tier
 * badges, as Recordings names a seat (pages/model.ts recordedIdentity, a house handle by its own row), never the
 * provider/model key; null where the agent reported no model.
 */
export function agentModel(a: Pick<StreamAgent, "modelLabel" | "thinkingLevel" | "serviceTier" | "identity">): NameParts | null {
  if (!a.modelLabel) return null;
  const name = a.identity?.displayName;
  const handle = name === undefined ? null : SEAT.exec(name)?.[1] ?? name;
  return recordedIdentity({ modelLabel: a.modelLabel, thinkingLevel: a.thinkingLevel ?? null, serviceTier: a.serviceTier ?? null, handle });
}

/** A name with its badges as plain text, "name (max · Fast)", where no badge element can be drawn (tooltips, labels). */
export const namedText = (parts: Pick<NameParts, "name" | "badges">): string =>
  parts.badges.length > 0 ? `${parts.name} (${parts.badges.join(" · ")})` : parts.name;

/** The HUD's model as plain text, "<name> (<badges>)"; "" where the agent reported no model. */
export const agentModelText = (a: Pick<StreamAgent, "modelLabel" | "thinkingLevel" | "serviceTier" | "identity"> | undefined): string => {
  const model = a ? agentModel(a) : null;
  return model === null ? "" : namedText(model);
};

/** The HUD's plain-text model line, "<label>: <name> (<badges>)"; "" where the agent reported no model. */
export function modelLine(a: Pick<StreamAgent, "modelLabel" | "thinkingLevel" | "serviceTier" | "identity">, label: string): string {
  const text = agentModelText(a);
  return text === "" ? "" : `${label}: ${text}`;
}

/** Name from the recorded seated identity, as the Leaderboard shows it; legacy recordings retain their generated handle. */
export function playerName(agent: number, player?: Pick<StreamAgent, "identity">): string {
  return player?.identity ? rowName(player.identity.displayName, undefined).name : agentHandle(agent);
}

export function playerLabel(agent: number, player?: Pick<StreamAgent, "identity">): string {
  const name = playerName(agent, player);
  return player?.identity?.elo === undefined ? name : `${name} · Rating ${ratingNumber(player.identity.elo)}`;
}

/** A rating as the match view shows it: a whole number (display only; stored ratings keep their precision). */
function ratingNumber(value: number): string { return String(Math.round(value)); }

/**
 * One line of a result's ratings: a player's shown name, a Benchmark name's level and Fast badges, then the change; a
 * line about the match as a whole has no name and no badges.
 */
export interface RatingRow { readonly name: string; readonly badges: readonly string[]; readonly text: string }

/** Read only the played result, never live account totals or undelayed store outcome. */
export function ratingResultRows(rated: boolean | undefined, agents: readonly StreamAgent[], result: StreamResult | null): RatingRow[] {
  const note = (text: string): RatingRow[] => [{ name: "", badges: [], text }];
  if (result === null || rated === undefined) return [];
  if (!rated) return note("Unrated match · no rating change");
  if (result.ratingChanges === undefined) return note("Rated match · rating update pending");
  return result.ratingChanges.map(change => {
    const identity = agents[change.agent]?.identity;
    const named = identity ? rowName(identity.displayName, undefined) : null;
    // The change between the shown whole numbers, so the line always adds up.
    const delta = Math.round(change.after) - Math.round(change.before);
    return {
      name: named?.name ?? agentHandle(change.agent), badges: named?.badges ?? [],
      text: `Rating ${ratingNumber(change.before)} → ${ratingNumber(change.after)} (${delta > 0 ? "+" : ""}${ratingNumber(delta)})`,
    };
  });
}

/**
 * Whether tilt-shift starts on: off by default, so the board is sharp;
 * ?tilt=1 turns it on, and the bottom bar's switch still toggles it.
 */
export function tiltOn(params: URLSearchParams): boolean {
  return params.get("tilt") === "1";
}

/** The one screen scale for board text and badges: 1 at 1080p, recomputed on every resize. */
export function screenScale(screenW: number): number {
  return screenW / 1920;
}

/**
 * A mark's marker on the board, drawn as
 * an RTS map ping in its squad's shade of the colony hue: a ring of radius ring
 * and stroke ringW on a dark halo, holding its owner's glyph within radius glyph
 * (the shape the agent's badge, roster swatch and log lines draw, so a
 * viewer reads which agent laid the mark), CSS px. The ring is what sets it apart
 * from the ants, which are solid specks; sizes are CSS px, so a phone shows the
 * same ping as 1080p. Every live mark is drawn at
 * this full size and opacity, fading only with its age:
 * how many ants a mark steers sets nothing about its marker.
 */
export const MARK_DOT = { glyph: 6, ring: 10, ringW: 2 } as const;

/** A mark's label beside its marker: 14 px at 1080p, never under 11. */
export function markLabelPx(screenW: number): number {
  return Math.max(11, Math.round(14 * screenScale(screenW)));
}

/** Badge radius in CSS px. */
export function badgeRadiusPx(screenW: number): number {
  return Math.max(7, Math.round(10 * screenScale(screenW)));
}

/**
 * The masthead's stream line, one state at a time in fixed words. Once playback has the result the match is over and a dropped stream is
 * its normal end, so the line says so instead. Whether agents are playing is said once, by
 * Live line (web/src/replay.ts modeCopy), never here.
 */
export const CONNECTING_LINE = "Connecting";
export const RECONNECTING_LINE = "Reconnecting…";
export const ENDED_LINE = "Match ended";

export function linkLine(state: "connecting" | "open" | "reconnecting", ended: boolean): string {
  if (ended) return ENDED_LINE;
  if (state === "reconnecting") return RECONNECTING_LINE;
  if (state === "connecting") return CONNECTING_LINE;
  return "";
}

// ---------------------------------------------------------------- touch targets

/**
 * A finger's target on the board: a tap picks an ant
 * within this many screen px even where a tile is drawn smaller, and a mark's label's tap box is
 * at least this wide and tall. A mouse keeps the exact targets.
 */
export const TOUCH_TARGET_PX = 44;
export const TOUCH_RADIUS_PX = TOUCH_TARGET_PX / 2;

// ---------------------------------------------------------------- agent glyphs

/** Eight glyph shapes; an agent's glyph is GLYPHS[agent % 8], in the agent's shade. */
export const GLYPHS = ["diamond", "triangle", "square", "circle", "star", "hexagon", "chevron", "cross"] as const;
export type Glyph = (typeof GLYPHS)[number];

export function agentGlyph(agent: number): Glyph {
  return GLYPHS[((agent % GLYPHS.length) + GLYPHS.length) % GLYPHS.length]!;
}

/**
 * An agent's handle for the match: its glyph's name, capitalised, the
 * same glyph its badge and roster swatch draw in its shade. Agents past the
 * eighth share a glyph with an earlier one, so they carry a number ("Diamond 2").
 * Read from the agent's index alone, so it is stable for the match and invents
 * nothing about who runs the agent.
 */
export function agentHandle(agent: number): string {
  const g = agentGlyph(agent);
  const name = g[0]!.toUpperCase() + g.slice(1);
  const round = Math.floor(Math.max(0, agent) / GLYPHS.length);
  return round === 0 ? name : `${name} ${round + 1}`;
}

/**
 * The glyph's outline as a flat [x0, y0, x1, y1, ...] polygon centred on (0, 0)
 * within radius r. The board badge and the roster swatch both draw this polygon.
 */
export function glyphPolygon(agent: number, r: number): number[] {
  const ring = (n: number, rot: number, rr = r) => Array.from({ length: n }, (_, i) => [rr * Math.cos(rot + (i * 2 * Math.PI) / n), rr * Math.sin(rot + (i * 2 * Math.PI) / n)]).flat();
  switch (agentGlyph(agent)) {
    case "diamond":
      return [0, -r, r * 0.8, 0, 0, r, -r * 0.8, 0];
    case "triangle":
      return ring(3, -Math.PI / 2);
    case "square":
      return ring(4, Math.PI / 4, r * 1.05);
    case "circle":
      return ring(16, 0, r * 0.9);
    case "star":
      return Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r : r * 0.45;
        return [rr * Math.cos(a), rr * Math.sin(a)];
      }).flat();
    case "hexagon":
      return ring(6, 0, r * 0.95);
    case "chevron":
      return [-r, -r * 0.55, 0, r * 0.35, r, -r * 0.55, r, r * 0.15, 0, r, -r, r * 0.15];
    case "cross": {
      const t = r * 0.38;
      return [-t, -r, t, -r, t, -t, r, -t, r, t, t, t, t, r, -t, r, -t, t, -r, t, -r, -t, -t, -t];
    }
  }
}

// ---------------------------------------------------------------- badge anchors

export interface AntsView {
  count: number;
  id: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  agent: ArrayLike<number>;
}

/**
 * Each agent's badge anchor, in tiles: the squad ant nearest the squad's mean
 * position (centres, as squads.ts squadCentres gives them), ties to the lowest
 * ant id, so a split squad's badge sits on one of its ants. An agent with no
 * ants has no anchor. n is the squad's size.
 */
export function badgeAnchors(ants: AntsView, centres: ReadonlyMap<number, { x: number; y: number; n: number }>): Map<number, { x: number; y: number; n: number; ant: number }> {
  const best = new Map<number, { x: number; y: number; n: number; ant: number; d: number }>();
  for (let i = 0; i < ants.count; i++) {
    const a = ants.agent[i]!;
    const c = centres.get(a);
    if (a < 0 || !c) continue;
    const d = (ants.x[i]! - c.x) ** 2 + (ants.y[i]! - c.y) ** 2;
    const b = best.get(a);
    const id = ants.id[i]!;
    if (!b || d < b.d || (d === b.d && id < b.ant)) best.set(a, { x: ants.x[i]!, y: ants.y[i]!, n: c.n, ant: id, d });
  }
  const out = new Map<number, { x: number; y: number; n: number; ant: number }>();
  for (const [a, b] of best) out.set(a, { x: b.x, y: b.y, n: b.n, ant: b.ant });
  return out;
}

// ---------------------------------------------------------------- tooltips
// Where a tooltip sits beside what was pointed at (web/src/tip.ts draws it in the page's type above every
// panel, so it passes no overlays to keep clear of; the terms remain for a caller that does).

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Space between a tooltip and what it describes, in CSS px. */
const TIP_GAP = 6;

/** A tooltip keeps this far from the screen's side edges, so a plate at the edge never reads as cut (the 031b9eb phone stills). */
export const TIP_EDGE = 6;

/** A tooltip's left edge: centred on target, clamped across the screen less TIP_EDGE each side. */
function tipX0(target: Box, w: number, screen: { w: number; h: number }): number {
  return Math.round(Math.min(Math.max((target.x0 + target.x1) / 2 - w / 2, TIP_EDGE), Math.max(TIP_EDGE, screen.w - w - TIP_EDGE)));
}

/**
 * The screen rows a tooltip of width w beside target can use: the
 * screen, less the HTML overlays (blocked) over the tooltip's columns that lie
 * wholly above or below target, such as the phone header and bottom bar. An
 * overlay beside target, spanning its height (a side panel or drawer), does not
 * bound it.
 */
export function tipBand(target: Box, w: number, screen: { w: number; h: number }, blocked: readonly Box[] = []): { y0: number; y1: number } {
  const x0 = tipX0(target, w, screen);
  let y0 = 0;
  let y1 = screen.h;
  for (const b of blocked) {
    if (!(b.x0 < x0 + w && x0 < b.x1)) continue;
    if (b.y1 <= target.y0) y0 = Math.max(y0, b.y1);
    else if (b.y0 >= target.y1) y1 = Math.min(y1, b.y0);
  }
  return { y0, y1 };
}

/** A tooltip's height for rows of these heights, gap between them and pad in all, plus the "+N more" line when moreH is given. */
export function tipHeight(rows: readonly number[], gap: number, pad: number, moreH: number | null = null): number {
  const lines = moreH === null ? rows : [...rows, moreH];
  return lines.reduce((s, h) => s + h, 0) + gap * Math.max(0, lines.length - 1) + pad;
}

/**
 * How many of a tooltip's rows show within maxH: all of them when they
 * fit, otherwise the most that fit above one "+N more" line; 0 leaves that line alone.
 */
export function tipFit(rows: readonly number[], gap: number, pad: number, moreH: number, maxH: number): number {
  if (tipHeight(rows, gap, pad) <= maxH) return rows.length;
  let k = rows.length - 1;
  while (k > 0 && tipHeight(rows.slice(0, k), gap, pad, moreH) > maxH) k--;
  return k;
}

/**
 * Where a tooltip (a disclosure asked for by hover or tap)
 * sits: centred above target, or below it where above would leave the screen or
 * sit under an HTML overlay (blocked), clamped across the screen. Where neither
 * fits it is clamped into tipBand, or into the screen when taller than the band.
 * It takes no space in the layout and draws no leader, so it may cover the board while shown.
 */
export function tipRect(target: Box, w: number, h: number, screen: { w: number; h: number }, blocked: readonly Box[] = []): Box {
  const x0 = tipX0(target, w, screen);
  const at = (y0: number): Box => ({ x0, y0: Math.round(y0), x1: x0 + w, y1: Math.round(y0) + h });
  const ok = (r: Box) => r.y0 >= 0 && r.y1 <= screen.h && !blocked.some((b) => r.x0 < b.x1 && b.x0 < r.x1 && r.y0 < b.y1 && b.y0 < r.y1);
  const above = at(target.y0 - TIP_GAP - h);
  const below = at(target.y1 + TIP_GAP);
  if (ok(above)) return above;
  if (ok(below)) return below;
  const band = tipBand(target, w, screen, blocked);
  const [lo, hi] = h <= band.y1 - band.y0 ? [band.y0, band.y1] : [0, screen.h];
  return at(Math.min(Math.max(above.y0, lo), Math.max(lo, hi - h)));
}
