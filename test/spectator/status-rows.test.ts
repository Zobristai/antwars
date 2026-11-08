/**
 * The empty-server scene's status-row check (web/capture/empty-server.ts statusRowProblems), against the HUD's visible
 * status line: the 2D board's mode label, date and Back to live, and the deck's legend and Back to live.
 * Regression caught: an iPhone showed a recording's status line with its
 * items over one another; a check that only looked at control centres would pass them.
 */
import { describe, expect, it } from "vitest";
import { statusRowProblems, type Rect, type StatusRows } from "../../web/capture/empty-server.ts";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });
const screen = r(0, 0, 390, 844);

/** The 2D board's recording state at 390x844: the mode label and date on one line, Back to live under them. */
const recording2d: StatusRows = {
  label: [r(8, 644, 236, 16)],
  date: [r(260, 644, 79, 16)],
  dateText: "21 Oct 2026",
  dateInLine: false,
  back: [r(8, 662, 86, 44)],
  backUncovered: true,
  screen,
};

/** The deck's recording state at 390x844: the legend's words wrap onto a second line, which Back to live ends. */
const recordingDeck: StatusRows = {
  label: [r(30, 45, 71, 14), r(101, 45, 222, 14), r(14, 61, 40, 14)],
  date: null,
  dateText: "21 Oct 2026",
  dateInLine: true,
  back: [r(56, 61, 86, 14)],
  backUncovered: true,
  screen,
};

describe("status rows: the mode line, the date and Back to live", () => {
  it("passes the visible line, idle and recording, on both boards", () => {
    expect(statusRowProblems(recording2d, true)).toEqual([]);
    expect(statusRowProblems({ ...recording2d, label: [r(8, 618, 330, 16)], back: null, backUncovered: null }, false)).toEqual([]);
    expect(statusRowProblems(recordingDeck, true)).toEqual([]);
    expect(statusRowProblems({ ...recordingDeck, back: null, backUncovered: null }, false)).toEqual([]);
  });

  it("fails Back to live covered at its centre", () => {
    expect(statusRowProblems({ ...recording2d, backUncovered: false }, true)).toEqual(["Back to live is covered at its centre"]);
  });

  it("fails a recording without its date or Back to live, and an idle line with Back to live", () => {
    expect(statusRowProblems({ ...recording2d, date: null, dateText: "", back: null, backUncovered: null }, true)).toEqual(['no date line (it reads "")', "no Back to live"]);
    expect(statusRowProblems({ ...recording2d, dateText: "— Recorded match, 15 Oct 2026" }, true)).toEqual(['no date line (it reads "— Recorded match, 15 Oct 2026")']);
    // A date cut to no width is not laid out.
    expect(statusRowProblems({ ...recording2d, date: null }, true)).toEqual(['no date line (it reads "21 Oct 2026")']);
    expect(statusRowProblems(recording2d, false)).toEqual(["the idle line shows Back to live"]);
  });

  it("fails an item off the screen", () => {
    expect(statusRowProblems({ ...recording2d, back: [r(330, 662, 86, 44)] }, true)).toEqual(["Back to live is not whole on screen"]);
  });

  it("fails items over one another, judged line by line", () => {
    expect(statusRowProblems({ ...recording2d, date: [r(200, 644, 79, 16)] }, true)).toEqual(["the mode line overlaps the date"]);
    expect(statusRowProblems({ ...recordingDeck, back: [r(20, 61, 86, 14)] }, true)).toEqual(["the mode line overlaps Back to live"]);
  });
});
