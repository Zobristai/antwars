/**
 * Flyers' take-offs and landings show as moments where they happen, on the delayed clock: in recorded playback, in live
 * (worker-prepared) playback at the same playback time, after a seek (a fresh playback fed from the start, as a replay
 * seek is) and when joining while flyers are already airborne; a colony's view keeps its own moments and the ones it sees.
 * The 2D board draws each as a ring (and a take-off's dot) on the ground at the point, and the 3D board the same shape
 * as ground meshes; NullEngine and Pixi's recorded drawing instructions show what each draws headlessly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Graphics } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { SUB_TILE, type StreamAnts, type StreamEvent, type StreamFlyer, type StreamFull, type StreamMessage, type StreamSetup } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { FLIGHT_MOMENT_MS, Frame, Playback, RENDER_DELAY_MS, TickPreparation, type Flight, type StreamFlightEvent } from "../../web/src/buffer.ts";
import { FLIGHT_RING, FlightMoments, flightMoment, flightTint } from "../../web/src/effects.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { FlightMoments3D } from "../../web/src/board3d/effects3d.ts";
import { Ground } from "../../web/src/board3d/ground.ts";

/** Every stream plays at grid scale 2: the scene is laid out in original tiles and placed at t(tile) fine tiles. */
const t = (tile: number) => tile * 2;
const W = t(40), H = t(20);
const sub = (tile: number) => tile * SUB_TILE + SUB_TILE / 2;
const setup = { mapW: W, mapH: H, gridScale: 2, ticksPerSecond: 10, matchTicks: 7200, idleTicks: 300, overrunRadiusTiles: 2,
  queens: [[sub(t(2)), sub(t(5))], [sub(t(38)), sub(t(5))]] } as StreamSetup;
const full = (): StreamFull => ({ match: 7, setup, territory: new Uint8Array(W * H), marks: [], agents: [], overrun: [0, 0], overrunRequired: 100, deaths: [0, 0], result: null });

/** Ant 1 (colony 0) is a flyer on the ground at join; ant 2 (colony 1) is a flyer already airborne at join; ant 3 is a worker. */
const ANT = { 1: [t(5), t(5)], 2: [t(30), t(5)], 3: [t(6), t(6)] } as const;
type State = StreamFlyer["state"];
function ants(one: State, two: State): StreamAnts {
  const flyer = (state: State): StreamFlyer => (state === "flying" ? { state, destX: sub(t(20)), destY: sub(t(10)) } : { state });
  return {
    count: 3,
    id: Uint32Array.from([1, 2, 3]),
    x: Uint16Array.from([sub(ANT[1][0]), sub(ANT[2][0]), sub(ANT[3][0])]),
    y: Uint16Array.from([sub(ANT[1][1]), sub(ANT[2][1]), sub(ANT[3][1])]),
    heading: new Uint8Array(3),
    colony: Uint8Array.from([0, 1, 0]),
    agent: Int16Array.from([-1, -1, -1]),
    flyers: [flyer(one), flyer(two), null],
  };
}

const TAKEOFF = 105, LANDING_2 = 112, LANDING_1 = 130, LAST = 150;
/** The agreed stream events, carried in messages as the stream will carry them. */
const flight = (e: StreamFlightEvent) => e as unknown as StreamEvent;
const takeoff = (antId: 1 | 2, colony: 0 | 1, at: readonly [number, number]) => flight({ kind: "takeoff", antId, colony, x: sub(at[0]), y: sub(at[1]) });
const landing = (antId: 1 | 2, colony: 0 | 1, at: readonly [number, number]) => flight({ kind: "landing", antId, colony, x: sub(at[0]), y: sub(at[1]) });

/** The match from join (tick 100) to LAST: ant 1 takes off at TAKEOFF and lands at LANDING_1; ant 2, airborne at join, lands at LANDING_2. */
function match(): StreamMessage[] {
  const out: StreamMessage[] = [];
  for (let tick = 100; tick <= LAST; tick++) {
    const one: State = tick < TAKEOFF ? "grounded" : tick < LANDING_1 ? "flying" : "lockedOut";
    const two: State = tick < LANDING_2 ? "flying" : "lockedOut";
    const events: StreamEvent[] = [];
    if (tick === TAKEOFF) events.push(takeoff(1, 0, ANT[1]));
    if (tick === LANDING_2) events.push(landing(2, 1, ANT[2]));
    if (tick === LANDING_1) events.push(landing(1, 0, [t(9), t(5)]));
    out.push({ tick, ants: ants(one, two), full: tick === 100 ? full() : null, events });
  }
  return out;
}

