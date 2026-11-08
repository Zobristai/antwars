/// <reference types="vite/client" />
/**
 * Marks on the board:
 * each live mark is a small marker at its tile, like an RTS map
 * ping: a dot in its squad's shade of the colony hue, every one at full size
 * and opacity, fading only over the mark's 180 s life (compose.ts MARK_DOT),
 * holding its command symbol, or its owner's glyph without a verb.
 * Beside a count mark's marker, where the layout has room, its label in the owner's shade on a translucent backing:
 * its caste's icon, then its answered/requested count, the count alone with no caste. Labels can be hidden without
 * hiding markers or badges. Word marks have their marker only. Hovering or tapping
 * a marker, or tapping a label (the label is its own target, never shadowed by
 * an ant), shows a tooltip
 * beside it, with no leader, in the page's own type above every panel
 * (tipContent; web/src/tip.ts draws it): the mark's reading
 * as the stream carries it (markReading: a count mark's verb, count and answered
 * ants, a word mark's words as written, never a gloss composed here), then who
 * laid it (its agent handle) and how long ago, kept current about once a second.
 * Each newly laid mark is also a chat line (overlays.ts). The markers
 * and labels sit in the layout so the squads' badges keep clear of them
 * (placeBadges). Sizes follow the screen and are rebuilt on resize and rotation.
 * A LINE mark (rules 26) keeps that marker and label at its first tile and adds a dotted line to its
 * second, ending in a larger dot (lineDots); one drawing for both boards, through each board's toScreen.
 *
 * Font: IBM Plex Mono, Copyright 2017 IBM Corp., licensed under the
 * SIL Open Font License, Version 1.1 (OFL-1.1), bundled from @fontsource.
 */
import { IconSprites } from "./icons/sprites.ts";
import { glyphIconKey } from "./icons/set.ts";
import { BitmapFont, BitmapText, Container, Graphics, GraphicsPath } from "pixi.js";
import plexMono500 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2?url";
import { WORDS } from "../../src/sim/types.ts";
import { SUB_TILE, type StreamAgent, type StreamMark } from "../../src/live/format.ts";
import { MARK_LIFE_MS, type Frame } from "./buffer.ts";
import { agentShade } from "./squads.ts";
import { MARK_DOT, TOUCH_TARGET_PX, agentHandle, glyphPolygon, markLabelPx } from "./compose.ts";
import { OPEN_COPY } from "./story.ts";
import { markSymbol, markSymbolPolygon } from "./mark-symbols.ts";
import { CASTE_ICON_PATH } from "./ui/deck/icons.ts";

export const FONT_FAMILY = "IBM Plex Mono";
export const FONT_LICENCE = "IBM Plex Mono, Copyright 2017 IBM Corp., SIL Open Font License 1.1 (OFL-1.1)";
const GLOSS_FONT = "antwar-plex-500";
const FADE_IN_MS = 350;

export async function loadFonts(): Promise<void> {
  const face = new FontFace(FONT_FAMILY, `url(${plexMono500})`, { weight: "500" });
  await face.load();
  document.fonts.add(face);
  const shadow = { color: 0x000000, alpha: 0.9, blur: 4, distance: 0, angle: 0 };
  // The one board font: the counts on the labels beside the count marks' markers. A dark outline under the shadow, so
  // a count reads on light ground through its translucent backing; tinted, the white fill takes the shade.
  BitmapFont.install({ name: GLOSS_FONT, style: { fontFamily: FONT_FAMILY, fontWeight: "500", fontSize: 40, fill: 0xffffff, stroke: { color: 0x000000, width: 6, join: "round" }, dropShadow: shadow }, chars: [["a", "z"], ["A", "Z"], ["0", "9"], " /-.,:!?'+·"], resolution: 1, padding: 6 });
}

// ---------------------------------------------------------------- readings

/** A mark's words, as the vocabulary spells them, each set off ("ATTACK · W · FEW", shown as written). */
export function wordsText(words: readonly number[]): string {
  return words.map((w) => WORDS[w] ?? "?").join(" · ");
}

export function markText(m: StreamMark): string {
  return wordsText(m.words);
}

/** A count mark: a wordless mark that directs free ants, carrying its verb, count and claimed ants. */
export function isCountMark(m: { words: readonly number[]; verb?: string }): boolean {
  return m.verb !== undefined || m.words.length === 0;
}

// ---------------------------------------------------------------- layout

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Clear space kept around everything placed, so neighbours read as separate. */
const GAP = 4;
const CELL = 64;

/**
 * Occupied screen space with a grid index: the HTML overlays, the markers and
 * the squads' badges, so a badge is placed clear of the others.
 */
export class Placer {
  private w: number;
  private h: number;
  private cells = new Map<number, Rect[]>();
  /** Every rect placed or blocked, in order. */
  readonly rects: Rect[] = [];

  constructor(w: number, h: number, blocked: readonly Rect[] = []) {
    this.w = w;
    this.h = h;
    for (const r of blocked) this.occupy(r);
  }

  /** The screen size this placer covers. */
  get size(): [number, number] {
    return [this.w, this.h];
  }

  occupy(r: Rect): void {
    this.rects.push(r);
    for (const k of this.keys(r)) {
      const list = this.cells.get(k);
      if (list) list.push(r);
      else this.cells.set(k, [r]);
    }
  }

  free(r: Rect): boolean {
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > this.w || r.y1 > this.h) return false;
    const g = { x0: r.x0 - GAP, y0: r.y0 - GAP, x1: r.x1 + GAP, y1: r.y1 + GAP };
    for (const k of this.keys(g)) {
      for (const o of this.cells.get(k) ?? []) if (g.x0 < o.x1 && o.x0 < g.x1 && g.y0 < o.y1 && o.y0 < g.y1) return false;
    }
    return true;
  }

  private *keys(r: Rect): Generator<number> {
    const cx0 = Math.max(0, Math.floor(r.x0 / CELL));
    const cy0 = Math.max(0, Math.floor(r.y0 / CELL));
    const cx1 = Math.floor(r.x1 / CELL);
    const cy1 = Math.floor(r.y1 / CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) yield cy * 4096 + cx;
  }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Where a badge may sit, in steps of (radius + 6) px from its anchor ant, in order of preference. */
