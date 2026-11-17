import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.ts";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { renderRules } from "../../web/rules.ts";
import { playable } from "../playable.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { startHarness, type Harness } from "./harness.ts";

const excludedWord = /\bsteer\w*\b/i;
const redesign = rulesConfig("redesign");
const variants: { name: string; config: SimConfig }[] = [
  { name: "historical word marks", config: HISTORICAL_CONFIG },
  { name: "long count marks", config: { ...rulesConfig("count-marks"), countMarks: { ...rulesConfig("count-marks").countMarks!, combatTotals: undefined } } },
  { name: "compact word and count marks", config: { ...redesign, wordMarksDisabled: undefined, patrolLinkTiles: undefined } },
  { name: "long word and count marks", config: { ...redesign, wordMarksDisabled: undefined, patrolLinkTiles: undefined, countMarks: { ...redesign.countMarks!, combatTotals: undefined } } },
  { name: "soft movement without point arrival", config: { ...redesign, pointArrival: undefined } },
  { name: "current redesign", config: redesign },
];

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });

describe("instruction vocabulary", () => {
  it("keeps the README free of the excluded word", () => {
    expect(readFileSync(new URL("../../README.md", import.meta.url), "utf8")).not.toMatch(excludedWord);
  });

  for (const { name, config: template } of variants) {
    const config = playable(template);
    it(`${name}: keeps agent briefings and visitor rules free of the excluded word`, () => {
      for (const house of [false, true]) {
        expect(briefing(config, undefined, { house })).not.toMatch(excludedWord);
        for (const nestWindow of [false, true]) {
          expect(joinBriefing(config, undefined, nestWindow, { house })).not.toMatch(excludedWord);
        }
      }
      expect(renderRules(config)).not.toMatch(excludedWord);
    });

    it(`${name}: keeps advertised tool and input descriptions free of the excluded word`, async () => {
      harness = await startHarness({ simConfig: config });
      const agent = await harness.connect();
      const { tools } = await agent.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.description, tool.name).not.toMatch(excludedWord);
        expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(excludedWord);
      }
    });
  }
});
