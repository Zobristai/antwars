/** The seven map checks,
 * for the four maps added to the grid-scale-2 rotation and the two v2 maps swapped in, each run at the
 * map's own board size.
 * Carried (commit 66302c50fda5dabf3c9b8ebe47c94c34f586c51b) at grid scale 2 only. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch, nestTile } from "../../src/sim/map.js";
import { startBoxes } from "../../src/sim/startPlacement.js";
import { isBlockedTile, isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { newMatchMaps } from "../../src/sim/mapShapes.js";
import type { SimState } from "../../src/sim/types.js";
import type { WaterRect } from "../../src/sim/config.js";

/** Seeds 1-8, 15, 6006 and 7001 (a sample, not proof for every seed); seeds 1-8 and 15 draw each of the seven maps in the unpinned rotation. */
export const SEEDS: readonly number[] = [...Array.from({ length: 8 }, (_, i) => i + 1), 15, 6006, 7001];
export type FoodSet = "redesign";
export type Fixture = "default placement" | "mirrored four-seat pick";
export const FIXTURES: readonly Fixture[] = ["default placement", "mirrored four-seat pick"];

export type Scale2MapId = "isthmus" | "twin-shields" | "four-lanes" | "wide-plain";
export type V2MapId = "three-crossings-v2" | "central-lake-v2";
export type NewMapId = Scale2MapId | V2MapId;
/** The new-match grid scale, the only one these maps play at. */
export const SCALE = 2;

/** The default server's rules (redesign), as a new match (grid scale 2, seven-map rotation) with the map pinned. */
export function newMapConfig(mapId: NewMapId, foodSet: FoodSet): SimConfig {
  const config = newMatchConfig(rulesConfig(foodSet));
  return newMatchConfig({ ...config, terrain: { ...config.terrain!, mapId } });
}

/** Four legal tiles in colony 0's start box nearest its quarter rows, and their exact mirrors for colony 1. */
function fourSeatPick(state: SimState): SimConfig {
  const c = state.config, [box] = startBoxes(c);
  const legal = (x: number, y: number) => !isBlockedTile(state.terrain, x, y) && state.food[y * c.mapWidth + x] === 0;
  const picks: { tileX: number; tileY: number }[] = [];
  for (const quarter of [1, 3, 5, 7]) {
    const tx = box.x + Math.floor(box.width / 2), ty = box.y + Math.floor(box.height * quarter / 8);
    let best: { tileX: number; tileY: number } | null = null, bestD = Infinity;
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (d < bestD && legal(x, y) && !picks.some(p => p.tileX === x && p.tileY === y)) { best = { tileX: x, tileY: y }; bestD = d; }
    }
    if (best === null) throw new Error("no legal start tile for the four-seat pick");
    picks.push(best);
  }
  return { ...c, initialQueens: [picks, picks.map(p => ({ tileX: c.mapWidth - 1 - p.tileX, tileY: p.tileY }))] };
}

export function playMatch(seed: number, config: SimConfig, fixture: Fixture): SimState {
  const state = createMatch(seed, config);
  return fixture === "default placement" ? state : createMatch(seed, fourSeatPick(state));
}

/** Tiles reachable by 4-way steps over unblocked land, from the sources, never entering the extra blocked tiles. */
export function reach(state: SimState, sources: Iterable<number>, blocked: (x: number, y: number) => boolean = () => false): Uint8Array {
  const { mapWidth: w, mapHeight: h } = state.config;
  const open = (x: number, y: number) => !isBlockedTile(state.terrain, x, y) && !blocked(x, y);
  const seen = new Uint8Array(w * h), queue: number[] = [];
  for (const s of sources) if (!seen[s] && open(s % w, Math.floor(s / w))) { seen[s] = 1; queue.push(s); }
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!, x = at % w, y = Math.floor(at / w);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (!seen[next] && open(nx, ny)) { seen[next] = 1; queue.push(next); }
    }
  }
  return seen;
}

export function nestIndex(state: SimState, colony: 0 | 1): number {
  const { tx, ty } = nestTile(state.config, colony);
  return Math.floor(ty) * state.config.mapWidth + Math.floor(tx);
}

/** Water-free rows of a native column, as half-open bands. */
export function dryBands(state: SimState, x: number): [number, number][] {
  const bands: [number, number][] = [];
  for (let y = 0; y < state.config.mapHeight; y++) {
    if (isWaterTile(state.terrain, x, y)) continue;
    const last = bands[bands.length - 1];
    if (last?.[1] === y) last[1]++; else bands.push([y, y + 1]);
  }
  return bands;
}

