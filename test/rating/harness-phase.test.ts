import { describe, expect, it } from "vitest";
import { EFFORT_MISMATCH_UNTIL, HARNESS_PHASES, harnessPhaseAt, isIndexMode } from "../../src/rating/harnessPhase.ts";

const at = (iso: string) => Date.parse(iso);
const phaseAt = (ms: number) => harnessPhaseAt(ms).phase;

describe("the committed harness phase table", () => {
  it("lists the five phases oldest first, each with its start instant", () => {
    expect(HARNESS_PHASES).toEqual([
      { phase: "rounds 1-7", startsAt: null },
      { phase: "rounds 8-10", startsAt: at("2026-10-27T03:56:59Z") },
      { phase: "rounds 11-25", startsAt: at("2026-10-28T00:32:01Z") },
      { phase: "rounds 26-30", startsAt: at("2026-11-07T03:34:52Z") },
      { phase: "from the pin onward", startsAt: at("2026-11-10T03:03:46.329Z") },
    ]);
    expect(EFFORT_MISMATCH_UNTIL).toBe(at("2026-10-26T03:02:42.158Z"));
  });

  it.each([
    ["2026-10-27T03:56:59Z", "rounds 1-7", "rounds 8-10"],
    ["2026-10-28T00:32:01Z", "rounds 8-10", "rounds 11-25"],
    ["2026-11-07T03:34:52Z", "rounds 11-25", "rounds 26-30"],
    ["2026-11-10T03:03:46.329Z", "rounds 26-30", "from the pin onward"],
  ])("puts a match 1 ms before %s in %s, and one at the instant or 1 ms after in %s", (instant, before, after) => {
    expect(phaseAt(at(instant) - 1)).toBe(before);
    expect(phaseAt(at(instant))).toBe(after);
    expect(phaseAt(at(instant) + 1)).toBe(after);
  });

  it("flags a possible effort mismatch only before 2026-10-26T03:02:42.158Z", () => {
    expect(harnessPhaseAt(EFFORT_MISMATCH_UNTIL - 1).possibleEffortMismatch).toBe(true);
    expect(harnessPhaseAt(EFFORT_MISMATCH_UNTIL).possibleEffortMismatch).toBe(false);
    expect(harnessPhaseAt(EFFORT_MISMATCH_UNTIL + 1).possibleEffortMismatch).toBe(false);
    // The flagged matches are all in rounds 1-7.
    expect(harnessPhaseAt(EFFORT_MISMATCH_UNTIL - 1)).toEqual({ phase: "rounds 1-7", possibleEffortMismatch: true });
    expect(harnessPhaseAt(at("2026-11-08T12:00:00Z")).possibleEffortMismatch).toBe(false);
  });

  it("labels every match from the pin instant on as from the pin onward, with no upper bound", () => {
    expect(harnessPhaseAt(at("2026-11-10T03:03:46.329Z") - 1)).toEqual({ phase: "rounds 26-30", possibleEffortMismatch: false });
    expect(harnessPhaseAt(at("2026-11-10T03:03:46.329Z"))).toEqual({ phase: "from the pin onward", possibleEffortMismatch: false });
    expect(phaseAt(at("2027-06-01T00:00:00Z"))).toBe("from the pin onward");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("labels a match with no readable time (%s) unknown", value => {
    expect(harnessPhaseAt(value)).toEqual({ phase: "unknown", possibleEffortMismatch: null });
  });

  it("names the four index modes, and no other mode, as Model Index modes", () => {
    expect(["house-1v1", "house-2v2", "house-3v3", "house-4v4"].every(isIndexMode)).toBe(true);
    expect([null, undefined, "1v1", "2v2", "3v3", "4v4", "", "house-5v5"].some(isIndexMode)).toBe(false);
  });
});
