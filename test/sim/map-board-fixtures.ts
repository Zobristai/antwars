/** Fixture board maps for the board-map tests, in reference tiles. Shapes follow the map
 * candidates; they are test fixtures, not maps in any rotation. */
import { rulesConfig, withDistinctMaps, type FoodPatch, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { createMapShapes } from "../../src/sim/mapShapes.js";
import { withGridScale, type GridScale } from "../../src/sim/gridScale.js";

const food = (list: [number, number, number, number][]): FoodPatch[] =>
  list.map(([tileX, tileY, radius, perTile]) => ({ tileX, tileY, radius, perTile }));

/** 64x48, today's size and redesign templates, as a board map. */
export const SHIELDS_BOARD: MapDefinition = {
  id: "fixture-shields", name: "Fixture Shields",
  water: [{ x: 20, y: 14, width: 4, height: 20 }, { x: 40, y: 14, width: 4, height: 20 }],
  board: { referenceWidth: 64, referenceHeight: 48, nestTileX: 8, nestTileY: 24,
    foodPatches: food([[10, 10, 5, 2], [18, 9, 2, 6], [18, 39, 2, 6], [30, 24, 1, 1], [28, 10, 1, 1], [28, 38, 1, 1]]) },
};

/** 64x64: three long lakes, four lanes. */
export const LANES_BOARD: MapDefinition = {
  id: "fixture-lanes", name: "Fixture Lanes",
  water: [{ x: 18, y: 10, width: 28, height: 8 }, { x: 18, y: 28, width: 28, height: 8 }, { x: 18, y: 46, width: 28, height: 8 }],
  board: { referenceWidth: 64, referenceHeight: 64, nestTileX: 8, nestTileY: 32,
    foodPatches: food([[10, 18, 5, 2], [26, 23, 2, 6], [26, 41, 2, 6], [30, 32, 1, 1], [28, 5, 1, 1], [28, 59, 1, 1]]) },
};

/** 128x46: a broken line of water in front of each home, open plain between. */
export const WIDE_BOARD: MapDefinition = {
  id: "fixture-wide", name: "Fixture Wide",
  water: [{ x: 34, y: 8, width: 4, height: 11 }, { x: 34, y: 27, width: 4, height: 11 },
    { x: 90, y: 8, width: 4, height: 11 }, { x: 90, y: 27, width: 4, height: 11 }],
  board: { referenceWidth: 128, referenceHeight: 46, nestTileX: 16, nestTileY: 23,
    foodPatches: food([[18, 9, 5, 2], [44, 9, 2, 6], [44, 37, 2, 6], [60, 23, 1, 1], [56, 9, 1, 1], [56, 37, 1, 1]]) },
};

/** Every board size, at the one grid scale a map with its own board plays at. */
export const BOARD_CASES: readonly { readonly map: MapDefinition; readonly scale: GridScale }[] = [
  { map: SHIELDS_BOARD, scale: 2 }, { map: LANES_BOARD, scale: 2 }, { map: WIDE_BOARD, scale: 2 },
];

/** Today's 64x48 board size with no board of its own: only its ant cap differs. */
export const CAP_ONLY_MAP: MapDefinition = { id: "fixture-cap-only", name: "Fixture Cap Only", water: [], colonyCap: 33 };

/** Only its match length differs. */
export const LENGTH_ONLY_MAP: MapDefinition = { id: "fixture-length-only", name: "Fixture Length Only", water: [], matchTicks: 72_000 };

/** Fixture Wide with its own ant cap and match length as well as its board. */
export const OWN_VALUES_WIDE: MapDefinition = { ...WIDE_BOARD, id: "fixture-own-wide", name: "Fixture Own Wide", colonyCap: 33, matchTicks: 40 };

/** The three-map rotation at grid scale 2 (Open Field, Three Crossings, Central Lake) plus the given maps,
 * without newMatchConfig's validation, so tests can also reach createMatch with an unsupported board.
 * The scale argument is the one grid scale every match plays at. */
export function boardRotation(_scale: GridScale, extra: readonly MapDefinition[], options: { mapId?: string; only?: boolean; base?: SimConfig } = {}): SimConfig {
  const base = options.base ?? rulesConfig("redesign");
  const distinct = withDistinctMaps(base.gridScale === undefined ? withGridScale(base) : base);
  const terrain = distinct.terrain!;
  return { ...distinct, startArea: "back-quarter", terrain: { ...terrain,
    maps: options.only === true ? [...extra] : [...createMapShapes(), ...extra],
    ...(options.mapId === undefined ? {} : { mapId: options.mapId }) } };
}
