/**
 * Four-colony matches on a quadrant rotation: the match config a seed draws, and the tick-0 state built from
 * the quadrant board that map generates for the seed (src/sim/quadrantMap.ts). Colony 0 starts in the top-left
 * quadrant, colony 1 in the top-right, colony 2 in the bottom-left and colony 3 in the bottom-right, as the board
 * lists its quadrants. Everything a colony starts with is the mirror image of colony 0's.
 */
import { SUB, type FoodPatch, type SimConfig } from "./config.js";
import { tileCentre, withinTiles } from "./geometry.js";
import { gridScaleOf, scaledFoodPatch } from "./gridScale.js";
import { checkInitialQueens, newAnt, newColony, newStats, startingQueens } from "./map.js";
import { OWN_VALUE_GRID_SCALE } from "./mapBoard.js";
import { generateQuadrantBoard, type QuadrantBoard } from "./quadrantMap.js";
import { nextUint32 } from "./rng.js";
import type { StartBox } from "./startPlacement.js";
import { isBlockedTile, selectMap } from "./terrain.js";
import type { Ant, ColonyState, SimState, Terrain, TileOwner } from "./types.js";

export const QUADRANT_COLONIES = 4;

/**
 * Rules a four-colony match cannot be played without. Each colony's ants follow their own local rules from
 * the first tick (there is no house player for a colony), a colony leaves the match when its last queen's
 * HP runs out, and the territory win is the majority hold. Lobby nest picks, when given, cover all four colonies.
 */
function refuseUnplayable(config: SimConfig): void {
  if (config.localAnts === undefined) throw new RangeError("a four-colony match needs local ant rules: no house player moves a colony's ants");
  if (config.queenHp === undefined) throw new RangeError("a four-colony match needs queen HP: a colony leaves the match when its last queen dies");
  if (config.earlyWin === undefined) throw new RangeError("a four-colony match needs the territory win rules");
  if (config.initialQueens !== undefined && config.initialQueens.length !== QUADRANT_COLONIES) {
    throw new RangeError("a four-colony match takes nest picks for exactly four colonies");
  }
}

/**
 * The four-colony match config for a seed: the drawn map's board size, colony 0's nest, ant cap, match length and
 * food. Idempotent, so a log header holding the result replays identically. Seeded two-colony food layout does
 * not apply: the board carries its own food.
 */
export function quadrantConfigForMap(seed: number, config: SimConfig): SimConfig {
  return drawn(seed, config).config;
}

function drawn(seed: number, config: SimConfig): { config: SimConfig; board: QuadrantBoard } {
  refuseUnplayable(config);
  const scale = gridScaleOf(config);
  if (scale !== OWN_VALUE_GRID_SCALE) throw new RangeError(`a quadrant map plays only at grid scale ${OWN_VALUE_GRID_SCALE}`);
  const map = selectMap(seed, config.terrain!);
  const board = generateQuadrantBoard(map, seed);
  const { foodLayout: _seededLayout, ...rest } = config;
  return { board, config: { ...rest,
    colonyCap: map.colonyCap ?? config.colonyCap, matchTicks: map.matchTicks ?? config.matchTicks,
    mapWidth: board.width * scale, mapHeight: board.height * scale,
    rotationSize: config.rotationSize ?? { width: config.mapWidth, height: config.mapHeight },
    nestTileX: board.nests[0]!.tx * scale, nestTileY: board.nests[0]!.ty * scale,
    foodPatches: [...board.quadrantFood, ...board.centreFood].map(p => scaledFoodPatch(p, scale)) } };
}

/** A reference-tile rectangle in fine tiles. */
function fine(r: { x: number; y: number; width: number; height: number }, scale: number): StartBox {
  return { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale };
}

/** Each colony's nest-pick box for a seed: the drawn board's start areas in fine tiles, in quadrant order. */
export function quadrantStartBoxes(seed: number, config: SimConfig): StartBox[] {
  const { config: drawnConfig, board } = drawn(seed, config);
  return board.startAreas.map(area => fine(area, gridScaleOf(drawnConfig)));
}

