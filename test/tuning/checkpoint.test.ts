// A seated Wide Plain match at 768 ants per side, saved
// mid-battle and reloaded, plays every tick exactly as the original match continuing.
import { describe, expect, it } from "vitest";
import { cloneState } from "../../src/sim/map.js";
import type { StepOutput } from "../../src/sim/types.js";
import { advanceCheckpoint, loadCheckpoint, recordCheckpoint } from "./checkpoint.js";
import { compareTicks, type TickMismatch } from "./equality.js";
import { DEFAULT_START, playToBattle, startConfig, startSeated, type SeatedMatch } from "./seated.js";

/** Record a checkpoint, keeping a copy of every tick the original match continues with. */
function recordWithContinuation(match: SeatedMatch, tapeTicks: number): { text: string; original: StepOutput[] } {
  const original: StepOutput[] = [];
  const text = recordCheckpoint(match, tapeTicks, (out) => original.push({ state: cloneState(out.state), events: out.events, results: out.results }));
  return { text, original };
}

/** Reload the checkpoint and advance it through its tape, comparing every tick with the original continuation. */
function reloadMismatches(text: string, original: readonly StepOutput[]): TickMismatch[] {
  const cp = loadCheckpoint(text);
  expect(cp.inputs).toHaveLength(original.length);
  const mismatches: TickMismatch[] = [];
  for (let i = 0; i < original.length; i++) {
    const found = compareTicks(original[i]!, advanceCheckpoint(cp, i));
    if (found !== null) mismatches.push(found);
  }
  return mismatches;
}

describe("seated mid-battle save and reload", () => {
  it("Wide Plain at 768 per side, seated under server policy: every tick after reload equals the original continuation", () => {
    expect(DEFAULT_START).toEqual({ map: "wide-plain", perSide: 768 });
    const match = startSeated({ ...DEFAULT_START, seed: 7 });
    playToBattle(match);
    const saved = match.state;
    // Mid-battle at full strength: the first death has happened, both colonies hold 768 ants, both seats joined.
    expect(saved.terrain?.mapId).toBe("wide-plain");
    expect(saved.config.colonyCap).toBe(768);
    expect(saved.stats.deaths[0] + saved.stats.deaths[1]).toBeGreaterThan(0);
    expect([0, 1].map((colony) => saved.ants.filter((a) => a.colony === colony).length)).toEqual([768, 768]);
    expect(saved.agents.map((a) => a.id).sort()).toEqual(["a0", "a1"]);
    const tick = saved.tick;

    const { text, original } = recordWithContinuation(match, 200);
    expect(original).toHaveLength(200);
    expect(original[0]!.state.tick).toBe(tick + 1);
    expect(original.some((out) => out.events.some((e) => e.type === "death"))).toBe(true);
    expect(JSON.parse(text).inputs.flat().some((input: { type: string }) => input.type === "observe")).toBe(true);
    expect(reloadMismatches(text, original)).toEqual([]);
  }, 300_000);


  it("refuses an unknown start map, text that is not a checkpoint, and a tick past the tape", () => {
    expect(() => startConfig("no-such-map", 768)).toThrow("unknown start map");
    expect(() => loadCheckpoint(JSON.stringify({ state: {}, inputs: [] }))).toThrow("checkpoint");
    const match = startSeated({ map: "wide-plain", perSide: 8, seed: 5 });
    const cp = loadCheckpoint(recordCheckpoint(match, 3));
    for (let i = 0; i < 3; i++) advanceCheckpoint(cp, i);
    expect(() => advanceCheckpoint(cp, 3)).toThrow(RangeError);
  });
});
