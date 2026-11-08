import { describe, expect, it } from "vitest";
import { portraitFitProblems, portraitMovement, type PortraitFit } from "./phone-portrait-fit.ts";

const sample = (): PortraitFit => ({
  targets: [{ label: "Rules", box: { x: 24, y: 615, width: 44, height: 44 }, visible: true, centerHits: true, interceptedByEntry: false }],
  landmarks: { stage: { x: 24, y: 400, width: 345, height: 44 } },
  scroll: [{ name: "overlay", width: 393, height: 659, scrollWidth: 393, scrollHeight: 659, x: 0, y: 0 }],
});

describe("portrait dock and footer fit", () => {
  it("accepts whole 44px targets exactly at the viewport edge", () => {
    expect(portraitFitProblems(sample())).toEqual([]);
  });
  it("rejects the locked baseline's off-screen footer and chip targets", () => {
    const s = sample(); s.targets[0]!.box.y = 687.9375;
    expect(portraitFitProblems(s)).toContain("Rules: outside viewport");
    s.targets[0]!.label = "Marks"; s.targets[0]!.box.y = 643.9375;
    expect(portraitFitProblems(s)).toContain("Marks: outside viewport");
  });
  it("does not accept a sub-44px or invalid target", () => {
    const s = sample(); s.targets[0]!.box.height = 43.999;
    expect(portraitFitProblems(s)).toContain("Rules: invalid or short target");
    s.targets[0]!.box.height = NaN;
    expect(portraitFitProblems(s)).toContain("Rules: invalid or short target");
  });
  it("rejects intrinsic interception while retaining separate entry ownership", () => {
    const s = sample(); s.targets[0]!.centerHits = false;
    expect(portraitFitProblems(s)).toContain("Rules: intrinsic centre interception");
    s.targets[0]!.interceptedByEntry = true;
    expect(portraitFitProblems(s)).toEqual([]);
    s.targets[0]!.box.y = 650; // Entry ownership never excuses an offscreen target.
    expect(portraitFitProblems(s)).toContain("Rules: outside viewport");
  });
  it("rejects hidden-overflow scrolling as a substitute for fitting", () => {
    const s = sample(); s.scroll[0]!.scrollHeight = 728;
    expect(portraitFitProblems(s)).toContain("overlay: scroll overflow");
    s.scroll[0]!.scrollHeight = 659; s.scroll[0]!.y = 1;
    expect(portraitFitProblems(s)).toContain("overlay: scroll overflow");
  });
  it("holds the one-pixel settled movement boundary", () => {
    const before = sample(), after = sample(); after.landmarks.stage!.y += 1;
    expect(portraitMovement(before, after)).toEqual([]);
    after.landmarks.stage!.y += 0.001;
    expect(portraitMovement(before, after)).toEqual(["stage y moved"]);
  });
});
