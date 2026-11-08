import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig } from "../../src/sim/config.js";
import { groundIncome } from "../../src/sim/forage.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { renderRules } from "../../web/rules.js";
import { PRE_FRONTLINE_CONFIGS, PRE_FRONTLINE_PUBLIC_CONFIG } from "./fixtures.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: each live template as a match plays it.
const live = [DEFAULT_CONFIG, RULES_V4_CONFIG, PUBLIC_CONFIG,
  rulesConfig("v4"), rulesConfig("count-marks"), rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))].map(playable);

describe("new matches forage instead of earning held-ground income", () => {
  it.each(live)("omits income and its taper from the new config and stored header (%#)", config => {
    expect(config).not.toHaveProperty("groundFoodIntervalTicks");
    expect(config).not.toHaveProperty("groundIncomeExcessPermille");
    expect(config.groundIncomeRevision).toBe(1);
    const { header } = parseLog([headerLine(7919, config)]);
    expect(header.rulesVersion).toBe(27);
    expect(JSON.stringify(header.config)).toBe(JSON.stringify(config));
    const state = createMatch(7919, config);
    state.owner.fill(0);
    for (const tick of [0, 599, 600, 1200, 18000]) expect(groundIncome(state, tick)).toEqual([0, 0]);
  });

  it("keeps the actual step from crediting held ground at the old payout boundary", () => {
    const state = createMatch(7919, playable({ ...PUBLIC_CONFIG, hatchIntervalTicks: 100_000 }));
    state.ants = [];
    state.owner.fill(0);
    state.tick = 600;
    expect(step(state).state.colonies.map(c => c.foodStore)).toEqual([0, 0]);
  });

  it.each([PRE_FRONTLINE_PUBLIC_CONFIG, PRE_FRONTLINE_CONFIGS.redesign])("pays held-ground income for a stored config with an income interval, and replays it (%#)", recorded => {
    const before = JSON.stringify(recorded);
    expect(recorded.groundFoodIntervalTicks).toBe(600);
    const config = playable(recorded);
    const state = createMatch(7919, config);
    state.owner.fill(-1);
    // One reference tile each (2x2 fine cells at grid scale 2). Balanced ownership avoids fractional marginal taper.
    for (const [x, owner] of [[10, 0], [11, 0], [12, 1], [13, 1]] as const) for (const y of [0, 1]) state.owner[y * config.mapWidth + x] = owner;
    expect(groundIncome(state, 600)).toEqual([1, 1]);
    let played = createMatch(7919, config);
    for (let tick = 0; tick < 20; tick++) played = step(played).state;
    expect(stateHash(replay([headerLine(7919, config)], 20))).toBe(stateHash(played));
    expect(JSON.stringify(recorded)).toBe(before);
  });

  it.each([PUBLIC_CONFIG, rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))].map(playable))("teaches frontline food without held-ground or taper text (%#)", config => {
    for (const text of [briefing(config), joinBriefing(config), renderRules(config)]) {
      expect(text).toContain("Frontline food: four small mirrored patches");
      expect(text).toContain("(28,10), (35,10), (28,38), (35,38)");
      expect(text).toContain("A pair that cannot fit is omitted on both sides.");
      expect(text).not.toMatch(/Held ground|Ground income:|marginal income taper|above that half pay/);
    }
  });
});
