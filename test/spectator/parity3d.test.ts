import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CORPSE_FADE_MS, Frame, type Board } from "../../web/src/buffer.ts";
import { COLONY_TINT, DIM_TINT, FALLEN_TINT, SOLDIER_SCALE } from "../../web/src/ants.ts";
import { FOOD, foodPiles } from "../../web/src/food.ts";
import { PlaceMarkers, STORY_MARK_MS } from "../../web/src/effects.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { Ants3D, buildAntGeometry } from "../../web/src/board3d/ants3d.ts";
import { Food3D } from "../../web/src/board3d/food3d.ts";
import { MARKER_FRAMES, MarkerSpecs3D, markerParticles, type ProjectToRef } from "../../web/src/board3d/markers3d.ts";
import { patchTarget } from "../../web/capture/board-parity.ts";

let engine: NullEngine, scene: Scene, ground: Ground;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); ground = new Ground(scene, 8, 8); });
afterEach(() => { scene.dispose(); engine.dispose(); });

function board(food = new Uint32Array(64)): Board {
  return { setup: { mapW: 8, mapH: 8, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 600, overrunRadiusTiles: 1, queens: [[384, 896], [1664, 896]] }, food, territory: new Uint8Array(64), held: [0, 0], marks: [], agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null, hatch: null, stores: [{ food: 0, nextHatchTick: 0, nextCost: 0 }, { food: 0, nextHatchTick: 0, nextCost: 0 }] };
}
function m(name: string): Mesh { const mesh = scene.getMeshByName(name); expect(mesh).toBeInstanceOf(Mesh); return mesh as Mesh; }
function matrix(name: string): Float32Array { return m(name)._thinInstanceDataStorage.matrixData!; }
function rgba(name: string) { const mesh = m(name); return mesh.getVertexBuffer("instanceColor")!.getFloatData(mesh.thinInstanceCount, true)!; }
function count(name: string, n: number): void { expect(m(name).thinInstanceCount).toBe(n); expect(m(name).isEnabled()).toBe(n > 0); }
function antFrame(): Frame {
  const f = new Frame(); f.ensure(3); f.count = 3;
  for (let i = 0; i < 3; i++) { f.id[i] = i + 1; f.x[i] = 3; f.y[i] = 4; f.alpha[i] = 1; f.agent[i] = i; }
  f.caste[1] = 1; f.colony[2] = 1;
  f.carrying[0] = 1; f.carrying[1] = 1; // even a malformed soldier flag cannot give a soldier a crumb
  return f;
}

describe("3D economy from the same board as 2D", () => {
  it("matches the shared tile/pile amounts and their changes including harvested and corpse food", () => {
    const f = new Frame(); const food = new Food3D(scene, ground);
    f.board = board(); f.board.food[19] = 2; f.board.food[21] = 14;
    food.update(f, 10);
    expect(food.piles).toEqual(foodPiles(f.board.food, 8)); count("food-piles", 9);
    const matrices = food.mesh.thinInstanceGetWorldMatrices();
    const first = food.piles[0]!;
    expect(matrices[0]!.m[12]).toBeCloseTo(first.x);
    expect(matrices[0]!.m[14]).toBeCloseTo(8 - first.y);
    expect(matrices[0]!.m[13]).toBeGreaterThan(ground.heightAt(first.x, first.y));
    f.board = { ...f.board, food: f.board.food.slice() }; f.board.food[19] = 0; f.board.food[21] = 1; f.board.food[30] = 3;
    f.corpses = [{ antId: 99, x: 6.5, y: 3.5, colony: 1, heading: 0, ageMs: 0 }];
    food.update(f, 10); count("food-piles", 4);
    expect(food.piles.map((p) => [p.tile, p.crumbs])).toEqual([[21, 1], [30, 3]]);
    f.board = { ...f.board, food: new Uint32Array(64) }; food.update(f, 10); count("food-piles", 0);
  });
  it("grows and reuses one batch, respects hiding, and keeps the camera-dependent phone floor", () => {
    const f = new Frame(); f.board = board(new Uint32Array(64).fill(7));
    const food = new Food3D(scene, ground); food.mesh.isVisible = false;
    food.update(f, 6); count("food-piles", 448); expect(food.mesh.isVisible).toBe(false);
    expect(food.mesh.thinInstanceGetWorldMatrices()[0]!.m[0]).toBeCloseTo(Math.cos(food.piles[0]!.rotation) * 1.6 / 6);
    const piles = food.piles; food.update(f, 6); expect(food.piles).toBe(piles);
    const first = piles[0]!;
    food.update(f, 20); expect(food.piles).toBe(piles); expect(food.piles[0]).toBe(first);
    f.board = null; food.update(f, 20); count("food-piles", 0);
    food.mesh.isVisible = true; expect(food.mesh.isEnabled()).toBe(false);
    f.board = board(Uint32Array.from({ length: 64 }, (_, i) => i === 19 ? 1 : 0)); food.update(f, 20); count("food-piles", 1);
    expect(scene.meshes.filter((m) => m.name === "food-piles")).toHaveLength(1);
    expect((food.mesh.material as StandardMaterial).diffuseColor.toHexString()).toBe(`#${FOOD.toString(16).toUpperCase()}`);
  });
});

