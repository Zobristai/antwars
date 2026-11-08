/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { summarizeMatch, summaryLines } from "./summary.js";
import { headerLine, tickLine } from "../../src/sim/log.js";
import type { SimInput } from "../../src/sim/types.js";
import { shortConfig } from "../server/helpers.js";
import { playable } from "../playable.ts";

const config = playable(shortConfig(400));

/** A match log from inputs keyed by tick. */
function log(inputs: Record<number, SimInput[]>): string[] {
  return [headerLine(42, config), ...Object.entries(inputs).map(([tick, list]) => tickLine(Number(tick), list))];
}

const join = (agentId: string): SimInput => ({ type: "join", agentId, placement: 0, modelLabel: `model-${agentId}` });
const observe = (agentId: string): SimInput => ({ type: "observe", agentId });

describe("match summary from the log", () => {
  it("counts a mark one agent laid as received when it appears in a teammate's observe view", () => {
    const s = summarizeMatch(
      log({
        0: [join("a"), join("b")],
        5: [{ type: "mark", agentId: "a", words: ["FOOD"] }],
        10: [observe("a"), observe("b")],
        30: [observe("a"), observe("b")],
      }),
    );
    const vlc = s.colonies[0];
    expect(vlc.agents).toBe(2);
    expect(vlc.marksLaid).toBe(1);
    expect(vlc.marksReceived).toBe(1);
    expect(vlc.receptionRate).toBe(1);
    expect(s.marks[0]!.receivers).toEqual([{ agentId: "b", tick: 10 }]);
    expect(s.markPassed).toBe(true);
    // Observes at ticks 10 and 30 at 10 ticks a second: a 2 s loop.
    expect(vlc.medianLoopSeconds).toBe(2);
    const a = s.agents.find((x) => x.agentId === "a")!;
    // Calls at ticks 0, 5, 10, 30: gaps 0.5, 0.5 and 2 s.
    expect(a.callGapSeconds).toEqual({ median: 0.5, p95: 0.5, gaps: 3 });
    expect(a.modelLabel).toBe("model-a");
    // The replay runs on to the match's own result.
    expect(s.ticks).toBe(400);
    expect(s.result).not.toBeNull();
    expect(s.colonies[1].marksLaid).toBe(0);
    expect(s.colonies[1].receptionRate).toBeNull();
    expect(summaryLines(s).at(-1)).toMatch(/mark pass condition met/);
  });

  it("does not count the layer's own observe, so a mark no teammate observed fails the condition", () => {
    const s = summarizeMatch(
      log({
        0: [join("a"), join("b")],
        5: [{ type: "mark", agentId: "a", words: ["FOOD"] }],
        10: [observe("a")],
      }),
    );
    expect(s.colonies[0].marksLaid).toBe(1);
    expect(s.colonies[0].marksReceived).toBe(0);
    expect(s.colonies[0].receptionRate).toBe(0);
    expect(s.markPassed).toBe(false);
  });

  it("reports each colony's ants lost in combat and the time of first contact", () => {
    const s = summarizeMatch(log({ 0: [join("a")] }));
    const fights = s.colonies.map((c) => c.firstContactSeconds);
    expect(fights[0]).toBe(fights[1]);
    expect(s.colonies.map((c) => c.antsLostInCombat).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
});
