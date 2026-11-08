/** Twin Shields (64x48), the map's checks at grid scale 2 with the default server's food templates. */
import { describeNewMapChecks, describeNewMapSelection, describeExactWater, nestIndex, reach, waterOutside, type NewMapSuite } from "./new-maps-checks.js";

const suite: NewMapSuite = {
  mapId: "twin-shields", name: "Twin Shields", referenceWidth: 64, referenceHeight: 48, foodSets: ["redesign"],
  // Check 5: Water lies only in columns 16-23 and 40-47 within rows 14-33. From each default nest the
  // midfield (columns 24-39) is reachable by the north way alone and by the south way alone, with that seed's rocks;
  // a way is tested alone by blocking the other half (rows 24 and below, or above 24) of that side's shield columns.
  routes: (state, s) => {
    const failures = waterOutside(state, [[16 * s, 24 * s], [40 * s, 48 * s]], [[14 * s, 34 * s]]), w = state.config.mapWidth;
    for (const colony of [0, 1] as const) {
      const shield = colony === 0 ? [16 * s, 24 * s] : [40 * s, 48 * s];
      for (const [way, closed] of [["north", (y: number) => y >= 24 * s], ["south", (y: number) => y < 24 * s]] as const) {
        const seen = reach(state, [nestIndex(state, colony)], (x, y) => x >= shield[0]! && x < shield[1]! && closed(y));
        if (!seen.some((v, i) => v === 1 && i % w >= 24 * s && i % w < 40 * s)) failures.push(`5 colony ${colony} cannot reach the midfield by the ${way} way alone`);
      }
    }
    return failures;
  },
};

describeExactWater(suite);
describeNewMapSelection(suite, { x: 8, y: 24 });
describeNewMapChecks(suite);
