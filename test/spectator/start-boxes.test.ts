/** Geometry and real renderer upload boundaries; browser observations are made separately. */
import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { OPENING_OUTLINE_PIXELS, openingOutlineWidth, phoneOpeningOutline, projectedOutlineWidth, StartBoxes3D } from "../../web/src/board3d/start-boxes.ts";
import { project, type Pose } from "../../web/src/board3d/view.ts";
import { StartBoxes2D } from "../../web/src/start-boxes2d.ts";
import { visibleStartBoxes, type StartBoxSetup } from "../../web/src/start-boxes.ts";

// Every match plays at grid scale 2: scale 1 and 4 boards no longer play.
function setup(scale: 2): StartBoxSetup {
  return { mapW: 64 * scale, mapH: 48 * scale, gridScale: scale,
    startBoxes: [{ x: 2 * scale, y: 12 * scale, width: 12 * scale, height: 24 * scale },
      { x: 50 * scale, y: 12 * scale, width: 12 * scale, height: 24 * scale }] };
}

it("draws nothing for legacy or absent boards, and refuses malformed geometry rather than guessing", () => {
  expect(visibleStartBoxes(undefined)).toEqual([]);
  expect(visibleStartBoxes({ mapW: 64, mapH: 48 })).toEqual([]);
  const good = setup(2);
  for (const bad of [{ x: -1 }, { y: 0.5 }, { width: 0 }, { height: 1000 }, { x: NaN }]) {
    expect(visibleStartBoxes({ ...good, startBoxes: [{ ...good.startBoxes![0], ...bad }, good.startBoxes![1]] }))
      .toEqual([{ ...good.startBoxes![1], colony: 1 }]);
  }
});

it("limits the raster floor to the existing phone layouts during opening", () => {
  for (const [w, h] of [[393, 852], [852, 393], [700, 900], [900, 500]]) {
    expect(phoneOpeningOutline(w!, h!, true)).toBe(true);
    expect(phoneOpeningOutline(w!, h!, false)).toBe(false);
  }
  expect(phoneOpeningOutline(1440, 1000, true)).toBe(false);
  expect(phoneOpeningOutline(701, 501, true)).toBe(false);
});

it("repairs the measured missing pixel-centre row without depth or camera changes", () => {
  const box = visibleStartBoxes(setup(2))[0]!;
  // A browser measurement gave 373.54..374.37: neither 373.5 nor 374.5 is covered.
  const projection = { key: "diagnostic-affine", project: (x: number, y: number): [number, number] =>
    [51.9975 + (x - box.x) * 2.6, 373.54 + (y - box.y) * 2.6] };
  const hasPixelRow = (width: number) => {
    const low = projection.project(box.x, box.y)[1], high = projection.project(box.x, box.y + width)[1];
    return Math.ceil(low - 0.5) + 0.5 <= high;
  };
  expect(projectedOutlineWidth(box, 0.32, projection.project)).toBeCloseTo(0.832);
  expect(hasPixelRow(0.32)).toBe(false);
  const width = openingOutlineWidth(box, 0.32, projection);
  expect(projectedOutlineWidth(box, width, projection.project)).toBeGreaterThanOrEqual(OPENING_OUTLINE_PIXELS);
  expect(hasPixelRow(width)).toBe(true);
});