describe("3D parity geometry and reuse budgets", () => {
  it("keeps both crumb batches at eight outward-facing, flat-shaded triangles with their original radius/offset", () => {
    const food = new Food3D(scene, ground);
    new Ants3D(scene, ground, 0.5, COLONY_RGB);
    for (const [mesh, radius, cx, cy] of [[food.mesh, 1, 0, 0], [m("carried-food"), 0.16, 0.48, 0.24]] as const) {
      expect(mesh.getTotalIndices() / 3).toBe(8);
      expect(mesh.getTotalVertices()).toBe(24);
      const positions = mesh.getVerticesData("position")!, normals = mesh.getVerticesData("normal")!;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]! - cx, y = positions[i + 1]! - cy, z = positions[i + 2]!;
        expect(Math.hypot(x, y, z)).toBeCloseTo(radius);
        expect(x * normals[i]! + y * normals[i + 1]! + z * normals[i + 2]!).toBeGreaterThan(0);
      }
    }
  });
  it("uses the shared 912-triangle geometry without losing soldier caste details", () => {
    new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const worker = buildAntGeometry(scene, COLONY_RGB[0], false, 4, false, 3);
    expect(m("ants0").getTotalIndices()).toBe(worker.indices!.length);
    expect(m("soldiers0").getTotalIndices() / 3).toBeLessThan(1000);
    const positions = m("soldiers0").getVerticesData("position")!, colors = m("soldiers0").getVerticesData("color")!;
    // Both forward pale mandibles remain, and the coloured head is still wide in z.
    let leftJaw = false, rightJaw = false, wideHead = false;
    for (let i = 0; i < positions.length / 3; i++) {
      const x = positions[i * 3]!, z = positions[i * 3 + 2]!;
      if (x > 0.45 && colors[i * 4]! > 0.85 && colors[i * 4 + 1]! > 0.8) {
        if (z < 0) leftJaw = true;
        if (z > 0) rightJaw = true;
      }
      if (x > 0.2 && x < 0.4 && Math.abs(z) > 0.12 && colors[i * 4] === COLONY_RGB[0][0]) wideHead = true;
    }
    expect(leftJaw && rightJaw && wideHead).toBe(true);
  });
  it("reuses each shared-rule tile record across zoom, amount changes, depletion and regrowth", () => {
    const f = new Frame(); f.board = board(); f.board.food[19] = 7;
    const food = new Food3D(scene, ground); food.update(f, 10);
    const list = food.piles, tile = list[0]!;
    for (const amount of [1, 14, 0, 3]) {
      f.board = { ...f.board, food: f.board.food.slice() }; f.board.food[19] = amount;
      food.update(f, 12);
      expect(food.piles).toBe(list);
      expect(food.piles).toEqual(foodPiles(f.board.food, 8));
      if (amount) expect(food.piles[0]).toBe(tile);
    }
  });
});

