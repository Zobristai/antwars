import { rulesConfig, type FoodPatch, type MapDefinition, type SimConfig, type WaterRect } from "./config.js";
import { newMatchConfig } from "./gridScale.js";

/**
 * Candidate four-colony quadrant maps, built for preview only. They are in no rotation, two-colony or
 * four-colony: a match plays on one only through quadrantCandidateConfig with its explicit map id.
 * None carries its own ant cap or match length; the config's apply. Every value is in reference tiles of the
 * top-left quadrant (src/sim/quadrantMap.ts mirrors it into the other three), except the water: each candidate sets
 * nativeWater, so its water is the top-left quadrant of the native board at grid scale 2, row by row.
 */
const rect = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });
const food = (tileX: number, tileY: number, radius: number, perTile: number): FoodPatch => ({ tileX, tileY, radius, perTile });
/** Three seeded centre disks of radius 2 at 6 per tile, shared by every candidate. */
const CENTRE_FOOD = [{ radius: 2, perTile: 6 }, { radius: 2, perTile: 6 }, { radius: 2, perTile: 6 }];

/** 64x48: each home sits in a corner cove behind a curved lake, open toward both neighbours; open centre. */
export const FOUR_COVES: MapDefinition = {
  id: "four-coves", name: "Four Coves",
  water: [
    rect(40, 16, 2, 1), rect(39, 17, 5, 1), rect(38, 18, 6, 1), rect(38, 19, 7, 2), rect(38, 21, 8, 3),
    rect(38, 24, 9, 2), rect(38, 26, 8, 1), rect(18, 27, 5, 1), rect(34, 27, 12, 1), rect(17, 28, 29, 1),
    rect(16, 29, 29, 2), rect(16, 31, 28, 1), rect(17, 32, 26, 1), rect(18, 33, 24, 1), rect(20, 34, 22, 1),
    rect(23, 35, 18, 1), rect(26, 36, 14, 1), rect(34, 37, 3, 1),
  ],
  quadrant: {
    referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 8, centreHalfHeight: 6,
    nestTileX: 6, nestTileY: 5, startArea: rect(1, 1, 12, 10),
    foodPatches: [food(13, 7, 5, 2), food(27, 9, 2, 6), food(11, 20, 2, 6)],
    centreFood: CENTRE_FOOD, nativeWater: true,
  },
};

/** 96x64: a plus-shaped river splits four islands, joined by one ford on each arm and an open central plaza. */
export const CROSSROADS: MapDefinition = {
  id: "crossroads", name: "Crossroads",
  water: [
    rect(86, 0, 10, 5), rect(87, 5, 9, 3), rect(88, 8, 8, 1), rect(89, 9, 7, 2), rect(90, 11, 6, 1),
    rect(91, 12, 5, 2), rect(92, 14, 4, 1), rect(94, 15, 2, 1), rect(94, 32, 2, 1), rect(93, 33, 3, 1),
    rect(92, 34, 4, 1), rect(91, 35, 5, 1), rect(90, 36, 6, 4), rect(91, 40, 5, 3), rect(90, 43, 6, 2),
    rect(91, 45, 5, 1), rect(92, 46, 4, 1), rect(93, 47, 3, 3), rect(0, 54, 4, 1), rect(9, 54, 3, 1),
    rect(52, 54, 4, 1), rect(0, 55, 5, 1), rect(8, 55, 5, 1), rect(51, 55, 6, 1), rect(0, 56, 14, 1),
    rect(50, 56, 9, 1), rect(0, 57, 16, 1), rect(48, 57, 15, 1), rect(68, 57, 3, 1), rect(0, 58, 20, 2),
    rect(44, 58, 29, 1), rect(43, 59, 31, 1), rect(0, 60, 22, 1), rect(42, 60, 33, 1), rect(0, 61, 23, 1),
    rect(41, 61, 35, 1), rect(0, 62, 24, 2), rect(40, 62, 36, 2),
  ],
  quadrant: {
    referenceWidth: 96, referenceHeight: 64, centreHalfWidth: 10, centreHalfHeight: 7,
    nestTileX: 10, nestTileY: 9, startArea: rect(2, 2, 16, 13),
    foodPatches: [food(24, 9, 5, 2), food(39, 12, 2, 6), food(16, 23, 2, 6)],
    centreFood: CENTRE_FOOD, nativeWater: true,
  },
};

/** 112x64: an east-west strait crossed only through the central plaza; a pond on each north-south border splits
 * it into two routes. */
export const STRAIT: MapDefinition = {
  id: "strait", name: "Strait",
  water: [
    rect(109, 16, 3, 1), rect(107, 17, 5, 1), rect(105, 18, 7, 1), rect(103, 19, 9, 3), rect(102, 22, 10, 2),
    rect(103, 24, 9, 1), rect(104, 25, 8, 1), rect(106, 26, 6, 1), rect(108, 27, 4, 1), rect(0, 52, 6, 1),
    rect(0, 53, 9, 1), rect(36, 53, 6, 1), rect(0, 54, 12, 1), rect(33, 54, 11, 1), rect(74, 54, 9, 1),
    rect(0, 55, 14, 1), rect(32, 55, 15, 1), rect(71, 55, 13, 1), rect(0, 56, 18, 1), rect(30, 56, 19, 1),
    rect(63, 56, 23, 1), rect(0, 57, 20, 1), rect(29, 57, 22, 1), rect(60, 57, 27, 1), rect(0, 58, 88, 1),
    rect(0, 59, 90, 1), rect(0, 60, 91, 1), rect(0, 61, 92, 3),
  ],
  quadrant: {
    referenceWidth: 112, referenceHeight: 64, centreHalfWidth: 10, centreHalfHeight: 8,
    nestTileX: 12, nestTileY: 11, startArea: rect(2, 2, 20, 16),
    foodPatches: [food(27, 8, 5, 2), food(45, 11, 2, 6), food(30, 24, 2, 6)],
    centreFood: CENTRE_FOOD, nativeWater: true,
  },
};

/** The candidates, kept apart from every rotation. */
export const QUADRANT_CANDIDATES: readonly MapDefinition[] = [FOUR_COVES, CROSSROADS, STRAIT];

/** A headless four-colony match config on the candidate with this map id: base with terrain.maps holding that
 * candidate alone, so a match created from it takes the candidate's own board size. base defaults to
 * newMatchConfig(rulesConfig("redesign")). RangeError for an id that names no candidate. */
export function quadrantCandidateConfig(id: string, base: SimConfig = newMatchConfig(rulesConfig("redesign"))): SimConfig {
  const map = QUADRANT_CANDIDATES.find(candidate => candidate.id === id);
  if (map === undefined) {
    throw new RangeError(`no quadrant map candidate has id ${JSON.stringify(id)}; candidates: ${QUADRANT_CANDIDATES.map(c => c.id).join(", ")}`);
  }
  if (base.terrain === undefined) throw new Error("a quadrant map candidate requires a base config with terrain rules");
  return { ...base, terrain: { ...base.terrain, maps: [map] } };
}
