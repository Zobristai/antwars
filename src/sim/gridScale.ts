import { withDistinctMaps, type FoodPatch, type SimConfig } from "./config.js";
import { validateMapBoards } from "./mapBoard.js";

/** Fine tiles per original tile edge. Every match plays at grid scale 2. */
export type GridScale = 2;

/** The one grid scale every match plays at. */
export const NEW_MATCH_GRID_SCALE: GridScale = 2;

/** Only server new-match boundaries call this; saved/replay configs are never converted. A reference
 * template (a rules template without a grid scale) is built at grid scale 2; a grid-scale-2 config is kept. */
export function newMatchConfig(config: SimConfig): SimConfig {
  const current = config.gridScale === undefined ? withDistinctMaps(withGridScale(config)) : config;
  gridScaleOf(current);
  // Refuse any map whose own board this grid scale cannot carry.
  validateMapBoards(current);
  return current.startArea === "back-quarter" ? current : { ...current, startArea: "back-quarter" };
}

export interface GridScaleMetadata {
  readonly gridScale?: number;
}

/** The grid scale a playable config, log header or stream setup carries. Only an explicit 2 plays:
 * a missing marker is never read as another scale, and grid scales 1 and 4 are refused. */
export function gridScaleOf(config: GridScaleMetadata | SimConfig): GridScale {
  const scale = (config as GridScaleMetadata).gridScale;
  if (scale === undefined) throw new RangeError("grid scale missing: every match plays at grid scale 2");
  if (scale === 1 || scale === 4) throw new RangeError(`grid scale ${scale} no longer plays: every match plays at grid scale 2`);
  if (scale !== 2) throw new RangeError(`grid scale ${String(scale)} is not 2: every match plays at grid scale 2`);
  return scale;
}

/** Number of fine cells in one original tile's physical area. */
export function physicalTileArea(config: GridScaleMetadata | SimConfig): number {
  return gridScaleOf(config) ** 2;
}

/** Original tile containing a fine tile, for rules that count physical tile areas. */
export function referenceTile(fineTile: number, config: GridScaleMetadata | SimConfig): number {
  return Math.floor(fineTile / gridScaleOf(config));
}

/** Canonical fine-array index for one original physical food/resource cell. */
export function resourceCellIndex(config: Pick<SimConfig, "mapWidth" | "gridScale">, tile: number): number {
  const scale = gridScaleOf(config);
  return Math.floor(Math.floor(tile / config.mapWidth) / scale) * scale * config.mapWidth +
    Math.floor((tile % config.mapWidth) / scale) * scale;
}

/** Tile-centre coordinates, not cell boundaries: preserves exact physical centres. */
export function scaledTileCentre(tile: number, scale: number): number {
  return (tile + 0.5) * scale - 0.5;
}

export function scaledFoodPatch(patch: FoodPatch, scale: number): FoodPatch {
  return { ...patch, tileX: scaledTileCentre(patch.tileX, scale),
    tileY: scaledTileCentre(patch.tileY, scale), radius: patch.radius * scale };
}

/** Build the grid-scale-2 config from a reference-grid template (a rules template without a grid scale).
 * This is the one construction of a playable config from a template. Counts, money and clocks never scale.
 * Food amounts remain per original resource cell, not per fine terrain cell.
 * Terrain maps retain their serialized reference dimensions and half-open bounds.
 */
export function withGridScale(config: SimConfig): SimConfig {
  if (config.gridScale !== undefined) throw new Error("withGridScale requires a reference-grid template");
  const scale = NEW_MATCH_GRID_SCALE;
  return {
    ...config, gridScale: scale,
    mapWidth: config.mapWidth * scale, mapHeight: config.mapHeight * scale,
    nestTileX: scaledTileCentre(config.nestTileX, scale), nestTileY: scaledTileCentre(config.nestTileY, scale),
    nestDeliverTiles: config.nestDeliverTiles * scale,
    antSpeedTilesPerSecond: config.antSpeedTilesPerSecond * scale,
    sightTiles: config.sightTiles * scale, smellTiles: config.smellTiles * scale,
    overrunRadiusTiles: config.overrunRadiusTiles * scale,
    markReachTiles: config.markReachTiles * scale, attackRadiusTiles: config.attackRadiusTiles * scale,
    ...(config.patrolLinkTiles === undefined ? {} : { patrolLinkTiles: config.patrolLinkTiles * scale }),
    guardEngageTiles: config.guardEngageTiles * scale,
    foodPatches: config.foodPatches.map(p => scaledFoodPatch(p, scale)),
    ...(config.foodLayout === undefined ? {} : { foodLayout: {
      ...config.foodLayout, patches: config.foodLayout.patches.map(p => scaledFoodPatch(p, scale)),
      positionJitterTiles: config.foodLayout.positionJitterTiles * scale,
      radiusJitterTiles: config.foodLayout.radiusJitterTiles * scale,
      nestClearanceTiles: config.foodLayout.nestClearanceTiles * scale,
      patchClearanceTiles: config.foodLayout.patchClearanceTiles * scale,
    } }),
    ...(config.queenFounding === undefined ? {} : { queenFounding: {
      ...config.queenFounding, minDistanceTiles: config.queenFounding.minDistanceTiles * scale,
    } }),
    ...(config.countMarks === undefined ? {} : { countMarks: {
      ...config.countMarks, recruitTiles: config.countMarks.recruitTiles * scale,
      defendTiles: config.countMarks.defendTiles * scale,
    } }),
    ...(config.localAnts === undefined ? {} : { localAnts: {
      ...config.localAnts, defendTiles: config.localAnts.defendTiles * scale,
      ...(config.localAnts.workerQueenThreatTiles === undefined ? {} : {
        workerQueenThreatTiles: config.localAnts.workerQueenThreatTiles * scale,
      }),
    } }),
    ...(config.queenHp === undefined ? {} : { queenHp: {
      ...config.queenHp, regenClearTiles: config.queenHp.regenClearTiles * scale,
    } }),
    // All imported spacing values have length units: radius/epsilon/link
    // and arrival are sub-units; strength and maxStep are displacement per tick.
    // None is a dimensionless multiplier or a count.
    ...(config.pointArrival === undefined ? {} : { pointArrival: { ...config.pointArrival,
      pitch: config.pointArrival.pitch * scale, jitter: config.pointArrival.jitter * scale,
      minimumSpacing: config.pointArrival.minimumSpacing * scale,
    } }),
    ...(config.softSeparation === undefined ? {} : { softSeparation: {
      radius: config.softSeparation.radius * scale,
      ...(config.softSeparation.soldierRadius === undefined ? {} : { soldierRadius: config.softSeparation.soldierRadius * scale }),
      ...(config.softSeparation.guardSettle === undefined ? {} : { guardSettle: config.softSeparation.guardSettle }),
      ...(config.softSeparation.restPass === undefined ? {} : { restPass: config.softSeparation.restPass }),
      strength: config.softSeparation.strength * scale,
      maxStep: config.softSeparation.maxStep * scale,
      arrivalSubunits: config.softSeparation.arrivalSubunits * scale,
      epsilon: config.softSeparation.epsilon * scale,
      arrivalLinkRadius: config.softSeparation.arrivalLinkRadius * scale,
    } }),
  };
}
