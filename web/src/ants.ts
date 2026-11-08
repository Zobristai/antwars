/**
 * Ants and corpses (the brightest, crispest element,
 * read as insects). Ants are drawn in
 * code once, baked into one texture atlas (per colony: three walk frames and a
 * curled corpse frame) and rotated to face their direction of travel. Contrast,
 * not glow, makes them the hero: a pale chitin body with dark seams between
 * head, thorax, waist and abdomen, thin crisp legs, and the colony colour as a
 * restrained accent on the abdomen. Spawns fade in; corpses fade over about
 * three seconds, dulled by tint. A squad's ants are tinted in their agent's hue at
 * all times and free ants stay plain; while a squad is
 * selected (squads.ts selected) every other ant is dimmed and the
 * rings come from squads.ts. An ant carrying food home holds a crumb in its
 * mandibles, baked into its own walk frames so it takes the ant's tint.
 * With the rules switch on, soldiers have their
 * own frames, baked SOLDIER_SCALE (about twice) a worker's length and crisp at
 * it: head and abdomen in the full colony colour with a thin dark outline, a
 * big round head and large pale mandibles, so a soldier reads as a solid
 * coloured insect beside the pale-bodied workers even on a phone.
 * Soldiers never carry food, so they have no carrying frames.
 */
import { Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, type Renderer } from "pixi.js";
import { CORPSE_FADE_MS, type Frame } from "./buffer.ts";
import { FOOD, FOOD_SHADE } from "./food.ts";
import { Bites } from "./bite.ts";

export const COLONY_TINT = [0xffb000, 0x00c2ff] as const;
/** Corpses keep their colony accent, dulled. */
const CORPSE_TINT = 0x8c8478;

/** Atlas cell size in drawing units; the atlas is baked at the ants' on-screen size. */
const CELL_W = 64;
const CELL_H = 48;

const CHITIN = 0xece4d4;
const CHITIN_SHADE = 0xa89e8c;
const SEAM = 0x0b0907;

/**
 * On-screen ant length in CSS pixels: about 1.3 tiles, so a column reads as a
 * chain of insects at whole-board view, kept between 10 px (a phone's whole
 * board, where a larger floor merged neighbours into blobs) and 28 px.
 */
export function antLengthPx(tilePx: number): number {
  return Math.min(28, Math.max(10, tilePx * 1.3));
}

/** A food crumb held between the mandibles, outlined like the ant so it reads on any ground. */
function drawCrumb(g: Graphics, ox: number, cy: number) {
  g.circle(ox + 58.5, cy, 4.6 + 1.6).fill({ color: SEAM, alpha: 0.9 });
  g.circle(ox + 58.5, cy, 4.6).fill({ color: FOOD }).stroke({ width: 1.2, color: FOOD_SHADE });
  g.circle(ox + 57.3, cy - 1.4, 1.4).fill({ color: 0xffffff, alpha: 0.7 });
}

