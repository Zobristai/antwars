import type { MapDefinition, SimConfig } from "./config.js";
import { gridScaleOf } from "./gridScale.js";

/**
 * Per-map board size: which reference sizes a grid scale supports, and the
 * size a config's rotation plays at. Selection and derivation live in map.ts/terrain.ts.
 *
 * The largest native board side every format can carry. Each limit below is 256:
 * - live stream and replay setup: mapW and mapH at most 256 (src/live/format.ts);
 * - ant positions: unsigned 16-bit at 256 sub-units per tile, so 65,536 / 256 tiles;
 * - mark, order and fight tiles: single bytes, coordinates 0 to 255;
 * - agent territory bitset: 1 to 256 a side (src/mcp/territory.ts).
 * The JSONL match log has no limit of its own; replays are stream messages.
 */
export const MAX_BOARD_SIDE_TILES = 256;

export interface BoardSize { readonly width: number; readonly height: number }

/** Why a reference size is unsupported at a grid scale, or null when it is supported.
 * Config limits: the mirrored food layout lays whole reference left halves (even width),
 * and each back-quarter start strip is a whole number of native tiles (width x scale / 4). */
export function boardSizeProblem(referenceWidth: number, referenceHeight: number, scale: number): string | null {
  if (scale !== 2) return "grid scale must be 2";
  if (!Number.isSafeInteger(referenceWidth) || !Number.isSafeInteger(referenceHeight) || referenceWidth < 1 || referenceHeight < 1) {
    return "reference width and height must be positive whole tiles";
  }
  if (referenceWidth % 2 !== 0) return "reference width must be even (mirrored food halves)";
  if ((referenceWidth * scale) % 4 !== 0) return "board width must be a multiple of 4 tiles (back-quarter start strips)";
  if (referenceWidth * scale > MAX_BOARD_SIDE_TILES || referenceHeight * scale > MAX_BOARD_SIDE_TILES) {
    return `board sides must be at most ${MAX_BOARD_SIDE_TILES} tiles (stream, replay and territory formats)`;
  }
  return null;
}

/** Refuse, never clamp. */
export function assertSupportedBoard(referenceWidth: number, referenceHeight: number, scale: number): void {
  const problem = boardSizeProblem(referenceWidth, referenceHeight, scale);
  if (problem !== null) throw new RangeError(`unsupported board ${referenceWidth}x${referenceHeight} at grid scale ${scale}: ${problem}`);
}

/** The longest match the match-record builder accepts (src/replays/history.ts). */
export const MAX_MATCH_TICKS = 10_000_000;

/** The one grid scale a map with its own board, ant cap or match length plays at. */
export const OWN_VALUE_GRID_SCALE = 2;

/** Whether a map carries its own board, ant cap or match length. Recorded maps carry none. */
export function hasOwnMapValues(map: MapDefinition): boolean {
  return map.board !== undefined || map.colonyCap !== undefined || map.matchTicks !== undefined;
}

/** A map with its own grid scale plays at that scale only; a map with its own board,
 * ant cap or match length plays at grid scale 2 only. Ant cap and match length are
 * positive whole numbers the stream, replay and record formats hold. A board map's size, nest,
 * water and food centres must fit its own board. Refuse, never clamp. */