/** Recorded playback: every message arriving on time, sampled so playback shows exactly tick `at` (plus `extraMs`). */
function recordedAt(messages: readonly StreamMessage[], at: number, extraMs = 0): Frame {
  const p = new Playback();
  for (const m of messages) p.push(m, m.tick * TICK_MS);
  const f = new Frame();
  p.sample(at * TICK_MS + RENDER_DELAY_MS + extraMs, f);
  return f;
}

const moments = (f: Pick<Frame, "flights">) => f.flights.map((m) => `${m.kind} ${m.antId} @${m.x},${m.y} +${Math.round(m.ageMs)}`);
const at = (tile: readonly [number, number]) => `${tile[0] + 0.5},${tile[1] + 0.5}`;

describe("take-off and landing moments in playback", () => {
  const messages = match();

  it("shows each take-off and landing from the tick its message carries, at its ground point, for FLIGHT_MOMENT_MS", () => {
    const span = FLIGHT_MOMENT_MS / TICK_MS;
    expect(moments(recordedAt(messages, TAKEOFF - 1))).toEqual([]);
    expect(moments(recordedAt(messages, TAKEOFF))).toEqual([`takeoff 1 @${at(ANT[1])} +0`]);
    expect(moments(recordedAt(messages, TAKEOFF, 50))).toEqual([`takeoff 1 @${at(ANT[1])} +50`]);
    expect(moments(recordedAt(messages, LANDING_2))).toEqual([`takeoff 1 @${at(ANT[1])} +${(LANDING_2 - TAKEOFF) * TICK_MS}`, `landing 2 @${at(ANT[2])} +0`]);
    expect(moments(recordedAt(messages, TAKEOFF + span))).toEqual([`landing 2 @${at(ANT[2])} +${(TAKEOFF + span - LANDING_2) * TICK_MS}`]);
    expect(moments(recordedAt(messages, LANDING_2 + span))).toEqual([]);
    expect(moments(recordedAt(messages, LANDING_1 + 3))).toEqual([`landing 1 @${at([t(9), t(5)])} +300`]);
    expect(moments(recordedAt(messages, LANDING_1 + span))).toEqual([]);
    const f = recordedAt(messages, LANDING_1);
    expect(f.flights[0]).toEqual({ antId: 1, kind: "landing", colony: 0, x: t(9) + 0.5, y: t(5) + 0.5, ageMs: 0 } satisfies Flight);
  });

  it("joining while flyers are airborne shows no take-off for them, and their landings as they come", () => {
    // From the join to just before the first landing, the only moment is ant 1's own take-off, after the join.
    for (let tick = 100; tick < LANDING_2; tick++) expect(recordedAt(messages, tick).flights.every((m) => m.antId === 1 && m.kind === "takeoff")).toBe(true);
    // Joining later, with both flyers airborne (ant 1 since TAKEOFF): nothing is shown until a landing.
    const late = messages.slice(TAKEOFF + 10 - 100);
    late[0] = { ...late[0]!, full: full() };
    expect(moments(recordedAt(late, TAKEOFF + 10))).toEqual([]);
    expect(moments(recordedAt(late, LANDING_1))).toEqual([`landing 1 @${at([t(9), t(5)])} +0`]);
  });

  it("after a seek, a fresh playback fed from the start shows the moments continuous playback shows there", () => {
    for (const target of [TAKEOFF + 3, LANDING_2 + 2, LANDING_2 + 9, LANDING_1 + 4]) {
      const fed = messages.filter((m) => m.tick <= target);
      expect(moments(recordedAt(fed, target))).toEqual(moments(recordedAt(messages, target)));
    }
    expect(moments(recordedAt(messages.filter((m) => m.tick <= TAKEOFF + 3), TAKEOFF + 3))).toEqual([`takeoff 1 @${at(ANT[1])} +300`]);
  });

  it("a reconnect's full snapshot clears moments already shown, as it does fights", () => {
    const p = new Playback(), f = new Frame();
    for (const m of messages.filter((m) => m.tick <= TAKEOFF + 2)) p.push(m, m.tick * TICK_MS);
    p.push({ ...messages[TAKEOFF + 3 - 100]!, full: full() }, (TAKEOFF + 3) * TICK_MS);
    p.sample((TAKEOFF + 3) * TICK_MS + RENDER_DELAY_MS, f);
    expect(f.flights).toEqual([]);
  });

  it("live, worker-prepared playback shows the same moments as recorded playback at the same playback time", () => {
    const live = new Playback({ live: true }), worker = new TickPreparation();
    for (const m of messages) {
      // The worker's output crosses a structured clone to the page (intake.worker.ts).
      const prepared = worker.prepare(m);
      if (prepared) live.pushPrepared(structuredClone(prepared), m.tick * TICK_MS);
    }
    const recorded = new Playback();
    for (const m of messages) recorded.push(m, m.tick * TICK_MS);
    const a = new Frame(), b = new Frame();
    const seen = new Set<string>();
    for (let now = LAST * TICK_MS; now <= LAST * TICK_MS + 6000; now += 16) {
      if (!live.sample(now, a)) continue;
      recorded.sample(a.renderMs + RENDER_DELAY_MS, b);
      expect(b.renderMs).toBe(a.renderMs);
      expect(moments(a)).toEqual(moments(b));
      for (const m of a.flights) seen.add(`${m.kind} ${m.antId}`);
    }
    expect([...seen].sort()).toEqual(["landing 1", "landing 2", "takeoff 1"]);
  });

  it("a message with no take-off or landing leaves the frame's moments empty", () => {
    const quiet = messages.map((m) => ({ ...m, events: m.events.filter((e) => !["takeoff", "landing"].includes((e as { kind: string }).kind)) }));
    for (let tick = 100; tick <= LAST; tick++) expect(recordedAt(quiet, tick).flights).toEqual([]);
  });

  it("a colony's view keeps its own flyers' moments and the others' only where it sees", () => {
    const f = recordedAt(messages, LANDING_2);
    expect(moments(f).map((m) => m.split(" @")[0])).toEqual(["takeoff 1", "landing 2"]);
    const view = new TeamView();
    view.choice = 0;
    expect(view.apply(f).flights.map((m) => m.antId)).toEqual([1]);
    view.choice = 1;
    expect(view.apply(f).flights.map((m) => m.antId)).toEqual([2]);
    view.choice = "full";
    expect(view.apply(f).flights.map((m) => m.antId)).toEqual([1, 2]);
  });
});

