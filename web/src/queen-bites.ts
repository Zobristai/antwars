/**
 * The bite cues at a queen fight, the same on both boards, drawn in screen space above the emblems (Frame.queenPulse,
 * stream version 32; nothing on recordings without it):
 * - her bite: four corner brackets in her colony colour round the ant she bites, the zone brackets' stroke, sized
 *   clamp(1.15 × its drawn body, 16, 64) CSS px, and under them a name tab naming that ant's colony ("Lake Hodges");
 *   when it died in this message its corpse keeps both for the message;
 * - the ants biting her: a count stack at her emblem, one row per biting colony ("4 Lake Hodges") with a 3 px colony
 *   bar at its left edge and a leader from her ring; and the contacts of their bite poses, as sparks on her ring.
 * Count stacks go into the layout first, then tabs, and both are reserved, so mark labels and badges keep clear of
 * them (Words). A stack or tab is never hidden, cut or shortened. Every cue is a cut: none tweens, under reduced motion too.
 */
import { BitmapText, Container, Graphics } from "pixi.js";
import { SUB_TILE, streamQueens } from "../../src/live/format.ts";
import { colonyNamesOf } from "../../src/sim/colonyNames.ts";
import type { Frame, QueenPulse } from "./buffer.ts";
import { renderedQueenBiteContacts } from "./bite.ts";
import { colonyTint } from "./colony-palette.ts";
import { EMBLEM_BAR, GROUND_SPARK, QUEEN_EMBLEM } from "./effects.ts";
import { GLOSS_FONT, LABEL_PLATE_ALPHA, Placer, overlaps, type Rect } from "./words.ts";

/** The board label's type for the stacks and tabs, CSS px, and its plate's padding and corner radius. */
export const CUE_LABEL = { px: 11, padX: 4, padY: 2, radius: 3, bar: 3, rowGap: 3, leader: 1.5 } as const;
/** The brackets round the ant she bites: box = clamp(1.15 × body, 16, 64) CSS px, arm = min(14, box / 3); a second queen's 3 px outside. */
export const CUE_BRACKETS = { scale: 1.15, min: 16, max: 64, arm: 14, width: 2, outline: 4.5, outlineAlpha: 0.55, nested: 3 } as const;
/** The layout's gap; a tab keeps this far from a count stack; the near fallback's grid step and reach, CSS px. */
const GAP = 4, TAB_STACK_CLEAR = 12, NEAR_STEP = 4, NEAR_MAX = 56;
/** A stack's spots sit this far from her centre, clear of her emblem and bar by the layout's gap. */
const STACK_SIDE = EMBLEM_BAR.w / 2 + GAP + 1;

/** A colony's name as the cues write it: without " Colony". */
export function cueName(name: string): string {
  return name.replace(/ Colony$/, "");
}

/** A row or tab of `text`: its plate's width and height, CSS px (Plex Mono advances 0.6 em). */
export function cueSize(text: string, bar: boolean): { w: number; h: number } {
  const { px, padX, padY } = CUE_LABEL;
  return { w: Math.ceil(text.length * px * 0.6) + 2 * padX + (bar ? CUE_LABEL.bar : 0), h: Math.ceil(px * 1.25) + 2 * padY };
}

/** The bracket box's side for a body `bodyPx` long on screen. */
export function bracketBox(bodyPx: number): number {
  return Math.min(CUE_BRACKETS.max, Math.max(CUE_BRACKETS.min, CUE_BRACKETS.scale * bodyPx));
}

/** One count row: its biting colony, how many, its text. */
interface Row { colony: number; count: number; text: string; w: number }
/**
 * A stack as placed: its rows top to bottom in colony order, each aligned to the side facing her (left beside her right,
 * right beside her left), and its box; the leader from her ring to its row nearest her.
 */
