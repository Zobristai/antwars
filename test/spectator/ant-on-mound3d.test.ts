import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { SUB_TILE, type StreamQueen } from "../../src/live/format.ts";
import { Frame } from "../../web/src/buffer.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";

// Constructed frames and queens only, never a generated match: on the 3D board an ant on a nest stands on its mound.
let engine: NullEngine, scene: Scene;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); });
afterEach(() => { scene.dispose(); engine.dispose(); });

const SCALE = 2, MAP = 48, L = 0.5;
// Two mounds that overlap (as at a colony's two nests) and one apart; tiles.
const sites: [number, number][] = [[16.5, 20.5], [16.5, 16.5], [36.5, 36.5]];
const queens = (lost: (number | null)[] = [null, null, null]): StreamQueen[] => sites.map(([x, y], i) => ({
  id: i === 2 ? 0 : i, colony: (i === 2 ? 1 : 0) as 0 | 1, x: x * SUB_TILE, y: y * SUB_TILE, foundedTick: 0, lostTick: lost[i]!, overrun: 0,
}));

function board() {
  const ground = new Ground(scene, MAP, MAP, SCALE);
  const ants = new Ants3D(scene, ground, L, COLONY_RGB);
  const nests = new Nests(scene, ground, { queens: [[sites[0]![0] * SUB_TILE, sites[0]![1] * SUB_TILE], [sites[2]![0] * SUB_TILE, sites[2]![1] * SUB_TILE]] }, L, COLONY_RGB);
  nests.update(queens());
  return { ground, ants, nests };
}

/** The drawn mound meshes' highest surface (world y) under tile tx, ty, by a ray cast down onto the meshes themselves; -Infinity off every mound. */
function moundTop(ground: Ground, tx: number, ty: number): number {
  const ray = new Ray(new Vector3(tx, 100, ground.mapH - ty), new Vector3(0, -1, 0), 200);
  let top = -Infinity;
  for (const mesh of scene.meshes) {
    if (!mesh.name.startsWith("mound") || !mesh.isEnabled()) continue;
    const hit = ray.intersectsMesh(mesh as Mesh);
    if (hit.hit) top = Math.max(top, hit.pickedPoint!.y);
  }
  return top;
}

/** The highest drawn mound surface anywhere under a body of horizontal half-extent reach at tx, ty. */
function footprintTop(ground: Ground, tx: number, ty: number, reach: number): number {
  let top = moundTop(ground, tx, ty);
  for (const r of [reach / 2, reach]) for (let a = 0; a < 16; a++) {
    top = Math.max(top, moundTop(ground, tx + r * Math.cos(a * Math.PI / 8), ty + r * Math.sin(a * Math.PI / 8)));
  }
  return top;
}

function frameOf(points: readonly (readonly [number, number, 0 | 1])[]): Frame {
  const frame = new Frame(); frame.ensure(points.length); frame.count = points.length;
  points.forEach(([x, y, caste], i) => {
    frame.id[i] = i + 1; frame.x[i] = x; frame.y[i] = y; frame.rotation[i] = i * 0.7;
    frame.alpha[i] = 1; frame.agent[i] = -1; frame.colony[i] = 1; frame.caste[i] = caste;
  });
  return frame;
}

/** Each drawn instance's height (world y), read from the herd's live matrix buffer. */
function heights(name: string): number[] {
  const mesh = scene.getMeshByName(name) as Mesh, data = mesh._thinInstanceDataStorage.matrixData!;
  return Array.from({ length: mesh.thinInstanceCount }, (_, k) => data[k * 16 + 13]!);
}

// On the nest centre, mid-slope, near the rim, in the two mounds' overlap.
const onMound: [number, number][] = [[16.5, 20.5], [17.5, 20.5], [16.5, 23.4], [19.6, 21.5], [16.5, 18.5], [17.4, 18.4]];
const offMound: [number, number][] = [[4, 4], [30, 10], [10, 40]];

