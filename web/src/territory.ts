/**
 * Ground: soil, territory, front line and ant-traffic trails
 * (tuned).
 *
 * The ground is one opaque full-screen pass: it samples the baked soil and lays
 * the territory over it, because on SwiftShader every extra full-screen layer
 * costs several milliseconds. Territory is a light tint, strongest near the
 * front and fading inward, so the soil shows.
 *
 * Each snapshot's ownership grid becomes a W x H texture: R = ownership
 * (1 colony 0, 0 colony 1, 0.5 neutral), G = closeness to the front (1 at a tile
 * bordering the other colony, falling to 0 over FRONT_REACH tiles). A shader
 * blends the two bracketing snapshots' textures by the playback fraction, so a
 * tile that changes hands fades between them; noise roughens the edges. The
 * front line is a second mesh over the same textures, drawing a bright band where
 * the colonies meet inside a soft glow drawn by the same shader (the bloom), sized
 * each frame to the tiles the front spans. Trails are a finer grid
 * (TRAIL_RES cells per tile) sampled by the ground pass as thin, faint paths.
 */
import { BufferImageSource, Container, Geometry, Mesh, Shader, Texture, type RenderTexture } from "pixi.js";
import { boardLook } from "./board-look.ts";
import { NOISE_GLSL, QUAD_VERTEX, quadGeometry } from "./soil.ts";
import { TRAIL_RES, type Frame } from "./buffer.ts";
import { BOUNDARY_TILES, ROCK_GLSL, WATER_GLSL, WaterMask } from "./terrain.ts";

/** Tiles over which the territory tint fades from the front inward. */
const FRONT_REACH = 10;

const GROUND_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
in vec2 aScreen;
out vec2 vUV;
out vec2 vScreen;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vScreen = aScreen;
}`;

export const COLONY_RGB: readonly [readonly number[], readonly number[]] = [
  [1.0, 0xb0 / 255, 0.0], // Very Large Colony, amber #FFB000
  [0.0, 0xc2 / 255, 1.0], // Lake Hodges Colony, cyan #00C2FF
];

const COMMON = /* glsl */ `
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uBlend;
uniform vec2 uMap;
uniform float uTrails;
uniform float uTime;
uniform vec3 uC0;
uniform vec3 uC1;
uniform sampler2D uWater;
${WATER_GLSL}
${ROCK_GLSL}
float awRockAt(vec2 uv) {
  vec2 cell = clamp(floor(uv * uMap), vec2(0.0), uMap - 1.0);
  return step(0.5 / 255.0, texture(uWater, (cell + 0.5) / uMap).g);
}
float awWaterAt(vec2 uv) {
  vec2 cell = clamp(floor(uv * uMap), vec2(0.0), uMap - 1.0);
  return texture(uWater, (cell + 0.5) / uMap).r;
}
float awBoundaryWeight(vec2 uv) {
  vec2 edge = min(uv, 1.0 - uv) * uMap;
  return smoothstep(0.0, ${BOUNDARY_TILES.toFixed(2)}, min(edge.x, edge.y));
}
vec3 awBoundary(vec3 colour, vec2 uv) {
  return mix(vec3(0.043137, 0.031373, 0.019608), colour, awBoundaryWeight(uv));
}
${NOISE_GLSL}
// Ownership at uv (1 colony 0, 0 colony 1), blended between snapshots, with a
// noisy edge near the front. s.g is closeness to the front.
float ownership(vec2 uv, out vec4 s) {
  vec2 tile = uv * uMap;
  float n = vnoise(tile * 0.6) - 0.5;
  vec2 warp = vec2(n, -n) * 0.9 / uMap;
  s = mix(texture(uA, uv + warp), texture(uB, uv + warp), uBlend);
  float r = s.r;
  if (s.g > 0.3) r += (fbm3(tile * 1.9) - 0.44) * 0.3 * s.g;
  return r;
}`;

const FILL_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vScreen;
uniform sampler2D uSoil;
uniform sampler2D uTrail;
void main() {
  vec3 soil = texture(uSoil, vScreen).rgb;
  if (vUV.x < 0.0 || vUV.y < 0.0 || vUV.x > 1.0 || vUV.y > 1.0) { finalColor = vec4(soil, 1.0); return; }
  if (awWaterAt(vUV) > 0.5) {
    finalColor = vec4(awBoundary(awWaterColour(vUV * uMap), vUV), 1.0);
    return;
  }
  if (awRockAt(vUV) > 0.5) {
    vec2 rockCell = clamp(floor(vUV * uMap), vec2(0.0), uMap - 1.0);
    vec4 rockMask = texture(uWater, (rockCell + 0.5) / uMap);
    finalColor = vec4(awBoundary(awRockColour(vUV * uMap, rockMask), vUV), 1.0);
    return;
  }
  vec4 s;
  float r = ownership(vUV, s);
  float w0 = clamp(r * 2.0 - 1.0, 0.0, 1.0);
  float w1 = clamp(1.0 - r * 2.0, 0.0, 1.0);
  // A light tint over the soil, strongest near the front and fading inward.
  float tint = (0.04 + 0.2 * s.g * s.g) * (w0 + w1);
  vec3 hue = (uC0 * 0.85 * w0 + uC1 * w1) / max(w0 + w1, 0.001);
  vec3 col = mix(soil, hue * 0.55 + soil * 0.45, tint);
  // Thin, faint paths: a slight lightening in each colony's hue.
  vec2 tr = texture(uTrail, vUV).rg * uTrails;
  col += (uC0 * 0.85 * tr.x + uC1 * tr.y) * 0.2;
  col = awBoundary(col, vUV);
  finalColor = vec4(col, 1.0);
}`;

