/** Queen-home landmarks and new story places, projected through the 3D camera.
 * A single atlas and particle batch, above the ground and below labels; never one mesh per marker.
 * Positions and zone bounds come from the same stream/clock helpers as effects.ts on 2D. */
import { IconSprites } from "../icons/sprites.ts";
import { iconMasks, iconTexture } from "../icons/textures.ts";
import { Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, type Renderer } from "pixi.js";
import { SUB_TILE, streamQueens } from "../../../src/live/format.ts";
import { TICK_MS } from "../../../src/live/snapshot.ts";
import type { Frame } from "../buffer.ts";
import { COLONY_TINT } from "../ants.ts";
import { reducedMotion } from "../camera.ts";
import { EMBLEM_BAR, QUEEN_EMBLEM, STORY_MARK_MS, crownPolygon, emblemState, mixColour } from "../effects.ts";
import { visibleStory } from "../story.ts";

const COLONIES = [0, 1] as const;

export type Project = (x: number, y: number) => [number, number];
export interface ScreenPoint { x: number; y: number }
export type ProjectToRef = (x: number, y: number, out: ScreenPoint) => void;
export interface MarkerParticle {
  kind: "ring" | "dot" | "line" | "queen0" | "queen1";
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  tint: number;
  alpha: number;
}

type MarkerFrame = Pick<Rectangle, "x" | "y" | "width" | "height">;
/** Trim only transparent padding, not the drawing or its scale. Symmetric bounds keep
 * the original cell centre at the particle anchor, with room for strokes and filtering. */
export const MARKER_FRAMES: Readonly<Record<MarkerParticle["kind"], MarkerFrame>> = {
  ring: { x: 32, y: 32, width: 64, height: 64 },
  dot: { x: 185, y: 57, width: 14, height: 14 },
  line: { x: 262, y: 60, width: 116, height: 8 },
  queen0: { x: 434, y: 50, width: 28, height: 28 },
  queen1: { x: 562, y: 50, width: 28, height: 28 },
};

/** Screen-space specs, reused between frames including after a temporary empty board.
 * The projection writes to scratch points rather than allocating a tuple for each arm. */
export class MarkerSpecs3D {
  readonly particles: MarkerParticle[] = [];
  shown = 0;
  /** The tile of an order the viewer points at in the dock or on the card (overlays.ts handlers.target), lit on the board; null for none. */
  target: [number, number] | null = null;
  /** The pointed order's agent hue, the colour its tile is lit in. */
  targetColour = 0xffffff;
  private readonly pool: MarkerParticle[] = [];
  private readonly corner: ScreenPoint = { x: 0, y: 0 };
  private readonly end: ScreenPoint = { x: 0, y: 0 };
  private readonly point: ScreenPoint = { x: 0, y: 0 };
  private count = 0;

