/** Real mesh/texture boundaries; NullEngine is not browser pixel proof (renders are checked in a browser). */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { DOMAdapter, RenderTexture } from "pixi.js";
import { MAPS, rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { decodeMessage, encodeMessage, GRID_SCALE_STREAM_VERSION, type StreamSetup } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { Ground } from "../../web/src/board3d/ground.ts";
import { Rocks3D } from "../../web/src/board3d/rocks.ts";
import { ROCK_GLSL, WaterMask } from "../../web/src/terrain.ts";
import { Territory } from "../../web/src/territory.ts";
import { dryControls, terrainPhaseFixture, terrainRecordingName } from "../../web/capture/terrain.ts";
import { playable } from "../playable.ts";

let engine: NullEngine, scene: Scene;
const adapter = DOMAdapter.get();
beforeEach(() => {
  DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) as unknown as ReturnType<typeof adapter.createCanvas> });
  engine = new NullEngine(); scene = new Scene(engine);
});
afterEach(() => { vi.restoreAllMocks(); DOMAdapter.set(adapter); scene.dispose(); engine.dispose(); });

function fixture(mapId: string) {
  const base = rulesConfig("redesign"), state = createMatch(7001, playable({ ...base, terrain: { ...base.terrain!, mapId } }));
  const recorder = new SpectatorRecorder(state);
  const message = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
  const playback = new Playback(), frame = new Frame();
  playback.push(message, 0); expect(playback.sample(2000, frame)).toBe(true);
  return { message, frame };
}

