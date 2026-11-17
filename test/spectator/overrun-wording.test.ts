import { describe, expect, it } from "vitest";
import { joinBriefing } from "../../src/mcp/briefing.js";
import { PUBLIC_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { renderRules, ruleSections } from "../../web/rules.js";
import { playable } from "../playable.ts";

// Under queen HP overrun is never evaluated, so neither the Rules page nor the agent briefing may name it as a way
// to end a match or as something carriers affect. Rule sets with overrun keep their text exactly.
const line = (config: SimConfig, title: string, start: string) => {
  const found = ruleSections(config).find(section => section.title === title)!.lines.find(text => text.startsWith(start));
  expect(found).toBeDefined();
  return found!;
};
const howToWin = (config: SimConfig) => line(config, "How to win", "At ");
const winning = (config: SimConfig) => line(config, "Winning", "A match lasts");
const carriers = (config: SimConfig) => line(config, "Food and hatching", "Ants carrying food");
const briefingWin = (config: SimConfig, compact: boolean) => {
  const current: SimConfig = { ...config, countMarks: config.countMarks === undefined ? undefined : { ...config.countMarks, combatTotals: compact ? true : undefined } };
  return joinBriefing(current).split("\n").find(text => text.startsWith("How to win:"))!;
};

const CARRIERS = "Ants carrying food do not bite enemy ants or queens. Free, squad and count-mark carriers keep delivering to a live friendly queen past enemies, regardless of orders or marks; they never stop for combat.";
const CARRIERS_OVERRUN = `${CARRIERS} Carriers do not count toward overrunning an enemy queen.`;

describe("historical rules (queen HP)", () => {
  const config = playable({ ...rulesConfig("redesign"), queenKillsFirst: undefined });
  it("states the same-tick ending as queens killed on the Rules page", () => {
    expect(howToWin(config)).toBe("At 30 minutes, or if both colonies lose their last queen on the same tick (queens killed), more kills wins. Ties go to territory, then living ants, then food delivered; if still equal, the match is a draw. Kills count enemy ants killed by the colony, including queen strikes.");
    expect(winning(config)).toBe("A match lasts 30 minutes. Kill every enemy queen to win before time-up, or meet the sustained-territory early-win condition described in Battle balance. At time-up, or if both colonies lose their last queen on the same tick (queens killed), the colony with more kills wins; ties go to more territory, then more living ants, then more food delivered, else a draw.");
  });
  it("gives carriers no overrun effect and keeps There is no overrun", () => {
    expect(carriers(config)).toBe(CARRIERS);
    const html = renderRules(config);
    expect(html).not.toContain("double overrun");
    expect(html).not.toContain("overrunning");
    expect(html).toContain("There is no overrun.");
  });
  for (const compact of [false, true]) it(`states no overrun win in the agent briefing, compact=${compact}`, () => {
    expect(briefingWin(config, compact)).toContain("both last queens lost on the same tick (queens killed):");
    expect(briefingWin(config, compact)).not.toContain("overrun");
  });
});

describe("rule sets with overrun keep their text", () => {
  for (const name of [undefined, "v4", "count-marks"] as const) {
    const config = playable({ ...(name === undefined ? PUBLIC_CONFIG : rulesConfig(name)), queenKillsFirst: undefined });
    it(`${name ?? "default"}`, () => {
      expect(howToWin(config)).toBe("At 30 minutes, or if both colonies lose their last queen on the same tick (double overrun or queens killed), more kills wins. Ties go to territory, then living ants, then food delivered; if still equal, the match is a draw. Kills count enemy ants killed by the colony, including queen bites.");
      expect(winning(config)).toBe("A match lasts 30 minutes. Overrun every enemy queen to win before time-up. At time-up, or if both colonies lose their last queen on the same tick (double overrun or queens killed), the colony with more kills wins; ties go to more territory, then more living ants, then more food delivered, else a draw.");
      expect(carriers(config)).toBe(CARRIERS_OVERRUN);
      for (const compact of [false, true]) expect(briefingWin(config, compact)).toBe("How to win: Queen overrun: hold an enemy majority at every enemy nest; time-up or both last queens lost on the same tick (double overrun/queens killed): kills, territory, ants alive, delivered food, else draw. Kills = enemy ant deaths, including queen bites.");
    });
  }
});


describe("new queen-first scoring", () => {
  for (const hp of [false, true]) it(`describes the new order without inventing an overrun in HP mode: ${hp}`, () => {
    const config = playable(hp ? rulesConfig("redesign") : PUBLIC_CONFIG);
    const ending = hp ? "queens killed" : "double overrun or queens killed";
    const exclusions = hp ? "elimination removals" : "uncredited overruns and elimination removals";
    const order = `Queen kills decide first; on equal queen kills, kills, then territory, living ants and food delivered decide, else a draw. Queen kills go to the colony whose hit takes the queen to zero HP; ${exclusions} count for no one.`;
    expect(howToWin(config)).toBe(`At 30 minutes, or if both colonies lose their last queen on the same tick (${ending}): ${order}`);
    expect(winning(config)).toBe(`A match lasts 30 minutes. ${hp ? "Kill every enemy queen" : "Overrun every enemy queen"} to win before time-up${hp ? ", or meet the sustained-territory early-win condition described in Battle balance" : ""}. At time-up, or if both colonies lose their last queen on the same tick (${ending}): ${order}`);
    expect(carriers(config)).toBe(hp ? CARRIERS : CARRIERS_OVERRUN);
    for (const compact of [false, true]) {
      expect(briefingWin(config, compact)).toBe(`How to win: ${hp ? "kill every enemy queen" : "Queen overrun: hold an enemy majority at every enemy nest"}; time-up or both last queens lost on the same tick (${hp ? "queens killed" : "double overrun/queens killed"}): queen kills, kills, territory, ants alive, food delivered, draw. Queen kills: the colony whose hit takes a queen to zero HP gets one; ${exclusions} count for no one. Kills = enemy ant deaths, including queen ${hp ? "strikes" : "bites"}.`);
      if (hp) expect(briefingWin(config, compact)).not.toContain("overrun");
    }
    if (hp) {
      expect(renderRules(config)).not.toContain("double overrun");
      expect(renderRules(config)).not.toContain("overrunning");
      expect(renderRules(config)).toContain("There is no overrun.");
    }
  });
});
