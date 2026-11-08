import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { PUBLIC_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { renderRules } from "../../web/rules.js";
import { lineMarksEnabled } from "../../src/sim/patrol.js";
import { playable } from "../playable.ts";

describe("carrier guidance, whatever the match type or text generation", () => {
  const configs: SimConfig[] = [PUBLIC_CONFIG, ...(["v4", "count-marks", "redesign"] as const).map(rulesConfig)].map(playable);
  for (const config of configs) for (const compact of [false, true]) {
    it(`${config.rules ?? "default"}, compact=${compact}: carriers never bite and keep delivering`, () => {
      const current: SimConfig = { ...config, countMarks: config.countMarks === undefined ? undefined
        : { ...config.countMarks, combatTotals: compact ? true : undefined } };
      for (const text of [briefing(current), renderRules(current)]) {
        expect(text).toContain("Ants carrying food do not bite enemy ants or queens.");
        expect(text).toContain("Free, squad and count-mark carriers keep delivering to a live friendly queen past enemies");
        expect(text).toContain("they never stop for combat.");
      }
      // The agent reply with count marks drops the overrun clause (it says "There is no overrun");
      // the Rules page keeps it.
      expect(briefing(current).includes("Carriers do not count toward overrunning an enemy queen.")).toBe(!lineMarksEnabled(current));
      expect(renderRules(current)).toContain("Carriers do not count toward overrunning an enemy queen.");
      expect(joinBriefing(current)).toContain("Carriers never bite ants or queens");
      const compactText = compact && config.countMarks !== undefined;
      expect(briefing(current)).toContain(compactText ? "- Combat: non-carrying ants" : "every non-carrying ant within");
      if (config.queenHp !== undefined) {
        expect(briefing(current)).toMatch(/[Nn]on-carrying ant.*with no enemy ant in reach/);
        expect(renderRules(current)).toContain("A non-carrying ant with no enemy ant in reach");
      }
    });
  }
});
