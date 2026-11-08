/**
 * The 3D board's ants (from the earlier Babylon.js prototype's ants, its second style,
 * the look of its hero still): code-built 3D meshes drawn with thin instances (one
 * draw per colony, plus one per colony for corpses). Body: abdomen in the colony colour, pale
 * chitin waist, thorax and head, thin legs and antennae, all from spheres and tubes built here;
 * no image or model files. The walk cycle runs in the vertex shader (a material plugin): legs in
 * two alternating tripods swing about their hips and lift on the forward stroke, the gaster
 * sways and the antennae sweep, with each ant's phase advanced by the distance it actually
 * moved, so feet keep pace with the ground. Squad ants are tinted toward their agent's hue at all
 * times and free ants stay plain; the roster's hovered squad has a ring under each of its ants and
 * every other ant is dimmed, as on the 2D board.
 */
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { FresnelParameters } from "@babylonjs/core/Materials/fresnelParameters.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder.js";
import { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { CORPSE_FADE_MS, type Frame } from "../buffer.ts";
import { DIM_TINT, FALLEN_TINT, NO_FALLEN, NO_HUES, SOLDIER_SCALE } from "../ants.ts";
import { FOOD, FOOD_SHADE } from "../food.ts";
import { Bites } from "../bite.ts";
import type { Ground } from "./ground.ts";

const HIP_Y = 0.17;
/** Radians of leg swing either side of rest. */
const SWING = 0.42;

/** Eight flat-shaded triangles: enough facets for a green crumb at phone size, without
 * the sphere builder's 144 triangles per crumb. Shared by piles and carried food. */
export function buildCrumbGeometry(radius = 1, x = 0, y = 0): VertexData {
  const vertices = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const faces = [[0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 2], [1, 3, 2], [1, 4, 3], [1, 5, 4], [1, 2, 5]];
  const positions: number[] = [], indices: number[] = [], normals: number[] = [];
  for (const face of faces) for (const index of face) {
    const v = vertices[index]!;
    indices.push(indices.length);
    positions.push(v[0]! * radius + x, v[1]! * radius + y, v[2]! * radius);
  }
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions; vd.indices = indices; vd.normals = normals;
  return vd;
}

class WalkPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "AntwarWalk", 200, { AW_WALK: false });
    this._enable(true);
  }
  override prepareDefines(defines: MaterialDefines): void {
    defines.AW_WALK = true;
  }
  override getClassName(): string {
    return "AntwarWalkPlugin";
  }
  override getAttributes(attributes: string[]): void {
    attributes.push("aWalk", "aLeg", "aBite", "aHead");
  }
  override getUniforms() {
    return { ubo: [] };
  }
  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_DEFINITIONS: `
#ifdef AW_WALK
attribute float aWalk;
attribute vec2 aLeg;
attribute float aBite;
attribute vec2 aHead;
#endif`,
      CUSTOM_VERTEX_UPDATE_POSITION: `
#ifdef AW_WALK
if (abs(aLeg.x) > 0.5 && abs(aLeg.x) < 1.5) {
  float ph = aWalk + (aLeg.x > 0.0 ? 0.0 : 3.14159265);
  float sw = sin(ph) * ${SWING.toFixed(3)};
  vec3 hip = vec3(aLeg.y, ${HIP_Y.toFixed(3)}, 0.0);
  vec3 p = positionUpdated - hip;
  float reach = length(p.xz);
  float c = cos(sw);
  float s = sin(sw);
  p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
  p.y += max(0.0, cos(ph)) * 0.09 * reach / 0.35;
  positionUpdated = p + hip;
}
// The gaster swings against the stride and lifts slightly, the antennae sweep, and the whole
// body bobs twice per stride. aLeg.x codes the part: 2 gaster, 3 antenna.
if (abs(aLeg.x - 2.0) < 0.25) {
  float g = sin(aWalk * 0.5) * 0.16;
  vec3 piv = vec3(-0.05, 0.17, 0.0);
  vec3 q = positionUpdated - piv;
  float c2 = cos(g);
  float s2 = sin(g);
  q.xz = vec2(c2 * q.x - s2 * q.z, s2 * q.x + c2 * q.z);
  q.y += sin(aWalk) * 0.02 * (-q.x / 0.45);
  positionUpdated = q + piv;
} else if (abs(aLeg.x - 3.0) < 0.25) {
  float reach = max(0.0, positionUpdated.x - 0.33);
  positionUpdated.z += sin(aWalk * 0.7 + aLeg.y * 9.0) * reach * 0.45;
  positionUpdated.y += cos(aWalk * 0.9 + aLeg.y * 7.0) * reach * 0.25;
}
// Tag 4: a mandible, hinged at its root. aLeg.y is the signed hinge z.
if (abs(aLeg.x - 4.0) < 0.25) {
  float jaw = sign(aLeg.y) * aBite * 0.5;
  float cj = cos(jaw), sj = sin(jaw);
  vec3 pivot = vec3(0.34, 0.2, aLeg.y);
  vec3 qj = positionUpdated - pivot;
  qj.xz = vec2(cj * qj.x - sj * qj.z, sj * qj.x + cj * qj.z);
  positionUpdated = qj + pivot;
  normalUpdated.xz = vec2(cj * normalUpdated.x - sj * normalUpdated.z, sj * normalUpdated.x + cj * normalUpdated.z);
}
// Only head, mandibles and antennae move relative to the capped body lean.
if (aLeg.x >= 3.0) { positionUpdated.x += aHead.x; positionUpdated.z += aHead.y; }
positionUpdated.y += abs(sin(aWalk)) * 0.018;
#endif`,
    };
  }
}

