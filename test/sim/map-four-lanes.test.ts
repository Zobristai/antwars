/** Four Lanes (64x64, its own board), the map's checks at grid scale 2 with its own food templates. */
import { expect, it } from "vitest";
import { FOUR_LANES, SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { describeNewMapChecks, describeNewMapSelection, describeExactWater, landParts, reach, waterOutside, type NewMapSuite } from "./new-maps-checks.js";

const suite: NewMapSuite = {
  mapId: "four-lanes", name: "Four Lanes", referenceWidth: 64, referenceHeight: 64, foodSets: ["redesign"],
  // Check 5: Water lies only in columns 18-45 within the bands rows 10-17, 28-35 and 46-53. The land of
  // columns 18-45, joined only within those columns, forms exactly four parts touching both column 18 and column 45
  // (a pocket touching only one is not a lane). Each of the four alone joins the back areas, with that seed's rocks.
  routes: (state, s) => {
    const { mapWidth: w, mapHeight: h } = state.config, from = 18 * s, to = 46 * s;
    const failures = waterOutside(state, [[from, to]], [[10 * s, 18 * s], [28 * s, 36 * s], [46 * s, 54 * s]]);
    const touches = (part: Uint8Array, x: number) => { for (let y = 0; y < h; y++) if (part[y * w + x]) return true; return false; };
    const lanes = landParts(state, [from, to]).filter(part => touches(part, from) && touches(part, to - 1));
    if (lanes.length !== 4) return [...failures, `5 ${lanes.length} lanes cross columns ${from}-${to - 1}`];
    const west: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < from; x++) west.push(y * w + x);
    for (const [i, lane] of lanes.entries()) {
      const seen = reach(state, west, (x, y) => x >= from && x < to && !lane[y * w + x]);
      if (!seen.some((v, j) => v === 1 && j % w >= to)) failures.push(`5 lane ${i + 1} alone does not join the back areas`);
    }
    return failures;
  },
};

it("Four Lanes keeps its board 64x64, nest (8,32) and its six food templates", () => {
  const { water: _water, ...rest } = FOUR_LANES;
  expect(rest).toEqual({ id: "four-lanes", name: "Four Lanes", gridScale: 2, colonyCap: 768, matchTicks: 27_000,
    board: { referenceWidth: 64, referenceHeight: 64, nestTileX: 8, nestTileY: 32, foodPatches: [
      { tileX: 10, tileY: 18, radius: 5, perTile: 2 }, { tileX: 26, tileY: 23, radius: 2, perTile: 6 }, { tileX: 26, tileY: 41, radius: 2, perTile: 6 },
      { tileX: 30, tileY: 32, radius: 1, perTile: 1 }, { tileX: 28, tileY: 5, radius: 1, perTile: 1 }, { tileX: 28, tileY: 59, radius: 1, perTile: 1 }] } });
  expect(SCALE2_MAPS).toContain(FOUR_LANES);
});

describeExactWater(suite);
describeNewMapSelection(suite, { x: 8, y: 32 });
describeNewMapChecks(suite);