describe("the moment's shape, shared by both boards", () => {
  const ages = Array.from({ length: 9 }, (_, i) => (i * FLIGHT_MOMENT_MS) / 8 - (i === 8 ? 1 : 0));

  it("a take-off's ring spreads out from its point and a landing's closes in on it, both fading out", () => {
    const up = ages.map((a) => flightMoment("takeoff", a, false));
    const down = ages.map((a) => flightMoment("landing", a, false));
    expect(up[0]).toEqual({ radius: FLIGHT_RING.near, ring: 0.9, dot: 0.9 });
    expect(down[0]).toEqual({ radius: FLIGHT_RING.far, ring: 0.9, dot: 0 });
    for (let i = 1; i < ages.length; i++) {
      expect(up[i]!.radius).toBeGreaterThan(up[i - 1]!.radius);
      expect(down[i]!.radius).toBeLessThan(down[i - 1]!.radius);
      expect(up[i]!.ring).toBeLessThan(up[i - 1]!.ring);
      expect(down[i]!.ring).toBeLessThan(down[i - 1]!.ring);
      expect(up[i]!.dot).toBeLessThan(up[i - 1]!.dot);
      expect(down[i]!.dot).toBe(0);
    }
    expect(up.at(-1)!.radius).toBeCloseTo(FLIGHT_RING.far, 1);
    expect(down.at(-1)!.radius).toBeCloseTo(FLIGHT_RING.near, 1);
    expect(up.at(-1)!.ring).toBeLessThan(0.01);
  });

  it("under reduced motion the ring stands still where its motion ends and only fades", () => {
    for (const a of ages) {
      expect(flightMoment("takeoff", a, true).radius).toBe(FLIGHT_RING.far);
      expect(flightMoment("landing", a, true).radius).toBe(FLIGHT_RING.near);
    }
    expect(flightMoment("takeoff", 400, true).ring).toBe(flightMoment("takeoff", 400, false).ring);
  });
});

type Shape = { type: string; x: number; y: number; radius: number };
type Ins = { action: string; data: { style: { alpha: number; width?: number; color?: number }; path: { shapePath: { shapePrimitives: { shape: Shape }[] } } } };