interface Part {
  mesh: Mesh;
  color: [number, number, number];
  leg: [number, number];
}

/** Shared tessellation for workers, soldiers and corpses: 912 triangles per ant at every tier. */
export const LITE_SEGMENTS = 4;
export const LITE_TUBE_SEGMENTS = 3;

/** One ant along +x, one unit long, feet at y 0: vertex colours, and per-vertex part tags in aLeg. */
export function buildAntGeometry(scene: Scene, accent: readonly number[], dull: boolean, segments = 10, soldier = false, tubeSegments = soldier ? LITE_TUBE_SEGMENTS : 5): VertexData {
  const parts: Part[] = [];
  const chitin: [number, number, number] = [0.86, 0.81, 0.73];
  const chitinShade: [number, number, number] = [0.62, 0.57, 0.5];
  const ell = (name: string, x: number, y: number, rx: number, ry: number, rz: number, color: [number, number, number], tag = 0) => {
    const m = CreateSphere(name, { diameterX: rx * 2, diameterY: ry * 2, diameterZ: rz * 2, segments }, scene);
    m.position.set(x, y, 0);
    parts.push({ mesh: m, color, leg: [tag, 0] });
  };
  const a = (k: number): [number, number, number] => [accent[0]! * k, accent[1]! * k, accent[2]! * k];
  // Proportions follow web/src/ants.ts's drawing (abdomen, waist, thorax, head along the body axis).
  ell("abdomen", -0.27, 0.2, 0.235, 0.15, 0.155, a(0.8), 2);
  ell("band", -0.27, 0.205, 0.2, 0.152, 0.157, a(0.55), 2);
  ell("petiole", -0.04, 0.17, 0.045, 0.045, 0.04, chitinShade);
  ell("thorax", 0.07, 0.19, 0.13, 0.085, 0.08, soldier ? a(0.75) : chitin);
  ell("head", 0.27, 0.2, soldier ? 0.14 : 0.1, 0.085, soldier ? 0.15 : 0.095, soldier ? a(1) : chitin, 5);
  for (const side of [-1, 1]) {
    const hinge = soldier ? 0.12 : 0.055;
    const jaw = CreateTube("mandible", { path: [new Vector3(0.34, 0.2, side * hinge), new Vector3(0.48, 0.2, side * (soldier ? 0.13 : 0.075)), new Vector3(0.55, 0.2, side * 0.015)], radius: soldier ? 0.032 : 0.022, tessellation: tubeSegments }, scene);
    parts.push({ mesh: jaw, color: chitin, leg: [4, side * hinge] });
  }
  // Antennae: two-segment tubes forward from the head.
  for (const side of [-1, 1]) {
    const t = CreateTube("antenna", { path: [new Vector3(0.33, 0.24, side * 0.04), new Vector3(0.43, 0.3, side * 0.1), new Vector3(0.53, 0.24, side * 0.17)], radius: 0.014, tessellation: tubeSegments }, scene);
    parts.push({ mesh: t, color: chitinShade, leg: [3, side * 0.5] });
  }
  // Legs: three a side from the thorax; tripods L1 R2 L3 against R1 L2 R3.
  const hips = [0.13, 0.07, 0.01];
  hips.forEach((hx, i) => {
    for (const side of [-1, 1]) {
      const group = (i % 2 === 0 ? 1 : -1) * side;
      const knee = new Vector3(hx + (1 - i) * 0.12, 0.3, side * 0.2);
      const foot = new Vector3(hx + (1 - i) * 0.26, 0.0, side * 0.36);
      const t = CreateTube("leg", { path: [new Vector3(hx, HIP_Y, side * 0.04), knee, foot], radius: 0.021, tessellation: tubeSegments, cap: Mesh.CAP_END }, scene);
      parts.push({ mesh: t, color: chitinShade, leg: [group, hx] });
    }
  });
  // Abdomen bands: a slightly larger dark ring segment reads as segmentation.
  parts[1]!.mesh.scaling.set(0.35, 1, 1);
  parts[1]!.mesh.position.x = -0.16;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const legs: number[] = [];
  for (const p of parts) {
    p.mesh.bakeCurrentTransformIntoVertices();
    const vd = VertexData.ExtractFromMesh(p.mesh);
    const base = positions.length / 3;
    const pos = vd.positions!;
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]!);
    for (let i = 0; i < vd.normals!.length; i++) normals.push(vd.normals![i]!);
    for (const ix of vd.indices!) indices.push(ix + base);
    let [r, g, b] = p.color;
    if (dull) {
      const k = 0.45;
      [r, g, b] = [r * k + 0.55 * 0.3, g * k + 0.52 * 0.3, b * k + 0.47 * 0.3];
    }
    for (let i = 0; i < pos.length / 3; i++) {
      colors.push(r, g, b, 1);
      legs.push(p.leg[0], p.leg[1]);
    }
    p.mesh.dispose();
  }
  const out = new VertexData();
  out.positions = positions;
  out.normals = normals;
  out.indices = indices;
  out.colors = colors;
  (out as unknown as { aLeg: number[] }).aLeg = legs;
  return out;
}

