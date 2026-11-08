/** Wide Plain (128x46, its own board), the map's checks at grid scale 2 with its own food templates. */
import { expect, it } from "vitest";
import { WIDE_PLAIN, SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { describeNewMapChecks, describeNewMapSelection, describeExactWater, nestIndex, reach, waterOutside, type NewMapSuite } from "./new-maps-checks.js";

const GAPS = [[0, 8], [19, 27], [38, 46]] as const;
const suite: NewMapSuite = {
  mapId: "wide-plain", name: "Wide Plain", referenceWidth: 128, referenceHeight: 46, foodSets: ["redesign"],
  // Check 5: Water lies only in columns 32-41 and 86-95 within rows 8-18 and 27-37. On each side, each gap
  // (rows 0-7, 19-26 and 38-45 of those columns) alone joins the default nest to the plain (columns 42-85), with that seed's rocks.
  routes: (state, s) => {
    const w = state.config.mapWidth;
    const failures = waterOutside(state, [[32 * s, 42 * s], [86 * s, 96 * s]], [[8 * s, 19 * s], [27 * s, 38 * s]]);
    for (const colony of [0, 1] as const) {
      const ponds = colony === 0 ? [32 * s, 42 * s] : [86 * s, 96 * s];
      for (const [i, [top, bottom]] of GAPS.entries()) {
        const seen = reach(state, [nestIndex(state, colony)], (x, y) => x >= ponds[0]! && x < ponds[1]! && (y < top * s || y >= bottom * s));
        if (!seen.some((v, j) => v === 1 && j % w >= 42 * s && j % w < 86 * s)) failures.push(`5 colony ${colony} gap ${i + 1} alone does not reach the plain`);
      }
    }
    return failures;
  },
};

it("Wide Plain keeps its board 128x46, nest (16,23) and its six food templates", () => {
  const { water: _water, ...rest } = WIDE_PLAIN;
  expect(rest).toEqual({ id: "wide-plain", name: "Wide Plain", gridScale: 2, colonyCap: 1024, matchTicks: 36_000,
    board: { referenceWidth: 128, referenceHeight: 46, nestTileX: 16, nestTileY: 23, foodPatches: [
      { tileX: 18, tileY: 9, radius: 5, perTile: 2 }, { tileX: 44, tileY: 9, radius: 2, perTile: 6 }, { tileX: 44, tileY: 37, radius: 2, perTile: 6 },
      { tileX: 60, tileY: 23, radius: 1, perTile: 1 }, { tileX: 56, tileY: 9, radius: 1, perTile: 1 }, { tileX: 56, tileY: 37, radius: 1, perTile: 1 }] } });
  expect(SCALE2_MAPS).toContain(WIDE_PLAIN);
});

describeExactWater(suite);
describeNewMapSelection(suite, { x: 16, y: 23 });
describeNewMapChecks(suite);
