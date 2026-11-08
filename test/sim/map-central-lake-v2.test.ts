/** Central Lake v2 (64x48), the map's checks at grid scale 2 with the default server's food templates. */
import { describeExactOlderWater, describeNewMapChecks, describeNewMapSelection, dryBands, nestIndex, reach, type NewMapSuite } from "./new-maps-checks.js";

const suite: NewMapSuite & { readonly mapId: "central-lake-v2" } = {
  mapId: "central-lake-v2", name: "Central Lake v2", referenceWidth: 64, referenceHeight: 48, foodSets: ["redesign"],
  // 5. Both centre columns are dry exactly north (reference rows 0-11) and south (36-47) of the lake, each route
  // 12 reference tiles wide there. Each route alone joins the halves: with that seed's rocks, colony 0's nest reaches
  // colony 1's when the centre columns are closed outside that route's rows.
  routes: (state, s) => {
    const failures: string[] = [], w = state.config.mapWidth, centre = [w / 2 - 1, w / 2];
    const routes: [string, [number, number]][] = [["north", [0, 12 * s]], ["south", [36 * s, 48 * s]]];
    for (const x of centre) if (JSON.stringify(dryBands(state, x)) !== JSON.stringify(routes.map(([, band]) => band))) failures.push(`5 centre column ${x} dry at ${JSON.stringify(dryBands(state, x))}`);
    for (const [name, [top, bottom]] of routes) {
      const seen = reach(state, [nestIndex(state, 0)], (x, y) => centre.includes(x) && (y < top || y >= bottom));
      if (seen[nestIndex(state, 1)] !== 1) failures.push(`5 the ${name} route alone does not join the halves`);
    }
    return failures;
  },
};

describeExactOlderWater(suite);
describeNewMapSelection(suite, { x: 8, y: 24 });
describeNewMapChecks(suite);