/**
 * The front line with its bloom drawn in one pass (a shader-drawn glow stands
 * in for the bloom filter): a narrow bright band where the colonies meet,
 * inside a wider, soft glow that falls off from it.
 */
const FRONT_FRAGMENT = /* glsl */ `${COMMON}
void main() {
  if (awWaterAt(vUV) > 0.5) discard;
  if (awRockAt(vUV) > 0.5) discard;
  vec4 s;
  float r = ownership(vUV, s);
  if (s.g < 0.45) discard;
  float d = abs(r - 0.5);
  float near = smoothstep(0.45, 0.9, s.g);
  float band = (1.0 - smoothstep(0.0, 0.15, d)) * near;
  float glow = (1.0 - smoothstep(0.0, 0.5, d)) * near;
  glow = glow * glow * 0.35;
  if (band + glow < 0.01) discard;
  vec2 tile = vUV * uMap;
  float flicker = 0.85 + 0.15 * vnoise(tile * 2.3 + vec2(uTime * 0.7, -uTime * 0.4));
  vec3 side = uC0 * clamp(r * 2.0 - 0.5, 0.0, 1.0) + uC1 * clamp(1.5 - r * 2.0, 0.0, 1.0);
  vec3 hot = mix(vec3(1.0, 0.96, 0.86), side, 0.7);
  float a = min(1.0, band * flicker);
  float g = glow * flicker;
  // Premultiplied: the band over a soft glow in the colonies' colours. Kept dim and close
  // to the colony shade: a contested centre drawn pale blue-white outshone the
  // ants fighting on it; the front still reads as a coloured line, below the ants' chitin.
  vec3 col = hot * 0.25 * a + mix(hot, side, 0.5) * 0.22 * g * (1.0 - a);
  finalColor = vec4(col, min(1.0, a * 0.8 + g * 0.5));
  finalColor *= awBoundaryWeight(vUV);
}`;