class Herd {
  readonly mesh: Mesh;
  matrices = new Float32Array(0);
  walk = new Float32Array(0);
  bite = new Float32Array(0);
  head = new Float32Array(0);
  /** Per-instance RGBA multiplied into the vertex colour (Babylon's built-in thin-instance "color" buffer). */
  color: Float32Array | null = null;
  capacity = 0;
  private readonly tinted: boolean;

  constructor(scene: Scene, name: string, vd: VertexData, material: StandardMaterial, mapW: number, mapH: number, tinted = false) {
    this.tinted = tinted;
    this.mesh = new Mesh(name, scene);
    vd.applyToMesh(this.mesh, false);
    const leg = (vd as unknown as { aLeg: number[] }).aLeg;
    this.mesh.setVerticesBuffer(new VertexBuffer(scene.getEngine(), new Float32Array(leg), "aLeg", false, false, 2));
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.ensure(256);
    this.mesh.thinInstanceCount = 0;
    // An empty thin-instance mesh draws its source geometry without instancing instead.
    this.mesh.setEnabled(false);
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.setBoundingInfo(new BoundingInfo(new Vector3(-8, -4, -8), new Vector3(mapW + 8, 4, mapH + 8)));
    this.mesh.doNotSyncBoundingInfo = true;
  }

