import { DEFAULT_CONFIG, SUB, type QueenRules, type SimConfig } from "./config.js";
import { tileCentre, withinTiles } from "./geometry.js";
import { addRocks, createTerrain, isBlockedTile, isWaterTile, landBirthPosition, passableMask, selectMap } from "./terrain.js";
import { startBoxes } from "./startPlacement.js";
import { generateFoodLayout, referenceFoodConfig } from "./foodLayout.js";
import { gridScaleOf, scaledFoodPatch, scaledTileCentre, withGridScale } from "./gridScale.js";
import { validateMapBoards } from "./mapBoard.js";
import { nextUint32 } from "./rng.js";
import type { Ant, Caste, ColonyId, ColonyState, MatchStats, QueenState, SimState, Terrain, TileOwner } from "./types.js";

/** Row-major tile index. */
export function tileIndex(config: SimConfig, tx: number, ty: number): number {
  return ty * config.mapWidth + tx;
}

/** Mirror a tile x across the vertical centre line. */
export function mirrorTileX(config: SimConfig, tx: number): number {
  return config.mapWidth - 1 - tx;
}

/** Mirror a sub-tile x across the vertical centre line. */
export function mirrorX(config: SimConfig, x: number): number {
  return config.mapWidth * SUB - x;
}

export function nestTile(config: SimConfig, colony: ColonyId): { tx: number; ty: number } {
  const tx = colony === 0 ? config.nestTileX : mirrorTileX(config, config.nestTileX);
  return { tx, ty: config.nestTileY };
}

/** Keep mirrored fine-grid starts in mirrored half-open tiles, not on their boundary. */
function startX(config: SimConfig, colony: ColonyId, tx: number): number {
  const x = tileCentre(tx);
  return x % SUB === 0 ? x + (colony === 0 ? -1 : 1) : x;
}

/** Lay out the mirrored food patches, drawing per-tile jitter from the PRNG. colony0Ants are colony 0's start ants. */
function layFood(config: SimConfig, rngState: number, colony0Ants: readonly Ant[]): { food: number[]; rngState: number } {
  const food = new Array<number>(config.mapWidth * config.mapHeight).fill(0);
  const scale = gridScaleOf(config);
  const reference = referenceFoodConfig(config);
  const laid = layReferenceFood(reference, rngState);
  // Distribute whole food units over the original cell's fine footprint.
  // Mirrored cells use mirrored offsets, retaining exact integer resources.
  const offsets = Array.from({ length: scale * scale }, (_, i) => i).sort((a, b) => {
    const distance = (i: number) => (i % scale + 0.5 - scale / 2) ** 2 +
      (Math.floor(i / scale) + 0.5 - scale / 2) ** 2;
    return distance(a) - distance(b) || a - b;
  });
  // A start ant at a reference tile's centre stands in its lower-left fine cell (colony 1 in the mirror). A cell
  // within reference sight of a start ant fills that lower row first, so the ant's fine distance to its food is
  // exactly the reference distance times the scale and the scaled sight reaches it. Every other cell is unchanged.
  const opening = [...offsets].sort((a, b) => Math.floor(b / scale) - Math.floor(a / scale) || offsets.indexOf(a) - offsets.indexOf(b));
  const starts = colony0Ants.map((ant) => ({ x: Math.floor(ant.x / SUB / scale), y: Math.floor(ant.y / SUB / scale) }));
  const inOpeningSight = (x: number, y: number) =>
    starts.some((a) => scale * scale * ((a.x - x) ** 2 + (a.y - y) ** 2) <= config.sightTiles ** 2);
  for (let y = 0; y < reference.mapHeight; y++) for (let x = 0; x < reference.mapWidth / 2; x++) {
    const amount = laid.food[y * reference.mapWidth + x]!;
    const order = amount > 0 && inOpeningSight(x, y) ? opening : offsets;
    for (let unit = 0; unit < amount; unit++) {
      const offset = order[unit % order.length]!;
      const fx = x * scale + offset % scale, fy = y * scale + Math.floor(offset / scale);
      food[fy * config.mapWidth + fx]! += 1;
      food[fy * config.mapWidth + config.mapWidth - 1 - fx]! += 1;
    }
  }
  return { food, rngState: laid.rngState };
}