export class Territory {
  readonly fill: Mesh<Geometry, Shader>;
  readonly front: Mesh<Geometry, Shader>;
  /** Container for the front band alone, so bloom can be applied to this layer only. */
  readonly frontLayer = new Container();
  private texA: Texture<BufferImageSource>;
  private texB: Texture<BufferImageSource>;
  private dataA: Uint8Array;
  private dataB: Uint8Array;
  private trailTex: Texture<BufferImageSource>;
  private trailData: Uint8Array;
  readonly water: WaterMask;
  private waterTex: Texture<BufferImageSource>;
  private keyA: object | null = null;
  private keyB: object | null = null;
  private keyTrail: object | null = null;
  private uniforms: { uniforms: Record<string, unknown> };
  private frontGeometry: Geometry;
  private ground: Geometry;
  private screen: { w: number; h: number };
  private fillShader: Shader;
  private soil: RenderTexture;

  readonly mapW: number;
  readonly mapH: number;

  /**
   * screen: the CSS size the ground covers; origin and tilePx place the map on it.
   * The fill mesh lives in the world container's tile coordinates.
   */
  constructor(mapW: number, mapH: number, soil: RenderTexture, screen: { w: number; h: number; ox: number; oy: number; tilePx: number }) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.dataA = new Uint8Array(mapW * mapH * 4);
    this.dataB = new Uint8Array(mapW * mapH * 4);
    this.texA = makeTexture(this.dataA, mapW, mapH);
    this.texB = makeTexture(this.dataB, mapW, mapH);
    this.trailData = new Uint8Array(mapW * TRAIL_RES * mapH * TRAIL_RES * 4);
    this.trailTex = makeTexture(this.trailData, mapW * TRAIL_RES, mapH * TRAIL_RES);
    this.water = new WaterMask(mapW, mapH);
    this.waterTex = makeTexture(this.water.data, mapW, mapH);
    const uniformDefs = {
      uBlend: { value: 0, type: "f32" },
      uMap: { value: [mapW, mapH], type: "vec2<f32>" },
      uTrails: { value: 1, type: "f32" },
      uTime: { value: 0, type: "f32" },
      uC0: { value: [...COLONY_RGB[0]], type: "vec3<f32>" },
      uC1: { value: [...COLONY_RGB[1]], type: "vec3<f32>" },
    };
    // The board look (board-look.ts) gives both passes its own code; none keeps the plain code.
    const look = boardLook()?.board2d;
    const fillShader = Shader.from({
      gl: { vertex: GROUND_VERTEX, fragment: look ? look.fill(COMMON) : FILL_FRAGMENT },
      resources: { terr: uniformDefs, uA: this.texA.source, uB: this.texB.source, uSoil: soil.source, uTrail: this.trailTex.source, uWater: this.waterTex.source },
    });
    this.fillShader = fillShader;
    this.soil = soil;
    // Both meshes read the same uniform group, so one write updates both.
    const group = fillShader.resources.terr;
    const frontShader = Shader.from({
      gl: { vertex: QUAD_VERTEX, fragment: look ? look.front(COMMON) : FRONT_FRAGMENT },
      resources: { terr: group, uA: this.texA.source, uB: this.texB.source, uWater: this.waterTex.source },
    });
    this.uniforms = group;
    // Ground quad: the whole screen, in tile units, with map uv and screen uv; setView keeps it on screen as the camera moves.
    this.screen = { w: screen.w, h: screen.h };
    const ground = new Geometry({
      attributes: { aPosition: new Float32Array(8), aUV: new Float32Array(8), aScreen: new Float32Array(8) },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this.ground = ground;
    this.setView(screen);
    this.fill = new Mesh({ geometry: ground, shader: fillShader });
    this.fill.blendMode = "none";
    this.frontGeometry = quadGeometry(mapW, mapH);
    this.front = new Mesh({ geometry: this.frontGeometry, shader: frontShader });
    this.frontLayer.addChild(this.front);
  }

  /**
   * The board look changed (board-look.ts): both passes take its code, or the plain code
   * with none, over the same textures and uniforms. The caller then bakes the matching soil and passes it to resize.
   */
  relook() {
    const look = boardLook()?.board2d;
    const fill = Shader.from({
      gl: { vertex: GROUND_VERTEX, fragment: look ? look.fill(COMMON) : FILL_FRAGMENT },
      resources: { terr: this.uniforms, uA: this.texA.source, uB: this.texB.source, uSoil: this.soil.source, uTrail: this.trailTex.source, uWater: this.waterTex.source },
    });
    const front = Shader.from({
      gl: { vertex: QUAD_VERTEX, fragment: look ? look.front(COMMON) : FRONT_FRAGMENT },
      resources: { terr: this.uniforms, uA: this.texA.source, uB: this.texB.source, uWater: this.waterTex.source },
    });
    const old = [this.fill.shader, this.front.shader];
    this.fill.shader = fill;
    this.front.shader = front;
    this.fillShader = fill;
    // Programs stay cached for a switch back; textures and uniforms are shared, so only the shader objects go.
    for (const shader of old) shader?.destroy(false);
  }

  /**
   * Cover the part of the screen the board occupies for a view: tile (0, 0) at
   * (ox, oy), tilePx CSS px per tile. Outside the board the page background
   * shows (the soil's vignette is near-black there anyway), which keeps this
   * full-screen pass, the costliest on SwiftShader, to the board's pixels.
   */
  setView(view: { ox: number; oy: number; tilePx: number }) {
    const { w, h } = this.screen;
    const { ox, oy, tilePx } = view;
    const W = this.mapW;
    const H = this.mapH;
    const x0 = Math.max(0, -ox / tilePx);
    const y0 = Math.max(0, -oy / tilePx);
    const x1 = Math.min(W, (w - ox) / tilePx);
    const y1 = Math.min(H, (h - oy) / tilePx);
    const sx = (x: number) => (ox + x * tilePx) / w;
    const sy = (y: number) => (oy + y * tilePx) / h;
    const pos = this.ground.getBuffer("aPosition");
    const uv = this.ground.getBuffer("aUV");
    const screen = this.ground.getBuffer("aScreen");
    (pos.data as Float32Array).set([x0, y0, x1, y0, x1, y1, x0, y1]);
    (uv.data as Float32Array).set([x0 / W, y0 / H, x1 / W, y0 / H, x1 / W, y1 / H, x0 / W, y1 / H]);
    (screen.data as Float32Array).set([sx(x0), sy(y0), sx(x1), sy(y0), sx(x1), sy(y1), sx(x0), sy(y1)]);
    pos.update();
    uv.update();
    screen.update();
  }

  /** The screen changed size: draw over a soil baked for the new size (the old one is destroyed), then place the view. */
  resize(soil: RenderTexture, screen: { w: number; h: number; ox: number; oy: number; tilePx: number }) {
    this.fillShader.resources.uSoil = soil.source;
    this.soil.destroy(true);
    this.soil = soil;
    this.screen = { w: screen.w, h: screen.h };
    this.setView(screen);
  }

  set trails(on: boolean) {
    this.uniforms.uniforms.uTrails = on ? 1 : 0;
  }

  get trailsOn(): boolean {
    return this.uniforms.uniforms.uTrails === 1;
  }

  update(frame: Frame, timeMs: number) {
    const u = this.uniforms.uniforms;
    u.uBlend = frame.blend;
    u.uTime = timeMs / 1000;
    if (this.water.update(frame.board?.setup.terrain)) this.waterTex.source.update();
    if (this.keyA !== frame.territoryA || this.keyB !== frame.territoryB) {
      this.dataA.set(encodeTerritory(frame.territoryA, this.mapW, this.mapH));
      this.dataB.set(encodeTerritory(frame.territoryB, this.mapW, this.mapH));
      this.texA.source.update();
      this.texB.source.update();
      this.keyA = frame.territoryA;
      this.keyB = frame.territoryB;
      this.fitFront(frame.territoryA, frame.territoryB);
    }
    if (this.keyTrail !== frame.trails) {
      const t = frame.trails;
      const d = this.trailData;
      for (let i = 0, n = t.length / 2; i < n; i++) {
        d[i * 4] = t[i * 2]! * 255;
        d[i * 4 + 1] = t[i * 2 + 1]! * 255;
      }
      this.trailTex.source.update();
      this.keyTrail = t;
    }
  }

  /** Limit the front mesh to the tiles where the colonies meet, in both snapshots, plus a margin. */
  private fitFront(a: Uint8Array, b: Uint8Array) {
    const box = frontBounds([a, b], this.mapW, this.mapH, 3);
    this.front.visible = box !== null;
    if (!box) return;
    const { x0, y0, x1, y1 } = box;
    const W = this.mapW;
    const H = this.mapH;
    const pos = this.frontGeometry.getBuffer("aPosition");
    const uv = this.frontGeometry.getBuffer("aUV");
    (pos.data as Float32Array).set([x0, y0, x1, y0, x1, y1, x0, y1]);
    (uv.data as Float32Array).set([x0 / W, y0 / H, x1 / W, y0 / H, x1 / W, y1 / H, x0 / W, y1 / H]);
    pos.update();
    uv.update();
  }
}

/**
 * The tile rectangle [x0, x1) x [y0, y1) covering every boundary between the two
 * colonies in any of the grids, counting both left/right and top/bottom
 * neighbours, grown by margin tiles and clamped to the map; null when the
 * colonies meet nowhere. Neutral tiles (0) border no one.
 */
export function frontBounds(grids: Uint8Array[], W: number, H: number, margin: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  const hit = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const g of grids) {
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const o = g[r * W + c]!;
        if (o === 0) continue;
        if (c > 0) {
          const l = g[r * W + c - 1]!;
          if (l !== 0 && l !== o) (hit(c - 1, r), hit(c, r));
        }
        if (r > 0) {
          const u = g[(r - 1) * W + c]!;
          if (u !== 0 && u !== o) (hit(c, r - 1), hit(c, r));
        }
      }
    }
  }
  if (x1 < 0) return null;
  return { x0: Math.max(0, x0 - margin), y0: Math.max(0, y0 - margin), x1: Math.min(W, x1 + 1 + margin), y1: Math.min(H, y1 + 1 + margin) };
}

