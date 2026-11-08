/** Isthmus (64x48), the map's checks at grid scale 2 with the default server's food templates. */
import { describeNewMapChecks, describeNewMapSelection, describeExactWater, dryBands, waterInRows, type NewMapSuite } from "./new-maps-checks.js";

const suite: NewMapSuite = {
  mapId: "isthmus", name: "Isthmus", referenceWidth: 64, referenceHeight: 48, foodSets: ["redesign"],
  // Check 5: Both centre columns are dry only at rows 20-27, and rows 20-27 hold no water at any column.
  routes: (state, s) => {
    const failures: string[] = [], bridge: [number, number] = [20 * s, 28 * s];
    const w = state.config.mapWidth;
    for (const x of [w / 2 - 1, w / 2]) if (JSON.stringify(dryBands(state, x)) !== JSON.stringify([bridge])) failures.push(`5 centre column ${x} dry at ${JSON.stringify(dryBands(state, x))}`);
    failures.push(...waterInRows(state, bridge));
    return failures;
  },
};

describeExactWater(suite);
describeNewMapSelection(suite, { x: 8, y: 24 });
describeNewMapChecks(suite);
