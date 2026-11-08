/**
 * The 3D board's lit ground with relief (from the earlier Babylon.js prototype's ground):
 * one subdivided mesh displaced by heightAt, a StandardMaterial (so it takes the key light's
 * shadow map and the fill), and a material plugin that paints the baked soil, the territory
 * colour, distinct dark trails and a thin, light front into it. Exact tile ownership makes
 * regions read as areas. Only edges between opposing owned tiles get a border; neutral ground
 * never becomes a front, and the front adds no HDR glow to the scene's bloom pass.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { TRAIL_RES, type Frame } from "../buffer.ts";
import { FOG_ALPHA } from "../team-view.ts";
import { boardLook } from "../board-look.ts";
import { heightAt, soilAt } from "./noise.ts";
import { WATER_GLSL, WaterMask, mirrorAxis } from "../terrain.ts";

export const COLONY_RGB = [
  [1.0, 0xb0 / 255, 0.0],
  [0.0, 0xc2 / 255, 1.0],
] as const;

/** The front occupies this fraction of a tile on each side of an opposing edge (0.24 tiles total). */
export const FRONT_HALF_WIDTH = 0.12;
/** Dark trail marks are bounded inside each fine-grid cell, not smeared over the tile fill. */
export const TRAIL_CELL_WIDTH = 0.8;

/** Retain a 25% playable-edge drop without halving already-dark soil before lighting. */
export const OFFBOARD_BRIGHTNESS = 0.75;
/** Keep a crisp playable edge; the broad atmospheric fade starts beyond this short outside band. */
export const EDGE_FADE_START_TILES = 1.5;
/** Fixed outer subdivisions per side: extending the backdrop must not multiply the dense mesh/texture budget. */
const OUTER_STEPS = 16;

/** The exterior joins the edge continuously, then becomes a flat, featureless backdrop. */
export const OFFBOARD_FLATTEN_TILES = 2;

/** Dense playable relief and its short transition; coarse flat ground beyond it. */
function groundAxis(length: number, per: number, denseMargin: number, margin: number): number[] {
  const outerStep = (margin - denseMargin) / OUTER_STEPS;
  return [
    ...Array.from({ length: OUTER_STEPS }, (_, i) => -margin + i * outerStep),
    ...Array.from({ length: (length + 2 * denseMargin) * per + 1 }, (_, i) => i / per - denseMargin),
    ...Array.from({ length: OUTER_STEPS }, (_, i) => length + denseMargin + (i + 1) * outerStep),
  ];
}

/** Fractional vertex index on a nonuniform axis, clamped to its actual mesh extent. */
function gridIndex(axis: readonly number[], value: number): number {
  if (value <= axis[0]!) return 0;
  if (value >= axis[axis.length - 1]!) return axis.length - 1;
  let lo = 0, hi = axis.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid]! <= value) lo = mid;
    else hi = mid;
  }
  return lo + (value - axis[lo]!) / (axis[hi]! - axis[lo]!);
}

/** GLSL-100: R owner, G opposing-edge bits (left/right/up/down), B owned coverage, A opaque. */
const DEFS = /* glsl */ `
#ifdef AW_GROUND
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uTrail;
uniform sampler2D uSoil;
uniform sampler2D uWater;
uniform sampler2D uFog;
${WATER_GLSL}
vec3 awColony(vec4 s) {
  return mix(uC1, uC0 * 0.85, step(0.75, s.r));
}
vec3 awFill(vec4 s, vec3 soil) {
  // Reuse the mip-filtered, baked sub-tile grain: a scalar keeps colony hue intact.
  // Owned soil gets at most +/-5% variation; trails/front/water are composited later.
  float grain = clamp((soil.r - 0.44) / 0.44, -0.10, 0.10);
  vec3 owned = awColony(s) * 0.48 * (1.0 + grain * 0.5);
  return mix(soil, owned, 0.72 * s.b);
}
float awBorder(vec4 s, vec2 local) {
  float flags = floor(s.g * 255.0 + 0.5);
  vec4 edges = mod(floor(flags / vec4(1.0, 2.0, 4.0, 8.0)), 2.0);
  vec4 distanceToEdge = vec4(local.x, 1.0 - local.x, local.y, 1.0 - local.y);
  vec4 line = (1.0 - smoothstep(vec4(0.08), vec4(${FRONT_HALF_WIDTH.toFixed(2)}), distanceToEdge)) * edges;
  return max(max(line.x, line.y), max(line.z, line.w)) * s.b;
}
vec3 awBorderColour(vec4 s) {
  return mix(awColony(s), vec3(1.0), 0.18) * 0.65;
}
#endif
`;