/** Checks 1-4, 6 and 7 for one match; failures are named, never thrown. */
export function commonChecks(state: SimState): string[] {
  const failures: string[] = [], c = state.config, w = c.mapWidth, h = c.mapHeight;
  const fail = (label: string) => failures.push(label);
  // 1. Mirrored water: every rectangle has its exact left-right mirror.
  const water = state.terrain!.water;
  if (!water.every(r => water.some(o => o.x === w - r.x - r.width && o.y === r.y && o.width === r.width && o.height === r.height))) fail("1 water rectangle without its mirror");
  // 2. Mirrored starts: water, rocks, food, ants and queens.
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) {
    const m = w - 1 - x;
    if (isWaterTile(state.terrain, x, y) !== isWaterTile(state.terrain, m, y)) { fail(`2 water not mirrored at ${x},${y}`); break; }
    if (isRockTile(state.terrain, x, y) !== isRockTile(state.terrain, m, y)) { fail(`2 rocks not mirrored at ${x},${y}`); break; }
    if (state.food[y * w + x] !== state.food[y * w + m]) { fail(`2 food not mirrored at ${x},${y}`); break; }
  }
  const zero = state.ants.filter(a => a.colony === 0), one = state.ants.filter(a => a.colony === 1);
  if (zero.length !== one.length || zero.some((a, i) => one[i]!.x !== w * SUB - a.x || one[i]!.y !== a.y || one[i]!.hp !== a.hp)) fail("2 ants not mirrored");
  const q0 = state.colonies[0].queens ?? [], q1 = state.colonies[1].queens ?? [];
  if (q0.length !== q1.length || q0.some((q, i) => q1[i]!.queenX !== w * SUB - q.queenX || q1[i]!.queenY !== q.queenY)
    || state.colonies[1].queenX !== w * SUB - state.colonies[0].queenX || state.colonies[1].queenY !== state.colonies[0].queenY) fail("2 queens not mirrored");
  // 3. Legal nest boxes: both fit, hold the same number of legal nest tiles, at least four.
  let boxes;
  try { boxes = startBoxes(c); } catch (err) { fail(`3 start areas do not fit: ${(err as Error).message}`); }
  if (boxes !== undefined) {
    const counts = boxes.map(b => {
      let n = 0;
      for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
        if (!isBlockedTile(state.terrain, x, y) && state.food[y * w + x] === 0) n++;
      }
      return n;
    });
    if (counts[0] !== counts[1] || counts[0]! < 4) fail(`3 legal nest tiles ${counts.join(" vs ")}`);
  }
  // 4. Connected land: one region with this seed's rocks.
  let land = 0, first = -1;
  for (let i = 0; i < w * h; i++) if (!isBlockedTile(state.terrain, i % w, Math.floor(i / w))) { land++; if (first < 0) first = i; }
  const region = reach(state, [first]).reduce((s, v) => s + v, 0);
  if (region !== land) fail(`4 land split: ${region} of ${land} tiles connected`);
  // 6. Reachable food: required templates placed, optional ones omitted only whole, every patch reachable from both start areas.
  const templates = c.foodLayout!.patches.length, optionalTemplates = c.foodLayout!.optionalPatchIndices?.length ?? 0;
  const placed = c.foodPatches.length;
  if (placed < templates - optionalTemplates || placed > templates) fail(`6 ${placed} of ${templates} templates placed`);
  if (boxes !== undefined) for (const [colony, b] of boxes.entries()) {
    const sources: number[] = [];
    for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) sources.push(y * w + x);
    const seen = reach(state, sources);
    const lost = state.food.findIndex((amount, i) => amount > 0 && !seen[i]);
    if (lost >= 0) fail(`6 food at ${lost % w},${Math.floor(lost / w)} unreachable from start area ${colony}`);
  }
  // 7. Rocks place (createMatch throws otherwise), within the configured pair count.
  const rocks = state.terrain!.rocks ?? [], rules = c.terrain!.rocks!;
  if (rocks.length < 2 * rules.minPairs || rocks.length > 2 * rules.maxPairs) fail(`7 ${rocks.length} rocks`);
  return failures;
}

export interface NewMapSuite {
  readonly mapId: NewMapId;
  readonly name: string;
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  readonly foodSets: readonly FoodSet[];
  /** Check 5, readable routes, at the scale. */
  readonly routes: (state: SimState, scale: number) => string[];
}

