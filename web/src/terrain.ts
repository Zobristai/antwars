/** Spectator-only geometry from the stream. Never reconstruct a map from its name or seed. */
import type { StreamSetup } from "../../src/live/format.ts";

export type StreamTerrain = StreamSetup["terrain"];

/** Reflect continuous coordinates at each edge, including corners and repeated reflections. */
export function mirrorAxis(value: number, size: number): number {
  if (value >= 0 && value <= size) return value;
  const period = 2 * size;
  const wrapped = ((value % period) + period) % period;
  return size - Math.abs(size - wrapped);
}

/** Half-open playable bounds. The decorative ring is never a place to select anything. */
export function onBoard(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Exact row-major RGBA terrain mask; R=255 water, G!=0 rock footprint.
 * G packs width/height, B local x/y offsets (four bits each); A is appearance.
 * The largest physical rock at quarter-size tiles is 12 by 4 (or 4 by 12).
 * Keep the water channel unchanged and never coarsen its single-tile steps. */
export class WaterMask {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  private key: StreamTerrain;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  update(terrain: StreamTerrain): boolean {
    if (terrain === this.key) return false;
    this.key = terrain;
    this.data.fill(0);
    for (const [x, y, w, h] of terrain?.water ?? []) {
      for (let ty = Math.max(0, y); ty < Math.min(this.height, y + h); ty++) {
        for (let tx = Math.max(0, x); tx < Math.min(this.width, x + w); tx++) {
          this.data[(ty * this.width + tx) * 4] = 255;
        }
      }
    }
    for (const [x, y, w, h, appearance] of terrain?.rocks ?? []) {
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h) ||
          w < 1 || h < 1 || w > 15 || h > 15 || x < 0 || y < 0 || x + w > this.width || y + h > this.height) continue;
      for (let ty = Math.max(0, y); ty < Math.min(this.height, y + h); ty++) {
        for (let tx = Math.max(0, x); tx < Math.min(this.width, x + w); tx++) {
          const at = (ty * this.width + tx) * 4;
          this.data[at + 1] = w | (h << 4);
          this.data[at + 2] = (tx - x) | ((ty - y) << 4);
          this.data[at + 3] = appearance;
        }
      }
    }
    return true;
  }
}

/** Quiet grey faceted stone, not colony tint, food or a moving effect. */
export const ROCK_GLSL = /* glsl */ `
vec3 awRockColour(vec2 tile, vec4 mask) {
  float dimensions = floor(mask.g * 255.0 + 0.5);
  float offsets = floor(mask.b * 255.0 + 0.5);
  vec2 size = vec2(mod(dimensions, 16.0), floor(dimensions / 16.0));
  vec2 offset = vec2(mod(offsets, 16.0), floor(offsets / 16.0));
  float appearance = floor(mask.a * 255.0 + 0.5);
  float angle = mod(appearance, 32.0) * 6.28318530718 / 32.0;
  float scale = 0.86 + mod(floor(appearance / 32.0), 4.0) * 0.14 / 3.0;
  vec2 p = ((fract(tile) + offset) / max(size, vec2(1.0)) - 0.5) / scale;
  if (appearance >= 128.0) p.x = -p.x;
  p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
  float rim = max(max(abs(p.x), abs(p.y)), (abs(p.x) + abs(p.y)) * 0.75);
  float shape = 1.0 - smoothstep(0.34, 0.37, rim);
  float facet = p.x + p.y * 0.7 > 0.0 ? 0.22 : 0.34;
  if (p.y > 0.12 && p.x < 0.12) facet = 0.17;
  return mix(vec3(0.08, 0.075, 0.065), vec3(facet * 0.96, facet, facet * 1.02), shape);
}
`;

/** Static, quiet blue water: distinct from earth and colony cyan, with no moving camera or waves. */
export const WATER_GLSL = /* glsl */ `
vec3 awWaterColour(vec2 tile) {
  float ripple = 0.5 + 0.5 * sin(tile.y * 12.0 + sin(tile.x * 3.0));
  return mix(vec3(0.09, 0.24, 0.30), vec3(0.14, 0.34, 0.41), ripple * 0.35);
}
`;

/** 2D's inner boundary band, in tiles. Outside it dry land shading stays unchanged. */
export const BOUNDARY_TILES = 1.25;
