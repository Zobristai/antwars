import { afterAll, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Ground } from "../../web/src/board3d/ground.ts";
import { foundingAspect, foundingFrame, foundingProjection, fitFoundingPose, NEST_FRAME_MARGIN } from "../../web/src/board3d/queen-framing.ts";
import { HERO_ALPHA, TOP_BETA, project, projector, type Area, type Pose } from "../../web/src/board3d/view.ts";
import { QUEEN_FRAME_TILES } from "../../web/src/buffer.ts";
import { nestZoneRect } from "../../web/src/words.ts";
import { clipPolygon, foundingProblems, foundingRecording, projectedArea, type QueenFrameMeasurement } from "../../web/capture/queen-framing-3d.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";

// Actual interpolated mesh heights, not the analytic noise function or a flat plane.
// NullEngine is geometry evidence only, never a Chromium/WebKit render pass.
const engine = new NullEngine();
const scene = new Scene(engine);
const ground = new Ground(scene, 128, 96, 2);
const frame = foundingFrame(128, 96, (x, y) => ground.heightAt(x, y));
const base: Pose = { alpha: HERO_ALPHA, beta: TOP_BETA, radius: 300, target: [64, 0, 48] };
const aspect = foundingAspect(frame, base);
afterAll(() => { scene.dispose(); engine.dispose(); });

const viewports = [[1920, 1080, 1548, 837, 24, 163], [1366, 768, 994, 505.75, 24, 182.25],
  [390, 844, 390, 318.0625, 0, 268.9375], [360, 780, 360, 284.0625, 0, 250.9375], [844, 390, 476, 338, 0, 0]] as const;