/** One test per food set and fixture at grid scale 2; each loops seeds 1-8, 15, 6006 and 7001 and names every failing seed. */
export function describeNewMapChecks(suite: NewMapSuite): void {
  describe(`${suite.name} (${suite.referenceWidth}x${suite.referenceHeight}) at grid scale ${SCALE}`, () => {
    const scale = SCALE, width = suite.referenceWidth * scale, height = suite.referenceHeight * scale;
    const cases = suite.foodSets.flatMap(foodSet => FIXTURES.map(fixture => [foodSet, fixture] as const));
    it.each(cases)(`${width}x${height} tiles, %s food, %s: checks 1-7 for seeds 1-8, 15, 6006 and 7001`, (foodSet, fixture) => {
      const config = newMapConfig(suite.mapId, foodSet);
      const failures: string[] = [];
      for (const seed of SEEDS) {
        let state: SimState;
        try { state = playMatch(seed, config, fixture); } catch (err) { failures.push(`seed ${seed}: 7/6 match failed: ${(err as Error).message}`); continue; }
        if (state.terrain?.mapId !== suite.mapId || state.config.mapWidth !== width || state.config.mapHeight !== height) {
          failures.push(`seed ${seed}: played ${state.terrain?.mapId} at ${state.config.mapWidth}x${state.config.mapHeight}`);
          continue;
        }
        if (fixture === "mirrored four-seat pick" && state.colonies.some(col => col.queens?.length !== 4)) failures.push(`seed ${seed}: four-seat pick not installed`);
        for (const f of [...commonChecks(state), ...suite.routes(state, scale)]) failures.push(`seed ${seed}: ${f}`);
      }
      expect(failures).toEqual([]);
    }, 300_000);
  });
}

/** Explicit-id selection in the grid-scale-2 new-match rotation, and the seeds that draw the map. */
export function describeNewMapSelection(suite: NewMapSuite, nest: { x: number; y: number }): void {
  describe(`${suite.name} is selectable by explicit map id at grid scale ${SCALE}`, () => {
    const scale = SCALE;
    it.each(suite.foodSets)("with %s food: its name, size, nest and back-quarter start areas", foodSet => {
      const config = newMapConfig(suite.mapId, foodSet);
      expect(config.terrain!.mapId).toBe(suite.mapId);
      const state = createMatch(7001, config);
      const w = suite.referenceWidth * scale, h = suite.referenceHeight * scale;
      expect([state.terrain!.mapId, state.terrain!.mapName]).toEqual([suite.mapId, suite.name]);
      expect([state.config.mapWidth, state.config.mapHeight, state.config.gridScale]).toEqual([w, h, scale]);
      expect([state.config.nestTileX, state.config.nestTileY]).toEqual([(nest.x + 0.5) * scale - 0.5, (nest.y + 0.5) * scale - 0.5]);
      expect(startBoxes(state.config)).toEqual([{ x: 0, y: 0, width: w / 4, height: h }, { x: w - w / 4, y: 0, width: w / 4, height: h }]);
    });

    it("in the unpinned rotation, some of seeds 1-8 and 15 draw it, at its own size", () => {
      const config = newMatchConfig(rulesConfig("redesign"));
      expect(config.terrain!.mapId).toBeUndefined();
      const drawn = SEEDS.map(seed => createMatch(seed, config)).filter(state => state.terrain!.mapId === suite.mapId);
      expect(drawn.length).toBeGreaterThan(0);
      for (const state of drawn) expect([state.config.mapWidth, state.config.mapHeight]).toEqual([suite.referenceWidth * scale, suite.referenceHeight * scale]);
    });
  });
}

/** water-rev4.json, byte for byte. */
const WATER_REV4_BYTES = readFileSync(new URL("./water-rev4.json", import.meta.url));
const WATER_REV4_SHA256 = "65705ae7e55220a41ed722daaf48c4b1c1e62e8ccc770fcb88c48cfff9202861";
type ListRect = [number, number, number, number];
type WaterLists = { board: false; scale1: ListRect[]; scale2: ListRect[] } | { board: true; reference: ListRect[] };
const WATER_REV4 = JSON.parse(WATER_REV4_BYTES.toString("utf8")) as Record<Scale2MapId, WaterLists>;
const asRects = (list: readonly ListRect[], factor: number): WaterRect[] =>
  list.map(([x, y, width, height]) => ({ x: x * factor, y: y * factor, width: width * factor, height: height * factor }));

