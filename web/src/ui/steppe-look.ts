// The spectator HUD's board look: a mid-tone dry steppe of warm
// earth with dry-grass and gravel patches, boulders that shade and cast shadows, water shallow at its shore, and
// territory as a deeper colony wash edged where it ends.
// One recipe for both boards: the 3D board bakes it on the CPU (soil), the 2D board on the GPU (the GLSL twin below),
// at the same physical-tile coordinates with board3d/noise.ts's noise (which mirrors soil.ts NOISE_GLSL). Water and
// rocks come only from the streamed terrain mask; nothing here moves, widens or smooths a blocked tile.
import { fbm, hash12, vnoise } from "../board3d/noise.ts";
import { NOISE_GLSL } from "../soil.ts";
import { TRAIL_RES } from "../buffer.ts";
import type { BoardLook, Rgb } from "../board-look.ts";

/** sRGB albedo, a little darker than sand so the pale ants and both colony hues stand out on it. */
export const EARTH_LIGHT: Rgb = [0.70, 0.61, 0.46];
export const EARTH_DEEP: Rgb = [0.59, 0.50, 0.37];
export const STRAW_DRY: Rgb = [0.63, 0.61, 0.41];
export const STRAW_GREEN: Rgb = [0.52, 0.56, 0.35];
export const GRAVEL_LIGHT: Rgb = [0.65, 0.63, 0.58];
export const GRAVEL_DARK: Rgb = [0.53, 0.51, 0.47];
export const PEBBLE: Rgb = [0.41, 0.37, 0.31];
/** Territory washes: amber toward orange and cyan toward blue, so both read on warm earth (the colonies' own hues stay). */
export const HUE: readonly [Rgb, Rgb] = [[0.96, 0.55, 0.05], [0.0, 0.58, 0.98]];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Round specks, one chance per cell of a grid `freq` cells per tile: a jittered point with a radius, so pebbles and
 * tufts read as stones and clumps rather than the square blobs thresholded value noise makes.
 */
export function specks(x: number, y: number, freq: number, density: number, salt: number): number {
  const px = x * freq, py = y * freq;
  const cx = Math.floor(px), cy = Math.floor(py);
  let m = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ix = cx + i + salt, iy = cy + j;
      if (hash12(ix * 1.37 + 0.5, iy * 1.37 + 0.5) > density) continue;
      const dx = cx + i + hash12(ix + 3.1, iy + 3.1) - px, dy = cy + j + hash12(ix + 7.7, iy + 7.7) - py;
      const r = 0.14 + 0.14 * hash12(ix + 11.3, iy + 11.3);
      m = Math.max(m, 1 - smoothstep(r * 0.6, r, Math.hypot(dx, dy)));
    }
  }
  return m;
}

/** The steppe's colour at physical tile (x, y), without relief shading (the 3D board lights its own relief). */
export function steppe(x: number, y: number, out: number[]): void {
  const broad = fbm(x * 0.05 + 2.3, y * 0.05 + 7.1, 4);
  const detail = vnoise(x * 0.37 + 5.1, y * 0.37 + 1.3);
  const grass = smoothstep(0.5, 0.6, broad + (detail - 0.5) * 0.24);
  const gravel = smoothstep(0.66, 0.76, fbm(x * 0.09 + 9.2, y * 0.09 + 3.4, 3)) * (1 - grass);
  const tone = smoothstep(0.25, 0.8, vnoise(x * 0.21 + 1.1, y * 0.21 + 6.6));
  const straw = vnoise(x * 0.8 + 3.3, y * 0.8 + 2.2);
  const stone = vnoise(x * 1.9 + 0.7, y * 1.9 + 4.4);
  const tuft = specks(x, y, 1.6, 0.55, 17) * grass;
  const pebble = specks(x, y, 2.4, 0.3, 41) * (1 - grass);
  const grain = (hash12(Math.floor(x * 7), Math.floor(y * 7)) - 0.5) * 0.035;
  for (let c = 0; c < 3; c++) {
    let v = mix(mix(EARTH_DEEP[c]!, EARTH_LIGHT[c]!, tone), mix(STRAW_DRY[c]!, STRAW_GREEN[c]!, straw), grass);
    v = mix(v, mix(GRAVEL_DARK[c]!, GRAVEL_LIGHT[c]!, stone), gravel * 0.9);
    v = mix(v, v * 0.74, tuft * 0.7);
    out[c] = mix(v, PEBBLE[c]!, pebble * 0.6) + grain;
  }
}

