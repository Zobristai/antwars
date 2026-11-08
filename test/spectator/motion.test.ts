/**
 * Interpolation checks: recorded
 * live streams, made by src/live/record.ts from scripted matches whose agents
 * attack the enemy queen, are replayed through the client's playback buffer
 * 250 ms behind their newest tick at 30 fps, with frame times stepped 33/33/34
 * ms as capture does. Both recordings run into combat (deaths from tick 600),
 * so the dropped-message and corpse checks have deaths to work on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { SUB_TILE, decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { createRng } from "../../src/sim/rng.ts";
import { LARGE_CONFIG, playScripted, recordLog, type ScriptOptions } from "../../src/live/record.ts";
import { Frame, Playback, RENDER_DELAY_MS, SPAWN_FADE_MS, squadsInQueenZone } from "../../web/src/buffer.ts";
import { forEachNear, type Grid } from "../../src/sim/map.ts";
import type { SimState } from "../../src/sim/types.ts";
import type { StreamAnts, StreamSetup } from "../../src/live/format.ts";
import { checkRenderer } from "../../web/capture/browser.ts";
import { frontBounds } from "../../web/src/territory.ts";
import { QueenHomes } from "../../web/src/effects.ts";
import { Bites } from "../../web/src/bite.ts";
import { playable } from "../playable.ts";

vi.setConfig({ testTimeout: 120_000 });

const FPS = 30;
const TICKS = 1_000;
// Default seed 6004 (was 6006): under the capped mark rule seed 6006 ends by queen overrun at tick 954, before TICKS.
const SCRIPTS: Record<string, ScriptOptions> = {
  default: { seed: 6004, config: playable(DEFAULT_CONFIG), agents: 10, ticks: TICKS, attack: true },
  large: { seed: 6006, config: LARGE_CONFIG, agents: 50, ticks: TICKS, attack: true },
};

interface Recording {
  messages: StreamMessage[];
  /** Tile owners at each tick, rebuilt from the stream. */
  territory: Uint8Array[];
}

function record(script: ScriptOptions): Recording {
  const messages = recordLog(playScripted(script).lines, TICKS).map(decodeMessage);
  const first = messages[0]!;
  const board = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
  const territory = [board.full.territory.slice()];
  for (const m of messages.slice(1)) {
    board.apply(m);
    territory.push(board.full.territory.slice());
  }
  return { messages, territory };
}

const recordings = Object.fromEntries(Object.entries(SCRIPTS).map(([name, s]) => [name, record(s)])) as Record<string, Recording>;

interface Replay {
  /** Messages in the order delivered, with their arrival times. */
  delivered: { msg: StreamMessage; at: number }[];
  frames: { now: number; frame: Frame; underrun: boolean; target: number; newestTick: number }[];
}

/** Replay with given arrival times (null = dropped), sampling a copy of every frame. */
function replay(msgs: StreamMessage[], arrival: (tick: number) => number | null, keep: (f: Frame) => Frame = clone): Replay {
  const delivered = msgs.flatMap((msg) => {
    const at = arrival(msg.tick);
    return at === null ? [] : [{ msg, at }];
  });
  const pb = new Playback();
  const frame = new Frame();
  const frames: Replay["frames"] = [];
  let next = 0;
  const start = delivered[0]!.at;
  const end = delivered.at(-1)!.at;
  for (let k = 0; ; k++) {
    const now = start + Math.round((k * 1000) / FPS);
    if (now > end) break;
    while (next < delivered.length && delivered[next]!.at <= now) {
      pb.push(delivered[next]!.msg, delivered[next]!.at);
      next++;
    }
    pb.sample(now, frame);
    frames.push({ now, frame: keep(frame), underrun: pb.underrun(now), target: pb.targetMs(now), newestTick: pb.newestTick });
  }
  return { delivered, frames };
}

function clone(f: Frame): Frame {
  const c = new Frame();
  c.renderMs = f.renderMs;
  c.tick = f.tick;
  c.count = f.count;
  c.blend = f.blend;
  c.territoryA = f.territoryA;
  c.territoryB = f.territoryB;
  c.id = f.id.slice(0, f.count);
  c.x = f.x.slice(0, f.count);
  c.y = f.y.slice(0, f.count);
  c.alpha = f.alpha.slice(0, f.count);
  c.corpses = [...f.corpses];
  c.engagements = f.engagements;
  c.marks = [...f.marks];
  return c;
}

