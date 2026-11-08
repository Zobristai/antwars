/** Opening framing is temporary, metadata-led, and independent of the live/fall camera. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StreamSetup } from "../../src/live/format.ts";
import { Camera, fightLane, queensBox, type Box } from "../../web/src/camera.ts";
import { fitOpeningView, openingBounds, openingPhase, OPENING_MARGIN } from "../../web/src/start-framing.ts";
import { fitOpeningPose } from "../../web/src/board3d/start-framing.ts";
import { fallPose, poseAfterResize, project, viewPose } from "../../web/src/board3d/view.ts";

// Every match plays at grid scale 2: scale 1 and 4 boards no longer play.
function board(scale: 2 = 2) {
  const setup: StreamSetup = { mapW: 64 * scale, mapH: 48 * scale, gridScale: scale,
    ticksPerSecond: 10, matchTicks: 1000, idleTicks: 100, overrunRadiusTiles: 2 * scale,
    queens: [[8.5 * 256 * scale, 24.5 * 256 * scale], [55.5 * 256 * scale, 24.5 * 256 * scale]],
    startBoxes: [{ x: 2 * scale, y: 12 * scale, width: 12 * scale, height: 24 * scale },
      { x: 50 * scale, y: 12 * scale, width: 12 * scale, height: 24 * scale }], startingQueenIds: [[0, 3], [0, 3]] };
  const queens = ([0, 1] as const).flatMap(colony => [0, 3].map((id, i) => ({ colony, id,
    x: (colony ? 61.5 - i * 10 : 2.5 + i * 10) * 256 * scale, y: (i ? 35.5 : 12.5) * 256 * scale,
    lostTick: null, foundedTick: 0, overrun: 0 })));
  return { setup, queens, result: null };
}
const screens = [
  { w: 1440, h: 1000, area: { x0: 30, y0: 110, x1: 1040, y1: 870 } },
  { w: 393, h: 852, area: { x0: 8, y0: 180, x1: 385, y1: 650 } },
  { w: 852, h: 393, area: { x0: 10, y0: 95, x1: 560, y1: 315 } },
];
const contains = (p: readonly number[], a: Box, margin = 0) => {
  expect(p[0]).toBeGreaterThanOrEqual(a.x0 + margin - 1e-6);
  expect(p[0]).toBeLessThanOrEqual(a.x1 - margin + 1e-6);
  expect(p[1]).toBeGreaterThanOrEqual(a.y0 + margin - 1e-6);
  expect(p[1]).toBeLessThanOrEqual(a.y1 - margin + 1e-6);
};
function camera(b = board(), screen = screens[0]!) {
  return new Camera(b.setup.mapW, b.setup.mapH, screen.w, screen.h, screen.area,
    fightLane(b.setup), queensBox(b.setup), b.setup.gridScale);
}

it("uses all actual starting nests, not legacy anchors, map presets or a later founded queen", () => {
  const b = board();
  const bounds = openingBounds(b)!;
  // Grid scale 2: each starting nest tile padded by max(3 x scale, overrun radius) = 6 fine tiles, with both boxes.
  expect(bounds).toEqual({ x0: -1, y0: 19, x1: 130, y1: 78 });
  b.setup.queens = [[0, 0], [0, 0]];
  expect(openingBounds(b)).toEqual(bounds);
  b.queens.push({ ...b.queens[0]!, id: 77, x: 500 * 256 });
  expect(openingBounds(b)).toEqual(bounds);
  b.queens[1]!.x = 140 * 256;
  expect(openingBounds(b)!.x1).toBe(147);
});

it("fails closed for absent/invalid layout or missing starting identities", () => {
  const b = board();
  delete b.setup.startBoxes;
  expect(openingPhase(0, b)).toBe(false);
  expect(openingBounds(b)).toBeNull();
  const invalid = board(); invalid.setup.startBoxes![0].width = NaN;
  expect(openingBounds(invalid)).toBeNull();
  const missing = board(); missing.queens.pop();
  expect(openingBounds(missing)).toBeNull();
  const legacy = board(); delete legacy.setup.startingQueenIds;
  expect(openingBounds(legacy)).toBeNull();
});

it("ends opening before any live tick, result, loss or missing board", () => {
  const b = board();
  expect(openingPhase(0, b)).toBe(true);
  expect(openingPhase(1, b)).toBe(false);
  expect(openingPhase(0, null)).toBe(false);
  expect(openingPhase(0, { ...b, result: {} })).toBe(false);
  expect(openingPhase(0, { ...b, queens: b.queens.map(q => ({ ...q, lostTick: 0 })) })).toBe(false);
});

describe.each([2] as const)("physical scale %s", scale => {
  it.each(screens)("contains all opening ground bounds in $w x $h, even below whole-board zoom", screen => {
    const b = board(scale), cam = camera(b, screen), bounds = openingBounds(b)!;
    cam.setOpeningBounds(bounds);
    expect(cam.atHome()).toBe(true);
    expect(cam.view).toEqual(fitOpeningView(bounds, screen.area));
    for (const x of [bounds.x0, bounds.x1]) for (const y of [bounds.y0, bounds.y1]) contains(cam.toScreen(x, y), screen.area, OPENING_MARGIN);
    const normal = camera(b, screen);
    const fallBox = { x0: 1 * scale, y0: 10 * scale, x1: 9 * scale, y1: 18 * scale };
    // Both fall inputs (home/fit/area) AND exact output are identical once opening clears.
    cam.setOpeningBounds(null);
    expect(cam.homeView()).toEqual(normal.homeView());
    expect(cam.fit).toEqual(normal.fit);
    expect(cam.area).toEqual(normal.area);
    expect(cam.view).toEqual(normal.view);
    expect(cam.fallView(fallBox)).toEqual(normal.fallView(fallBox));
    // set() exposes clamped's own output. Compare the same arbitrary live inputs to
    // a camera that never entered opening, including minimum zoom and every edge.
    for (const tilePx of [normal.fit.tilePx / 2, normal.fit.tilePx, normal.fit.tilePx * 2, normal.fit.tilePx * 8]) {
      for (const ox of [-10000, 0, 10000]) for (const oy of [-10000, 0, 10000]) {
        const input = { tilePx, ox, oy };
        cam.set(input); normal.set(input);
        expect(cam.view).toEqual(normal.view);
        expect(cam.homeView()).toEqual(normal.homeView());
        expect(cam.fallView(fallBox)).toEqual(normal.fallView(fallBox));
      }
    }
  });

  it.each(screens)("fits the full elevated 3D prism at both view angles in $w x $h", screen => {
    const b = board(scale), cam = camera(b, screen), bounds = openingBounds(b)!;
    for (const name of ["tilted", "top"] as const) {
      const base = viewPose(name, b.setup.mapW, b.setup.mapH, screen.w, screen.h, cam.view,
        screen.area, fightLane(b.setup), queensBox(b.setup), scale);
      const before = structuredClone(base);
      const pose = fitOpeningPose(base, bounds, b.setup.mapH, screen.w, screen.h, screen.area, scale);
      expect(pose.alpha).toBe(base.alpha); expect(pose.beta).toBe(base.beta);
      for (const x of [bounds.x0, bounds.x1]) for (const y of [bounds.y0, bounds.y1]) {
        for (const z of [-2 * scale, 6 * scale]) {
          const p = project(pose, screen.w, screen.h, [x, z, b.setup.mapH - y]);
          expect(p).not.toBeNull(); contains(p!, screen.area, OPENING_MARGIN);
        }
      }
      expect(base).toEqual(before); // Existing live default/ant-size input is not mutated.
      const restored = poseAfterResize(pose, pose, base);
      expect(restored).toEqual(base);
      const fallBox = { x0: 1 * scale, y0: 10 * scale, x1: 9 * scale, y1: 18 * scale };
      expect(fallPose(restored, fallBox, fallBox, b.setup.mapW, b.setup.mapH, screen.w, screen.h, screen.area))
        .toEqual(fallPose(before, fallBox, fallBox, b.setup.mapW, b.setup.mapH, screen.w, screen.h, screen.area));
      const moved = { ...pose, alpha: pose.alpha + 0.1 };
      expect(poseAfterResize(moved, pose, base)).toBe(moved);
    }
  });
});

it("keeps moved 2D cameras, refits an opening home on area/resize, and resets for another opening", () => {
  const b = board(), cam = camera(b), bounds = openingBounds(b)!;
  cam.setOpeningBounds(bounds);
  const portrait = screens[1]!;
  cam.resize(portrait.w, portrait.h, portrait.area);
  expect(cam.view).toEqual(fitOpeningView(bounds, portrait.area));
  const smaller = { ...portrait.area, x1: portrait.area.x1 - 50 };
  cam.setArea(smaller);
  expect(cam.view).toEqual(fitOpeningView(bounds, smaller));
  cam.zoomBy(3); cam.panBy(20, 10);
  const moved = { ...cam.view };
  expect(cam.atHome()).toBe(false);
  cam.setOpeningBounds(null);
  expect(cam.view).toEqual(moved);
  expect(cam.homeView()).toEqual(camera(b, { ...portrait, area: smaller }).homeView());
  cam.setOpeningBounds(bounds);
  cam.resize(portrait.w, portrait.h, portrait.area); // Existing next-match reset.
  expect(cam.view).toEqual(fitOpeningView(bounds, portrait.area));
});

it("bounds moved boxes on an asymmetric future map without substituting fixed coordinates", () => {
  const b = board(); b.setup.startBoxes = [{ x: 6, y: 2, width: 14, height: 24 }, { x: 76, y: 60, width: 36, height: 26 }];
  const bounds = openingBounds(b)!;
  expect(bounds.y0).toBe(2); expect(bounds.y1).toBe(86);
});

it("wires opening removal before both fall paths and keeps the live 3D fit separate", () => {
  const two = readFileSync("web/src/main.ts", "utf8"), three = readFileSync("web/src/board3d/main3d.ts", "utf8");
  expect(two.indexOf("camera.setOpeningBounds(openingPhase(frame.tick, board)")).toBeLessThan(two.indexOf("const to = camera.fallView(nests,"));
  expect(three.indexOf("openingBoard = nextOpening")).toBeLessThan(three.indexOf("const to = fallPose("));
  expect(three).toContain('const antScale = () => antTiles(viewTilePx(defaultPose("tilted"), w, h), scale)');
  expect(three).toContain("const pose = openingDefaultPose(name)");
});

it.each(screens)("frames full-height strips from setup data in 2D and 3D on $w x $h", screen => {
  const b = board(2);
  b.setup.startBoxes = [{ x: 0, y: 0, width: 32, height: 96 }, { x: 96, y: 0, width: 32, height: 96 }];
  const bounds = openingBounds(b)!;
  expect(bounds.y0).toBeLessThanOrEqual(0); expect(bounds.y1).toBeGreaterThanOrEqual(96);
  const cam = camera(b, screen); cam.setOpeningBounds(bounds);
  for (const x of [bounds.x0, bounds.x1]) for (const y of [bounds.y0, bounds.y1]) contains(cam.toScreen(x, y), screen.area, OPENING_MARGIN);
  for (const angle of ["tilted", "top"] as const) {
    const base = viewPose(angle, 128, 96, screen.w, screen.h, cam.view, screen.area, fightLane(b.setup), queensBox(b.setup), 2);
    const pose = fitOpeningPose(base, bounds, 96, screen.w, screen.h, screen.area, 2);
    for (const x of [bounds.x0, bounds.x1]) for (const y of [bounds.y0, bounds.y1]) for (const z of [-4, 12]) {
      contains(project(pose, screen.w, screen.h, [x, z, 96 - y])!, screen.area, OPENING_MARGIN);
    }
  }
});