const vec3 = (c: Rgb) => `vec3(${c.map(v => v.toFixed(4)).join(", ")})`;

/** GLSL twins of steppe and of board3d/noise.ts fbm (any octave count) and heightAt. Needs NOISE_GLSL. */
export const STEPPE_GLSL = /* glsl */ `
float d1Fbm(vec2 p, const int octaves) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}
float d1Height(vec2 q) {
  float broad = d1Fbm(q * 0.045 + vec2(3.1, 7.7), 4) - 0.5;
  float ridge = 1.0 - abs(d1Fbm(q * 0.09 + vec2(11.3, 2.9), 3) * 2.0 - 1.0);
  float fine = vnoise(q * 0.55) - 0.5;
  return broad * 3.2 + ridge * ridge * 0.9 + fine * 0.18;
}
float d1Specks(vec2 q, float freq, float density, float salt) {
  vec2 p = q * freq;
  vec2 cell = floor(p);
  float m = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = cell + vec2(float(i) + salt, float(j));
      if (hash12(id * 1.37 + 0.5) > density) continue;
      vec2 d = cell + vec2(float(i), float(j)) + vec2(hash12(id + 3.1), hash12(id + 7.7)) - p;
      float r = 0.14 + 0.14 * hash12(id + 11.3);
      m = max(m, 1.0 - smoothstep(r * 0.6, r, length(d)));
    }
  }
  return m;
}
vec3 d1Steppe(vec2 q) {
  float broad = d1Fbm(q * 0.05 + vec2(2.3, 7.1), 4);
  float detail = vnoise(q * 0.37 + vec2(5.1, 1.3));
  float grass = smoothstep(0.5, 0.6, broad + (detail - 0.5) * 0.24);
  float gravel = smoothstep(0.66, 0.76, d1Fbm(q * 0.09 + vec2(9.2, 3.4), 3)) * (1.0 - grass);
  float tone = smoothstep(0.25, 0.8, vnoise(q * 0.21 + vec2(1.1, 6.6)));
  float straw = vnoise(q * 0.8 + vec2(3.3, 2.2));
  float stone = vnoise(q * 1.9 + vec2(0.7, 4.4));
  float tuft = d1Specks(q, 1.6, 0.55, 17.0) * grass;
  float pebble = d1Specks(q, 2.4, 0.3, 41.0) * (1.0 - grass);
  float grain = (hash12(floor(q * 7.0)) - 0.5) * 0.035;
  vec3 v = mix(mix(${vec3(EARTH_DEEP)}, ${vec3(EARTH_LIGHT)}, tone), mix(${vec3(STRAW_DRY)}, ${vec3(STRAW_GREEN)}, straw), grass);
  v = mix(v, mix(${vec3(GRAVEL_DARK)}, ${vec3(GRAVEL_LIGHT)}, stone), gravel * 0.9);
  v = mix(v, v * 0.74, tuft * 0.7);
  return mix(v, ${vec3(PEBBLE)}, pebble * 0.6) + grain;
}
`;

/** Light from the upper left, as the 3D board's key light falls, high enough that flat ground keeps its colour. */
const LIGHT_2D = [-0.55, -0.45, 0.70] as const;