  ensure(n: number) {
    if (n <= this.capacity) return;
    const cap = Math.max(n, this.capacity * 2);
    const m = new Float32Array(cap * 16);
    m.set(this.matrices);
    const w = new Float32Array(cap);
    w.set(this.walk);
    const b = new Float32Array(cap);
    b.set(this.bite);
    this.matrices = m;
    this.walk = w;
    this.bite = b;
    const head = new Float32Array(cap * 2); head.set(this.head); this.head = head;
    this.capacity = cap;
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("aWalk", this.walk, 1, false);
    this.mesh.thinInstanceSetBuffer("aBite", this.bite, 1, false);
    this.mesh.thinInstanceSetBuffer("aHead", this.head, 2, false);
    if (this.tinted) {
      const c = new Float32Array(cap * 4).fill(1);
      if (this.color) c.set(this.color);
      this.color = c;
      this.mesh.thinInstanceSetBuffer("color", this.color, 4, false);
    }
  }

  commit(n: number) {
    this.mesh.thinInstanceCount = n;
    if (n > 0) {
      this.mesh.thinInstanceBufferUpdated("matrix");
      this.mesh.thinInstanceBufferUpdated("aWalk");
      this.mesh.thinInstanceBufferUpdated("aBite");
      this.mesh.thinInstanceBufferUpdated("aHead");
      if (this.color) this.mesh.thinInstanceBufferUpdated("color");
    }
    // Keep the layer's isVisible switch independent of whether there is anything to draw.
    this.mesh.setEnabled(n > 0);
  }
}

/** Row-major Babylon matrix: scale L, optional flip onto the back, yaw a, then translate. */
export function writeMatrix(m: Float32Array, o: number, L: number, a: number, x: number, y: number, z: number, flip: boolean) {
  const c = Math.cos(a) * L;
  const s = Math.sin(a) * L;
  const f = flip ? -1 : 1;
  m[o] = c;
  m[o + 1] = 0;
  m[o + 2] = -s;
  m[o + 3] = 0;
  m[o + 4] = 0;
  m[o + 5] = L * f;
  m[o + 6] = 0;
  m[o + 7] = 0;
  m[o + 8] = s * f;
  m[o + 9] = 0;
  m[o + 10] = c * f;
  m[o + 11] = 0;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  m[o + 15] = 1;
}

export class Ants3D {
  private live: Herd[];
  private soldiers: Herd[];
  private crumbs: Herd;
  private dead: Herd[];
  private readonly herds: Herd[];
  private readonly counts = new Uint32Array(4);
  private readonly at = new Uint32Array(4);
  private readonly corpseCounts = new Uint32Array(2);
  private readonly corpseAt = new Uint32Array(2);
  /** Rings under the highlighted squad's ants (one thin-instanced torus, unlit, tinted per instance). */
  private rings: Herd;
  /** Per ant id: last position (tiles) and walk phase. */
  private gait = new Map<number, { x: number; y: number; ph: number; seen: number }>();
  private stamp = 0;
  private readonly bites = new Bites();
  private readonly ground: Ground;
  /** Ant length in tiles. */
  lengthTiles: number;