describe.each(MAPS)("$name rocks on both boards", map => {
  // Every stream setup carries grid scale 2 and so encodes at the grid-scale stream version: a pre-rocks
  // (version 10/11) baseline reading of the projection is no longer possible. The water-only projection keeps that format.
  it("encodes a water-only projection without changing any candidate bytes or non-rock state", () => {
    const original = fixture(map.id).message;
    for (const lead of [undefined, { colony: 0 as const, startTick: 0, winTick: 100 }]) {
      const message = { ...original, full: { ...original.full!, territoryWin: lead } };
      const candidateBytes = encodeMessage(message), untouched = structuredClone(message);
      expect(candidateBytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
      const before = terrainPhaseFixture(message, "before");
      const beforeBytes = unpackMessages(packMessages([encodeMessage(before)]))[0]!;
      expect(beforeBytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
      const decoded = decodeMessage(beforeBytes);
      expect(decoded.full!.setup.terrain!.rocks).toBeUndefined();
      const { rocks: _rocks, ...waterOnly } = message.full.setup.terrain!;
      const expected = { ...message, full: { ...message.full, setup: { ...message.full.setup, terrain: waterOnly } } };
      expect(before).toEqual(expected);
      expect(decoded).toEqual(expected);
      const after = terrainPhaseFixture(message, "after");
      expect(after).toBe(message);
      expect(unpackMessages(packMessages([encodeMessage(after)]))[0]).toEqual(candidateBytes);
      expect(encodeMessage(message)).toEqual(candidateBytes);
      expect(message).toEqual(untouched);
      expect(after.full!.setup.terrain!.rocks).toEqual(untouched.full!.setup.terrain!.rocks);
      // The comparison uses these same candidate-derived dry coordinates on both sides.
      const mask = new WaterMask(message.full.setup.mapW, message.full.setup.mapH);
      mask.update(decoded.full!.setup.terrain);
      for (const [x, y] of dryControls(message)) expect(mask.data[(Math.floor(y) * message.full.setup.mapW + Math.floor(x)) * 4]).toBe(0);
    }
  });

  it("uploads streamed footprints/appearance, rebuilds same-name geometry, and clears old rocks", () => {
    const { message, frame } = fixture(map.id), setup = frame.board!.setup;
    const ground = new Ground(scene, setup.mapW, setup.mapH), rocks = new Rocks3D(scene, ground);
    const territory = new Territory(setup.mapW, setup.mapH, RenderTexture.create({ width: 10, height: 10 }), { w: 100, h: 100, ox: 0, oy: 0, tilePx: 1 });
    try {
      const writes = vi.spyOn(rocks.mesh, "setVerticesData");
      const uploads = vi.spyOn(territory.fill.shader!.resources.uWater, "update");
      rocks.update(frame); territory.update(frame, 0);
      expect(rocks.mesh.isEnabled()).toBe(true); expect(rocks.mesh.isPickable).toBe(false);
      expect(uploads).toHaveBeenCalledTimes(1);
      const positions = rocks.mesh.getVerticesData("position")!;
      const footprints = setup.terrain!.rocks!;
      expect(positions.length).toBe(footprints.length * 216);
      for (const [i, [x, y, w, h, appearance]] of footprints.entries()) {
        for (let at = i * 216; at < (i + 1) * 216; at += 3) {
          expect(positions[at]!).toBeGreaterThanOrEqual(x); expect(positions[at]!).toBeLessThanOrEqual(x + w);
          const ty = setup.mapH - positions[at + 2]!;
          expect(ty).toBeGreaterThanOrEqual(y); expect(ty).toBeLessThanOrEqual(y + h);
        }
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          const at = ((y + dy) * setup.mapW + x + dx) * 4;
          expect(Array.from(territory.water.data.slice(at, at + 4))).toEqual([0, w | (h << 4), dx | (dy << 4), appearance]);
        }
      }
      const writeCount = writes.mock.calls.length;
      rocks.update(frame); territory.update(frame, 1);
      expect(writes).toHaveBeenCalledTimes(writeCount); expect(uploads).toHaveBeenCalledTimes(1);
      const controls = dryControls(message);
      for (const [x, y] of controls) expect(territory.water.data[(Math.floor(y) * setup.mapW + Math.floor(x)) * 4 + 1]).toBe(0);
      expect(territory.fill.shader!.glProgram!.fragment).toContain(ROCK_GLSL);
      expect(territory.front.shader!.glProgram!.fragment).toContain("if (awRockAt(vUV) > 0.5) discard");

      const changed: NonNullable<StreamSetup["terrain"]> = { mapId: map.id, mapName: map.name, water: [], rocks: [[3, 4, 1, 3, 77]] };
      frame.board!.setup = { ...setup, terrain: changed };
      rocks.update(frame); territory.update(frame, 2);
      expect(rocks.mesh.getVerticesData("position")!.length).toBe(216);
      expect(Array.from(territory.water.data).filter((v, i) => i % 4 === 1 && v !== 0)).toHaveLength(3);
      const previous = [...rocks.mesh.getVerticesData("position")!];
      frame.board!.setup = { ...setup, terrain: { ...changed, rocks: [[3, 4, 1, 3, 15]] } };
      rocks.update(frame); territory.update(frame, 3);
      expect([...rocks.mesh.getVerticesData("position")!]).not.toEqual(previous);
      frame.board!.setup = { ...setup, terrain: undefined };
      rocks.update(frame); territory.update(frame, 4);
      expect(rocks.mesh.isEnabled()).toBe(false); expect(territory.water.data.every(v => v === 0)).toBe(true);
    } finally { territory.fill.destroy(); territory.frontLayer.destroy({ children: true }); }
  });
});

it("keeps before and after recording paths distinct and wires each client to its own encoded phase", () => {
  const names = new Set<string>();
  for (const map of MAPS) for (const scenario of ["ordinary", "spread-queens"] as const) for (const phase of ["before", "after"] as const) {
    const name = terrainRecordingName(map.id, 0, scenario, phase);
    expect(name).toBe(`terrain-${map.id}-0-${scenario}-${phase}`);
    names.add(name);
  }
  expect(names.size).toBe(MAPS.length * 4);
  const source = readFileSync("web/capture/terrain.ts", "utf8");
  expect(source).toContain("const name = terrainRecordingName(map.id, fixture.tick, scenario, phase)");
  expect(source).toContain("terrainPhaseFixture(fixture, phase), encoded = encodeMessage(phaseFixture)");
  expect(source).toContain('phase === "before" && streamVersion > TERRITORY_WIN_STREAM_VERSION');
  expect(source).toContain('phase === "after" ? packMessages([encodeMessage(fixture)]) : packMessages([encoded])');
  expect(source.indexOf('writeFileSync(join(RECORDING_DIR, `${name}.bin`)')).toBeLessThan(source.indexOf("const client = await openTerrainClient"));
  expect(source).toContain("{ recording: name, width, height");
  expect(source).toContain('phase === "after" ? { centres: rockCentres');
  expect(source).toContain("samplePixels(client, dryControls(fixture), \"tile\", true)");
});

it.each([2, 4])("keeps scaled rock footprints and every local coordinate at scale %i", (scale) => {
  const width = 3 * scale, height = scale, W = 32, H = 24;
  const terrain = { mapId: "fine", mapName: "Fine", water: [[0, 0, 1, 1]] as const,
    rocks: [[5, 7, width, height, 221]] as const };
  const mask = new WaterMask(W, H);
  mask.update(terrain);
  expect(mask.data[0]).toBe(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 4;
    const blocked = x >= 5 && x < 5 + width && y >= 7 && y < 7 + height;
    expect(mask.data[at + 1] !== 0).toBe(blocked);
    if (blocked) {
      expect(mask.data[at + 1]! & 15).toBe(width);
      expect(mask.data[at + 1]! >> 4).toBe(height);
      expect(mask.data[at + 2]! & 15).toBe(x - 5);
      expect(mask.data[at + 2]! >> 4).toBe(y - 7);
      expect(mask.data[at + 3]).toBe(221);
    }
  }
  const { frame } = fixture("open-field");
  frame.board!.setup = { ...frame.board!.setup, mapW: W, mapH: H, terrain };
  const ground = new Ground(scene, W, H), rocks = new Rocks3D(scene, ground);
  rocks.update(frame);
  expect(rocks.mesh.isEnabled()).toBe(true);
  expect(rocks.mesh.getVerticesData("position")).toHaveLength(216);
});

it("keeps rock clusters exact across tile boundaries in the existing RGBA terrain texture", () => {
  const mask = new WaterMask(4, 3), bytes = mask.data;
  const terrain = { mapId: "exact", mapName: "Exact", water: [[0, 0, 1, 1]] as const, rocks: [[1, 1, 3, 1, 221]] as const };
  expect(mask.update(terrain)).toBe(true);
  expect(bytes[0]).toBe(255); expect(bytes[1]).toBe(0);
  for (let dx = 0; dx < 3; dx++) expect(Array.from(bytes.slice((5 + dx) * 4, (6 + dx) * 4))).toEqual([0, 3 | (1 << 4), dx, 221]);
  mask.update({ ...terrain, rocks: [] });
  expect(mask.data).toBe(bytes);
  expect(Array.from(bytes).every((v, i) => i === 0 ? v === 255 : v === 0)).toBe(true);
  const main = readFileSync("web/src/board3d/main3d.ts", "utf8");
  expect(main).toContain("new Rocks3D(scene, ground)"); expect(main).toContain("rocks.update(shown)");
});

type Vec = readonly [number, number, number];
const vertex = (data: ArrayLike<number>, i: number): Vec => [data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centroid = (a: Vec, b: Vec, c: Vec): Vec => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
/** Babylon's front-face normal for triangle (a, b, c): VertexData.ComputeNormals' (a-b)x(c-b). */
const winding = (a: Vec, b: Vec, c: Vec): Vec => {
  const u = sub(a, b), v = sub(c, b);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

describe("3D rock faces point outward", () => {
  it("anchors the winding convention on Babylon's own front-facing box", () => {
    const box = CreateBox("winding-anchor", { size: 2 }, scene);
    const positions = box.getVerticesData("position")!, indices = box.getIndices()!;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [vertex(positions, indices[t]!), vertex(positions, indices[t + 1]!), vertex(positions, indices[t + 2]!)];
      expect(dot(winding(a, b, c), centroid(a, b, c))).toBeGreaterThan(0);
    }
  });

  /** Every triangle of every rock faces away from that rock's interior (vertex mean), by winding and by uploaded normal. */
  function expectOutward(rocks: Rocks3D, count: number) {
    const positions = rocks.mesh.getVerticesData("position")!, normals = rocks.mesh.getVerticesData("normal")!;
    expect(positions.length).toBe(count * 216);
    for (let rock = 0; rock < count; rock++) {
      const first = rock * 72, interior: [number, number, number] = [0, 0, 0];
      for (let v = first; v < first + 72; v++) for (let k = 0; k < 3; k++) interior[k] += positions[v * 3 + k]! / 72;
      for (let v = first; v < first + 72; v += 3) {
        const [a, b, c] = [vertex(positions, v), vertex(positions, v + 1), vertex(positions, v + 2)];
        const out = sub(centroid(a, b, c), interior);
        expect(dot(winding(a, b, c), out), `rock ${rock} triangle ${(v - first) / 3}`).toBeGreaterThan(0);
        for (let k = 0; k < 3; k++) expect(dot(vertex(normals, v + k), out), `rock ${rock} normal ${v - first + k}`).toBeGreaterThan(0);
      }
    }
  }

  it.each(MAPS)("on every streamed rock of $name, mirrored and unmirrored", map => {
    const { frame } = fixture(map.id), setup = frame.board!.setup, footprints = setup.terrain!.rocks!;
    expect(footprints.some(r => (r[4] & 128) !== 0)).toBe(true);
    expect(footprints.some(r => (r[4] & 128) === 0)).toBe(true);
    const rocks = new Rocks3D(scene, new Ground(scene, setup.mapW, setup.mapH));
    rocks.update(frame);
    expectOutward(rocks, footprints.length);
  });

  it("for mirrored and unmirrored rocks across rotations, scales and footprint sizes", () => {
    const { frame } = fixture("open-field"), W = 96, H = 64;
    const list: [number, number, number, number, number][] = [];
    for (let appearance = 0; appearance < 256; appearance += 5) {
      const n = list.length;
      list.push([1 + (n % 10) * 8, 1 + Math.floor(n / 10) * 8, 1 + n % 6, 1 + n % 4, appearance]);
    }
    expect(list.every(([x, y, w, h]) => x + w <= W && y + h <= H)).toBe(true);
    expect(list.some(r => (r[4] & 128) !== 0) && list.some(r => (r[4] & 128) === 0)).toBe(true);
    frame.board!.setup = { ...frame.board!.setup, mapW: W, mapH: H, terrain: { mapId: "winding", mapName: "Winding", water: [], rocks: list } };
    const rocks = new Rocks3D(scene, new Ground(scene, W, H));
    rocks.update(frame);
    expectOutward(rocks, list.length);
  });
});