/** The 2D soil, baked once over the whole map: the steppe, relief-shaded from the 3D board's own height field. */
export const SOIL_2D = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform vec2 uSize;
uniform vec2 uMap;
${NOISE_GLSL}
${STEPPE_GLSL}
void main() {
  vec2 q = vUV * uMap;
  vec3 col = d1Steppe(q);
  float e = 0.5;
  vec2 g = vec2(d1Height(q + vec2(e, 0.0)) - d1Height(q - vec2(e, 0.0)), d1Height(q + vec2(0.0, e)) - d1Height(q - vec2(0.0, e))) / (2.0 * e);
  vec3 n = normalize(vec3(-g * 1.4, 1.0));
  vec3 l = normalize(vec3(${LIGHT_2D.join(", ")}));
  col *= clamp(1.0 + 0.7 * (dot(n, l) - l.z), 0.8, 1.16);
  finalColor = vec4(col, 1.0);
}`;

/** Water by its distance to the shore, inside its own tiles only: shallows at the bank, a light line where it meets land. */
const WATER_2D = (wet: string) => /* glsl */ `
vec3 d1Water(vec2 tile, float time) {
  vec2 cell = floor(tile);
  float d = 1.6;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      if (${wet}(c) > 0.5) continue;
      d = min(d, length(tile - clamp(tile, c, c + 1.0)));
    }
  }
  float depth = smoothstep(0.0, 1.5, d);
  vec3 col = mix(vec3(0.36, 0.58, 0.60), vec3(0.15, 0.36, 0.44), depth);
  float ripple = 0.5 + 0.5 * sin(tile.x * 2.1 + tile.y * 4.3 + time * 0.8 + 3.0 * vnoise(tile * 0.7));
  col *= 0.97 + 0.05 * ripple;
  return mix(col, vec3(0.78, 0.85, 0.82), (1.0 - smoothstep(0.03, 0.12, d)) * 0.45);
}
`;

/** The 2D ground pass: the baked steppe, water, boulders with their shadows, the territory wash and trails. */
function fill2d(prelude: string): string {
  return /* glsl */ `${prelude}
in vec2 vScreen;
uniform sampler2D uSoil;
uniform sampler2D uTrail;
vec4 d1Cell(vec2 cell) { return texture(uWater, (clamp(cell, vec2(0.0), uMap - 1.0) + 0.5) / uMap); }
bool d1On(vec2 c) { return c.x >= 0.0 && c.y >= 0.0 && c.x < uMap.x && c.y < uMap.y; }
float d1Wet(vec2 c) { return d1On(c) ? step(0.5, d1Cell(c).r) : 0.0; }
float d1Stone(vec2 c) { return d1On(c) ? step(0.5 / 255.0, d1Cell(c).g) : 0.0; }
${WATER_2D("d1Wet")}
// A boulder over its streamed footprint: a rounded stone lit from the upper left with lichen on it, and scree in the
// footprint's corners, so the whole blocked footprint still reads as rock.
vec3 d1Boulder(vec2 tile, vec4 mask, vec3 ground) {
  float dims = floor(mask.g * 255.0 + 0.5);
  float offs = floor(mask.b * 255.0 + 0.5);
  float look = floor(mask.a * 255.0 + 0.5);
  vec2 size = max(vec2(mod(dims, 16.0), floor(dims / 16.0)), vec2(1.0));
  vec2 off = vec2(mod(offs, 16.0), floor(offs / 16.0));
  vec2 d = fract(tile) + off - size * 0.5;
  float r = min(size.x, size.y) * 0.34;
  vec2 k = abs(d) - (size * 0.5 - r - 0.04);
  float sdf = length(max(k, 0.0)) + min(max(k.x, k.y), 0.0) - r;
  vec3 n = normalize(vec3(d / (size * 0.5) * 0.9, 1.0));
  float lit = clamp(0.36 + 0.74 * dot(n, normalize(vec3(-0.55, -0.62, 0.56))), 0.28, 1.12);
  float lichen = vnoise(tile * 1.7 + look * 0.37);
  vec3 stone = mix(vec3(0.55, 0.52, 0.47), vec3(0.64, 0.62, 0.55), smoothstep(0.55, 0.82, lichen));
  stone = mix(stone, vec3(0.40, 0.38, 0.34), smoothstep(0.22, 0.06, lichen) * 0.6);
  vec3 body = stone * lit * mix(0.62, 1.0, smoothstep(0.0, -0.14, sdf));
  vec3 scree = mix(vec3(0.42, 0.40, 0.37), ground * 0.6, 0.35) * (0.9 + 0.2 * hash12(floor(tile * 5.0)));
  return mix(scree, body, step(sdf, 0.0));
}
void main() {
  if (vUV.x < 0.0 || vUV.y < 0.0 || vUV.x > 1.0 || vUV.y > 1.0) discard;
  vec2 tile = vUV * uMap;
  vec2 cell = clamp(floor(tile), vec2(0.0), uMap - 1.0);
  vec4 mask = d1Cell(cell);
  if (mask.r > 0.5) { finalColor = vec4(d1Water(tile, uTime), 1.0); return; }
  vec3 col = texture(uSoil, vUV).rgb;
  if (mask.g > 0.5 / 255.0) { finalColor = vec4(d1Boulder(tile, mask, col), 1.0); return; }
  // Fine grain, sharp at any zoom.
  col *= 0.975 + 0.05 * hash12(floor(tile * 8.0));
  // Damp ground at the water's edge, and each boulder's shadow below and right of it: only beside them.
  float near = d1Wet(cell + vec2(1.0, 0.0)) + d1Wet(cell - vec2(1.0, 0.0)) + d1Wet(cell + vec2(0.0, 1.0)) + d1Wet(cell - vec2(0.0, 1.0))
    + d1Stone(cell - vec2(1.0, 0.0)) + d1Stone(cell - vec2(0.0, 1.0)) + d1Stone(cell - vec2(1.0, 1.0));
  if (near > 0.0) {
    float dw = 1.5;
    float dr = 1.5;
    vec2 shade = tile - vec2(0.22, 0.28);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        if (d1Wet(c) > 0.5) dw = min(dw, length(tile - clamp(tile, c, c + 1.0)));
        if (d1Stone(c) > 0.5) dr = min(dr, length(shade - clamp(shade, c, c + 1.0)));
      }
    }
    col *= mix(0.82, 1.0, smoothstep(0.0, 0.8, dw));
    col *= mix(0.7, 1.0, smoothstep(0.0, 0.45, dr));
  }
  // Territory: a wash of the colony's hue, deeper toward the front, edged where it meets unheld ground.
  vec4 s;
  float r = ownership(vUV, s);
  float w0 = clamp(r * 2.0 - 1.0, 0.0, 1.0);
  float w1 = clamp(1.0 - r * 2.0, 0.0, 1.0);
  float own = max(w0, w1);
  vec3 hue = w0 >= w1 ? ${vec3(HUE[0])} : ${vec3(HUE[1])};
  // Cyan on warm earth greys sooner than amber does, so its wash is a little deeper.
  float wash = (0.28 + 0.18 * s.g * s.g) * smoothstep(0.5, 0.78, own) * (w0 >= w1 ? 1.0 : 1.3);
  col = mix(col, mix(col, hue, 0.6), wash);
  float rim = (1.0 - smoothstep(0.0, 0.16, abs(own - 0.5))) * step(0.02, own);
  col = mix(col, hue * 0.5, rim * 0.75);
  // Trails: ground compacted by traffic, a little darker.
  vec2 tr = texture(uTrail, vUV).rg * uTrails;
  col *= 1.0 - 0.18 * clamp(tr.x + tr.y, 0.0, 1.0);
  // The playable edge: a crisp darker lip just inside it.
  vec2 lip = min(vUV, 1.0 - vUV) * uMap;
  col *= mix(0.7, 1.0, smoothstep(0.0, 0.8, min(lip.x, lip.y)));
  finalColor = vec4(col, 1.0);
}`;
}

/** Where the colonies meet: a dark seam with each colony's hue glowing on its own side, premultiplied. */
function front2d(prelude: string): string {
  return /* glsl */ `${prelude}