  constructor(scene: Scene, ground: Ground, lengthTiles: number, colonyRgb: readonly (readonly number[])[], segments = 10) {
    this.ground = ground;
    this.lengthTiles = lengthTiles;
    const mk = (name: string, specular: number) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = new Color3(1, 1, 1);
      m.specularColor = new Color3(specular, specular, specular);
      m.specularPower = 56;
      return m;
    };
    const liveMat = mk("ant", 0.55);
    new WalkPlugin(liveMat);
    // A tighter, brighter chitin highlight and a warm Fresnel rim (built-in emissive Fresnel).
    liveMat.specularPower = 90;
    liveMat.specularColor = new Color3(0.8, 0.74, 0.66);
    liveMat.emissiveFresnelParameters = new FresnelParameters({ leftColor: new Color3(0.32, 0.22, 0.12), rightColor: new Color3(0, 0, 0), bias: 0.15, power: 2.2 });
    const deadMat = mk("corpse", 0.1);
    new WalkPlugin(deadMat);
    deadMat.emissiveColor = new Color3(0.12, 0.1, 0.08);
    deadMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
    deadMat.disableDepthWrite = true;
    const W = ground.mapW;
    const H = ground.mapH;
    this.live = [0, 1].map((c) => new Herd(scene, `ants${c}`, buildAntGeometry(scene, colonyRgb[c]!, false, Math.min(segments, LITE_SEGMENTS), false, LITE_TUBE_SEGMENTS), liveMat, W, H, true));
    this.soldiers = [0, 1].map((c) => new Herd(scene, `soldiers${c}`, buildAntGeometry(scene, colonyRgb[c]!, false, Math.min(segments, LITE_SEGMENTS), true), liveMat, W, H, true));
    this.herds = [...this.live, ...this.soldiers];
    // One batched faceted green crumb, held in front of a worker's head; soldiers never carry.
    const cvd = buildCrumbGeometry(0.16, 0.48, 0.24);
    cvd.colors = new Array((cvd.positions!.length / 3) * 4).fill(1);
    (cvd as unknown as { aLeg: number[] }).aLeg = new Array((cvd.positions!.length / 3) * 2).fill(0);
    const crumbMat = mk("carried-food", 0.15);
    crumbMat.diffuseColor = Color3.FromHexString(`#${FOOD.toString(16).padStart(6, "0")}`);
    crumbMat.emissiveColor = Color3.FromHexString(`#${FOOD_SHADE.toString(16).padStart(6, "0")}`);
    this.crumbs = new Herd(scene, "carried-food", cvd, crumbMat, W, H, true);
    const ringMat = new StandardMaterial("ring", scene);
    ringMat.disableLighting = true;
    // Unlit standard material: colour = clamp(emissive) * vertex colour * instance colour, so emissive must be 1.
    ringMat.diffuseColor = new Color3(0, 0, 0);
    ringMat.emissiveColor = new Color3(1, 1, 1);
    ringMat.alpha = 0.9;
    ringMat.zOffset = -1; // beat the ground's relief, not the ants
    ringMat.disableDepthWrite = true;
    const torus = CreateTorus("ringgeo", { diameter: 1.5, thickness: 0.16, tessellation: 28 }, scene);
    const tvd = VertexData.ExtractFromMesh(torus);
    torus.dispose();
    tvd.colors = new Array((tvd.positions!.length / 3) * 4).fill(1);
    (tvd as unknown as { aLeg: number[] }).aLeg = new Array((tvd.positions!.length / 3) * 2).fill(0);
    this.rings = new Herd(scene, "rings", tvd, ringMat, W, H, true);
    this.dead = [0, 1].map((c) => new Herd(scene, `corpses${c}`, buildAntGeometry(scene, colonyRgb[c]!, true, Math.min(segments, LITE_SEGMENTS), false, LITE_TUBE_SEGMENTS), deadMat, W, H, true));
    for (const h of this.dead) h.mesh.hasVertexAlpha = true;
  }

  /** All ant meshes, including visible corpses; used by the ants layer toggle. */
  get meshes(): Mesh[] {
    return [...this.live.map((h) => h.mesh), ...this.soldiers.map((h) => h.mesh), ...this.dead.map((h) => h.mesh)];
  }

  /** Only live workers and soldiers cast shadows; corpses remain in the visible layer. */
  get casters(): Mesh[] {
    return this.herds.map((h) => h.mesh);
  }

  setVisible(on: boolean) {
    for (const m of [...this.meshes, this.rings.mesh, this.crumbs.mesh]) m.isVisible = on;
  }

  /** highlight: agent whose squad leads and is ringed, every other ant dimmed (-1 none); hues: each agent's hue by index (squads.ts agentHues); fallen: the colonies whose ants are dimmed as fallen. */
  update(frame: Frame, highlight = -1, hues: readonly number[] = NO_HUES, fallen: readonly boolean[] = NO_FALLEN) {
    const L = this.lengthTiles;
    const n = frame.count;
    this.bites.update(frame);
    let ringCount = 0;
    const counts = this.counts;
    counts.fill(0);
    let carrying = 0;
    for (let i = 0; i < n; i++) {
      counts[frame.colony[i]! + (frame.caste[i] === 1 ? 2 : 0)]!++;
      if (frame.caste[i] !== 1 && frame.carrying[i]) carrying++;
      if (highlight >= 0 && frame.agent[i] === highlight) ringCount++;
    }
    this.rings.ensure(ringCount);
    this.crumbs.ensure(carrying);
    const herds = this.herds;
    for (let i = 0; i < herds.length; i++) herds[i]!.ensure(counts[i]!);
    const at = this.at;
    at.fill(0);
    let r = 0, carried = 0;
    this.stamp++;
    for (let i = 0; i < n; i++) {
      const c = frame.colony[i]!;
      const caste = frame.caste[i] === 1 ? 1 : 0;
      const group = c + caste * 2;
      const herd = herds[group]!;
      const k = at[group]!++;
      const size = L * (caste ? SOLDIER_SCALE : 1);
      const x = frame.drawX?.[i] ?? frame.x[i]!;
      const y = frame.drawY?.[i] ?? frame.y[i]!;
      const id = frame.id[i]!;
      let g = this.gait.get(id);
      if (!g) {
        g = { x, y, ph: (id * 2.399) % 6.283, seen: 0 };
        this.gait.set(id, g);
      }
      // About one full stride per 0.55 body lengths travelled.
      g.ph += (Math.hypot(x - g.x, y - g.y) / (size * 0.55)) * 6.283;
      g.x = x;
      g.y = y;
      g.seen = this.stamp;
      const grow = 0.35 + 0.65 * frame.alpha[i]!;
      const pose = this.bites.pose(i, size);
      const position = this.bites.bodyPosition(i, size);
      const drawX = position?.x ?? x, drawY = position?.y ?? y;
      const rotation = pose?.rotation ?? frame.drawRotation?.[i] ?? frame.rotation[i]!;
      const gy = this.ground.heightAt(drawX, drawY);
      writeMatrix(herd.matrices, k * 16, size * grow, rotation, drawX, gy + 0.02, this.ground.mapH - drawY, false);
      herd.walk[k] = g.ph;
      herd.bite[k] = pose?.jawOpen ?? 0;
      herd.head[k * 2] = (pose?.headOffset ?? 0) / (size * grow);
      herd.head[k * 2 + 1] = -(pose?.headSideOffset ?? 0) / (size * grow);
      const agent = frame.agent[i]!;
      const hue = agent >= 0 ? hues[agent] : undefined;
      const lit = highlight >= 0 && agent === highlight;
      const gone = fallen[c] === true;
      const col = herd.color!;
      // A squad ant is tinted toward its agent's hue at all times, as on the 2D board, but
      // keeps the body's shading; a free ant stays plain. With a squad highlighted every other ant is dimmed, a squad
      // ant keeping its hue under the dim; a fallen colony's ants are dimmed as fallen whatever is selected.
      for (let ch = 0; ch < 3; ch++) {
        const shift = 16 - 8 * ch;
        const own = hue === undefined ? 1 : 0.35 + 0.95 * (((hue >> shift) & 255) / 255);
        col[k * 4 + ch] = gone ? ((FALLEN_TINT >> shift) & 255) / 255 : highlight < 0 || lit ? own : own * (((DIM_TINT >> shift) & 255) / 255);
      }
      if (!caste && frame.carrying[i]) {
        const crumbX = drawX + Math.cos(rotation) * (pose?.headOffset ?? 0) - Math.sin(rotation) * (pose?.headSideOffset ?? 0);
        const crumbY = drawY + Math.sin(rotation) * (pose?.headOffset ?? 0) + Math.cos(rotation) * (pose?.headSideOffset ?? 0);
        writeMatrix(this.crumbs.matrices, carried * 16, size * grow, rotation, crumbX, gy + 0.02, this.ground.mapH - crumbY, false);
        const crumbColor = this.crumbs.color!;
        const ci = carried * 4, hi = k * 4;
        crumbColor[ci] = col[hi]!;
        crumbColor[ci + 1] = col[hi + 1]!;
        crumbColor[ci + 2] = col[hi + 2]!;
        crumbColor[ci + 3] = 1;
        carried++;
      }
      if (lit) {
        writeMatrix(this.rings.matrices, r * 16, size, 0, drawX, gy + 0.08, this.ground.mapH - drawY, false);
        const ringColor = this.rings.color!, ri = r * 4;
        for (let ch = 0; ch < 3; ch++) ringColor[ri + ch] = (hue === undefined ? 1 : ((hue >> (16 - 8 * ch)) & 255) / 255) * 1.35;
        ringColor[ri + 3] = 1;
        r++;
      }
    }
    for (let i = 0; i < herds.length; i++) herds[i]!.commit(counts[i]!);
    this.crumbs.commit(carried);
    this.rings.commit(r);
    if (this.stamp % 64 === 0) for (const [id, g] of this.gait) if (this.stamp - g.seen > 64) this.gait.delete(id);

    const cc = this.corpseCounts;
    cc.fill(0);
    for (const k of frame.corpses) if (k.ageMs >= 0 && k.ageMs < CORPSE_FADE_MS) cc[k.colony]!++;
    this.dead[0]!.ensure(cc[0]!);
    this.dead[1]!.ensure(cc[1]!);
    const ca = this.corpseAt;
    ca.fill(0);
    for (const k of frame.corpses) {
      if (k.ageMs < 0 || k.ageMs >= CORPSE_FADE_MS) continue;
      const herd = this.dead[k.colony]!;
      const j = ca[k.colony]!++;
      const t = k.ageMs / CORPSE_FADE_MS;
      // Stay entirely above the relief for the shared 3000 ms lifetime; fade, never sink.
      const pose = this.bites.corpsePose(k.antId, L);
      const position = this.bites.corpsePosition(k.antId, L);
      const x = position?.x ?? k.x, z = position?.y ?? k.y;
      const y = this.ground.heightAt(x, z) + (pose ? 0.02 : L * 0.36 + 0.05);
      writeMatrix(herd.matrices, j * 16, L, pose?.rotation ?? k.heading, x, y, this.ground.mapH - z, !pose);
      herd.walk[j] = 0; herd.bite[j] = pose?.jawOpen ?? 0;
      herd.head[j * 2] = (pose?.headOffset ?? 0) / L;
      herd.head[j * 2 + 1] = -(pose?.headSideOffset ?? 0) / L;
      const color = herd.color!, ci = j * 4;
      color[ci] = color[ci + 1] = color[ci + 2] = 1;
      color[ci + 3] = 0.9 * (1 - t);
    }
    this.dead[0]!.commit(cc[0]!);
    this.dead[1]!.commit(cc[1]!);
    this.bites.publishContacts(L, "3d");
  }
}