/** The sub-tile position of a reference tile's centre, nudged one sub-tile into the fine tile on its own side of
 * each mirror axis (a fine-grid centre falls on a tile boundary), so mirrored starts stay in mirrored tiles. */
function nestPosition(referenceTile: number, referenceSize: number, scale: number): number {
  const x = (referenceTile + 0.5) * scale * SUB;
  return referenceTile < referenceSize / 2 ? x - 1 : x + 1;
}

/** Quadrant food with today's per-tile jitter, drawn once per top-left tile and mirrored into the other three
 * quadrants; centre food drawn once per tile. Each reference tile's food is spread over its fine footprint. */
function layQuadrantFood(config: SimConfig, board: QuadrantBoard, rngState: number): { food: number[]; rngState: number } {
  const scale = gridScaleOf(config), width = board.width, height = board.height;
  const food = new Array<number>(config.mapWidth * config.mapHeight).fill(0);
  let rng = rngState;
  const jittered = (base: number): number => {
    const draw = nextUint32(rng);
    rng = draw.state;
    return Math.max(1, base + (draw.value % (config.foodJitter * 2 + 1)) - config.foodJitter);
  };
  const baseAt = (patches: readonly FoodPatch[], tx: number, ty: number): number =>
    patches.reduce((base, p) => withinTiles(tx, ty, p.tileX, p.tileY, p.radius) ? Math.max(base, p.perTile) : base, 0);
  // Fine cells in row-major order within the reference tile; a mirrored tile takes the mirrored cells.
  const lay = (tx: number, ty: number, amount: number, mirrorX: boolean, mirrorY: boolean): void => {
    for (let unit = 0; unit < amount; unit++) {
      const cell = unit % (scale * scale), dx = cell % scale, dy = Math.floor(cell / scale);
      const fx = tx * scale + (mirrorX ? scale - 1 - dx : dx), fy = ty * scale + (mirrorY ? scale - 1 - dy : dy);
      food[fy * config.mapWidth + fx]! += 1;
    }
  };
  const topLeft = board.quadrantFood.filter((_, i) => i % 4 === 0);
  for (let ty = 0; ty < height / 2; ty++) for (let tx = 0; tx < width / 2; tx++) {
    const base = baseAt(topLeft, tx, ty);
    if (base === 0) continue;
    const amount = jittered(base);
    lay(tx, ty, amount, false, false);
    lay(width - 1 - tx, ty, amount, true, false);
    lay(tx, height - 1 - ty, amount, false, true);
    lay(width - 1 - tx, height - 1 - ty, amount, true, true);
  }
  const centre = board.centre;
  for (let ty = centre.y; ty < centre.y + centre.height; ty++) for (let tx = centre.x; tx < centre.x + centre.width; tx++) {
    const base = baseAt(board.centreFood, tx, ty);
    if (base > 0) lay(tx, ty, jittered(base), false, false);
  }
  return { food, rngState: rng };
}

/**
 * Start tiles for one colony's ants: the land tiles of its start box, one per start ant, ant k taking the free
 * tile nearest queen k mod the queen count (nearest first, then by row and column). Centres are in fine tiles.
 */
function startTiles(config: SimConfig, box: StartBox, centres: readonly { x: number; y: number }[], terrain: Terrain): { tx: number; ty: number }[] {
  const tiles: { tx: number; ty: number }[] = [];
  for (let ty = box.y; ty < box.y + box.height; ty++) {
    for (let tx = box.x; tx < box.x + box.width; tx++) if (!isBlockedTile(terrain, tx, ty)) tiles.push({ tx, ty });
  }
  if (tiles.length < config.startAnts) throw new RangeError(`start area holds ${tiles.length} land tiles, fewer than ${config.startAnts} start ants`);
  const byQueen = centres.map(({ x, y }) => {
    const distance = ({ tx, ty }: { tx: number; ty: number }) => (tx - x) ** 2 + (ty - y) ** 2;
    return tiles.slice().sort((a, b) => distance(a) - distance(b) || a.ty - b.ty || a.tx - b.tx);
  });
  const used = new Set<{ tx: number; ty: number }>(), chosen: { tx: number; ty: number }[] = [];
  for (let ant = 0; ant < config.startAnts; ant++) {
    const tile = byQueen[ant % byQueen.length]!.find(t => !used.has(t))!;
    used.add(tile);
    chosen.push(tile);
  }
  return chosen;
}

