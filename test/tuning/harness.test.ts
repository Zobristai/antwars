// The tuning harness's statistics and profile aggregation (scripts/tuning). The commands themselves are run
// end to end against a store as documented in docs/tuning-harness.md.
import { describe, expect, it } from "vitest";
import { functionTimes, type CpuProfile } from "../../scripts/tuning/profile.ts";
import { median, noiseBar, quantile, repetitionsFor, roundGain, sideOrder } from "../../scripts/tuning/stats.ts";

describe("paired timing statistics", () => {
  it("takes the median and nearest-rank quantiles", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.99)).toBe(10);
    expect(quantile([5, 1], 0.5)).toBe(1);
  });

  it("weights each segment's tick time by its workload share", () => {
    // A 10% faster candidate on every segment gains 10%, whatever the weights.
    expect(roundGain([{ weight: 0.25, referenceMeanMs: 4, candidateMeanMs: 3.6 }, { weight: 0.75, referenceMeanMs: 10, candidateMeanMs: 9 }])).toBeCloseTo(0.1, 12);
    // Heavier segments count for more: halving the 2 ms segment saves 0.5 of the weighted 11 ms.
    expect(roundGain([{ weight: 0.5, referenceMeanMs: 2, candidateMeanMs: 1 }, { weight: 0.5, referenceMeanMs: 20, candidateMeanMs: 20 }])).toBeCloseTo(1 / 22, 12);
    expect(roundGain([{ weight: 1, referenceMeanMs: 5, candidateMeanMs: 6 }])).toBeCloseTo(-0.2, 12);
  });

  it("alternates which side runs first, by round", () => {
    expect(sideOrder(0)).toEqual(["reference", "candidate"]);
    expect(sideOrder(1)).toEqual(["candidate", "reference"]);
    expect(sideOrder(2)).toEqual(["reference", "candidate"]);
  });
});

describe("noise check", () => {
  it("reports every median, their range and the largest absolute median as the bar", () => {
    expect(noiseBar([0.01, -0.03, 0.02])).toEqual({ medians: [0.01, -0.03, 0.02], min: -0.03, max: 0.02, range: 0.05, bar: 0.03 });
  });

  it("repeats so that at least three medians exist", () => {
    expect([1, 2, 3, 4].map(n => n * repetitionsFor(n))).toEqual([3, 4, 3, 4]);
    expect(() => repetitionsFor(0)).toThrow();
  });
});

describe("profile aggregation", () => {
  // root → a → b, root → b; b recurses into b once.
  const frame = (functionName: string, line: number) => ({ functionName, url: "file:///tree/src/sim/x.ts", lineNumber: line });
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 4] },
      { id: 2, callFrame: frame("a", 0), children: [3] },
      { id: 3, callFrame: frame("b", 9), children: [5] },
      { id: 4, callFrame: frame("b", 9) },
      { id: 5, callFrame: frame("b", 9) },
    ],
    samples: [2, 3, 4, 5],
    timeDeltas: [1000, 2000, 3000, 4000],
  };

  it("charges self time to the top frame and inclusive time once per function on the stack", () => {
    const { totalMs, functions } = functionTimes(profile, "/tree/");
    const by = Object.fromEntries(functions.map(f => [f.function, f]));
    expect(totalMs).toBe(10);
    expect(by["a src/sim/x.ts:1"]).toMatchObject({ selfMs: 1, inclusiveMs: 7 });
    // b: self 2 + 3 + 4; inclusive the same 9, the recursive sample counted once.
    expect(by["b src/sim/x.ts:10"]).toMatchObject({ selfMs: 9, inclusiveMs: 9, inclusiveShare: 0.9 });
    expect(by["(root)"]).toMatchObject({ selfMs: 0, inclusiveMs: 10 });
  });
});
