/** Bounded non-additive contact sparks at the ant renderer's head contacts (air fights lifted to their flyers and ringed), and flyers' take-off and landing moments. */
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
import { FLIGHT_MOMENT_MS, type Frame } from "../buffer.ts";
import type { Ground } from "./ground.ts";
import { airFights, fightPairKey, renderedBiteContactPairs, renderedBiteContacts } from "../bite.ts";
import { reducedMotion } from "../camera.ts";
import { FLIGHT_RING, flightMoment, flightTint } from "../effects.ts";
import { AIR_LIFT_3D_TILES } from "../flyer-lift.ts";

/** Above the ground at a contact, in tiles: where a ground fight's spark sits. An air fight's sits AIR_LIFT_3D_TILES higher. */
const SPARK_HEIGHT = 0.09;
/** An air fight's ring on the 3D board: a flat pale ring around the fight at its flyers' height, radius in tiles. */
export const AIR_RING_3D = { r: 0.32, rgb: [0.88, 0.95, 1], alpha: 0.85 } as const;


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

/**
 * Ground fights: a small dim spark at each head contact. A fight between two airborne flyers
 * (bite.ts airFights) is drawn AIR_LIFT_3D_TILES above the ground, where their bodies are:
 * a brighter pale spark at their heads' contact and a flat ring around them for as long as
 * they stay engaged; its spark is never drawn on the ground.
 */
export class Battles3D {
  private flash: Burst;
  private ring: Burst;
  private sparks: Burst;
  private airRing: Burst;
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
    const airTorus = CreateTorus("air-fight-ring", { diameter: 2, thickness: 0.24, tessellation: 28 }, scene);
    airTorus.hasVertexAlpha = true;
    this.airRing = new Burst(scene, airTorus, ground.mapW, ground.mapH, false);
  }

  setVisible(on: boolean) {
    this.flash.mesh.isVisible = this.ring.mesh.isVisible = this.sparks.mesh.isVisible = this.airRing.mesh.isVisible = on;
  }

  update(frame: Frame, tilePx = 10) {
    const points = renderedBiteContacts(frame), pairs = renderedBiteContactPairs(frame);
    const air = airFights(frame);
    this.sparks.ensure(points.length);
    const radius = Math.min(0.035, 1.5 / Math.max(tilePx, 1));
    const airRadius = Math.min(0.05, 2 / Math.max(tilePx, 1));
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (air.size > 0 && air.has(fightPairKey(pairs[i]![0], pairs[i]![1]))) {
        this.sparks.put(i, p.x, this.ground.heightAt(p.x, p.y) + SPARK_HEIGHT + AIR_LIFT_3D_TILES, this.ground.mapH - p.y,
          airRadius, 0.92, 0.96, 1, 0.95);
      } else {
        this.sparks.put(i, p.x, this.ground.heightAt(p.x, p.y) + SPARK_HEIGHT, this.ground.mapH - p.y,
          radius, 0.55, 0.42, 0.22, 0.6);
      }
    }
    this.airRing.ensure(air.size);
    let rings = 0;
    for (const f of air.values()) {
      const [r, g, b] = AIR_RING_3D.rgb;
      this.airRing.put(rings++, f.x, this.ground.heightAt(f.x, f.y) + SPARK_HEIGHT + AIR_LIFT_3D_TILES, this.ground.mapH - f.y,
        AIR_RING_3D.r, r, g, b, AIR_RING_3D.alpha);
    }
    // Source meshes must remain disabled: additive discs/rings hid the ants.
    this.flash.commit(0); this.ring.commit(0); this.sparks.commit(points.length); this.airRing.commit(rings);
  }
}

/**
 * Each flyer's take-offs and landings (Frame.flights) as the 2D board's moments (effects.ts flightMoment): a ring on the
 * ground around the point, and a take-off's dot, sized in CSS px through the camera's tile size, blended normally so the
 * ants stay in front of them.
 */
export class FlightMoments3D {
  private readonly rings: Burst;
  private readonly dots: Burst;
  private readonly ground: Ground;
  /** Moments drawn this frame. */
  shown = 0;

  constructor(scene: Scene, ground: Ground) {
    this.ground = ground;
    const ring = CreateTorus("flight-rings", { diameter: 2, thickness: 0.12, tessellation: 32 }, scene);
    const dot = CreateDisc("flight-dots", { radius: 1, tessellation: 12 }, scene);
    dot.rotation.x = Math.PI / 2;
    dot.bakeCurrentTransformIntoVertices();
    // Each moment fades by its instance colour's alpha.
    ring.hasVertexAlpha = dot.hasVertexAlpha = true;
    this.rings = new Burst(scene, ring, ground.mapW, ground.mapH, false);
    this.dots = new Burst(scene, dot, ground.mapW, ground.mapH, false);
  }

  setVisible(on: boolean) {
    this.rings.mesh.isVisible = this.dots.mesh.isVisible = on;
  }

  update(frame: Pick<Frame, "flights">, tilePx = 10, reduced = reducedMotion()) {
    const tile = 1 / Math.max(tilePx, 1);
    let rings = 0, dots = 0;
    this.rings.ensure(frame.flights.length);
    this.dots.ensure(frame.flights.length);
    for (const f of frame.flights) {
      if (f.ageMs < 0 || f.ageMs >= FLIGHT_MOMENT_MS) continue;
      const s = flightMoment(f.kind, f.ageMs, reduced);
      const tint = flightTint(f.colony);
      const r = ((tint >> 16) & 255) / 255, g = ((tint >> 8) & 255) / 255, b = (tint & 255) / 255;
      const y = this.ground.heightAt(f.x, f.y) + 0.06, z = this.ground.mapH - f.y;
      this.rings.put(rings++, f.x, y, z, s.radius * tile, r, g, b, s.ring);
      if (s.dot > 0) this.dots.put(dots++, f.x, y + 0.01, z, FLIGHT_RING.dot * tile, r, g, b, s.dot);
    }
    this.shown = rings;
    this.rings.commit(rings);
    this.dots.commit(dots);
  }
}