describe("3D ants on nest mounds", () => {
  it("draws workers and soldiers on a nest with their whole body on the mound's surface, and off a nest exactly as before", () => {
    const { ground, ants } = board();
    const points = [...onMound, ...offMound];
    ants.update(frameOf([...points.map(([x, y]) => [x, y, 0] as const), ...points.map(([x, y]) => [x, y, 1] as const)]));
    for (const [name, size] of [["ants1", L], ["soldiers1", L * 2]] as const) {
      const ys = heights(name);
      expect(ys).toHaveLength(points.length);
      onMound.forEach(([x, y], i) => {
        const top = footprintTop(ground, x, y, size * 0.55);
        expect(top, `mound under ${x},${y}`).toBeGreaterThan(ground.heightAt(x, y));
        expect(ys[i]!, `${name} at ${x},${y}`).toBeGreaterThanOrEqual(top);
        // On the surface, not floating: within the mesh's facet error of the highest point under the body.
        expect(ys[i]! - top, `${name} at ${x},${y}`).toBeLessThan(0.15 * SCALE);
      });
      offMound.forEach(([x, y], j) => {
        expect(moundTop(ground, x, y)).toBe(-Infinity);
        expect(ys[onMound.length + j]).toBeCloseTo(ground.heightAt(x, y) + 0.02, 5);
      });
    }
  });

  it("lays a corpse on a nest above the mound's surface", () => {
    const { ground, ants } = board();
    const frame = frameOf([]);
    frame.corpses = onMound.map(([x, y], i) => ({ antId: 100 + i, colony: 1 as const, x, y, heading: 0, ageMs: 0 }));
    ants.update(frame);
    heights("corpses1").forEach((y, i) => {
      const [x, z] = onMound[i]!;
      expect(y).toBeGreaterThanOrEqual(footprintTop(ground, x, z, L * 0.55) + L * 0.36);
    });
  });

  it("keeps ants on a lost queen's nest, which stays drawn, and drops a nest no longer listed", () => {
    const { ground, ants, nests } = board();
    const at = [[36.5, 36.5, 0], [16.5, 20.5, 0]] as const;
    nests.update(queens([null, null, 900]));
    ants.update(frameOf(at));
    expect(heights("ants1")[0]!).toBeGreaterThanOrEqual(footprintTop(ground, 36.5, 36.5, L * 0.55));
    nests.update(queens().slice(0, 2));
    ants.update(frameOf(at));
    expect(heights("ants1")[0]).toBeCloseTo(ground.heightAt(36.5, 36.5) + 0.02, 5);
    expect(heights("ants1")[1]!).toBeGreaterThanOrEqual(footprintTop(ground, 16.5, 20.5, L * 0.55));
    nests.update(queens());
    ants.update(frameOf(at));
    expect(heights("ants1")[0]!).toBeGreaterThanOrEqual(footprintTop(ground, 36.5, 36.5, L * 0.55));
  });

  it("leaves the mound meshes and the relief query unchanged", () => {
    const { ground, nests } = board();
    const mound = scene.getMeshByName("mound0") as Mesh;
    const box = mound.getBoundingInfo().boundingBox;
    expect(box.maximumWorld.x - box.minimumWorld.x).toBeCloseTo(1.7 * 2 * SCALE, 3);
    expect(box.maximumWorld.y - mound.position.y).toBeCloseTo(0.55 * SCALE, 3);
    expect(mound.position.y).toBeCloseTo(ground.heightAt(16.5, 20.5) - 0.05 * SCALE, 5);
    const before = ground.heightAt(16.5, 20.5);
    nests.update(queens());
    expect(ground.heightAt(16.5, 20.5)).toBe(before);
    expect(ground.standAt(16.5, 20.5)).toBeCloseTo(before - 0.05 * SCALE + 0.55 * SCALE, 5);
  });
});
