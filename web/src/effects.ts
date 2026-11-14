/**
 * Battles and screen effects: a small contact spark
 * per fixed-tick bite, the place markers of new timeline entries, the
 * switchable tilt-shift miniature effect, and colour-blindness simulation used
 * by capture to check the colony colours.
 */
import { IconSprites } from "./icons/sprites.ts";
import { ColorMatrixFilter, Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, type ColorMatrix, type Renderer } from "pixi.js";
import { TiltShiftFilter } from "pixi-filters";
import { streamQueens, type StreamQueen } from "../../src/live/format.ts";
import { HIT_FLASH_MS, QUEEN_COLLAPSE_MS, queenLossAge, type Frame } from "./buffer.ts";
import { SUB_TILE, TICK_MS, type Colony } from "../../src/live/snapshot.ts";
import { renderedBiteContacts } from "./bite.ts";
import { colonyTint } from "./colony-palette.ts";
import { reducedMotion } from "./camera.ts";
import { visibleStory } from "./story.ts";
import { boardQueenHp } from "./variant.ts";

/** Tiny contact sparks, normally blended and drawn below ants. The ant renderer
 * supplies exact rendered head boundaries; no independent flash/ring timer. */
export class Battles {
  readonly layer: ParticleContainer;
  private px: number;
  private pool: Particle[] = [];
  private spark: Texture;
  constructor(renderer: Renderer, tilePx: number) {
    this.px = 1 / tilePx;
    const g = new Graphics();
    g.circle(16, 16, 14).fill({ color: 0xffffff });
    this.spark = renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, 32, 32), antialias: true });
    this.layer = new ParticleContainer({ dynamicProperties: { position: true, vertex: true, color: true, uvs: false, rotation: false }, texture: this.spark });
    this.layer.blendMode = "normal";
  }
  setTilePx(tilePx: number) { this.px = 1 / tilePx; }
  update(frame: Frame) {
    const points = renderedBiteContacts(frame);
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const p = this.pool[i] ??= new Particle({ texture: this.spark, anchorX: 0.5, anchorY: 0.5 });
      p.x = point.x; p.y = point.y;
      // At most 1.5 CSS px, never a full-width glow or expanding burst.
      p.scaleX = p.scaleY = 1.5 * this.px / 14;
      p.tint = 0xc3ad78; p.alpha = 0.6;
    }
    const kids = this.layer.particleChildren;
    kids.length = 0;
    for (let i = 0; i < points.length; i++) kids.push(this.pool[i]!);
    this.layer.update();
  }
}

/** Tilt-shift at half filter resolution, focused on a horizontal band through the middle. */
export function tiltShift(width: number, height: number): TiltShiftFilter {
  // A wide sharp band through the action with a gentle falloff and a
  // much weaker blur, so ant silhouettes stay readable everywhere:
  // the filter's blur ramps by smoothstep over gradientBlur.
  const f = new TiltShiftFilter({ blur: 5, gradientBlur: 600, start: { x: 0, y: height / 2 }, end: { x: width, y: height / 2 } });
  f.resolution = 0.5;
  return f;
}

export type Deficiency = "protanopia" | "deuteranopia" | "tritanopia";

/** Machado, Oliveira and Fernandes (2009) simulation matrices at severity 1.0. */
export const CVD_MATRICES: Record<Deficiency, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

export function cvdFilter(kind: Deficiency): ColorMatrixFilter {
  const m = CVD_MATRICES[kind];
  const f = new ColorMatrixFilter();
  f.matrix = [m[0]!, m[1]!, m[2]!, 0, 0, m[3]!, m[4]!, m[5]!, 0, 0, m[6]!, m[7]!, m[8]!, 0, 0, 0, 0, 0, 1, 0] as ColorMatrix;
  return f;
}

/** A queen's emblem: a dark disc of radius r with a colony-colour ring, holding a crown; CSS px. */
export const QUEEN_EMBLEM = { r: 11, ringW: 2.5, crown: 7 } as const;
/** The queen zone's corner brackets: stroke and arm length in CSS px. */
const BRACKET_W = 2;
const BRACKET_ARM = 14;

/** A crown centred on (0, 0) within radius r: a band with three points, as a flat polygon. */
export function crownPolygon(r: number): number[] {
  const w = r;
  const top = -r * 0.75;
  const dip = -r * 0.05;
  const base = r * 0.6;
  return [-w, base, -w, top, -w * 0.5, dip, 0, top - r * 0.15, w * 0.5, dip, w, top, w, base];
}

/** The bar under a queen's emblem: width and height in CSS px, and its gap below the disc. */
export const EMBLEM_BAR = { w: 28, h: 3, gap: 4 } as const;
/** The hit flash's ring: how far (CSS px) outside the emblem it has spread by the end of the flash. */
const FLASH_SPREAD = 7;