describe("stable 3D founding envelope", () => {
  it("samples the actual diagnostic's complete possible integer corner domain once", () => {
    expect(frame.points).toHaveLength((128 + 2 * QUEEN_FRAME_TILES + 1) * (96 + 2 * QUEEN_FRAME_TILES + 1));
    expect(frame.points[0]).toEqual([-2, ground.heightAt(-2, -2), 98]);
    expect(frame.points.at(-1)).toEqual([130, ground.heightAt(130, 98), -2]);
    expect(frame.points.some(p => p[1] !== 0)).toBe(true);
    expect(aspect).toBeGreaterThan(1.25);
    expect(aspect).toBeLessThan(1.4);
  });

  it.each(viewports)("contains every later nest at %ix%i without changing orientation", (w, h, availableW, availableH, x, y) => {
    // Exercise the fixed stage contract independently of the DOM allocator. Its browser
    // implementation is checked by the capture, not certified by this arithmetic.
    const width = Math.min(availableW, availableH * aspect), height = width / aspect;
    const area: Area = { x0: x, y0: y, x1: x + width, y1: y + height };
    const before = structuredClone(frame);
    const pose = fitFoundingPose(base, frame, w, h, area, 2);
    const bounds = foundingProjection(frame, pose, w, h)!;
    expect(bounds.x0).toBeGreaterThanOrEqual(area.x0 + NEST_FRAME_MARGIN - 1e-6);
    expect(bounds.y0).toBeGreaterThanOrEqual(area.y0 + NEST_FRAME_MARGIN - 1e-6);
    expect(bounds.x1).toBeLessThanOrEqual(area.x1 - NEST_FRAME_MARGIN + 1e-6);
    expect(bounds.y1).toBeLessThanOrEqual(area.y1 - NEST_FRAME_MARGIN + 1e-6);
    expect(pose.alpha).toBe(base.alpha);
    expect(pose.beta).toBe(base.beta);
    // Every potential later tile, including the fixture's actual edge founding [26,0].
    // Aggregate extrema, avoiding thousands of assertion objects in the full gate.
    const screen = projector(pose, w, h);
    let clearance = Infinity;
    for (let ty = 0; ty < 96; ty++) for (let tx = 0; tx < 128; tx++) {
      const rect = nestZoneRect({ x: tx * 256 + 128, y: ty * 256 + 128 }, QUEEN_FRAME_TILES,
        (x, y) => screen([x, ground.heightAt(x, y), 96 - y])!);
      clearance = Math.min(clearance, rect.x0 - area.x0, rect.y0 - area.y0, area.x1 - rect.x1, area.y1 - rect.y1);
    }
    expect(clearance).toBeGreaterThanOrEqual(NEST_FRAME_MARGIN - 1e-6);
    expect(frame).toEqual(before);
    // Founding has no input to this function; a layout-identical call is deterministic.
    expect(fitFoundingPose(base, frame, w, h, area, 2)).toEqual(pose);
  });

  it("uses interior terrain extrema, not only map corners", () => {
    const raised = foundingFrame(8, 6, (x, y) => x === 4 && y === 3 ? 8 : 0);
    expect(raised.points).toContainEqual([4, 8, 3]);
    const area = { x0: 20, y0: 100, x1: 380, y1: 600 };
    const pose = fitFoundingPose({ ...base, radius: 50 }, raised, 400, 700, area);
    const box = foundingProjection(raised, pose, 400, 700)!;
    expect(box.x0).toBeGreaterThanOrEqual(21);
    expect(box.y0).toBeGreaterThanOrEqual(101);
    expect(box.x1).toBeLessThanOrEqual(379);
    expect(box.y1).toBeLessThanOrEqual(599);
  });

  it("keeps the pinned offline founding input and rejects missing or moved browser evidence", () => {
    const messages = unpackMessages(foundingRecording()).map(decodeMessage);
    expect(messages.map(m => m.tick)).toEqual([100, 101]);
    const nest = { colony: 0, id: 0, lost: false, rect: { x0: 10, y0: 10, x1: 20, y1: 20 } };
    const before: QueenFrameMeasurement = { tick: 100, stage: { x0: 0, y0: 0, x1: 100, y1: 100 },
      view: { tilePx: 5 }, camera: { alpha: -Math.PI / 2, beta: 0.01, radius: 100, target: [1, 0, 1] },
      corners: [[2, 2], [98, 2], [98, 98], [2, 98]], nests: Array.from({ length: 8 }, (_, id) => ({ ...nest, id })) };
    const after = { ...structuredClone(before), tick: 101, nests: [...before.nests, { ...nest, id: 8 }] };
    expect(foundingProblems(before, after)).toEqual([]);
    expect(foundingProblems(before, { ...after, camera: null })).toContain("3D camera diagnostic missing");
    expect(foundingProblems(before, { ...after, stage: { ...after.stage, x0: 1 } })).toContain("stage moved on founding");
    const clipped = structuredClone(after); clipped.nests[8]!.rect.x0 = -1;
    expect(foundingProblems(before, clipped)).toContain("after: colony 0 nest 8 has only -1px clearance");
  });

  it("separates projected bounds from clipped footprint instead of claiming raster area", () => {
    const polygon = [[-10, -10], [110, -10], [110, 110], [-10, 110]] as const;
    expect(projectedArea(polygon)).toEqual({ width: 120, height: 120, area: 14400 });
    const clipped = projectedArea(clipPolygon(polygon, { x0: 0, y0: 0, x1: 100, y1: 50 }));
    expect(clipped.width).toBeCloseTo(100, 10);
    expect(clipped.height).toBeCloseTo(50, 10);
    expect(clipped.area).toBeCloseTo(5000, 10);
    expect(projectedArea([]).area).toBe(0);
  });

  it("batch projection preserves single-point perspective including points behind the camera", () => {
    const pose: Pose = { alpha: -1.1, beta: 0.7, radius: 50, target: [30, 0, 20] };
    const batch = projector(pose, 390, 844);
    for (const p of [[0, 0, 0], [40, 9, 60], [20, 1000, 20]] as const) {
      expect(batch(p)).toEqual(project(pose, 390, 844, p));
    }
  });
});
