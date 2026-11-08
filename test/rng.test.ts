import { describe, expect, it } from "vitest";
import { createRng } from "../src/sim/rng.js";

function take(seed: number, count: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.next());
}

describe("createRng", () => {
  it("yields the same sequence for the same seed", () => {
    expect(take(42, 100)).toEqual(take(42, 100));
  });

  it("yields different sequences for different seeds", () => {
    expect(take(1, 10)).not.toEqual(take(2, 10));
  });

  it("keeps every value in [0, 1)", () => {
    for (const value of take(7, 10_000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
