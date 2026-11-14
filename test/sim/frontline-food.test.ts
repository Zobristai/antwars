import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { PUBLIC_CONFIG, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { renderRules } from "../../web/rules.js";
import { playable } from "../playable.ts";

describe("frontline food", () => {
  it.each([PUBLIC_CONFIG, rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))].map(playable))("is taught by the briefing, join briefing and rules page (%#)", config => {
    for (const text of [briefing(config), joinBriefing(config), renderRules(config)]) {
      expect(text).toContain("Frontline food: four small mirrored patches");
      expect(text).toContain("(28,10), (35,10), (28,38), (35,38)");
      expect(text).toContain("A pair that cannot fit is omitted on both sides.");
    }
  });
});
