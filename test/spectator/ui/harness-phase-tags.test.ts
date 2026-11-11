// A Model Index match's harness phase as the Matches page and the replay word it (web/src/ui/format.ts, web/src/replay.ts).
import { describe, expect, it } from "vitest";
import { OUTSIDE_INDEX, PHASE_UNKNOWN, harnessPhaseTags, liveRow, phaseDividers, recordingRow } from "../../../web/src/ui/format.ts";
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

  describe("a list draws a divider where its rows' phase changes", () => {
    const r31 = ["Harness from round 31 onward"], r26 = ["Harness: rounds 26-30"];
    const flagged = ["Harness: rounds 1-7", "Possible effort mismatch"], unflagged = ["Harness: rounds 1-7"];
    // A divider as read: its words with each tag's no-break spaces and word joiners undone, "(outside)" marking the
    // divider over matches outside the Index.
    const read = (dividers: ReturnType<typeof phaseDividers>) =>
      dividers.map(d => d === null ? null : `${d.text.replace(/ /g, " ").replace(/-⁠/g, "-")}${d.outside ? " (outside)" : ""}`);
    const outside = `${OUTSIDE_INDEX} (outside)`;

    it("draws one before the first row of each phase, the older phases and the effort flag included, and none on a row", () => {
      expect(read(phaseDividers([r31, r31, r26, r26, unflagged, flagged, flagged]))).toEqual([
        "Harness from round 31 onward", null, "Harness: rounds 26-30", null, "Harness: rounds 1-7", "Harness: rounds 1-7 · Possible effort mismatch", null,
      ]);
    });

    it("holds each tag whole, so a divider breaks only between tags", () => {
      expect(phaseDividers([flagged])).toEqual([{ text: "Harness: rounds 1-⁠7 · Possible effort mismatch", outside: false }]);
    });

    it("ends a phase's divider over matches outside the Index, so none takes a phase, and draws the phase's again where its rows resume", () => {
      // As in the production listing: Index rows of rounds 26-30 interleaved with Challenge rows.
      expect(read(phaseDividers([r31, "outside", "outside", r26, "outside", r26, r26]))).toEqual([
        "Harness from round 31 onward", outside, null, "Harness: rounds 26-30", outside, "Harness: rounds 26-30", null,
      ]);
      // At the list's top no divider claims a phase, so matches outside the Index there need nothing said.
      expect(read(phaseDividers(["outside", "outside", r31]))).toEqual([null, null, "Harness from round 31 onward"]);
    });

    it("ends a phase's divider over a row whose phase the page cannot name, and draws the phase's again after it", () => {
      // A recording of unknown kind between two flagged Index rows, as in the production listing.
      expect(read(phaseDividers([flagged, "unknown", flagged]))).toEqual(["Harness: rounds 1-7 · Possible effort mismatch", PHASE_UNKNOWN, "Harness: rounds 1-7 · Possible effort mismatch"]);
      // Several in a row share one divider; one outside the Index after them has its own.
      expect(read(phaseDividers([r26, "unknown", "unknown", "outside", r26]))).toEqual(["Harness: rounds 26-30", PHASE_UNKNOWN, null, outside, "Harness: rounds 26-30"]);
      // The unknown phase's own words: the server's unknown phase and a row the page cannot read share one divider.
      expect(PHASE_UNKNOWN).toBe("Harness phase unknown");
      expect(read(phaseDividers([r31, ["Harness phase unknown"], "unknown"]))).toEqual(["Harness from round 31 onward", PHASE_UNKNOWN, null]);
      expect(phaseDividers(["unknown", "outside"])).toEqual([null, null]);
    });

    it("adds dividers for older rows loaded later without moving any already drawn", () => {
      const first = phaseDividers([r31, "outside", r31]);
      const more = phaseDividers([r31, "outside", r31, "outside", r26, r26]);
      expect(more.slice(0, 3)).toEqual(first);
      expect(read(more.slice(3))).toEqual([outside, "Harness: rounds 26-30", null]);
    });

    it("draws none for a list with no phase", () => {
      expect(phaseDividers(["outside", "outside"])).toEqual([null, null]);
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
