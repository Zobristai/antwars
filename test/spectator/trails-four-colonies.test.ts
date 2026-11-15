/**
 * Ant-traffic trails in a four-colony match: every trail cell holds one channel per colony (setup.queens.length), so
 * each colony's trail stays in its own cell and its own channel through tick preparation, a colony's point of view
 * and both boards' texture uploads (colony c in channel c), and both boards' four-colony passes draw all four channels.
 * A two-colony match's trails, the bytes both boards upload for them and the code that draws them are as they were
 * (the two-colony shader text is pinned in territory-four.test.ts, ground3d-four-colonies.test.ts and
 * colony-palette.test.ts). The quadrant map here is a test-only fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { DOMAdapter, RenderTexture } from "pixi.js";
import { decodeMessage, encodeMessage, SUB_TILE, type StreamAnts, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { advance } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { Frame, TickPreparation, TRAIL_DECAY_PER_TICK, TRAIL_DEPOSIT, TRAIL_RES, trailTexels, type Board } from "../../web/src/buffer.ts";
import { Ground } from "../../web/src/board3d/ground.ts";
import { setBoardLook } from "../../web/src/board-look.ts";
import { colonyRgb } from "../../web/src/colony-palette.ts";
import { STEPPE_LOOK } from "../../web/src/ui/steppe-look.ts";
import { Territory } from "../../web/src/territory.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

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
const CONFIG: SimConfig = { ...LIVE, terrain: { ...LIVE.terrain!, maps: [QUADRANTS] } };
const JOINS: SimInput[] = [0, 1, 2, 3].map(c => ({ type: "join", agentId: `a${c}`, modelLabel: `model ${c}` }));
/** Sub-tile units per trail cell. */
const CELL = SUB_TILE / TRAIL_RES;
/** One ant's deposit as a trail grid holds it. */
const DEPOSIT = Math.fround(TRAIL_DEPOSIT);

/** The first index where two arrays differ in length or value, or -1 when they are the same (fast on large grids). */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** A four-colony match as a spectator receives it: its opening full message, then `ticks` deltas, through the wire format. */
function fourColonyMessages(ticks: number): StreamMessage[] {
  const state = createMatch(404, CONFIG);
  const recorder = new SpectatorRecorder(state);
  const out: StreamMessage[] = [{ ...recorder.initial(), full: recorder.initialFull() }];
  for (let t = 0; t < ticks; t++) out.push({ ...recorder.record(advance(state, t === 0 ? JOINS : [], undefined, undefined, undefined, false, true)), full: null });
  return out.map(m => decodeMessage(encodeMessage(m)));
}

/** Ants at the given sub-tile positions, one per colony entry. */
function antsAt(spots: readonly { colony: number; x: number; y: number }[]): StreamAnts {
  const n = spots.length;
  const ants: StreamAnts = { count: n, id: new Uint32Array(n), x: new Uint16Array(n), y: new Uint16Array(n), heading: new Uint8Array(n),
    colony: new Uint8Array(n), agent: new Int16Array(n), carrying: new Uint8Array(n) };
  spots.forEach((s, i) => { ants.id[i] = i + 1; ants.x[i] = s.x; ants.y[i] = s.y; ants.colony[i] = s.colony; ants.agent[i] = -1; });
  return ants;
}

/** The trails an independent calculation gives: decay by elapsed ticks, then each ant's deposit at cell * colonies + colony. */
function expectedTrails(messages: readonly StreamMessage[], colonies: number): Float32Array[] {
  const { mapW, mapH } = messages[0]!.full!.setup;
  const tw = mapW * TRAIL_RES;
  let previous: Float32Array | null = null, previousTick = 0;
  return messages.map(m => {
    const grid = new Float32Array(tw * mapH * TRAIL_RES * colonies);
    if (previous) for (let i = 0; i < grid.length; i++) grid[i] = previous[i]! * TRAIL_DECAY_PER_TICK ** (m.tick - previousTick);
    for (let i = 0; i < m.ants.count; i++) {
      const at = (Math.floor(m.ants.y[i]! / CELL) * tw + Math.floor(m.ants.x[i]! / CELL)) * colonies + m.ants.colony[i]!;
      grid[at] = Math.min(1, grid[at]! + TRAIL_DEPOSIT);
    }
    previous = grid;
    previousTick = m.tick;
    return grid;
  });
}

