/** Reduced loading, no-agent and fall scope. Stage/queen framing is covered elsewhere. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, streamQueens } from "../../src/live/format.ts";
import { QUEENS_FIXTURE_COUNTS, firstImpressionFixture, queensFixture } from "../../web/capture/stills.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("the no-agent first-impression fixture", () => {
  it("uses real wire decoding and remains a stable no-agent match without founding events", () => {
    const messages = firstImpressionFixture().map((m) => decodeMessage(encodeMessage(m)));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.events).toEqual([]);
    const playback = new Playback();
    playback.push(messages[0]!, 0);
    const frame = new Frame();
    for (const elapsed of [0, 1000]) {
      expect(playback.sample(RENDER_DELAY_MS + elapsed, frame)).toBe(true);
      expect(frame.board!.agents).toEqual([]);
      expect(streamQueens(frame.board!)).toHaveLength(2);
      expect(frame.board!.result).toBeNull();
    }
  });

  it("saves completed scenes before normal actions and continues after viewport failures", () => {
    const src = source("web/capture/stills.ts");
    const capture = src.slice(src.indexOf("async function captureFirstImpression("), src.indexOf("/** A recording's messages"));
    expect(capture).toContain("scenes: Scene[]): Promise<void>");
    expect(capture).toContain("catch (e)");
    expect(capture).toContain("await settleFirstImpression(c)");
    expect(capture).not.toContain("force: true");
    expect(capture).not.toContain("founding:");
    expect(src).toContain("await c.advance(16)");
    expect(src).toContain("first-impression layout did not settle");
  });
});

describe("first-view wiring", () => {
  it("frames the fight lane at load and preserves current viewer rotation for the fall", () => {
    for (const file of ["main.ts", "board3d/main3d.ts"]) {
      const src = source(`web/src/${file}`);
      expect(src).toContain("fightLane(");
      if (file.includes("board3d")) {
        expect(src).toContain("fallPose(camPose(),");
        expect(src).not.toContain("fallPose(defaultPose(");
      }
    }
  });

  it("uses one 24 px gutter", () => {
    const html = source("web/index.html");
    expect([...html.matchAll(/--aw-gutter:\s*([^;]+);/g)].map((m) => m[1])).toEqual(["24px"]);
  });
});

// The next captures show 1, 4 and about 10 queens a side (scripted state allowed).
describe("the queens row fixture", () => {
  it("carries 1, 4 and 10 queens a colony through the wire, its fallen lost and the second colony's newest bitten", () => {
    expect(QUEENS_FIXTURE_COUNTS).toEqual([1, 4, 10]);
    for (const n of QUEENS_FIXTURE_COUNTS) {
      const [snapshot, bite] = queensFixture(n).map((m) => decodeMessage(encodeMessage(m)));
      const queens = snapshot!.full!.queens!;
      expect([0, 1].map((c) => queens.filter((q) => q.colony === c).length)).toEqual([n, n]);
      expect([0, 1].map((c) => queens.filter((q) => q.colony === c && q.lostTick !== null).length)).toEqual(n >= 10 ? [1, 2] : n >= 4 ? [1, 1] : [0, 0]);
      expect(bite!.events).toEqual([{ kind: "queenHp", colony: 1, queenId: n - 1, hp: 35_000 }]);
    }
  });
});