const DIFFUSE = /* glsl */ `
#ifdef AW_GROUND
vec2 awTile = vec2(vPositionW.x, uMap.y - vPositionW.z);
vec2 awUV = awTile / uMap;
// Only the playable board samples terrain. The exterior has one soil-derived albedo.
vec3 awCol = uOffboardSoil;
if (awUV.x >= 0.0 && awUV.y >= 0.0 && awUV.x < 1.0 && awUV.y < 1.0) {
  // Preserve the original in-bounds texture coordinates and water calculation.
  vec2 awMirror = uMap - abs(mod(awTile, 2.0 * uMap) - uMap);
  vec3 awSoil = texture2D(uSoil, (awMirror + uSoilMargin) / (uMap + 2.0 * uSoilMargin)).rgb;
  vec2 awWaterCell = clamp(floor(awMirror), vec2(0.0), uMap - 1.0);
  float awWet = texture2D(uWater, (awWaterCell + 0.5) / uMap).r;
  // Tile-centre samples prevent bilinear filtering/warp from streaking the solid fill or edge bits.
  vec2 awCell = clamp(floor(awTile), vec2(0.0), uMap - 1.0);
  vec2 awCentre = (awCell + 0.5) / uMap;
  vec2 awLocal = awTile - awCell;
  vec4 awA = texture2D(uA, awCentre);
  vec4 awB = texture2D(uB, awCentre);
  // Blend complete colours over time, not ownership scalars through a spurious neutral band.
  awCol = mix(awFill(awA, awSoil), awFill(awB, awSoil), uBlend);

  // Separately shaded, sub-tile trail marks. Each is at most 0.8 / TRAIL_RES = 0.2 tiles wide.
  vec2 awTrailCell = clamp(floor(awTile * ${TRAIL_RES.toFixed(1)}), vec2(0.0), uMap * ${TRAIL_RES.toFixed(1)} - 1.0);
  vec2 awTrailUV = (awTrailCell + 0.5) / (uMap * ${TRAIL_RES.toFixed(1)});
  vec2 awTrailLocal = awTile * ${TRAIL_RES.toFixed(1)} - awTrailCell - 0.5;
  vec2 awTrail = texture2D(uTrail, awTrailUV).rg;
  float awStroke = 1.0 - smoothstep(0.28, ${(TRAIL_CELL_WIDTH / 2).toFixed(2)}, max(abs(awTrailLocal.x), abs(awTrailLocal.y)));
  float awInk = smoothstep(0.04, 0.32, max(awTrail.r, awTrail.g)) * awStroke * uTrails;
  awCol *= 1.0 - 0.42 * awInk;

  // The light front is last, so trails cannot obscure it. No emissive band or broad bloom source.
  float awLineA = awBorder(awA, awLocal) * (1.0 - uBlend);
  float awLineB = awBorder(awB, awLocal) * uBlend;
  float awLine = awLineA + awLineB;
  vec3 awLineColour = (awBorderColour(awA) * awLineA + awBorderColour(awB) * awLineB) / max(awLine, 0.001);
  awCol = mix(awCol, awLineColour, awLine * uFrontOn);
  // Water replaces territory/front/trails only on its exact playable tiles.
  awCol = mix(awCol, awWaterColour(awMirror), awWet);
}
// A clear brightness step preserves the playable rectangle; only the ground beyond it fades.
if (awUV.x < 0.0 || awUV.y < 0.0 || awUV.x >= 1.0 || awUV.y >= 1.0) awCol *= ${OFFBOARD_BRIGHTNESS.toFixed(2)};
baseColor.rgb = awCol;
#endif
`;

/** The scene's clear colour (main3d.ts scene.clearColor): the page background the board sits on, #121719. */
export const CLEAR_RGB = [0x12 / 255, 0x17 / 255, 0x19 / 255] as const;

