import { SUB, type MapDefinition, type SimConfig, type TerrainRules } from "./config.js";
import { tileCentre, velocity, type Vec } from "./geometry.js";
import { nextUint32 } from "./rng.js";
import { gridScaleOf } from "./gridScale.js";
import type { Ant, Rock, SimState, Terrain } from "./types.js";

/** Water/map selection precedes food. Rocks are finalized by addRocks after protected tiles are known.
 * A separate seed domain, never consuming gameplay/food random draws. */
export function createTerrain(seed: number, config: SimConfig): Terrain | undefined {
  const rules = config.terrain;
  if (rules === undefined) return undefined;
  const map = selectMap(seed, rules);
  if (map.board !== undefined) {
    // A map's own board keeps its rectangles in its reference tiles.
    const scale = gridScaleOf(config);
    return Object.freeze({ mapId: map.id, mapName: map.name, water: Object.freeze(map.water.map(r => Object.freeze({
      x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale }))) });
  }
  const sx = (x: number) => Math.floor(x * config.mapWidth / rules.referenceWidth);
  const sy = (y: number) => Math.floor(y * config.mapHeight / rules.referenceHeight);
  const water = map.water.map(r => {
    // Both banks round inward/outward together, retaining left/right symmetry.
    const x = sx(r.x), right = config.mapWidth - sx(rules.referenceWidth - r.x - r.width);
    return Object.freeze({ x, y: sy(r.y), width: right - x, height: sy(r.y + r.height) - sy(r.y) });
  });
  return Object.freeze({ mapId: map.id, mapName: map.name, water: Object.freeze(water) });
}

/** The seed's map, or the pinned terrain.mapId. The one draw every match has always used. */
export function selectMap(seed: number, rules: TerrainRules): MapDefinition {
  if (rules.maps.length === 0) throw new Error("terrain requires at least one map");
  const map = rules.mapId === undefined
    ? rules.maps[nextUint32((seed ^ 0x74657272) >>> 0).value % rules.maps.length]!
    : rules.maps.find(m => m.id === rules.mapId);
  if (map === undefined) throw new Error(`unknown terrain map ${rules.mapId}`);
  return map;
}

const WATER = 1, ROCK = 2;
/** Larger obstacle boxes keep the rectangle scan instead of allocating a byte per tile. */
const MAX_LOOKUP_TILES = 1 << 24;

/** One byte per tile over the obstacles' bounding box, with the exact half-open rectangle bounds;
 * null keeps the scan for rectangles a grid cannot represent exactly (non-integer or huge). */
interface TileLookup { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly bits: Uint8Array }
const lookups = new WeakMap<Terrain, TileLookup | null>();

function tileLookup(terrain: Terrain): TileLookup | null {
  let lookup = lookups.get(terrain);
  if (lookup !== undefined) return lookup;
  const rects = [...terrain.water.map(r => [r, WATER] as const), ...(terrain.rocks ?? []).map(r => [r, ROCK] as const)]
    .filter(([r]) => r.width > 0 && r.height > 0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, exact = true;
  for (const [r] of rects) {
    if (![r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height].every(Number.isSafeInteger)) exact = false;
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
  }
  if (rects.length === 0) lookup = { x: 0, y: 0, width: 0, height: 0, bits: new Uint8Array(0) };
  else if (!exact || (maxX - minX) * (maxY - minY) > MAX_LOOKUP_TILES) lookup = null;
  else {
    const width = maxX - minX, bits = new Uint8Array(width * (maxY - minY));
    for (const [r, bit] of rects) for (let y = r.y; y < r.y + r.height; y++) {
      const row = (y - minY) * width - minX;
      for (let x = r.x; x < r.x + r.width; x++) bits[row + x]! |= bit;
    }
    lookup = { x: minX, y: minY, width, height: maxY - minY, bits };
  }
  lookups.set(terrain, lookup);
  return lookup;
}

/** Integer rectangle bounds make floor(x) inside exactly when x is; NaN and out-of-box tiles fail the range test. */
function obstacleBits(lookup: TileLookup, x: number, y: number): number {
  const dx = Math.floor(x) - lookup.x, dy = Math.floor(y) - lookup.y;
  if (!(dx >= 0 && dx < lookup.width && dy >= 0 && dy < lookup.height)) return 0;
  return lookup.bits[dy * lookup.width + dx]!;
}

export function isWaterTile(terrain: Terrain | undefined, x: number, y: number): boolean {
  if (terrain === undefined) return false;
  const lookup = tileLookup(terrain);
  if (lookup !== null) return (obstacleBits(lookup, x, y) & WATER) !== 0;
  return terrain.water.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}

/** Static obstacle footprints share the exact half-open tile convention used by water. */
export function isRockTile(terrain: Terrain | undefined, x: number, y: number): boolean {
  if (terrain === undefined) return false;
  const lookup = tileLookup(terrain);
  if (lookup !== null) return (obstacleBits(lookup, x, y) & ROCK) !== 0;
  return terrain.rocks?.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) ?? false;
}