describe("the 2D board's moments", () => {
  const frameOf = (flights: Flight[]) => ({ flights }) as Pick<Frame, "flights">;

  it("draws each moment as an outlined ring at its point, in CSS px, with a dot for a take-off", () => {
    const tilePx = 10, layer = new FlightMoments(tilePx);
    layer.update(frameOf([
      { antId: 1, kind: "takeoff", colony: 0, x: 10.5, y: 10.5, ageMs: 200 },
      { antId: 2, kind: "landing", colony: 1, x: 60.5, y: 10.5, ageMs: 200 },
    ]), false);
    expect(layer.shown).toBe(2);
    const drawn = (layer.layer.context.instructions as unknown as Ins[]).flatMap((ins) =>
      ins.data.path.shapePath.shapePrimitives.map((p) => ({ action: ins.action, ...p.shape, width: ins.data.style.width, alpha: ins.data.style.alpha })));
    const up = flightMoment("takeoff", 200, false), down = flightMoment("landing", 200, false);
    const rings = drawn.filter((d) => d.action === "stroke" && d.radius > (FLIGHT_RING.dot + 1) / tilePx);
    expect(rings.map((d) => [d.x, d.y, +(d.radius * tilePx).toFixed(6)])).toEqual([
      [10.5, 10.5, +up.radius.toFixed(6)], [10.5, 10.5, +up.radius.toFixed(6)],
      [60.5, 10.5, +down.radius.toFixed(6)], [60.5, 10.5, +down.radius.toFixed(6)],
    ]);
    // A dark outline under a lighter ring in the colony's colour, 2 CSS px wide, at the moment's alpha.
    expect(rings.map((d) => [+(d.width! * tilePx).toFixed(6), d.alpha])).toEqual([[3.5, 0.5 * up.ring], [2, up.ring], [3.5, 0.5 * down.ring], [2, down.ring]]);
    const dots = drawn.filter((d) => d.action === "fill");
    expect(dots.map((d) => [d.x, d.y, +(d.radius * tilePx).toFixed(6), d.alpha])).toEqual([[10.5, 10.5, FLIGHT_RING.dot, up.dot]]);
  });

  it("draws nothing once a moment is over, and nothing for a frame without moments", () => {
    const layer = new FlightMoments(10);
    layer.update(frameOf([{ antId: 1, kind: "takeoff", colony: 0, x: 1, y: 1, ageMs: FLIGHT_MOMENT_MS }]), false);
    expect(layer.shown).toBe(0);
    expect(layer.layer.context.instructions).toHaveLength(0);
    layer.update(frameOf([]), false);
    expect(layer.layer.context.instructions).toHaveLength(0);
    expect(layer.layer).toBeInstanceOf(Graphics);
  });
});

describe("the 3D board's moments", () => {
  let engine: NullEngine, scene: Scene, ground: Ground;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    ground = new Ground(scene, W, H);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });
  const mesh = (name: string) => {
    const found = scene.getMeshByName(name);
    expect(found).toBeInstanceOf(Mesh);
    return found as Mesh;
  };

  it("places each moment's ring (and a take-off's dot) on the ground at its point, sized as the 2D board's in CSS px", () => {
    const moments3d = new FlightMoments3D(scene, ground), tilePx = 12;
    const flights: Flight[] = [
      { antId: 1, kind: "takeoff", colony: 0, x: 10.5, y: 10.5, ageMs: 300 },
      { antId: 2, kind: "landing", colony: 1, x: 60.5, y: 4.5, ageMs: 100 },
    ];
    moments3d.update({ flights }, tilePx, false);
    expect(moments3d.shown).toBe(2);
    const rings = mesh("flight-rings"), dots = mesh("flight-dots");
    expect(rings.thinInstanceCount).toBe(2);
    expect(rings.isEnabled()).toBe(true);
    expect(dots.thinInstanceCount).toBe(1);
    const matrices = rings.thinInstanceGetWorldMatrices();
    flights.forEach((f, i) => {
      const m = matrices[i]!.m, s = flightMoment(f.kind, f.ageMs, false);
      expect(m[0]).toBeCloseTo(s.radius / tilePx, 6);
      expect(m[12]).toBeCloseTo(f.x, 6);
      expect(m[13]).toBeCloseTo(ground.heightAt(f.x, f.y) + 0.06, 5);
      expect(m[14]).toBeCloseTo(H - f.y, 6);
    });
    // Each ring in its colony's moment colour, at its alpha.
    const colours = (rings as unknown as { _userThinInstanceBuffersStorage: { data: Record<string, Float32Array> } })._userThinInstanceBuffersStorage.data[VertexBuffer.ColorInstanceKind]!;
    flights.forEach((f, i) => {
      const tint = flightTint(f.colony);
      const expected = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, flightMoment(f.kind, f.ageMs, false).ring];
      expected.forEach((v, k) => expect(colours[i * 4 + k]).toBeCloseTo(v, 5));
    });
    expect(dots.thinInstanceGetWorldMatrices()[0]!.m[0]).toBeCloseTo(FLIGHT_RING.dot / tilePx, 6);
  });

  it("disables its meshes when no moment is showing, and follows the battles switch", () => {
    const moments3d = new FlightMoments3D(scene, ground);
    moments3d.update({ flights: [{ antId: 1, kind: "takeoff", colony: 0, x: 3, y: 3, ageMs: 10 }] }, 10, false);
    expect(mesh("flight-rings").isEnabled()).toBe(true);
    moments3d.update({ flights: [] }, 10, false);
    expect(mesh("flight-rings").thinInstanceCount).toBe(0);
    expect(mesh("flight-rings").isEnabled()).toBe(false);
    expect(mesh("flight-dots").isEnabled()).toBe(false);
    moments3d.setVisible(false);
    expect(mesh("flight-rings").isVisible).toBe(false);
    expect(mesh("flight-dots").isVisible).toBe(false);
  });
});
