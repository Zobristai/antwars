import { describe, expect, it } from "vitest";
import { labelFixtures, labelProblems, type LabelFit } from "../../../web/capture/free-for-all-labels.ts";

const fit: LabelFit = { text: "Free-for-all", lines: 1, clipped: false, overlap: false };

describe("mode-label browser diagnostic", () => {
  it("feeds the unchanged mode id through waiting, live and recorded inputs", () => {
    const fixtures = labelFixtures();
    expect(fixtures.queue.waiting[0]!.mode).toBe("quadrants");
    expect(fixtures.queue.lobbies[0]!.mode).toBe("quadrants");
    expect(fixtures.catalog.matches[0]!.matchType).toEqual({ kind: "quadrants", size: 1 });
    expect(fixtures.history.matches[0]!.matchType).toEqual({ kind: "quadrants", size: 1 });
    expect(fixtures.history.matches[0]!.seats.map(s => s.colony)).toEqual([0, 1, 2, 3]);
  });
  it("rejects missing, stale, wrapped, clipped or overlapping labels", () => {
    expect(labelProblems([fit], "Free-for-all")).toEqual([]);
    expect(labelProblems([], "Free-for-all")).toEqual(["No visible mode labels"]);
    for (const change of [{ text: "Quadrants" }, { lines: 2 }, { clipped: true }, { overlap: true }]) {
      expect(labelProblems([{ ...fit, ...change }], "Free-for-all")).toHaveLength(1);
    }
    expect(labelProblems([{ ...fit, text: "Quadrants" }], "Quadrants")).toEqual([]);
  });
});
