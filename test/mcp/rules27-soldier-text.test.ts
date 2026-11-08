import { describe, expect, it } from "vitest";
import { balanceRuleLines, briefing } from "../../src/mcp/briefing.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { playable } from "../playable.ts";

// Rules-27 agent briefing soldier text, rendered for the shipped redesign config and its
// grid-scale-2 new-match form.
const CONFIGS = {
  shipped: playable(rulesConfig("redesign")),
  scaled: newMatchConfig(rulesConfig("redesign")),
} as const;
const COMBAT = "Combat in reach";

/** The food-patch line, unchanged by rules 27. */
const FOOD_PATCHES = "Food patches (left-half centres, mirrored on the right; food ceilings per original-size resource cell): (20.5,20.5), radius 10, 2 food; (36.5,18.5), radius 4, 6 food; (36.5,78.5), radius 4, 6 food; (60.5,48.5), radius 2, 1 food; (56.5,20.5), radius 2, 1 food; (56.5,76.5), radius 2, 1 food. Positions, radii and richness are drawn from the match seed, with equal mirrored food on both sides.";

/** Soldier allocation wording that rules 27 removed. */
const REMOVED_SOLDIER_WORDING = [
  "front fighters", "fights at the front", "front/patch detail", "split between queen defence",
  "of fighters", "of those fighters", "rally line", "Other free soldiers guard", "soldiers guard",
  "free soldiers stay within", "soldiers return", "empty the front",
];
/** Front share, front/queen-defence split, patch detail or fallback, stay-near-queen and return-to-queen wording. */
const FORBIDDEN_SOLDIER_TEXT = /front|patch|split|guard|stay within|nearest live queen and|return(s|ing)? (home|to (a|its|their) (live )?(queen|nest))|walk(s|ing)? (back|home)/i;

const line = (text: string, prefix: string): string => {
  const found = text.split("\n").filter(l => l.startsWith(prefix));
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
};
const soldierLine = (lines: readonly string[]): string => {
  const found = lines.filter(l => l.startsWith("Free soldiers:"));
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("rules-27 briefing describes free soldiers holding where they became free", () => {
  it.each(Object.entries(CONFIGS))("agent briefing soldier text (%s)", (_, base) => {
    const config = base;
    const defend = config.localAnts!.defendTiles;
    const text = briefing(config);
    const free = line(text, "- Free ants follow these defaults");
    const soldiers = free.slice(free.indexOf("free soldiers"));
    expect(soldiers).toBe(`free soldiers carry no food and, apart from local fights, hold within ${defend} tiles of where they became free: where they hatched, reached a spawn point or were released.`);
    // Local fights: bite in reach and near-queen defence stay in the shared clause.
    expect(free).toContain(`bite in reach; within ${defend} tiles of nearest live queen, pursue enemies within ${defend} tiles of her.`);
    const strategy = line(text, "- Strategy:");
    expect(strategy).toBe("- Strategy: workers gather and soldiers hold where they are, but you choose objectives. Count marks: food/defence/musters/attacks; squads scout/reveal. Found affordable queens; check claims/food; more commands alone do not win.");
    const balance = line(text, "- Free soldiers:");
    expect(balance).toBe(`- Free soldiers: enemy ants in sight -> push if local friends are at least 0.6 of them, else fall back toward nearest live queen; then return to hold. ${COMBAT}/nearby queen defence first.`);
    for (const owned of [soldiers, strategy.slice(strategy.indexOf("soldiers"), strategy.indexOf(", but")), balance]) {
      expect(owned).not.toMatch(FORBIDDEN_SOLDIER_TEXT);
    }
    for (const phrase of REMOVED_SOLDIER_WORDING) expect(text).not.toContain(phrase);
  });

  it.each(Object.entries(CONFIGS))("shared balance prose for /rules and house prompts (%s)", (name, base) => {
    const config = base;
    const lines = balanceRuleLines(config);
    const soldiers = soldierLine(lines);
    expect(soldiers).toBe(`Free soldiers: a free soldier with enemy ants in sight pushes on them if local friends are at least 0.6 of them, and otherwise falls back toward its nearest live queen. With none in sight it holds within ${config.localAnts!.defendTiles} tiles of where it became free: where it hatched, reached a spawn point or was released. ${COMBAT} and nearby queen defence take priority; count marks and squads take ants out of the free pool.`);
    expect(soldiers).not.toMatch(FORBIDDEN_SOLDIER_TEXT);
    for (const phrase of REMOVED_SOLDIER_WORDING) expect(lines.join("\n")).not.toContain(phrase);
    // The food-patch line is unchanged in rules 27.
    expect(lines).toContain(FOOD_PATCHES);
  });

  it("states the configured hold radius and push ratio", () => {
    const config: SimConfig = { ...CONFIGS.shipped, pushRatioPermille: 750, localAnts: { ...CONFIGS.shipped.localAnts!, defendTiles: 5 } };
    const text = briefing(config);
    expect(text).toContain("hold within 5 tiles of where they became free");
    expect(text).toContain("push if local friends are at least 0.75 of them");
    expect(soldierLine(balanceRuleLines(config))).toContain("holds within 5 tiles of where it became free");
  });
});

