import { describe, expect, it } from "vitest";
import { EFFORT_MISMATCH_UNTIL, HARNESS_PHASES, ROUND_30_CLOSED_AT, harnessPhaseAt, isIndexMode, type HarnessPhaseRow } from "../../src/rating/harnessPhase.ts";

const at = (iso: string) => Date.parse(iso);
const phaseAt = (ms: number) => harnessPhaseAt(ms).phase;

describe("the committed harness phase table", () => {
  it("lists the five phases oldest first, the from-the-pin-onward start left open", () => {
    expect(HARNESS_PHASES).toEqual([
      { phase: "rounds 1-7", startsAt: null },
      { phase: "rounds 8-10", startsAt: at("2026-10-27T03:56:59Z") },
      { phase: "rounds 11-25", startsAt: at("2026-10-28T00:32:01Z") },
      { phase: "rounds 26-30", startsAt: at("2026-11-07T03:34:52Z") },
      { phase: "from the pin onward", startsAt: null },
    ]);
    expect(ROUND_30_CLOSED_AT).toBe(at("2026-11-09T06:26:00Z"));
    expect(EFFORT_MISMATCH_UNTIL).toBe(at("2026-10-26T03:02:42.158Z"));
  });

  it.each([
    ["2026-10-27T03:56:59Z", "rounds 1-7", "rounds 8-10"],
    ["2026-10-28T00:32:01Z", "rounds 8-10", "rounds 11-25"],
    ["2026-11-07T03:34:52Z", "rounds 11-25", "rounds 26-30"],
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
    expect(harnessPhaseAt(EFFORT_MISMATCH_UNTIL - 1)).toEqual({ phase: "rounds 1-7", possibleEffortMismatch: true, pinBoundaryOpen: false });
    expect(harnessPhaseAt(at("2026-11-08T12:00:00Z")).possibleEffortMismatch).toBe(false);
  });

  it("labels a match after round 30 as rounds 26-30 with the open pin boundary noted, while the pin start is not set", () => {
    expect(harnessPhaseAt(ROUND_30_CLOSED_AT - 1)).toEqual({ phase: "rounds 26-30", possibleEffortMismatch: false, pinBoundaryOpen: false });
    expect(harnessPhaseAt(ROUND_30_CLOSED_AT)).toEqual({ phase: "rounds 26-30", possibleEffortMismatch: false, pinBoundaryOpen: true });
    expect(harnessPhaseAt(ROUND_30_CLOSED_AT + 1).pinBoundaryOpen).toBe(true);
    expect(harnessPhaseAt(at("2026-11-07T03:34:52Z")).pinBoundaryOpen).toBe(false);
  });

  it("starts from the pin onward at its instant once that start is set, with no open-boundary note", () => {
    const pin = at("2026-11-12T00:00:00Z");
    const table: HarnessPhaseRow[] = HARNESS_PHASES.map(row => row.phase === "from the pin onward" ? { ...row, startsAt: pin } : row);
    expect(harnessPhaseAt(pin - 1, table)).toEqual({ phase: "rounds 26-30", possibleEffortMismatch: false, pinBoundaryOpen: false });
    expect(harnessPhaseAt(pin, table)).toEqual({ phase: "from the pin onward", possibleEffortMismatch: false, pinBoundaryOpen: false });
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("labels a match with no readable time (%s) unknown", value => {
    expect(harnessPhaseAt(value)).toEqual({ phase: "unknown", possibleEffortMismatch: null, pinBoundaryOpen: false });
  });

  it("names the four index modes, and no other mode, as Model Index modes", () => {
    expect(["house-1v1", "house-2v2", "house-3v3", "house-4v4"].every(isIndexMode)).toBe(true);
    expect([null, undefined, "1v1", "2v2", "3v3", "4v4", "", "house-5v5"].some(isIndexMode)).toBe(false);
  });
});
