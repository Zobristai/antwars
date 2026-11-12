/**
 * Four-colony quadrant maps: validation and seeded board generation on the reference grid.
 *
 * A quadrant map describes its top-left quadrant (water, nest, start area and food templates)
 * and a contested centre region around the board's centre point. The board is the quadrant
 * mirrored left/right and up/down, so every colony starts with the same ground and food.
 * The match seed adds four-way mirrored rock groups outside the centre, then places the centre
 * food anywhere it fits inside the centre region.
 *
 * Quadrant order everywhere: top-left, top-right (left/right mirror), bottom-left (up/down
 * mirror), bottom-right (both). Two-colony rotations refuse quadrant maps (validateMapBoard).
 */
import { ROCK_RULES, type FoodPatch, type MapDefinition, type QuadrantLayout, type WaterRect } from "./config.js";
import { boardSizeProblem, OWN_VALUE_GRID_SCALE } from "./mapBoard.js";
import { nextUint32 } from "./rng.js";
import type { Rock } from "./types.js";

export interface QuadrantTile { readonly tx: number; readonly ty: number }

/** A generated quadrant board, in reference tiles. Each list holds every template's four images in quadrant order. */
export interface QuadrantBoard {
  readonly mapId: string;
  readonly mapName: string;
  readonly width: number;
  readonly height: number;
  readonly centre: WaterRect;
  readonly nests: readonly QuadrantTile[];
  readonly startAreas: readonly WaterRect[];
  readonly water: readonly WaterRect[];
  readonly quadrantFood: readonly FoodPatch[];
  /** The right-hand copies carry the mirror bit 128 in their appearance, as two-colony rocks do. */
  readonly rocks: readonly Rock[];
  readonly centreFood: readonly FoodPatch[];
}

/** Rock groups per board: today's 6 to 8 mirrored pairs per half board, per quarter board. */
const ROCK_GROUPS = { min: 3, max: 4 };
/** Seed domains of their own, so neither draw shares another's random sequence. */
const ROCK_SEED = 0x71726f6b, CENTRE_SEED = 0x63656e74;

const rect = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });
const overlaps = (a: WaterRect, b: WaterRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: WaterRect, inner: WaterRect): boolean => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const whole = (...values: number[]): boolean => values.every(Number.isSafeInteger);

function centreOf(q: QuadrantLayout): WaterRect {
  return rect(q.referenceWidth / 2 - q.centreHalfWidth, q.referenceHeight / 2 - q.centreHalfHeight,
    2 * q.centreHalfWidth, 2 * q.centreHalfHeight);
}

function rectImages(q: QuadrantLayout, r: WaterRect): WaterRect[] {
  const mx = q.referenceWidth - r.x - r.width, my = q.referenceHeight - r.y - r.height;
  return [rect(r.x, r.y, r.width, r.height), rect(mx, r.y, r.width, r.height), rect(r.x, my, r.width, r.height), rect(mx, my, r.width, r.height)];
}

function tileImages(q: QuadrantLayout, tx: number, ty: number): QuadrantTile[] {
  const mx = q.referenceWidth - 1 - tx, my = q.referenceHeight - 1 - ty;
  return [{ tx, ty }, { tx: mx, ty }, { tx, ty: my }, { tx: mx, ty: my }];
}

/** The tiles of a food disk: those within its radius of its centre tile (Euclidean), as food is laid today. */
function diskTiles(p: { readonly tileX: number; readonly tileY: number; readonly radius: number }): QuadrantTile[] {
  const tiles: QuadrantTile[] = [];
  for (let dy = -p.radius; dy <= p.radius; dy++) for (let dx = -p.radius; dx <= p.radius; dx++) {
    if (dx * dx + dy * dy <= p.radius * p.radius) tiles.push({ tx: p.tileX + dx, ty: p.tileY + dy });
  }
  return tiles;
}

/** A quadrant layout with the map's water, which is the top-left quadrant's. */
type Layout = QuadrantLayout & { readonly waterTemplates: readonly WaterRect[] };

/** The seed-free board (water, quadrant food and nests) and the land region holding the first nest. */
interface Ground {
  readonly q: Layout;
  readonly width: number;
  readonly centre: WaterRect;
  readonly nests: readonly QuadrantTile[];
  readonly land: Uint8Array;
  readonly food: Uint8Array;
  region: Uint8Array;
  regionSize: number;
}

function flood(g: Ground): { seen: Uint8Array; size: number } {
  const width = g.width, height = g.q.referenceHeight, seen = new Uint8Array(g.land.length);
  const start = g.nests[0]!.ty * width + g.nests[0]!.tx;
  if (!g.land[start]) return { seen, size: 0 };
  const queue = new Int32Array(g.land.length);
  let read = 0, write = 1;
  queue[0] = start; seen[start] = 1;
  while (read < write) {
    const at = queue[read++]!, x = at % width, y = Math.floor(at / width);
    for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
      if (next >= 0 && g.land[next] && !seen[next]) { seen[next] = 1; queue[write++] = next; }
    }
  }
  return { seen, size: write };
}

