import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { StreamQueen } from "../../src/live/format.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { Nests } from "../../web/src/board3d/nests.ts";

let engine: NullEngine, scene: Scene;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); });
afterEach(() => { scene.dispose(); engine.dispose(); });
const queens: StreamQueen[] = [0, 1].map(colony => ({ id: 0, colony: colony as 0 | 1,
  x: (2 + colony * 4) * 256, y: (2 + colony * 4) * 256, foundedTick: 0, lostTick: null, overrun: 0 }));
function fixture(length: number) {
  return new Nests(scene, new Ground(scene, 8, 8), { queens: [[512, 512], [1536, 1536]] }, length, COLONY_RGB);
}
function expectLength(queen: Mesh, antLength: number) {
  for (const value of queen.scaling.asArray()) expect(value).toBeCloseTo(antLength * 2.4, 8);
  const scale = new Vector3();
  queen.getWorldMatrix().decompose(scale);
  // Babylon's cached matrices use Float32 storage: compare relative scale at that precision.
  for (const value of scale.asArray()) expect(value / (antLength * 2.4)).toBeCloseTo(1, 6);
  expect(queen.isWorldMatrixFrozen).toBe(true);
}

it("rescales every frozen queen after layout settles and on repeated viewport changes without rebuilding nests", () => {
  const nests = fixture(11.4);
  const casters = [...nests.casters];
  const nestMeshes = scene.meshes.filter(mesh => !casters.includes(mesh as Mesh));
  const nestMatrices = nestMeshes.map(mesh => mesh.getWorldMatrix().asArray().slice());
  const poses = casters.map(mesh => ({ position: mesh.position.asArray(), rotation: mesh.rotation.asArray(), material: mesh.material }));
  casters.forEach(queen => expectLength(queen, 11.4));
  for (const length of [0.4, 0.7, 0.7, 0.25]) {
    nests.lengthTiles = length;
    expect(nests.lengthTiles).toBe(length);
    expect(nests.casters).toEqual(casters);
    casters.forEach((queen, index) => {
      expectLength(queen, length);
      expect(queen.position.asArray()).toEqual(poses[index]!.position);
      expect(queen.rotation.asArray()).toEqual(poses[index]!.rotation);
      expect(queen.material).toBe(poses[index]!.material);
    });
    nestMeshes.forEach((mesh, index) => expect(mesh.getWorldMatrix().asArray()).toEqual(nestMatrices[index]));
  }
});

it("uses the latest ant length for mid-match founding and for lost or absent queens restored later", () => {
  const nests = fixture(8);
  const extra = { ...queens[0]!, id: 1, x: 4 * 256, y: 3 * 256, foundedTick: 100 };
  nests.lengthTiles = 0.4;
  nests.update([...queens, extra]);
  expect(nests.casters).toHaveLength(3);
  nests.casters.forEach(queen => expectLength(queen, 0.4));
  nests.update([...queens, { ...extra, lostTick: 200 }]);
  expect(nests.casters[2]!.isEnabled()).toBe(false);
  nests.lengthTiles = 0.6;
  nests.update([]);
  nests.lengthTiles = 0.3;
  nests.casters.forEach(queen => expectLength(queen, 0.3));
  nests.update([...queens, extra]);
  nests.casters.forEach(queen => { expectLength(queen, 0.3); expect(queen.isEnabled()).toBe(true); });
  nests.lengthTiles = 0.5;
  const moved = { ...extra, x: extra.x + 256, y: extra.y + 256 };
  nests.update([...queens, moved]);
  nests.casters.forEach(queen => expectLength(queen, 0.5));
});

it("updates nests from the same current ant length in both production refit paths", () => {
  const source = readFileSync("web/src/board3d/main3d.ts", "utf8");
  for (const [start, end] of [["const refit =", "let areaStale"], ["const refitArea =", "let frame ="]]) {
    const body = source.slice(source.indexOf(start!), source.indexOf(end!));
    expect(body).toMatch(/ants\.lengthTiles = antScale\(\);\s*nests\.lengthTiles = ants\.lengthTiles;/);
  }
});
