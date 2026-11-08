import { describe, expect, it } from "vitest";
import { Texture, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { decodeMessage, SUB_TILE, type StreamMessage, type StreamSetup } from "../../src/live/format.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { Ants } from "../../web/src/ants.ts";
import { Ants3D } from "../../web/src/board3d/ants3d.ts";
import { Ground, COLONY_RGB } from "../../web/src/board3d/ground.ts";
import { Bites } from "../../web/src/bite.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

// Constructed stream messages, never a generated match or simulation.
const seed = decodeMessage(scale2Packets(1)[0]!).full!;
type Point = readonly [number, number];
const rect = [10, 10, 4, 4] as const;
const corner: readonly Point[] = [[9.998046875, 10.00390625], [10.00390625, 9.998046875], [18, 2], [19, 2], [19, 2]];
const phone2d = 1.4128728414442702, phone3d = 1.575799979790192;
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const occupied = ([x, y]: Point) => x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];

function recording(points: readonly Point[], terrain: StreamSetup["terrain"], dimensions?: readonly [number, number]): StreamMessage[] {
  const full = structuredClone(seed);
  full.setup.terrain = terrain;
  if (dimensions) { full.setup.mapW = dimensions[0]; full.setup.mapH = dimensions[1]; }
  const positions: Point[] = [points[0]!];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!, b = points[k]!, steps = Math.max(1, Math.ceil(dist(a, b) / 0.2));
    for (let q = 1; q <= steps; q++) positions.push([a[0] + (b[0] - a[0]) * q / steps, a[1] + (b[1] - a[1]) * q / steps]);
  }
  let heading = Math.round((Math.atan2(points[1]![1] - points[0]![1], points[1]![0] - points[0]![0]) / (2 * Math.PI) * 256 + 256) % 256);
  return positions.map(([x, y], tick) => {
    const before = positions[Math.max(0, tick - 1)]!;
    if (x !== before[0] || y !== before[1]) heading = Math.round((Math.atan2(y - before[1], x - before[0]) / (2 * Math.PI) * 256 + 256) % 256);
    return { tick, full: tick === 0 ? full : null, events: [], ants: { count: 1, id: Uint32Array.of(1),
      x: Uint16Array.of(Math.round(x * SUB_TILE)), y: Uint16Array.of(Math.round(y * SUB_TILE)), heading: Uint8Array.of(heading),
      colony: Uint8Array.of(0), agent: Int16Array.of(-1), caste: Uint8Array.of(0), carrying: Uint8Array.of(0) } };
  });
}
function playback(rows: readonly StreamMessage[]): Playback {
  const pb = new Playback();
  for (const row of rows) pb.push(row, row.tick * 100);
  return pb;
}
function position(pb: Playback, at: number) {
  const f = new Frame();
  expect(pb.sample(at + RENDER_DELAY_MS, f)).toBe(true);
  return { raw: [f.x[0]!, f.y[0]!] as Point, draw: [f.drawX![0]!, f.drawY![0]!] as Point, facing: f.drawRotation![0]!, walk: f.walk[0]! };
}
interface BodySample { at: number; raw: Point; positions: readonly Point[]; overrides: readonly boolean[] }
function bodies(rows: readonly StreamMessage[], fps: number): BodySample[] {
  const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
  const engine = new NullEngine(), scene = new Scene(engine);
  const setup = rows[0]!.full!.setup;
  const ants = new Ants(renderer, phone2d * 10, 10), ants3d = new Ants3D(scene, new Ground(scene, setup.mapW, setup.mapH), phone3d, COLONY_RGB);
  const pb = new Playback(), f = new Frame(), result: BodySample[] = [];
  let next = 0;
  try {
    for (let k = 0; k * 1000 / fps <= rows.at(-1)!.tick * 100; k++) {
      const at = k * 1000 / fps, now = at + RENDER_DELAY_MS;
      while (next < rows.length && rows[next]!.tick * 100 <= now + 1e-7) { const row = rows[next++]!; pb.push(row, row.tick * 100); }
      expect(pb.sample(now, f)).toBe(true);
      ants.update(f); ants3d.update(f);
      const p = ants.antLayer.particleChildren[0]!, m = (scene.getMeshByName("ants0") as Mesh)._thinInstanceDataStorage.matrixData!;
      const bites2 = Reflect.get(ants, "bites") as Bites, bites3 = Reflect.get(ants3d, "bites") as Bites;
      result.push({ at: f.renderMs, raw: [f.x[0]!, f.y[0]!], positions: [[p.x, p.y], [m[12]!, setup.mapH - m[14]!]],
        overrides: [bites2.bodyPosition(0, phone2d, "2d") !== null, bites3.bodyPosition(0, phone3d, "3d") !== null] });
    }
    return result;
  } finally { scene.dispose(); engine.dispose(); }
}