export function validateMapBoard(map: MapDefinition, scale: number): void {
  if (map.gridScale !== undefined && map.gridScale !== scale) {
    throw new RangeError(`${map.id}: plays only at grid scale ${map.gridScale}, not at grid scale ${scale}`);
  }
  if (hasOwnMapValues(map) && scale !== OWN_VALUE_GRID_SCALE) {
    throw new RangeError(`${map.id}: a map with its own board size, ant cap or match length plays only at grid scale ${OWN_VALUE_GRID_SCALE}, not at grid scale ${scale}`);
  }
  if (map.colonyCap !== undefined && !(Number.isSafeInteger(map.colonyCap) && map.colonyCap >= 1)) {
    throw new RangeError(`${map.id}: ant cap ${map.colonyCap} must be a positive whole number of at most ${Number.MAX_SAFE_INTEGER}`);
  }
  if (map.matchTicks !== undefined && !(Number.isSafeInteger(map.matchTicks) && map.matchTicks >= 1 && map.matchTicks <= MAX_MATCH_TICKS)) {
    throw new RangeError(`${map.id}: match length ${map.matchTicks} ticks must be a positive whole number of at most ${MAX_MATCH_TICKS} ticks (match record)`);
  }
  const board = map.board;
  if (board === undefined) return;
  const problem = boardSizeProblem(board.referenceWidth, board.referenceHeight, scale);
  if (problem !== null) throw new RangeError(`${map.id}: unsupported board ${board.referenceWidth}x${board.referenceHeight} at grid scale ${scale}: ${problem}`);
  const { referenceWidth: width, referenceHeight: height } = board;
  const leftHalf = (x: number, y: number) => Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && x < width / 2 && y >= 0 && y < height;
  if (!leftHalf(board.nestTileX, board.nestTileY)) throw new RangeError(`${map.id}: default nest must be a tile in the board's left half`);
  if (board.foodPatches.length === 0 || board.foodPatches.some(p => !leftHalf(p.tileX, p.tileY))) {
    throw new RangeError(`${map.id}: food templates must be centred on tiles in the board's left half`);
  }
  if (map.water.some(r => ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0
    || r.width < 1 || r.height < 1 || r.x + r.width > width || r.y + r.height > height)) {
    throw new RangeError(`${map.id}: water rectangles must lie inside the board`);
  }
}

/** Config validation for every map in the rotation. Recorded maps carry no board or grid scale and pass unchanged. */
export function validateMapBoards(config: SimConfig): void {
  for (const map of config.terrain?.maps ?? []) validateMapBoard(map, gridScaleOf(config));
}

/** The native size a map plays at under this config (a board-derived config keeps the rotation's size). */
export function mapBoardSize(config: SimConfig, map: MapDefinition): BoardSize {
  const scale = gridScaleOf(config);
  return map.board === undefined ? config.rotationSize ?? { width: config.mapWidth, height: config.mapHeight }
    : { width: map.board.referenceWidth * scale, height: map.board.referenceHeight * scale };
}

/** The maps the seed can select (a pinned map alone when terrain.mapId is set). */
function selectableMaps(config: SimConfig): readonly MapDefinition[] {
  const terrain = config.terrain;
  return terrain === undefined ? [] : terrain.mapId === undefined ? terrain.maps : terrain.maps.filter(map => map.id === terrain.mapId);
}

/** Distinct sizes the seed can select, in rotation order (a pinned map alone when terrain.mapId is set). */
export function undrawnBoardSizes(config: SimConfig): readonly BoardSize[] {
  const maps = selectableMaps(config);
  const sizes = maps.length === 0 ? [config.rotationSize ?? { width: config.mapWidth, height: config.mapHeight }] : maps.map(map => mapBoardSize(config, map));
  return sizes.filter((size, i) => sizes.findIndex(other => other.width === size.width && other.height === size.height) === i);
}

/** Distinct ant caps the seed can select, in rotation order. Reads the undrawn base config. */
export function undrawnColonyCaps(config: SimConfig): readonly number[] {
  const caps = selectableMaps(config).map(map => map.colonyCap ?? config.colonyCap);
  return caps.length === 0 ? [config.colonyCap] : caps.filter((cap, i) => caps.indexOf(cap) === i);
}

/** Distinct match lengths in ticks the seed can select, in rotation order. Reads the undrawn base config. */
export function undrawnMatchTicks(config: SimConfig): readonly number[] {
  const ticks = selectableMaps(config).map(map => map.matchTicks ?? config.matchTicks);
  return ticks.length === 0 ? [config.matchTicks] : ticks.filter((t, i) => ticks.indexOf(t) === i);
}

/** Before the map is drawn: the size every selectable map shares, or null when they differ. */
export function undrawnBoardSize(config: SimConfig): BoardSize | null {
  const sizes = undrawnBoardSizes(config);
  return sizes.length === 1 ? sizes[0]! : null;
}