function ground(q: Layout): Ground {
  const width = q.referenceWidth, land = new Uint8Array(width * q.referenceHeight).fill(1), food = new Uint8Array(land.length);
  for (const water of q.waterTemplates) for (const r of rectImages(q, water)) {
    for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) land[y * width + x] = 0;
  }
  for (const patch of q.foodPatches) for (const { tx, ty } of tileImages(q, patch.tileX, patch.tileY)) {
    for (const tile of diskTiles({ ...patch, tileX: tx, tileY: ty })) food[tile.ty * width + tile.tx] = 1;
  }
  const g: Ground = { q, width, centre: centreOf(q), nests: tileImages(q, q.nestTileX, q.nestTileY), land, food, region: new Uint8Array(0), regionSize: 0 };
  const region = flood(g);
  g.region = region.seen; g.regionSize = region.size;
  return g;
}

/** Rock spots of one size: inside the top-left quadrant and outside the centre, row by row. */
function rockSpots(g: Ground, width: number, height: number): WaterRect[] {
  const spots: WaterRect[] = [];
  for (let y = 0; y + height <= g.q.referenceHeight / 2; y++) for (let x = 0; x + width <= g.width / 2; x++) {
    const spot = rect(x, y, width, height);
    if (!overlaps(spot, g.centre)) spots.push(spot);
  }
  return spots;
}

/** Place a rock and its three mirror images when all four lie on land, clear of food and of every nest's
 * clearance, and the nests' land region loses no tile but the rocks' own; otherwise change nothing. */
function placeRock(g: Ground, spot: WaterRect): boolean {
  const clearance = ROCK_RULES.nestClearanceTiles, cells: number[] = [];
  for (const r of rectImages(g.q, spot)) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const i = y * g.width + x;
    if (!g.land[i] || g.food[i] || g.nests.some(n => Math.max(Math.abs(x - n.tx), Math.abs(y - n.ty)) <= clearance)) return false;
    cells.push(i);
  }
  const lost = cells.filter(i => g.region[i]).length;
  for (const i of cells) g.land[i] = 0;
  const after = flood(g);
  if (after.size !== g.regionSize - lost) {
    for (const i of cells) g.land[i] = 1;
    return false;
  }
  g.region = after.seen; g.regionSize = after.size;
  return true;
}

function layoutOf(map: MapDefinition): Layout {
  if (map.quadrant === undefined) throw new RangeError(`${map.id}: not a quadrant map`);
  return { ...map.quadrant, waterTemplates: map.water };
}

/**
 * Refuse, never clamp. Beyond the format itself, validation proves what generation then guarantees for
 * every seed: the four nests and the centre share one land region, and at least one rock group fits.
 */
export function validateQuadrantMap(map: MapDefinition): void {
  checkedLayout(map);
}