const BADGE_SPOTS = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1], [0, -2], [0, 2], [2, 0], [-2, 0]] as const;

/** A badge's (radius r) candidate spots around its anchor ant at (sx, sy), in BADGE_SPOTS order. */
function badgeSpots(sx: number, sy: number, r: number): Rect[] {
  return BADGE_SPOTS.map(([dx, dy]) => {
    const cx = Math.round(sx + dx * (r + 6));
    const cy = Math.round(sy + dy * (r + 6));
    return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
  });
}

/**
 * Further spots for a badge that has none of its BADGE_SPOTS clear of the markers and labels (a crowded phone board,
 * Review): centre offsets on a NEAR_STEP px grid within NEAR_MAX px of the anchor ant, nearest first.
 */
const NEAR_STEP = 4;
const NEAR_MAX = 56;
const NEAR_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let dy = -NEAR_MAX; dy <= NEAR_MAX; dy += NEAR_STEP) {
    for (let dx = -NEAR_MAX; dx <= NEAR_MAX; dx += NEAR_STEP) if ((dx !== 0 || dy !== 0) && Math.hypot(dx, dy) <= NEAR_MAX) out.push([dx, dy]);
  }
  return out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
})();

/** A badge's (radius r) further spots around its anchor ant at (sx, sy), nearest first (NEAR_OFFSETS). */
function nearSpots(sx: number, sy: number, r: number): Rect[] {
  return NEAR_OFFSETS.map(([dx, dy]) => {
    const cx = Math.round(sx + dx);
    const cy = Math.round(sy + dy);
    return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
  });
}

function onScreen(s: Rect, [w, h]: readonly [number, number]): boolean {
  return s.x0 >= 0 && s.y0 >= 0 && s.x1 <= w && s.y1 <= h;
}

function clearOf(s: Rect, rects: readonly Rect[]): boolean {
  return !rects.some((d) => overlaps(s, d));
}

/**
 * Place each squad's badge (radius r) beside its anchor ant, in the order given,
 * into a placer that already holds the overlays and the markers (dots): the
 * first spot that is free; else the first that covers no marker and no mark label
 * (labels); else the nearest further spot (nearSpots) that is free, else
 * on screen and clear of the markers and labels; else the first that covers no
 * marker, the label it covers moving instead (Words.paint); else just above the ant. A badge is never dropped
 * and never covers a marker while a spot clear of the markers exists, since taps
 * go to badges before marks.
 */
export function placeBadges(placer: Placer, anchors: readonly (readonly [number, number, number])[], r: number, dots: readonly Rect[], labels: readonly Rect[] = []): Map<number, Rect> {
  const out = new Map<number, Rect>();
  for (const [agent, sx, sy] of anchors) {
    const spots = badgeSpots(sx, sy, r);
    const clear = (s: Rect) => clearOf(s, dots) && clearOf(s, labels);
    const near = () => nearSpots(sx, sy, r);
    const spot =
      spots.find((s) => placer.free(s)) ??
      spots.find(clear) ??
      near().find((s) => placer.free(s)) ??
      near().find((s) => onScreen(s, placer.size) && clear(s)) ??
      spots.find((s) => clearOf(s, dots)) ??
      spots[0]!;
    placer.occupy(spot);
    out.set(agent, spot);
  }
  return out;
}

/** The screen rect a marker at (x, y) takes in the layout: the whole ping and its halo, so a badge does not touch it. */
export function markerRect(x: number, y: number): Rect {
  const h = MARK_DOT.ring + 3;
  return { x0: x - h, y0: y - h, x1: x + h, y1: y + h };
}

// ---------------------------------------------------------------- markers

export interface MarkStats {
  /** Live marks this frame, each drawn as a marker. */
  marks: number;
  markers: number;
  /** Count marks with their label drawn beside them: the ones the layout had room for. */
  labels: number;
  /** Id of the live mark the most ants answered, and how many answered it. */
  topMark: number | null;
  topAnswered: number;
  /** Badges drawn over a marker: only when every spot beside the badge's ant is taken (placeBadges' last resort). */
  badgesOnDots: number;
}

/**
 * A mark's reading, as the stream carries it, for the tooltip, the feed and the agent's card: a count mark's verb, count and the ants answering it,
 * "ATTACK · 20 requested · 12 answered" (the board label keeps its own form, markLabel); a word mark's
 * words as written, "ATTACK · W · FEW", never glossed into a sentence. "" for a count mark from a stream that
 * carries no verb or count (an older recording): its marker, byline and card line stand without words,
 * since a raw identifier is never copy, and its tooltip says the details are unavailable (tipContent).
 */
export function markReading(m: { words: readonly number[]; verb?: string; count?: number; claimed?: number; caste?: string }): string {
  // A word mark is the agent's own words: in quotation marks wherever it is read, so it never reads as a game value.
  if (!isCountMark(m)) return `“${wordsText(m.words)}”`;
  if (m.verb === undefined || m.count === undefined) return "";
  const order = `${m.verb} · ${m.caste === undefined ? "" : `${m.caste} · `}${m.count} ${OPEN_COPY.requested}`;
  return m.claimed === undefined ? order : `${order} · ${m.claimed} ${OPEN_COPY.answered}`;
}

/**
 * The detail of a wordless mark the stream carries no verb for, when its marker is pointed at or tapped:
 * "Triangle's mark · tile 30, 32", with the one line under
 * it that the recording lacks the command's details; such a mark has no line in the feed.
 */