/** The boards' upload loop before trails had a channel per colony: colonies 0 and 1 into red and green. */
function twoColonyTexels(trails: Float32Array, out: Uint8Array): void {
  for (let i = 0, n = trails.length / 2; i < n; i++) {
    out[i * 4] = trails[i * 2]! * 255;
    out[i * 4 + 1] = trails[i * 2 + 1]! * 255;
  }
}

describe("trails in a four-colony match", () => {
  it("keep colonies 0 to 3, side by side in adjacent cells, each in its own cell's own channel", () => {
    const [opening] = fourColonyMessages(0);
    const { mapW, mapH } = opening!.full!.setup;
    expect(opening!.full!.setup.queens).toHaveLength(4);
    // One ant of each colony in trail cells 0 to 3 of the top row, and colonies 3 and 2 again in cells 4 and 5 of row 1.
    const spots = [0, 1, 2, 3].map(c => ({ colony: c, x: c * CELL + 1, y: 1 }))
      .concat([{ colony: 3, x: 4 * CELL + 2, y: CELL + 2 }, { colony: 2, x: 5 * CELL + 2, y: CELL + 2 }]);
    const prepared = new TickPreparation().prepare({ ...opening!, ants: antsAt(spots), events: [] })!;
    const tw = mapW * TRAIL_RES;
    expect(prepared.trails.length).toBe(tw * mapH * TRAIL_RES * 4);
    const laid = new Map<number, number>();
    prepared.trails.forEach((v, i) => { if (v !== 0) laid.set(i, v); });
    // Exactly one deposit per ant, at its own cell's channel for its colony, and nothing in any other cell or channel.
    expect(laid).toEqual(new Map([
      [0, DEPOSIT], [1 * 4 + 1, DEPOSIT], [2 * 4 + 2, DEPOSIT], [3 * 4 + 3, DEPOSIT],
      [(tw + 4) * 4 + 3, DEPOSIT], [(tw + 5) * 4 + 2, DEPOSIT],
    ]));
    // Colonies 2 and 3 leave the next cells' colony 0 and 1 channels empty.
    expect([prepared.trails[3 * 4], prepared.trails[3 * 4 + 1], prepared.trails[4 * 4], prepared.trails[4 * 4 + 1]]).toEqual([0, 0, 0, 0]);
  });

  it("follow a played four-colony match tick by tick, with decay, as an independent per-colony calculation does", () => {
    const messages = fourColonyMessages(40);
    const prep = new TickPreparation();
    const expected = expectedTrails(messages, 4);
    const colonies = new Set<number>();
    messages.forEach((m, t) => {
      for (const c of m.ants.colony) colonies.add(c);
      expect(firstDifference(prep.prepare(structuredClone(m))!.trails, expected[t]!)).toBe(-1);
    });
    expect([...colonies].sort()).toEqual([0, 1, 2, 3]);
    // Every colony has laid its own trail by the end.
    const last = expected.at(-1)!;
    for (let c = 0; c < 4; c++) expect(last.some((v, i) => i % 4 === c && v > 0)).toBe(true);
  });

  it("give each colony's point of view only that colony's own channel", () => {
    const [opening] = fourColonyMessages(0);
    const spots = [0, 1, 2, 3].map(c => ({ colony: c, x: c * CELL + 1, y: 1 }));
    const prepared = new TickPreparation().prepare({ ...opening!, ants: antsAt(spots), events: [] })!;
    const frame = new Frame();
    frame.board = prepared.kind === "full" ? prepared.board : null;
    frame.ants = antsAt(spots);
    frame.mapW = opening!.full!.setup.mapW;
    frame.mapH = opening!.full!.setup.mapH;
    frame.territoryA = frame.territoryB = frame.board!.territory;
    frame.trails = prepared.trails;
    for (let c = 0; c < 4; c++) {
      const view = new TeamView();
      view.choice = c;
      const shown = view.apply(frame).trails;
      const laid: number[] = [];
      shown.forEach((v, i) => { if (v !== 0) laid.push(i); });
      expect(laid).toEqual([c * 4 + c]);
    }
  });
});

