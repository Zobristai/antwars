/** Static streamed boulders. One non-pickable mesh, rebuilt only when terrain changes.
 * No map/seed lookup, shadows, actors or obstacles outside the playable board; the board look
 * (board-look.ts) recolours them and lets them cast shadows (main3d.ts). */
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Frame } from "../buffer.ts";
import type { StreamTerrain } from "../terrain.ts";
import type { Ground } from "./ground.ts";

type Point = readonly [number, number, number];
const OUTLINE = [[0.15, 0], [0.8, 0], [1, 0.2], [1, 0.82], [0.78, 1], [0.18, 1], [0, 0.78], [0, 0.2]] as const;

/** Current's boulder colour. */
const ROCK_RGB = [0.36, 0.38, 0.4] as const;

export class Rocks3D {
  readonly mesh: Mesh;
  private terrain: StreamTerrain;
  private readonly material: StandardMaterial;

  constructor(scene: Scene, private readonly ground: Ground) {
    this.mesh = new Mesh("rock-obstacles", scene);
    const material = new StandardMaterial("rock-obstacles", scene);
    material.diffuseColor = new Color3(...ROCK_RGB);
    material.specularColor = new Color3(0.04, 0.04, 0.04);
    this.material = material;
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = true;
    this.mesh.setEnabled(false);
  }

  /** The board look's boulder colour (board-look.ts), or the plain one with none. */
  setColour(rgb: readonly [number, number, number] | null): void {
    const [r, g, b] = rgb ?? ROCK_RGB;
    this.material.diffuseColor.set(r, g, b);
  }

  update(frame: Pick<Frame, "board">): void {
    const terrain = frame.board?.setup.terrain;
    if (terrain === this.terrain) return;
    this.terrain = terrain;
    const positions: number[] = [], indices: number[] = [], normals: number[] = [];
    const face = (a: Point, b: Point, c: Point) => {
      const start = positions.length / 3;
      positions.push(...a, ...b, ...c); indices.push(start, start + 1, start + 2);
    };
    for (const [x, y, width, height, appearance] of terrain?.rocks ?? []) {
      // Wire geometry is authoritative. Invalid/outside footprints are never drawn as scenery.
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height) ||
          width < 1 || height < 1 || width > 15 || height > 15 ||
          x < 0 || y < 0 || x + width > this.ground.mapW || y + height > this.ground.mapH) continue;
      const angle = (appearance & 31) * 2 * Math.PI / 32;
      const scale = 0.86 + ((appearance >> 5) & 3) * 0.14 / 3;
      const mirrored = (appearance & 128) !== 0;
      const project = (dx: number, dy: number, rise: number): Point => {
        const rx = (dx * Math.cos(angle) - dy * Math.sin(angle)) * scale * 0.72;
        const ry = (dx * Math.sin(angle) + dy * Math.cos(angle)) * scale * 0.72;
        const px = x + (0.5 + (mirrored ? -rx : rx)) * width, py = y + (0.5 + ry) * height;
        return [px, this.ground.heightAt(px, py) + rise * scale * this.ground.physicalScale, this.ground.mapH - py];
      };
      const base = OUTLINE.map(([dx, dy]) => project(dx - 0.5, dy - 0.5, 0.02));
      const top = OUTLINE.map(([dx, dy]) => project((dx - 0.5) * 0.58, (dy - 0.5) * 0.58, 0.48));
      const peak = project(-0.06, -0.07, 0.67);
      for (let i = 0; i < base.length; i++) {
        const j = (i + 1) % base.length;
        // Outer faces must be front-facing for Babylon's culling. z = mapH - py reflects the outline once
        // and a mirrored rock reflects it again, so each case takes the opposite winding.
        if (mirrored) {
          face(base[i]!, base[j]!, top[i]!);
          face(base[j]!, top[j]!, top[i]!);
          face(top[i]!, top[j]!, peak);
        } else {
          face(base[j]!, base[i]!, top[i]!);
          face(top[j]!, base[j]!, top[i]!);
          face(top[j]!, top[i]!, peak);
        }
      }
    }
    if (positions.length > 0) {
      const data = new VertexData();
      VertexData.ComputeNormals(positions, indices, normals);
      data.positions = positions; data.indices = indices; data.normals = normals;
      data.applyToMesh(this.mesh, true);
    }
    this.mesh.setEnabled(positions.length > 0);
  }
}
