import type { FoodPatch, MapDefinition, WaterRect } from "./config.js";

/**
 * Four maps that play only at grid scale 2 (water exactly as test/sim/water-rev4.json lists it:
 * [x, y, width, height], half-open, row by row). Each carries gridScale 2, so a config at any
 * other grid scale refuses it (validateMapBoard).
 *
 * Isthmus and Twin Shields are 64x48 maps without a board: the config's size, start areas, default
 * nest and food templates, with water in native tiles at grid scale 2 (128x96).
 * Four Lanes (64x64) and Wide Plain (128x46) carry their own board, water in reference tiles.
 */
type Rect = readonly [x: number, y: number, width: number, height: number];
const rects = (list: readonly Rect[]): WaterRect[] => list.map(([x, y, width, height]) => ({ x, y, width, height }));
const food = (list: readonly (readonly [number, number, number, number])[]): FoodPatch[] =>
  list.map(([tileX, tileY, radius, perTile]) => ({ tileX, tileY, radius, perTile }));

export const ISTHMUS: MapDefinition = {
  id: "isthmus", name: "Isthmus", gridScale: 2,
  water: rects([
    [45, 0, 38, 6], [46, 6, 36, 1], [47, 7, 34, 1], [48, 8, 32, 4],
    [47, 12, 34, 1], [46, 13, 36, 2], [47, 15, 34, 2], [48, 17, 32, 3],
    [49, 20, 30, 2], [50, 22, 28, 3], [51, 25, 26, 7], [52, 32, 24, 1],
    [53, 33, 22, 1], [54, 34, 20, 1], [55, 35, 18, 1], [56, 36, 16, 1],
    [57, 37, 14, 1], [59, 38, 10, 1], [62, 39, 4, 1], [62, 56, 4, 1],
    [59, 57, 10, 1], [58, 58, 12, 1], [56, 59, 16, 2], [55, 61, 18, 2],
    [54, 63, 20, 1], [53, 64, 22, 2], [52, 66, 24, 1], [50, 67, 28, 2],
    [49, 69, 30, 2], [50, 71, 28, 5], [49, 76, 30, 1], [48, 77, 32, 4],
    [47, 81, 34, 6], [46, 87, 36, 1], [45, 88, 38, 1], [44, 89, 40, 5],
    [43, 94, 42, 2],
  ]),
};

export const TWIN_SHIELDS: MapDefinition = {
  id: "twin-shields", name: "Twin Shields", gridScale: 2,
  water: rects([
    [35, 29, 5, 1], [88, 29, 5, 1], [35, 30, 7, 1], [86, 30, 7, 1],
    [35, 31, 9, 1], [84, 31, 9, 1], [37, 32, 7, 1], [84, 32, 7, 1],
    [37, 33, 6, 2], [85, 33, 6, 2], [38, 35, 6, 1], [84, 35, 6, 1],
    [38, 36, 8, 5], [82, 36, 8, 5], [38, 41, 9, 1], [81, 41, 9, 1],
    [39, 42, 8, 1], [81, 42, 8, 1], [39, 43, 7, 2], [82, 43, 7, 2],
    [40, 45, 6, 2], [82, 45, 6, 2], [41, 47, 5, 3], [82, 47, 5, 3],
    [40, 50, 6, 2], [82, 50, 6, 2], [38, 52, 8, 1], [82, 52, 8, 1],
    [38, 53, 9, 4], [81, 53, 9, 4], [38, 57, 8, 1], [82, 57, 8, 1],
    [37, 58, 9, 1], [82, 58, 9, 1], [37, 59, 7, 1], [84, 59, 7, 1],
    [36, 60, 8, 1], [84, 60, 8, 1], [36, 61, 7, 1], [85, 61, 7, 1],
    [36, 62, 6, 1], [86, 62, 6, 1], [36, 63, 5, 1], [87, 63, 5, 1],
    [35, 64, 6, 1], [87, 64, 6, 1], [35, 65, 5, 1], [88, 65, 5, 1],
    [35, 66, 3, 1], [90, 66, 3, 1],
  ]),
};

export const FOUR_LANES: MapDefinition = {
  id: "four-lanes", name: "Four Lanes", gridScale: 2,
  // 768 ants per colony, 45 minutes.
  colonyCap: 768, matchTicks: 27_000,
  water: rects([
    [28, 10, 8, 1], [24, 11, 16, 1], [20, 12, 24, 1], [18, 13, 28, 3],
    [23, 16, 18, 1], [28, 17, 8, 1], [28, 28, 8, 1], [20, 29, 24, 1],
    [18, 30, 28, 3], [19, 33, 26, 1], [21, 34, 22, 1], [24, 35, 16, 1],
    [21, 47, 22, 1], [18, 48, 28, 3], [22, 51, 20, 1], [26, 52, 12, 1],
  ]),
  board: { referenceWidth: 64, referenceHeight: 64, nestTileX: 8, nestTileY: 32,
    // near-home; north and south inner lanes; centre; north and south outer lanes (optional pair).
    foodPatches: food([[10, 18, 5, 2], [26, 23, 2, 6], [26, 41, 2, 6], [30, 32, 1, 1], [28, 5, 1, 1], [28, 59, 1, 1]]) },
};