for (const fps of [30, 60]) describe(`${fps} fps legal terrain position`, () => {
  for (const kind of ["water", "rock"] as const) it(`progresses through a quantized ${kind} corner on actual particles and matrices`, () => {
    const terrain = { mapId: "ground-fixture", mapName: "Ground fixture", water: kind === "water" ? [rect] : [], rocks: kind === "rock" ? [[...rect, 1] as const] : [] };
    const rows = recording(corner, terrain), original = structuredClone(rows), samples = bodies(rows, fps);
    let moved = 0;
    for (let k = 0; k < samples.length; k++) {
      const s = samples[k]!;
      for (let model = 0; model < 2; model++) {
        const p = s.positions[model]!;
        expect(occupied(p)).toBe(false);
        expect(dist(p, s.raw)).toBeLessThanOrEqual(0.5);
        if (k) { const step = dist(p, samples[k - 1]!.positions[model]!); expect(step).toBeLessThanOrEqual(0.5); if (step > 1e-6) moved++; }
      }
    }
    expect(moved).toBeGreaterThan(100);
    expect(samples.at(-1)!.positions[0]![0]).toBeCloseTo(19, 5);
    expect(rows).toEqual(original);
  });

  it("keeps final bodies continuous when bite/recovery overrides start and end", () => {
    const rows = Array.from({ length: 65 }, (_, tick): StreamMessage => {
      const x = tick < 15 ? 9.8 : tick < 30 ? 9.8 - (tick - 15) * 0.1 : 8.3;
      const full = tick === 0 ? structuredClone(seed) : null;
      if (full) full.setup.terrain = { mapId: "bite-corner", mapName: "Bite corner", water: [rect] };
      return { tick, full, events: tick === 8 ? [{ kind: "fight", antId: 1, targetId: 2, colony: 0, tileX: 9, tileY: 10 }] : [],
        ants: { count: 2, id: Uint32Array.of(1, 2), x: Uint16Array.from([x, tick < 18 ? 9.1 : 3].map(v => Math.round(v * SUB_TILE))),
          y: Uint16Array.from([10.5, tick < 18 ? 10.5 : 3].map(v => Math.round(v * SUB_TILE))), heading: Uint8Array.of(tick < 15 ? 0 : 128, 0),
          colony: Uint8Array.of(0, 1), agent: Int16Array.of(-1, -1), caste: Uint8Array.of(0, 0), carrying: Uint8Array.of(0, 0) } };
    });
    const samples = bodies(rows, fps), transitions = [0, 0];
    for (let k = 1; k < samples.length; k++) for (let model = 0; model < 2; model++) {
      const a = samples[k - 1]!, b = samples[k]!;
      expect(dist(b.positions[model]!, b.raw)).toBeLessThanOrEqual(0.5);
      expect(dist(a.positions[model]!, b.positions[model]!)).toBeLessThanOrEqual(0.5);
      if (a.overrides[model] !== b.overrides[model]) transitions[model]!++;
    }
    expect(transitions[0]).toBeGreaterThanOrEqual(2); expect(transitions[1]).toBeGreaterThanOrEqual(2);
  });
});