export function isBlockedTile(terrain: Terrain | undefined, x: number, y: number): boolean {
  if (terrain === undefined) return false;
  const lookup = tileLookup(terrain);
  if (lookup !== null) return obstacleBits(lookup, x, y) !== 0;
  return isWaterTile(terrain, x, y) || isRockTile(terrain, x, y);
}

/** Finalize immutable mirrored obstacles without moving food or consuming gameplay draws.
 * Reject each pair if it splits the remaining land, not merely the nest-to-nest path. */
export function addRocks(seed: number, config: SimConfig, terrain: Terrain | undefined,
  food: readonly number[], starts: readonly Pick<Ant, "x" | "y">[]): Terrain | undefined {
  const rules = config.terrain?.rocks;
  if (terrain === undefined || rules === undefined) return terrain;
  const { mapWidth: width, mapHeight: height } = config;
  const scale = gridScaleOf(config);
  if (![rules.minPairs, rules.maxPairs, rules.minClusterTiles, rules.maxClusterTiles,
      rules.placementAttempts, rules.nestClearanceTiles].every(Number.isInteger) ||
      rules.minPairs < 0 || rules.maxPairs < rules.minPairs || rules.minClusterTiles < 1 ||
      rules.maxClusterTiles > 3 || rules.maxClusterTiles < rules.minClusterTiles ||
      rules.placementAttempts < 1 || rules.nestClearanceTiles < 0) throw new Error("invalid rock placement rules");
  const land = Uint8Array.from(passableMask(config, terrain), value => value ? 1 : 0);
  const protectedTiles = new Set(starts.map(ant => Math.floor(ant.y / SUB) * width + Math.floor(ant.x / SUB)));
  const nestXs = [config.nestTileX, width - 1 - config.nestTileX];
  let rng = (seed ^ 0x726f636b) >>> 0;
  const draw = (range: number) => { const next = nextUint32(rng); rng = next.state; return next.value % range; };
  const pairs = rules.minPairs + draw(rules.maxPairs - rules.minPairs + 1);
  const rocks: Rock[] = [], queue = new Int32Array(land.length), seen = new Uint8Array(land.length);
  const connected = () => {
    seen.fill(0);
    const first = land.indexOf(1);
    if (first < 0) return false;
    let read = 0, write = 1;
    queue[0] = first; seen[first] = 1;
    while (read < write) {
      const at = queue[read++]!, x = at % width, y = Math.floor(at / width);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1,
        y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) {
        if (next >= 0 && land[next] && !seen[next]) { seen[next] = 1; queue[write++] = next; }
      }
    }
    return write === land.reduce((sum, value) => sum + value, 0);
  };
  for (let pair = 0; pair < pairs; pair++) {
    const tiles = rules.minClusterTiles + draw(rules.maxClusterTiles - rules.minClusterTiles + 1);
    const horizontal = draw(2) === 0, rw = (horizontal ? tiles : 1) * scale, rh = (horizontal ? 1 : tiles) * scale;
    const appearance = draw(128), candidates: number[] = [];
    for (let y = 0; y + rh <= height; y += scale) for (let x = 0; x + rw <= Math.floor(width / 2); x += scale) candidates.push(y * width + x);
    let placed = false;
    for (let attempt = 0; attempt < rules.placementAttempts && candidates.length; attempt++) {
      const choice = draw(candidates.length), tile = candidates[choice]!;
      candidates[choice] = candidates[candidates.length - 1]!; candidates.pop();
      const x = tile % width, y = Math.floor(tile / width), mirror = width - x - rw;
      const cells: number[] = [];
      for (const left of [x, mirror]) for (let dy = 0; dy < rh; dy++) for (let dx = 0; dx < rw; dx++) {
        cells.push((y + dy) * width + left + dx);
      }
      if (cells.some(i => !land[i] || (food[i] ?? 0) > 0 || protectedTiles.has(i) ||
        nestXs.some(nx => Math.max(
          Math.abs(Math.floor((i % width) / scale) - ((nx + 0.5) / scale - 0.5)),
          Math.abs(Math.floor(Math.floor(i / width) / scale) - ((config.nestTileY + 0.5) / scale - 0.5)),
        ) <= rules.nestClearanceTiles))) continue;
      for (const i of cells) land[i] = 0;
      if (!connected()) { for (const i of cells) land[i] = 1; continue; }
      rocks.push(Object.freeze({ x, y, width: rw, height: rh, appearance }),
        Object.freeze({ x: mirror, y, width: rw, height: rh, appearance: appearance | 128 }));
      placed = true; break;
    }
    if (!placed) throw new Error(`${terrain.mapId}: cannot place ${pairs} mirrored rock pairs safely (placed ${pair})`);
  }
  return Object.freeze({ ...terrain, rocks: Object.freeze(rocks) });
}

