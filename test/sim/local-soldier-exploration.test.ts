import { describe, expect, it } from "vitest";
import { rulesConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";

describe("shipped map exploration", () => {
  it.each(["central-lake", "open-field", "three-crossings"])("has a scoutable flank on %s for all sweep seeds", map => {
    const config = withGridScale(rulesConfig("redesign"));
    for (let seed = 0; seed < 100; seed++) {
      const state = createMatch(seed, { ...config, terrain: { ...config.terrain!, mapId: map } });
      expect(state.config.foodPatches.filter(patch => patch.tileY !== state.config.nestTileY).length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});