/** Per-tile jitter on the reference grid (referenceFoodConfig's output), drawn from the PRNG. */
function layReferenceFood(config: SimConfig, rngState: number): { food: number[]; rngState: number } {
  const food = new Array<number>(config.mapWidth * config.mapHeight).fill(0);
  const half = config.mapWidth / 2;
  let rng = rngState;
  for (let ty = 0; ty < config.mapHeight; ty += 1) {
    for (let tx = 0; tx < half; tx += 1) {
      let base = 0;
      for (const patch of config.foodPatches) {
        if (withinTiles(tx, ty, patch.tileX, patch.tileY, patch.radius)) {
          base = Math.max(base, patch.perTile);
        }
      }
      if (base === 0) continue;
      const draw = nextUint32(rng);
      rng = draw.state;
      const span = config.foodJitter * 2 + 1;
      const amount = Math.max(1, base + (draw.value % span) - config.foodJitter);
      food[tileIndex(config, tx, ty)] = amount;
      food[tileIndex(config, mirrorTileX(config, tx), ty)] = amount;
    }
  }
  return { food, rngState: rng };
}

/** Starting ant offsets around the nest: a 5 x 7 block, filled row-major. */
function startOffsets(count: number): { dx: number; dy: number }[] {
  const offsets: { dx: number; dy: number }[] = [];
  for (let dy = -3; dy <= 3 && offsets.length < count; dy += 1) {
    for (let dx = -2; dx <= 2 && offsets.length < count; dx += 1) {
      offsets.push({ dx, dy });
    }
  }
  let ring = 4;
  while (offsets.length < count) {
    for (let dx = -ring; dx <= ring && offsets.length < count; dx += 1) {
      offsets.push({ dx, dy: ring });
    }
    ring += 1;
  }
  return offsets;
}

/**
 * Colony 0's start tiles under startAntLayout "fill-start-area", one per start ant: the land tiles of its
 * start area whose mirror is also land, nearest the nest first, one ant per tile. Colony 1 takes the mirror
 * of each. Rocks come later and avoid these tiles. Refuses more start ants than such tiles.
 */
function filledStartTiles(config: SimConfig, terrain: Terrain | undefined): { tx: number; ty: number }[] {
  const box = startBoxes(config)[0];
  const tiles: { tx: number; ty: number }[] = [];
  for (let ty = box.y; ty < box.y + box.height; ty += 1) for (let tx = box.x; tx < box.x + box.width; tx += 1) {
    if (!isBlockedTile(terrain, tx, ty) && !isBlockedTile(terrain, mirrorTileX(config, tx), ty)) tiles.push({ tx, ty });
  }
  if (tiles.length < config.startAnts) throw new RangeError(`start area holds ${tiles.length} land tiles, fewer than ${config.startAnts} start ants`);
  const distance = ({ tx, ty }: { tx: number; ty: number }) => (tx - config.nestTileX) ** 2 + (ty - config.nestTileY) ** 2;
  tiles.sort((a, b) => distance(a) - distance(b) || a.ty - b.ty || a.tx - b.tx);
  return tiles.slice(0, config.startAnts);
}

/** A new ant. With the rules switch off there is no caste and the caste argument is ignored. */
export function newAnt(
  config: SimConfig,
  id: number,
  colony: ColonyId,
  x: number,
  y: number,
  caste: Caste = "worker",
): Ant {
  const ant: Ant = {
    id,
    colony,
    x,
    y,
    hp: config.antHp,
    carrying: false,
    role: "forager",
    squad: null,
    vx: 0,
    vy: 0,
    foodTarget: -1,
    lastTargetId: -1,
  };
  if (config.castes === undefined) return ant;
  ant.caste = caste;
  if (caste === "soldier") {
    ant.hp = Math.trunc((config.antHp * config.castes.soldierHpPermille) / 1000);
    // Soldiers never forage.
    ant.role = "fighter";
  }
  return ant;
}

/**
 * Per-map config selection: the seed's map decides the board, ant cap and match
 * length. A map without its own values, as every recorded map is, returns this exact config
 * object. A map's own ant cap and match length replace the config's. A board map takes its
 * size, default nest and food templates at the config's grid scale. Idempotent, so a log header
 * holding the result replays identically.
 */
