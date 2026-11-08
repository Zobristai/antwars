import type { SimConfig } from "../../src/sim/config.js";
import { createMapShapes } from "../../src/sim/mapShapes.js";

/** A grid-scale-2 new-match config with the three-map rotation it had before the seven-map rotation (Open Field,
 * Three Crossings, Central Lake), so a test written for that rotation draws the same map for each seed. */
export function threeMapRotation(config: SimConfig): SimConfig {
  if (config.gridScale !== 2) throw new Error("threeMapRotation pins a grid-scale-2 new-match config");
  return { ...config, terrain: { ...config.terrain!, maps: createMapShapes() } };
}