/**
 * A queen's emblem at one frame, the same on both boards: its scale and alpha through a
 * lost queen's collapse (QUEEN_COLLAPSE_MS, eased in) down to the landmark that stays of her (LOST_EMBLEM;
 * the fallen queen or nest stays visible instead of vanishing),
 * her zone's brackets and the bar under the emblem fading out through the collapse (zone, 1 to 0), the bar's
 * fill (her HP over the configured maximum, in her own colour; null, and no bar, on a recording without queen
 * HP: one design only, never the old overrun bar under the queens) and the hit flash (1 as
 * a bite lands, 0 after HIT_FLASH_MS). Under reduced motion
 * the collapse is a cut to the landmark; the boards also leave out the
 * flash's spreading ring, keeping the lit disc.
 */
export interface EmblemState {
  scale: number;
  alpha: number;
  /** The zone's brackets and the bar: 1 while she stands, fading to 0 through the collapse. */
  zone: number;
  /** The bar's fill, 0..1 (0 through her collapse); null on a recording without queen HP, which draws no bar. */
  bar: number | null;
  flash: number;
}

/** What stays of a lost queen's emblem once her collapse is over: dimmed and a little smaller, a landmark of where she was. */
export const LOST_EMBLEM = { alpha: 0.35, scale: 0.78 } as const;

export function emblemState(q: StreamQueen, frame: Pick<Frame, "board" | "targetMs" | "hits" | "lossShown">, reduced = reducedMotion()): EmblemState | null {
  const board = frame.board;
  if (!board) return null;
  const lossAge = queenLossAge(q, frame.targetMs, frame.lossShown.get(`${q.colony}:${q.id}`));
  const k = lossAge === null ? 0 : reduced ? 1 : Math.min(1, Math.max(0, lossAge) / QUEEN_COLLAPSE_MS);
  const hp = boardQueenHp(board);
  const bar = hp === undefined ? null : lossAge === null ? Math.min(1, (q.hp ?? 0) / hp.hp) : 0;
  let flash = 0;
  for (const h of frame.hits) if (h.colony === q.colony && h.queenId === q.id) flash = Math.max(flash, 1 - h.ageMs / HIT_FLASH_MS);
  return { scale: 1 - k * k * (1 - LOST_EMBLEM.scale), alpha: 1 - k * (1 - LOST_EMBLEM.alpha), zone: 1 - k, bar, flash };
}

/** A colour part way (t, 0..1) from a to b, by channel. */
export function mixColour(a: number, b: number, t: number): number {
  let out = 0;
  for (const shift of [16, 8, 0]) out |= Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t) << shift;
  return out >>> 0;
}

/**
 * Each queen's home, from the stream's queens: corner brackets in the
 * colony's colour framing the queen zone (buffer.ts queenZone, the tiles the
 * sim's overrun counts), and an emblem, a crown on a dark disc, at the queen,
 * with its bar (emblemState). A bite flashes the emblem and its bar white; a
 * lost queen's home collapses. Ground brackets stay beneath ants; emblems draw above them,
 * redrawn every frame; sizes are CSS px so a phone shows the same landmark as 1080p.
 */
export class QueenHomes {
  readonly layer = new Graphics();
  readonly emblems = new Graphics();
  private readonly icons = new IconSprites();
  readonly crownIcons = this.icons.layer;
  private px: number;
  /** Each standing queen's bracketed zone as last drawn, in tiles: [x0, x1) x [y0, y1). */
  zones: { colony: Colony; x0: number; y0: number; x1: number; y1: number }[] = [];

  constructor(tilePx: number) {
    this.px = 1 / tilePx;
  }

  setTilePx(tilePx: number) {
    this.px = 1 / tilePx;
  }