export function matchConfigForMap(seed: number, config: SimConfig): SimConfig {
  if (config.terrain === undefined) return config;
  // Every map in the rotation must play at this grid scale and fit its own board.
  validateMapBoards(config);
  const map = selectMap(seed, config.terrain);
  // The map's own ant cap and match length, with or without its own board.
  if (map.colonyCap !== undefined && map.colonyCap !== config.colonyCap) config = { ...config, colonyCap: map.colonyCap };
  if (map.matchTicks !== undefined && map.matchTicks !== config.matchTicks) config = { ...config, matchTicks: map.matchTicks };
  const board = map.board;
  if (board === undefined) return config;
  const scale = gridScaleOf(config);
  const patches = board.foodPatches.map(p => scaledFoodPatch(p, scale));
  // Re-deriving a stored result keeps its recorded rotation size, so replay is identical.
  const rotationSize = config.rotationSize ?? { width: config.mapWidth, height: config.mapHeight };
  return { ...config, mapWidth: board.referenceWidth * scale, mapHeight: board.referenceHeight * scale, rotationSize,
    nestTileX: scaledTileCentre(board.nestTileX, scale), nestTileY: scaledTileCentre(board.nestTileY, scale),
    foodPatches: patches, ...(config.foodLayout === undefined ? {} : { foodLayout: { ...config.foodLayout, patches } }) };
}

/** A colony at match start with its first nest at (queenX, queenY), in sub-tile units. */
export function newColony(config: SimConfig, id: ColonyId, queenX: number, queenY: number): ColonyState {
  return {
    id,
    queenX,
    queenY,
    foodStore: 0,
    lastHatchTick: -config.hatchIntervalTicks,
    overrunTicks: 0,
    ...(config.castes === undefined ? {} : { mixedNext: "worker" as const }),
    ...(config.queenFounding === undefined ? {} : {
      queens: [{ id: 0, ...(config.queenFounding.costBasis === "founded-live" ? { starting: true as const } : {}), queenX, queenY, foundedTick: 0,
        lastHatchTick: -config.hatchIntervalTicks, overrunTicks: 0, lostTick: null,
        ...(config.queenHp === undefined ? {} : { hp: config.queenHp.hp, lastBiteTick: -config.queenHp.biteIntervalTicks, regenFromTick: 0 }) }],
      lastQueenFoundedTick: -config.queenFounding.cooldownTicks,
    }),
    ...(config.localAnts === undefined ? {} : { seenFood: [] as number[] }),
  };
}

/** Match statistics at match start for this many colonies. */
export function newStats(colonyCount: number): MatchStats {
  const zeros = (): number[] => Array.from({ length: colonyCount }, () => 0);
  return { delivered: zeros(), hatched: zeros(), deaths: zeros(), fights: 0, ownerChanges: 0, bonusHits: zeros() };
}

/** Create a match at tick 0. Queued agents join through inputs on the first step. */
export function createMatch(seed: number, config: SimConfig = withGridScale(DEFAULT_CONFIG)): SimState {
  config = matchConfigForMap(seed, config);
  let terrain = createTerrain(seed, config);
  if (config.foodLayout !== undefined) config = { ...config,
    foodPatches: generateFoodLayout(config, seed, terrain === undefined ? undefined : passableMask(config, terrain)) };
  const tiles = config.mapWidth * config.mapHeight;
  const colonies = [0, 1].map((id): ColonyState => {
    const { tx, ty } = nestTile(config, id);
    return newColony(config, id, startX(config, id, tx), tileCentre(ty));
  });

  const ants: Ant[] = [];
  let nextAntId = 1;
  if (config.startAntLayout === "fill-start-area") {
    for (const { tx, ty } of filledStartTiles(config, terrain)) for (const colony of [0, 1] as const) {
      const x = startX(config, colony, colony === 0 ? tx : mirrorTileX(config, tx));
      ants.push(newAnt(config, nextAntId, colony, x, tileCentre(ty)));
      nextAntId += 1;
    }
  } else for (const { dx, dy } of startOffsets(config.startAnts)) {
    for (const colony of [0, 1] as const) {
      const nest = nestTile(config, colony);
      const scale = gridScaleOf(config);
      const tx = nest.tx + (colony === 0 ? dx : -dx) * scale;
      ants.push(newAnt(config, nextAntId, colony, startX(config, colony, tx), tileCentre(nest.ty + dy * scale)));
      nextAntId += 1;
    }
  }

  const laid = layFood(config, seed >>> 0, ants.filter((ant) => ant.colony === 0));
  // Fixed historical patches retain their food draw schedule. Seeded patches
  // already have complete dry footprints; never trim their generated budget.
  if (config.foodLayout === undefined && terrain !== undefined) for (let i = 0; i < laid.food.length; i++) {
    if (isWaterTile(terrain, i % config.mapWidth, Math.floor(i / config.mapWidth))) laid.food[i] = 0;
  }

  // Keep the existing food and start layout intact; obstacles avoid both footprints.
  terrain = addRocks(seed, config, terrain, laid.food, ants);
  const state: SimState = {
    config,
    seed,
    ...(terrain === undefined ? {} : { terrain }),
    tick: 0,
    rngState: laid.rngState,
    nextAntId,
    ants,
    colonies,
    food: laid.food,
    foodCap: laid.food.slice(),
    owner: new Array<TileOwner>(tiles).fill(-1),
    lastVisit: new Array<number>(tiles).fill(0),
    stats: newStats(2),
    result: null,
    agents: [],
    marks: [],
    nextMarkId: 1,
    ...(config.earlyWin === undefined ? {} : { earlyWinProgress: { leader: null, ticks: 0 } }),
  };
  if (config.initialQueens !== undefined) installInitialQueens(state);
  return state;
}

