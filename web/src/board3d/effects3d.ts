/** Bounded non-additive contact sparks at the ant renderer's head contacts. */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { type Frame } from "../buffer.ts";
import type { Ground } from "./ground.ts";
import { renderedBiteContacts } from "../bite.ts";


class Burst {
  matrices = new Float32Array(0);
  colors = new Float32Array(0);
  capacity = 0;
  readonly mesh: Mesh;
  constructor(scene: Scene, mesh: Mesh, mapW: number, mapH: number, additive = true) {
    this.mesh = mesh;
    const mat = new StandardMaterial(`${mesh.name}-mat`, scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    mat.alpha = 0.999;
    mat.disableDepthWrite = true;
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.ensure(64);
    mesh.thinInstanceCount = 0;
    // An empty thin-instance mesh draws its source geometry without instancing instead.
    mesh.setEnabled(false);
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-8, -4, -8), new Vector3(mapW + 8, 4, mapH + 8)));
    mesh.doNotSyncBoundingInfo = true;
  }
  ensure(n: number) {
    if (n <= this.capacity) return;
    const cap = Math.max(n, this.capacity * 2);
    this.matrices = new Float32Array(cap * 16);
    this.colors = new Float32Array(cap * 4);
    this.capacity = cap;
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
  }
  put(k: number, x: number, y: number, z: number, s: number, r: number, g: number, b: number, alpha = 1) {
    const m = this.matrices;
    const o = k * 16;
    m.fill(0, o, o + 16);
    m[o] = s;
    m[o + 5] = s;
    m[o + 10] = s;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const c = k * 4;
    this.colors[c] = r; this.colors[c + 1] = g; this.colors[c + 2] = b; this.colors[c + 3] = alpha;
  }
  commit(n: number) {
    this.mesh.thinInstanceCount = n;
    if (n > 0) {
      this.mesh.thinInstanceBufferUpdated("matrix");
      this.mesh.thinInstanceBufferUpdated("color");
    }
    // Keep the layer's isVisible switch independent of whether there is anything to draw.
    this.mesh.setEnabled(n > 0);
  }
}

export class Battles3D {
  private flash: Burst;
  private ring: Burst;
  private sparks: Burst;
  private readonly ground: Ground;

  constructor(scene: Scene, ground: Ground) {
    this.ground = ground;
    const disc = CreateDisc("flash", { radius: 1, tessellation: 20 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.bakeCurrentTransformIntoVertices();
    const torus = CreateTorus("ring", { diameter: 2, thickness: 0.12, tessellation: 28 }, scene);
    const spark = CreateDisc("fight-sparks", { radius: 1, tessellation: 8 }, scene);
    spark.rotation.x = Math.PI / 2;
    spark.bakeCurrentTransformIntoVertices();
    spark.hasVertexAlpha = true;
    this.sparks = new Burst(scene, spark, ground.mapW, ground.mapH, false);
    this.flash = new Burst(scene, disc, ground.mapW, ground.mapH);
    this.ring = new Burst(scene, torus, ground.mapW, ground.mapH);
  }

  setVisible(on: boolean) {
    this.flash.mesh.isVisible = this.ring.mesh.isVisible = this.sparks.mesh.isVisible = on;
  }

  update(frame: Frame, tilePx = 10) {
    const points = renderedBiteContacts(frame);
    this.sparks.ensure(points.length);
    const radius = Math.min(0.035, 1.5 / Math.max(tilePx, 1));
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      this.sparks.put(i, p.x, this.ground.heightAt(p.x, p.y) + 0.09, this.ground.mapH - p.y,
        radius, 0.55, 0.42, 0.22, 0.6);
    }
    // Source meshes must remain disabled: additive discs/rings hid the ants.
    this.flash.commit(0); this.ring.commit(0); this.sparks.commit(points.length);
  }
}