export function isPassable(state: SimState, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 &&
    x < state.config.mapWidth && y < state.config.mapHeight && !isBlockedTile(state.terrain, x, y);
}

const masks = new WeakMap<Terrain, Map<string, readonly boolean[]>>();

/** The last mask passableMask returned, with the terrain and dimensions it belongs to: one match's ticks ask for the same one. */
let lastTerrain: Terrain | undefined, lastWidth = -1, lastHeight = -1, lastMask: readonly boolean[] = [];

/** Static row-major land mask; no ant counts or reservations live here. */
export function passableMask(config: SimConfig, terrain: Terrain): readonly boolean[] {
  if (terrain === lastTerrain && config.mapWidth === lastWidth && config.mapHeight === lastHeight) return lastMask;
  const key = `${config.mapWidth}x${config.mapHeight}`;
  let dimensions = masks.get(terrain);
  if (dimensions === undefined) { dimensions = new Map(); masks.set(terrain, dimensions); }
  let mask = dimensions.get(key);
  if (mask === undefined) {
    mask = Object.freeze(Array.from({ length: config.mapWidth * config.mapHeight }, (_, i) =>
      !isBlockedTile(terrain, i % config.mapWidth, Math.floor(i / config.mapWidth))));
    dimensions.set(key, mask);
  }
  lastTerrain = terrain; lastWidth = config.mapWidth; lastHeight = config.mapHeight; lastMask = mask;
  return mask;
}

let blockedMask: readonly boolean[] | undefined, blocked = new Int32Array(0);

/** Summed-area table of a mask blocked tiles: entry (y, x) of a (width + 1)-wide grid counts those above-left of (x, y). */
function blockedTable(mask: readonly boolean[], width: number, height: number): Int32Array {
  if (mask === blockedMask) return blocked;
  const stride = width + 1, table = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] !== true) row++;
      table[(y + 1) * stride + x + 1] = table[y * stride + x + 1]! + row;
    }
  }
  blockedMask = mask; blocked = table;
  return table;
}

function landAt(mask: readonly boolean[], width: number, height: number, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < width && ty < height && mask[ty * width + tx] === true;
}