describe("3D caste, carrying and selection", () => {
  it("routes soldiers separately at 2x length with a wide coloured head and pale mandibles", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB, 4); const f = antFrame(); ants.update(f);
    count("ants0", 1); count("ants1", 1); count("soldiers0", 1); count("soldiers1", 0); count("carried-food", 1);
    expect(m("soldiers0").thinInstanceGetWorldMatrices()[0]!.m[0]).toBeCloseTo(0.5 * SOLDIER_SCALE);
    const worker = buildAntGeometry(scene, COLONY_RGB[0], false, 4);
    const soldier = buildAntGeometry(scene, COLONY_RGB[0], false, 4, true);
    // Mandibles still extend beyond the worker's head/antennae; vertex count is not a caste feature.
    const forward = (positions: ArrayLike<number>) => Math.max(...Array.from(positions).filter((_, i) => i % 3 === 0));
    expect(forward(soldier.positions!)).toBeGreaterThan(forward(worker.positions!));
    expect(soldier.colors).not.toEqual(worker.colors);
    expect(soldier.positions!.length / 3).toBe(soldier.colors!.length / 4);
    expect(ants.meshes.map((m) => m.name)).toContain("soldiers0");
    f.caste[1] = 0; f.carrying[0] = 0; ants.update(f);
    count("ants0", 2); count("soldiers0", 0); count("carried-food", 1);
    f.carrying[1] = 0; ants.update(f); count("carried-food", 0);
  });
  it("puts carrying crumbs in the worker's local heading and scales rings for each caste", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB, 4); const f = antFrame();
    f.rotation[0] = Math.PI / 2; ants.update(f, 0, [0xff9900]);
    const cm = m("carried-food").thinInstanceGetWorldMatrices()[0]!;
    expect(cm.m[12]).toBeCloseTo(3); expect(cm.m[14]).toBeCloseTo(4); expect(cm.m[2]).toBeCloseTo(-0.5);
    expect(m("carried-food").getVerticesData("position")!.some((v, i) => i % 3 === 0 && v > 0.48)).toBe(true);
    count("rings", 1); expect(matrix("rings")[0]).toBeCloseTo(0.5);
    ants.update(f, 1); count("rings", 1); expect(matrix("rings")[0]).toBeCloseTo(1);
    expect(rgba("ants0")[0]).toBeCloseTo(((DIM_TINT >> 16) & 255) / 255);
    // A fallen colony's ants are dimmed as fallen, the other colony's untouched, as on the 2D board.
    ants.update(f, -1, [], [true, false]);
    expect(rgba("ants0")[0]).toBeCloseTo(((FALLEN_TINT >> 16) & 255) / 255);
    expect(rgba("soldiers0")[2]).toBeCloseTo((FALLEN_TINT & 255) / 255);
    expect(rgba("ants1")[0]).toBeCloseTo(1);
    ants.setVisible(false); ants.update(f); expect(m("carried-food").isVisible).toBe(false); expect(m("soldiers0").isVisible).toBe(false);
    ants.update(new Frame()); ants.setVisible(true); count("carried-food", 0); count("soldiers0", 0);
  });
  // Regression caught: 3D squad ants tinted only while highlighted,
  // a free ant taking a hue, or a dimmed squad losing its hue.
  it("tints squad ants toward their agent's hue at all times and leaves free ants plain, as the 2D board does", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB, 4); const f = antFrame();
    const hues = [0xff0000, 0x00ff00, 0x0000ff];
    ants.update(f, -1, hues);
    expect(rgba("ants0")[0]).toBeCloseTo(1.3); expect(rgba("ants0")[1]).toBeCloseTo(0.35); expect(rgba("ants0")[2]).toBeCloseTo(0.35);
    expect(rgba("ants1")[0]).toBeCloseTo(0.35); expect(rgba("ants1")[2]).toBeCloseTo(1.3);
    // Another squad highlighted: this one is dimmed but keeps its hue; the highlighted squad's ring is in its own hue.
    ants.update(f, 1, hues);
    expect(rgba("ants0")[0]).toBeCloseTo(1.3 * (((DIM_TINT >> 16) & 255) / 255));
    expect(rgba("ants0")[1]).toBeCloseTo(0.35 * (((DIM_TINT >> 8) & 255) / 255));
    count("rings", 1); expect(rgba("rings")[0]).toBeCloseTo(0); expect(rgba("rings")[1]).toBeCloseTo(1.35);
    // A free ant stays plain.
    f.agent[2] = -1; ants.update(f, -1, hues);
    expect(rgba("ants1")[0]).toBeCloseTo(1); expect(rgba("ants1")[2]).toBeCloseTo(1);
  });
  it("keeps corpse geometry above the ground and fades until exactly the shared 3000 ms boundary", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB, 4); const f = new Frame();
    const k = { antId: 1, x: 3, y: 4, colony: 0 as const, heading: 0, ageMs: 0 }; f.corpses = [k];
    let startY = 0;
    for (const age of [0, 1500, CORPSE_FADE_MS - 1]) {
      k.ageMs = age; ants.update(f); count("corpses0", 1);
      const matrix = m("corpses0").thinInstanceGetWorldMatrices()[0]!;
      if (age === 0) startY = matrix.m[13]!;
      expect(matrix.m[13]).toBe(startY);
      const positions = m("corpses0").getVerticesData("position")!;
      const maxLocalY = Math.max(...Array.from(positions).filter((_, i) => i % 3 === 1));
      expect(startY - maxLocalY * 0.5).toBeGreaterThan(ground.heightAt(k.x, k.y));
      expect(rgba("corpses0")[3]).toBeCloseTo(0.9 * (1 - age / CORPSE_FADE_MS));
      expect(m("corpses0").hasVertexAlpha).toBe(true);
    }
    k.ageMs = CORPSE_FADE_MS; ants.update(f); count("corpses0", 0);
    k.ageMs = -1; ants.update(f); count("corpses0", 0);
  });
});