export interface PlacedStack { queen: QueenPulse; rows: (Row & { x: number; y: number })[]; rect: Rect; rowH: number; leader: [number, number, number, number]; leaderColony: number }
/** A tab as placed: its text and box; its leader to its box where it is not flush with it. */
export interface PlacedTab { colony: number; text: string; rect: Rect; leader: [number, number, number, number] | null }
/** A bracket box drawn: its centre, side and colour. */
export interface PlacedBrackets { queen: QueenPulse; x: number; y: number; side: number; colour: number }

/** What a board supplies: tile to screen, a body's drawn length on screen at a tile point, and its ants' drawn points. */
export interface CueBoard {
  toScreen(tx: number, ty: number): [number, number];
  bodyPx(tx: number, ty: number, soldier: boolean): number;
}

/** Every rect a near fallback may take: offsets on a 4 px grid within 56 px, nearest first. */
const NEAR: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let dy = -NEAR_MAX; dy <= NEAR_MAX; dy += NEAR_STEP) for (let dx = -NEAR_MAX; dx <= NEAR_MAX; dx += NEAR_STEP) {
    if ((dx !== 0 || dy !== 0) && Math.hypot(dx, dy) <= NEAR_MAX) out.push([dx, dy]);
  }
  return out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
})();

const shift = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/** Where a stack w × h may sit at her emblem centred (x, y): upper right, upper left, lower right, lower left. */
export function stackSpots(x: number, y: number, w: number, h: number): Rect[] {
  const at = (x0: number, y0: number): Rect => ({ x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0) + w, y1: Math.round(y0) + h });
  return [at(x + STACK_SIDE, y - h), at(x - STACK_SIDE - w, y - h), at(x + STACK_SIDE, y), at(x - STACK_SIDE - w, y)];
}

/** Where a tab w × h may sit at its bracket box: under it (left-aligned), over it, right of it, left of it (top-aligned). */
export function tabSpots(box: Rect, w: number, h: number): Rect[] {
  const at = (x0: number, y0: number): Rect => ({ x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x0) + w, y1: Math.round(y0) + h });
  return [at(box.x0, box.y1 + GAP), at(box.x0, box.y0 - GAP - h), at(box.x1 + GAP, box.y0), at(box.x0 - GAP - w, box.y0)];
}

/** Her emblem and bar on screen, as the layout keeps clear of them. */
export function emblemRect(x: number, y: number): Rect {
  const r = QUEEN_EMBLEM.r + QUEEN_EMBLEM.ringW / 2;
  return { x0: x - Math.max(r, EMBLEM_BAR.w / 2), y0: y - r, x1: x + Math.max(r, EMBLEM_BAR.w / 2), y1: y + QUEEN_EMBLEM.r + EMBLEM_BAR.gap + EMBLEM_BAR.h };
}

/** A leader from a point on her ring toward (tx, ty), to it. */
function ringLeader(x: number, y: number, tx: number, ty: number): [number, number, number, number] {
  const d = Math.hypot(tx - x, ty - y) || 1, r = QUEEN_EMBLEM.r + QUEEN_EMBLEM.ringW / 2;
  return [x + (tx - x) / d * r, y + (ty - y) / d * r, tx, ty];
}

/** The leader from a box to a tab that is not at one of its own spots: from the box's nearest edge point to the tab's. */
function boxLeader(box: Rect, tab: Rect): [number, number, number, number] {
  const cx = Math.max(box.x0, Math.min((tab.x0 + tab.x1) / 2, box.x1)), cy = Math.max(box.y0, Math.min((tab.y0 + tab.y1) / 2, box.y1));
  const tx = Math.max(tab.x0, Math.min(cx, tab.x1)), ty = Math.max(tab.y0, Math.min(cy, tab.y1));
  return [cx, cy, tx, ty];
}

/**
 * This frame's placement, the same on both boards: each fighting queen in colony then queen-id order, count stacks
 * first, then the brackets and tabs. blocked: the HUD panels. Returns what is drawn, and the rects the marks' layout
 * keeps clear of.
 */
