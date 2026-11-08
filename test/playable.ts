import type { SimConfig } from "../src/sim/config.ts";
import { withGridScale } from "../src/sim/gridScale.ts";

/** Test scenarios name a reference-grid rules template (no grid scale) or an already playable config.
 * Every match plays at grid scale 2, so a template is built at grid scale 2 here, once,
 * through the one template constructor; a config that already carries grid scale 2 is used unchanged. */
export function playable(config: SimConfig): SimConfig {
  return config.gridScale === undefined ? withGridScale(config) : config;
}