describe("projected queen homes and story places", () => {
  it("omits contact-only pulses on both boards without removing queen landmarks", () => {
    const f = new Frame();
    f.story = [{ id: 1, kind: "contact", tick: 10, colony: 1, agent: 0, x: 2, y: 3 }];
    const places = new PlaceMarkers(10), specs = new MarkerSpecs3D();
    const project: ProjectToRef = (x, y, out) => { out.x = x * 10; out.y = y * 10; };
    try {
      for (const age of [-1, 0, 1999, STORY_MARK_MS - 1, STORY_MARK_MS]) {
        f.targetMs = 1000 + age;
        places.update(f); specs.update(f, project);
        expect(places.shown).toBe(0);
        expect(places.layer.getLocalBounds().width).toBe(0);
        expect(specs.shown).toBe(0);
        expect(specs.particles).toHaveLength(0);
      }
      f.board = board(); f.targetMs = 1000;
      specs.update(f, project);
      expect(specs.shown).toBe(0);
      expect(specs.particles).toHaveLength(18);
      expect(specs.particles.filter((p) => p.kind === "ring" || p.kind === "dot")).toHaveLength(0);
      expect(specs.particles.filter((p) => p.kind === "queen0" || p.kind === "queen1")).toHaveLength(2);
    } finally { places.layer.destroy(); }
  });

  // Regression caught: the pointed order's tile lit in the page's
  // ink instead of its agent's hue.
  it("lights the pointed order's tile in its agent's hue on both boards", () => {
    const f = new Frame();
    const places = new PlaceMarkers(10), specs = new MarkerSpecs3D();
    const project: ProjectToRef = (x, y, out) => { out.x = x * 10; out.y = y * 10; };
    try {
      places.target = specs.target = [3, 4];
      places.targetColour = specs.targetColour = 0x9f85e5;
      places.update(f); specs.update(f, project);
      expect(specs.particles.filter((p) => p.kind === "ring" || p.kind === "dot").map((p) => p.tint)).toEqual([0x9f85e5, 0x9f85e5]);
      type Ins = { action: string; data: { style: { color: number } } };
      const colours = (places.layer.context.instructions as unknown as Ins[]).filter((i) => i.action === "stroke" || i.action === "fill").map((i) => i.data.style.color);
      expect(colours).toContain(0x9f85e5);
      expect(colours).not.toContain(0xffffff);
    } finally { places.layer.destroy(); }
  });

  it.each(["lead", "overrun"] as const)("preserves %s pulses and expiry beside a filtered contact entry on both boards", (kind) => {
    const f = new Frame();
    f.story = [
      { id: 1, kind: "contact", tick: 10, colony: 0, agent: 0, x: 2, y: 3 },
      { id: 2, kind, tick: 10, colony: 1, agent: 0, x: 20, y: 30 },
    ];
    const places = new PlaceMarkers(10);
    try {
      for (const age of [-1, 0, 1999, STORY_MARK_MS - 1, STORY_MARK_MS]) {
        f.targetMs = 1000 + age;
        places.update(f);
        const out = markerParticles(f, (x, y) => [x * 10, y * 10]);
        const live = age >= 0 && age < STORY_MARK_MS;
        expect(places.shown).toBe(live ? 1 : 0);
        expect(places.layer.getLocalBounds().width > 0).toBe(live);
        expect(out.shown).toBe(live ? 1 : 0);
        expect(out.particles).toHaveLength(live ? 3 : 0);
        if (live) expect(out.particles.every((p) => p.x === 200 && p.y === 300 && p.tint === COLONY_TINT[1])).toBe(true);
      }
    } finally { places.layer.destroy(); }
  });
  it("uses tight symmetric atlas frames without clipping the drawings or changing their scale", () => {
    const centres = { ring: 64, dot: 192, line: 320, queen0: 448, queen1: 576 };
    const drawingBounds = { ring: [63, 63], dot: [11, 11], line: [112, 4], queen0: [24.5, 24.5], queen1: [24.5, 24.5] };
    for (const kind of ["ring", "dot", "line", "queen0", "queen1"] as const) {
      const f = MARKER_FRAMES[kind];
      expect(f.x + f.width / 2).toBe(centres[kind]);
      expect(f.y + f.height / 2).toBe(64);
      expect(f.width).toBeGreaterThan(drawingBounds[kind][0]!);
      expect(f.height).toBeGreaterThan(drawingBounds[kind][1]!);
      expect(f.width * f.height).toBeLessThanOrEqual(128 * 128 / 4);
    }
    expect(MARKER_FRAMES.line.height).toBe(8);
    const src = readFileSync("web/src/board3d/markers3d.ts", "utf8");
    expect(src).toContain("const f = MARKER_FRAMES[kind]");
    expect(src).toContain("new Rectangle(f.x, f.y, f.width, f.height)");
    expect(src).toContain("p.scaleX = spec.scaleX; p.scaleY = spec.scaleY");
  });
  it("reuses specs and projection scratch points while preserving positions, pulses, empty frames and setup changes", () => {
    const f = new Frame(); f.board = board();
    // Places age on the playback target (as the collapse does), so a place a match's last message marks keeps pulsing and expires.
    f.story = [{ id: 1, kind: "lead", tick: 10, colony: 1, agent: 0, x: 2, y: 3 }]; f.targetMs = 1000;
    const specs = new MarkerSpecs3D();
    const scratch = new Set<object>();
    const project: ProjectToRef = (x, y, out) => { scratch.add(out); out.x = x * 10; out.y = y * 10; };
    specs.update(f, project);
    const list = specs.particles, records = [...list];
    expect(scratch.size).toBe(3);
    f.targetMs += 350; f.board.setup.queens[0] = [640, 1152];
    specs.update(f, project);
    expect(specs.particles).toBe(list);
    records.forEach((p, i) => expect(specs.particles[i]).toBe(p));
    expect(specs.particles).toEqual(markerParticles(f, (x, y) => [x * 10, y * 10]).particles);
    expect(scratch.size).toBe(3);
    specs.update(new Frame(), project); expect(list).toHaveLength(0); expect(specs.shown).toBe(0);
    specs.update(f, project); records.forEach((p, i) => expect(specs.particles[i]).toBe(p));
    expect(specs.particles).toHaveLength(21);
    specs.update(f, (_x, _y, out) => { out.x = NaN; out.y = Infinity; });
    expect(specs.particles).toHaveLength(0);
  });
  it("uses exact stream queen-zone corners and queen coordinates with screen-sized crowns", () => {
    const f = new Frame(); f.board = board();
    const out = markerParticles(f, (x, y) => [x * 10, y * 10]);
    expect(out.shown).toBe(0); expect(out.particles).toHaveLength(18);
    expect(out.particles.filter((p) => p.kind === "queen0").map((p) => [p.x, p.y, p.scaleX])).toEqual([[15, 35, 1]]);
    const lines = out.particles.filter((p) => p.kind === "line");
    expect(lines).toHaveLength(16); expect(lines[0]!.x).toBeCloseTo(5); expect(lines[0]!.y).toBe(20);
    expect(lines.every((p) => p.scaleX * 112 <= 14)).toBe(true);
    f.board.setup.queens[0] = [640, 1152];
    const moved = markerParticles(f, (x, y) => [x * 20 + 100, y * 5 + 50]);
    expect(moved.particles.find((p) => p.kind === "queen0")).toMatchObject({ x: 150, y: 72.5, scaleX: 1 });
  });
  it("matches 2D's two pulses and centre dot for the full 4000 ms, with no future/expired marks", () => {
    const f = new Frame(); f.story = [{ id: 1, kind: "lead", tick: 10, colony: 1, agent: 0, x: 2, y: 3 }];
    for (const age of [-1, 0, 1999, STORY_MARK_MS - 1, STORY_MARK_MS]) {
      f.targetMs = 1000 + age;
      const out = markerParticles(f, (x, y) => [100 + x * 10, 50 + y * 10]);
      const live = age >= 0 && age < STORY_MARK_MS;
      expect(out.shown).toBe(live ? 1 : 0); expect(out.particles.length).toBe(live ? 3 : 0);
      if (live) {
        expect(out.particles.map((p) => p.kind)).toEqual(["ring", "ring", "dot"]);
        expect(out.particles.every((p) => p.x === 120 && p.y === 80 && p.tint === COLONY_TINT[1])).toBe(true);
        expect(out.particles[2]!.alpha).toBeCloseTo(0.7 * (1 - age / STORY_MARK_MS));
      }
    }
  });
  it("under reduced motion the place's two rings stand still at the phases' radii and only fade, on both boards", () => {
    const f = new Frame(); f.story = [{ id: 1, kind: "lead", tick: 10, colony: 1, agent: 0, x: 2, y: 3 }];
    const rings = (age: number, reduced: boolean) => {
      f.targetMs = 1000 + age;
      return markerParticles(f, (x, y) => [x * 10, y * 10], reduced).particles.filter((p) => p.kind === "ring").map((p) => [p.scaleX, p.alpha]);
    };
    expect(rings(100, true).map(([s]) => s)).toEqual([14 / 30, (14 + 23) / 30]);
    expect(rings(600, true).map(([s]) => s)).toEqual([14 / 30, (14 + 23) / 30]);
    expect(rings(600, true).map(([, a]) => a)).toEqual([0.6 * (1 - 600 / STORY_MARK_MS), 0.3 * (1 - 600 / STORY_MARK_MS)]);
    expect(rings(600, false).map(([s]) => s)).not.toEqual(rings(100, false).map(([s]) => s));
    const places = new PlaceMarkers(10);
    try {
      f.targetMs = 1100; places.update(f, true);
      const still = places.layer.getLocalBounds().width;
      f.targetMs = 1600; places.update(f, true);
      expect(places.layer.getLocalBounds().width).toBe(still);
      // Moving otherwise (100 and 600 ms share their two phases; 350 ms does not).
      f.targetMs = 1100; places.update(f, false);
      const moving = places.layer.getLocalBounds().width;
      f.targetMs = 1350; places.update(f, false);
      expect(places.layer.getLocalBounds().width).not.toBe(moving);
    } finally { places.layer.destroy(); }
  });
});