// Fade gradually beyond the clear playable-edge step, not in a narrow strip at the mesh's far end.
// The extended mesh ends outside the default/Whole board frame, where it matches the clear colour.
const EMISSIVE = /* glsl */ `
#ifdef AW_GROUND
vec2 awEdgeUV = vec2(vPositionW.x, uMap.y - vPositionW.z) / uMap;
vec2 awEdge = max(max(-awEdgeUV, awEdgeUV - 1.0), 0.0) * uMap;
// A colony's point of view: its unseen playable tiles under the page background, as on the 2D board.
if (uFogOn > 0.5 && awEdgeUV.x >= 0.0 && awEdgeUV.y >= 0.0 && awEdgeUV.x < 1.0 && awEdgeUV.y < 1.0) {
  vec2 awFogCell = clamp(floor(awEdgeUV * uMap), vec2(0.0), uMap - 1.0);
  float awUnseen = 1.0 - texture2D(uFog, (awFogCell + 0.5) / uMap).r;
  color.rgb = mix(color.rgb, vec3(${CLEAR_RGB.map((c) => c.toFixed(6)).join(", ")}), ${FOG_ALPHA.toFixed(2)} * awUnseen);
}
color.rgb = mix(color.rgb, vec3(${CLEAR_RGB.map((c) => c.toFixed(6)).join(", ")}), smoothstep(${EDGE_FADE_START_TILES.toFixed(2)}, uMargin, max(awEdge.x, awEdge.y)));
#endif
`;

class GroundPlugin extends MaterialPluginBase {
  values = {
    blend: 0,
    time: 0,
    trails: 1,
    front: 1,
    fog: 0,
  };
  textures: { a: Texture; b: Texture; trail: Texture; soil: Texture; water: Texture; fog: Texture };
  map: [number, number];
  margin: number;
  soilMargin: number;
  /** The in-bounds mean soil colour, derived again whenever the soil is baked again (Ground.relook). */
  offboardSoil: readonly [number, number, number];

  constructor(material: Material, textures: GroundPlugin["textures"], map: [number, number], margin: number, soilMargin: number, offboardSoil: readonly [number, number, number]) {
    // AW_LOOK: the board look's id (board-look.ts), so a change of look builds a new shader.
    super(material, "AntwarGround", 200, { AW_GROUND: false, AW_LOOK: 0 });
    this.textures = textures;
    this.map = map;
    this.margin = margin;
    this.soilMargin = soilMargin;
    this.offboardSoil = offboardSoil;
    this._enable(true);
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines.AW_GROUND = true;
    defines.AW_LOOK = boardLook()?.id ?? 0;
  }

  override getClassName(): string {
    return "AntwarGroundPlugin";
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("uA", "uB", "uTrail", "uSoil", "uWater", "uFog");
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "uMap", size: 2, type: "vec2" },
        { name: "uMargin", size: 1, type: "float" },
        { name: "uSoilMargin", size: 1, type: "float" },
        { name: "uBlend", size: 1, type: "float" },
        { name: "uTrails", size: 1, type: "float" },
        { name: "uTime", size: 1, type: "float" },
        { name: "uFrontOn", size: 1, type: "float" },
        { name: "uFogOn", size: 1, type: "float" },
        { name: "uC0", size: 3, type: "vec3" },
        { name: "uC1", size: 3, type: "vec3" },
        { name: "uOffboardSoil", size: 3, type: "vec3" },
      ],
      fragment: `#ifdef AW_GROUND
uniform vec2 uMap; uniform float uMargin; uniform float uSoilMargin; uniform float uBlend; uniform float uTrails; uniform float uTime;
uniform float uFrontOn; uniform float uFogOn; uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uOffboardSoil;
#endif`,
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const v = this.values;
    ubo.updateFloat2("uMap", this.map[0], this.map[1], "");
    ubo.updateFloat("uMargin", this.margin);
    ubo.updateFloat("uSoilMargin", this.soilMargin);
    ubo.updateFloat("uBlend", v.blend);
    ubo.updateFloat("uTrails", v.trails);
    ubo.updateFloat("uTime", v.time);
    ubo.updateFloat("uFogOn", v.fog);
    ubo.updateFloat("uFrontOn", v.front);
    ubo.updateFloat3("uC0", COLONY_RGB[0][0], COLONY_RGB[0][1], COLONY_RGB[0][2], "");
    ubo.updateFloat3("uC1", COLONY_RGB[1][0], COLONY_RGB[1][1], COLONY_RGB[1][2], "");
    ubo.updateFloat3("uOffboardSoil", ...this.offboardSoil, "");
    ubo.setTexture("uA", this.textures.a);
    ubo.setTexture("uB", this.textures.b);
    ubo.setTexture("uTrail", this.textures.trail);
    ubo.setTexture("uSoil", this.textures.soil);
    ubo.setTexture("uWater", this.textures.water);
    ubo.setTexture("uFog", this.textures.fog);
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const look = boardLook()?.board3d;
    if (look) {
      return { CUSTOM_FRAGMENT_DEFINITIONS: look.ground("definitions", DEFS), CUSTOM_FRAGMENT_UPDATE_DIFFUSE: look.ground("diffuse", DIFFUSE), CUSTOM_FRAGMENT_BEFORE_FOG: look.ground("beforeFog", EMISSIVE) };
    }
    return { CUSTOM_FRAGMENT_DEFINITIONS: DEFS, CUSTOM_FRAGMENT_UPDATE_DIFFUSE: DIFFUSE, CUSTOM_FRAGMENT_BEFORE_FOG: EMISSIVE };
  }
}