describe.each([2] as const)("grid scale %s", scale => {
  it("keeps exact half-open tile rectangles at every physical grid size", () => {
    const s = setup(scale), boxes = visibleStartBoxes(s);
    expect(boxes.map(b => [b.width / scale, b.height / scale])).toEqual([[12, 24], [12, 24]]);
    expect(boxes[1]!.x).toBe(s.mapW - boxes[0]!.x - boxes[0]!.width);
    expect(boxes.map(b => [b.x, b.y, b.width, b.height])).toEqual(s.startBoxes!.map(b => [b.x, b.y, b.width, b.height]));
  });

  it("draws 2D paths from the current delayed setup and clears them on old-match transition", () => {
    const s = setup(scale), overlay = new StartBoxes2D(10 / scale);
    try {
      overlay.update({ board: { setup: s } });
      expect(overlay.boxes).toEqual(visibleStartBoxes(s));
      expect(overlay.layer.context.instructions).toHaveLength(6);
      const bounds = overlay.layer.getLocalBounds();
      expect(bounds.minX).toBeCloseTo(2 * scale);
      expect(bounds.maxX).toBeCloseTo(62 * scale);
      expect(bounds.minY).toBeCloseTo(12 * scale);
      expect(bounds.maxY).toBeCloseTo(36 * scale);
      overlay.setTilePx(20 / scale);
      overlay.update({ board: { setup: s } });
      expect(overlay.boxes).toHaveLength(2);
      overlay.update({ board: { setup: { mapW: s.mapW, mapH: s.mapH } } });
      expect(overlay.boxes).toEqual([]);
      expect(overlay.layer.context.instructions).toHaveLength(0);
      overlay.update({ board: null });
      expect(overlay.layer.context.instructions).toHaveLength(0);
    } finally { overlay.layer.destroy(); }
  });

  it.each([1, 0.75, 0.5])("keeps two buffer pixels through perspective/rotation at render scale %s", renderScale => {
    const s = setup(scale);
    for (const [w, h] of [[393, 852], [852, 393]]) for (const beta of [0.01, 0.6]) {
      const pose: Pose = { alpha: -Math.PI / 2 + 0.1, beta, radius: 270 * scale, target: [32 * scale, 0, 24 * scale] };
      const projection = { key: `${w}:${h}:${beta}:${renderScale}`, project: (x: number, y: number): [number, number] => {
        const p = project(pose, w!, h!, [x, Math.sin(x / scale) * 0.1 * scale, s.mapH - y])!;
        return [p[0] * renderScale, p[1] * renderScale];
      } };
      for (const b of visibleStartBoxes(s)) {
        const width = openingOutlineWidth(b, 0.16 * scale, projection);
        expect(width).toBeGreaterThanOrEqual(0.16 * scale);
        expect(width).toBeLessThanOrEqual(Math.min(b.width, b.height) / 2);
        expect(projectedOutlineWidth(b, width, projection.project)).toBeGreaterThanOrEqual(OPENING_OUTLINE_PIXELS);
      }
    }
  });

  it("caches by projection and restores byte-identical original geometry for desktop/later ticks", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const s = setup(scale), heightAt = (x: number, y: number) => x * 0.01 + y * 0.02;
      const overlay = new StartBoxes3D(scene, { heightAt }, [[1, 0, 0], [0, 0, 1]]);
      const frame = { board: { setup: s } };
      overlay.update(frame);
      const original = overlay.meshes.map(mesh => ({ positions: [...mesh.getVerticesData("position")!], indices: [...mesh.getIndices()!] }));
      const projection = { key: "phone", project: (x: number, y: number): [number, number] => [x * 2 / scale, y * 2 / scale] };
      overlay.update(frame, projection);
      const widened = overlay.meshes[0].getVerticesData("position");
      expect([...widened!]).not.toEqual(original[0]!.positions);
      overlay.update(frame, projection);
      expect(overlay.meshes[0].getVerticesData("position")).toBe(widened);
      overlay.update(frame, { key: "half-resolution", project: (x, y) => [x / scale, y / scale] });
      expect(overlay.meshes[0].getVerticesData("position")).not.toEqual(widened);
      for (const colony of [0, 1] as const) {
        const b = s.startBoxes![colony], mesh = overlay.meshes[colony], positions = mesh.getVerticesData("position")!;
        expect(mesh.isPickable).toBe(false);
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i]!, y = s.mapH - positions[i + 2]!;
          expect(x).toBeGreaterThanOrEqual(b.x); expect(x).toBeLessThanOrEqual(b.x + b.width);
          expect(y).toBeGreaterThanOrEqual(b.y); expect(y).toBeLessThanOrEqual(b.y + b.height);
          expect(positions[i + 1]).toBeCloseTo(heightAt(x, y) + 0.035 * scale, 5);
        }
      }
      overlay.update(frame); // Desktop or post-opening omits the projection: exact original path.
      for (const [i, mesh] of overlay.meshes.entries()) {
        expect([...mesh.getVerticesData("position")!]).toEqual(original[i]!.positions);
        expect([...mesh.getIndices()!]).toEqual(original[i]!.indices);
      }
      overlay.update({ board: null }, projection);
      expect(overlay.meshes.every(m => !m.isEnabled())).toBe(true);
      overlay.update({ board: { setup: { mapW: s.mapW, mapH: s.mapH } } }, projection);
      expect(overlay.boxes).toEqual([]);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("uploads colony borders on the ground inside exact fine-tile edges, then clears stale meshes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const s = setup(scale), heightAt = (x: number, y: number) => x * 0.01 + y * 0.02;
      const overlay = new StartBoxes3D(scene, { heightAt }, [[1, 0, 0], [0, 0, 1]]);
      overlay.update({ board: { setup: s } });
      expect(overlay.boxes).toEqual(visibleStartBoxes(s));
      for (const colony of [0, 1] as const) {
        const mesh = overlay.meshes[colony], b = s.startBoxes![colony];
        expect(mesh.isEnabled()).toBe(true);
        expect(mesh.isPickable).toBe(false);
        const positions = mesh.getVerticesData("position")!;
        expect(positions).toHaveLength((b.width + b.height) * 2 * 12);
        const xs: number[] = [], ys: number[] = [];
        for (let i = 0; i < positions.length; i += 3) {
          const x = positions[i]!, y = s.mapH - positions[i + 2]!;
          xs.push(x); ys.push(y);
          expect(x).toBeGreaterThanOrEqual(b.x);
          expect(x).toBeLessThanOrEqual(b.x + b.width);
          expect(y).toBeGreaterThanOrEqual(b.y);
          expect(y).toBeLessThanOrEqual(b.y + b.height);
          expect(positions[i + 1]).toBeCloseTo(heightAt(x, y) + 0.035 * scale, 5);
        }
        expect(Math.min(...xs)).toBe(b.x); expect(Math.max(...xs)).toBe(b.x + b.width);
        expect(Math.min(...ys)).toBe(b.y); expect(Math.max(...ys)).toBe(b.y + b.height);
      }
      overlay.update({ board: null });
      expect(overlay.meshes.every(m => !m.isEnabled())).toBe(true);
      overlay.update({ board: { setup: s } });
      expect(overlay.meshes.every(m => m.isEnabled())).toBe(true);
      overlay.update({ board: { setup: { mapW: s.mapW, mapH: s.mapH } } });
      expect(overlay.meshes.every(m => !m.isEnabled())).toBe(true);
    } finally { scene.dispose(); engine.dispose(); }
  });
});