function drawAnt(g: Graphics, ox: number, oy: number, frame: number, curled: boolean, accent: number, carrying = false, jawOpen = -1) {
  const cy = oy + CELL_H / 2;
  // Legs: alternating tripods swing between the walk frames.
  const swing = curled ? 0 : [-1, 0, 1][frame]!;
  const legs = (pass: (path: Graphics) => void) => {
    [ox + 30, ox + 35, ox + 40].forEach((hx, i) => {
      const phase = (i % 2 === 0 ? 1 : -1) * swing * 7;
      const reach = curled ? 7 : 16;
      for (const side of [-1, 1]) {
        const kneeX = hx + (i - 1) * 6 + phase * side * 0.4;
        const footX = hx + (i - 1) * 12 + phase * side;
        g.moveTo(hx, cy).lineTo(kneeX, cy + side * reach * 0.65).lineTo(footX, cy + side * reach);
      }
    });
    g.moveTo(ox + 52, cy - 2).quadraticCurveTo(ox + 57, cy - 8, ox + 62, cy - 11 + swing * 2);
    g.moveTo(ox + 52, cy + 2).quadraticCurveTo(ox + 57, cy + 8, ox + 62, cy + 11 - swing * 2);
    pass(g);
  };
  const seam = { width: 1.8, color: SEAM };
  // A dark silhouette under everything keeps the ant readable on any ground.
  legs((p) => p.stroke({ width: 5, color: SEAM, alpha: 0.9, cap: "round", join: "round" }));
  g.ellipse(ox + 17, cy, (curled ? 10 : 13) + 2, 8.5 + 2).fill({ color: SEAM, alpha: 0.9 });
  g.ellipse(ox + 37, cy, 7.5 + 2, 4.8 + 2).fill({ color: SEAM, alpha: 0.9 });
  g.ellipse(ox + 49, cy, 5.8 + 2, 5.2 + 2).fill({ color: SEAM, alpha: 0.9 });
  legs((p) => p.stroke({ width: 2.2, color: CHITIN, cap: "round", join: "round" }));
  // Abdomen in the colony colour, banded like an insect's segments.
  g.ellipse(ox + 17, cy, curled ? 10 : 13, 8.5).fill({ color: accent }).stroke(seam);
  for (const bx of [12, 19]) g.moveTo(ox + bx, cy - 7.6).quadraticCurveTo(ox + bx + 2.5, cy, ox + bx, cy + 7.6);
  g.stroke({ width: 1.3, color: SEAM, alpha: 0.55 });
  // Waist, thorax and head in pale chitin, each with its own dark seam.
  g.circle(ox + 30, cy, 2.4).fill({ color: CHITIN_SHADE }).stroke(seam);
  g.ellipse(ox + 37, cy, 7.5, 4.8).fill({ color: CHITIN }).stroke(seam);
  g.ellipse(ox + 49, cy, 5.8, 5.2).fill({ color: CHITIN }).stroke(seam);
  // Crisp specular highlights give the chitin its gloss.
  g.ellipse(ox + 13, cy - 3.5, 4.5, 1.8).fill({ color: 0xffffff, alpha: 0.75 });
  g.ellipse(ox + 36, cy - 1.8, 3.2, 1.2).fill({ color: 0xffffff, alpha: 0.9 });
  if (!curled && jawOpen >= 0) {
    const jaws = () => {
      for (const side of [-1, 1]) g.moveTo(ox + 53, cy + side * 3)
        .quadraticCurveTo(ox + 59, cy + side * (4 + jawOpen * 4), ox + 61, cy + side * (1.2 + jawOpen * 6));
    };
    jaws(); g.stroke({ width: 4.5, color: SEAM, cap: "round", join: "round" });
    jaws(); g.stroke({ width: 2.2, color: CHITIN, cap: "round", join: "round" });
  }
  if (carrying) drawCrumb(g, ox, cy);
  g.ellipse(ox + 50, cy - 2, 2.2, 1.2).fill({ color: 0xffffff, alpha: 0.9 });
}

/** A colour with each channel multiplied by k (0..1). */
function darken(rgb: number, k: number): number {
  return (Math.round(((rgb >> 16) & 0xff) * k) << 16) | (Math.round(((rgb >> 8) & 0xff) * k) << 8) | Math.round((rgb & 0xff) * k);
}

/** A soldier's head and abdomen, in a worker cell's drawing units: both filled with the colony colour. */
export const SOLDIER_HEAD = { x: 45.5, rx: 6.8, ry: 7.6 } as const;
export const SOLDIER_ABDOMEN = { x: 15, rx: 12.5, ry: 9 } as const;

/**
 * A soldier, in a worker cell's drawing units (baked SOLDIER_SCALE times larger):
 * head and abdomen in the colony colour with a thin dark outline, the thorax a darker
 * shade of it so the body reads as one coloured insect, pale legs, and two large pale
 * mandibles with a dark edge reaching forward from the round head.
 */