export const WIDE_PLAIN: MapDefinition = {
  id: "wide-plain", name: "Wide Plain", gridScale: 2,
  // 1024 ants per colony, 60 minutes.
  colonyCap: 1024, matchTicks: 36_000,
  water: rects([
    [35, 8, 4, 1], [89, 8, 4, 1], [34, 9, 6, 1], [88, 9, 6, 1],
    [33, 10, 8, 2], [87, 10, 8, 2], [33, 12, 7, 2], [88, 12, 7, 2],
    [33, 14, 8, 3], [87, 14, 8, 3], [33, 17, 7, 1], [88, 17, 7, 1],
    [35, 18, 4, 1], [89, 18, 4, 1], [36, 27, 3, 1], [89, 27, 3, 1],
    [35, 28, 5, 1], [88, 28, 5, 1], [34, 29, 7, 4], [87, 29, 7, 4],
    [33, 33, 8, 1], [87, 33, 8, 1], [33, 34, 7, 2], [88, 34, 7, 2],
    [33, 36, 6, 1], [89, 36, 6, 1], [35, 37, 4, 1], [89, 37, 4, 1],
  ]),
  board: { referenceWidth: 128, referenceHeight: 46, nestTileX: 16, nestTileY: 23,
    // near-home; north and south flanks on the plain; centre; two frontline (optional pair).
    foodPatches: food([[18, 9, 5, 2], [44, 9, 2, 6], [44, 37, 2, 6], [60, 23, 1, 1], [56, 9, 1, 1], [56, 37, 1, 1]]) },
};

/** Appended, in this order, to the grid-scale-2 new-match rotation. */
export const SCALE2_MAPS: readonly MapDefinition[] = [ISTHMUS, TWIN_SHIELDS, FOUR_LANES, WIDE_PLAIN];

/**
 * Stepped versions of Three Crossings and Central Lake, which they replace in the new-match
 * rotation. Water exactly as test/sim/water-older.json lists it under each old id's
 * "scale2" key: native tiles at grid scale 2 (128x96).
 * No board, ant cap or match length of their own: the config's 64x48 board, start areas, default nest,
 * food templates, 512 ants and 30 minutes, as the maps they replace.
 */
export const THREE_CROSSINGS_V2: MapDefinition = {
  id: "three-crossings-v2", name: "Three Crossings v2", gridScale: 2,
  water: rects([
    [57, 0, 14, 2], [58, 2, 12, 2], [59, 4, 10, 3], [58, 7, 12, 1],
    [57, 8, 14, 2], [58, 10, 12, 1], [59, 11, 10, 1], [60, 12, 8, 2],
    [61, 14, 6, 1], [62, 15, 4, 1], [62, 24, 4, 1], [61, 25, 6, 1],
    [60, 26, 8, 2], [59, 28, 10, 1], [58, 29, 12, 1], [57, 30, 14, 1],
    [56, 31, 16, 3], [57, 34, 14, 1], [58, 35, 12, 1], [59, 36, 10, 2],
    [60, 38, 8, 3], [61, 41, 6, 2], [62, 43, 4, 1], [62, 52, 4, 1],
    [61, 53, 6, 2], [60, 55, 8, 3], [59, 58, 10, 1], [58, 59, 12, 2],
    [59, 61, 10, 1], [60, 62, 8, 2], [59, 64, 10, 1], [58, 65, 12, 1],
    [57, 66, 14, 2], [58, 68, 12, 1], [59, 69, 10, 1], [61, 70, 6, 1],
    [62, 71, 4, 1], [62, 80, 4, 1], [61, 81, 6, 1], [60, 82, 8, 1],
    [59, 83, 10, 2], [58, 85, 12, 2], [59, 87, 10, 3], [58, 90, 12, 1],
    [57, 91, 14, 2], [56, 93, 16, 3],
  ]),
};

export const CENTRAL_LAKE_V2: MapDefinition = {
  id: "central-lake-v2", name: "Central Lake v2", gridScale: 2,
  water: rects([
    [60, 24, 8, 1], [58, 25, 12, 1], [56, 26, 16, 1], [54, 27, 20, 1],
    [52, 28, 24, 2], [51, 30, 26, 2], [50, 32, 28, 1], [48, 33, 32, 1],
    [46, 34, 36, 1], [45, 35, 38, 1], [44, 36, 40, 2], [45, 38, 38, 1],
    [46, 39, 36, 1], [48, 40, 32, 1], [49, 41, 30, 3], [48, 44, 32, 1],
    [46, 45, 36, 1], [44, 46, 40, 1], [43, 47, 42, 1], [42, 48, 44, 1],
    [41, 49, 46, 2], [40, 51, 48, 3], [41, 54, 46, 2], [42, 56, 44, 1],
    [43, 57, 42, 2], [44, 59, 40, 1], [46, 60, 36, 1], [48, 61, 32, 1],
    [49, 62, 30, 2], [50, 64, 28, 1], [51, 65, 26, 2], [53, 67, 22, 1],
    [54, 68, 20, 1], [56, 69, 16, 1], [57, 70, 14, 1], [59, 71, 10, 1],
  ]),
};
