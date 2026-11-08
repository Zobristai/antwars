/**
 * The 3D ground's albedo, upload data and shader wiring. NullEngine does not
 * compile/render GLSL: browser stills and timing remain the pixel/performance proof.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { mirrorAxis } from "../../web/src/terrain.ts";
import { Frame, TRAIL_RES } from "../../web/src/buffer.ts";
import { CLEAR_RGB, COLONY_RGB, EDGE_FADE_START_TILES, FRONT_HALF_WIDTH, Ground, OFFBOARD_BRIGHTNESS, OFFBOARD_FLATTEN_TILES, TRAIL_CELL_WIDTH } from "../../web/src/board3d/ground.ts";
import { heightAt, soilAt } from "../../web/src/board3d/noise.ts";
import { encodeTerritory } from "../../web/src/territory.ts";

describe("even 3D soil", () => {
  it("has only bounded fine grain, not broad or height-dependent colour patches", () => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const colour = [0, 0, 0];
    let finite = true;
    let hueError = 0;
    // Include the off-board margin and the large map, at sub-tile and broad scales.
    // Aggregate every sample before asserting, so assertion bookkeeping cannot dominate the full gate.
    for (let y = -32; y <= 160; y += 0.625) {
      for (let x = -32; x <= 160; x += 0.625) {
        soilAt(x, y, colour);
        for (let c = 0; c < 3; c++) {
          finite = finite && Number.isFinite(colour[c]);
          lo[c] = Math.min(lo[c]!, colour[c]!);
          hi[c] = Math.max(hi[c]!, colour[c]!);
        }
        hueError = Math.max(hueError, Math.abs(colour[0]! - colour[1]! + 0.02), Math.abs(colour[1]! - colour[2]! - 0.09));
      }
    }
    expect(finite).toBe(true);
    expect(hueError).toBeLessThan(0.5e-12);
    for (const [c, base] of [0.44, 0.46, 0.37].entries()) {
      expect(lo[c]).toBeGreaterThanOrEqual(base - 0.012);
      expect(hi[c]).toBeLessThanOrEqual(base + 0.012);
      expect(hi[c]! - lo[c]!).toBeLessThanOrEqual(0.024);
      expect(hi[c]! - lo[c]!).toBeGreaterThan(0.023);
    }
  });

  it("survives the 8-bit bake while averaging to the same neutral soil in every tile", () => {
    const levels = new Set<number>();
    const colour = [0, 0, 0];
    let maxTileDeviation = 0;
    for (let y = -4; y < 12; y++) for (let x = -4; x < 12; x++) {
      let sum = 0;
      for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) {
        soilAt(x + (i + 0.5) / 7, y + (j + 0.5) / 7, colour);
        sum += colour[0]!;
        levels.add(Math.floor(colour[0]! * 255));
      }
      maxTileDeviation = Math.max(maxTileDeviation, Math.abs(sum / 49 - 0.44));
    }
    expect(levels.size).toBeGreaterThanOrEqual(6);
    expect(levels.size).toBeLessThanOrEqual(8);
    expect(maxTileDeviation).toBeLessThan(0.004);
  });

  it("reuses the caller's output and stays constant inside each fine-grain cell", () => {
    const a = [NaN, NaN, NaN];
    const b = [0, 0, 0];
    expect(soilAt(2.001, 3.001, a)).toBeUndefined();
    soilAt(2.01, 3.01, b);
    expect(a).toEqual(b);
    soilAt(2.001, 3.001, b);
    expect(a).toEqual(b);
  });

  it.each([
    [0, 0, 0.8419059301215737],
    [1, 1, 1.1277439067809223],
    [40, 72, 0.23489758222188115],
    [-8, 128, 0.6898385499777175],
    [128, 128, 0.8082785780333013],
  ])("preserves baseline relief at (%s, %s)", (x, y, height) => {
    expect(heightAt(x, y)).toBe(height);
  });
});

let engine: NullEngine;
let scene: Scene;
let ground: Ground;
const W = 8;
const H = 4;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  ground = new Ground(scene, W, H);
});
afterEach(() => {
  vi.restoreAllMocks();
  scene.dispose();
  engine.dispose();
});

function frame(): Frame {
  const f = new Frame();
  f.territoryA = new Uint8Array(W * H);
  f.territoryB = new Uint8Array(W * H);
  f.trails = new Float32Array(W * H * TRAIL_RES * TRAIL_RES * 2);
  return f;
}

function textureSpy(texture: Ground["plugin"]["textures"]["a"]) {
  return vi.spyOn(texture as RawTexture, "update");
}

describe("3D ownership and trail uploads", () => {
  it("marks both colonies as owned and neutral as unowned without mutating shared 2D encodings", () => {
    const f = frame();
    f.territoryA.set([1, 2, 0, 1]);
    f.territoryB.set([0, 1, 2, 0]);
    const sharedA = encodeTerritory(f.territoryA, W, H);
    const sharedB = encodeTerritory(f.territoryB, W, H);
    const baselineA = sharedA.slice();
    const baselineB = sharedB.slice();
    const a = textureSpy(ground.plugin.textures.a);
    const b = textureSpy(ground.plugin.textures.b);
    f.blend = 0.375;
    ground.update(f, 2500);
    for (const [owners, encoded, upload] of [
      [f.territoryA, baselineA, a.mock.calls[0]![0]],
      [f.territoryB, baselineB, b.mock.calls[0]![0]],
    ] as const) {
      const bytes = upload as Uint8Array;
      for (let i = 0; i < W * H; i++) {
        expect(bytes[i * 4 + 2]).toBe(owners[i] === 0 ? 0 : 255);
        // G is now 3D-only opponent-edge flags, not the 2D front-distance field.
        for (const channel of [0, 3]) expect(bytes[i * 4 + channel]).toBe(encoded[i * 4 + channel]);
      }
    }
    expect((a.mock.calls[0]![0] as Uint8Array)[1]).toBe(2); // colony 0's right edge
    expect((a.mock.calls[0]![0] as Uint8Array)[5]).toBe(1); // colony 1's left edge
    expect((b.mock.calls[0]![0] as Uint8Array)[5]).toBe(2);
    expect((b.mock.calls[0]![0] as Uint8Array)[9]).toBe(1);
    expect(sharedA).toEqual(baselineA);
    expect(sharedB).toEqual(baselineB);
    expect(ground.plugin.values.blend).toBe(0.375);
    expect(ground.plugin.values.time).toBe(2.5);
    ground.update(f, 3000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // A new neutral snapshot must clear the previous owner's B channel in the reused upload buffer.
    f.territoryA = new Uint8Array(W * H);
    ground.update(f, 3500);
    expect(a).toHaveBeenCalledTimes(2);
    const neutral = a.mock.calls[1]![0] as Uint8Array;
    for (let i = 0; i < W * H; i++) expect([...neutral.subarray(i * 4, i * 4 + 4)]).toEqual([128, 0, 0, 255]);
  });

  it("flags only exact opposing edges, including corners and all four sides of an owned tile", () => {
    const f = frame();
    f.territoryA.set([2, 1, 2], 0);
    f.territoryA.set([1, 2, 1], W);
    f.territoryA.set([2, 1, 2], W * 2);
    const upload = textureSpy(ground.plugin.textures.a);
    ground.update(f, 0);
    const bytes = upload.mock.calls[0]![0] as Uint8Array;
    const edges = (x: number, y: number) => bytes[(y * W + x) * 4 + 1];
    expect(edges(0, 0)).toBe(2 | 8);
    expect(edges(1, 1)).toBe(1 | 2 | 4 | 8);
    expect(edges(0, 1)).toBe(2 | 4 | 8);
    expect(edges(2, 1)).toBe(1 | 4 | 8);
    expect(edges(1, 0)).toBe(1 | 2 | 8);
    expect(edges(1, 2)).toBe(1 | 2 | 4);
    expect(edges(3, 1)).toBe(0); // neutral next to owned tiles is never a front
  });

  it("draws no front across a neutral gap or a wrapped row/map edge", () => {
    const f = frame();
    f.territoryA.set([1, 0, 2], W * 2 + 2);
    f.territoryA[W - 1] = 1;
    f.territoryA[W] = 2;
    const upload = textureSpy(ground.plugin.textures.a);
    ground.update(f, 0);
    const bytes = upload.mock.calls[0]![0] as Uint8Array;
    for (let i = 0; i < W * H; i++) expect(bytes[i * 4 + 1]).toBe(0);
  });

  it("retains both trail channels and their upload cache", () => {
    const f = frame();
    f.trails.set([1, 0.5, 0.25, 1]);
    const upload = textureSpy(ground.plugin.textures.trail);
    ground.update(f, 0);
    const bytes = upload.mock.calls[0]![0] as Uint8Array;
    expect([...bytes.subarray(0, 8)]).toEqual([255, 127, 0, 0, 63, 255, 0, 0]);
    ground.update(f, 1);
    expect(upload).toHaveBeenCalledTimes(1);
    f.trails = new Float32Array(f.trails.length);
    ground.update(f, 2);
    expect(upload).toHaveBeenCalledTimes(2);
    expect([...(upload.mock.calls[1]![0] as Uint8Array).subarray(0, 8)]).toEqual(new Array(8).fill(0));
  });
});

describe("extended 3D ground geometry", () => {
  it.each([[64, 48], [128, 128]])("extends %sx%s with a smaller dense exterior and unchanged baked soil", (width, height) => {
    const backdrop = new Ground(scene, width, height);
    const denseMargin = Math.round(Math.max(width, height) * 0.25);
    const per = width > 100 ? 2 : 3, tpt = width > 100 ? 5 : 8;
    const originalVertices = ((width + 2 * denseMargin) * per + 1) * ((height + 2 * denseMargin) * per + 1);
    const bounds = backdrop.mesh.getBoundingInfo().boundingBox;
    expect(backdrop.margin).toBe(Math.max(width, height) * 2);
    expect(bounds.minimum.x).toBe(-backdrop.margin);
    expect(bounds.maximum.x).toBe(width + backdrop.margin);
    expect(bounds.minimum.z).toBe(-backdrop.margin);
    expect(bounds.maximum.z).toBe(height + backdrop.margin);
    expect(backdrop.mesh.getTotalVertices()).toBeLessThan(originalVertices);
    expect(backdrop.mesh.getTotalIndices() / 3).toBe(width === 64 ? 88_736 : 175_232);
    expect(backdrop.plugin.textures.soil.getSize()).toEqual({ width: (width + 2 * denseMargin) * tpt, height: (height + 2 * denseMargin) * tpt });
    expect(backdrop.plugin.soilMargin).toBe(denseMargin);
    expect(backdrop.plugin.margin).toBe(backdrop.margin);

    // The original uniform mesh's bilinear height, including Float32 storage. Actors/camera use this API.
    const baseline = (x: number, y: number) => {
      const fx = (x + denseMargin) * per, fy = (y + denseMargin) * per;
      const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const sample = (ix: number, iy: number) => Math.fround(heightAt(ix / per - denseMargin, iy / per - denseMargin));
      const a = sample(i, j), b = sample(i + 1, j), c = sample(i, j + 1), d = sample(i + 1, j + 1);
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
    for (const [x, y] of [[0, 0], [width, height], [8.125, 12.875], [width / 2 + 0.25, height / 2 + 0.125]]) {
      expect(backdrop.heightAt(x!, y!)).toBeCloseTo(baseline(x!, y!), 10);
    }
    // Queries on, and past, either far edge clamp to the actual final vertex, not a missing cell.
    for (const [x, y] of [[-backdrop.margin, -backdrop.margin], [width + backdrop.margin, height + backdrop.margin]]) {
      expect(Number.isFinite(backdrop.heightAt(x!, y!))).toBe(true);
      expect(backdrop.heightAt(x! * 2, y! * 2)).toBe(backdrop.heightAt(x!, y!));
    }
  });
});

describe("plain exterior and unchanged playable relief", () => {
  it.each([[64, 48, 1], [128, 128, 1], [192, 144, 3]])("preserves every in-bounds vertex and normal on %sx%s at scale %s", (width, height, scale) => {
    const backdrop = new Ground(scene, width, height, scale);
    // Reconstruct the baseline mesh independently, including its original broad mirrored band.
    const margin = Math.round(Math.max(width, height) * 0.25) / scale;
    const far = Math.max(width, height) * 2 / scale;
    const per = width / scale > 100 ? 2 : 3;
    const axis = (length: number) => [
      ...Array.from({ length: 16 }, (_, i) => (-far + i * (far - margin) / 16) * scale),
      ...Array.from({ length: (length + 2 * margin) * per + 1 }, (_, i) => (i / per - margin) * scale),
      ...Array.from({ length: 16 }, (_, i) => (length + margin + (i + 1) * (far - margin) / 16) * scale),
    ];
    const xs = axis(width / scale), ys = axis(height / scale);
    const original = new Float32Array(xs.length * ys.length * 3);
    const indices: number[] = [];
    for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
      const k = (j * xs.length + i) * 3;
      original.set([xs[i]!, heightAt(mirrorAxis(xs[i]!, width) / scale, mirrorAxis(ys[j]!, height) / scale) * scale, height - ys[j]!], k);
      if (i + 1 < xs.length && j + 1 < ys.length) {
        const a = j * xs.length + i, b = a + 1, c = a + xs.length;
        indices.push(a, c, b, b, c, c + 1);
      }
    }
    const normals = new Float32Array(original.length);
    VertexData.ComputeNormals(original, indices, normals);
    const baseline = new Map<string, number[]>();
    for (let k = 0; k < original.length; k += 3) if (original[k]! >= 0 && original[k]! <= width && original[k + 2]! >= 0 && original[k + 2]! <= height) {
      baseline.set(`${original[k]},${original[k + 2]}`, [original[k + 1]!, ...normals.subarray(k, k + 3)]);
    }
    const actual = backdrop.mesh.getVerticesData("position")!, actualNormals = backdrop.mesh.getVerticesData("normal")!;
    let compared = 0, mismatches = 0;
    for (let k = 0; k < actual.length; k += 3) if (actual[k]! >= 0 && actual[k]! <= width && actual[k + 2]! >= 0 && actual[k + 2]! <= height) {
      const before = baseline.get(`${actual[k]},${actual[k + 2]}`);
      const after = [actual[k + 1]!, ...actualNormals.slice(k, k + 3)];
      if (!before || after.some((v, i) => v !== before[i])) mismatches++;
      compared++;
    }
    expect(compared).toBe(baseline.size);
    expect(compared).toBeGreaterThan(20_000);
    expect(mismatches).toBe(0);
    // Query interpolation remains the complete original grid, even outside the map.
    const cell = (axis: number[], value: number) => {
      const clamped = Math.max(axis[0]!, Math.min(axis.at(-1)!, value));
      const upper = axis.findIndex(v => v > clamped);
      const i = upper < 0 ? axis.length - 2 : Math.max(0, upper - 1);
      // Baseline gridIndex first forms a fractional index, then subtracts its
      // integer part; retaining that rounding order permits exact query equality.
      const index = i + (clamped - axis[i]!) / (axis[i + 1]! - axis[i]!);
      return [i, index - i] as const;
    };
    const oldHeight = (x: number, y: number) => {
      const [i, u] = cell(xs, x), [j, v] = cell(ys, y);
      const at = (ix: number, iy: number) => original[(iy * xs.length + ix) * 3 + 1]!;
      return (at(i, j) + (at(i + 1, j) - at(i, j)) * u) * (1 - v) + (at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u) * v;
    };
    for (const [x, y] of [[-0.125, 12.3], [width + 1.5, 3.125], [-2, -2], [width + 2, height + 2], [-backdrop.margin * 0.6, 11], [10, height + backdrop.margin * 0.8], [-backdrop.margin * 2, -backdrop.margin * 2], [width + backdrop.margin * 2, height + backdrop.margin * 2]]) {
      expect(backdrop.heightAt(x!, y!)).toBe(oldHeight(x!, y!));
    }
  });

  it.each([1, 3])("joins all sides/corners continuously and becomes exactly flat after two physical tiles, scale %s", (scale) => {
    const width = 64 * scale, height = 48 * scale;
    const backdrop = new Ground(scene, width, height, scale);
    const band = OFFBOARD_FLATTEN_TILES * scale;
    const renderedHeight = (x: number, y: number) => {
      const hit = new Ray(new Vector3(x, 20 * scale, height - y), new Vector3(0, -1, 0)).intersectsMesh(backdrop.mesh);
      expect(hit.hit).toBe(true);
      return hit.pickedPoint!.y;
    };
    for (const [x, y, dx, dy] of [[0, 12 * scale, -1, 0], [width, 12 * scale, 1, 0], [20 * scale, 0, 0, -1], [20 * scale, height, 0, 1], [0, 0, -1, -1], [width, height, 1, 1]]) {
      const edge = renderedHeight(x!, y!);
      expect(renderedHeight(x! + dx! * 1e-6, y! + dy! * 1e-6)).toBeCloseTo(edge, 5);
      for (const distance of [band, band + scale, backdrop.margin]) expect(renderedHeight(x! + dx! * distance, y! + dy! * distance)).toBeCloseTo(0, 10);
      // Vertex-aligned transition samples follow the smooth taper, not reflected relief.
      for (const tiles of [1 / 3, 1, 5 / 3]) {
        const t = tiles / OFFBOARD_FLATTEN_TILES;
        expect(renderedHeight(x! + dx! * tiles * scale, y! + dy! * tiles * scale)).toBeCloseTo(edge * (1 - t * t * (3 - 2 * t)), 5);
      }
    }
    const positions = backdrop.mesh.getVerticesData("position")!, normals = backdrop.mesh.getVerticesData("normal")!;
    let flatVertices = 0, mismatches = 0;
    for (let k = 0; k < positions.length; k += 3) {
      const x = positions[k]!, y = height - positions[k + 2]!;
      if (Math.max(-x, x - width, -y, y - height) > band) {
        flatVertices++;
        if (positions[k + 1] !== 0 || Math.abs(normals[k]!) > 1e-7 || Math.abs(normals[k + 1]! - 1) > 1e-7 || Math.abs(normals[k + 2]!) > 1e-7) mismatches++;
      }
    }
    expect(flatVertices).toBeGreaterThan(1000);
    expect(mismatches).toBe(0);
  });

  it("derives its uniform albedo from the original quantized in-bounds soil without changing a baked texel", () => {
    const upload = vi.spyOn(RawTexture, "CreateRGBATexture");
    const backdrop = new Ground(scene, 8, 4);
    const bytes = upload.mock.calls[0]![0] as Uint8Array;
    const margin = 2, tpt = 8, width = (8 + 2 * margin) * tpt, height = (4 + 2 * margin) * tpt;
    const expected = new Uint8Array(bytes.length), colour = [0, 0, 0], sum = [0, 0, 0];
    let count = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const tx = x / tpt - margin, ty = y / tpt - margin, k = (y * width + x) * 4;
      soilAt(mirrorAxis(tx, 8), mirrorAxis(ty, 4), colour);
      expected.set([...colour.map(c => Math.max(0, Math.min(255, c * 255))), 255], k);
      if (tx >= 0 && tx < 8 && ty >= 0 && ty < 4) { for (let c = 0; c < 3; c++) sum[c]! += expected[k + c]!; count++; }
    }
    expect(bytes).toEqual(expected);
    expect(backdrop.plugin.offboardSoil).toEqual(sum.map(c => c / (count * 255)));
    expect(backdrop.plugin.offboardSoil.every(c => c > 0.35 && c < 0.5)).toBe(true);
  });

  it("gates every spatial sample inside one half-open playable branch, leaving only uniform colour, edge step and fade outside", () => {
    const diffuse = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    const condition = "if (awUV.x >= 0.0 && awUV.y >= 0.0 && awUV.x < 1.0 && awUV.y < 1.0) {";
    const branch = diffuse.indexOf(condition), end = diffuse.indexOf("\n}", branch);
    expect(diffuse.slice(0, branch)).toContain("vec3 awCol = uOffboardSoil;");
    expect(diffuse.slice(0, branch)).not.toContain("texture2D");
    expect(diffuse.slice(end)).not.toContain("texture2D");
    for (const sampler of ["uSoil", "uWater", "uA", "uB", "uTrail"]) expect(diffuse.slice(branch, end)).toContain(`texture2D(${sampler},`);
    expect(diffuse.slice(branch, end)).toContain("awWaterColour(awMirror)");
    expect(diffuse.slice(end)).toContain(`awCol *= ${OFFBOARD_BRIGHTNESS.toFixed(2)}`);
  });
});

describe("3D ground shader wiring (not rendered pixels)", () => {
  it("has no specular lobe but still receives the scene's diffuse light and shadows", () => {
    const material = ground.mesh.material;
    expect(material).toBeInstanceOf(StandardMaterial);
    const lit = material as StandardMaterial;
    expect(lit.specularColor.asArray()).toEqual([0, 0, 0]);
    expect(lit.diffuseColor.asArray()).toEqual([1, 1, 1]);
    expect(lit.disableLighting).toBe(false);
    expect(lit.emissiveColor.asArray()).toEqual([0, 0, 0]);
    expect(ground.mesh.receiveShadows).toBe(true);
  });

  it("uses bounded scalar grain only in the fill, before trail/front/water compositing", () => {
    const code = ground.plugin.getCustomCode("fragment")!;
    const defs = code.CUSTOM_FRAGMENT_DEFINITIONS!, diffuse = code.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(defs).toContain("float grain = clamp((soil.r - 0.44) / 0.44, -0.10, 0.10);");
    expect(defs).toContain("vec3 owned = awColony(s) * 0.48 * (1.0 + grain * 0.5);");
    expect(defs).toContain("return mix(soil, owned, 0.72 * s.b);");
    expect(diffuse.indexOf("awCol *= 1.0 - 0.42 * awInk")).toBeGreaterThan(diffuse.indexOf("awCol = mix(awFill"));
    expect(diffuse.indexOf("awCol = mix(awCol, awLineColour")).toBeGreaterThan(diffuse.indexOf("awCol *= 1.0 - 0.42 * awInk"));
    expect(diffuse.indexOf("awCol = mix(awCol, awWaterColour")).toBeGreaterThan(diffuse.indexOf("awCol = mix(awCol, awLineColour"));
  });

  it("keeps a clear playable-edge step and starts the gradual plain-ground fade beyond it", () => {
    const shader = ground.plugin.getCustomCode("fragment")!;
    const diffuse = shader.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!, fog = shader.CUSTOM_FRAGMENT_BEFORE_FOG!;
    expect(diffuse).not.toContain("awCol *= 0.4");
    expect(diffuse).toContain(`if (awUV.x < 0.0 || awUV.y < 0.0 || awUV.x >= 1.0 || awUV.y >= 1.0) awCol *= ${OFFBOARD_BRIGHTNESS.toFixed(2)};`);
    expect(diffuse.indexOf(`awCol *= ${OFFBOARD_BRIGHTNESS.toFixed(2)}`)).toBeGreaterThan(diffuse.indexOf("mix(awCol, awWaterColour(awMirror), awWet)"));
    expect(diffuse).toContain("(awMirror + uSoilMargin) / (uMap + 2.0 * uSoilMargin)");
    expect(diffuse).toContain("vec3 awCol = uOffboardSoil;");
    expect(EDGE_FADE_START_TILES).toBeGreaterThan(0);
    expect(fog).toContain(`smoothstep(${EDGE_FADE_START_TILES.toFixed(2)}, uMargin, max(awEdge.x, awEdge.y))`);
    expect(fog).toContain(`vec3(${CLEAR_RGB.map((c) => c.toFixed(6)).join(", ")})`);
  });

  it("lifts exterior albedo by 50% over the failed material while retaining a 25% edge step before lighting", () => {
    expect(OFFBOARD_BRIGHTNESS).toBe(0.75);
    const soil = [0, 0, 0];
    for (const [x, y] of [[0, 0], [3.25, 7.5], [-12, 24], [64, 48]]) {
      soilAt(x!, y!, soil);
      for (const channel of soil) {
        const outside = channel * OFFBOARD_BRIGHTNESS;
        expect(outside / (channel * 0.5)).toBeCloseTo(1.5);
        expect(outside / (channel * 0.4)).toBeCloseTo(1.875);
        expect(outside / channel).toBeCloseTo(0.75);
        expect(outside).toBeLessThan(channel);
      }
    }
    // Shader wiring, not GPU proof: the lift applies only after the off-board
    // condition, never on the interior water or fill.
    const diffuse = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(diffuse).toContain("awCol = mix(awFill(awA, awSoil), awFill(awB, awSoil), uBlend);");
    expect(diffuse).not.toContain("awCol *= 0.5");
    expect(ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_BEFORE_FOG).toContain(`smoothstep(${EDGE_FADE_START_TILES.toFixed(2)}, uMargin, max(awEdge.x, awEdge.y))`);
  });

  it("fills exact tile owners without warped edges and blends complete fills only over time", () => {
    const samplers: string[] = [];
    ground.plugin.getSamplers(samplers);
    expect(samplers).toEqual(["uA", "uB", "uTrail", "uSoil", "uWater", "uFog"]);
    expect(ground.plugin.getCustomCode("vertex")).toBeNull();
    const code = ground.plugin.getCustomCode("fragment")!;
    const defs = code.CUSTOM_FRAGMENT_DEFINITIONS!;
    const diffuse = code.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(defs).toContain("return mix(soil, owned, 0.72 * s.b);");
    expect(defs).not.toMatch(/vnoise|fbm|awOwnership/);
    expect(diffuse).toContain("vec2 awCell = clamp(floor(awTile), vec2(0.0), uMap - 1.0);");
    expect(diffuse).toContain("vec2 awCentre = (awCell + 0.5) / uMap;");
    expect(diffuse).toContain("vec4 awA = texture2D(uA, awCentre);");
    expect(diffuse).toContain("vec4 awB = texture2D(uB, awCentre);");
    expect(diffuse).toContain("awCol = mix(awFill(awA, awSoil), awFill(awB, awSoil), uBlend);");
  });

  it("bounds a light front to flagged edges, with no emissive glow", () => {
    const code = ground.plugin.getCustomCode("fragment")!;
    const defs = code.CUSTOM_FRAGMENT_DEFINITIONS!;
    const diffuse = code.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(FRONT_HALF_WIDTH * 2).toBeLessThan(1);
    expect(defs).toContain("floor(s.g * 255.0 + 0.5)");
    expect(defs).toContain("vec4(1.0, 2.0, 4.0, 8.0)");
    expect(defs).toContain(`smoothstep(vec4(0.08), vec4(${FRONT_HALF_WIDTH.toFixed(2)}), distanceToEdge)`);
    expect(defs).toContain("return mix(awColony(s), vec3(1.0), 0.18) * 0.65;");
    expect(diffuse).toContain("awCol = mix(awCol, awLineColour, awLine * uFrontOn);");
    expect(diffuse.indexOf("awCol = mix(awCol, awLineColour")).toBeGreaterThan(diffuse.indexOf("awCol *= 1.0 - 0.42 * awInk"));
    expect(code.CUSTOM_FRAGMENT_BEFORE_FOG).not.toContain("awFront");
    expect(ground.plugin.getUniforms().ubo.map((u) => u.name)).not.toContain("uFrontGlow");
    expect(ground.plugin.values).toMatchObject({ trails: 1, front: 1 });
  });

  it("draws dark, sub-tile trail strokes instead of additive colony fill", () => {
    const diffuse = ground.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
    expect(TRAIL_CELL_WIDTH / TRAIL_RES).toBeLessThan(0.25);
    expect(diffuse).toContain("texture2D(uTrail, awTrailUV).rg");
    expect(diffuse).toContain(`smoothstep(0.28, ${(TRAIL_CELL_WIDTH / 2).toFixed(2)}, max(abs(awTrailLocal.x), abs(awTrailLocal.y)))`);
    expect(diffuse).toContain("max(awTrail.r, awTrail.g)) * awStroke * uTrails;");
    expect(diffuse).toContain("awCol *= 1.0 - 0.42 * awInk;");
    expect(diffuse).not.toContain("awCol +=");
  });

  it("binds snapshot blending, colony hues, trail and front controls to the existing plugin", () => {
    const ubo = new UniformBuffer(engine);
    // NullEngine has no compiled Effect. Observe the external binding boundary, not GPU execution.
    vi.spyOn(ubo, "updateFloat2").mockImplementation(() => {});
    const floats = vi.spyOn(ubo, "updateFloat").mockImplementation(() => {});
    const colours = vi.spyOn(ubo, "updateFloat3").mockImplementation(() => {});
    const textures = vi.spyOn(ubo, "setTexture").mockImplementation(() => {});
    ground.plugin.values.blend = 0.4;
    ground.plugin.values.trails = 0;
    ground.plugin.bindForSubMesh(ubo, scene, engine, ground.mesh.subMeshes![0]!);
    expect(floats).toHaveBeenCalledWith("uMargin", ground.margin);
    expect(floats).toHaveBeenCalledWith("uSoilMargin", Math.round(Math.max(W, H) * 0.25));
    expect(ground.plugin.getUniforms().fragment).toContain("uniform float uSoilMargin;");
    expect(floats).toHaveBeenCalledWith("uBlend", 0.4);
    expect(floats).toHaveBeenCalledWith("uTrails", 0);
    expect(floats).toHaveBeenCalledWith("uFrontOn", 1);
    expect(colours).toHaveBeenCalledWith("uC0", ...COLONY_RGB[0], "");
    expect(colours).toHaveBeenCalledWith("uC1", ...COLONY_RGB[1], "");
    expect(colours).toHaveBeenCalledWith("uOffboardSoil", ...ground.plugin.offboardSoil, "");
    expect(ground.plugin.getUniforms().ubo).toContainEqual({ name: "uOffboardSoil", size: 3, type: "vec3" });
    expect(ground.plugin.getUniforms().fragment).toContain("uniform vec3 uOffboardSoil;");
    for (const [uniform, texture] of [["uA", "a"], ["uB", "b"], ["uTrail", "trail"], ["uSoil", "soil"], ["uWater", "water"]] as const) {
      expect(textures).toHaveBeenCalledWith(uniform, ground.plugin.textures[texture]);
    }
    ground.plugin.values.front = 0;
    ground.plugin.bindForSubMesh(ubo, scene, engine, ground.mesh.subMeshes![0]!);
    expect(floats).toHaveBeenLastCalledWith("uFrontOn", 0);
    ubo.dispose();
  });
});

describe("2D dry-interior regression locks", () => {
  // Locked ALL territory.ts bytes against ae32634ffe1fc4dfa0b38f88b5babceb12c24ecf.
  // Must add exact water shading/front exclusion and the inner boundary band.
  // Only that plumbing and those guarded branches are unlocked, not land ownership,
  // trails, temporal blending, front colour/shape, viewport geometry or encodings.
  // These hashes were measured before editing, on main 1eb159791a01dfefd4999024a8970ebe1305d1b7.
  const source = readFileSync(new URL("../../web/src/territory.ts", import.meta.url), "utf8");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  it("preserves ownership noise and the complete dry interior fill/trails/blend calculation", () => {
    expect(hash(source.slice(source.indexOf("// Ownership at uv"), source.indexOf("const FILL_FRAGMENT")))).toBe("c6bccbe988a6f6712159cc6e0e76ec28d1ae1f4077d1b0bd680c6110e1d412fb");
    const land = source.slice(source.indexOf("  vec4 s;", source.indexOf("const FILL_FRAGMENT")), source.indexOf("  col = awBoundary(col, vUV);"));
    expect(hash(land)).toBe("05e4110ad1ad497509a367463e112b02ce8cbecefbb35fcd6d82b1c5ebfba4c9");
  });
  it("preserves the complete front shader apart from water discard and boundary fade", () => {
    const front = source.slice(source.indexOf("const FRONT_FRAGMENT"), source.indexOf("export class Territory"))
      .replace("  if (awWaterAt(vUV) > 0.5) discard;\n", "")
      .replace("  finalColor *= awBoundaryWeight(vUV);\n", "");
    // Compared with main ff2979e629abff609b521ddd3502623dfc3c5562.
    // Exactly one rock-discard line changes the complete front; all other front bytes stay locked.
    expect(hash(front)).toBe("aa71a0fcb3c45f524ce993e317c63cb09ccf4c2aa32fdd4486a0fa091c18964e");
  });
  it("preserves encodings, front bounds, viewport geometry, controls and uploads apart from the water mask", () => {
    expect(hash(source.slice(source.indexOf("export function frontBounds")))).toBe("3a10df087f97171b350d7b4292233fbfc9c4ecd3e47174950b42cd75d40614c5");
    expect(hash(source.slice(source.indexOf("  setView(view:"), source.indexOf("  update(frame:")))).toBe("a55fac54e0f66a0dfef300451a587e1ce9866d169420a6bcb2c0f2958ae8ea31");
    const uploads = source.slice(source.indexOf("  update(frame:"), source.indexOf("/**\n * The tile rectangle"))
      .replace("    if (this.water.update(frame.board?.setup.terrain)) this.waterTex.source.update();\n", "");
    expect(hash(uploads)).toBe("903dcbaa345b3d31a90cb0e895548abf5fdf37bedf4baa7850bf018dd4168ac5");
  });
});
