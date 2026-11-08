/**
 * Workers, soldiers and corpses use 912 triangles at every quality tier.
 * NullEngine proves geometry and preserved instance state; WebGL stills prove pixels.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Frame } from "../../web/src/buffer.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { TIERS } from "../../web/src/board3d/quality.ts";

/** Shared tessellation for workers, soldiers and corpses. */
const LITE = 912;

let engine: NullEngine;
let scene: Scene;
let ground: Ground;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  ground = new Ground(scene, 8, 8);
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

function mesh(name: string): Mesh {
  const found = scene.getMeshByName(name);
  expect(found).toBeInstanceOf(Mesh);
  return found as Mesh;
}

const triangles = (name: string) => mesh(name).getTotalIndices() / 3;

/** Both colonies' workers and soldiers, some squad ants tinted toward their agent's hue. */
function mixedFrame(): Frame {
  const frame = new Frame();
  const n = 12;
  frame.ensure(n);
  frame.count = n;
  for (let i = 0; i < n; i++) {
    frame.id[i] = i + 1;
    frame.x[i] = 1 + (i % 4) * 1.5;
    frame.y[i] = 1 + Math.floor(i / 4) * 2;
    frame.rotation[i] = i * 0.4;
    frame.alpha[i] = 1;
    frame.colony[i] = i % 2;
    frame.caste[i] = i % 3 === 0 ? 1 : 0;
    frame.agent[i] = i % 4 === 0 ? 0 : -1;
  }
  return frame;
}

const PER_INSTANCE = [VertexBuffer.ColorInstanceKind, "aWalk", "aBite", "aHead"];

/** What the herds draw per instance: count, matrices, colour, walk, bite and head, each still attached to the mesh. */
function instances(name: string) {
  const m = mesh(name);
  const storage = (m as unknown as { _userThinInstanceBuffersStorage: { data: Record<string, Float32Array>; strides: Record<string, number>; vertexBuffers: Record<string, VertexBuffer> } })._userThinInstanceBuffersStorage;
  const perInstance: Record<string, number[]> = {};
  for (const kind of PER_INSTANCE) {
    expect(m.getVertexBuffer(kind), `${name} ${kind} attached`).toBe(storage.vertexBuffers[kind]);
    perInstance[kind] = Array.from(storage.data[kind]!.subarray(0, m.thinInstanceCount * storage.strides[kind]!));
  }
  return {
    count: m.thinInstanceCount,
    matrices: m.thinInstanceGetWorldMatrices().map((x) => Array.from(x.asArray())),
    perInstance,
  };
}

/** The distinct vertex colours of a herd's source geometry: the worker's body colours. */
function palette(name: string): string[] {
  const c = mesh(name).getVerticesData(VertexBuffer.ColorKind)!;
  const set = new Set<string>();
  for (let i = 0; i < c.length; i += 4) set.add(`${c[i]!.toFixed(4)},${c[i + 1]!.toFixed(4)},${c[i + 2]!.toFixed(4)}`);
  return [...set].sort();
}

describe("3D worker mesh by quality tier", () => {
  it("leaves every render-quality setting unchanged", () => {
    expect(TIERS.map(({ msaa, shadowMap, shadows, bloom, scale }) => ({ msaa, shadowMap, shadows, bloom, scale }))).toEqual([
      { msaa: 4, shadowMap: 2048, shadows: true, bloom: true, scale: 1 },
      { msaa: 1, shadowMap: 1024, shadows: true, bloom: true, scale: 1 },
      { msaa: 1, shadowMap: 1024, shadows: false, bloom: false, scale: 0.75 },
      { msaa: 1, shadowMap: 1024, shadows: false, bloom: false, scale: 0.5 },
    ]);
  });

  it("draws 912-triangle workers, soldiers and corpses at every tier", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    // Before any tier is applied, workers already have the shared geometry.
    for (const herd of ["ants0", "ants1"]) expect(triangles(herd)).toBe(LITE);
    TIERS.forEach((_tier, i) => {
      for (const herd of ["ants0", "ants1"]) expect(triangles(herd), `${herd} at tier ${i}`).toBe(LITE);
      for (const herd of ["corpses0", "corpses1"]) expect(triangles(herd), `${herd} at tier ${i}`).toBe(LITE);
      // Soldiers keep their existing geometry at every tier.
      for (const herd of ["soldiers0", "soldiers1"]) expect(triangles(herd), `${herd} at tier ${i}`).toBe(LITE);
    });
  });

  it("switches both ways (1→2→1 and 0→3→0) without changing ant count, positions or colours", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const frame = mixedFrame();
    const herds = ["ants0", "ants1", "soldiers0", "soldiers1"];
    for (const path of [[1, 2, 1], [0, 3, 0]]) {
      ants.update(frame, -1, [0x33aaff]);
      const before = herds.map(instances);
      const colours = ["ants0", "ants1"].map(palette);
      expect(before.reduce((s, h) => s + h.count, 0)).toBe(frame.count);
      for (const herd of ["ants0", "ants1"]) expect(triangles(herd)).toBe(LITE);

      ants.update(frame, -1, [0x33aaff]);
      for (const herd of ["ants0", "ants1"]) expect(triangles(herd), `${herd} at tier ${path[1]}`).toBe(LITE);
      expect(herds.map(instances)).toEqual(before);
      expect(["ants0", "ants1"].map(palette)).toEqual(colours);

      ants.update(frame, -1, [0x33aaff]);
      for (const herd of ["ants0", "ants1"]) expect(triangles(herd), `${herd} back at tier ${path[2]}`).toBe(LITE);
      expect(herds.map(instances)).toEqual(before);
      expect(["ants0", "ants1"].map(palette)).toEqual(colours);
    }
  });
});