/** Apply only after map generation: picks must never change the board they were made on. */
function installInitialQueens(state: SimState): void {
  const { config } = state, layout = config.initialQueens!;
  if (config.queenFounding === undefined || layout.length !== 2 || layout.some(team => team.length === 0)) {
    throw new Error("Initial queen layout requires queen rules and two nonempty teams");
  }
  const boxes = startBoxes(config), used = new Set<number>();
  for (const colony of [0, 1] as const) {
    const box = boxes[colony];
    for (const { tileX, tileY } of layout[colony]) {
      const index = tileIndex(config, tileX, tileY);
      if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY) || tileX < box.x || tileX >= box.x + box.width
        || tileY < box.y || tileY >= box.y + box.height || isBlockedTile(state.terrain, tileX, tileY)
        || state.food[index] > 0 || used.has(index)) throw new Error("Invalid initial queen tile");
      used.add(index);
    }
  }
  for (const colony of [0, 1] as const) {
    const before = state.colonies[colony], template = before.queens![0];
    const queens = layout[colony].map(({ tileX, tileY }, id): QueenState => ({
      ...template, id, starting: true, queenX: tileCentre(tileX), queenY: tileCentre(tileY),
    }));
    state.colonies[colony] = { ...before, queens, queenX: queens[0].queenX, queenY: queens[0].queenY };
    // Preserve population, identities and offset pattern. Distribute the same ants
    // across starting nests; unlike map generation this consumes no random draws.
    let index = 0;
    for (const ant of state.ants) if (ant.colony === colony) {
      const queen = queens[index++ % queens.length];
      const x = Math.max(0, Math.min(config.mapWidth * SUB - 1, queen.queenX + ant.x - before.queenX));
      const y = Math.max(0, Math.min(config.mapHeight * SUB - 1, queen.queenY + ant.y - before.queenY));
      const position = landBirthPosition(config, state.terrain, x, y, colony) ?? { x: queen.queenX, y: queen.queenY };
      ant.x = position.x; ant.y = position.y;
    }
  }
}

/**
 * Living ants bucketed by tile index, for neighbourhood queries: a buildGrid Map,
 * or one sync of a match's GridTracker. Both hold, per tile, the ants on it in
 * state.ants order; consumers only read them.
 */
export type Grid = Map<number, Ant[]> | TrackedGrid;

/**
 * The same buckets as a buildGrid grid, indexed densely by tile, so forEachNear
 * reads an array slot instead of one Map.get per tile. Only grids built here get
 * one; buildGrid grids are never mutated afterwards. Any other Map keeps Map.get.
 */
const denseBuckets = new WeakMap<Grid, readonly (Ant[] | undefined)[]>();

export function buildGrid(state: SimState): Map<number, Ant[]> {
  const grid = new Map<number, Ant[]>();
  const dense: (Ant[] | undefined)[] = new Array(state.config.mapWidth * state.config.mapHeight);
  for (const ant of state.ants) {
    const key = tileIndex(state.config, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB));
    const bucket = grid.get(key);
    if (bucket) bucket.push(ant);
    else {
      const created = [ant];
      grid.set(key, created);
      dense[key] = created;
    }
  }
  denseBuckets.set(grid, dense);
  return grid;
}

/**
 * One sync of a GridTracker. Its buckets are the tracker's, updated in place by the
 * next sync, so a handle is valid only until then: reading an older one throws
 * rather than silently seeing a later phase's positions.
 */
export class TrackedGrid {
  private readonly tracker: GridTracker;
  private readonly generation: number;