function drawSoldier(g: Graphics, ox: number, oy: number, frame: number, accent: number, jawOpen = 0) {
  const cy = oy + CELL_H / 2;
  const swing = [-1, 0, 1][frame]!;
  const H = SOLDIER_HEAD;
  const A = SOLDIER_ABDOMEN;
  const legs = () => {
    [ox + 30, ox + 35, ox + 40].forEach((hx, i) => {
      const phase = (i % 2 === 0 ? 1 : -1) * swing * 7;
      for (const side of [-1, 1]) {
        const kneeX = hx + (i - 1) * 6 + phase * side * 0.4;
        const footX = hx + (i - 1) * 12 + phase * side;
        g.moveTo(hx, cy).lineTo(kneeX, cy + side * 16 * 0.65).lineTo(footX, cy + side * 16);
      }
    });
    // Short antennae swept back from the head, out of the mandibles' way.
    g.moveTo(ox + 48, cy - 6).quadraticCurveTo(ox + 50, cy - 12, ox + 54, cy - 14 + swing * 2);
    g.moveTo(ox + 48, cy + 6).quadraticCurveTo(ox + 50, cy + 12, ox + 54, cy + 14 - swing * 2);
  };
  const mandibles = () => {
    for (const side of [-1, 1]) g.moveTo(ox + 49, cy + side * 6.2)
      .quadraticCurveTo(ox + 59, cy + side * (8 + jawOpen * 3), ox + 61, cy + side * (1.2 + jawOpen * 9));
  };
  const outline = { width: 1.2, color: SEAM };
  // The thin dark silhouette under legs, antennae and mandibles.
  legs();
  g.stroke({ width: 4.2, color: SEAM, alpha: 0.9, cap: "round", join: "round" });
  mandibles();
  g.stroke({ width: 5.4, color: SEAM, alpha: 0.9, cap: "round", join: "round" });
  legs();
  g.stroke({ width: 2, color: CHITIN, cap: "round", join: "round" });
  mandibles();
  g.stroke({ width: 3, color: CHITIN, cap: "round", join: "round" });
  // Abdomen, waist, thorax and head: one coloured body, each part outlined.
  g.ellipse(ox + A.x, cy, A.rx, A.ry).fill({ color: accent }).stroke(outline);
  for (const bx of [10, 17]) g.moveTo(ox + bx, cy - 8).quadraticCurveTo(ox + bx + 2.5, cy, ox + bx, cy + 8);
  g.stroke({ width: 1.1, color: SEAM, alpha: 0.5 });
  g.circle(ox + 29.5, cy, 2.2).fill({ color: darken(accent, 0.6) }).stroke(outline);
  g.ellipse(ox + 35, cy, 6, 4.4).fill({ color: darken(accent, 0.75) }).stroke(outline);
  g.ellipse(ox + H.x, cy, H.rx, H.ry).fill({ color: accent }).stroke(outline);
  // A small gloss on abdomen and head.
  g.ellipse(ox + 12, cy - 4, 4, 1.6).fill({ color: 0xffffff, alpha: 0.45 });
  g.ellipse(ox + H.x - 1, cy - 4, 2.6, 1.2).fill({ color: 0xffffff, alpha: 0.45 });
}

/** A soldier's frames are baked this many times a worker's size. */
export const SOLDIER_SCALE = 2;
const SOLDIER_W = CELL_W * SOLDIER_SCALE;
const SOLDIER_H = CELL_H * SOLDIER_SCALE;
/**
 * The atlas: two rows of worker cells (three walk frames and a corpse), two rows of
 * workers carrying a crumb, then two rows of soldier walk frames.
 * Each row also holds closed/open bite frames: worker columns 4/5, soldier 3/4.
 */
const ATLAS_W = Math.max(CELL_W * 6, SOLDIER_W * 5);
const SOLDIER_Y = CELL_H * 4;
const ATLAS_H = SOLDIER_Y + SOLDIER_H * 2;

/** Every ant outside the selected squad is multiplied by this while a squad is selected, so the squad leads. */
export const DIM_TINT = 0x77706a;
/**
 * A fallen colony's ants (once its last queen dies the board may dim them, through the beat
 * before the result card): multiplied by this, at this alpha, on both boards, whatever squad is selected.
 */
export const FALLEN_TINT = 0x5a5550;
export const FALLEN_ALPHA = 0.6;
export const NO_FALLEN: readonly [boolean, boolean] = [false, false];

/** No agent hues known: every ant plain. */
export const NO_HUES: readonly number[] = [];

