import type { SimConfig } from "../../src/sim/config.js";
import { retiredSevenMapRotation } from "../../src/sim/mapShapes.js";

/** A grid-scale-2 new-match config with the seven-map rotation that shipped first (Open Field, Three Crossings,
 * Central Lake, Isthmus, Twin Shields, Four Lanes, Wide Plain), before the swap brought in the two v2 maps,
 * so a test written for that rotation draws the same map for each seed. */
export function sevenMapRotation(config: SimConfig): SimConfig {
  if (config.gridScale !== 2) throw new Error("sevenMapRotation pins a grid-scale-2 new-match config");
  return { ...config, terrain: { ...config.terrain!, maps: retiredSevenMapRotation() } };
}