  constructor(tracker: GridTracker, generation: number) {
    this.tracker = tracker;
    this.generation = generation;
  }

  /** The dense per-tile buckets (undefined for an empty tile) this handle reads. */
  buckets(): readonly (readonly Ant[] | undefined)[] {
    if (this.generation !== this.tracker.generation) throw new Error("stale grid: read after its tracker synced again");
    return this.tracker.dense;
  }

  get(tile: number): readonly Ant[] | undefined {
    return this.buckets()[tile];
  }

  /** Each colony's ant count per tile, matching buckets(); valid only until the next sync, like it. */
  colonyCounts(): readonly [Int32Array, Int32Array] {
    this.buckets();
    return [this.tracker.count0, this.tracker.count1];
  }
}

let verifySyncs = false;
/** Test-only: compare every GridTracker sync with a fresh buildGrid and throw on any difference. */
export function verifyGridSyncs(on: boolean): void {
  verifySyncs = on;
}

/**
 * A match's neighbour grid kept across phases and ticks. Each sync gives
 * exactly the buckets, and per-tile order, a fresh buildGrid gives at that point,
 * but rebuilds only the tiles an ant entered. The first sync, a changed board, or
 * ants not in strictly ascending id order (now or at the previous sync) take one
 * full build instead.
 *
 * Why order holds: ids ascend in both the previous and current state.ants, so ants
 * present in both keep their relative order. A tile no ant entered holds its previous
 * members minus those that left, in that order; a tile any ant entered is refilled
 * from state.ants in order.
 */
export class GridTracker {
  /** @internal Read by TrackedGrid. */
  dense: (Ant[] | undefined)[] = [];
  /** @internal Read by TrackedGrid. */
  generation = 0;
  /** Full builds performed, for tests and measurement. */
  fullBuilds = 0;
  /** @internal Read by TrackedGrid: colony 0 and colony 1 ants per tile, kept with dense. */
  count0 = new Int32Array(0);
  /** @internal Read by TrackedGrid. */
  count1 = new Int32Array(0);
  private width = -1;
  private height = -1;
  private prevAnts: Ant[] = [];
  private prevAscending = false;
  private prevTiles = new Int32Array(0);
  private curTiles = new Int32Array(0);
  private dirtyMark = new Int32Array(0);
  private dirtyList = new Int32Array(0);
  private stamp = 0;

  sync(state: SimState): TrackedGrid {
    const { mapWidth, mapHeight } = state.config, ants = state.ants, n = ants.length;
    if (this.curTiles.length < n) this.curTiles = new Int32Array(Math.max(n, this.curTiles.length * 2, 64));
    const cur = this.curTiles;
    let ascending = true;
    for (let i = 0; i < n; i += 1) {
      const ant = ants[i]!;
      if (i > 0 && ant.id <= ants[i - 1]!.id) ascending = false;
      cur[i] = Math.floor(ant.y / SUB) * mapWidth + Math.floor(ant.x / SUB);
    }
    // The update's merge walk needs ascending ids in both this sync and the previous one.
    if (!ascending || !this.prevAscending || mapWidth !== this.width || mapHeight !== this.height) this.fullBuild(mapWidth, mapHeight, ants, cur);
    else this.update(ants, cur);
    this.prevAscending = ascending;
    // Keep this sync as the next one's previous state (swap the tile buffers).
    const prev = this.prevAnts;
    prev.length = n;
    for (let i = 0; i < n; i += 1) prev[i] = ants[i]!;
    this.curTiles = this.prevTiles;
    this.prevTiles = cur;
    this.generation += 1;
    const grid = new TrackedGrid(this, this.generation);
    if (verifySyncs) assertSameGrid(state, grid);
    return grid;
  }

