/**
 * A four-colony match on the 3D board: every colony's ants, soldiers, corpses, nests, queen emblems and start area
 * are drawn in that colony's own colour, and the opening view frames all four nests; a two-colony board builds
 * exactly what it built before. NullEngine proves meshes, counts and colours here; the capture host's WebGL renders
 * prove pixels.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { StreamQueen, StreamSetup } from "../../src/live/format.ts";
import type { Colony } from "../../src/live/snapshot.ts";
import { CORPSE_FADE_MS, Frame, type Board } from "../../web/src/buffer.ts";
import { colonyTint } from "../../web/src/colony-palette.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { MARKER_FRAMES, markerParticles } from "../../web/src/board3d/markers3d.ts";
import { Nests, queenTiles } from "../../web/src/board3d/nests.ts";
import { StartBoxes3D } from "../../web/src/board3d/start-boxes.ts";
import { fitOpeningPose } from "../../web/src/board3d/start-framing.ts";
import { fitFoundingPose, foundingFrame } from "../../web/src/board3d/queen-framing.ts";
import { HERO_ALPHA, project, type Pose } from "../../web/src/board3d/view.ts";
import { visibleStartBoxes } from "../../web/src/start-boxes.ts";
import { openingBounds, openingPhase } from "../../web/src/start-framing.ts";

/** Four distinct colours, one per colony: the Quadrants names' colours. */
const RGB4 = [[1, 0xb0 / 255, 0], [0, 0xc2 / 255, 1], [1, 0x1e / 255, 0x1e / 255], [0, 0x90 / 255, 0x78 / 255]] as const;
const COLONIES = [0, 1, 2, 3] as const;
const W = 128, H = 96, SUB = 256;

/** A nest in each quadrant, each with its start area around it. The stream types still read two colonies at this
 * commit, so the four-entry setup is cast; its shape is the agreed four-colony one (one entry per colony). */
function setup4(): StreamSetup {
  const centres = [[24, 20], [104, 20], [24, 76], [104, 76]] as const;
  return {
    mapW: W, mapH: H, gridScale: 2, ticksPerSecond: 10, matchTicks: 1000, idleTicks: 100, overrunRadiusTiles: 4,
    queens: centres.map(([x, y]) => [(x + 0.5) * SUB, (y + 0.5) * SUB]),
    startBoxes: centres.map(([x, y]) => ({ x: x - 10, y: y - 8, width: 20, height: 16 })),
    startingQueenIds: centres.map(() => [0]),
  } as unknown as StreamSetup;
}
function queens4(setup: StreamSetup): StreamQueen[] {
  return setup.queens.map(([x, y], colony) => ({ id: 0, colony: colony as Colony, x, y, foundedTick: 0, lostTick: null, overrun: 0 }));
}
function board4(): Board {
  const setup = setup4();
  return { setup, queens: queens4(setup), food: new Uint32Array(W * H), territory: new Uint8Array(W * H), held: [0, 0], marks: [],
    agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null, hatch: null,
    stores: [{ food: 0, nextHatchTick: 0, nextCost: 0 }, { food: 0, nextHatchTick: 0, nextCost: 0 }] };
}

let engine: NullEngine, scene: Scene, ground: Ground;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); ground = new Ground(scene, W, H, 2); });
afterEach(() => { scene.dispose(); engine.dispose(); });

function m(name: string): Mesh {
  const mesh = scene.getMeshByName(name);
  expect(mesh, name).toBeInstanceOf(Mesh);
  return mesh as Mesh;
}
function count(name: string, n: number): void {
  expect(m(name).thinInstanceCount, name).toBe(n);
  expect(m(name).isEnabled(), name).toBe(n > 0);
}
/** The abdomen, built first, carries the colony colour at 0.8 (ants3d.ts buildAntGeometry). */
function abdomen(name: string): number[] {
  return Array.from(m(name).getVerticesData("color")!.slice(0, 3));
}
const near = (actual: readonly number[], expected: readonly number[]) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 5));