export function layoutCues(frame: Pick<Frame, "board" | "queenPulse" | "count" | "id" | "x" | "y" | "drawX" | "drawY" | "corpses">,
  board: CueBoard, screen: { w: number; h: number }, blocked: readonly Rect[]): { stacks: PlacedStack[]; tabs: PlacedTab[]; brackets: PlacedBrackets[]; reserved: Rect[] } {
  const stacks: PlacedStack[] = [], tabs: PlacedTab[] = [], brackets: PlacedBrackets[] = [];
  const b = frame.board;
  if (!b || frame.queenPulse.length === 0) return { stacks, tabs, brackets, reserved: [] };
  const names = colonyNamesOf(b.setup).map(cueName);
  const pulses = [...frame.queenPulse].sort((p, q) => p.colony - q.colony || p.queenId - q.queenId);
  const placer = new Placer(screen.w, screen.h, blocked);
  // Every standing queen's emblem and bar, fighting or not, is kept clear.
  for (const q of streamQueens(b)) {
    if (q.lostTick !== null) continue;
    const [x, y] = board.toScreen(q.x / SUB_TILE, q.y / SUB_TILE);
    if (Number.isFinite(x) && Number.isFinite(y)) placer.occupy(emblemRect(x, y));
  }
  const free = (r: Rect, extra: readonly Rect[] = []) => placer.free(r) && !extra.some((e) => overlaps(r, e));
  const onScreen = (r: Rect) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= screen.w && r.y1 <= screen.h;
  const near = (first: Rect, extra: readonly Rect[]) => NEAR.map(([dx, dy]) => shift(first, dx, dy)).find((r) => free(r, extra));
  // The last resort, for a cue whose anchor is on screen: a place whole on screen and off every HUD panel, clear of
  // every emblem and cue already placed where one exists (the first of its spots, else the nearest on the 4 px grid),
  // else the same without that clearance, drawn on top. A cue is never cut and never covers another while room exists.
  const seen = (r: Rect) => onScreen(r) && !blocked.some((b) => overlaps(r, b));
  const clear = (r: Rect, extra: readonly Rect[]) => !placer.rects.some((o) => overlaps(r, o)) && !extra.some((e) => overlaps(r, e));
  const nearest = (first: Rect, ok: (r: Rect) => boolean): Rect | undefined => {
    for (let d = NEAR_STEP, reach = Math.max(screen.w, screen.h); d <= reach; d += NEAR_STEP) {
      let best: Rect | undefined, bestD = Infinity;
      for (let k = -d; k <= d; k += NEAR_STEP) for (const [dx, dy] of [[k, -d], [k, d], [-d, k], [d, k]] as const) {
        const r = shift(first, dx, dy), dist = Math.hypot(dx, dy);
        if (dist < bestD && ok(r)) { best = r; bestD = dist; }
      }
      if (best !== undefined) return best;
    }
    return undefined;
  };
  const visible = (spots: readonly Rect[], extra: readonly Rect[]): Rect | undefined => {
    const roomy = (r: Rect) => seen(r) && clear(r, extra);
    return spots.find(roomy) ?? nearest(spots[0]!, roomy) ?? spots.find(seen) ?? nearest(spots[0]!, seen);
  };
  const inView = (x: number, y: number) => x >= 0 && y >= 0 && x <= screen.w && y <= screen.h;
  for (const p of pulses) {
    const rows: Row[] = [];
    for (let c = 0; c < p.counts.length; c++) if (p.counts[c]! > 0) {
      const text = `${p.counts[c]} ${names[c] ?? ""}`.trim();
      rows.push({ colony: c, count: p.counts[c]!, text, w: cueSize(text, true).w });
    }
    if (rows.length === 0) continue;
    const [x, y] = board.toScreen(p.x, p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rowH = cueSize("", true).h, w = Math.max(...rows.map((r) => r.w));
    const h = rows.length * rowH + (rows.length - 1) * CUE_LABEL.rowGap;
    const spots = stackSpots(x, y, w, h);
    const rect = spots.find((s) => free(s)) ?? near(spots[0]!, []) ?? (inView(x, y) ? visible(spots, []) : undefined) ?? spots[0]!;
    placer.occupy(rect);
    // The leader meets the row nearest her centre, at its side facing her.
    const right = (rect.x0 + rect.x1) / 2 >= x, below = (rect.y0 + rect.y1) / 2 >= y;
    const placedRows = rows.map((row, k) => ({ ...row, x: right ? rect.x0 : rect.x1 - row.w, y: rect.y0 + k * (rowH + CUE_LABEL.rowGap) }));
    const nearest = below ? placedRows[0]! : placedRows[placedRows.length - 1]!;
    stacks.push({ queen: p, rows: placedRows, rect, rowH, leaderColony: nearest.colony,
      leader: ringLeader(x, y, right ? nearest.x : nearest.x + nearest.w, nearest.y + rowH / 2) });
  }
  const stackRects = stacks.map((s) => grow(s.rect, TAB_STACK_CLEAR - GAP));
  // Her target's brackets and tab, after every stack: one tab per ant, each queen's brackets in her own colour.
  const tabbed = new Map<number, number>();
  const pointOf = (id: number, dead: boolean): [number, number] | null => {
    if (dead) {
      const corpse = frame.corpses.find((c) => c.antId === id);
      return corpse ? [corpse.x, corpse.y] : null;
    }
    for (let i = 0; i < frame.count; i++) if (frame.id[i] === id) return [frame.drawX?.[i] ?? frame.x[i]!, frame.drawY?.[i] ?? frame.y[i]!];
    return null;
  };
  for (const p of pulses) {
    const t = p.target;
    if (t === null) continue;
    const at = pointOf(t.id, t.dead);
    if (at === null) continue;
    const [sx, sy] = board.toScreen(at[0], at[1]);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    const nested = tabbed.get(t.id) ?? 0;
    const side = bracketBox(board.bodyPx(at[0], at[1], t.soldier)) + 2 * CUE_BRACKETS.nested * nested;
    tabbed.set(t.id, nested + 1);
    brackets.push({ queen: p, x: sx, y: sy, side, colour: colonyTint(p.colony) });
    if (nested > 0) continue;
    const text = names[t.colony] ?? "";
    const { w, h } = cueSize(text, false);
    const box: Rect = { x0: sx - side / 2, y0: sy - side / 2, x1: sx + side / 2, y1: sy + side / 2 };
    const spots = tabSpots(box, w, h);
    const flush = spots.find((s) => free(s, stackRects));
    const rect = flush ?? near(spots[0]!, stackRects) ?? (inView(sx, sy) ? visible(spots, stackRects) : undefined) ?? spots[0]!;
    placer.occupy(rect);
    tabs.push({ colony: p.colony, text, rect, leader: flush === undefined ? boxLeader(box, rect) : null });
  }
  return { stacks, tabs, brackets, reserved: [...stacks.map((s) => s.rect), ...tabs.map((t) => t.rect)] };
}

/** A key that changes whenever a cue's reserved rect moves, so the marks' layout is placed again clear of it. */
export function cueKey(rects: readonly Rect[]): string {
  return rects.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join(";");
}

/** The queen bite cues' screen layer (layoutCues), for both boards. */
export class QueenBiteCues {
  readonly layer = new Container();
  private readonly sparks = new Graphics();
  private readonly brackets = new Graphics();
  private readonly stackPlates = new Graphics();
  private readonly stackTexts = new Container();
  private readonly tabPlates = new Graphics();
  private readonly tabTexts = new Container();
  private readonly pool: BitmapText[] = [];
  private used = 0;
  /** This frame's placement, for the stills' checks. */
  placed: ReturnType<typeof layoutCues> = { stacks: [], tabs: [], brackets: [], reserved: [] };

  constructor() {
    this.layer.addChild(this.sparks, this.brackets, this.stackPlates, this.stackTexts, this.tabPlates, this.tabTexts);
  }

  /** Lay out and draw this frame's cues; returns the rects the marks' layout keeps clear of. */
  update(frame: Frame, board: CueBoard, screen: { w: number; h: number }, blocked: readonly Rect[]): readonly Rect[] {
    for (const g of [this.sparks, this.brackets, this.stackPlates, this.tabPlates]) g.clear();
    this.used = 0;
    // The contacts of the ants biting her, on her ring, above her emblem so the mob cannot hide them.
    for (const c of renderedQueenBiteContacts(frame)) {
      const [x, y] = board.toScreen(c.x, c.y);
      if (Number.isFinite(x) && Number.isFinite(y)) this.sparks.circle(x, y, GROUND_SPARK.r);
    }
    this.sparks.fill({ color: GROUND_SPARK.tint, alpha: GROUND_SPARK.alpha });
    const placed = this.placed = layoutCues(frame, board, screen, blocked);
    for (const br of placed.brackets) {
      const half = br.side / 2, arm = Math.min(CUE_BRACKETS.arm, br.side / 3);
      const x0 = br.x - half, y0 = br.y - half, x1 = br.x + half, y1 = br.y + half;
      const path = () => {
        for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]] as const) {
          this.brackets.moveTo(cx + sx * arm, cy).lineTo(cx, cy).lineTo(cx, cy + sy * arm);
        }
      };
      path();
      this.brackets.stroke({ width: CUE_BRACKETS.outline, color: 0x000000, alpha: CUE_BRACKETS.outlineAlpha, cap: "square", join: "miter" });
      path();
      this.brackets.stroke({ width: CUE_BRACKETS.width, color: br.colour, cap: "square", join: "miter" });
    }
    for (const s of placed.stacks) {
      const [lx0, ly0, lx1, ly1] = s.leader;
      this.stackPlates.moveTo(lx0, ly0).lineTo(lx1, ly1).stroke({ width: CUE_LABEL.leader, color: colonyTint(s.leaderColony) });
      for (const row of s.rows) {
        this.stackPlates.roundRect(row.x, row.y, row.w, s.rowH, CUE_LABEL.radius).fill({ color: 0x0b0907, alpha: LABEL_PLATE_ALPHA });
        this.stackPlates.rect(row.x, row.y, CUE_LABEL.bar, s.rowH).fill({ color: colonyTint(row.colony) });
        this.text(this.stackTexts, row.text, row.x + CUE_LABEL.bar + CUE_LABEL.padX, row.y + CUE_LABEL.padY);
      }
    }
    for (const t of placed.tabs) {
      if (t.leader) this.tabPlates.moveTo(t.leader[0], t.leader[1]).lineTo(t.leader[2], t.leader[3]).stroke({ width: CUE_LABEL.leader, color: colonyTint(t.colony) });
      this.tabPlates.roundRect(t.rect.x0, t.rect.y0, t.rect.x1 - t.rect.x0, t.rect.y1 - t.rect.y0, CUE_LABEL.radius).fill({ color: 0x0b0907, alpha: LABEL_PLATE_ALPHA });
      this.text(this.tabTexts, t.text, t.rect.x0 + CUE_LABEL.padX, t.rect.y0 + CUE_LABEL.padY);
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i]!.visible = false;
    return placed.reserved;
  }

  /** One ink label in the board font, from the pool, in parent. */
  private text(parent: Container, text: string, x: number, y: number): void {
    let t = this.pool[this.used];
    if (!t) {
      t = new BitmapText({ text, style: { fontFamily: GLOSS_FONT, fontSize: CUE_LABEL.px } });
      this.pool.push(t);
    }
    this.used++;
    if (t.parent !== parent) parent.addChild(t);
    if (t.text !== text) t.text = text;
    t.position.set(Math.round(x), Math.round(y));
    t.tint = 0xffffff;
    t.visible = true;
  }
}
