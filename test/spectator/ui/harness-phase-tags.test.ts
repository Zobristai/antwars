// A Model Index match's harness phase as the Matches page and the replay word it (web/src/ui/format.ts, web/src/replay.ts).
import { describe, expect, it } from "vitest";
import { OUTSIDE_INDEX, harnessPhaseTags, liveRow, phaseDividers, recordingRow } from "../../../web/src/ui/format.ts";
import { harnessPhase } from "../../../web/src/matches-page/data.ts";
import { detailWithoutPhase, modeCopy } from "../../../web/src/replay.ts";
import type { LiveMatch, Recording } from "../../../web/src/matches-page/data.ts";

const phase = (name: string, possibleEffortMismatch: boolean | null = false) =>
  ({ phase: name, possibleEffortMismatch }) as NonNullable<Recording["harnessPhase"]>;

describe("harness phase tags", () => {
  it("words each phase and adds the effort flag where set", () => {
    expect(harnessPhaseTags(phase("rounds 1-7", true))).toEqual(["Harness: rounds 1-7", "Possible effort mismatch"]);
    expect(harnessPhaseTags(phase("rounds 8-10"))).toEqual(["Harness: rounds 8-10"]);
    expect(harnessPhaseTags(phase("rounds 11-25"))).toEqual(["Harness: rounds 11-25"]);
    expect(harnessPhaseTags(phase("rounds 26-30"))).toEqual(["Harness: rounds 26-30"]);
    expect(harnessPhaseTags(phase("from the pin onward"))).toEqual(["Harness from the pin onward"]);
    expect(harnessPhaseTags(phase("from round 31 onward"))).toEqual(["Harness from round 31 onward"]);
    expect(harnessPhaseTags(phase("unknown", null))).toEqual(["Harness phase unknown"]);
  });

  it("shows none for a match with no phase", () => {
    expect(harnessPhaseTags(null)).toEqual([]);
    expect(harnessPhaseTags(undefined)).toEqual([]);
  });

  it("reads a phase the page does not know as none, never failing the page", () => {
    expect(harnessPhase.parse(undefined)).toBeUndefined();
    expect(harnessPhase.parse({ phase: "rounds 31-40", possibleEffortMismatch: false })).toBeNull();
    expect(harnessPhase.parse({ phase: "from round 31 onward", possibleEffortMismatch: false }))
      .toEqual({ phase: "from round 31 onward", possibleEffortMismatch: false });
    expect(harnessPhase.parse({ phase: "rounds 8-10", possibleEffortMismatch: false }))
      .toEqual({ phase: "rounds 8-10", possibleEffortMismatch: false });
  });

  it("carries the tags on Recordings and Live now rows", () => {
    const base: Recording = { id: "2026-11-07T07-47-08-869Z-1", startedAt: "2026-11-07T07:47:08.869Z", endedAt: null, simulationEndedAt: null,
      winner: 0, reason: "queens_killed", decidedBy: null, seats: [], status: "complete", unavailable: [] };
    expect(recordingRow({ ...base, harnessPhase: phase("rounds 26-30") }, "").phase).toEqual(["Harness: rounds 26-30"]);
    expect(recordingRow(base, "").phase).toEqual([]);
    const live: LiveMatch = { lobbyId: "l", startedAt: Date.parse("2026-11-10T02:00:00Z"), rated: true, delaySeconds: 300, colonies: [[], []] };
    expect(liveRow({ ...live, harnessPhase: phase("from the pin onward") }, "").phase).toEqual(["Harness from the pin onward"]);
    expect(liveRow(live, "").phase).toEqual([]);
  });

  describe("a list draws a divider where its phase changes", () => {
    const r31 = ["Harness from round 31 onward"], r26 = ["Harness: rounds 26-30"];
    const flagged = ["Harness: rounds 1-7", "Possible effort mismatch"], unflagged = ["Harness: rounds 1-7"];
    // A divider's text as read: each tag is held whole with no-break spaces and a word joiner after each hyphen.
    const read = (dividers: (string | null)[]) => dividers.map(text => text?.replace(/ /g, " ").replace(/-⁠/g, "-") ?? null);

    it("draws one before the first row of each phase, the older phases and the effort flag included, and none on a row", () => {
      // Recordings, newest first: rows with no phase (another kind of match, by its badge) stand under the divider above.
      expect(read(phaseDividers([null, r31, null, r31, r26, null, r26, unflagged, flagged, flagged]))).toEqual([
        null, "Harness from round 31 onward", null, null, "Harness: rounds 26-30", null, null, "Harness: rounds 1-7",
        "Harness: rounds 1-7 · Possible effort mismatch", null,
      ]);
    });

    it("holds each tag whole, so a divider breaks only between tags", () => {
      expect(phaseDividers([flagged])).toEqual(["Harness: rounds 1-⁠7 · Possible effort mismatch"]);
    });

    it("adds dividers for older rows loaded later without moving any already drawn", () => {
      const first = phaseDividers([r31, null, r31]);
      expect(phaseDividers([r31, null, r31, null, r26, r26]).slice(0, 3)).toEqual(first);
      expect(read(phaseDividers([r31, null, r31, null, r26, r26]).slice(3))).toEqual([null, "Harness: rounds 26-30", null]);
    });

    it("ends a phase's divider over a Live now match outside the Index, and says nothing where no phase is above it", () => {
      expect(read(phaseDividers([r31, [], [], r31]))).toEqual(["Harness from round 31 onward", OUTSIDE_INDEX, null, "Harness from round 31 onward"]);
      expect(phaseDividers([[], [], null])).toEqual([null, null, null]);
      expect(read(phaseDividers([[], r31]))).toEqual([null, "Harness from round 31 onward"]);
    });

    it("draws none for a list with no phase", () => {
      expect(phaseDividers([null, null])).toEqual([null, null]);
      expect(phaseDividers([])).toEqual([]);
    });
  });

  it("follows a replay's date on its mode line, and leaves the line as it was without one", () => {
    const id = "2026-10-26T01-38-33-692Z-1";
    const tags = ["Harness: rounds 1-7", "Possible effort mismatch"];
    // Each tag holds together: no-break spaces, and a word joiner after its hyphen.
    const whole = "Harness:\u00a0rounds\u00a01-\u20607 · Possible\u00a0effort\u00a0mismatch";
    expect(modeCopy("replay", 2, false, "/", id, true, undefined, tags).detail).toBe(`26 Oct 2026 · ${whole}`);
    expect(modeCopy("replay", 2, true, "/", id, true, undefined, tags).detail).toBe(`· recording ended · ${whole}`);
    expect(modeCopy("replay", 2, false, "/", id, true, undefined, [])).toEqual(modeCopy("replay", 2, false, "/", id, true));
  });

  it("gives the phase apart, so a HUD can show it as a part of its own after the date", () => {
    const id = "2026-10-26T01-38-33-692Z-1";
    const whole = "Harness: rounds 1-⁠7 · Possible effort mismatch";
    const line = modeCopy("replay", 2, false, "/", id, true, undefined, ["Harness: rounds 1-7", "Possible effort mismatch"]);
    expect(line.phase).toBe(whole);
    expect(detailWithoutPhase(line)).toBe("26 Oct 2026");
    expect(detailWithoutPhase(modeCopy("replay", 2, true, "/", id, true, undefined, ["Harness: rounds 26-30"]))).toBe("· recording ended");
    // With no date, the detail is the phase alone.
    expect(detailWithoutPhase(modeCopy("replay", 2, false, "/", null, true, undefined, ["Harness: rounds 26-30"]))).toBe("");
    // A line with no phase has none apart, and its detail stays whole.
    const plain = modeCopy("replay", 2, false, "/", id, true);
    expect("phase" in plain).toBe(false);
    expect(detailWithoutPhase(plain)).toBe("26 Oct 2026");
  });
});
