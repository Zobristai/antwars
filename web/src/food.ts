/**
 * Food on the board: every tile holding food shows a pile of crumbs,
 * more crumbs and a larger pile for more food, so a viewer sees patches shrink
 * as ants carry them off and regrow, and the food a corpse leaves on its tile.
 *
 * Food is leaf green with the ants' dark outline: amber and cyan are the
 * colonies' colours, and the outline keeps a crumb readable on any ground.
 * Piles are drawn beneath the corpses and ants, from the board at the earlier
 * bracketing message, so a death's food appears in the frame its corpse does.
 * Sizes are CSS px with a floor, so a phone's whole-board view still shows them.
 */
import { Container, Graphics, Particle, ParticleContainer, Rectangle, Texture, type Renderer } from "pixi.js";
import type { Frame } from "./buffer.ts";

export const FOOD = 0x9ccc4a;
export const FOOD_SHADE = 0x3d5a1c;
const FOOD_LIGHT = 0xc4e27c;
const OUTLINE = 0x0b0907;

/** A pile shows one crumb per food, up to this many; past it the pile grows instead. */
export const MAX_CRUMBS = 7;
/** Crumb radius in atlas units; each atlas cell is CELL units square. */
const CRUMB_R = 7;
const CELL = 64;

/** Crumbs drawn for a tile holding amount food. */
export function pileCrumbs(amount: number): number {
  return Math.max(0, Math.min(MAX_CRUMBS, amount));
}

/** Extra scale for a pile past MAX_CRUMBS food, up to 1.5x. */
export function pileGrowth(amount: number): number {
  return amount <= MAX_CRUMBS ? 1 : Math.min(1.5, Math.sqrt(amount / MAX_CRUMBS));
}

/** On-screen crumb radius in CSS px at tilePx CSS px per tile: a ninth of a tile, kept between 1.6 and 4 px. */
export function crumbRadiusPx(tilePx: number): number {
  return Math.min(4, Math.max(1.6, tilePx * 0.11));
}

/** A small stable hash of a tile index, 0..1, for each pile's offset and turn. */
function tileHash(tile: number, salt: number): number {
  let h = Math.imul(tile ^ (salt * 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

export interface Pile {
  tile: number;
  /** Pile centre in tiles: the tile's centre, nudged a little per tile so a patch does not read as a grid. */
  x: number;
  y: number;
  crumbs: number;
  growth: number;
  rotation: number;
}

/** One pile per tile holding food, in tile order. */
export function foodPiles(food: ArrayLike<number>, mapW: number): Pile[] {
  const piles: Pile[] = [];
  for (let tile = 0; tile < food.length; tile++) {
    const amount = food[tile]!;
    if (amount <= 0) continue;
    piles.push({
      tile,
      x: (tile % mapW) + 0.5 + (tileHash(tile, 1) - 0.5) * 0.3,
      y: Math.floor(tile / mapW) + 0.5 + (tileHash(tile, 2) - 0.5) * 0.3,
      crumbs: pileCrumbs(amount),
      growth: pileGrowth(amount),
      rotation: tileHash(tile, 3) * Math.PI * 2,
    });
  }
  return piles;
}

/** Crumb centres in atlas units for a pile of n crumbs: one in the middle, the rest on a golden-angle spiral. */
function crumbSpots(n: number): [number, number][] {
  const spots: [number, number][] = [];
  for (let j = 0; j < n; j++) {
    const d = j === 0 ? 0 : 8.5 * Math.sqrt(j);
    spots.push([Math.cos(j * 2.4) * d, Math.sin(j * 2.4) * d]);
  }
  return spots;
}

export class FoodPiles {
  readonly layer: ParticleContainer;
  /** Index k - 1 holds the pile of k crumbs. */
  private textures: Texture[];
  private pool: Particle[] = [];
  private tilePx: number;
  private drawn: Uint32Array | null = null;
  /** Piles drawn last update (for tests and capture). */
  piles: Pile[] = [];

  constructor(renderer: Renderer, tilePx: number, private readonly physicalScale = 1) {
    this.tilePx = tilePx;
    const g = new Graphics();
    for (let k = 1; k <= MAX_CRUMBS; k++) {
      const ox = (k - 1) * CELL + CELL / 2;
      const oy = CELL / 2;
      const spots = crumbSpots(k);
      // Outline first under every crumb, so touching crumbs share one silhouette.
      for (const [x, y] of spots) g.circle(ox + x, oy + y, CRUMB_R + 2).fill({ color: OUTLINE, alpha: 0.85 });
      spots.forEach(([x, y], j) => {
        g.circle(ox + x, oy + y, CRUMB_R).fill({ color: j % 3 === 1 ? FOOD_LIGHT : FOOD }).stroke({ width: 1.4, color: FOOD_SHADE });
        g.circle(ox + x - 2.2, oy + y - 2.2, 2).fill({ color: 0xffffff, alpha: 0.55 });
      });
    }
    const holder = new Container();
    holder.addChild(g);
    const atlas = renderer.generateTexture({ target: holder, frame: new Rectangle(0, 0, CELL * MAX_CRUMBS, CELL), resolution: 2 * renderer.resolution, antialias: true });
    atlas.source.scaleMode = "linear";
    this.textures = Array.from({ length: MAX_CRUMBS }, (_, i) => new Texture({ source: atlas.source, frame: new Rectangle(i * CELL, 0, CELL, CELL) }));
    this.layer = new ParticleContainer({
      dynamicProperties: { position: true, vertex: true, rotation: true, uvs: true, color: false },
      texture: this.textures[0],
    });
  }

  /** Keep crumbs a readable on-screen size as the camera zooms. */
  setTilePx(tilePx: number) {
    this.tilePx = tilePx;
    this.drawn = null;
  }

  /** Redraws only when the board's food changed (a new array) or the zoom did. */
  update(frame: Pick<Frame, "board">) {
    const board = frame.board;
    if (!board) {
      if (this.layer.particleChildren.length > 0) {
        this.layer.particleChildren.length = 0;
        this.layer.update();
      }
      this.drawn = null;
      this.piles = [];
      return;
    }
    if (board.food === this.drawn) return;
    this.drawn = board.food;
    this.piles = foodPiles(board.food, board.setup.mapW);
    // Tiles per atlas unit at this zoom.
    const unit = crumbRadiusPx(this.tilePx * this.physicalScale) / CRUMB_R / this.tilePx;
    const kids = this.layer.particleChildren;
    kids.length = 0;
    this.piles.forEach((pile, i) => {
      let p = this.pool[i];
      if (!p) {
        p = new Particle({ texture: this.textures[0]!, anchorX: 0.5, anchorY: 0.5 });
        this.pool.push(p);
      }
      p.texture = this.textures[pile.crumbs - 1]!;
      p.x = pile.x;
      p.y = pile.y;
      p.rotation = pile.rotation;
      p.scaleX = p.scaleY = unit * pile.growth;
      kids.push(p);
    });
    this.layer.update();
  }
}
