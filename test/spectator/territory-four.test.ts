/**
 * The 2D territory layer (web/src/territory.ts) for four colonies, and unchanged for two. A two-colony match keeps its
 * ownership bytes and both passes' shader text exactly; a four-colony match (four queens in its setup) also uploads
 * each colony's holdings and draws with the four-colony passes, each colony in its own colour and wash, its front where
 * any two colonies meet, and an eliminated colony's former tiles neutral. Pixi's program objects compile no GLSL here:
 * the browser check is the pixel proof. A recorded four-colony match reaches the layer through the stream as the page
 * plays it: recorder, wire encoding and decoding, playback.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RenderTexture } from "pixi.js";
import { decodeMessage, encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { rulesConfig, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { advance } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { addAnt } from "../sim/fixtures.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { setBoardLook } from "../../web/src/board-look.ts";
import { colonyRgb, colonyWash } from "../../web/src/colony-palette.ts";
import { encodeHoldings, encodeTerritory, frontBounds, type Territory } from "../../web/src/territory.ts";
import { STEPPE_LOOK } from "../../web/src/ui/steppe-look.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** encodeTerritory as the baseline client wrote it, for two colonies (0 neutral, 1 colony 0, 2 colony 1). */
function baselineEncode(owners: Uint8Array, W: number, H: number): Uint8Array {
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
    if (d > 10) continue;
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
    out[i * 4 + 1] = dist[i]! < 0 ? 0 : Math.round(255 * Math.max(0, 1 - dist[i]! / 10));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A W x H owner grid from owner(x, y). */
const grid = (W: number, H: number, owner: (x: number, y: number) => number) => {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = owner(x, y);
  return g;
};

/** Deterministic noise in [0, 1). */
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe("two-colony territory bytes", () => {
  it("encode exactly as the baseline client encoded them, front closeness included", () => {
    const next = lcg(7);
    const grids: [Uint8Array, number, number][] = [];
    for (const [W, H] of [[1, 1], [2, 1], [1, 3], [7, 5], [40, 30], [64, 48]] as const) {
      // Noise, patches and a front with neutral ground at its ends.
      grids.push([grid(W, H, () => Math.floor(next() * 3)), W, H]);
      grids.push([grid(W, H, (x, y) => (Math.sin(x * 0.7) + Math.cos(y * 0.5) > 0.6 ? 0 : x + y < (W + H) / 2 ? 1 : 2)), W, H]);
      grids.push([grid(W, H, (x, y) => (y < 2 || y >= H - 2 ? 0 : x < W / 2 ? 1 : 2)), W, H]);
    }
    for (const [g, W, H] of grids) expect(encodeTerritory(g, W, H)).toEqual(baselineEncode(g, W, H));
  });
});

describe("four-colony territory bytes", () => {
  const W = 12;
  const H = 10;
  // Four quadrants meeting at the centre, with a neutral column between colonies 1 and 2 (owners 2 and 3) at the top.
  const quads = grid(W, H, (x, y) => (y < 5 ? (x < 6 ? 1 : x === 6 ? 0 : 2) : x < 6 ? 3 : 4));

  it("put colonies 2 and 3 on neutral's R and measure the front from every two colonies' meeting", () => {
    const e = encodeTerritory(quads, W, H);
    const at = (x: number, y: number, channel: number) => e[(y * W + x) * 4 + channel];
    // R: 255 colony 0, 0 colony 1, 128 otherwise; A always 255, B 0.
    expect([at(0, 0, 0), at(11, 0, 0), at(0, 9, 0), at(11, 9, 0), at(6, 0, 0)]).toEqual([255, 0, 128, 128, 128]);
    for (let i = 0; i < W * H; i++) expect([e[i * 4 + 2], e[i * 4 + 3]]).toEqual([0, 255]);
    // Tiles on a boundary between any two colonies are on the front: 0|2 (owners 1|3), 2|3 (owners 3|4), 1|3 (owners 2|4).
    for (const [x, y] of [[2, 4], [2, 5], [5, 7], [6, 7], [9, 4], [9, 5]] as const) expect(at(x, y, 1)).toBe(255);
    // Colonies 0 and 1 are kept apart by neutral ground at the top, which borders no one: one tile away is not the front.
    expect(at(5, 0, 1)).toBeLessThan(255);
    expect(at(7, 0, 1)).toBeLessThan(255);
  });

  it("hold each colony in its own channel, and a neutral tile in none", () => {
    const h = encodeHoldings(quads, W, H);
    const at = (x: number, y: number) => Array.from(h.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect([at(0, 0), at(11, 0), at(0, 9), at(11, 9), at(6, 0)]).toEqual([[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [0, 0, 0, 255], [0, 0, 0, 0]]);
    expect(encodeHoldings(quads, W, H)).toBe(h);
  });

  it("show an eliminated colony's former tiles as neutral: no holding, and no front where it met another colony", () => {
    // Colony 2 (owner 3) eliminated: its tiles arrive as 0.
    const after = quads.map(o => (o === 3 ? 0 : o));
    const h = encodeHoldings(after, W, H);
    const e = encodeTerritory(after, W, H);
    for (let y = 5; y < H; y++) for (let x = 0; x < 6; x++) expect(Array.from(h.slice((y * W + x) * 4, (y * W + x) * 4 + 4))).toEqual([0, 0, 0, 0]);
    // Where colony 2 met colonies 0 and 3 there is no meeting left; colonies 1 and 3 (owners 2 and 4) still meet.
    expect(e[(4 * W + 2) * 4 + 1]).toBeLessThan(255);
    expect(e[(7 * W + 6) * 4 + 1]).toBeLessThan(255);
    expect(e[(4 * W + 9) * 4 + 1]).toBe(255);
  });

  it("bound the front line where colonies 2 and 3 alone meet, and nowhere when only one colony holds ground", () => {
    const pair = grid(W, H, (x) => (x < 6 ? 3 : 4));
    expect(frontBounds([pair], W, H, 0)).toEqual({ x0: 5, y0: 0, x1: 7, y1: H });
    expect(frontBounds([grid(W, H, (x) => (x < 6 ? 4 : 0))], W, H, 2)).toBeNull();
  });
});

describe("the 2D territory passes", () => {
  type Shaded = { shader: { glProgram: { fragment: string }; resources: Record<string, unknown> } };
  let RT: typeof RenderTexture;
  let TerritoryClass: typeof Territory;
  const saved = (globalThis as { document?: unknown }).document;
  beforeAll(async () => {
    // Pixi reaches for a canvas when it makes a texture; no drawing happens here.
    (globalThis as { document?: unknown }).document ??= { createElement: () => ({ getContext: () => null, style: {}, addEventListener() {} }), baseURI: "http://localhost/" };
    ({ RenderTexture: RT } = await import("pixi.js"));
    ({ Territory: TerritoryClass } = await import("../../web/src/territory.ts"));
  });
  afterAll(() => {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = saved;
  });
  afterEach(() => setBoardLook(null));

  const W = 16;
  const H = 12;
  const make = () => new TerritoryClass(W, H, RT.create({ width: 8, height: 6 }), { w: 80, h: 60, ox: 0, oy: 0, tilePx: 5 });
  const passes = (t: Territory) => [t.fill, t.front] as unknown as [Shaded, Shaded];
  const fragments = (t: Territory) => passes(t).map(m => m.shader.glProgram.fragment);
  /** A frame of a match with this many queens, its territory grids a and b. */
  const frame = (queens: number, a: Uint8Array, b = a) => {
    const f = new Frame();
    f.territoryA = a;
    f.territoryB = b;
    f.board = { setup: { mapW: W, mapH: H, queens: Array.from({ length: queens }, () => [0, 0]) } } as unknown as Frame["board"];
    return f;
  };
  const quads = grid(W, H, (x, y) => (y < 6 ? (x < 8 ? 1 : 2) : x < 8 ? 3 : 4));
  // The two-colony passes' fragments as the baseline client built them, measured before the four-colony change.
  const BASELINE = {
    plain: ["36d7bee6fa6cc5deb7c693819287af043103036e35deeb17f6ff8d174a579e54", "a955f227b94968a549f7b230b35b883b7e80aa26b6222c03351a487a87168f12"],
    steppe: ["5292b49e320caff32fc365aefea5554203b0d6966984bbaf28eddd80daa85d3d", "7420005ca4d9a773adb8b787caeb3bd5fae201451503a4a616d72459bae2f934"],
  };

  it("keep a two-colony match's shader text exactly, on the plain board and the steppe look, before and after its frames", () => {
    const plain = make();
    expect(fragments(plain).map(sha)).toEqual(BASELINE.plain);
    plain.update(frame(2, grid(W, H, (x) => (x < 8 ? 1 : 2))), 0);
    expect(fragments(plain).map(sha)).toEqual(BASELINE.plain);
    for (const m of passes(plain)) expect(m.shader.resources).not.toHaveProperty("uWA");
    setBoardLook(STEPPE_LOOK);
    const steppe = make();
    expect(fragments(steppe).map(sha)).toEqual(BASELINE.steppe);
    steppe.update(frame(2, grid(W, H, (x) => (x < 8 ? 1 : 2))), 0);
    expect(fragments(steppe).map(sha)).toEqual(BASELINE.steppe);
  });

  it("draw a four-colony match with the four-colony passes over each snapshot's holdings, and a two-colony match again after it", () => {
    const t = make();
    const two = fragments(t);
    const b = quads.map(o => (o === 3 ? 0 : o));
    t.update(frame(4, quads, b), 0);
    const [fill, front] = passes(t);
    for (const m of [fill, front]) {
      expect(m.shader.glProgram.fragment).toContain("float ownership4(vec2 uv, out vec4 s, out int ca, out int cb)");
      expect(m.shader.resources).toHaveProperty("uWA");
      expect(m.shader.resources).toHaveProperty("uWB");
    }
    const source = (name: string) => fill.shader.resources[name] as { resource: Uint8Array };
    expect(source("uWA").resource).toEqual(encodeHoldings(quads, W, H));
    expect(source("uWB").resource).toEqual(encodeHoldings(b, W, H));
    // A new snapshot re-uploads; an unchanged one does not.
    const uploads = vi.spyOn(fill.shader.resources.uWA as { update(): void }, "update");
    t.update(frame(4, quads, b), 16);
    expect(uploads).not.toHaveBeenCalled();
    t.update(frame(4, b, b), 32);
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(source("uWA").resource).toEqual(encodeHoldings(b, W, H));
    t.update(frame(2, grid(W, H, (x) => (x < 8 ? 1 : 2))), 48);
    expect(fragments(t)).toEqual(two);
  });

  it("draw the four-colony front only where two colonies hold ground, on the plain board and the steppe look", () => {
    // Over a colony's edge against unheld ground (an eliminated colony's former ground among it) only one colony holds
    // any ground, so ownership4 gives cb = -1 there and the front pass draws nothing.
    const t = make();
    t.update(frame(4, quads, quads.map(o => (o === 3 ? 0 : o))), 0);
    for (const look of [null, STEPPE_LOOK]) {
      setBoardLook(look);
      t.relook();
      const front = fragments(t)[1]!;
      expect(front).toContain("float r = ownership4(vUV, s, ca, cb);\n  if (s.g < 0.45 || cb < 0) discard;\n");
      expect(front).not.toContain("ca < 0) discard");
    }
  });

  it("give each colony its own colour on the plain board and its own wash on the steppe look", () => {
    const t = make();
    t.update(frame(4, quads), 0);
    const [fill] = passes(t);
    const terr = fill.shader.resources.terr as { uniforms: Record<string, number[]> };
    for (const c of [0, 1, 2, 3]) expect(terr.uniforms[`uC${c}`]).toEqual([...colonyRgb(c)]);
    expect(fill.shader.glProgram.fragment).toContain("vec3 colonyColour(int c) { return c == 0 ? uC0 : c == 1 ? uC1 : c == 2 ? uC2 : uC3; }");
    setBoardLook(STEPPE_LOOK);
    t.relook();
    const vec3 = (rgb: readonly number[]) => `vec3(${rgb.map(v => v.toFixed(4)).join(", ")})`;
    const wash = `vec3 d1Wash(int c) { return c == 0 ? ${vec3(colonyWash(0).hue)} : c == 1 ? ${vec3(colonyWash(1).hue)} : c == 2 ? ${vec3(colonyWash(2).hue)} : ${vec3(colonyWash(3).hue)}; }`;
    const depth = `float d1Depth(int c) { return c == 0 ? ${colonyWash(0).depth.toFixed(1)} : c == 1 ? ${colonyWash(1).depth.toFixed(1)} : c == 2 ? ${colonyWash(2).depth.toFixed(1)} : ${colonyWash(3).depth.toFixed(1)}; }`;
    for (const fragment of fragments(t)) {
      expect(fragment).toContain(wash);
      expect(fragment).toContain("ownership4(vUV, s, ca, cb)");
    }
    expect(fragments(t)[0]).toContain(depth);
  });

  /** Test-only quadrant geometry (as in test/live/four-colony-recorder.test.ts). */
  const QUADRANTS: MapDefinition = {
    id: "fixture-quadrants", name: "Fixture Quadrants",
    water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
    quadrant: {
      referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
      startArea: { x: 2, y: 4, width: 12, height: 15 },
      foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
      centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
    },
  };
  const LIVE = newMatchConfig(rulesConfig("redesign"));
  const CONFIG: SimConfig = { ...LIVE, combatGraceTicks: 0, queenHp: { ...LIVE.queenHp!, shieldTicks: 0 }, terrain: { ...LIVE.terrain!, maps: [QUADRANTS] } };
  const JOINS: SimInput[] = [0, 1, 2, 3].map(c => ({ type: "join", agentId: `a${c}`, modelLabel: `model ${c}` }));

  /** A four-colony match whose every message crosses the wire into the page's playback, as a recording plays. */
  function recorded(state: SimState) {
    const recorder = new SpectatorRecorder(state);
    const wire = (m: StreamMessage) => decodeMessage(encodePublicMessage(m));
    const playback = new Playback();
    playback.push(wire({ ...recorder.initial(), full: recorder.initialFull() }), state.tick * TICK_MS);
    const play = (inputs: readonly SimInput[] = []) => {
      const rec = recorder.record(advance(state, inputs, undefined, undefined, undefined, false, true));
      playback.push(wire({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events }), rec.tick * TICK_MS);
    };
    const shown = () => {
      const f = new Frame();
      expect(playback.sample(state.tick * TICK_MS + RENDER_DELAY_MS, f)).toBe(true);
      return f;
    };
    return { play, shown };
  }

  // Simulates and streams a whole match, which can outrun vitest's default 5 s on a busy machine.
  it("draw a recorded four-colony match with the four-colony passes, and its eliminated colony's ground as neutral", () => {
    const state = createMatch(404, CONFIG);
    const { play, shown } = recorded(state);
    for (let t = 0; t < 200; t++) play(t === 0 ? JOINS : []);
    const before = shown();
    const { mapW, mapH } = before.board!.setup;
    expect(before.board!.setup.queens).toHaveLength(4);
    expect(new Set(before.territoryA)).toEqual(new Set([0, 1, 2, 3, 4]));
    const t = new TerritoryClass(mapW, mapH, RT.create({ width: 8, height: 6 }), { w: 80, h: 60, ox: 0, oy: 0, tilePx: 5 });
    t.update(before, 0);
    const [fill, front] = passes(t);
    for (const m of [fill, front]) expect(m.shader.glProgram.fragment).toContain("ownership4(vUV, s, ca, cb)");
    const holdings = () => (fill.shader.resources.uWA as { resource: Uint8Array }).resource;
    expect(holdings()).toEqual(encodeHoldings(before.territoryA, mapW, mapH));
    const held = (h: Uint8Array, c: number) => h.some((v, i) => i % 4 === c && v === 255);
    for (const c of [0, 1, 2, 3]) expect(held(holdings(), c)).toBe(true);
    // Colony 1's only queen, one bite from death, with colony 0's ants on her tile (as the recorder test eliminates it).
    const queen = state.colonies[1]!.queens![0]!;
    const [qx, qy] = [Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB)];
    queen.hp = 1;
    state.ants = state.ants.filter(a => a.colony !== 1 || Math.abs(Math.floor(a.x / SUB) - qx) > 8 || Math.abs(Math.floor(a.y / SUB) - qy) > 8);
    for (let i = 0; i < 4; i++) addAnt(state, 0, qx, qy, { hp: 100_000 });
    for (let k = 0; k < 6; k++) play();
    expect(state.colonies[1]!.eliminated).toMatchObject({ reason: "queens_killed" });
    const after = shown();
    expect(after.territoryA.includes(2)).toBe(false);
    t.update(after, 16);
    expect(holdings()).toEqual(encodeHoldings(after.territoryA, mapW, mapH));
    expect(held(holdings(), 1)).toBe(false);
    for (const c of [0, 2, 3]) expect(held(holdings(), c)).toBe(true);
  }, 30_000);
});
