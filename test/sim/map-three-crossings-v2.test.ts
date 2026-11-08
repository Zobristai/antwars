/** Three Crossings v2 (64x48), the map's checks at grid scale 2 with the default server's food templates. */
import { describeExactOlderWater, describeNewMapChecks, describeNewMapSelection, dryBands, nestIndex, reach, type NewMapSuite } from "./new-maps-checks.js";

/** The three crossings, reference rows 8-11, 22-25 and 36-39, as half-open reference bands. */
const CROSSINGS = [[8, 12], [22, 26], [36, 40]] as const;

const suite: NewMapSuite & { readonly mapId: "three-crossings-v2" } = {
  mapId: "three-crossings-v2", name: "Three Crossings v2", referenceWidth: 64, referenceHeight: 48, foodSets: ["redesign"],
  // 5. Both centre columns are dry exactly on the three crossings, each 4 reference tiles wide there. Each crossing
  // alone joins the halves: with that seed's rocks, colony 0's nest reaches colony 1's when the centre columns are
  // closed outside that crossing's rows.
  routes: (state, s) => {
    const failures: string[] = [], w = state.config.mapWidth, centre = [w / 2 - 1, w / 2];
    const crossings = CROSSINGS.map(([top, bottom]) => [top * s, bottom * s] as [number, number]);
    for (const x of centre) if (JSON.stringify(dryBands(state, x)) !== JSON.stringify(crossings)) failures.push(`5 centre column ${x} dry at ${JSON.stringify(dryBands(state, x))}`);
    for (const [top, bottom] of crossings) {
      const seen = reach(state, [nestIndex(state, 0)], (x, y) => centre.includes(x) && (y < top || y >= bottom));
      if (seen[nestIndex(state, 1)] !== 1) failures.push(`5 the crossing on rows ${top}-${bottom - 1} alone does not join the halves`);
    }
    return failures;
  },
};

describeExactOlderWater(suite);
describeNewMapSelection(suite, { x: 8, y: 24 });
describeNewMapChecks(suite);