export function wordlessMarkTip(m: Pick<StreamMark, "agent" | "tileX" | "tileY">): string {
  return `${agentHandle(m.agent)}'s mark · tile ${m.tileX}, ${m.tileY}`;
}

/** A count mark's compact reading, caste word and answered/requested count (the HUD's line); full tooltip/feed copy stays in markReading. */
export function markLabel(m: { words: readonly number[]; verb?: string; count?: number; claimed?: number; caste?: string }): string | null {
  return isCountMark(m) && markSymbol(m.verb) !== null && m.count !== undefined && m.claimed !== undefined ? `${m.caste === undefined ? "" : `${m.caste} · `}${m.claimed}/${m.count}` : null;
}

/** The castes a board label shows as an icon (CASTE_ICON_PATH); "any" and an absent caste have none. */
export type LabelCaste = keyof typeof CASTE_ICON_PATH;

/**
 * What a count mark's board label draws: its caste as the caste's
 * icon, in place of the word, and its answered/requested count, "10/10"; a mark with no caste, or any caste, its count
 * alone. No kind symbol (its marker beside it carries that) and never an icon without its count. Null where markLabel
 * gives no label. The tooltip keeps the whole reading (markReading).
 */
export function boardLabel(m: { words: readonly number[]; verb?: string; count?: number; claimed?: number; caste?: string }): { figure: string; caste: LabelCaste | null } | null {
  if (markLabel(m) === null) return null;
  const caste = m.caste === "worker" || m.caste === "soldier" ? m.caste : null;
  return { figure: `${m.claimed}/${m.count}`, caste };
}

/**
 * A mark laid at `laidTick`, its age at playback tick `now`: the match clock's whole seconds
 * since the second it was laid in, "12s ago", "1m 05s ago". It changes only as the playback
 * second turns, so the log line and the tooltip, re-texted at different ticks within a
 * second, read the same.
 */
