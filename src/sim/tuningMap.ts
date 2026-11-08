import { rulesConfig, type MapDefinition, type SimConfig } from "./config.js";
import { gridScaleOf, newMatchConfig } from "./gridScale.js";
import { WIDE_PLAIN } from "./scale2Maps.js";

/**
 * A tuning-only map for up to 10,000 ants per side, at grid scale 2 for 27,000 ticks, with the chosen
 * per-side count as its ant cap. It is not in the new-match rotation (newMatchMaps): a match plays on it only
 * through tuningMapConfig.
 */
export const TUNING_MAP_ID = "tuning-plain";
export const TUNING_MAP_MAX_ANTS_PER_SIDE = 10_000;

/** Wide Plain's 256x92 board has rest sites
 * for only about 6,200 ants per side, so the tuning map has its own board: Wide Plain's 128-column layout over
 * 92 reference rows (256x184 at grid scale 2), every row of its water, nest and food centres doubled. */
const ROWS = 2;
const wideBoard = WIDE_PLAIN.board!;
const TUNING_WATER = WIDE_PLAIN.water.map(r => ({ ...r, y: r.y * ROWS, height: r.height * ROWS }));
const TUNING_BOARD = { ...wideBoard, referenceHeight: wideBoard.referenceHeight * ROWS, nestTileY: wideBoard.nestTileY * ROWS,
  foodPatches: wideBoard.foodPatches.map(p => ({ ...p, tileY: p.tileY * ROWS })) };

/** New-match config pinned to the tuning map: map colonyCap = perSide and config.startAnts = perSide, placed by
 * startAntLayout "fill-start-area" so every start ant is on the board; grid scale 2, 27,000 ticks, the tuning
 * board above; terrain.maps holds only the tuning map, terrain.mapId names it.
 * RangeError for anything but a whole number 1..10,000. base defaults to newMatchConfig(rulesConfig("redesign")). */
export function tuningMapConfig(perSide: number, base: SimConfig = newMatchConfig(rulesConfig("redesign"))): SimConfig {
  if (!Number.isSafeInteger(perSide) || perSide < 1 || perSide > TUNING_MAP_MAX_ANTS_PER_SIDE) {
    throw new RangeError(`tuning map ants per side must be a whole number from 1 to ${TUNING_MAP_MAX_ANTS_PER_SIDE}; got ${String(perSide)}`);
  }
  // A grid-scale-2 base with terrain rules: newMatchConfig would otherwise replace the maps with the rotation.
  gridScaleOf(base);
  if (base.terrain === undefined) throw new Error("tuning map requires a base config with terrain rules");
  const map: MapDefinition = {
    id: TUNING_MAP_ID, name: "Tuning Plain", gridScale: 2,
    colonyCap: perSide, matchTicks: 27_000,
    water: TUNING_WATER, board: TUNING_BOARD,
  };
  return newMatchConfig({ ...base, startAnts: perSide, startAntLayout: "fill-start-area",
    terrain: { ...base.terrain, maps: [map], mapId: TUNING_MAP_ID } });
}
