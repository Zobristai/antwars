// A Model Index match's harness phase as the Matches page and the replay word it (web/src/ui/format.ts, web/src/replay.ts).
import { describe, expect, it } from "vitest";
import { harnessPhaseTags, liveRow, recordingRow } from "../../../web/src/ui/format.ts";
import { harnessPhase } from "../../../web/src/matches-page/data.ts";
import { modeCopy } from "../../../web/src/replay.ts";
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

  it("follows a replay's date on its mode line, and leaves the line as it was without one", () => {
    const id = "2026-10-26T01-38-33-692Z-1";
    const tags = ["Harness: rounds 1-7", "Possible effort mismatch"];
    expect(modeCopy("replay", 2, false, "/", id, true, undefined, tags).detail).toBe("26 Oct 2026 · Harness: rounds 1-7 · Possible effort mismatch");
    expect(modeCopy("replay", 2, true, "/", id, true, undefined, tags).detail).toBe("· recording ended · Harness: rounds 1-7 · Possible effort mismatch");
    expect(modeCopy("replay", 2, false, "/", id, true, undefined, [])).toEqual(modeCopy("replay", 2, false, "/", id, true));
  });
});