  private put(kind: MarkerParticle["kind"], x: number, y: number, scaleX: number, scaleY: number, tint: number, alpha: number, rotation = 0): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return;
    const p = this.pool[this.count] ??= { kind, x, y, scaleX, scaleY, tint, alpha, rotation };
    p.kind = kind; p.x = x; p.y = y; p.scaleX = scaleX; p.scaleY = scaleY;
    p.tint = tint; p.alpha = alpha; p.rotation = rotation;
    this.particles[this.count++] = p;
  }

  private arm(tint: number, alpha: number): void {
    const a = this.corner, b = this.end;
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const k = Math.min(1 / 3, 14 / Math.max(length, 0.001));
    this.put("line", a.x + dx * k / 2, a.y + dy * k / 2, length * k / 112, 1, tint, 0.9 * alpha, Math.atan2(dy, dx));
  }

  /**
   * The same homes as the 2D board's QueenHomes (effects.ts emblemState): brackets and emblem fading
   * and shrinking through a lost queen's collapse, the HP bar under the emblem (none on a recording
   * without queen HP) and the hit flash as a white ring spreading from the disc.
   */
  update(frame: Pick<Frame, "board" | "story" | "targetMs" | "hits" | "lossShown">, project: ProjectToRef, reduced = reducedMotion()): void {
    this.count = 0;
    this.shown = 0;
    const setup = frame.board?.setup;
    if (setup) for (const q of streamQueens(frame.board!)) {
      const s = emblemState(q, frame, reduced);
      if (s === null) continue;
      const colony = q.colony;
      const tx = Math.floor(q.x / SUB_TILE), ty = Math.floor(q.y / SUB_TILE), r = setup.overrunRadiusTiles;
      const x0 = tx - r, y0 = ty - r, x1 = tx + r + 1, y1 = ty + r + 1;
      // The zone's brackets and the bar fade out through a lost queen's collapse; her emblem stays as a landmark.
      if (s.zone > 0) for (let i = 0; i < 4; i++) {
        const left = i === 0 || i === 3, top = i < 2;
        const x = left ? x0 : x1, y = top ? y0 : y1;
        project(x, y, this.corner);
        project(left ? x1 : x0, y, this.end);
        this.arm(COLONY_TINT[colony], s.zone);
        project(x, top ? y1 : y0, this.end);
        this.arm(COLONY_TINT[colony], s.zone);
      }
      project(q.x / SUB_TILE, q.y / SUB_TILE, this.point);
      // The flash's spreading ring, not under reduced motion; the disc stays lit either way.
      if (s.flash > 0 && !reduced) {
        const radius = QUEEN_EMBLEM.r + 1 + 7 * (1 - s.flash);
        this.put("ring", this.point.x, this.point.y, radius / 30, radius / 30, 0xffffff, 0.9 * s.flash);
      }
      this.put(colony === 0 ? "queen0" : "queen1", this.point.x, this.point.y, s.scale, s.scale, mixColour(0xffffff, COLONY_TINT[colony], 0.5 * s.flash), s.alpha);
      if (s.zone > 0 && s.bar !== null) {
        const y = this.point.y + QUEEN_EMBLEM.r + EMBLEM_BAR.gap + 1;
        this.put("line", this.point.x, y, EMBLEM_BAR.w / 112, 1.5, 0x111111, s.zone);
        if (s.bar > 0) this.put("line", this.point.x - (EMBLEM_BAR.w / 2) * (1 - s.bar), y, (EMBLEM_BAR.w * s.bar) / 112, 1.5, mixColour(COLONY_TINT[colony], 0xffffff, s.flash), s.zone);
      }
    }
    for (const e of visibleStory(frame.story)) {
      const age = frame.targetMs - e.tick * TICK_MS;
      if (age < 0 || age >= STORY_MARK_MS) continue;
      this.shown++;
      project(e.x, e.y, this.point);
      const fade = 1 - age / STORY_MARK_MS;
      for (let phase = 0; phase < 1; phase += 0.5) {
        // As the 2D board's PlaceMarkers: still rings at the two phases' radii under reduced motion.
        const t = reduced ? phase : ((age / 1000 + phase) % 1 + 1) % 1;
        const scale = (14 + 46 * t) / 30;
        this.put("ring", this.point.x, this.point.y, scale, scale, COLONY_TINT[e.colony], 0.6 * fade * (1 - t));
      }
      this.put("dot", this.point.x, this.point.y, 1, 1, COLONY_TINT[e.colony], 0.7 * fade);
    }
    // The pointed order's tile, as the 2D board's PlaceMarkers square: a bright ring on the tile's centre, with its dot, in its agent's hue.
    if (this.target) {
      project(this.target[0] + 0.5, this.target[1] + 0.5, this.point);
      this.put("ring", this.point.x, this.point.y, 16 / 30, 16 / 30, this.targetColour, 0.95);
      this.put("dot", this.point.x, this.point.y, 0.6, 0.6, this.targetColour, 0.9);
    }
    this.particles.length = this.count;
  }
}

/** Convenience snapshot for callers with a tuple-returning projector. The live layer uses
 * MarkerSpecs3D and ProjectToRef directly so it doesn't allocate this snapshot each frame. */
export function markerParticles(frame: Pick<Frame, "board" | "story" | "targetMs" | "hits" | "lossShown">, project: Project, reduced = reducedMotion()): { particles: MarkerParticle[]; shown: number } {
  const specs = new MarkerSpecs3D();
  specs.update(frame, (x, y, out) => { const xy = project(x, y); out.x = xy[0]; out.y = xy[1]; }, reduced);
  return { particles: specs.particles, shown: specs.shown };
}

const CELL = 128;
const KINDS = ["ring", "dot", "line", "queen0", "queen1"] as const;

export class BoardMarkers3D {
  readonly layer: ParticleContainer;
  shown = 0;
  private textures: Record<MarkerParticle["kind"], Texture>;
  private pool: Particle[] = [];
  private readonly specs = new MarkerSpecs3D();