  private fullBuild(width: number, height: number, ants: readonly Ant[], tiles: Int32Array): void {
    this.fullBuilds += 1;
    const size = width * height;
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.dense = new Array(size);
      this.dirtyMark = new Int32Array(size);
      this.dirtyList = new Int32Array(size);
      this.count0 = new Int32Array(size);
      this.count1 = new Int32Array(size);
      this.stamp = 0;
    } else {
      this.dense.fill(undefined);
      this.count0.fill(0);
      this.count1.fill(0);
    }
    const dense = this.dense, count0 = this.count0, count1 = this.count1;
    for (let i = 0; i < ants.length; i += 1) {
      const bucket = dense[tiles[i]!];
      if (bucket === undefined) dense[tiles[i]!] = [ants[i]!];
      else bucket.push(ants[i]!);
      if (ants[i]!.colony === 0) count0[tiles[i]!] += 1; else count1[tiles[i]!] += 1;
    }
  }

  private update(ants: readonly Ant[], tiles: Int32Array): void {
    const dense = this.dense, mark = this.dirtyMark, list = this.dirtyList, count0 = this.count0, count1 = this.count1;
    const prev = this.prevAnts, prevTiles = this.prevTiles, pn = prev.length, n = ants.length;
    const stamp = ++this.stamp;
    let dirty = 0;
    const enter = (tile: number) => { if (mark[tile] !== stamp) { mark[tile] = stamp; list[dirty++] = tile; } };
    const leave = (tile: number, ant: Ant) => {
      if (mark[tile] === stamp) return; // refilled below
      const bucket = dense[tile]!;
      if (bucket.length === 1) dense[tile] = undefined;
      else bucket.splice(bucket.indexOf(ant), 1);
      if (ant.colony === 0) count0[tile] -= 1; else count1[tile] -= 1;
    };
    let i = 0, j = 0;
    while (i < n || j < pn) {
      const ant = i < n ? ants[i]! : undefined, was = j < pn ? prev[j]! : undefined;
      if (was !== undefined && (ant === undefined || was.id < ant.id)) { leave(prevTiles[j]!, was); j += 1; continue; }
      if (ant !== undefined && (was === undefined || ant.id < was.id)) { enter(tiles[i]!); i += 1; continue; }
      if (ant !== was || tiles[i] !== prevTiles[j]) { leave(prevTiles[j]!, was!); enter(tiles[i]!); }
      i += 1;
      j += 1;
    }
    if (dirty === 0) return;
    for (let k = 0; k < dirty; k += 1) { dense[list[k]!] = undefined; count0[list[k]!] = 0; count1[list[k]!] = 0; }
    for (let k = 0; k < n; k += 1) {
      const tile = tiles[k]!;
      if (mark[tile] !== stamp) continue;
      const bucket = dense[tile];
      if (bucket === undefined) dense[tile] = [ants[k]!];
      else bucket.push(ants[k]!);
      if (ants[k]!.colony === 0) count0[tile] += 1; else count1[tile] += 1;
    }
  }
}

function assertSameGrid(state: SimState, grid: TrackedGrid): void {
  const fresh = buildGrid(state), buckets = grid.buckets();
  for (let tile = 0; tile < state.config.mapWidth * state.config.mapHeight; tile += 1) {
    const want = fresh.get(tile), got = buckets[tile];
    if (want === undefined && got === undefined) continue;
    if (want === undefined || got === undefined || want.length !== got.length || want.some((ant, k) => ant !== got[k])) {
      throw new Error(`grid sync differs from buildGrid at tile ${tile} on tick ${state.tick}`);
    }
  }
}

/** The dense per-tile buckets forEachNear reads for this grid; undefined for a Map grid not built by buildGrid. */
export function gridBuckets(grid: Grid): readonly (readonly Ant[] | undefined)[] | undefined {
  return grid instanceof TrackedGrid ? grid.buckets() : denseBuckets.get(grid);
}

/** Each colony's ant count per tile for a buildGrid grid, counted from its buckets on first use. */
const bucketCounts = new WeakMap<Grid, readonly [Int32Array, Int32Array]>();

/**
 * Each colony's ant count per tile (colony 0, colony 1) on this grid's buckets: kept by the tracker for a
 * TrackedGrid, counted once for a buildGrid grid; undefined for any other Map. Valid while the buckets are.
 * The counts cover two colonies only, so a match with any other number of colonies gets undefined and its
 * callers take their per-ant paths.
 */
export function gridColonyCounts(grid: Grid, state: SimState): readonly [Int32Array, Int32Array] | undefined {
  if (state.colonies.length !== 2) return undefined;
  if (grid instanceof TrackedGrid) return grid.colonyCounts();
  const dense = denseBuckets.get(grid);
  if (dense === undefined) return undefined;
  let counts = bucketCounts.get(grid);
  if (counts === undefined) {
    const zero = new Int32Array(dense.length), one = new Int32Array(dense.length);
    for (let tile = 0; tile < dense.length; tile += 1) {
      const bucket = dense[tile];
      if (bucket !== undefined) for (let i = 0; i < bucket.length; i += 1) { if (bucket[i]!.colony === 0) zero[tile] += 1; else one[tile] += 1; }
    }
    counts = [zero, one];
    bucketCounts.set(grid, counts);
  }
  return counts;
}