function checkedLayout(map: MapDefinition): Layout {
  const fail = (why: string): never => { throw new RangeError(`${map.id}: ${why}`); };
  const q = layoutOf(map);
  if (map.board !== undefined) fail("a quadrant map carries no two-colony board");
  const { referenceWidth: width, referenceHeight: height } = q;
  const size = boardSizeProblem(width, height, OWN_VALUE_GRID_SCALE);
  if (size !== null) fail(`unsupported board ${width}x${height}: ${size}`);
  if (height % 2 !== 0) fail("board height must be even (mirrored top and bottom halves)");
  if (!whole(q.centreHalfWidth, q.centreHalfHeight) || q.centreHalfWidth < 1 || q.centreHalfHeight < 1 ||
      q.centreHalfWidth >= width / 2 || q.centreHalfHeight >= height / 2) {
    fail("the centre region must be whole tiles strictly inside the board");
  }
  const quadrant = rect(0, 0, width / 2, height / 2), centre = centreOf(q);
  const place = (kind: string, area: WaterRect, tiles: readonly QuadrantTile[]): void => {
    if (!contains(quadrant, area)) fail(`${kind} must lie inside the top-left quadrant`);
    if (tiles.some(t => overlaps(rect(t.tx, t.ty, 1, 1), centre))) fail(`${kind} must not overlap the centre region`);
  };
  // Inside the quadrant, a rectangle overlaps the centre region exactly when its bottom-right tile lies in it.
  const farTile = (r: WaterRect): QuadrantTile[] => [{ tx: r.x + r.width - 1, ty: r.y + r.height - 1 }];
  for (const r of q.waterTemplates) {
    if (!whole(r.x, r.y, r.width, r.height) || r.width < 1 || r.height < 1) fail("water rectangles must be positive whole tiles");
    place("water rectangles", r, farTile(r));
  }
  if (!whole(q.nestTileX, q.nestTileY)) fail("the nest must be a whole tile");
  place("the nest", rect(q.nestTileX, q.nestTileY, 1, 1), [{ tx: q.nestTileX, ty: q.nestTileY }]);
  const start = q.startArea;
  if (!whole(start.x, start.y, start.width, start.height) || start.width < 1 || start.height < 1) fail("the start area must be positive whole tiles");
  place("the start area", start, farTile(start));
  for (const p of q.foodPatches) {
    if (!whole(p.tileX, p.tileY, p.radius, p.perTile) || p.radius < 1 || p.perTile < 1) fail("food templates must be whole tiles with radius and amount at least 1");
    place("food templates", rect(p.tileX - p.radius, p.tileY - p.radius, 2 * p.radius + 1, 2 * p.radius + 1), diskTiles(p));
  }
  if (q.centreFood.length === 0) fail("the centre needs at least one food disk");
  // The centre's sides are even and a disk spans an odd 2 x radius + 1 tiles, so every disk that fits has at
  // least two positions on each axis: the centre food differs between draws.
  for (const disk of q.centreFood) {
    if (!whole(disk.radius, disk.perTile) || disk.radius < 1 || disk.perTile < 1) fail("centre food disks must have whole radius and amount at least 1");
    if (2 * disk.radius + 1 > Math.min(centre.width, centre.height)) fail("centre food disks must fit inside the centre region");
  }
  const g = ground(q);
  if (!g.land[q.nestTileY * width + q.nestTileX]) fail("the nest must be on land");
  if (![...g.nests, { tx: centre.x, ty: centre.y }].every(t => g.region[t.ty * width + t.tx])) {
    fail("the four nests and the centre must share one land region");
  }
  // The same rule the first rock group falls back to on the same seed-free board: one spot proves every seed gets a rock group.
  const proof = ground(q);
  if (!rockSpots(proof, 1, 1).some(spot => placeRock(proof, spot))) {
    fail("no room for a rock: every spot touches water, food or a nest's clearance, or cuts land off from the nests");
  }
  return q;
}

/** The board a quadrant map generates for a match seed. The same seed always gives the same board. */
export function generateQuadrantBoard(map: MapDefinition, seed: number): QuadrantBoard {
  const q = checkedLayout(map), g = ground(q);
  let rng = (seed ^ ROCK_SEED) >>> 0;
  const draw = (range: number): number => { const next = nextUint32(rng); rng = next.state; return next.value % range; };
  const rocks: Rock[] = [];
  const groups = ROCK_GROUPS.min + draw(ROCK_GROUPS.max - ROCK_GROUPS.min + 1);
  for (let group = 0; group < groups; group++) {
    const tiles = ROCK_RULES.minClusterTiles + draw(ROCK_RULES.maxClusterTiles - ROCK_RULES.minClusterTiles + 1);
    const horizontal = draw(2) === 0, appearance = draw(128);
    // The first group falls back to one tile, which validation proved fits; a later group that fits nowhere is left out.
    const sizes = group === 0 && tiles > 1 ? [[horizontal ? tiles : 1, horizontal ? 1 : tiles], [1, 1]] : [[horizontal ? tiles : 1, horizontal ? 1 : tiles]];
    let placed: WaterRect | undefined;
    for (const [width, height] of sizes) {
      const spots = rockSpots(g, width!, height!);
      while (placed === undefined && spots.length > 0) {
        const choice = draw(spots.length), spot = spots[choice]!;
        spots[choice] = spots[spots.length - 1]!; spots.pop();
        if (placeRock(g, spot)) placed = spot;
      }
      if (placed !== undefined) break;
    }
    if (placed === undefined) continue;
    rectImages(q, placed).forEach((r, i) => rocks.push({ ...r, appearance: i % 2 === 1 ? appearance | 128 : appearance }));
  }
  let centreRng = (seed ^ CENTRE_SEED) >>> 0;
  const drawCentre = (range: number): number => { const next = nextUint32(centreRng); centreRng = next.state; return next.value % range; };
  const centre = g.centre;
  const centreFood = q.centreFood.map(({ radius, perTile }) => ({
    tileX: centre.x + radius + drawCentre(centre.width - 2 * radius),
    tileY: centre.y + radius + drawCentre(centre.height - 2 * radius), radius, perTile }));
  return {
    mapId: map.id, mapName: map.name, width: q.referenceWidth, height: q.referenceHeight, centre,
    nests: g.nests, startAreas: rectImages(q, q.startArea),
    water: q.waterTemplates.flatMap(r => rectImages(q, r)),
    quadrantFood: q.foodPatches.flatMap(p => tileImages(q, p.tileX, p.tileY).map(({ tx, ty }) => ({ ...p, tileX: tx, tileY: ty }))),
    rocks, centreFood,
  };
}
