import { describe, expect, it } from "vitest";
import { Texture, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { decodeMessage, SUB_TILE, type StreamMessage } from "../../src/live/format.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { BODY_TURN_SPEED_DEGREES_PER_SECOND, Pivots, type TravelFrame } from "../../web/src/pivot.ts";
import { Ants } from "../../web/src/ants.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const full = decodeMessage(scale2Packets(1)[0]!).full!;
const radians = (degrees: number) => degrees * Math.PI / 180;
const delta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const cap = radians(BODY_TURN_SPEED_DEGREES_PER_SECOND) / 1000;

/** Constructed stream messages only; no matches or simulation are generated. */
function message(tick: number, options: { heading?: number; x?: number; fight?: number; far?: boolean; full?: boolean; id?: number } = {}): StreamMessage {
  const x = options.x ?? 2;
  return { tick, full: options.full ? structuredClone(full) : null,
    ants: { count: 3, id: Uint32Array.of(options.id ?? 1, 2, 3),
      x: Uint16Array.from([x, options.far ? 50 : x - 0.7, options.far ? 51 : x].map(v => Math.round(v * SUB_TILE))),
      y: Uint16Array.from([3, options.far ? 40 : 3, options.far ? 41 : 3.7].map(v => Math.round(v * SUB_TILE))),
      heading: Uint8Array.of(options.heading ?? 0, 0, 192), colony: Uint8Array.of(0, 1, 1),
      agent: new Int16Array(3).fill(-1), caste: new Uint8Array(3), carrying: new Uint8Array(3) },
    events: options.fight ? [{ kind: "fight", antId: options.id ?? 1, targetId: options.fight, colony: 0, tileX: Math.floor(x), tileY: 3 }] : [] };
}
function playback(rows: readonly StreamMessage[]): Playback {
  const pb = new Playback(); for (const m of rows) pb.push(m, m.tick * 100); return pb;
}
function sample(pb: Playback, at: number, f = new Frame()): Frame {
  expect(pb.sample(at + RENDER_DELAY_MS, f)).toBe(true); return f;
}
function pose(f: Frame, id = 1): number[] {
  const i = f.id.subarray(0, f.count).indexOf(id); expect(i).toBeGreaterThanOrEqual(0);
  return [f.x[i]!, f.y[i]!, f.rotation[i]!, f.drawX![i]!, f.drawY![i]!, f.drawRotation![i]!];
}

for (const fps of [30, 60]) describe(`${fps} fps shared body facing`, () => {
  it("caps actual particles and matrices through stationary, walking, bites, retargets and recovery", () => {
    const rows = Array.from({ length: 81 }, (_, tick) => message(tick, {
      full: tick === 0,
      heading: tick < 10 ? 0 : tick < 20 ? 128 : tick < 50 ? 0 : 128,
      x: tick < 20 ? 2 : tick < 30 ? 2 + (tick - 20) * 0.1 : tick < 60 ? 3 : 3 - (tick - 60) * 0.1,
      fight: tick === 30 ? 2 : tick === 40 ? 3 : undefined, far: tick >= 50,
    }));
    const original = structuredClone(rows), pb = new Playback(), f = new Frame();
    const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
    const ants = new Ants(renderer, 10, 10), engine = new NullEngine(), scene = new Scene(engine);
    const ants3d = new Ants3D(scene, new Ground(scene, full.setup.mapW, full.setup.mapH), 0.5, COLONY_RGB);
    const previous: ({ at: number; h: number } | undefined)[] = [];
    let next = 0, moving = 0, stationaryTurns = 0, biting = 0, retargeted = false, recovered = false;
    try {
      for (let k = 0; k <= 8 * fps; k++) {
        const at = k * 1000 / fps;
        while (next < rows.length && rows[next]!.tick * 100 <= at + RENDER_DELAY_MS + 1e-7) {
          const m = rows[next++]!; pb.push(m, m.tick * 100);
        }
        sample(pb, at, f); ants.update(f); ants3d.update(f);
        const i = f.id.subarray(0, f.count).indexOf(1), particle = ants.antLayer.particleChildren[i]!;
        const matrix = (scene.getMeshByName("ants0") as Mesh)._thinInstanceDataStorage.matrixData!;
        const headings = [particle.rotation, -Math.atan2(matrix[2]!, matrix[0]!)];
        for (let model = 0; model < headings.length; model++) {
          const h = headings[model]!, before = previous[model];
          expect(delta(h, f.drawRotation![i]!)).toBeCloseTo(0, 5);
          if (before && f.renderMs > before.at) {
            const change = Math.abs(delta(before.h, h));
            expect(change).toBeLessThanOrEqual(cap * (f.renderMs - before.at) + 1e-6);
            if (f.renderMs >= 1000 && f.renderMs < 1900 && change > 1e-6) stationaryTurns++;
          }
          previous[model] = { at: f.renderMs, h };
        }
        if (f.walk[i]) moving++;
        const pair = f.engagements.find(p => p.a === 1);
        if (pair) biting++;
        if (pair?.b === 3) retargeted = true;
        if (f.renderMs > 6000 && !pair) recovered = true;
      }
      expect(moving).toBeGreaterThan(0); expect(stationaryTurns).toBeGreaterThan(0);
      expect(biting).toBeGreaterThan(0); expect(retargeted).toBe(true); expect(recovered).toBe(true);
      expect(rows).toEqual(original);
    } finally { scene.dispose(); engine.dispose(); }
  });
});

it("uses the selected continuous 540-degree/s rate, completing a half-turn after 333 1/3 ms", () => {
  expect(BODY_TURN_SPEED_DEGREES_PER_SECOND).toBe(540);
  const rows = Array.from({ length: 12 }, (_, tick) => message(tick, { full: tick === 0, heading: tick ? 128 : 0 }));
  const pb = playback(rows);
  for (const [at, degrees] of [[100, 0], [117, 9.18], [150, 27], [200, 54], [300, 108], [433, 179.82], [434, 180]] as const) {
    expect(pose(sample(pb, at))[5]).toBeCloseTo(radians(degrees), 9);
  }
});

it("retains main's body-turn cap beyond the legacy bounds on the 128×96 board", () => {
  const rows = Array.from({ length: 12 }, (_, tick) => {
    const row = message(tick, { full: tick === 0, heading: tick ? 128 : 0, x: 100 });
    row.ants.y.fill(70 * SUB_TILE);
    if (row.full) { row.full.setup.mapW = 128; row.full.setup.mapH = 96; }
    return row;
  });
  const pb = playback(rows);
  for (const [at, degrees] of [[100, 0], [117, 9.18], [150, 27], [200, 54], [300, 108], [433, 179.82], [434, 180]] as const) {
    const f = sample(pb, at);
    expect(f.x[0]).toBe(100); expect(f.y[0]).toBe(70);
    expect(pose(f)[5]).toBeCloseTo(radians(degrees), 9);
  }
});

it("holds facing through a gap, clears bite ownership, then resumes the same cap without an interpolation escape", () => {
  const rows = [message(0, { full: true }), message(1, { fight: 2 }),
    ...Array.from({ length: 8 }, (_, i) => message(i + 5, { heading: 64, far: true }))];
  const pb = playback(rows);
  for (const at of [100, 150, 300, 499, 500]) expect(pose(sample(pb, at))[5]).toBe(0);
  for (const at of [501, 550, 600, 899, 900]) {
    const f = sample(pb, at); expect(f.engagements.some(p => p.a === 1)).toBe(false);
    expect(pose(f)[5]).toBeCloseTo(Math.min(radians(90), cap * (at - 500)), 9);
  }
});

it("holds across arbitrarily large message gaps without allocating a dense gap trajectory", () => {
  const pb = playback([message(0, { full: true }), message(100_000, { heading: 128 }), message(100_001, { heading: 128 })]);
  expect(pose(sample(pb, 5_000_000))[5]).toBe(0);
  expect(pose(sample(pb, 10_000_000))[5]).toBe(0);
  expect(pose(sample(pb, 10_000_050))[5]).toBeCloseTo(cap * 50, 9);
});

it("does not freeze the newest interval when held ticks later acquire their next message", () => {
  const pb = playback([message(0, { full: true })]);
  const seed = pose(sample(pb, 0)); expect(pose(sample(pb, 1000))).toEqual(seed);
  pb.push(message(1, { heading: 128 }), 100);
  expect(pose(sample(pb, 100))[5]).toBe(0);
  pb.push(message(2, { heading: 128 }), 200);
  expect(pose(sample(pb, 150))[5]).toBeCloseTo(cap * 50, 9);
  const held = pose(sample(pb, 200)); expect(pose(sample(pb, 1000))).toEqual(held);
  pb.push(message(3, { heading: 128 }), 300);
  expect(pose(sample(pb, 250))[5]).toBeCloseTo(cap * 150, 9);
});

it("matches streamed and cold checkpoint reconstruction across movement, gaps and old end-state-only checkpoints", () => {
  const rows = Array.from({ length: 300 }, (_, tick) => {
    const phase = tick % 12;
    return message(tick, { full: tick === 0, x: 2 + Math.min(phase, 12 - phase) * 0.1, heading: phase < 6 ? 0 : 128 });
  }).filter(m => m.tick < 20 || m.tick > 22);
  const cold = playback(rows), streamed = new Playback(); let next = 0;
  for (let at = 0; at <= 20_350; at += 50) {
    while (next < rows.length && rows[next]!.tick * 100 <= at + RENDER_DELAY_MS) {
      const m = rows[next++]!; streamed.push(m, m.tick * 100);
    }
    sample(streamed, at);
  }
  const a = pose(sample(cold, 20_350)), b = pose(sample(streamed, 20_350));
  expect(a).toEqual(b);
  const first = pose(sample(cold, 20_333)); sample(cold, 20_375);
  expect(pose(sample(cold, 20_333))).toEqual(first);
});

it("tracks ids through array reorder and seeds full snapshots/new identities without stale body or target history", () => {
  const rows = Array.from({ length: 15 }, (_, tick) => message(tick, { full: tick === 0, heading: tick ? 128 : 0 }));
  const reordered = structuredClone(rows);
  for (let i = 1; i < reordered.length; i += 2) {
    for (const field of ["id", "x", "y", "heading", "colony", "agent", "caste", "carrying"] as const) {
      const a = reordered[i]!.ants[field]; if (!a) continue;
      const value = a[0]!; a[0] = a[1]!; a[1] = value;
    }
  }
  const a = playback(rows), b = playback(reordered);
  for (const at of [0, 117, 235, 400, 700]) expect(pose(sample(a, at))).toEqual(pose(sample(b, at)));
  a.push(message(15, { full: true, heading: 64 }), 1500);
  const reset = sample(a, 1500); expect(pose(reset)[5]).toBeCloseTo(Math.PI / 2); expect(reset.engagements).toEqual([]);
  a.push(message(16, { id: 99, heading: 128 }), 1600);
  a.push(message(17, { id: 99, heading: 128 }), 1700);
  const fresh = sample(a, 1650); expect(pose(fresh, 99)[5]).toBeCloseTo(Math.PI); expect(fresh.engagements).toEqual([]);
});

type FacingTick = Parameters<Pivots["sample"]>[0][number];

/** Small recorded-message-shaped routes, not simulations; tests the real owner without private-state hooks. */
function turnRoute(legs: readonly (readonly [number | null, number])[], mirror = 1): FacingTick[] {
  const ticks: FacingTick[] = [];
  let x = 25 * SUB_TILE, y = 25 * SUB_TILE, heading = 0;
  const append = () => ticks.push({ tick: ticks.length, board: { setup: full.setup }, index: new Map([[1, 0]]), facing: new Map(), engagements: [],
    ants: { count: 1, id: Uint32Array.of(1), x: Uint16Array.of(x), y: Uint16Array.of(y), heading: Uint8Array.of(heading),
      colony: Uint8Array.of(0), agent: Int16Array.of(-1), caste: Uint8Array.of(0), carrying: Uint8Array.of(0) } });
  for (const [degrees, count] of legs) {
    const dx = degrees === null ? 0 : Math.round(Math.cos(radians(degrees)) * 32);
    const dy = degrees === null ? 0 : mirror * Math.round(Math.sin(radians(degrees)) * 32);
    if (degrees !== null) heading = (Math.round(Math.atan2(dy, dx) / (2 * Math.PI) * 256) + 256) % 256;
    for (let n = 0; n < count; n++) { append(); x += dx; y += dy; }
  }
  append();
  return ticks;
}
function facingAt(owner: Pivots, ticks: readonly FacingTick[], time: number): number {
  let at = 0;
  while (at + 1 < ticks.length && ticks[at + 1]!.tick * 100 <= time) at++;
  const a = ticks[at]!.ants;
  const f: TravelFrame = { count: 1, id: a.id, x: Float32Array.of(a.x[0]! / SUB_TILE), y: Float32Array.of(a.y[0]! / SUB_TILE),
    drawX: null, drawY: null, drawRotation: new Float64Array(1), walk: new Uint8Array(1) };
  owner.sample(ticks, at, time, f);
  return f.drawRotation![0]!;
}
const netTurn = (owner: Pivots, ticks: readonly FacingTick[], start: number, end = start + 600) =>
  facingAt(owner, ticks, end) - facingAt(owner, ticks, start);

for (const mirror of [1, -1]) describe(`travel reversal winding, mirror ${mirror}`, () => {
  it("takes the true other physical arc across interval/wrap boundaries and leaves canonical arrays untouched", () => {
    const ticks = turnRoute([[0, 7], [170, 7], [340, 7], [150, 7]], mirror), original = structuredClone(ticks), owner = new Pivots();
    const turns = [600, 1300, 2000].map(start => netTurn(owner, ticks, start) * mirror);
    expect(turns[0]).toBeGreaterThan(radians(150));
    // A roughly +170-degree shortest delta must become roughly -190, not
    // -170 (wrong endpoint), or a per-interval shortest-arc reselection.
    expect(turns[1]).toBeLessThan(-Math.PI); expect(turns[1]).toBeGreaterThan(-radians(210.1));
    expect(turns[2]).toBeGreaterThan(radians(150));
    for (const start of [600, 1300, 2000]) {
      let previous = facingAt(owner, ticks, start);
      for (let ms = start + 10; ms <= start + 600; ms += 10) {
        const h = facingAt(owner, ticks, ms);
        expect(Math.abs(h - previous)).toBeLessThanOrEqual(cap * 10 + 1e-9); previous = h;
      }
      const end = start + 600, tick = ticks[end / 100]!, next = ticks[end / 100 + 1]!;
      const direction = Math.atan2(next.ants.y[0]! - tick.ants.y[0]!, next.ants.x[0]! - tick.ants.x[0]!);
      expect(delta(facingAt(owner, ticks, end), direction)).toBeCloseTo(0, 8);
    }
    expect(ticks).toEqual(original);
  });

  it("keeps sub-150 turns shortest while applying the wider policy just above the threshold", () => {
    for (const degrees of [149, 151]) {
      const ticks = turnRoute([[0, 7], [degrees, 7], [degrees * 2, 7]], mirror), owner = new Pivots();
      const second = netTurn(owner, ticks, 1300) * mirror;
      if (degrees < 150) { expect(second).toBeGreaterThan(0); expect(second).toBeLessThan(radians(150)); }
      else { expect(second).toBeLessThan(-Math.PI); expect(second).toBeGreaterThan(-radians(210.1)); }
    }
  });

  it("does not qualify a peak that retargets back below 150 degrees before its fixed net boundary", () => {
    const ticks = turnRoute([[0, 7], [170, 3], [100, 3], [270, 7]], mirror), owner = new Pivots();
    expect(netTurn(owner, ticks, 600, 900) * mirror).toBeGreaterThan(radians(150));
    expect(netTurn(owner, ticks, 600, 1200) * mirror).toBeLessThan(radians(150));
    // No qualifying predecessor: this later +170-degree turn remains shortest.
    expect(netTurn(owner, ticks, 1200) * mirror).toBeGreaterThan(radians(150));
  });

  it("retains qualified history through a microturn and a hold", () => {
    const ticks = turnRoute([[0, 7], [170, 7], [180, 1], [null, 1], [350, 7]], mirror), owner = new Pivots();
    expect(netTurn(owner, ticks, 600) * mirror).toBeGreaterThan(radians(150));
    expect(netTurn(owner, ticks, 1500) * mirror).toBeLessThan(-Math.PI);
  });

  it("uses the eligible start-to-start two-second boundary, not time since completion", () => {
    for (const ticksInLeg of [20, 21]) {
      const ticks = turnRoute([[0, 7], [170, ticksInLeg], [340, 7]], mirror), owner = new Pivots();
      const start = (6 + ticksInLeg) * 100, arc = netTurn(owner, ticks, start) * mirror;
      if (ticksInLeg === 20) expect(arc).toBeLessThan(-Math.PI);
      else expect(arc).toBeGreaterThan(radians(150));
    }
  });
});

it("clears reversal ownership across a real gap and combat-facing ownership, and reseeds a reappearing identity", () => {
  const route = () => turnRoute([[0, 7], [170, 7], [340, 7]]);
  const gap = route().filter(t => t.tick !== 14), gapOwner = new Pivots();
  expect(facingAt(gapOwner, gap, 1400)).toBe(facingAt(gapOwner, gap, 1300));
  expect(netTurn(gapOwner, gap, 1500)).toBeGreaterThan(radians(150));
  const combat = route(), combatOwner = new Pivots();
  combat[10]!.facing = new Map([[1, { rotation: 0, target: Math.PI }]]);
  expect(netTurn(combatOwner, combat, 1300)).toBeGreaterThan(radians(150));
  const reborn = route(), rebornOwner = new Pivots();
  reborn[14]!.ants.id[0] = 99; reborn[14]!.index = new Map([[99, 0]]); reborn[15]!.ants.heading[0] = 0;
  expect(facingAt(rebornOwner, reborn, 1500)).toBe(0);
  const fresh = route().slice(13), freshOwner = new Pivots();
  expect(netTurn(freshOwner, fresh, 1300)).toBeGreaterThan(radians(150));
});

// Isolated recorded coordinates, not a regenerated match or a replacement for browser evidence.
// Match 30, ant 3463, ticks 8590–8650; source SHA-256
// d81472ba2d9ed92e61b78fcd96f5639ea3e406371c31d7880880130756ed14a0.
const shuttlePoints: readonly (readonly [number, number, number, number])[] = [
    [10761, 9424, 150, 0],
    [10716, 9399, 150, 1],
    [10766, 9413, 12, 1],
    [10815, 9428, 12, 1],
    [10864, 9442, 12, 1],
    [10913, 9457, 12, 1],
    [10962, 9471, 12, 1],
    [11011, 9486, 12, 0],
    [10963, 9468, 142, 0],
    [10915, 9451, 142, 0],
    [10867, 9433, 142, 0],
    [10819, 9415, 142, 0],
    [10771, 9398, 142, 0],
    [10723, 9380, 142, 1],
    [10771, 9396, 13, 1],
    [10820, 9412, 13, 1],
    [10868, 9428, 13, 1],
    [10917, 9444, 13, 1],
    [10966, 9460, 13, 1],
    [11014, 9476, 13, 0],
    [10966, 9459, 141, 0],
    [10918, 9443, 141, 0],
    [10869, 9427, 141, 0],
    [10821, 9410, 141, 0],
    [10772, 9394, 141, 0],
    [10724, 9378, 141, 1],
    [10773, 9394, 13, 1],
    [10821, 9410, 13, 1],
    [10870, 9426, 13, 1],
    [10919, 9442, 13, 1],
    [10967, 9458, 13, 1],
    [11016, 9474, 13, 0],
    [10967, 9458, 141, 0],
    [10919, 9442, 141, 0],
    [10870, 9426, 141, 0],
    [10821, 9410, 141, 0],
    [10773, 9394, 141, 0],
    [10724, 9378, 141, 1],
    [10773, 9394, 13, 1],
    [10821, 9410, 13, 1],
    [10870, 9426, 13, 1],
    [10919, 9442, 13, 1],
    [10967, 9458, 13, 1],
    [11016, 9474, 13, 0],
    [10967, 9458, 141, 0],
    [10919, 9442, 141, 0],
    [10870, 9426, 141, 0],
    [10821, 9410, 141, 0],
    [10773, 9394, 141, 0],
    [10724, 9378, 141, 1],
    [10773, 9394, 13, 1],
    [10821, 9410, 13, 1],
    [10870, 9426, 13, 1],
    [10919, 9442, 13, 1],
    [10967, 9458, 13, 1],
    [11016, 9474, 13, 0],
    [10966, 9464, 136, 0],
    [10916, 9454, 136, 0],
    [10865, 9444, 136, 0],
    [10815, 9434, 136, 0],
    [10765, 9424, 136, 0],
];

for (const fps of [30, 60]) it(`recorded worker 3463 completes near-half-turns at the selected rate without exceeding position bounds at ${fps} fps`, () => {
  const board = structuredClone(full);
  board.setup.terrain = { mapId: "isolated-recorded-shuttle", mapName: "Recorded shuttle on clear ground", water: [] };
  const rows: StreamMessage[] = shuttlePoints.map(([x, y, heading, carrying], i) => ({
    tick: 8590 + i, full: i === 0 ? board : null, events: [],
    ants: { count: 1, id: Uint32Array.of(3463), x: Uint16Array.of(x), y: Uint16Array.of(y),
      heading: Uint8Array.of(heading), colony: Uint8Array.of(1), agent: Int16Array.of(-1),
      caste: Uint8Array.of(0), carrying: Uint8Array.of(carrying) },
  }));
  const pb = new Playback(), f = new Frame(), renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const ants = new Ants(renderer, 10, 10), engine = new NullEngine(), scene = new Scene(engine);
  const ants3d = new Ants3D(scene, new Ground(scene, board.setup.mapW, board.setup.mapH), 0.5, COLONY_RGB);
  const turns = new Map<number, number[]>(), boundaries = [861400, 862000, 862600, 863200, 863800, 864400];
  let next = 0, maximumTrail = 0;
  let previousHeadings: number[] | null = null;
  const unwrapped = [0, 0];
  try {
    for (let k = 0; k <= 6 * fps; k++) {
      const at = 859000 + k * 1000 / fps;
      while (next < rows.length && rows[next]!.tick * 100 <= at + RENDER_DELAY_MS + 1e-7) {
        const m = rows[next++]!; pb.push(m, m.tick * 100);
      }
      sample(pb, at, f); ants.update(f); ants3d.update(f);
      const a = rows[f.tick - 8590]!, b = rows[Math.min(rows.length - 1, f.tick - 8590 + 1)]!;
      expect(f.x[0]).toBeCloseTo((a.ants.x[0]! + (b.ants.x[0]! - a.ants.x[0]!) * f.blend) / SUB_TILE, 5);
      expect(f.y[0]).toBeCloseTo((a.ants.y[0]! + (b.ants.y[0]! - a.ants.y[0]!) * f.blend) / SUB_TILE, 5);
      expect(f.carrying[0]).toBe(a.ants.carrying![0]);
      const p = ants.antLayer.particleChildren[0]!, m = (scene.getMeshByName("ants1") as Mesh)._thinInstanceDataStorage.matrixData!;
      maximumTrail = Math.max(maximumTrail, Math.hypot(p.x - f.x[0]!, p.y - f.y[0]!),
        Math.hypot(m[12]! - f.x[0]!, board.setup.mapH - m[14]! - f.y[0]!));
      const headings = [p.rotation, -Math.atan2(m[2]!, m[0]!)];
      if (previousHeadings) for (let model = 0; model < 2; model++) unwrapped[model]! += delta(previousHeadings[model]!, headings[model]!);
      previousHeadings = headings;
      const boundary = boundaries.find(t => Math.abs(f.renderMs - t) < 1e-6);
      if (boundary !== undefined) turns.set(boundary, [...unwrapped]);
    }
    expect(maximumTrail).toBeLessThanOrEqual(0.50001);
    for (let model = 0; model < 2; model++) {
      let previousChange: number | null = null;
      for (let i = 1; i < boundaries.length; i++) {
        // Unwrap individual frame increments above, NEVER this entire arc:
        // a physical -180.003-degree turn must not become positive here.
        const change = turns.get(boundaries[i]!)![model]! - turns.get(boundaries[i - 1]!)![model]!;
        expect(Math.abs(change) * 180 / Math.PI).toBeCloseTo(180, 0);
        if (previousChange !== null) expect(Math.sign(change)).toBe(-Math.sign(previousChange));
        previousChange = change;
      }
    }
  } finally { scene.dispose(); engine.dispose(); }
});