function makeTexture(data: Uint8Array, w: number, h: number): Texture<BufferImageSource> {
  const source = new BufferImageSource({
    resource: data,
    width: w,
    height: h,
    scaleMode: "linear",
    alphaMode: "no-premultiply-alpha",
  });
  return new Texture({ source });
}

const encoded = new WeakMap<Uint8Array, Uint8Array>();

/**
 * RGBA per tile: R ownership (255 colony 0, 0 colony 1, 128 neutral), G closeness
 * to the front (distance to the nearest tile bordering the other colony, by a
 * breadth-first search). Cached per snapshot grid, so each is encoded once.
 */
export function encodeTerritory(owners: Uint8Array, W: number, H: number): Uint8Array {
  const hit = encoded.get(owners);
  if (hit) return hit;
  const n = W * H;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const o = owners[i]!;
    if (o === 0) continue;
    const x = i % W;
    const other = 3 - o;
    if ((x > 0 && owners[i - 1] === other) || (x < W - 1 && owners[i + 1] === other) || (i >= W && owners[i - W] === other) || (i + W < n && owners[i + W] === other)) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const d = dist[i]! + 1;
    if (d > FRONT_REACH) continue;
    const x = i % W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j < 0 || j >= n || dist[j] !== -1) continue;
      dist[j] = d;
      queue[tail++] = j;
    }
  }
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = owners[i]!;
    out[i * 4] = o === 1 ? 255 : o === 2 ? 0 : 128;
    out[i * 4 + 1] = dist[i]! < 0 ? 0 : Math.round(255 * Math.max(0, 1 - dist[i]! / FRONT_REACH));
    out[i * 4 + 3] = 255;
  }
  encoded.set(owners, out);
  return out;
}