/**
 * An ant's tint: a squad ant in its agent's hue (`hue`) at all
 * times; a free ant (agent -1) plain chitin (white), so its colony colour shows. With a squad selected, every ant
 * outside it is dimmed, a squad ant keeping its hue under the dim.
 */
export function antTint(agent: number, selected: number, hue: number): number {
  const own = agent >= 0 ? hue : 0xffffff;
  return selected < 0 || agent === selected ? own : multiply(own, DIM_TINT);
}

/** Two colours multiplied channel by channel, as a tint multiplies the texture. */
function multiply(a: number, b: number): number {
  return channel(a, b, 16) | channel(a, b, 8) | channel(a, b, 0);
}

function channel(a: number, b: number, shift: number): number {
  return Math.round((((a >> shift) & 255) * ((b >> shift) & 255)) / 255) << shift;
}

export class Ants {
  readonly corpseLayer: ParticleContainer;
  readonly antLayer: ParticleContainer;
  /** Per caste (worker, soldier), per colony, per carrying (0 or 1): three walk frames. */
  private walkFrames: Texture[][][][];
  /** Same caste/colony/carrying slots as walkFrames, then closed/open jaws. */
  private biteFrames: Texture[][][][];
  private biteBodies: Texture[][][][];
  private biteHeads: Texture[][][][];
  private readonly bites = new Bites();
  private corpseFrame: Texture[];
  private ants: Particle[] = [];
  private corpses: Particle[] = [];
  private scale: number;
  /** Ids of the selected squad's ants this frame, drawn undimmed in its hue (none while no squad is selected). */
  readonly tinted: number[] = [];

  /** antPx: on-screen ant length in CSS pixels; tilePx: CSS pixels per tile. */
  constructor(renderer: Renderer, antPx: number, tilePx: number) {
    const g = new Graphics();
    for (const colony of [0, 1]) {
      for (let f = 0; f < 3; f++) drawAnt(g, f * CELL_W, colony * CELL_H, f, false, COLONY_TINT[colony]!);
      drawAnt(g, 3 * CELL_W, colony * CELL_H, 0, true, COLONY_TINT[colony]!);
    }
    // Workers carrying a crumb, in rows 2 and 3: their own drawing, so the plain workers' stays as it was.
    const c = new Graphics();
    for (const colony of [0, 1]) {
      for (let f = 0; f < 3; f++) drawAnt(c, f * CELL_W, (2 + colony) * CELL_H, f, false, COLONY_TINT[colony]!, true);
    }
    // Soldiers are drawn in worker units and scaled up as they are baked, so they stay crisp at their size.
    const s = new Graphics();
    s.position.set(0, SOLDIER_Y);
    s.scale.set(SOLDIER_SCALE);
    for (const colony of [0, 1]) {
      for (let f = 0; f < 3; f++) drawSoldier(s, f * CELL_W, colony * CELL_H, f, COLONY_TINT[colony]!);
      for (let jaw = 0; jaw < 2; jaw++) drawSoldier(s, (3 + jaw) * CELL_W, colony * CELL_H, 1, COLONY_TINT[colony]!, jaw);
    }
    // Keep the existing worker walk/corpse drawing untouched. Biting workers
    // have their own cells and explicit mandibles, not a changed walking pose.
    const b = new Graphics();
    for (const colony of [0, 1]) for (const carrying of [0, 1]) for (let jaw = 0; jaw < 2; jaw++) {
      drawAnt(b, (4 + jaw) * CELL_W, (colony + 2 * carrying) * CELL_H, 1, false, COLONY_TINT[colony]!, !!carrying, jaw);
    }
    const holder = new Container();
    holder.addChild(g, s, c, b);
    const atlas = renderer.generateTexture({
      target: holder,
      frame: new Rectangle(0, 0, ATLAS_W, ATLAS_H),
      // Baked at the size it is drawn, so ants stay crisp rather than downsampled.
      resolution: (antPx / CELL_W) * renderer.resolution,
      antialias: true,
    });
    atlas.source.scaleMode = "linear";
    const cell = (i: number, row: number) => new Texture({ source: atlas.source, frame: new Rectangle(i * CELL_W, row * CELL_H, CELL_W, CELL_H) });
    const soldierCell = (i: number, colony: number) =>
      new Texture({ source: atlas.source, frame: new Rectangle(i * SOLDIER_W, SOLDIER_Y + colony * SOLDIER_H, SOLDIER_W, SOLDIER_H) });
    this.walkFrames = [
      [0, 1].map((c) => [0, 1].map((carrying) => [0, 1, 2].map((f) => cell(f, c + 2 * carrying)))),
      // A soldier never carries: both carrying slots hold its own frames.
      [0, 1].map((c) => {
        const frames = [0, 1, 2].map((f) => soldierCell(f, c));
        return [frames, frames];
      }),
    ];
    this.biteFrames = [
      [0, 1].map((c) => [0, 1].map((carrying) => [0, 1].map((jaw) => cell(4 + jaw, c + 2 * carrying)))),
      [0, 1].map((c) => {
        const frames = [0, 1].map((jaw) => soldierCell(3 + jaw, c));
        return [frames, frames];
      }),
    ];
    const crop = (heads: boolean) => this.biteFrames.map((colonies, caste) => colonies.map((slots) => slots.map((frames) => frames.map((t) => {
      const unit = caste ? SOLDIER_SCALE : 1, cut = (caste ? 42 : 44) * unit;
      const width = heads ? t.frame.width - cut : cut;
      return new Texture({ source: t.source,
        frame: new Rectangle(t.frame.x + (heads ? cut : 0), t.frame.y, width, t.frame.height),
        // Trimmed pieces retain the full ant's original bounds and centre.
        orig: new Rectangle(0, 0, t.frame.width, t.frame.height),
        trim: new Rectangle(heads ? cut : 0, 0, width, t.frame.height) });
    }))));
    this.biteBodies = crop(false); this.biteHeads = crop(true);
    this.corpseFrame = [cell(3, 0), cell(3, 1)];
    this.scale = antPx / tilePx / CELL_W;
    const props = { position: true, rotation: true, color: true, uvs: true, vertex: false };
    this.antLayer = new ParticleContainer({ dynamicProperties: props, texture: this.walkFrames[0]![0]![0]![0] });
    this.corpseLayer = new ParticleContainer({ dynamicProperties: props, texture: this.corpseFrame[0] });
  }

