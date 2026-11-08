/**
 * Light, desaturated earth from a noise shader, with a gentle colour vignette.
 * The soil does not move, so it is rendered once into a texture at start-up;
 * the territory pass samples it, so the noise costs nothing per frame.
 */
import { Geometry, Mesh, RenderTexture, Shader, type Renderer } from "pixi.js";
import { boardLook } from "./board-look.ts";

export const QUAD_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

/** Value noise and fbm shared by the soil and territory shaders. */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return v;
}
float fbm3(vec2 p) {
  return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + vec2(17.1, 9.7)) + 0.125 * vnoise(p * 4.1 + vec2(3.3, 21.4));
}`;

const SOIL_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform vec2 uSize;
${NOISE_GLSL}
void main() {
  vec2 p = vUV * uSize / 90.0;
  float large = fbm(p * 0.6);
  float mid = fbm(p * 2.1 + 4.0);
  float grain = hash12(floor(vUV * uSize / 1.5));
  // Calm texture: low-contrast mottling and few pebbles, so ants read before the ground.
  float pebble = smoothstep(0.80, 0.88, vnoise(p * 7.0)) * 0.25;
  vec3 deep = vec3(0.440, 0.460, 0.370);
  vec3 warm = vec3(0.570, 0.590, 0.490);
  vec3 col = mix(deep, warm, smoothstep(0.25, 0.8, large));
  col *= 0.9 + 0.15 * mid;
  col += (grain - 0.5) * 0.016 + pebble * vec3(0.06, 0.05, 0.04);
  vec2 q = vUV - 0.5;
  float vig = smoothstep(0.85, 0.2, length(q * vec2(1.15, 1.0)));
  col *= mix(0.78, 1.0, vig);
  finalColor = vec4(col, 1.0);
}`;

export function quadGeometry(w: number, h: number): Geometry {
  return new Geometry({
    attributes: {
      aPosition: [0, 0, w, 0, w, h, 0, h],
      aUV: [0, 0, 1, 0, 1, 1, 0, 1],
    },
    indexBuffer: [0, 1, 2, 0, 2, 3],
  });
}

/**
 * Bake the soil for a screen of w x h CSS pixels into a texture. The board look (board-look.ts)
 * bakes its own soil over the whole map instead, `map` being its size in physical tiles.
 */
export function bakeSoil(renderer: Renderer, w: number, h: number, map: { w: number; h: number } = { w: 1, h: 1 }): RenderTexture {
  const look = boardLook()?.board2d;
  const shader = look
    ? Shader.from({
      gl: { vertex: QUAD_VERTEX, fragment: look.soil },
      resources: { soilUniforms: { uSize: { value: [w, h], type: "vec2<f32>" }, uMap: { value: [map.w, map.h], type: "vec2<f32>" } } },
    })
    : Shader.from({
      gl: { vertex: QUAD_VERTEX, fragment: SOIL_FRAGMENT },
      resources: { soilUniforms: { uSize: { value: [w, h], type: "vec2<f32>" } } },
    });
  const mesh = new Mesh({ geometry: quadGeometry(w, h), shader });
  const target = RenderTexture.create({ width: w, height: h, resolution: renderer.resolution });
  renderer.render({ container: mesh, target });
  mesh.destroy();
  return target;
}