  update(frame: Pick<Frame, "board" | "targetMs" | "hits" | "lossShown">, reduced = reducedMotion()) {
    const g = this.layer;
    const emblem = this.emblems;
    const px = this.px;
    g.clear();
    emblem.clear();
    this.icons.reset();
    this.zones = [];
    const setup = frame.board?.setup;
    if (!setup) return;
    for (const q of streamQueens(frame.board!)) {
      const s = emblemState(q, frame, reduced);
      if (s === null) continue;
      const colony = q.colony;
      const colour = colonyTint(colony);
      const tx = Math.floor(q.x / SUB_TILE), ty = Math.floor(q.y / SUB_TILE), r = setup.overrunRadiusTiles;
      const x0 = tx - r;
      const y0 = ty - r;
      const x1 = tx + r + 1;
      const y1 = ty + r + 1;
      if (q.lostTick === null) this.zones.push({ colony, x0, y0, x1, y1 });
      const arm = Math.min(BRACKET_ARM * px, (x1 - x0) / 3);
      const corners = [
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x1, y1, -1, -1],
        [x0, y1, 1, -1],
      ] as const;
      const path = () => {
        for (const [cx, cy, sx, sy] of corners) g.moveTo(cx + sx * arm, cy).lineTo(cx, cy).lineTo(cx, cy + sy * arm);
      };
      if (s.zone > 0) {
        path();
        g.stroke({ width: (BRACKET_W + 2.5) * px, color: 0x000000, alpha: 0.55 * s.zone, cap: "square", join: "miter" });
        path();
        g.stroke({ width: BRACKET_W * px, color: colour, alpha: 0.9 * s.zone, cap: "square", join: "miter" });
      }
      const qx = q.x / SUB_TILE;
      const qy = q.y / SUB_TILE;
      // The flash: a white ring spreading from the disc (not under reduced motion), and the disc lit in the colony's colour.
      if (s.flash > 0 && !reduced) emblem.circle(qx, qy, (QUEEN_EMBLEM.r + 1 + FLASH_SPREAD * (1 - s.flash)) * px).stroke({ width: 2 * px, color: 0xffffff, alpha: 0.9 * s.flash });
      emblem.circle(qx, qy, QUEEN_EMBLEM.r * s.scale * px).fill({ color: mixColour(0x0b0907, colour, 0.5 * s.flash), alpha: 0.85 * s.alpha }).stroke({ width: QUEEN_EMBLEM.ringW * px, color: colour, alpha: 0.95 * s.alpha });
      const crownR = QUEEN_EMBLEM.crown * s.scale * px;
      if (!this.icons.draw("crown", qx - crownR, qy - crownR, crownR * 2, crownR * 2, colour, s.alpha)) emblem.poly(crownPolygon(QUEEN_EMBLEM.crown * s.scale * px).map((v, i) => v + (i % 2 === 0 ? qx : qy))).fill({ color: colour, alpha: s.alpha });
      if (s.zone > 0 && s.bar !== null) {
        const w = EMBLEM_BAR.w * px, h = EMBLEM_BAR.h * px, y = qy + (QUEEN_EMBLEM.r + EMBLEM_BAR.gap) * px;
        emblem.rect(qx - w / 2, y, w, h).fill({ color: 0x090807, alpha: 0.9 * s.zone });
        if (s.bar > 0) emblem.rect(qx - w / 2, y, w * s.bar, h).fill({ color: mixColour(colour, 0xffffff, s.flash), alpha: s.zone });
      }
    }
  }
}

/** How long a new timeline entry's place stays marked on the board. */
export const STORY_MARK_MS = 4000;

/**
 * When a timeline entry is added, its place is marked briefly on the board
 *: two pulsing rings in the acting colony's colour.
 * The camera never moves to it (no automatic camera), except in
 * the fall window, when the view frames the fallen colony's nests
 * (web/src/main.ts). Aged on the playback target, so the place a match's
 * last message marks keeps pulsing past it, as the collapse does. Under reduced motion
 * the rings stand still at the two phases' radii and only fade.
 */
export class PlaceMarkers {
  readonly layer = new Graphics();
  private px: number;
  /** Entries marked this frame. */
  shown = 0;
  /** The tile of an order the viewer points at in the dock or on the card (overlays.ts handlers.target), lit on the board; null for none. */
  target: [number, number] | null = null;
  /** The pointed order's agent hue, the colour its tile is lit in. */
  targetColour = 0xffffff;

  constructor(tilePx: number) {
    this.px = 1 / tilePx;
  }

  setTilePx(tilePx: number) {
    this.px = 1 / tilePx;
  }

  update(frame: Frame, reduced = reducedMotion()) {
    const g = this.layer;
    const px = this.px;
    g.clear();
    this.shown = 0;
    // The pointed order's tile: a bright square on the tile in its agent's hue, outlined dark so it holds over any ground.
    if (this.target) {
      const [tx, ty] = this.target;
      g.rect(tx, ty, 1, 1).stroke({ width: 5 * px, color: 0x000000, alpha: 0.6 }).stroke({ width: 2 * px, color: this.targetColour, alpha: 0.95 });
      g.rect(tx, ty, 1, 1).fill({ color: this.targetColour, alpha: 0.18 });
    }
    for (const e of visibleStory(frame.story)) {
      const age = frame.targetMs - e.tick * TICK_MS;
      if (age < 0 || age >= STORY_MARK_MS) continue;
      this.shown++;
      const fade = 1 - age / STORY_MARK_MS;
      const colour = colonyTint(e.colony);
      for (const phase of [0, 0.5]) {
        const t = reduced ? phase : ((age / 1000 + phase) % 1 + 1) % 1;
        g.circle(e.x, e.y, (14 + 46 * t) * px).stroke({ width: 2 * px, color: colour, alpha: 0.6 * fade * (1 - t) });
      }
      g.circle(e.x, e.y, 5 * px).fill({ color: colour, alpha: 0.7 * fade });
    }
  }
}
