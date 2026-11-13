import { rulesConfig, type FoodPatch, type MapDefinition, type SimConfig, type WaterRect } from "./config.js";
import { newMatchConfig } from "./gridScale.js";

/**
 * Candidate four-colony quadrant maps, built for preview only. They are in no rotation, two-colony or
 * four-colony: a match plays on one only through quadrantCandidateConfig with its explicit map id.
 * None carries its own ant cap or match length; the config's apply. Every value is in reference tiles of the
 * top-left quadrant (src/sim/quadrantMap.ts mirrors it into the other three).
 */
const rect = (x: number, y: number, width: number, height: number): WaterRect => ({ x, y, width, height });
const food = (tileX: number, tileY: number, radius: number, perTile: number): FoodPatch => ({ tileX, tileY, radius, perTile });
/** Three seeded centre disks of radius 2 at 6 per tile, shared by every candidate. */
const CENTRE_FOOD = [{ radius: 2, perTile: 6 }, { radius: 2, perTile: 6 }, { radius: 2, perTile: 6 }];

/** 64x48: each home sits in a corner cove behind an L-shaped lake, open toward both neighbours; open centre. */
export const FOUR_COVES: MapDefinition = {
  id: "four-coves", name: "Four Coves",
  water: [rect(19, 8, 3, 8), rect(8, 13, 11, 3)],
  quadrant: {
    referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 8, centreHalfHeight: 6,
    nestTileX: 6, nestTileY: 5, startArea: rect(1, 1, 12, 10),
    foodPatches: [food(13, 7, 5, 2), food(27, 9, 2, 6), food(11, 20, 2, 6)],
    centreFood: CENTRE_FOOD,
  },
};

/** 96x64: a plus-shaped river splits four islands, joined by one ford on each arm and an open central plaza. */
export const CROSSROADS: MapDefinition = {
  id: "crossroads", name: "Crossroads",
  water: [rect(45, 0, 3, 8), rect(45, 16, 3, 9), rect(0, 29, 12, 3), rect(20, 29, 18, 3)],
  quadrant: {
    referenceWidth: 96, referenceHeight: 64, centreHalfWidth: 10, centreHalfHeight: 7,
    nestTileX: 10, nestTileY: 9, startArea: rect(2, 2, 16, 13),
    foodPatches: [food(24, 9, 5, 2), food(39, 12, 2, 6), food(16, 23, 2, 6)],
    centreFood: CENTRE_FOOD,
  },
};

/** 112x64: an east-west strait crossed only through the central plaza; a pond on each north-south border splits
 * it into two routes. */
export const STRAIT: MapDefinition = {
  id: "strait", name: "Strait",
  water: [rect(0, 28, 46, 4), rect(52, 8, 4, 6)],
  quadrant: {
    referenceWidth: 112, referenceHeight: 64, centreHalfWidth: 10, centreHalfHeight: 8,
    nestTileX: 12, nestTileY: 11, startArea: rect(2, 2, 20, 16),
    foodPatches: [food(27, 8, 5, 2), food(45, 11, 2, 6), food(30, 24, 2, 6)],
    centreFood: CENTRE_FOOD,
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