export class Ground {
  readonly mesh: Mesh;
  readonly plugin: GroundPlugin;
  private dataA: Uint8Array;
  private dataB: Uint8Array;
  private trailData: Uint8Array;
  private texA: RawTexture;
  private texB: RawTexture;
  private trailTex: RawTexture;
  readonly water: WaterMask;
  private waterTex: RawTexture;
  private fogData: Uint8Array;
  private fogTex: RawTexture;
  private keyFog: object | null = null;
  private keyA: object | null = null;
  private keyB: object | null = null;
  private keyTrail: object | null = null;
  /** Original relief query grid, retained for every caller independently of the exterior mesh. */
  private heights: Float32Array;
  private xs: number[];
  private ys: number[];
  private gw: number;
  private gh: number;
  readonly margin: number;
  readonly mapW: number;
  readonly mapH: number;
  /** Bakes the soil again into its texture, with the board look current then. */
  private rebake: () => void;

  constructor(scene: Scene, mapW: number, mapH: number, readonly physicalScale = 1) {
    this.mapW = mapW;
    this.mapH = mapH;
    // Keep the original bake/mip footprint independent of the smaller geometry band.
    const soilMargin = Math.round(Math.max(mapW, mapH) * 0.25);
    const denseMargin = OFFBOARD_FLATTEN_TILES * physicalScale;
    // Two map spans cover the full frame, including tall phones, without moving the camera.
    const margin = Math.max(mapW, mapH) * 2;
    this.margin = margin;
    const per = mapW / physicalScale > 100 ? 2 : 3;
    // Preserve the original query grid for every heightAt caller (framing, actors and view).
    // Only the rendered exterior changes; querying it must not move the camera or scenery.
    this.xs = groundAxis(mapW / physicalScale, per, soilMargin / physicalScale, margin / physicalScale).map(x => x * physicalScale);
    this.ys = groundAxis(mapH / physicalScale, per, soilMargin / physicalScale, margin / physicalScale).map(y => y * physicalScale);
    this.gw = this.xs.length;
    this.gh = this.ys.length;
    this.heights = new Float32Array(this.gw * this.gh);
    for (let j = 0; j < this.gh; j++) for (let i = 0; i < this.gw; i++) {
      this.heights[j * this.gw + i] = heightAt(mirrorAxis(this.xs[i]!, mapW) / physicalScale, mirrorAxis(this.ys[j]!, mapH) / physicalScale) * physicalScale;
    }

    const xs = groundAxis(mapW / physicalScale, per, denseMargin / physicalScale, margin / physicalScale).map(x => x * physicalScale);
    const ys = groundAxis(mapH / physicalScale, per, denseMargin / physicalScale, margin / physicalScale).map(y => y * physicalScale);
    const gw = xs.length, gh = ys.length, sx = gw - 1, sy = gh - 1;
    const renderHeight = (x: number, y: number): number => {
      const distance = Math.max(-x, x - mapW, -y, y - mapH, 0) / physicalScale;
      const t = Math.min(1, distance / OFFBOARD_FLATTEN_TILES);
      return t === 1 ? 0 : heightAt(Math.max(0, Math.min(mapW, x)) / physicalScale, Math.max(0, Math.min(mapH, y)) / physicalScale) * physicalScale * (1 - t * t * (3 - 2 * t));
    };

    // Mesh: a grid in world space (x = tile x, y up, z = mapH - tile y; Babylon is left-handed, so this keeps screen right = +x and up = +z looking down).
    const positions = new Float32Array(gw * gh * 3);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = (j * gw + i) * 3;
        positions[k] = xs[i]!;
        positions[k + 1] = renderHeight(xs[i]!, ys[j]!);
        positions[k + 2] = mapH - ys[j]!;
      }
    }
    const indices = new Uint32Array(sx * sy * 6);
    let n = 0;
    for (let j = 0; j < sy; j++) {
      for (let i = 0; i < sx; i++) {
        const a = j * gw + i;
        const b = a + 1;
        const c = a + gw;
        const d = c + 1;
        // Winding for Babylon's left-handed, clockwise-front convention (world z = mapH - tile y).
        indices[n++] = a;
        indices[n++] = c;
        indices[n++] = b;
        indices[n++] = b;
        indices[n++] = c;
        indices[n++] = d;
      }
    }
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    // The boundary's lit interior must not change when its exterior neighbours flatten.
    // Restore just the original one-cell ghost heights to obtain its old mirrored normals;
    // those ghost vertices are never rendered. All exterior normals keep the new geometry.
    const ghostPositions = positions.slice();
    const spacing = physicalScale / per;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = xs[i]!, y = ys[j]!;
      const distance = Math.max(-x, x - mapW, -y, y - mapH, 0);
      if (distance > 0 && distance <= spacing + 1e-9) {
        ghostPositions[(j * gw + i) * 3 + 1] = heightAt(mirrorAxis(x, mapW) / physicalScale, mirrorAxis(y, mapH) / physicalScale) * physicalScale;
      }
    }
    const ghostNormals = new Float32Array(normals.length);
    VertexData.ComputeNormals(ghostPositions, indices, ghostNormals);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = xs[i]!, y = ys[j]!;
      if (x >= 0 && x <= mapW && y >= 0 && y <= mapH && (x === 0 || x === mapW || y === 0 || y === mapH)) {
        const k = (j * gw + i) * 3;
        normals.set(ghostNormals.subarray(k, k + 3), k);
      }
    }
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    this.mesh = new Mesh("ground", scene);
    vd.applyToMesh(this.mesh, false);
    this.mesh.receiveShadows = true;

    // Keep every original soil texel/mip, including the border, for the playable board.
    const tpt = (mapW / physicalScale > 100 ? 5 : 8) / physicalScale;
    const swd = (mapW + 2 * soilMargin) * tpt;
    const shd = (mapH + 2 * soilMargin) * tpt;
    const soil = new Uint8Array(swd * shd * 4);
    const c = [0, 0, 0];
    // The board look (board-look.ts) colours the soil; with none it is soilAt. Each bake returns the in-bounds mean.
    const bake = (): [number, number, number] => {
      const colour = boardLook()?.board3d.soil ?? soilAt;
      const soilSum: [number, number, number] = [0, 0, 0];
      let soilSamples = 0;
      for (let y = 0; y < shd; y++) {
        for (let x = 0; x < swd; x++) {
          const tx = x / tpt - soilMargin, ty = y / tpt - soilMargin;
          colour(mirrorAxis(tx, mapW) / physicalScale, mirrorAxis(ty, mapH) / physicalScale, c);
          const k = (y * swd + x) * 4;
          soil[k] = Math.max(0, Math.min(255, c[0]! * 255));
          soil[k + 1] = Math.max(0, Math.min(255, c[1]! * 255));
          soil[k + 2] = Math.max(0, Math.min(255, c[2]! * 255));
          soil[k + 3] = 255;
          if (tx >= 0 && tx < mapW && ty >= 0 && ty < mapH) {
            soilSum[0] += soil[k]!; soilSum[1] += soil[k + 1]!; soilSum[2] += soil[k + 2]!;
            soilSamples++;
          }
        }
      }
      return soilSum.map(sum => sum / (soilSamples * 255)) as [number, number, number];
    };
    const offboardSoil = bake();
    // Texture rows run with tile y (v = tile y / height), matching how the shader samples.
    const soilTex = RawTexture.CreateRGBATexture(soil, swd, shd, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    soilTex.wrapU = soilTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.rebake = () => { this.plugin.offboardSoil = bake(); soilTex.update(soil); };

    this.dataA = new Uint8Array(mapW * mapH * 4);
    this.dataB = new Uint8Array(mapW * mapH * 4);
    this.trailData = new Uint8Array(mapW * TRAIL_RES * mapH * TRAIL_RES * 4);
    const mk = (d: Uint8Array, w: number, h: number) => {
      const t = RawTexture.CreateRGBATexture(d, w, h, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
      t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
      return t;
    };
    this.texA = mk(this.dataA, mapW, mapH);
    this.texB = mk(this.dataB, mapW, mapH);
    this.trailTex = mk(this.trailData, mapW * TRAIL_RES, mapH * TRAIL_RES);
    this.water = new WaterMask(mapW, mapH);
    this.waterTex = mk(this.water.data, mapW, mapH);
    this.fogData = new Uint8Array(mapW * mapH * 4);
    this.fogTex = mk(this.fogData, mapW, mapH);

    const mat = new StandardMaterial("ground", scene);
    mat.diffuseColor = new Color3(1, 1, 1);
    // Earth and territory are matte. Keep the shared key light and its shadows
    // unchanged for ants/nests. Water shares this material, so loses this lobe too;
    // its animated diffuse colour remains in the ground plugin.
    mat.specularColor = new Color3(0, 0, 0);
    this.plugin = new GroundPlugin(mat, { a: this.texA, b: this.texB, trail: this.trailTex, soil: soilTex, water: this.waterTex, fog: this.fogTex }, [mapW, mapH], margin, soilMargin, offboardSoil);
    this.mesh.material = mat;
    this.mesh.isPickable = false;
    this.mesh.freezeWorldMatrix();
  }

  /**
   * The board look changed (board-look.ts): bake its soil, and mark the material so its next draw builds the shader
   * with the look's code (the plugin's AW_LOOK define changes with it).
   */
  relook(): void {
    this.rebake();
    this.mesh.material?.markAsDirty(Material.AllDirtyFlag);
  }

  /** Original ground height (world y), including its mirrored exterior query envelope. */
  heightAt(tx: number, ty: number): number {
    const fx = gridIndex(this.xs, tx);
    const fy = gridIndex(this.ys, ty);
    const i = Math.min(this.gw - 2, Math.floor(fx));
    const j = Math.min(this.gh - 2, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    const h = this.heights;
    const w = this.gw;
    const a = h[j * w + i]!;
    const b = h[j * w + i + 1]!;
    const c = h[(j + 1) * w + i]!;
    const d = h[(j + 1) * w + i + 1]!;
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  /** 3D-only tile data: ownership, exact opponent-edge bits, owned coverage, opaque alpha. */
  private writeTerritory(out: Uint8Array, owners: Uint8Array): void {
    const W = this.mapW;
    const H = this.mapH;
    for (let i = 0; i < W * H; i++) {
      const owner = owners[i]!;
      const x = i % W;
      const other = 3 - owner;
      let edges = 0;
      if (owner !== 0) {
        if (x > 0 && owners[i - 1] === other) edges |= 1;
        if (x + 1 < W && owners[i + 1] === other) edges |= 2;
        if (i >= W && owners[i - W] === other) edges |= 4;
        if (i + W < W * H && owners[i + W] === other) edges |= 8;
      }
      out[i * 4] = owner === 1 ? 255 : owner === 2 ? 0 : 128;
      out[i * 4 + 1] = edges;
      out[i * 4 + 2] = owner === 0 ? 0 : 255;
      out[i * 4 + 3] = 255;
    }
  }

  update(frame: Frame, timeMs: number): void {
    const v = this.plugin.values;
    v.blend = frame.blend;
    v.time = timeMs / 1000;
    if (this.water.update(frame.board?.setup.terrain)) this.waterTex.update(this.water.data);
    if (this.keyA !== frame.territoryA || this.keyB !== frame.territoryB) {
      this.writeTerritory(this.dataA, frame.territoryA);
      this.writeTerritory(this.dataB, frame.territoryB);
      this.texA.update(this.dataA);
      this.texB.update(this.dataB);
      this.keyA = frame.territoryA;
      this.keyB = frame.territoryB;
    }
    v.fog = frame.fog === null ? 0 : 1;
    if (frame.fog !== null && this.keyFog !== frame.fog && frame.fog.length * 4 === this.fogData.length) {
      const fog = frame.fog;
      for (let i = 0; i < fog.length; i++) this.fogData[i * 4] = fog[i] === 1 ? 255 : 0;
      this.fogTex.update(this.fogData);
      this.keyFog = fog;
    }
    if (this.keyTrail !== frame.trails) {
      const t = frame.trails;
      const d = this.trailData;
      for (let i = 0, n = t.length / 2; i < n; i++) {
        d[i * 4] = t[i * 2]! * 255;
        d[i * 4 + 1] = t[i * 2 + 1]! * 255;
      }
      this.trailTex.update(d);
      this.keyTrail = t;
    }
  }
}