/** A four-colony match at tick 0. Queued agents join through inputs on the first step. */
export function createQuadrantMatch(seed: number, base: SimConfig): SimState {
  const { config, board } = drawn(seed, base);
  const scale = gridScaleOf(config), width = config.mapWidth, height = config.mapHeight;
  const terrain: Terrain = Object.freeze({ mapId: board.mapId, mapName: board.mapName,
    water: Object.freeze(board.water.map(r => Object.freeze(fine(r, scale)))),
    rocks: Object.freeze(board.rocks.map(r => Object.freeze({ ...fine(r, scale), appearance: r.appearance }))) });
  // Food draws no randomness that depends on ants or queens, so it is laid first and picks can be checked against it.
  const laid = layQuadrantFood(config, board, seed >>> 0);
  const picks = config.initialQueens, boxes = board.startAreas.map(area => fine(area, scale));
  if (picks !== undefined) checkInitialQueens(config, terrain, laid.food, boxes);

  const colonies = board.nests.map(({ tx, ty }, id): ColonyState => {
    const colony = newColony(config, id, nestPosition(tx, board.width, scale), nestPosition(ty, board.height, scale));
    // Every colony has one queen with HP, whether or not queens can be founded: the last queen's death eliminates it.
    const queens = colony.queens ?? [{ id: 0, queenX: colony.queenX, queenY: colony.queenY, foundedTick: 0,
      lastHatchTick: -config.hatchIntervalTicks, overrunTicks: 0, lostTick: null,
      hp: config.queenHp!.hp, lastBiteTick: -config.queenHp!.biteIntervalTicks, regenFromTick: 0 }];
    if (picks === undefined) return { ...colony, queens, kills: 0 };
    const picked = startingQueens(queens[0]!, picks[id]!);
    return { ...colony, queens: picked, queenX: picked[0]!.queenX, queenY: picked[0]!.queenY, kills: 0 };
  });

  // Without picks, colony 0's start tiles around its nest and their mirror images; with picks, each colony's own
  // start box around its picked queens. Ant ids interleave the colonies tile by tile either way.
  const nest = board.nests[0]!;
  const perColony = picks === undefined
    ? startTiles(config, boxes[0]!, [{ x: (nest.tx + 0.5) * scale - 0.5, y: (nest.ty + 0.5) * scale - 0.5 }], terrain).map(({ tx, ty }) =>
      [{ tx, ty }, { tx: width - 1 - tx, ty }, { tx, ty: height - 1 - ty }, { tx: width - 1 - tx, ty: height - 1 - ty }])
    : transpose(boxes.map((box, colony) => startTiles(config, box, picks[colony]!.map(q => ({ x: q.tileX, y: q.tileY })), terrain)));
  const ants: Ant[] = [];
  let nextAntId = 1;
  for (const images of perColony) images.forEach((tile, colony) => {
    ants.push(newAnt(config, nextAntId, colony, tileCentre(tile.tx), tileCentre(tile.ty)));
    nextAntId += 1;
  });

  const tiles = width * height;
  return {
    config,
    seed,
    terrain,
    tick: 0,
    rngState: laid.rngState,
    nextAntId,
    ants,
    colonies,
    food: laid.food,
    foodCap: laid.food.slice(),
    owner: new Array<TileOwner>(tiles).fill(-1),
    lastVisit: new Array<number>(tiles).fill(0),
    stats: newStats(QUADRANT_COLONIES),
    result: null,
    agents: [],
    marks: [],
    nextMarkId: 1,
    earlyWinProgress: { leader: null, ticks: 0 },
  };
}

/** Rows of columns: [colony][ant] becomes [ant][colony]. */
function transpose<T>(columns: readonly (readonly T[])[]): T[][] {
  return columns[0]!.map((_, row) => columns.map(column => column[row]!));
}