for (const kind of ["water", "rock"] as const) it(`keeps main's ${kind}-corner routing on the 128×96 board`, () => {
  const shifted = corner.map(([x, y]): Point => [x + 80, y + 60]);
  const barrier = [90, 70, 4, 4] as const;
  const rows = recording(shifted, { mapId: "scaled-corner", mapName: "Scaled corner",
    water: kind === "water" ? [barrier] : [], rocks: kind === "rock" ? [[...barrier, 1] as const] : [] }, [128, 96]);
  const pb = playback(rows);
  let detoured = 0;
  for (let at = 0; at <= 200; at += 0.25) {
    const p = position(pb, at);
    expect(p.draw[0] >= 90 && p.draw[0] < 94 && p.draw[1] >= 70 && p.draw[1] < 74).toBe(false);
    expect(dist(p.raw, p.draw)).toBeLessThanOrEqual(0.5);
    if (dist(p.raw, p.draw) > 0.00001) detoured++;
  }
  expect(detoured).toBeGreaterThan(0);
  expect(position(pb, rows.at(-1)!.tick * 100).draw[0]).toBeCloseTo(99, 5);
});

it("takes legal fractional-ms routes rather than re-cutting the water corner", () => {
  const pb = playback(recording(corner, { mapId: "fractional", mapName: "Fractional", water: [rect] }));
  let detoured = 0;
  for (let at = 0; at <= 200; at += 0.25) {
    const p = position(pb, at);
    expect(occupied(p.draw)).toBe(false);
    expect(dist(p.raw, p.draw)).toBeLessThanOrEqual(0.5);
    if (dist(p.raw, p.draw) > 0.00001) detoured++;
  }
  expect(detoured).toBeGreaterThan(0);
});

it("reconstructs the same corner route across frame rates, backwards seeks and cold checkpoints", () => {
  const rows = recording(corner, { mapId: "seek", mapName: "Seek", water: [rect] });
  const a = playback(rows), b = playback(rows), end = rows.at(-1)!.tick * 100;
  for (let k = 0; k * 1000 / 30 < end; k++) {
    const at = k * 1000 / 30;
    const low = position(a, at); position(b, Math.max(0, at - 1000 / 60));
    expect(position(b, at)).toEqual(low);
  }
  // Live playback keeps only a short seek window; a recording seek rebuilds it.
  const seek = playback(rows), before = position(seek, 50.25);
  position(seek, 250); expect(position(seek, 50.25)).toEqual(before);
  expect(position(playback(rows), 50.25)).toEqual(before);
  expect(position(playback(rows), end - 50.25)).toEqual(position(a, end - 50.25));
});

it("holds the last legal point when a route is unavailable instead of teleporting across terrain", () => {
  const rows = recording([[9.8, 3], [11.2, 3], [11.2, 3]], { mapId: "split", mapName: "Split", water: [[10, 0, 1, seed.setup.mapH]] });
  const pb = playback(rows);
  for (let at = 0; at <= rows.at(-1)!.tick * 100; at += 10) expect(position(pb, at).draw[0]).toBeLessThan(10);
});

it("clears route geometry/history for a new full snapshot and preserves an underrun hold", () => {
  const rows = recording(corner, { mapId: "before", mapName: "Before", water: [rect] });
  const pb = playback(rows), end = rows.at(-1)!.tick * 100;
  const held = position(pb, end); expect(position(pb, end + 1000)).toEqual(held);
  const fresh = recording([[10.5, 10.5], [11.5, 10.5]], { mapId: "after", mapName: "After", water: [] });
  const offset = rows.at(-1)!.tick + 10;
  for (const row of fresh) { row.tick += offset; pb.push(row, row.tick * 100); }
  const p = position(pb, offset * 100 + 50);
  expect(p.draw[0]).toBeCloseTo(p.raw[0], 5); expect(p.draw[1]).toBeCloseTo(p.raw[1], 5);
  expect(occupied(p.draw)).toBe(true); // The old setup's water must not leak into the new one.
});