/** The exact-lists check at grid scale 2: the stored water is water-rev4.json's list, and a match plays it in native tiles. */
export function describeExactWater(suite: NewMapSuite): void {
  it(`${suite.name}: water is exactly water-rev4.json's at grid scale ${SCALE}, as stored and as played`, () => {
    expect(createHash("sha256").update(WATER_REV4_BYTES).digest("hex")).toBe(WATER_REV4_SHA256);
    const lists = WATER_REV4[suite.mapId as Scale2MapId];
    // Without a board: the scale2 list in native tiles. With a board: the reference list, times the scale when played.
    const stored = lists.board ? asRects(lists.reference, 1) : asRects(lists.scale2, 1);
    const played = lists.board ? asRects(lists.reference, SCALE) : stored;
    expect(SCALE2_MAPS.find(m => m.id === suite.mapId)!.water).toEqual(stored);
    expect(newMapConfig(suite.mapId, suite.foodSets[0]!).terrain!.maps.find(m => m.id === suite.mapId)!.water).toEqual(stored);
    expect(createMatch(7001, newMapConfig(suite.mapId, suite.foodSets[0]!)).terrain!.water).toEqual(played);
  });
}

/** The sheet's water-older.json, byte for byte.
 * Its keys carry the old ids because the sheet predates the v2 naming; each scale2 list is that v2 map's water. */
const WATER_OLDER_BYTES = readFileSync(new URL("./water-older.json", import.meta.url));
const WATER_OLDER_SHA256 = "3fe2bde7c2bc376c82a50ea984e0485a2183a48973e5a0efb1cf5aba2847b987";
const WATER_OLDER = JSON.parse(WATER_OLDER_BYTES.toString("utf8")) as Record<"three-crossings" | "central-lake", { scale2: ListRect[] }>;
const OLDER_KEY: Record<V2MapId, "three-crossings" | "central-lake"> = { "three-crossings-v2": "three-crossings", "central-lake-v2": "central-lake" };

/** The exact-lists check for a v2 map: the stored water is water-older.json's scale2 list in native tiles, as stored and as played. */
export function describeExactOlderWater(suite: NewMapSuite & { readonly mapId: V2MapId }): void {
  it(`${suite.name}: water is exactly water-older.json's scale2 list at grid scale ${SCALE}, as stored and as played`, () => {
    expect(createHash("sha256").update(WATER_OLDER_BYTES).digest("hex")).toBe(WATER_OLDER_SHA256);
    const stored = asRects(WATER_OLDER[OLDER_KEY[suite.mapId]].scale2, 1);
    expect(newMatchMaps().find(m => m.id === suite.mapId)!.water).toEqual(stored);
    expect(newMapConfig(suite.mapId, suite.foodSets[0]!).terrain!.maps.find(m => m.id === suite.mapId)!.water).toEqual(stored);
    expect(createMatch(7001, newMapConfig(suite.mapId, suite.foodSets[0]!)).terrain!.water).toEqual(stored);
  });
}

type Band = readonly [number, number];

/** Check 5's water bounds: every water rectangle lies within one column band and one row band (bands are disjoint and not adjacent). */
export function waterOutside(state: SimState, columns: readonly Band[], rows: readonly Band[]): string[] {
  const out = state.terrain!.water.find(r => !columns.some(([a, b]) => r.x >= a && r.x + r.width <= b) || !rows.some(([a, b]) => r.y >= a && r.y + r.height <= b));
  return out === undefined ? [] : [`5 water (${out.x},${out.y},${out.width},${out.height}) outside columns ${JSON.stringify(columns)} rows ${JSON.stringify(rows)}`];
}

/** Rows holding any water, as a failure when one falls in the band. */
export function waterInRows(state: SimState, [top, bottom]: Band): string[] {
  const hit = state.terrain!.water.find(r => r.y < bottom && r.y + r.height > top);
  return hit === undefined ? [] : [`5 water (${hit.x},${hit.y},${hit.width},${hit.height}) in rows ${top}-${bottom - 1}`];
}

/** Connected parts of the land in columns [from, to), joined only within those columns, with this seed's rocks. */
export function landParts(state: SimState, [from, to]: Band): Uint8Array[] {
  const { mapWidth: w, mapHeight: h } = state.config, taken = new Uint8Array(w * h), parts: Uint8Array[] = [];
  for (let y = 0; y < h; y++) for (let x = from; x < to; x++) {
    const i = y * w + x;
    if (taken[i] || isBlockedTile(state.terrain, x, y)) continue;
    const part = reach(state, [i], px => px < from || px >= to);
    part.forEach((v, j) => { if (v) taken[j] = 1; });
    parts.push(part);
  }
  return parts;
}