  private crownTexture: Texture | undefined;
  private crownSecondTexture: Texture | undefined;
  constructor(private readonly renderer: Renderer) {
    this.textures = this.makeTextures();
    this.crownTexture = iconTexture("crown");
    this.crownSecondTexture = iconMasks().get("crown")?.second?.texture;
    this.layer = new ParticleContainer({ texture: this.textures.ring, dynamicProperties: { position: true, vertex: true, rotation: true, uvs: true, color: true } });
  }

  private makeTextures(): Record<MarkerParticle["kind"], Texture> {
    const renderer = this.renderer;
    const crowns = new IconSprites();
    const g = new Graphics();
    g.circle(64, 64, 30).stroke({ width: 3, color: 0x000000, alpha: 0.55 }).stroke({ width: 1.5, color: 0xffffff });
    g.circle(CELL + 64, 64, 5).fill({ color: 0xffffff }).stroke({ width: 1, color: 0x000000 });
    g.rect(2 * CELL + 8, 62, 112, 4).fill({ color: 0x000000, alpha: 0.55 });
    g.rect(2 * CELL + 8, 63, 112, 2).fill({ color: 0xffffff });
    for (const c of [0, 1] as const) {
      const x = (3 + c) * CELL + 64;
      g.circle(x, 64, QUEEN_EMBLEM.r).fill({ color: 0x0b0907, alpha: 0.85 }).stroke({ width: QUEEN_EMBLEM.ringW, color: COLONY_TINT[c] });
      if (!crowns.draw("crown", x - QUEEN_EMBLEM.crown, 64 - QUEEN_EMBLEM.crown, 2 * QUEEN_EMBLEM.crown, 2 * QUEEN_EMBLEM.crown, COLONY_TINT[c])) g.poly(crownPolygon(QUEEN_EMBLEM.crown).map((v, i) => v + (i % 2 === 0 ? x : 64))).fill({ color: COLONY_TINT[c] });
    }
    const holder = new Container();
    holder.addChild(g, crowns.layer);
    const atlas = renderer.generateTexture({ target: holder, frame: new Rectangle(0, 0, CELL * KINDS.length, CELL), resolution: renderer.resolution, antialias: true });
    atlas.source.scaleMode = "linear";
    const textures = Object.fromEntries(KINDS.map((kind) => {
      const f = MARKER_FRAMES[kind];
      return [kind, new Texture({ source: atlas.source, frame: new Rectangle(f.x, f.y, f.width, f.height) })];
    })) as Record<MarkerParticle["kind"], Texture>;
    holder.destroy({ children: true });
    return textures;
  }

  /** The tile of an order the viewer points at, lit on the board (MarkerSpecs3D target); null for none. */
  set target(tile: [number, number] | null) {
    this.specs.target = tile;
  }

  /** The pointed order's agent hue (MarkerSpecs3D targetColour). */
  set targetColour(colour: number) {
    this.specs.targetColour = colour;
  }

  update(frame: Frame, project: ProjectToRef): void {
    let retired: Record<MarkerParticle["kind"], Texture> | undefined;
    const crownSecond = iconMasks().get("crown")?.second?.texture;
    if (this.crownTexture !== iconTexture("crown") || this.crownSecondTexture !== crownSecond) {
      retired = this.textures;
      this.textures = this.makeTextures();
      this.layer.texture = this.textures.ring;
      this.crownTexture = iconTexture("crown");
      this.crownSecondTexture = crownSecond;
    }
    this.specs.update(frame, project);
    const particles = this.specs.particles;
    this.shown = this.specs.shown;
    const kids = this.layer.particleChildren;
    const changedCount = kids.length !== particles.length;
    for (let i = 0; i < particles.length; i++) {
      const spec = particles[i]!;
      const p = this.pool[i] ??= new Particle({ texture: this.textures.ring, anchorX: 0.5, anchorY: 0.5 });
      p.texture = this.textures[spec.kind];
      p.x = spec.x; p.y = spec.y;
      p.scaleX = spec.scaleX; p.scaleY = spec.scaleY;
      p.rotation = spec.rotation; p.tint = spec.tint; p.alpha = spec.alpha;
      if (changedCount) kids[i] = p;
    }
    if (changedCount) kids.length = particles.length;
    if (changedCount || particles.length > 0 || retired) this.layer.update();
    if (retired) { const source = retired.ring.source; for (const texture of Object.values(retired)) texture.destroy(); source.destroy(); }
  }
}
