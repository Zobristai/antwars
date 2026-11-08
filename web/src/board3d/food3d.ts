/** 3D food, from the same amount/placement rules as the 2D board. One reusable thin-instance
 * batch for all crumbs, not a mesh per tile. No shadows or post effects added to the phone budget. */
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Frame } from "../buffer.ts";
import { FOOD, FOOD_SHADE, crumbRadiusPx, foodPiles, pileCrumbs, pileGrowth, type Pile } from "../food.ts";
import { buildCrumbGeometry, writeMatrix } from "./ants3d.ts";
import type { Ground } from "./ground.ts";

export class Food3D {
  readonly mesh: Mesh;
  readonly piles: Pile[] = [];
  /** Stable placement records, computed once by the shared 2D rule for every board tile. */
  private readonly tilePiles: Pile[];
  private crumbCount = 0;
  private matrices = new Float32Array(0);
  private capacity = 0;
  private drawn: Uint32Array | null = null;
  private radius = 0;

  constructor(scene: Scene, private readonly ground: Ground) {
    this.mesh = new Mesh("food-piles", scene);
    buildCrumbGeometry().applyToMesh(this.mesh, false);
    this.tilePiles = foodPiles(new Uint8Array(ground.mapW * ground.mapH).fill(1), ground.mapW);
    const material = new StandardMaterial("food-piles", scene);
    material.diffuseColor = Color3.FromHexString(`#${FOOD.toString(16).padStart(6, "0")}`);
    material.emissiveColor = Color3.FromHexString(`#${FOOD_SHADE.toString(16).padStart(6, "0")}`);
    material.specularColor = new Color3(0.18, 0.2, 0.12);
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.setBoundingInfo(new BoundingInfo(new Vector3(-8, -4, -8), new Vector3(ground.mapW + 8, 8, ground.mapH + 8)));
    this.mesh.doNotSyncBoundingInfo = true;
    this.ensure(64);
    this.mesh.thinInstanceCount = 0;
    this.mesh.setEnabled(false);
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2);
    this.matrices = new Float32Array(this.capacity * 16);
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
  }

  /** tilePx at the camera target: the same 1.6..4 CSS px crumb floor/cap as 2D.
   * A new board food array includes harvesting, regrowth and corpse food in that frame. */
  update(frame: Pick<Frame, "board">, tilePx: number): void {
    const food = frame.board?.food ?? null;
    const scale = this.ground.physicalScale;
    const radius = crumbRadiusPx(tilePx * scale) / Math.max(tilePx, 1 / scale);
    if (food === this.drawn && Math.abs(radius - this.radius) < 0.0001) return;
    if (food !== this.drawn) {
      this.piles.length = 0;
      this.crumbCount = 0;
      if (food) for (let tile = 0; tile < food.length; tile++) {
        const amount = food[tile]!;
        if (amount <= 0) continue;
        const p = this.tilePiles[tile]!;
        p.crumbs = pileCrumbs(amount);
        p.growth = pileGrowth(amount);
        this.piles.push(p);
        this.crumbCount += p.crumbs;
      }
    }
    this.drawn = food;
    this.radius = radius;
    const count = this.crumbCount;
    this.ensure(count);
    let at = 0;
    for (const p of this.piles) {
      const r = radius * p.growth;
      for (let j = 0; j < p.crumbs; j++) {
        // Same stable golden-angle cluster as food.ts, oriented by its tile hash.
        const d = j === 0 ? 0 : (8.5 / 7) * Math.sqrt(j) * r;
        const angle = j * 2.4 + p.rotation;
        const x = p.x + Math.cos(angle) * d;
        const y = p.y + Math.sin(angle) * d;
        writeMatrix(this.matrices, at++ * 16, r, angle, x, this.ground.heightAt(x, y) + r + 0.03, this.ground.mapH - y, false);
      }
    }
    this.mesh.thinInstanceCount = count;
    if (count > 0) this.mesh.thinInstanceBufferUpdated("matrix");
    this.mesh.setEnabled(count > 0);
  }
}
