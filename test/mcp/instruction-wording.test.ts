import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.ts";
import { packMarks, unpackMarks } from "../../src/mcp/markTable.ts";
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

  it.each([true, false])("identifies the squad-following field in actual observations (compact: %s)", async compact => {
    const config = playable({ ...rulesConfig("count-marks"), patrolLinkTiles: undefined,
      countMarks: { ...rulesConfig("count-marks").countMarks!, combatTotals: compact ? true : undefined } });
    harness = await startHarness({ simConfig: config });
    const agent = await harness.connect();
    expect((await agent.call("join")).isError).toBe(false);
    const rules = (await agent.call("rules")).data.rules as string;
    expect(rules).toContain("In each myMarks entry, the only field whose name starts with s counts squad ants following word marks; claimed counts ants answering a count mark.");
    expect(rules).not.toMatch(excludedWord);
    expect((await agent.call("order", { kind: "follow_trail", mark: { words: ["HOLD"] } })).isError).toBe(false);
    const wordView = (await agent.call("observe")).data.view;
    harness.advance(config.commandFloorTicks);
    expect((await agent.call("count_mark", { verb: "GATHER", count: 1 })).isError).toBe(false);
    const mixedView = (await agent.call("observe")).data.view;
    for (const view of [wordView, mixedView]) {
      const entries = unpackMarks(view.myMarks);
      expect(entries.length).toBeGreaterThan(0);
      // The prose's selector identifies exactly the same key before/after wire compaction.
      for (const marks of [entries, unpackMarks(packMarks(entries))]) for (const mark of marks) {
        const keys = Object.keys(mark).filter(key => key.startsWith("s"));
        expect(keys).toEqual(["steering"]);
        expect(mark[keys[0]!]).toBe(mark.verb === undefined ? view.squad.length : 0);
        if (mark.verb !== undefined) expect(mark.claimed).toEqual(expect.any(Number));
      }
    }
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