it.each([2] as const)("draws streamed full-height back-quarter rectangles in both renderers at scale %i", scale => {
  const s = setup(scale);
  s.startBoxes = [{ x: 0, y: 0, width: s.mapW / 4, height: s.mapH },
    { x: s.mapW * 3 / 4, y: 0, width: s.mapW / 4, height: s.mapH }];
  const two = new StartBoxes2D(10 / scale), engine = new NullEngine(), scene = new Scene(engine);
  const three = new StartBoxes3D(scene, { heightAt: () => 0 }, [[1, 0, 0], [0, 0, 1]]);
  try {
    two.update({ board: { setup: s } }); three.update({ board: { setup: s } });
    expect(two.boxes).toEqual(visibleStartBoxes(s));
    expect(three.boxes).toEqual(visibleStartBoxes(s));
    const bounds = two.layer.getLocalBounds();
    expect([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]).toEqual([0, 0, s.mapW, s.mapH]);
    for (const colony of [0, 1] as const) {
      const positions = three.meshes[colony].getVerticesData("position")!, box = s.startBoxes[colony];
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < positions.length; i += 3) { xs.push(positions[i]!); ys.push(s.mapH - positions[i + 2]!); }
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)])
        .toEqual([box.x, box.x + box.width, 0, s.mapH]);
    }
  } finally { two.layer.destroy(); scene.dispose(); engine.dispose(); }
});