/** Supercover tile traversal: reject blocked tiles along a segment, including corner cuts. */
export function segmentOnLand(config: SimConfig, terrain: Terrain | undefined,
  x: number, y: number, endX: number, endY: number): boolean {
  if (terrain === undefined || (terrain.water.length === 0 && (terrain.rocks?.length ?? 0) === 0)) return true;
  const width = config.mapWidth, height = config.mapHeight, mask = passableMask(config, terrain);
  let tx = Math.floor(x / SUB), ty = Math.floor(y / SUB);
  const gx = Math.floor(endX / SUB), gy = Math.floor(endY / SUB);
  if (!landAt(mask, width, height, tx, ty) || !landAt(mask, width, height, gx, gy)) return false;
  // The traversal below visits only tiles inside the endpoints bounding box, corner checks
  // included: when that box holds no blocked tile, every tile it would visit is land.
  const blocked = blockedTable(mask, width, height), stride = width + 1;
  const x0 = tx < gx ? tx : gx, x1 = (tx < gx ? gx : tx) + 1, y0 = ty < gy ? ty : gy, y1 = (ty < gy ? gy : ty) + 1;
  if (blocked[y1 * stride + x1]! - blocked[y0 * stride + x1]! - blocked[y1 * stride + x0]! + blocked[y0 * stride + x0]! === 0) return true;
  const dx = endX - x, dy = endY - y, sx = Math.sign(dx), sy = Math.sign(dy);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  let crossX = sx > 0 ? (tx + 1) * SUB - x : x - tx * SUB;
  let crossY = sy > 0 ? (ty + 1) * SUB - y : y - ty * SUB;
  // Both endpoints are on the map, so every tile of their box, and so every tile visited below, is too:
  // the land test needs no bounds check here.
  while (tx !== gx || ty !== gy) {
    const horizontal = tx === gx || ax === 0 ? Infinity : crossX * ay;
    const vertical = ty === gy || ay === 0 ? Infinity : crossY * ax;
    if (horizontal === vertical) {
      if (mask[ty * width + tx + sx] !== true || mask[(ty + sy) * width + tx] !== true) return false;
      tx += sx; ty += sy; crossX += SUB; crossY += SUB;
    } else if (horizontal < vertical) { tx += sx; crossX += SUB; }
    else { ty += sy; crossY += SUB; }
    if (mask[ty * width + tx] !== true) return false;
  }
  return true;
}

/** Static-terrain movement boundary; a later reservation seam replaces this call. */
export function moveOnLand(config: SimConfig, terrain: Terrain, ant: Ant, dir: Vec, speed: number): void {
  // A zero heading on the map is a zero step: the ant stays, and either answer of the land test leaves it so.
  if (dir.x === 0 && dir.y === 0 && ant.x >= 0 && ant.x <= config.mapWidth * SUB - 1 && ant.y >= 0 && ant.y <= config.mapHeight * SUB - 1) {
    ant.vx = 0; ant.vy = 0; return;
  }
  const v = velocity(dir, speed);
  const x = Math.max(0, Math.min(config.mapWidth * SUB - 1, ant.x + v.x));
  const y = Math.max(0, Math.min(config.mapHeight * SUB - 1, ant.y + v.y));
  if (!segmentOnLand(config, terrain, ant.x, ant.y, x, y)) { ant.vx = 0; ant.vy = 0; return; }
  ant.vx = x - ant.x; ant.vy = y - ant.y; ant.x = x; ant.y = y;
}

/** A blocked birth waits, or uses the nearest passable tile still inside nest delivery reach. */
export function landBirthPosition(config: SimConfig, terrain: Terrain | undefined,
  x: number, y: number, colony: number): Vec | null {
  if (terrain === undefined || !isBlockedTile(terrain, Math.floor(x / SUB), Math.floor(y / SUB))) return { x, y };
  const tx = Math.floor(x / SUB), ty = Math.floor(y / SUB), radius = config.nestDeliverTiles;
  let best: Vec | null = null, distance = Infinity;
  for (let ny = Math.max(0, ty - radius); ny <= Math.min(config.mapHeight - 1, ty + radius); ny++) {
    // Mirror tie-breaking around the two colonies' fixed nest axis.
    for (let offset = -radius; offset <= radius; offset++) {
      const nx = tx + (colony === 0 ? offset : -offset);
      if (nx < 0 || nx >= config.mapWidth || isBlockedTile(terrain, nx, ny)) continue;
      const d = (nx - tx) ** 2 + (ny - ty) ** 2;
      if (d < distance) { distance = d; best = { x: tileCentre(nx), y: tileCentre(ny) }; }
    }
  }
  return best;
}

/** Public static geometry, not a second fogged entity map. */
export function terrainView(terrain: Terrain) {
  return { mapId: terrain.mapId, mapName: terrain.mapName,
    encoding: terrain.rocks === undefined ? "water rectangles [x,y,width,height], half-open tile bounds; all other tiles land"
      : "water and rocks rectangles [x,y,width,height], half-open tiles; other tiles land",
    water: terrain.water.map(r => [r.x, r.y, r.width, r.height] as const),
    ...(terrain.rocks === undefined ? {} : { rocks: terrain.rocks.map(r => [r.x, r.y, r.width, r.height] as const) }) };
}