const onTime = (tick: number) => tick * TICK_MS;

function sameGrid(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe.each(["default", "large"])("%s recording replayed 250 ms behind", (name) => {
  const { messages: msgs, territory } = recordings[name]!;
  const run = replay(msgs, onTime);
  // Once playback has reached the first message's time.
  const live = run.frames.filter((f) => f.now >= RENDER_DELAY_MS);

  it("runs into combat: ants die after tick 600", () => {
    const deaths = msgs.flatMap((m) => m.events.filter((e) => e.kind === "death").map(() => m.tick));
    expect(deaths.length).toBeGreaterThan(0);
    expect(Math.min(...deaths)).toBeGreaterThanOrEqual(600);
    expect(msgs.at(-1)!.tick).toBe(TICKS);
  });

  it("draws 250 ms behind the newest tick and never ahead", () => {
    for (const f of live) {
      expect(f.frame.renderMs).toBeLessThanOrEqual(f.newestTick * TICK_MS);
      expect(f.frame.renderMs).toBeCloseTo(f.now - RENDER_DELAY_MS, 6);
    }
  });

  it("puts every drawn ant between its own previous and next positions, matched by id", () => {
    const byTick = new Map(msgs.map((s) => [s.tick, new Map(Array.from(s.ants.id, (id, i) => [id, [s.ants.x[i]! / SUB_TILE, s.ants.y[i]! / SUB_TILE] as const]))]));
    const bad: string[] = [];
    let checked = 0;
    for (const { frame } of live) {
      const a = Math.floor(frame.renderMs / TICK_MS);
      const A = byTick.get(a)!;
      const B = byTick.get(a + 1) ?? A;
      // The drawn set is exactly the ants alive at the earlier message: none borrowed across a birth or death.
      expect(frame.count).toBe(A.size);
      for (let i = 0; i < frame.count; i++) {
        const id = frame.id[i]!;
        const p = A.get(id);
        if (!p) {
          bad.push(`frame ${frame.renderMs}: ant ${id} not in tick ${a}`);
          continue;
        }
        const q = B.get(id) ?? p;
        const x = frame.x[i]!;
        const y = frame.y[i]!;
        const eps = 1e-4;
        const inBox = x >= Math.min(p[0], q[0]) - eps && x <= Math.max(p[0], q[0]) + eps && y >= Math.min(p[1], q[1]) - eps && y <= Math.max(p[1], q[1]) + eps;
        // On the segment, not just inside its box.
        const cross = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
        if (!inBox || Math.abs(cross) > 1e-3) bad.push(`frame ${frame.renderMs}: ant ${id} at ${x},${y} outside ${p} -> ${q}`);
        checked++;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(live.length * 10);
  });

  it("moves a steadily walking ant a near-constant distance per frame (within 10%)", () => {
    // Ants with the same non-zero step over five consecutive ticks walk steadily across that window.
    let checked = 0;
    for (let t = 100; t < 900 && checked < 40; t += 37) {
      const w = [0, 1, 2, 3, 4].map((d) => msgs[t + d]!.ants);
      const idx = w.map((s) => new Map(Array.from(s.id, (id, i) => [id, i])));
      for (let i = 0; i < w[0]!.count && checked < 40; i++) {
        const id = w[0]!.id[i]!;
        const pos = w.map((s, k) => {
          const j = idx[k]!.get(id);
          return j === undefined ? null : [s.x[j]!, s.y[j]!];
        });
        if (pos.some((p) => p === null)) continue;
        const steps = pos.slice(1).map((p, k) => [p![0]! - pos[k]![0]!, p![1]! - pos[k]![1]!]);
        const steady = steps.every((s) => Math.abs(s[0]! - steps[0]![0]!) <= 1 && Math.abs(s[1]! - steps[0]![1]!) <= 1);
        if (!steady || Math.hypot(steps[0]![0]!, steps[0]![1]!) < 20) continue;
        const dists: number[] = [];
        let last: [number, number] | null = null;
        for (const { frame } of live) {
          if (frame.renderMs < t * TICK_MS || frame.renderMs > (t + 4) * TICK_MS) continue;
          const j = Array.prototype.indexOf.call(frame.id, id) as number;
          const here: [number, number] = [frame.x[j]!, frame.y[j]!];
          if (last) dists.push(Math.hypot(here[0] - last[0], here[1] - last[1]));
          last = here;
        }
        const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
        expect(dists.length).toBeGreaterThanOrEqual(10);
        expect((Math.max(...dists) - Math.min(...dists)) / mean).toBeLessThanOrEqual(0.1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("fades spawns in, and shows deaths and words within one frame of their tick", () => {
    const frameMs = Math.ceil(1000 / FPS);
    const born = new Map<number, number>();
    const deaths: { id: number; tick: number }[] = [];
    const laid: { id: number; tick: number }[] = [];
    for (const s of msgs) {
      for (const e of s.events) {
        if (e.kind === "birth") born.set(e.antId, s.tick);
        if (e.kind === "death") deaths.push({ id: e.antId, tick: s.tick });
        if (e.kind === "mark") laid.push({ id: e.mark.id, tick: s.tick });
      }
    }
    // Spawns: the first frame an ant is drawn it is faint, and it brightens over SPAWN_FADE_MS.
    const firstSeen = new Map<number, number>();
    for (const { frame } of live) {
      for (let i = 0; i < frame.count; i++) {
        const id = frame.id[i]!;
        const tick = born.get(id);
        if (tick === undefined) continue;
        const age = frame.renderMs - tick * TICK_MS;
        if (!firstSeen.has(id)) {
          firstSeen.set(id, age);
          expect(age).toBeLessThan(frameMs);
          expect(frame.alpha[i]!).toBeLessThan(0.1);
        }
        if (age < SPAWN_FADE_MS) expect(frame.alpha[i]!).toBeLessThan(1);
        else expect(frame.alpha[i]!).toBe(1);
      }
    }
    expect(firstSeen.size).toBeGreaterThan(10);
    // Deaths: the corpse appears on the first frame at or after the death tick, never before.
    let corpses = 0;
    for (const d of deaths) {
      if (d.tick * TICK_MS > live.at(-1)!.frame.renderMs) continue;
      const first = live.find((f) => f.frame.corpses.some((c) => c.antId === d.id));
      expect(first).toBeDefined();
      const lag = first!.frame.renderMs - d.tick * TICK_MS;
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(frameMs);
      corpses++;
    }
    expect(corpses).toBeGreaterThan(0);
    // Words: a mark's words are shown from the first frame at or after the tick of the message that laid it.
    expect(laid.length).toBeGreaterThan(10);
    for (const m of laid) {
      if (m.tick * TICK_MS > live.at(-1)!.frame.renderMs) continue;
      const first = live.find((f) => f.frame.marks.some((v) => v.mark.id === m.id))!;
      const lag = first.frame.renderMs - m.tick * TICK_MS;
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(frameMs);
    }
  });

  it("blends a tile changing owner over the frames between its two messages", () => {
    let segments = 0;
    const lastMs = live.at(-1)!.frame.renderMs;
    for (let t = 1; (t + 1) * TICK_MS <= lastMs; t++) {
      const a = territory[t]!;
      const b = territory[t + 1]!;
      if (sameGrid(a, b)) continue;
      const inside = live.filter((f) => f.frame.renderMs > t * TICK_MS && f.frame.renderMs < (t + 1) * TICK_MS);
      expect(inside.length).toBeGreaterThanOrEqual(2);
      let prev = 0;
      for (const { frame } of inside) {
        expect(sameGrid(frame.territoryA, a)).toBe(true);
        expect(sameGrid(frame.territoryB, b)).toBe(true);
        expect(frame.blend).toBeGreaterThan(prev);
        expect(frame.blend).toBeLessThan(1);
        prev = frame.blend;
      }
      segments++;
    }
    expect(segments).toBeGreaterThan(50);
  });
});

describe.each(["default", "large"])("%s recording under network trouble", (name) => {
  const msgs = recordings[name]!.messages;
  const lean = (f: Frame) => ({ renderMs: f.renderMs }) as Frame;

  it("never runs out of buffer with ±50 ms message jitter", () => {
    const rng = createRng(0x51773);
    const jitter = msgs.map(() => Math.round(rng.next() * 100 - 50));
    const run = replay(msgs, (t) => t * TICK_MS + jitter[t]!, lean);
    const first = run.delivered[0]!.at;
    const live = run.frames.filter((f) => f.now >= first + RENDER_DELAY_MS);
    expect(live.length).toBeGreaterThan(1500);
    for (const f of live) expect(f.underrun).toBe(false);
  });

  it("keeps births and deaths whose message was dropped", () => {
    const window = (r: Replay, tick: number) => r.frames.filter((f) => f.frame.renderMs >= (tick + 1) * TICK_MS && f.frame.renderMs < (tick + 3) * TICK_MS);
    // A dropped message carrying a death: the ant still leaves a corpse.
    const withDeath = msgs.find((s) => s.tick > 50 && s.events.some((e) => e.kind === "death"))!;
    const died = withDeath.events.find((e) => e.kind === "death")! as { antId: number };
    const r1 = replay(msgs, (t) => (t === withDeath.tick ? null : t * TICK_MS));
    expect(window(r1, withDeath.tick).some((f) => f.frame.corpses.some((c) => c.antId === died.antId))).toBe(true);
    // A dropped message carrying a birth: the newborn fades in rather than popping in at full strength.
    const withBirth = msgs.find((s) => s.tick > 50 && s.events.some((e) => e.kind === "birth"))!;
    const born = withBirth.events.find((e) => e.kind === "birth")! as { antId: number };
    const r2 = replay(msgs, (t) => (t === withBirth.tick ? null : t * TICK_MS));
    const first = window(r2, withBirth.tick).find((f) => Array.prototype.indexOf.call(f.frame.id, born.antId) >= 0)!;
    expect(first.frame.alpha[Array.prototype.indexOf.call(first.frame.id, born.antId) as number]!).toBeLessThan(1);
  });

  it("never runs out of buffer with one dropped message (a 200 ms gap)", () => {
    const dropped = 300;
    const run = replay(msgs, (t) => (t === dropped ? null : t * TICK_MS), lean);
    expect(run.delivered.some((d) => d.msg.tick === dropped)).toBe(false);
    for (const f of run.frames.filter((f) => f.now >= RENDER_DELAY_MS)) {
      expect(f.underrun).toBe(false);
      expect(f.frame.renderMs).toBeLessThanOrEqual(f.newestTick * TICK_MS);
    }
  });
});

describe("queen zone", () => {
  // The overrun bar names squads by the sim's tile-based (Chebyshev) zone.
  const W = 40;
  const H = 30;
  const qt: [number, number] = [20, 15];
  const r = DEFAULT_CONFIG.overrunRadiusTiles;
  const setup: StreamSetup = {
    mapW: W,
    mapH: H,
    ticksPerSecond: 10,
    matchTicks: 100,
    idleTicks: 100,
    overrunRadiusTiles: r,
    queens: [
      [qt[0] * SUB_TILE + SUB_TILE / 2, qt[1] * SUB_TILE + SUB_TILE / 2],
      [5 * SUB_TILE, 5 * SUB_TILE],
    ],
  };
  // Each ant: tile offset from the queen's tile, sub-tile position within that tile, colony, agent.
  const placed: { dt: [number, number]; at: [number, number]; colony: 0 | 1; agent: number }[] = [
    { dt: [r, r], at: [128, 128], colony: 1, agent: 3 }, // corner, tile centre
    { dt: [r, 0], at: [255, 128], colony: 1, agent: 4 }, // edge, past the tile centre
    { dt: [-r, -r], at: [0, 0], colony: 1, agent: 4 }, // far corner, outer edge of its tile
    { dt: [0, -r], at: [128, 0], colony: 1, agent: 4 }, // edge, outer edge of its tile
    { dt: [r + 1, 0], at: [0, 128], colony: 1, agent: 5 }, // one tile out, nearest edge
    { dt: [r + 1, r + 1], at: [0, 0], colony: 1, agent: 6 }, // one tile out diagonally
    { dt: [0, 1], at: [128, 128], colony: 0, agent: 1 }, // defender's own squad
    { dt: [1, 1], at: [128, 128], colony: 1, agent: -1 }, // enemy house-bot ant, no squad
  ];
  const ants: StreamAnts = {
    count: placed.length,
    id: Uint32Array.from(placed, (_p, i) => i + 1),
    x: Uint16Array.from(placed, (p) => (qt[0] + p.dt[0]) * SUB_TILE + p.at[0]),
    y: Uint16Array.from(placed, (p) => (qt[1] + p.dt[1]) * SUB_TILE + p.at[1]),
    heading: new Uint8Array(placed.length),
    colony: Uint8Array.from(placed, (p) => p.colony),
    agent: Int16Array.from(placed, (p) => p.agent),
  };

  it("names the corner and edge squads past the tile centre, and none a tile beyond", () => {
    // Squad 4 has three ants in the zone, squad 3 one; 5 and 6 are a tile outside.
    expect(squadsInQueenZone(ants, setup, 0)).toEqual([4, 3]);
  });

  it("brackets each queen's home on exactly the zone the overrun bar counts", () => {
    const homes = new QueenHomes(20);
    homes.update({ board: { setup }, targetMs: 0, hits: [], lossShown: new Map() } as unknown as Frame);
    const zone = homes.zones.find((z) => z.colony === 0)!;
    // Tiles queenTile-r to queenTile+r inclusive: [qt-r, qt+r+1).
    expect(zone).toEqual({ colony: 0, x0: qt[0] - r, y0: qt[1] - r, x1: qt[0] + r + 1, y1: qt[1] + r + 1 });
    // The ant r tiles out is inside the brackets and counted; the one r+1 tiles out is outside and not.
    const one = (i: number) => ({ ...ants, count: 1, id: ants.id.subarray(i, i + 1), x: ants.x.subarray(i, i + 1), y: ants.y.subarray(i, i + 1), heading: ants.heading.subarray(i, i + 1), colony: ants.colony.subarray(i, i + 1), agent: ants.agent.subarray(i, i + 1) });
    const inside = (i: number) => {
      const tx = Math.floor(ants.x[i]! / SUB_TILE);
      const ty = Math.floor(ants.y[i]! / SUB_TILE);
      return tx >= zone.x0 && tx < zone.x1 && ty >= zone.y0 && ty < zone.y1;
    };
    for (const i of [0, 1, 4, 5]) expect(inside(i), `ant at offset ${placed[i]!.dt}`).toBe(squadsInQueenZone(one(i), setup, 0).length === 1);
    expect(inside(1)).toBe(true);
    expect(inside(4)).toBe(false);
    // The other colony's home is drawn too, from its own queen.
    expect(homes.zones.find((z) => z.colony === 1)).toEqual({ colony: 1, x0: 5 - r, y0: 5 - r, x1: 5 + r + 1, y1: 5 + r + 1 });
  });

  it("counts exactly the ants the sim's own zone visits", () => {
    const grid: Grid = new Map();
    for (let i = 0; i < ants.count; i++) {
      const key = Math.floor(ants.y[i]! / SUB_TILE) * W + Math.floor(ants.x[i]! / SUB_TILE);
      const ant = { id: ants.id[i]!, colony: ants.colony[i]! };
      grid.set(key, [...(grid.get(key) ?? []), ant as never]);
    }
    const state = { config: { mapWidth: W, mapHeight: H } } as unknown as SimState;
    const simIn = new Set<number>();
    forEachNear(state, grid, qt[0], qt[1], r, (a) => simIn.add(a.id));
    for (let i = 0; i < ants.count; i++) {
      const p = placed[i]!;
      if (p.agent < 0 || p.colony === 0) continue;
      const named = squadsInQueenZone({ ...ants, count: 1, id: ants.id.subarray(i, i + 1), x: ants.x.subarray(i, i + 1), y: ants.y.subarray(i, i + 1), heading: ants.heading.subarray(i, i + 1), colony: ants.colony.subarray(i, i + 1), agent: ants.agent.subarray(i, i + 1) }, setup, 0);
      expect(named.length === 1, `ant at offset ${p.dt}`).toBe(simIn.has(ants.id[i]!));
    }
  });
});

describe("one clock", () => {
  it("takes animation time only from clock.ts; timing.ts alone reads real time, for the bench", () => {
    const dir = join(import.meta.dirname, "../../web/src");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "clock.ts" && f !== "timing.ts")
      .flatMap((f) => (/\b(?:Date\.now|new Date|Math\.random|performance\.now)/.test(readFileSync(join(dir, f), "utf8")) ? [f] : []));
    expect(offenders).toEqual([]);
  });
});

describe("capture renderer guard", () => {
  const swiftShader = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
  it("refuses any renderer that is not SwiftShader, whatever extra requirement is given", () => {
    const other = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)";
    expect(checkRenderer(other)).not.toBeNull();
    expect(checkRenderer(other, "ANGLE")).not.toBeNull();
    expect(checkRenderer(other, "")).not.toBeNull();
    expect(checkRenderer(swiftShader)).toBeNull();
    expect(checkRenderer(swiftShader, "Vulkan")).toBeNull();
    expect(checkRenderer(swiftShader, "NVIDIA")).not.toBeNull();
  });
});

describe("front line crop", () => {
  // The front mesh must cover boundaries between vertically adjacent tiles.
  const W = 20;
  const H = 12;
  const grid = (owner: (x: number, y: number) => number) => {
    const g = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = owner(x, y);
    return g;
  };
  it("covers a top/bottom split across the whole map width", () => {
    const g = grid((_x, y) => (y < 6 ? 1 : 2));
    expect(frontBounds([g], W, H, 0)).toEqual({ x0: 0, y0: 5, x1: W, y1: 7 });
  });
  it("covers a horizontal segment outside the columns of a vertical one", () => {
    // Colony 1 holds the left half and a strip along the top; the strip's lower edge runs
    // horizontally through columns the vertical boundary never reaches.
    const g = grid((x, y) => (x < 4 || y < 3 ? 1 : 2));
    const box = frontBounds([g], W, H, 0)!;
    expect(box.x1).toBe(W);
    expect(box.y0).toBe(2);
  });
  it("is empty where the colonies never meet, and ignores neutral tiles", () => {
    expect(frontBounds([grid((x) => (x < 10 ? 1 : 0))], W, H, 2)).toBeNull();
  });
});

// Isolated Held.engagements history: later messages cannot mutate a delayed pair.
describe("delayed fight target and final-hit history", () => {
  function ants(ids: number[], xs: number[]): StreamAnts {
    return { count: ids.length, id: Uint32Array.from(ids), x: Uint16Array.from(xs.map((x) => x * SUB_TILE)),
      y: new Uint16Array(ids.length).fill(2 * SUB_TILE), heading: new Uint8Array(ids.length),
      colony: Uint8Array.from(ids.map((id) => id === 81 ? 0 : 1)), agent: new Int16Array(ids.length).fill(-1) };
  }
  it("samples the earlier target, includes its killing hit exactly once, and clears after reset", () => {
    const pb = new Playback(), f = new Frame(), bites = new Bites();
    const full = structuredClone(recordings.default!.messages[0]!.full!);
    const all = ants([81, 17, 250], [2, 3, 3]);
    pb.push({ tick: 0, ants: all, full, events: [] }, 0);
    pb.push({ tick: 1, ants: all, full: null, events: [{ kind: "fight", antId: 81, targetId: 17, colony: 0, tileX: 2, tileY: 2 }] }, 100);
    pb.push({ tick: 2, ants: all, full: null, events: [{ kind: "fight", antId: 81, targetId: 250, colony: 0, tileX: 2, tileY: 2 }] }, 200);
    pb.push({ tick: 3, ants: ants([81, 17], [2, 3]), full: null, events: [{ kind: "death", antId: 250, colony: 1, x: 3 * SUB_TILE, y: 2 * SUB_TILE }] }, 300);
    pb.push({ tick: 4, ants: ants([81, 17], [2, 3]), full: null, events: [] }, 400);
    pb.sample(100 + RENDER_DELAY_MS + 30, f); expect(f.engagements.map((p) => p.b)).toEqual([17]);
    const old = f.engagements;
    pb.sample(200 + RENDER_DELAY_MS + 30, f); expect(f.engagements.map((p) => p.b)).toEqual([250]); expect(old.map((p) => p.b)).toEqual([17]);
    pb.sample(300 + RENDER_DELAY_MS + 30, f); expect(f.engagements[0]?.terminalTick).toBe(3);
    bites.update(f); expect(bites.pose(0, 1)).not.toBeNull();
    pb.sample(400 + RENDER_DELAY_MS, f); expect(f.engagements).toEqual([]);
    pb.push({ tick: 5, ants: all, full, events: [] }, 500);
    pb.sample(500 + RENDER_DELAY_MS, f); expect(f.engagements).toEqual([]);
  });
});