describe("a four-colony match on the 3D board", () => {
  it("draws every colony's workers, soldiers and corpses in that colony's own herds and colour", () => {
    const ants = new Ants3D(scene, ground, 0.5, RGB4);
    const f = new Frame();
    // Colony c has c + 1 workers and one soldier, and one fresh corpse.
    const rows = COLONIES.flatMap((c) => [...Array.from({ length: c + 1 }, () => ({ c, caste: 0 })), { c, caste: 1 }]);
    f.ensure(rows.length); f.count = rows.length;
    rows.forEach(({ c, caste }, i) => {
      f.id[i] = i + 1; f.x[i] = 10 + i * 4; f.y[i] = 10 + c * 20; f.alpha[i] = 1; f.agent[i] = -1;
      f.colony[i] = c; f.caste[i] = caste;
    });
    f.corpses = COLONIES.map((c) => ({ antId: 100 + c, x: 30 + c * 10, y: 40, colony: c as Colony, heading: 0, ageMs: CORPSE_FADE_MS / 2 }));
    ants.update(f);
    for (const c of COLONIES) {
      count(`ants${c}`, c + 1);
      count(`soldiers${c}`, 1);
      count(`corpses${c}`, 1);
      for (const herd of [`ants${c}`, `soldiers${c}`]) near(abdomen(herd), RGB4[c].map((v) => v * 0.8));
      // Dull corpses keep their colony's tint, mixed toward the ground.
      near(abdomen(`corpses${c}`), RGB4[c].map((v, i) => v * 0.8 * 0.45 + [0.55, 0.52, 0.47][i]! * 0.3));
    }
    expect(ants.meshes).toHaveLength(12);
    expect(ants.casters).toHaveLength(8);
    // The herds empty again with their colony's ants.
    f.count = 0; f.corpses = []; ants.update(f);
    for (const c of COLONIES) for (const herd of ["ants", "soldiers", "corpses"]) count(`${herd}${c}`, 0);
  });

  it("dims only a fallen colony's ants", () => {
    const ants = new Ants3D(scene, ground, 0.5, RGB4);
    const f = new Frame(); f.ensure(4); f.count = 4;
    for (const c of COLONIES) { f.id[c] = c + 1; f.x[c] = 10 + c * 20; f.y[c] = 10; f.alpha[c] = 1; f.agent[c] = -1; f.colony[c] = c; }
    ants.update(f, -1, [], [false, false, true, false]);
    const tint = (c: number) => Array.from(m(`ants${c}`).getVertexBuffer("instanceColor")!.getFloatData(1, true)!.slice(0, 3));
    for (const c of [0, 1, 3]) expect(tint(c)).toEqual([1, 1, 1]);
    expect(tint(2)).not.toEqual([1, 1, 1]);
  });

  it("builds every colony's nest, rim and queen, and keeps a lost colony's nest as its dimmed landmark", () => {
    const setup = setup4();
    expect(queenTiles(setup)).toEqual([[24.5, 20.5], [104.5, 20.5], [24.5, 76.5], [104.5, 76.5]]);
    const nests = new Nests(scene, ground, setup, 0.5, RGB4);
    expect(nests.casters).toHaveLength(4);
    for (const c of COLONIES) {
      for (const part of ["mound", "rim", "entrance", "queen"]) expect(m(`${part}${c}`).isEnabled(), `${part}${c}`).toBe(true);
      near((m(`rim${c}`).material as StandardMaterial).diffuseColor.asArray(), RGB4[c]);
      near(abdomen(`queen${c}`), RGB4[c].map((v) => v * 0.8));
    }
    const queens = queens4(setup);
    queens[2] = { ...queens[2]!, lostTick: 50 };
    nests.update(queens);
    expect(m("queen2").isEnabled()).toBe(false);
    expect(m("rim2").material!.name).toBe("rimLost2");
    near((m("rim2").material as StandardMaterial).diffuseColor.asArray(), RGB4[2].map((v) => v * 0.3));
    for (const c of [0, 1, 3]) expect(m(`queen${c}`).isEnabled()).toBe(true);
  });

  it("outlines every colony's start area in that colony's colour", () => {
    const setup = setup4();
    expect(visibleStartBoxes(setup).map((b) => b.colony)).toEqual([0, 1, 2, 3]);
    const boxes = new StartBoxes3D(scene, ground, RGB4);
    expect(boxes.meshes).toHaveLength(4);
    boxes.update({ board: { setup } });
    for (const c of COLONIES) {
      const mesh = m(`start-box-${c}`);
      expect(mesh.isEnabled()).toBe(true);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      near((mesh.material as StandardMaterial).emissiveColor.asArray(), RGB4[c]);
    }
  });

  it("marks every colony's queen with its own emblem, drawn in that colony's colour", () => {
    const f = new Frame(); f.board = board4(); f.targetMs = 0;
    const particles = markerParticles(f, (x, y) => [x * 10, y * 10], true).particles;
    const emblems = particles.filter((p) => p.kind.startsWith("queen"));
    expect(emblems.map((p) => p.kind)).toEqual(["queen0", "queen1", "queen2", "queen3"]);
    expect(emblems.map((p) => [p.x, p.y])).toEqual([[245, 205], [1045, 205], [245, 765], [1045, 765]]);
    // The emblem's colour is in its atlas cell; the particle tint stays white until a hit flashes it.
    expect(emblems.every((p) => p.tint === 0xffffff)).toBe(true);
    // Each zone's brackets are in its colony's colour.
    const lines = particles.filter((p) => p.kind === "line");
    for (const c of COLONIES) expect(lines.some((p) => p.tint === colonyTint(c))).toBe(true);
    for (const kind of ["queen2", "queen3"] as const) {
      expect(MARKER_FRAMES[kind].y + MARKER_FRAMES[kind].height / 2).toBe(64);
      expect(MARKER_FRAMES[kind].width).toBe(MARKER_FRAMES.queen0.width);
    }
    expect(MARKER_FRAMES.queen2.x + 14).toBe(5 * 128 + 64);
    expect(MARKER_FRAMES.queen3.x + 14).toBe(6 * 128 + 64);
  });

  it("opens framed on all four start areas and nests, and its later view keeps every nest in the board area", () => {
    const b = board4();
    expect(openingPhase(0, b)).toBe(true);
    const bounds = openingBounds(b)!;
    for (const box of b.setup.startBoxes!) {
      expect(bounds.x0).toBeLessThanOrEqual(box.x); expect(bounds.y0).toBeLessThanOrEqual(box.y);
      expect(bounds.x1).toBeGreaterThanOrEqual(box.x + box.width); expect(bounds.y1).toBeGreaterThanOrEqual(box.y + box.height);
    }
    const w = 1280, h = 800, area = { x0: 20, y0: 100, x1: 1000, y1: 760 };
    const base: Pose = { alpha: HERO_ALPHA, beta: 0.9, radius: 200, target: [W / 2, 0, H / 2] };
    const inside = (pose: Pose) => {
      for (const [tx, ty] of queenTiles(b.setup)) {
        const p = project(pose, w, h, [tx, ground.heightAt(tx, ty), H - ty])!;
        expect(p).not.toBeNull();
        expect(p[0]).toBeGreaterThan(area.x0); expect(p[0]).toBeLessThan(area.x1);
        expect(p[1]).toBeGreaterThan(area.y0); expect(p[1]).toBeLessThan(area.y1);
      }
    };
    inside(fitOpeningPose(base, bounds, H, w, h, area, 2, 6));
    inside(fitFoundingPose(base, foundingFrame(W, H, (x, y) => ground.heightAt(x, y)), w, h, area, 2));
  });
});

describe("a two-colony match on the 3D board", () => {
  it("builds exactly the herds it always built, in the same order", () => {
    const before = scene.meshes.length;
    new Ants3D(scene, ground, 0.5, COLONY_RGB);
    expect(scene.meshes.slice(before).map((mesh) => mesh.name))
      .toEqual(["ants0", "ants1", "soldiers0", "soldiers1", "carried-food", "rings", "corpses0", "corpses1"]);
    const boxes = new StartBoxes3D(scene, ground, COLONY_RGB);
    expect(boxes.meshes.map((mesh) => mesh.name)).toEqual(["start-box-0", "start-box-1"]);
  });
});