/**
 * Per grid, each colony's ants as 2D prefix counts of gridColonyCounts: entry y * (mapWidth + 1) + x counts
 * the colony's ants on tiles in rows before y and columns before x. Read with areaCount. Valid for the grid's
 * one snapshot; gridColonyCounts is read first on every call, so a stale TrackedGrid handle still throws.
 */
const colonyAreas = new WeakMap<Grid, readonly [Int32Array, Int32Array]>();

export function colonyAreaCounts(state: SimState, grid: Grid): readonly [Int32Array, Int32Array] | undefined {
  const tiles = gridColonyCounts(grid, state);
  if (tiles === undefined) return undefined;
  const cached = colonyAreas.get(grid);
  if (cached !== undefined) return cached;
  const { mapWidth: width, mapHeight: height } = state.config, stride = width + 1;
  const [count0, count1] = tiles;
  const zero = new Int32Array((height + 1) * stride), one = new Int32Array((height + 1) * stride);
  for (let y = 0; y < height; y += 1) {
    const above = y * stride, row = above + stride, at = y * width;
    let a = 0, b = 0;
    for (let x = 0; x < width; x += 1) {
      a += count0[at + x]!;
      b += count1[at + x]!;
      zero[row + x + 1] = zero[above + x + 1]! + a;
      one[row + x + 1] = one[above + x + 1]! + b;
    }
  }
  const counts = [zero, one] as const;
  colonyAreas.set(grid, counts);
  return counts;
}

/** One colony's ants on tiles x0..x1 by y0..y1 (inclusive, inside the map) from a colonyAreaCounts table. */
export function areaCount(table: Int32Array, mapWidth: number, x0: number, y0: number, x1: number, y1: number): number {
  const stride = mapWidth + 1;
  return table[(y1 + 1) * stride + x1 + 1]! - table[y0 * stride + x1 + 1]! - table[(y1 + 1) * stride + x0]! + table[y0 * stride + x0]!;
}

/** Whether a per-tile count array holds no ant within Chebyshev distance r of tile (tx, ty). */
function noneNear(state: SimState, tiles: Int32Array, tx: number, ty: number, r: number): boolean {
  const { mapWidth, mapHeight } = state.config;
  const x0 = Math.max(0, tx - r), x1 = Math.min(mapWidth - 1, tx + r), y0 = Math.max(0, ty - r), y1 = Math.min(mapHeight - 1, ty + r);
  for (let y = y0; y <= y1; y += 1) for (let x = x0, at = y * mapWidth; x <= x1; x += 1) if (tiles[at + x] !== 0) return false;
  return true;
}

/** Whether no ant of the other colony stands within Chebyshev distance r of tile (tx, ty); false when unknown. */
export function noEnemyNear(state: SimState, grid: Grid, colony: ColonyId, tx: number, ty: number, r: number): boolean {
  const counts = gridColonyCounts(grid, state);
  return counts !== undefined && Number.isInteger(r) && noneNear(state, counts[colony === 0 ? 1 : 0], tx, ty, r);
}

/** Visit every ant whose tile lies within Chebyshev distance r of tile (tx, ty). */
export function forEachNear(
  state: SimState,
  grid: Grid,
  tx: number,
  ty: number,
  r: number,
  visit: (ant: Ant) => void,
): void {
  const { mapWidth, mapHeight } = state.config;
  const x0 = Math.max(0, tx - r);
  const x1 = Math.min(mapWidth - 1, tx + r);
  const y0 = Math.max(0, ty - r);
  const y1 = Math.min(mapHeight - 1, ty + r);
  const dense = grid instanceof TrackedGrid ? grid.buckets() : denseBuckets.get(grid);
  if (dense !== undefined) {
    // Same tiles, same row-major order, same bucket arrays as the Map path below.
    for (let y = y0; y <= y1; y += 1) {
      const row = y * mapWidth;
      for (let x = x0; x <= x1; x += 1) {
        const bucket = dense[row + x];
        if (bucket !== undefined) for (let i = 0; i < bucket.length; i += 1) visit(bucket[i]!);
      }
    }
    return;
  }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const bucket = grid.get(y * mapWidth + x);
      if (bucket) for (const ant of bucket) visit(ant);
    }
  }
}