describe("capture and frame wiring", () => {
  it("settles every parity view through colony-scale before saving the first or subsequent image", () => {
    const source = readFileSync("web/capture/board-parity.ts", "utf8");
    expect(source).toContain('import { settle3DBoard } from "./colony-scale.ts"');
    const shoot = source.slice(source.indexOf("const shoot = async"), source.indexOf("await shoot(`3d-"));
    expect(shoot).toContain("const primaryBoard = await settle3DBoard(c, tick, name)");
    expect(shoot.indexOf("await settle3DBoard")).toBeLessThan(shoot.indexOf("await c.page.screenshot"));
    expect(shoot).toContain("primaryBoard, renderer:");
    expect(shoot).toContain("if (frame.playbackTick !== tick) throw");
  });
  it("chooses real food/carrier/soldier evidence deterministically and refuses missing actors", () => {
    const food = Uint32Array.of(0, 4, 0, 0);
    const ants = [{ id: 2, x: 1.5, y: 1, carrying: true, soldier: false }, { id: 3, x: 2, y: 1, carrying: false, soldier: true }];
    const target = patchTarget(food, 2, ants);
    expect(target).toMatchObject({ foodTile: 1, carryingAnt: 2, soldier: 3 });
    expect(patchTarget(food, 2, [...ants].reverse())).toEqual(target);
    expect(patchTarget(food, 2, ants.slice(0, 1))).toBeNull();
    expect(patchTarget(new Uint32Array(4), 2, ants)).toBeNull();
    expect(patchTarget(food, 2, [{ ...ants[0]!, x: 100 }, ants[1]!])).toBeNull();
  });
  it("wires the layers and true selected squad into each frame, including catch-up without rendering", () => {
    const src = readFileSync("web/src/board3d/main3d.ts", "utf8");
    const beforeRender = src.slice(src.indexOf("const step ="), src.indexOf("if (render) {"));
    for (const update of ["food.update(shown, tilePx)", "markers.update(shown, toScreenRef)", "battles.update(shown, tilePx)", "ants.update(shown, selected"]) expect(beforeRender).toContain(update);
    expect(beforeRender).toContain("const selected = squads.selected");
    expect(src).toContain("pixi.stage.addChild(markers.layer, words.layer");
    expect(src).toContain("placeMarks: markers.shown");
    expect(src).toContain("focusAt:");
  });
});