export function markAge(laidTick: number, now: number, tps: number): string {
  const t = Math.max(1, tps);
  const s = Math.max(0, Math.floor(now / t) - Math.floor(laidTick / t));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s ago`;
}

/**
 * The tooltip's line under a mark's gloss: who laid it and how long ago, at playback tick
 * `now`. Only characters the tooltip's bitmap font carries.
 */
export function markByline(m: Pick<StreamMark, "agent" | "laidTick">, now: number, tps: number): string {
  return `by ${agentHandle(m.agent)}, ${markAge(m.laidTick, now, tps)}`;
}

/** One block of a tooltip (web/src/tip.ts): a head line, a line under it and a meta line, each empty where there is none. */
export interface TipRow {
  head: string;
  body: string;
  meta: string;
}

/** What a tooltip shows and where: beside `target` (a screen rect), its edge in `colour` (an RGB number), its rows in order. */
export interface TipContent {
  target: Rect;
  colour: number;
  rows: TipRow[];
}

/** How near (CSS px) a pointer must come to a marker to show its tooltip. */
const FOCUS_PX = 16;

/** A mark's label on the board: its count as bitmap text, its caste's icon or none, and the box it takes in the layout. */
interface Label {
  text: BitmapText;
  caste: LabelCaste | null;
  w: number;
  h: number;
  /** Its box on screen, the plate's, while placed. */
  rect: Rect | null;
}

/** The backing behind a label's icon and count: its padding each side, CSS px. */
const LABEL_PAD = { x: 4, y: 2 } as const;
/**
 * The backing's opacity: translucent, so the ground shows through and the label covers little of the board
 * (small and translucent rather than an opaque black plate). The count's and the icon's dark outlines keep both readable on light ground; the
 * backing deepens dark ground behind them. Constant through the mark's life (the marker's ring shows the age).
 */
export const LABEL_PLATE_ALPHA = 0.4;
/** A caste icon's stroke in its 24-unit box (as the HUD draws it, ui/deck/icons.ts), and its dark outline each side, CSS px. */
const ICON_STROKE = 2.6;
const ICON_OUTLINE_PX = 1.25;
/** Each caste's icon path, parsed once. */
const CASTE_PATHS: Record<LabelCaste, GraphicsPath> = { worker: new GraphicsPath(CASTE_ICON_PATH.worker), soldier: new GraphicsPath(CASTE_ICON_PATH.soldier) };

/**
 * Each standing queen's nest on screen, her tile and the queen zone's radius around it, as a rect for the layout to
 * keep the marks' labels and the squads' badges clear of (labels sit beside clusters,
 * never across nests or queens). Positions are the stream's, in sub-tiles.
 */
export function nestRects(queens: readonly { x: number; y: number; lostTick: number | null }[], radiusTiles: number, toScreen: (tx: number, ty: number) => [number, number]): Rect[] {
  return queens
    .filter((q) => q.lostTick === null)
    .map((q) => {
      const tx = Math.floor(q.x / SUB_TILE);
      const ty = Math.floor(q.y / SUB_TILE);
      const [ax, ay] = toScreen(tx - radiusTiles, ty - radiusTiles);
      const [bx, by] = toScreen(tx + 1 + radiusTiles, ty + 1 + radiusTiles);
      return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    });
}

/**
 * The ground around one queen (her tile and radiusTiles around it) as the screen box of its four corners through the
 * board's camera, lost or standing: on the tilted 3D board that ground is a trapezoid, so its box takes every corner.
 * The stills' fall check reads it (web/capture/scene-checks.ts: the fallen queen whole in frame at every viewport).
 */
export function nestZoneRect(q: { x: number; y: number }, radiusTiles: number, toScreen: (tx: number, ty: number) => [number, number]): Rect {
  const tx = Math.floor(q.x / SUB_TILE);
  const ty = Math.floor(q.y / SUB_TILE);
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [cx, cy] of [[tx - radiusTiles, ty - radiusTiles], [tx + 1 + radiusTiles, ty - radiusTiles], [tx - radiusTiles, ty + 1 + radiusTiles], [tx + 1 + radiusTiles, ty + 1 + radiusTiles]] as const) {
    const [x, y] = toScreen(cx, cy);
    r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x);
    r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y);
  }
  return r;
}

/**
 * The short leader from a marker's ring to its label's plate: from the ring's edge
 * to the plate's near edge, on the side the plate lies (labelSpots: right, left, under, over), as [x0, y0, x1, y1].
 */
export function leaderLine(x: number, y: number, plate: Rect): [number, number, number, number] {
  const r = MARK_DOT.ring;
  if (plate.x0 >= x + r) return [x + r, y, plate.x0, y];
  if (plate.x1 <= x - r) return [x - r, y, plate.x1, y];
  if (plate.y0 >= y + r) return [x, y + r, x, plate.y0];
  return [x, y - r, x, plate.y1];
}

/**
 * Where a label of w x h may sit beside the marker at (x, y), in order of preference: to its
 * right, to its left, under it, over it, each clear of the marker's halo (markerRect) by the
 * layout's gap. Rounded to whole px, so the text stays crisp.
 */
export function labelSpots(x: number, y: number, w: number, h: number): Rect[] {
  const d = MARK_DOT.ring + 8;
  const at = (x0: number, y0: number): Rect => ({ x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0) + w, y1: Math.round(y0) + h });
  return [at(x + d, y - h / 2), at(x - d - w, y - h / 2), at(x - w / 2, y + d), at(x - w / 2, y - d - h)];
}

/**
 * A LINE mark's dotted line, CSS px: each
 * dot's radius, the spacing between dot centres along the projected line, and the larger dot at its far end.
 */
export const LINE_DOTS = { r: 2, step: 8, endR: 3.5 } as const;

/** A LINE mark's second endpoint, when the stream carries both of its fields (version 22); null for every other mark. */
export function lineEnd(m: Pick<StreamMark, "verb" | "toTileX" | "toTileY">): { tileX: number; tileY: number } | null {
  return m.verb === "LINE" && m.toTileX !== undefined && m.toTileY !== undefined ? { tileX: m.toTileX, tileY: m.toTileY } : null;
}

/**
 * The dotted line from a LINE mark's marker at screen (x, y) to its far end: points sampled in tile space between the
 * two tile centres and projected one by one through toScreen, so on the 3D board they follow the ground's relief, about
 * LINE_DOTS.step px apart on screen. Dots under the marker's ring or the end dot are left out; non-finite points too.
 */
export function lineDots(m: Pick<StreamMark, "tileX" | "tileY">, end: { tileX: number; tileY: number }, x: number, y: number, toScreen: (tx: number, ty: number) => [number, number]): { dots: [number, number][]; end: [number, number] } | null {
  const [ex, ey] = toScreen(end.tileX + 0.5, end.tileY + 0.5);
  if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
  const n = Math.max(1, Math.ceil(Math.hypot(ex - x, ey - y) / LINE_DOTS.step));
  const dots: [number, number][] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const [dx, dy] = toScreen(m.tileX + 0.5 + (end.tileX - m.tileX) * t, m.tileY + 0.5 + (end.tileY - m.tileY) * t);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (Math.hypot(dx - x, dy - y) < MARK_DOT.ring + LINE_DOTS.r + 1 || Math.hypot(dx - ex, dy - ey) < LINE_DOTS.endR + LINE_DOTS.r + 1) continue;
    dots.push([dx, dy]);
  }
  return { dots, end: [ex, ey] };
}

/** Where a label's count starts after its padding: past the caste icon (px square) and a gap, or at once with no icon. */
function figureOffset(px: number, icon: boolean): number {
  return icon ? px + 4 : 1;
}

/**
 * Plex Mono's advance is 0.6 em, so a label's box, icon, count and backing, is known without measuring the text
 * (which needs a DOM): the count's advance, after the caste icon when there is one.
 */
export function labelSize(figure: string, px: number, icon: boolean): { w: number; h: number } {
  return { w: figureOffset(px, icon) + Math.ceil(figure.length * px * 0.6) + 2 + 2 * LABEL_PAD.x, h: Math.ceil(px * 1.25) + 2 * LABEL_PAD.y };
}

export class Words {
  /** The markers: one Graphics, redrawn every frame on the layout's points, so the layer draws in one batch; then the labels beside them. */
  readonly layer = new Container();
  private readonly dotG = new Graphics();
  private readonly icons = new IconSprites();
  /** The labels' backings, caste icons and leaders, one Graphics under the label texts. */
  private readonly plateG = new Graphics();
  private readonly labelLayer = new Container();
  /** Each live mark's label, by mark id, kept while the mark is live. */
  private labels = new Map<number, Label>();
  private labelPx = 0;
  private screen: { w: number; h: number };
  private key: unknown[] = [];
  private showLabels = true;

  get labelsVisible(): boolean {
    return this.showLabels;
  }

  /** Invalidate placement and drop label hit targets immediately, even while playback is paused. */
  setLabelsVisible(on: boolean): void {
    if (on === this.showLabels) return;
    this.showLabels = on;
    this.key = [];
    if (!on) {
      this.plateG.clear();
      for (const label of this.labels.values()) {
        label.text.visible = false;
        label.rect = null;
      }
      this.stats.labels = 0;
    }
  }
  /** Each live mark and its marker's screen point, at the last layout; and by mark id, for the paint. */
  private points: { mark: StreamMark; x: number; y: number }[] = [];
  private pointById = new Map<number, { mark: StreamMark; x: number; y: number }>();
  /** Each live LINE mark's dotted line at the last layout, by mark id (lineDots). */
  private lines = new Map<number, { dots: [number, number][]; end: [number, number] }>();
  /**
   * Each squad's badge offset from its anchor ant at the last layout, by agent: the placement choice, which the
   * badge keeps as it follows its ant every frame; and the badge radius.
   */
  private badgeOffsets = new Map<number, readonly [number, number]>();
  private badgeR = 0;
  /** The markers' and LINE ends' rects, and the HTML overlays, at the last layout: what a badge or label moved off another keeps clear of. */
  private dots: Rect[] = [];
  private blocked: readonly Rect[] = [];
  /** The mark whose tooltip shows because the pointer is on its marker, it was tapped, or its log line was chosen; or null. */
  focus: number | null = null;
  /**
   * The mark whose log line was chosen, or null. It stays focused while the
   * pointer moves over the board: hovering another marker shows that one instead, and
   * moving off it returns to this one, until a click or tap on the board, Escape or a
   * press on another control clears it.
   */
  chosen: number | null = null;
  /** The playback tick and ticks per second of the last update, for the tooltip's ages. */
  private now = 0;
  private tps = 10;
  /** The board's agents at the last update, for each mark's agent hue (agentShade). */
  private agents: readonly Pick<StreamAgent, "colony">[] = [];
  /** The placer of the last layout. */
  placer: Placer;
  stats: MarkStats = { marks: 0, markers: 0, labels: 0, topMark: null, topAnswered: 0, badgesOnDots: 0 };
  /** Each squad's badge spot at the last layout, by agent: placed after the markers, clear of them. */
  badges = new Map<number, Rect>();

  constructor(screen: { w: number; h: number }) {
    this.screen = screen;
    this.setSizes(screen.w);
    this.placer = new Placer(screen.w, screen.h);
    this.layer.addChild(this.dotG, this.plateG, this.labelLayer, this.icons.layer);
  }

  private setSizes(screenW: number): void {
    this.labelPx = markLabelPx(screenW);
  }

  /** The screen changed size (resize or rotation): the labels are rebuilt at sizes for the new screen. */
  resize(screen: { w: number; h: number }): void {
    this.screen = { w: screen.w, h: screen.h };
    this.setSizes(screen.w);
    for (const l of this.labels.values()) l.text.destroy();
    this.labels.clear();
    this.placer = new Placer(screen.w, screen.h);
    this.key = [];
  }

  /** Each label drawn now: its mark, the count it draws and its box, for checks of what is on screen. */
  drawnLabels(): { id: number; text: string; rect: Rect }[] {
    return [...this.labels].flatMap(([id, l]) => (l.text.visible && l.rect !== null ? [{ id, text: l.text.text, rect: l.rect }] : []));
  }

  /** The label for mark `id`, drawing `figure` after `caste`'s icon: made once per live mark, re-texted as its claims change. */
  private label(id: number, figure: string, caste: LabelCaste | null): Label {
    let l = this.labels.get(id);
    if (!l) {
      const text = new BitmapText({ text: figure, style: { fontFamily: GLOSS_FONT, fontSize: this.labelPx } });
      this.labelLayer.addChild(text);
      l = { text, caste, w: 0, h: 0, rect: null };
      this.labels.set(id, l);
    } else if (l.text.text !== figure) l.text.text = figure;
    l.caste = caste;
    const size = labelSize(figure, this.labelPx, caste !== null);
    l.w = size.w;
    l.h = size.h;
    return l;
  }

  /** The live mark whose marker lies within FOCUS_PX of a screen point (the nearest), or null. */
  markAt(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = FOCUS_PX;
    for (const p of this.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestD) {
        bestD = d;
        best = p.mark.id;
      }
    }
    return best;
  }

  /**
   * The mark whose label's plate lies under a screen point (the label is its own
   * target), or null. On touch a plate's box is widened to at least TOUCH_TARGET_PX each way;
   * where widened boxes overlap, the plate whose centre is nearest wins.
   */
  labelAt(x: number, y: number, touch = false): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (const [id, l] of this.labels) {
      const r = l.rect;
      if (!l.text.visible || r === null) continue;
      const px = touch ? Math.max(0, (TOUCH_TARGET_PX - (r.x1 - r.x0)) / 2) : 0;
      const py = touch ? Math.max(0, (TOUCH_TARGET_PX - (r.y1 - r.y0)) / 2) : 0;
      if (x < r.x0 - px || x > r.x1 + px || y < r.y0 - py || y > r.y1 + py) continue;
      const d = Math.hypot((r.x0 + r.x1) / 2 - x, (r.y0 + r.y1) / 2 - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** A mark's log line was chosen: focus it and keep it focused through pointer moves. */
  choose(id: number): void {
    this.chosen = this.focus = id;
  }

  /** The pointer moved over the board (or left it, with no point): the marker or label under it, else the chosen mark. */
  hoverAt(x?: number, y?: number): void {
    this.focus = (x === undefined || y === undefined ? null : (this.markAt(x, y) ?? this.labelAt(x, y))) ?? this.chosen;
  }

  /** No mark focused or chosen. */
  clearFocus(): void {
    this.chosen = this.focus = null;
  }

  /**
   * A click or tap on the board, with whether an ant lies under it: a mark's label under it always opens that mark
   * (the label is its own reliable target, never shadowed by
   * ants) and the tap is the label's, which is returned; else the marker under it shows its tooltip, except on
   * touch with an ant under the same tap, where the ant wins and no mark tooltip shows;
   * a mouse click keeps the mark. A chosen log line is let go either way.
   */
  tapAt(x: number, y: number, onAnt: boolean, touch: boolean): boolean {
    this.chosen = null;
    const label = this.labelAt(x, y, touch);
    this.focus = label ?? (touch && onAnt ? null : this.markAt(x, y));
    return label !== null;
  }

  /**
   * The stills' squad tap: of an agent's ants
, the screen
   * points of those standing on the tile of a live mark of its own or a tile adjacent to it, the nearest to its
   * marker first, so the stills can take the first of them on the uncovered board; empty when none stands on its
   * own mark now.
   */
  antsOnOwnMark(frame: Frame, agent: number, toScreen: (tx: number, ty: number) => [number, number]): [number, number][] {
    const found: { s: [number, number]; d: number }[] = [];
    for (let i = 0; i < frame.count; i++) {
      if (frame.agent[i] !== agent) continue;
      const tx = Math.floor(frame.x[i]!);
      const ty = Math.floor(frame.y[i]!);
      const s = toScreen(frame.x[i]!, frame.y[i]!);
      let d = Infinity;
      for (const p of this.points) {
        if (p.mark.agent === agent && Math.abs(p.mark.tileX - tx) <= 1 && Math.abs(p.mark.tileY - ty) <= 1) d = Math.min(d, Math.hypot(s[0] - p.x, s[1] - p.y));
      }
      if (d < Infinity) found.push({ s, d });
    }
    return found.sort((a, b) => a.d - b.d).map((f) => f.s);
  }

  /** Each marker drawn now: its mark, screen point and steering count, for the stills driver. */
  markers(): { id: number; x: number; y: number; answered: number }[] {
    return this.points.map((p) => ({ id: p.mark.id, x: p.x, y: p.y, answered: p.mark.answered }));
  }

  /** Each LINE mark's dotted line drawn now: its mark, dots and far end on screen, for checks of what is on screen. */
  drawnLines(): { id: number; dots: [number, number][]; end: [number, number] }[] {
    return [...this.lines].map(([id, l]) => ({ id, dots: l.dots, end: l.end }));
  }

  /**
   * Lay out and fade this frame's markers. blocked: screen areas covered by the
   * HTML overlays. viewKey changes whenever the camera moves. badgeAnchors: each
   * squad's badge anchor ant on screen [agent, x, y], in rank order, and badgeR
   * the badge radius: the badges are placed after the markers.
   */
  update(frame: Frame, toScreen: (tx: number, ty: number) => [number, number], blocked: readonly Rect[], viewKey: unknown, badgeAnchors: readonly (readonly [number, number, number])[] = [], badgeR = 0): Placer {
    const visible = frame.marks;
    this.now = frame.tick;
    this.agents = frame.board?.agents ?? [];
    this.tps = frame.board?.setup?.ticksPerSecond || 10;
    // Placement is chosen again when the marks, the view or the squads change, and otherwise at most once a
    // playback second; the alphas and the badges' positions are painted every frame (only
    // placement choices are cached; transforms and opacity are computed every frame).
    const key = [frame.board?.marks ?? null, viewKey, blocked.length, visible.length, badgeAnchors.length, Math.floor(frame.tick / 10)];
    if (key.some((v, i) => v !== this.key[i])) {
      this.key = key;
      this.layout(frame, toScreen, blocked, badgeAnchors, badgeR);
    }
    this.paint(frame, badgeAnchors);
    const top = visible.reduce<StreamMark | null>((best, v) => (best === null || v.mark.answered > best.answered || (v.mark.answered === best.answered && v.mark.id > best.id) ? v.mark : best), null);
    this.stats = { marks: visible.length, markers: this.points.length, labels: this.stats.labels, topMark: top?.id ?? null, topAnswered: top?.answered ?? 0, badgesOnDots: this.stats.badgesOnDots };
    return this.placer;
  }

  /** The placement choices: each marker's point, each label's spot, each badge's offset from its anchor. */
  private layout(frame: Frame, toScreen: (tx: number, ty: number) => [number, number], blocked: readonly Rect[], badgeAnchors: readonly (readonly [number, number, number])[], badgeR: number): void {
    // One placer, seeded in order: the overlays, the markers with their labels, then the badges.
    const placer = new Placer(this.screen.w, this.screen.h, blocked);
    const dots: Rect[] = [];
    this.points = [];
    this.pointById = new Map();
    const labelled = new Set<number>();
    for (const { mark: m } of frame.marks) {
      const [sx, sy] = toScreen(m.tileX + 0.5, m.tileY + 0.5);
      const x = Math.round(sx);
      const y = Math.round(sy);
      const r = markerRect(x, y);
      placer.occupy(r);
      dots.push(r);
      const p = { mark: m, x, y };
      this.points.push(p);
      this.pointById.set(m.id, p);
    }
    // A LINE mark's far end is kept clear like a marker, so labels and badges do not sit on it; its dots are not reserved.
    this.lines = new Map();
    for (const { mark: m } of frame.marks) {
      const end = lineEnd(m);
      const p = this.pointById.get(m.id)!;
      const line = end === null ? null : lineDots(m, end, p.x, p.y, toScreen);
      if (line === null) continue;
      this.lines.set(m.id, line);
      const h = LINE_DOTS.endR + 3;
      const r = { x0: line.end[0] - h, y0: line.end[1] - h, x1: line.end[0] + h, y1: line.end[1] + h };
      placer.occupy(r);
      dots.push(r);
    }
    // Then each count mark's label beside its marker, in the owner's shade, where the layout has room (every
    // marker, panel and nest is already reserved); a crowded mark keeps its reading for the tooltip.
    for (const { mark: m } of frame.marks) {
      const p = this.pointById.get(m.id)!;
      const board = this.showLabels ? boardLabel(m) : null;
      if (board === null) continue;
      const label = this.label(m.id, board.figure, board.caste);
      const spot = labelSpots(p.x, p.y, label.w, label.h).find((s) => placer.free(s));
      if (spot === undefined) continue;
      placer.occupy(spot);
      this.placeLabel(label, spot);
      label.text.tint = agentShade(m.colony, m.agent, this.agents);
      label.text.visible = true;
      labelled.add(m.id);
    }
    const live = new Set(frame.marks.map((v) => v.mark.id));
    for (const [id, l] of this.labels) {
      if (labelled.has(id)) continue;
      if (live.has(id)) {
        l.text.visible = false;
        l.rect = null;
      } else {
        l.text.destroy();
        this.labels.delete(id);
      }
    }
    this.stats.labels = labelled.size;
    this.badges = placeBadges(placer, badgeAnchors, badgeR, dots, [...this.labels.values()].flatMap((l) => (l.rect === null ? [] : [l.rect])));
    this.badgeR = badgeR;
    this.dots = dots;
    this.blocked = blocked;
    this.badgeOffsets = new Map();
    for (const [agent, sx, sy] of badgeAnchors) {
      const b = this.badges.get(agent);
      if (b) this.badgeOffsets.set(agent, [(b.x0 + b.x1) / 2 - sx, (b.y0 + b.y1) / 2 - sy]);
    }
    this.stats.badgesOnDots = [...this.badges.values()].filter((b) => dots.some((d) => overlaps(b, d))).length;
    this.placer = placer;
  }

  /**
   * Every frame, on the layout's choices: each marker's ring and glyph at its age's alpha, each placed label's
   * backing, caste icon and leader, and each badge's spot at its offset from its anchor ant now, so badges move with their
   * ants and fades run smoothly. In a mark's last MARK_EXIT_MS its ring, backing, icon, leader and count fade out
   * together, in place, instead of vanishing.
   */
  private paint(frame: Frame, badgeAnchors: readonly (readonly [number, number, number])[]): void {
    this.dotG.clear();
    this.plateG.clear();
    this.icons.reset();
    // The badges, at their layout offsets from their anchor ants now: a fresh map, so the squads redraw them. The
    // badges draw above the markers and labels and take taps first, so neither is left under one: a
    // badge that lands on a marker or a label (its ant moving since the layout) moves to its first spot beside the ant
    // clear of the markers, and of the labels where it can, and keeps that spot; a label a badge still covers moves to
    // its first spot beside its marker clear of the badges, the markers and the other labels. Labels stay shown.
    const badges = this.paintBadges(badgeAnchors);
    this.badges = badges;
    this.moveLabelsOffBadges([...badges.values()]);
    const dot = MARK_DOT;
    for (const { mark: m, ageMs } of frame.marks) {
      const p = this.pointById.get(m.id);
      if (!p) continue;
      const exit = exitAlpha(ageMs);
      const a = fadeAlpha(ageMs) * exit;
      const shade = agentShade(m.colony, m.agent, this.agents);
      // A LINE mark's dotted line runs under its marker to the larger far-end dot, in the owner's shade at the marker's alpha.
      const line = this.lines.get(m.id);
      if (line) {
        for (const [x, y] of line.dots) this.dotG.circle(x, y, LINE_DOTS.r).fill({ color: shade, alpha: a }).stroke({ width: 1.5, color: 0x000000, alpha: 0.7 * a });
        this.dotG.circle(line.end[0], line.end[1], LINE_DOTS.endR).fill({ color: shade, alpha: a }).stroke({ width: 1.5, color: 0x000000, alpha: 0.8 * a });
      }
      // The owner's hue remains on the ring; a known command replaces the owner glyph inside it.
      this.dotG.circle(p.x, p.y, dot.ring).stroke({ width: dot.ringW + 2.5, color: 0x000000, alpha: 0.6 * a });
      this.dotG.circle(p.x, p.y, dot.ring).stroke({ width: dot.ringW, color: shade, alpha: a });
      const symbol = markSymbol(m.verb);
      const pts = symbol === null ? glyphPolygon(m.agent, dot.glyph) : markSymbolPolygon(symbol, dot.glyph);
      if (!this.icons.draw(symbol === null ? glyphIconKey(m.agent) : `mark-${symbol}`, p.x - dot.glyph, p.y - dot.glyph, 2 * dot.glyph, 2 * dot.glyph, shade, a, 1.5)) this.dotG.poly(pts.map((v, i) => v + (i % 2 === 0 ? p.x : p.y))).fill({ color: shade, alpha: a }).stroke({ width: 1.5, color: 0x000000, alpha: 0.8 * a });
      const l = this.labels.get(m.id);
      if (!l || l.rect === null || !l.text.visible) continue;
      const spot = l.rect;
      // On a translucent dark backing, constant as the mark fades (the ring carries the age), with a short
      // leader from the ring to the backing.
      this.plateG.roundRect(spot.x0, spot.y0, spot.x1 - spot.x0, spot.y1 - spot.y0, 3).fill({ color: 0x0b0907, alpha: LABEL_PLATE_ALPHA * exit });
      // The caste's own line icon (CASTE_ICON_PATH, as the HUD draws it) in a px square before the count: a dark
      // outline under the owner's shade, so it reads on light and dark ground. No kind symbol: the marker shows it.
      if (l.caste !== null) this.casteIcon(l.caste, spot.x0 + LABEL_PAD.x, (spot.y0 + spot.y1) / 2 - this.labelPx / 2, shade, exit);
      const [lx0, ly0, lx1, ly1] = leaderLine(p.x, p.y, spot);
      this.plateG.moveTo(lx0, ly0).lineTo(lx1, ly1).stroke({ width: 1.5, color: shade, alpha: 0.9 * exit });
      l.text.alpha = exit;
    }
  }

  /** A label's box at spot, its count after the caste icon's room. */
  private placeLabel(l: Label, spot: Rect): void {
    l.text.position.set(spot.x0 + LABEL_PAD.x + figureOffset(this.labelPx, l.caste !== null), spot.y0 + LABEL_PAD.y);
    l.rect = spot;
  }

  /** Each badge at its offset from its anchor ant now; one on a marker or a label moves to a spot beside the ant clear of the markers (and of the labels where it can), and keeps it. */
  private paintBadges(badgeAnchors: readonly (readonly [number, number, number])[]): Map<number, Rect> {
    const labels = [...this.labels.values()].flatMap((l) => (l.rect === null || !l.text.visible ? [] : [l.rect]));
    const badges = new Map<number, Rect>();
    const r = this.badgeR;
    for (const [agent, sx, sy] of badgeAnchors) {
      const off = this.badgeOffsets.get(agent);
      if (!off) continue;
      const cx = sx + off[0];
      const cy = sy + off[1];
      let b: Rect = { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
      if (!clearOf(b, labels) || !clearOf(b, this.dots)) {
        // Never over a marker while a spot clear of the markers exists, so a tap on a marker reaches its mark (taps go
        // to badges first); among those (its BADGE_SPOTS, then its further spots, nearest first, on screen and off the
        // overlays), one clear of the labels too, else the badge stays (or takes the first) and the label it covers
        // moves (moveLabelsOffBadges).
        const others = [...badges.values()];
        const screen = [this.screen.w, this.screen.h] as const;
        const spots = [...badgeSpots(sx, sy, r), ...nearSpots(sx, sy, r)].filter((s) => onScreen(s, screen) && clearOf(s, this.dots) && clearOf(s, this.blocked));
        const spot = spots.find((s) => clearOf(s, labels) && clearOf(s, others)) ?? spots.find((s) => clearOf(s, labels)) ?? (clearOf(b, this.dots) ? undefined : spots[0]);
        if (spot !== undefined) {
          b = spot;
          this.badgeOffsets.set(agent, [(spot.x0 + spot.x1) / 2 - sx, (spot.y0 + spot.y1) / 2 - sy]);
        }
      }
      badges.set(agent, b);
    }
    return badges;
  }

  /** Each shown label a badge still covers, moved to its first spot beside its marker clear of the badges, the markers and the other labels. */
  private moveLabelsOffBadges(badges: readonly Rect[]): void {
    for (const [id, l] of this.labels) {
      const rect = l.rect;
      if (rect === null || !l.text.visible || clearOf(rect, badges)) continue;
      const p = this.pointById.get(id);
      if (!p) continue;
      const others = [...this.labels].flatMap(([o, ol]) => (o === id || ol.rect === null || !ol.text.visible ? [] : [ol.rect]));
      const onScreen = (s: Rect) => s.x0 >= 0 && s.y0 >= 0 && s.x1 <= this.screen.w && s.y1 <= this.screen.h;
      const spot = labelSpots(p.x, p.y, l.w, l.h).find((s) => onScreen(s) && clearOf(s, badges) && clearOf(s, this.dots) && clearOf(s, this.blocked) && clearOf(s, others));
      if (spot !== undefined) this.placeLabel(l, spot);
    }
  }

  /** A caste's icon in a labelPx square at (x, y): its 24-unit path scaled, stroked dark then in the shade. */
  private casteIcon(caste: LabelCaste, x: number, y: number, shade: number, alpha: number): void {
    if (this.icons.draw(caste, x, y, this.labelPx, this.labelPx, shade, alpha, ICON_OUTLINE_PX)) return;
    const k = this.labelPx / 24;
    const style = { cap: "round", join: "round" } as const;
    this.plateG.save().setTransform(k, 0, 0, k, x, y);
    this.plateG.path(CASTE_PATHS[caste]).stroke({ ...style, width: ICON_STROKE + (2 * ICON_OUTLINE_PX) / k, color: 0x000000, alpha: 0.8 * alpha });
    this.plateG.path(CASTE_PATHS[caste]).stroke({ ...style, width: ICON_STROKE, color: shade, alpha });
    this.plateG.restore();
  }

  /**
   * The marks the tooltip shows: every live mark on the focused marker's tile, the newest first.
   * Marks may share a tile (src/sim/agents.ts layMark), and each one's words and gloss must be
   * readable, so the tooltip lists them all, one block per mark.
   */
  tipMarks(): StreamMark[] {
    const p = this.focus === null ? undefined : this.points.find((q) => q.mark.id === this.focus);
    if (!p) return [];
    return this.points
      .filter((q) => q.mark.tileX === p.mark.tileX && q.mark.tileY === p.mark.tileY)
      .map((q) => q.mark)
      .sort((a, b) => b.id - a.id);
  }

  /**
   * The focused marker's tooltip (drawn by web/src/tip.ts in the page's own type above
   * every panel): beside the marker, in the newest mark's owner's shade, one block per
   * mark on its tile (tipMarks): the reading (markReading), then who laid it and how long ago, current to the
   * playback second (markByline); a wordless mark whose details the recording lacks reads wordlessMarkTip's
   * line with "Command details unavailable in this recording" under it (only then, never
   * for a mark with its details). Null while no mark is focused.
   */
  tipContent(): TipContent | null {
    const marks = this.tipMarks();
    const p = this.points.find((q) => q.mark.id === this.focus);
    if (!p || marks.length === 0) return null;
    const first = marks[0]!;
    return {
      target: markerRect(p.x, p.y),
      colour: agentShade(first.colony, first.agent, this.agents),
      rows: marks.map((m) => {
        const reading = markReading(m);
        if (reading === "") return { head: wordlessMarkTip(m), body: OPEN_COPY.noDetails, meta: "" };
        return { head: reading, body: "", meta: markByline(m, this.now, this.tps) };
      }),
    };
  }
}

function fadeAlpha(ageMs: number): number {
  return Math.min(1, ageMs / FADE_IN_MS) * (0.45 + 0.55 * (1 - ageMs / MARK_LIFE_MS));
}

/** A mark's last moments: its marker and label fade out together over this long before playback drops it. */
export const MARK_EXIT_MS = 800;

/** 1 through a mark's life, falling to 0 over its last MARK_EXIT_MS. */
export function exitAlpha(ageMs: number): number {
  return Math.min(1, Math.max(0, (MARK_LIFE_MS - ageMs) / MARK_EXIT_MS));
}