describe("trail texels", () => {
  it("put colony c in channel c for four colonies", () => {
    const trails = Float32Array.from({ length: 3 * 4 }, (_, i) => (i + 1) / 12);
    const out = new Uint8Array(3 * 4);
    trailTexels(trails, 4, out);
    expect([...out]).toEqual([...trails].map(v => Math.trunc(v * 255)));
  });

  it("are a two-colony match's bytes exactly as before, red and green only", () => {
    const packets = scale2Packets(40).map(decodeMessage);
    const prep = new TickPreparation();
    let trails: Float32Array = new Float32Array(0);
    for (const m of packets) trails = prep.prepare(structuredClone(m))!.trails;
    expect(packets[0]!.full!.setup.queens).toHaveLength(2);
    expect(trails.some(v => v > 0)).toBe(true);
    const before = new Uint8Array(trails.length * 2), now = new Uint8Array(trails.length * 2);
    twoColonyTexels(trails, before);
    trailTexels(trails, 2, now);
    expect(firstDifference(now, before)).toBe(-1);
    // And the two-colony grid itself keeps its layout: colony 0 then colony 1 in each cell.
    expect(firstDifference(trails, expectedTrails(packets, 2).at(-1)!)).toBe(-1);
  });

  it("clear a four-colony match's blue and alpha when a two-colony match follows on the same board", () => {
    const out = new Uint8Array(4 * 2);
    trailTexels(Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]), 4, out);
    trailTexels(Float32Array.from([1, 0.5, 0.25, 1]), 2, out);
    expect([...out]).toEqual([255, 127, 0, 0, 63, 255, 0, 0]);
  });
});

