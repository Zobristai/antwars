import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, FLYER_RULES, PUBLIC_CONFIG, RULES_MARKERS, RULES_V4_CONFIG, RULES28_VERSION, RULES_VERSION, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { headerLine, parseLog } from "../../src/sim/log.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { playable } from "../playable.ts";
import { rules27Redesign } from "../rules27.ts";

// The served redesign config plays rules 28 (RULES28_VERSION); every other config plays RULES_VERSION 27. A log header
// records that version, the generation markers and the ant115 hold behaviour; a header of any other generation is refused when read.
const CURRENT: readonly SimConfig[] = [DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig(undefined), rulesConfig("v4"),
  rulesConfig("count-marks"), rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))];
const header = (config: SimConfig) => JSON.parse(headerLine(6006, playable(config))) as Record<string, unknown> & { config: Record<string, unknown> };

describe("the rules generations", () => {
  it("are rules 27 and rules 28", () => {
    expect(RULES_VERSION).toBe(27);
    expect(RULES28_VERSION).toBe(28);
  });

  it.each(CURRENT)("records its rules version (28 for the served redesign, else 27), its markers and ant115 holds for every current config (%#)", config => {
    for (const [key, value] of Object.entries(RULES_MARKERS)) expect((config as unknown as Record<string, unknown>)[key]).toBe(value);
    const parsed = parseLog([headerLine(6006, playable(config))]).header;
    expect(parsed).toMatchObject({ rulesVersion: config.rules28 === true ? 28 : 27, holdBehaviour: "ant115" });
    expect(JSON.stringify(parsed.config)).toBe(JSON.stringify(playable(config)));
  });

  it.each([undefined, "v4", "count-marks", "redesign"] as const)("records kills-first scoring explicitly for new %s matches", name => {
    const config = rulesConfig(name);
    expect(config.adjudication).toBe("kills-first");
    expect(config.queenKillsFirst).toBe(true);
    expect(parseLog([headerLine(6006, playable(config))]).header).toMatchObject({ rulesVersion: name === "redesign" ? 28 : 27, config: { adjudication: "kills-first", queenKillsFirst: true } });
  });

  it("the served redesign differs from the rules-27 redesign only in unit figures, hatch rate, flyers, scoring, count-mark renewal and the rules-28 marker", () => {
    const now = rulesConfig("redesign") as unknown as Record<string, unknown>, before = rules27Redesign() as unknown as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(now), ...Object.keys(before)])].filter(key => JSON.stringify(now[key]) !== JSON.stringify(before[key])).sort();
    expect(changed).toEqual(["antHp", "castes", "countMarks", "flyers", "hatchCost", "hatchRate", "hatchTiming", "queenHp", "queenKillsFirst", "rules28"]);
    expect(now).toMatchObject({ rules28: true, antHp: 2000, hatchCost: 2, hatchRate: { foodPerSecond: 2 }, flyers: FLYER_RULES,
      castes: { soldierCost: 6, soldierHpPermille: 5000, soldierDamagePermille: 3000 } });
    expect(before.countMarks).not.toHaveProperty("renewOnRelay");
    expect(now.countMarks).toEqual({ ...rules27Redesign().countMarks, renewOnRelay: true });
    expect(now.hatchTiming).toBeUndefined();
    const { biteDamage: _bite, biteIntervalTicks: _interval, ...kept } = (before.queenHp as Record<string, number>);
    expect(now.queenHp).toEqual({ ...kept, hp: 100_000, damagePerSecond: 10_000 });
  });

  it("refuses a log header of another rules version", () => {
    for (const rulesVersion of [3, 25, 26, 28]) {
      expect(() => parseLog([JSON.stringify({ ...header(PUBLIC_CONFIG), rulesVersion })])).toThrow(/rules version/);
    }
  });

  it.each(Object.keys(RULES_MARKERS))("refuses a log header whose config lacks %s", key => {
    const { [key]: _removed, ...config } = header(PUBLIC_CONFIG).config;
    expect(() => parseLog([JSON.stringify({ ...header(PUBLIC_CONFIG), config })])).toThrow(new RegExp(`markers: ${key}`));
  });

  it("refuses a log header without the ant115 hold behaviour", () => {
    const { holdBehaviour: _holds, ...unmarked } = header(PUBLIC_CONFIG);
    expect(() => parseLog([JSON.stringify(unmarked)])).toThrow(/holdBehaviour must be ant115/);
    for (const holdBehaviour of ["legacy", "ant105"]) {
      expect(() => parseLog([JSON.stringify({ ...header(PUBLIC_CONFIG), holdBehaviour })])).toThrow(/holdBehaviour must be ant115/);
    }
  });
});
