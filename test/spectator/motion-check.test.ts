/**
 * The stills motion check's own rule (web/capture/motion.ts). Each case
 * is a window of readings, every 250 ms, as the check takes them from the page.
 *
 * Regressions caught: main 7081fbd's phone rule moved the score card up 1.94 px while a story card showed and back
 * after it, a move that returns, which a check comparing only first and last readings,
 * or allowing returns, would pass; and a feed whose lines move must only ever take new entries at one end, with no
 * line changing size or wrapping after it appears, and nothing outside the list moving.
 */
import { describe, expect, it } from "vitest";
import { motionChanges, motionProblem, type Box, type ListLine, type MotionSample } from "../../web/capture/motion.ts";

const CARD = "div.aw-overlays:1 > div.aw-top.aw-bug:3";
const FEED = "div.aw-overlays:1 > ol.aw-chat:5";

/** Readings every 250 ms for `seconds`, each from `at(ms)`. */
function windowOf(seconds: number, at: (ms: number) => MotionSample): { at: number; sample: MotionSample }[] {
  return Array.from({ length: seconds * 4 + 1 }, (_, i) => ({ at: i * 250, sample: at(i * 250) }));
}
const card = (y: number): MotionSample => ({ boxes: { [CARD]: [24, y, 345, 182.8] }, lists: {} });
const line = (id: number, y: number, h = 40, inner: Record<string, Box> = { "div.aw-chat-text:2": [12, 20, 260, 16] }): ListLine => ({ id, box: [1600, y, 280, h], inner });
const feed = (lines: ListLine[], listBox: Box = [1600, 300, 280, 600]): MotionSample => ({ boxes: { [FEED]: listBox }, lists: { [FEED]: lines } });
const failures = (samples: { at: number; sample: MotionSample }[]) => motionChanges(samples).changes.filter((c) => c.fails);

describe("motion check: boxes outside lists hold their place", () => {
  it("fails a box that moves 1.94 px and returns, at each time it leaves its place, against the window's first reading", () => {
    // The score card at y 104; up 1.94 px from +15 s to +17 s and from +38 s to +40 s, as on main 7081fbd at 393x852.
    const samples = windowOf(60, (ms) => card((ms >= 15_000 && ms < 17_000) || (ms >= 38_000 && ms < 40_000) ? 102.06 : 104));
    const found = failures(samples);
    expect(found.map((c) => [c.at, c.delta])).toEqual([[15_000, [0, -1.94, 0, 0]], [38_000, [0, -1.94, 0, 0]]]);
    expect(motionChanges(samples).max.get(CARD)).toEqual([0, -1.94, 0, 0]);
    expect(motionProblem("motion 2d-phone", found[0]!)).toBe("motion 2d-phone: div.aw-overlays:1 > div.aw-top.aw-bug:3 moved/resized by x 0, y -1.94, width 0, height 0 px at 15.00 s");
  });

  it("passes a box that stays within 1 px, and one that never moves", () => {
    expect(failures(windowOf(60, (ms) => card(ms >= 15_000 && ms < 17_000 ? 103.2 : 104)))).toEqual([]);
    expect(failures(windowOf(60, () => card(104)))).toEqual([]);
  });

  it("fails a change of size as well as of place", () => {
    const samples = windowOf(10, (ms) => ({ boxes: { [CARD]: [24, 104, 345, ms >= 5_000 ? 184.8 : 182.8] }, lists: {} }));
    expect(failures(samples).map((c) => [c.at, c.delta])).toEqual([[5_000, [0, 0, 0, 2]]]);
  });

  it("lists a box that comes or goes without failing it", () => {
    const samples = windowOf(4, (ms) => ({ boxes: { [CARD]: [24, 104, 345, 182.8], ...(ms >= 2_000 ? { "div.aw-overlays:1 > div.aw-story-card:9": [24, 600, 345, 70] as Box } : {}) }, lists: {} }));
    const { changes } = motionChanges(samples);
    expect(changes.filter((c) => c.fails)).toEqual([]);
    expect(changes.map((c) => c.kind)).toEqual(["appeared"]);
  });
});

describe("motion check: feed and list lines", () => {
  it("records lines pushed down as new entries arrive at the top, with nothing else moving", () => {
    // A new 40 px line enters at the top every 2 s; the older ones move down by its height.
    const samples = windowOf(10, (ms) => {
      const entered = Math.floor(ms / 2000) + 1;
      return feed(Array.from({ length: entered }, (_, k) => line(entered - k, 300 + 40 * k)));
    });
    const { changes } = motionChanges(samples);
    expect(changes.filter((c) => c.fails)).toEqual([]);
    expect(changes.some((c) => c.kind === "line-moved")).toBe(true);
  });

  it("records entries arriving at the bottom of a list that drops its oldest at the top", () => {
    const samples = windowOf(10, (ms) => {
      const newest = Math.floor(ms / 2000) + 3;
      return feed([newest - 2, newest - 1, newest].map((id, k) => line(id, 300 + 40 * k)));
    });
    expect(failures(samples)).toEqual([]);
  });

  it("fails a line that grows (wraps to another line) after it appeared", () => {
    const samples = windowOf(4, (ms) => feed([line(1, 300, ms >= 2_000 ? 56 : 40)]));
    expect(failures(samples).map((c) => [c.kind, c.at, c.delta])).toEqual([["line-resized", 2_000, [0, 0, 0, 16]]]);
  });

  it("fails anything that moves inside a line after it appeared", () => {
    const samples = windowOf(4, (ms) => feed([line(1, 300, 40, { "div.aw-chat-text:2": [12, ms >= 1_000 ? 22 : 20, 260, 16] })]));
    expect(failures(samples).map((c) => c.kind)).toEqual(["line-inner-moved"]);
  });

  it("fails new entries that arrive in the middle, or at the other end from before", () => {
    const middle = windowOf(4, (ms) => feed(ms >= 2_000 ? [line(1, 300), line(3, 340), line(2, 380)] : [line(1, 300), line(2, 340)]));
    expect(failures(middle).map((c) => c.kind)).toContain("line-entered-out-of-order");
    const bothEnds = windowOf(6, (ms) => feed(ms >= 4_000 ? [line(1, 300), line(2, 340), line(3, 380)] : ms >= 2_000 ? [line(2, 300), line(3, 340)] : [line(3, 300)]));
    // Entries came in at the top (2, then 1)... and here 1 arrives at the top too: fine. Now one at the bottom after that:
    expect(failures(bothEnds)).toEqual([]);
    const flipped = windowOf(6, (ms) => feed(ms >= 4_000 ? [line(1, 300), line(2, 340), line(3, 380), line(4, 420)] : ms >= 2_000 ? [line(1, 300), line(2, 340), line(3, 380)] : [line(2, 300), line(3, 340)]));
    expect(failures(flipped).map((c) => c.kind)).toContain("line-entered-out-of-order");
  });

  it("fails a line that moves with no entry arriving", () => {
    const samples = windowOf(4, (ms) => feed([line(1, ms >= 2_000 ? 310 : 300)]));
    expect(failures(samples).map((c) => c.kind)).toEqual(["line-moved"]);
  });

  it("holds the list's own box to the rule for every box", () => {
    const samples = windowOf(4, (ms) => feed([line(1, 300)], [1600, ms >= 2_000 ? 302 : 300, 280, 600]));
    expect(failures(samples).map((c) => [c.kind, c.element])).toEqual([["moved", FEED]]);
  });
});