describe("both boards upload and draw a four-colony match's trails one colony per channel", () => {
  let engine: NullEngine;
  let scene: Scene;
  const browserAdapter = DOMAdapter.get();
  beforeEach(() => {
    // Only Pixi's external precision probe is substituted: no browser/GPU is claimed here.
    DOMAdapter.set({ ...browserAdapter, createCanvas: () => ({ getContext: () => null }) as unknown as ReturnType<typeof browserAdapter.createCanvas> });
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => { vi.restoreAllMocks(); setBoardLook(null); DOMAdapter.set(browserAdapter); scene.dispose(); engine.dispose(); });

  /** A W x H frame whose board has `colonies` queens, every trail cell's every channel a different value. */
  function frame(W: number, H: number, colonies: number): Frame {
    const f = new Frame();
    f.board = { setup: { mapW: W, mapH: H, queens: Array.from({ length: colonies }, () => [0, 0]) } } as unknown as Board;
    f.mapW = W;
    f.mapH = H;
    f.territoryA = new Uint8Array(W * H);
    f.territoryB = new Uint8Array(W * H);
    const cells = W * TRAIL_RES * H * TRAIL_RES;
    f.trails = Float32Array.from({ length: cells * colonies }, (_, k) => ((Math.floor(k / colonies) * 4 + k % colonies) % 250 + 1) / 256);
    return f;
  }

  it("on the 3D ground and the 2D board, colonies 0 to 3 in red, green, blue and alpha", () => {
    const W = 8, H = 4, f = frame(W, H, 4);
    const ground = new Ground(scene, W, H);
    const upload3d = vi.spyOn(ground.plugin.textures.trail as RawTexture, "update");
    ground.update(f, 0);
    const territory = new Territory(W, H, RenderTexture.create({ width: 10, height: 10 }), { w: 100, h: 100, ox: 0, oy: 0, tilePx: 1 });
    const source2d = territory.fill.shader!.resources.uTrail;
    const upload2d = vi.spyOn(source2d, "update");
    territory.update(f, 0);
    expect(upload3d).toHaveBeenCalledTimes(1);
    expect(upload2d).toHaveBeenCalledTimes(1);
    const bytes3d = upload3d.mock.calls[0]![0] as Uint8Array, bytes2d = source2d.resource as Uint8Array;
    const cells = W * TRAIL_RES * H * TRAIL_RES;
    for (const bytes of [bytes3d, bytes2d]) {
      expect(bytes.length).toBe(cells * 4);
      for (const cell of [0, 1, 2, 3, cells - 1]) {
        expect([...bytes.subarray(cell * 4, cell * 4 + 4)]).toEqual([0, 1, 2, 3].map(c => Math.trunc(f.trails[cell * 4 + c]! * 255)));
        // Four different values, so no channel holds another colony's.
        expect(new Set(bytes.subarray(cell * 4, cell * 4 + 4)).size).toBe(4);
      }
    }
  });

  it("and a two-colony match's trails in red and green only, as before", () => {
    const W = 8, H = 4, f = frame(W, H, 2);
    const ground = new Ground(scene, W, H);
    const upload3d = vi.spyOn(ground.plugin.textures.trail as RawTexture, "update");
    ground.update(f, 0);
    const territory = new Territory(W, H, RenderTexture.create({ width: 10, height: 10 }), { w: 100, h: 100, ox: 0, oy: 0, tilePx: 1 });
    territory.update(f, 0);
    const before = new Uint8Array(W * TRAIL_RES * H * TRAIL_RES * 4);
    twoColonyTexels(f.trails, before);
    expect(firstDifference(upload3d.mock.calls[0]![0] as Uint8Array, before)).toBe(-1);
    expect(firstDifference(territory.fill.shader!.resources.uTrail.resource as Uint8Array, before)).toBe(-1);
  });

  const board2d = () => new Territory(8, 4, RenderTexture.create({ width: 10, height: 10 }), { w: 100, h: 100, ox: 0, oy: 0, tilePx: 1 });
  type Shaded = { shader: { glProgram: { fragment: string }; resources: Record<string, unknown> } };
  const fill2d = (t: Territory) => (t.fill as unknown as Shaded).shader;
  const diffuse3d = (g: Ground) => g.plugin.getCustomCode("fragment")!.CUSTOM_FRAGMENT_UPDATE_DIFFUSE!;
  const TWO_2D_PLAIN = ["  vec2 tr = texture(uTrail, vUV).rg * uTrails;", "  col += (uC0 * 0.85 * tr.x + uC1 * tr.y) * 0.2;"];
  const TWO_2D_STEPPE = ["  vec2 tr = texture(uTrail, vUV).rg * uTrails;", "  col *= 1.0 - 0.18 * clamp(tr.x + tr.y, 0.0, 1.0);"];
  const TWO_3D_INK = "max(awTrail.r, awTrail.g)) * awStroke * uTrails;";
  const FOUR_3D_INK = "max(max(awTrail.r, awTrail.g), max(awTrail.b, awTrail.a))) * awStroke * uTrails;";

  it("on the plain 2D board: each colony's trail lightens the ground in its own colour, colonies 2 and 3 from blue and alpha", () => {
    const four = board2d();
    four.update(frame(8, 4, 4), 0);
    const shader = fill2d(four);
    expect(shader.glProgram.fragment).toContain("  vec4 tr = texture(uTrail, vUV) * uTrails;\n  col += (uC0 * 0.85 * tr.r + uC1 * tr.g + uC2 * tr.b + uC3 * tr.a) * 0.2;\n");
    const terr = shader.resources.terr as { uniforms: Record<string, number[]> };
    expect(terr.uniforms.uC2).toEqual([...colonyRgb(2)]);
    expect(terr.uniforms.uC3).toEqual([...colonyRgb(3)]);
    const two = board2d();
    two.update(frame(8, 4, 2), 0);
    for (const line of TWO_2D_PLAIN) expect(fill2d(two).glProgram.fragment).toContain(line);
    expect(fill2d(two).glProgram.fragment).not.toContain("tr.b");
  });

  it("on the steppe 2D board: every colony's traffic darkens the ground, all four channels", () => {
    setBoardLook(STEPPE_LOOK);
    const four = board2d();
    four.update(frame(8, 4, 4), 0);
    expect(fill2d(four).glProgram.fragment).toContain("  vec4 tr = texture(uTrail, vUV) * uTrails;\n  col *= 1.0 - 0.18 * clamp(tr.r + tr.g + tr.b + tr.a, 0.0, 1.0);\n");
    const two = board2d();
    two.update(frame(8, 4, 2), 0);
    for (const line of TWO_2D_STEPPE) expect(fill2d(two).glProgram.fragment).toContain(line);
    expect(fill2d(two).glProgram.fragment).not.toContain("tr.b");
  });

  it("on the 3D ground, plain and steppe: the trail ink takes the strongest of all four colonies' channels", () => {
    for (const look of [null, STEPPE_LOOK]) {
      setBoardLook(look);
      const ground = new Ground(scene, 8, 4);
      ground.update(frame(8, 4, 4), 0);
      const four = diffuse3d(ground);
      expect(four).toMatch(/  vec4 awTrail = texture2D\(uTrail, [^;]*\);\n/);
      expect(four).not.toContain(").rg;");
      expect(four).toContain(FOUR_3D_INK);
      ground.update(frame(8, 4, 2), 1);
      const two = diffuse3d(ground);
      expect(two).toMatch(/  vec2 awTrail = texture2D\(uTrail, [^;]*\)\.rg;\n/);
      expect(two).toContain(TWO_3D_INK);
      expect(two).not.toContain("awTrail.b");
      ground.mesh.dispose();
    }
  });
});