/** Whether any enemy of this ant stands within combat reach (adjacent or same tile). */
export function hasAdjacentEnemy(state: SimState, grid: Grid, ant: Ant): boolean {
  const counts = gridColonyCounts(grid, state);
  if (counts !== undefined) return !noneNear(state, counts[ant.colony === 0 ? 1 : 0], Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), gridScaleOf(state.config));
  let found = false;
  forEachNear(state, grid, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), gridScaleOf(state.config), (other) => {
    if (other.colony !== ant.colony) found = true;
  });
  return found;
}

/** Deep copy of the mutable parts of a state; foodCap and config are shared, never mutated. */
export function cloneState(state: SimState): SimState {
  return {
    ...state,
    ...(state.earlyWinProgress === undefined ? {} : { earlyWinProgress: { ...state.earlyWinProgress } }),
    ants: state.ants.map((ant) => ({ ...ant })),
    colonies: state.colonies.map((c) => ({ ...c, ...(c.queens === undefined ? {} : { queens: c.queens.map((q) => ({ ...q })) }), ...(c.seenFood === undefined ? {} : { seenFood: c.seenFood.slice() }) })),
    food: state.food.slice(),
    owner: state.owner.slice(),
    lastVisit: state.lastVisit.slice(),
    stats: {
      delivered: [...state.stats.delivered],
      hatched: [...state.stats.hatched],
      deaths: [...state.stats.deaths],
      fights: state.stats.fights,
      ownerChanges: state.stats.ownerChanges,
      bonusHits: [...state.stats.bonusHits],
    },
    agents: state.agents.map((agent) => ({
      ...agent,
      squad: agent.squad.slice(),
      pendingEvents: agent.pendingEvents.slice(),
    })),
    marks: state.marks.map((mark) => ({ ...mark })),
  };
}

/** Read historical one-queen states without changing their shape or hashes. */
export function queensOf(colony: ColonyState): readonly QueenState[] {
  return colony.queens ?? [{ id: 0, queenX: colony.queenX, queenY: colony.queenY, foundedTick: 0,
    lastHatchTick: colony.lastHatchTick, overrunTicks: colony.overrunTicks, lostTick: null }];
}

export function activeQueens(colony: ColonyState): readonly QueenState[] {
  return queensOf(colony).filter((q) => q.lostTick === null);
}

/**
 * Rules 27: a lost queen's spawn point clears, and every ant of hers
 * still walking to it ends the walk where it stands, so it takes its caste's
 * defaults from there at its next plan. Call wherever a queen is lost.
 */
export function clearLostQueenSpawn(state: SimState, colony: ColonyId, queen: QueenState): void {
  delete queen.spawnPoint;
  for (const ant of state.ants) if (ant.colony === colony && ant.spawnWalk?.queenId === queen.id) delete ant.spawnWalk;
}

/** Pure price calculation; absent new fields preserves historical fixed-price logs. */
export function queenFoundingCost(colony: ColonyState, rules: QueenRules): number {
  if (rules.costBasis === "founded-live") {
    const founded = activeQueens(colony).filter(q => q.starting !== true).length;
    return rules.cost * (rules.costMultiplier ?? 1) ** founded;
  }
  const count = rules.costBasis === "live"
    ? Math.min(activeQueens(colony).length, (rules.maxLiveQueens ?? Infinity) - 1)
    : queensOf(colony).length;
  return rules.cost * (rules.costMultiplier ?? 1) ** Math.max(0, count - 1);
}

export function nextQueenFoundingTick(colony: ColonyState, rules: QueenRules): number {
  return Math.max(rules.firstFoundTick ?? 0, (colony.lastQueenFoundedTick ?? -rules.cooldownTicks) + rules.cooldownTicks);
}

/** The standing-nest rule is explicit so older log headers keep their original spacing. */
export function queenSpacingNests(colony: ColonyState, rules: QueenRules): readonly QueenState[] {
  return rules.standingNestsOnly ? activeQueens(colony) : queensOf(colony);
}

/** Stable nearest live nest, ties to the older queen. No fallback to a lost nest. */
export function nearestQueen(colony: ColonyState, x: number, y: number): QueenState | null {
  let best: QueenState | null = null;
  let bestD = Infinity;
  // The live queens in activeQueens order, read in place rather than through a filtered copy.
  for (const q of colony.queens ?? activeQueens(colony)) {
    if (q.lostTick !== null) continue;
    const d = (q.queenX - x) ** 2 + (q.queenY - y) ** 2;
    if (d < bestD || (d === bestD && q.id < (best?.id ?? Infinity))) { best = q; bestD = d; }
  }
  return best;
}