void main() {
  if (awWaterAt(vUV) > 0.5 || awRockAt(vUV) > 0.5) discard;
  vec4 s;
  float r = ownership(vUV, s);
  if (s.g < 0.45) discard;
  float d = abs(r - 0.5);
  float near = smoothstep(0.45, 0.9, s.g);
  float seam = (1.0 - smoothstep(0.02, 0.09, d)) * near;
  float glow = (1.0 - smoothstep(0.0, 0.4, d)) * near * 0.4;
  if (seam + glow < 0.01) discard;
  vec3 side = r > 0.5 ? ${vec3(HUE[0])} : ${vec3(HUE[1])};
  float a = clamp(seam * 0.8 + glow * 0.45, 0.0, 1.0);
  vec3 col = vec3(0.10, 0.08, 0.06) * seam * 0.8 + side * glow * 0.45;
  finalColor = vec4(col, a) * awBoundaryWeight(vUV);
}`;
}

/** The 3D ground's added helpers, after Current's (board3d/ground.ts DEFS). */
const DEFINITIONS_3D = /* glsl */ `
#ifdef AW_GROUND
${NOISE_GLSL}
vec3 d1Hue(vec4 s) { return mix(${vec3(HUE[1])}, ${vec3(HUE[0])}, step(0.75, s.r)); }
vec3 d1Owned(vec4 s, vec3 soil) { return mix(soil, mix(soil, d1Hue(s), 0.6), 0.45 * s.b); }
float d1WetCell(vec2 c) {
  if (c.x < 0.0 || c.y < 0.0 || c.x >= uMap.x || c.y >= uMap.y) return 1.0;
  return step(0.5, texture2D(uWater, (c + 0.5) / uMap).r);
}
${WATER_2D("d1WetCell")}
#endif
`;

/**
 * The 3D ground's colour before lighting, in place of the plain code: the baked steppe, the wash, trails, the seam,
 * water. Beyond the playable bounds the ground is one plain shade, the steppe's in-bounds mean (ground.ts).
 */
const DIFFUSE_3D = /* glsl */ `
#ifdef AW_GROUND
vec2 awTile = vec2(vPositionW.x, uMap.y - vPositionW.z);
vec2 awUV = awTile / uMap;
vec3 awCol = uOffboardSoil;
if (awUV.x >= 0.0 && awUV.y >= 0.0 && awUV.x < 1.0 && awUV.y < 1.0) {
  vec2 awMirror = uMap - abs(mod(awTile, 2.0 * uMap) - uMap);
  vec3 awSoil = texture2D(uSoil, (awMirror + uSoilMargin) / (uMap + 2.0 * uSoilMargin)).rgb;
  vec2 awWaterCell = clamp(floor(awMirror), vec2(0.0), uMap - 1.0);
  float awWet = texture2D(uWater, (awWaterCell + 0.5) / uMap).r;
  vec2 awCell = clamp(floor(awTile), vec2(0.0), uMap - 1.0);
  vec2 awCentre = (awCell + 0.5) / uMap;
  vec2 awLocal = awTile - awCell;
  vec4 awA = texture2D(uA, awCentre);
  vec4 awB = texture2D(uB, awCentre);
  awCol = mix(d1Owned(awA, awSoil), d1Owned(awB, awSoil), uBlend);
  vec2 awTrailCell = clamp(floor(awTile * ${TRAIL_RES.toFixed(1)}), vec2(0.0), uMap * ${TRAIL_RES.toFixed(1)} - 1.0);
  vec2 awTrail = texture2D(uTrail, (awTrailCell + 0.5) / (uMap * ${TRAIL_RES.toFixed(1)})).rg;
  vec2 awTrailLocal = awTile * ${TRAIL_RES.toFixed(1)} - awTrailCell - 0.5;
  float awStroke = 1.0 - smoothstep(0.28, 0.4, max(abs(awTrailLocal.x), abs(awTrailLocal.y)));
  awCol *= 1.0 - 0.3 * smoothstep(0.04, 0.32, max(awTrail.r, awTrail.g)) * awStroke * uTrails;
  float awLine = awBorder(awA, awLocal) * (1.0 - uBlend) + awBorder(awB, awLocal) * uBlend;
  awCol = mix(awCol, vec3(0.11, 0.09, 0.07), clamp(awLine, 0.0, 1.0) * 0.75 * uFrontOn);
  if (awWet > 0.5) awCol = d1Water(awMirror, uTime);
}
if (awUV.x < 0.0 || awUV.y < 0.0 || awUV.x >= 1.0 || awUV.y >= 1.0) awCol *= 0.62;
baseColor.rgb = awCol;
#endif
`;

/** The steppe look; the HUD sets it on mount and clears it when it unmounts (board-look.ts). */
export const STEPPE_LOOK: BoardLook = {
  id: 1,
  board2d: { soil: SOIL_2D, fill: fill2d, front: front2d },
  board3d: {
    soil: steppe,
    ground: (point, current) => point === "definitions" ? current + DEFINITIONS_3D : point === "diffuse" ? DIFFUSE_3D : current,
    rock: [0.56, 0.53, 0.48],
    // Neutral daylight from the same quarter as Current's warm key, so the ground shows its own colour.
    light: {
      key: [1.0, 0.97, 0.92], keyIntensity: 1.45, fill: [0.8, 0.86, 0.95], fillGround: [0.33, 0.3, 0.26], fillIntensity: 0.6,
      shadowDarkness: 0.28, contrast: 1.0, vignetteWeight: 0.9,
    },
  },
};