  /** The whole-board scale changed (a resize): antPx on-screen length in CSS pixels at tilePx CSS pixels per tile. */
  setFit(antPx: number, tilePx: number) {
    this.scale = antPx / tilePx / CELL_W;
    for (const p of [...this.ants, ...this.corpses]) p.scaleX = p.scaleY = this.scale;
    // Scale is static (vertex) data in these containers: re-upload it.
    this.antLayer.update();
    this.corpseLayer.update();
  }

  private grow(pool: Particle[], layer: ParticleContainer, n: number, texture: Texture) {
    if (layer.particleChildren.length === n) return;
    while (pool.length < n) {
      pool.push(new Particle({ texture, anchorX: 0.5, anchorY: 0.5, scaleX: this.scale, scaleY: this.scale }));
    }
    layer.particleChildren.length = 0;
    for (let i = 0; i < n; i++) layer.particleChildren.push(pool[i]!);
    layer.update();
  }

  /** selected: the agent whose squad leads, every other ant dimmed (-1 for none); hues: each agent's hue by index (squads.ts agentHues); fallen: the colonies whose ants are dimmed as fallen. */
  update(frame: Frame, selected = -1, hues: readonly number[] = NO_HUES, fallen: readonly boolean[] = NO_FALLEN) {
    const n = frame.count;
    this.bites.update(frame);
    this.tinted.length = 0;
    this.grow(this.ants, this.antLayer, n * 2 + frame.corpses.length, this.walkFrames[0]![0]![0]![0]!);
    // An ant's quad size comes from its frame and is static data in this container:
    // re-upload when caste size or head/body trimming changes.
    let resized = false;
    for (let i = 0; i < n; i++) {
      const p = this.ants[i]!;
      const caste = frame.caste[i] === 1 ? 1 : 0;
      const length = this.scale * CELL_W * (caste ? SOLDIER_SCALE : 1);
      const pose = this.bites.pose(i, length, "2d");
      const position = this.bites.bodyPosition(i, length, "2d");
      const slots = [caste, frame.colony[i]!, frame.carrying[i] ? 1 : 0] as const;
      const frames = (pose ? this.biteBodies : this.walkFrames)[slots[0]]![slots[1]]![slots[2]]!;
      const jaw = pose?.jawOpen && pose.jawOpen > 0.5 ? 1 : 0;
      const texture = frames[pose ? jaw : frame.walk[i]!]!;
      p.anchorX = 0.5;
      const head = this.ants[n + i]!;
      const ht = this.biteHeads[slots[0]]![slots[1]]![slots[2]]![jaw]!;
      if (head.texture !== ht) resized = true;
      head.texture = ht; head.anchorX = 0.5;
      head.x = (pose?.x ?? frame.x[i]!) + Math.cos(pose?.rotation ?? 0) * (pose?.headOffset ?? 0) - Math.sin(pose?.rotation ?? 0) * (pose?.headSideOffset ?? 0);
      head.y = (pose?.y ?? frame.y[i]!) + Math.sin(pose?.rotation ?? 0) * (pose?.headOffset ?? 0) + Math.cos(pose?.rotation ?? 0) * (pose?.headSideOffset ?? 0);
      head.rotation = pose?.rotation ?? 0;
      const gone = fallen[frame.colony[i]!] === true;
      const agent = frame.agent[i]!;
      const tint = gone ? FALLEN_TINT : antTint(agent, selected, hues[agent] ?? 0xffffff);
      const alpha = frame.alpha[i]! * (gone ? FALLEN_ALPHA : 1);
      head.alpha = pose ? alpha : 0;
      head.tint = tint;
      if (texture.orig.width !== p.texture.orig.width || texture.trim !== p.texture.trim) resized = true;
      p.texture = texture;
      p.x = position?.x ?? frame.drawX?.[i] ?? frame.x[i]!;
      p.y = position?.y ?? frame.drawY?.[i] ?? frame.y[i]!;
      p.rotation = pose?.rotation ?? frame.drawRotation?.[i] ?? frame.rotation[i]!;
      p.alpha = alpha;
      p.tint = tint;
      if (selected >= 0 && frame.agent[i] === selected) this.tinted.push(frame.id[i]!);
    }
    if (resized) this.antLayer.update();
    const c = frame.corpses;
    this.grow(this.corpses, this.corpseLayer, c.length, this.corpseFrame[0]!);
    for (let i = 0; i < c.length; i++) {
      const k = c[i]!;
      const p = this.corpses[i]!;
      const pose = this.bites.corpsePose(k.antId, this.scale * CELL_W, "2d");
      const caste = frame.engagements.find((e) => e.a === k.antId)?.caste === 1 ? 1 : 0;
      const jaw = pose && pose.jawOpen > 0.5 ? 1 : 0;
      const texture = pose ? this.biteBodies[caste]![k.colony]![0]![jaw]! : this.corpseFrame[k.colony]!;
      if (p.texture !== texture) resized = true;
      p.texture = texture; p.anchorX = 0.5;
      const position = this.bites.corpsePosition(k.antId, this.scale * CELL_W, "2d");
      p.x = position?.x ?? k.x; p.y = position?.y ?? k.y; p.rotation = pose?.rotation ?? k.heading;
      p.tint = CORPSE_TINT; p.alpha = 0.9 * (1 - k.ageMs / CORPSE_FADE_MS);
      const head = this.ants[n * 2 + i]!;
      head.texture = this.biteHeads[caste]![k.colony]![0]![jaw]!;
      head.anchorX = 0.5;
      head.x = p.x + Math.cos(p.rotation) * (pose?.headOffset ?? 0) - Math.sin(p.rotation) * (pose?.headSideOffset ?? 0);
      head.y = p.y + Math.sin(p.rotation) * (pose?.headOffset ?? 0) + Math.cos(p.rotation) * (pose?.headSideOffset ?? 0);
      head.rotation = p.rotation; head.tint = CORPSE_TINT; head.alpha = pose ? p.alpha : 0;
    }
    if (resized) { this.antLayer.update(); this.corpseLayer.update(); }
    this.bites.publishContacts(this.scale * CELL_W, "2d");
  }
}
