import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_MARKERS, RULES_V4_CONFIG, RULES_VERSION, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { headerLine, parseLog } from "../../src/sim/log.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { playable } from "../playable.ts";

// Every config plays one rules generation, RULES_VERSION 27. A log header records that version, the
// generation markers and the ant115 hold behaviour; a header of any other generation is refused when read.
const CURRENT: readonly SimConfig[] = [DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig(undefined), rulesConfig("v4"),
  rulesConfig("count-marks"), rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))];
const header = (config: SimConfig) => JSON.parse(headerLine(6006, playable(config))) as Record<string, unknown> & { config: Record<string, unknown> };

describe("the one rules generation", () => {
  it("is rules 27", () => {
    expect(RULES_VERSION).toBe(27);
  });

  it.each(CURRENT)("records rules 27, its markers and ant115 holds for every current config (%#)", config => {
    for (const [key, value] of Object.entries(RULES_MARKERS)) expect((config as unknown as Record<string, unknown>)[key]).toBe(value);
    const parsed = parseLog([headerLine(6006, playable(config))]).header;
    expect(parsed).toMatchObject({ rulesVersion: 27, holdBehaviour: "ant115" });
    expect(JSON.stringify(parsed.config)).toBe(JSON.stringify(playable(config)));
  });

  it.each([undefined, "v4", "count-marks", "redesign"] as const)("records kills-first scoring explicitly for new %s matches", name => {
    const config = rulesConfig(name);
    expect(config.adjudication).toBe("kills-first");
    expect(parseLog([headerLine(6006, playable(config))]).header).toMatchObject({ rulesVersion: 27, config: { adjudication: "kills-first" } });
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
