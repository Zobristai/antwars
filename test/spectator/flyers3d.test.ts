/**
 * The 3D board's flyers: each flyer is drawn in the herd of its state, landed (grounded or locked out) on the ground,
 * flying and hovering raised by the shared air lift over a shadow disc, in live and recorded playback, after a seek,
 * on joining while flyers are airborne, and in a one-colony view. Constructed stream messages, never a simulation.
 * NullEngine proves herd membership and placement; it does not prove pixels.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { decodeMessage, SUB_TILE, type StreamFlyer, type StreamMessage } from "../../src/live/format.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { AIR_LIFT_3D_TILES } from "../../web/src/flyer-lift.ts";
import { flyerOf } from "../../web/src/flyer-state.ts";
import { Ants3D, buildAntGeometry, type WingPose } from "../../web/src/board3d/ants3d.ts";
import { COLONY_RGB, Ground } from "../../web/src/board3d/ground.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const seed = decodeMessage(scale2Packets(1)[0]!).full!;
const { mapW, mapH } = seed.setup;
const TICKS = 40;

let engine: NullEngine, scene: Scene, ground: Ground;
beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); ground = new Ground(scene, mapW, mapH); });
afterEach(() => { scene.dispose(); engine.dispose(); });

type State = StreamFlyer["state"] | "worker" | "soldier";
interface Actor { id: number; colony: 0 | 1; at(tick: number): { x: number; y: number; state: State } }

// Colony 0 near its queen, colony 1 across the map, out of each other's sight. Ids interleave the colonies.
const ACTORS: Actor[] = [
  { id: 1, colony: 0, at: (t) => ({ x: 20 + t * 0.05, y: 45, state: "worker" }) },
  { id: 2, colony: 1, at: () => ({ x: 104, y: 45, state: "soldier" }) },
  // Takes off, flies, hovers, lands and is locked out, then is grounded again.
  { id: 3, colony: 0, at: (t) => ({ x: 22 + Math.min(Math.max(t - 5, 0), 10) * 0.4, y: 50,
    state: t < 5 ? "grounded" : t < 15 ? "flying" : t < 25 ? "hovering" : t < 30 ? "lockedOut" : "grounded" }) },
  { id: 4, colony: 1, at: (t) => ({ x: 100 - t * 0.3, y: 50, state: "flying" }) },
  { id: 5, colony: 1, at: () => ({ x: 106, y: 52, state: "hovering" }) },
  { id: 6, colony: 0, at: (t) => ({ x: 18, y: 52 + t * 0.1, state: "flying" }) },
];

function message(tick: number, full: boolean): StreamMessage {
  const rows = ACTORS.map((a) => ({ a, ...a.at(tick) }));
  const flyers = rows.map((r): StreamFlyer | null => {
    if (r.state === "worker" || r.state === "soldier") return null;
    if (r.state === "lockedOut") return { state: r.state, takeOffTick: 30 };
    if (r.state === "grounded") return { state: r.state };
    return { state: r.state, destX: 30 * SUB_TILE, destY: 50 * SUB_TILE };
  });
  return {
    tick, full: full ? structuredClone(seed) : null, events: [],
    ants: {
      count: rows.length, id: Uint32Array.from(rows.map((r) => r.a.id)),
      x: Uint16Array.from(rows.map((r) => Math.round(r.x * SUB_TILE))), y: Uint16Array.from(rows.map((r) => Math.round(r.y * SUB_TILE))),
      heading: new Uint8Array(rows.length), colony: Uint8Array.from(rows.map((r) => r.a.colony)), agent: new Int16Array(rows.length).fill(-1),
      caste: Uint8Array.from(rows.map((r) => (r.state === "soldier" ? 1 : 0))), carrying: new Uint8Array(rows.length), flyers,
    },
  };
}

const HERD: Record<State, string> = { worker: "ants", soldier: "soldiers", grounded: "flyers-landed", lockedOut: "flyers-landed",
  flying: "flyers-flying", hovering: "flyers-hovering" };
const NAMES = ["ants0", "ants1", "soldiers0", "soldiers1", "flyers-landed0", "flyers-landed1", "flyers-flying0", "flyers-flying1",
  "flyers-hovering0", "flyers-hovering1"];

function mesh(name: string): Mesh {
  const found = scene.getMeshByName(name);
  expect(found, name).toBeInstanceOf(Mesh);
  return found as Mesh;
}

/** Each drawn instance's translation: x, body height above the ground there, tile y. */
function drawn(name: string): { x: number; lift: number; y: number }[] {
  const m = mesh(name);
  if (m.thinInstanceCount === 0) return [];
  return m.thinInstanceGetWorldMatrices().slice(0, m.thinInstanceCount).map((w) => {
    const [x, h, z] = [w.m[12]!, w.m[13]!, w.m[14]!];
    return { x, lift: h - ground.heightAt(x, mapH - z), y: mapH - z };
  });
}

/** What the herds should hold for these ants: count per herd, and every airborne one raised over a shadow. */
function expectDrawn(ants: readonly { colony: number; state: State }[]): void {
  const want = new Map<string, number>(NAMES.map((n) => [n, 0]));
  for (const a of ants) want.set(`${HERD[a.state]}${a.colony}`, want.get(`${HERD[a.state]}${a.colony}`)! + 1);
  for (const name of NAMES) {
    expect(mesh(name).thinInstanceCount, name).toBe(want.get(name));
    expect(mesh(name).isEnabled(), `${name} enabled`).toBe(want.get(name)! > 0);
    const lift = name.startsWith("flyers-flying") || name.startsWith("flyers-hovering") ? AIR_LIFT_3D_TILES : 0.02;
    for (const d of drawn(name)) expect(d.lift, `${name} height`).toBeCloseTo(lift, 4);
  }
  const airborne = ants.filter((a) => a.state === "flying" || a.state === "hovering").length;
  expect(mesh("flyer-shadows").thinInstanceCount).toBe(airborne);
  for (const d of drawn("flyer-shadows")) expect(d.lift).toBeCloseTo(0.03, 4);
}

const expected = (tick: number, colony?: 0 | 1) =>
  ACTORS.filter((a) => colony === undefined || a.colony === colony).map((a) => ({ colony: a.colony, state: a.at(tick).state }));

/** Pushes ticks from..TICKS-1, the first a full snapshot (a join or a seek), all arriving at once. */
function feed(pb: Playback, from: number): void {
  for (let t = from; t < TICKS; t++) pb.push(message(t, t === from), from * 100);
}

describe("3D flyer bodies", () => {
  it("draws each flyer in its state's herd through recorded playback, raised only while airborne", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const pb = new Playback(), frame = new Frame();
    feed(pb, 0);
    const seen = new Set<State>();
    for (let t = 0; t < TICKS - 1; t++) {
      expect(pb.sample(t * 100 + 50 + RENDER_DELAY_MS, frame)).toBe(true);
      ants.update(frame);
      expectDrawn(expected(frame.tick));
      for (const a of expected(frame.tick)) seen.add(a.state);
    }
    expect([...seen].sort()).toEqual(["flying", "grounded", "hovering", "lockedOut", "soldier", "worker"]);
  });

  it("draws the same in live playback, whatever tick the live clock shows", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const pb = new Playback({ live: true }), frame = new Frame();
    feed(pb, 0);
    let drawnTicks = 0;
    for (let ms = 0; ms <= TICKS * 100 + 2000; ms += 70) {
      if (!pb.sample(ms, frame) || frame.count === 0) continue;
      ants.update(frame);
      expectDrawn(expected(frame.tick));
      drawnTicks++;
    }
    expect(drawnTicks).toBeGreaterThan(20);
  });

  it("shows flyers already airborne on joining a live match and right after a replay seek", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    // Draw some of the match first, so the seek reuses a board that has already drawn these ants on the ground.
    let pb = new Playback(), frame = new Frame();
    feed(pb, 0);
    for (let t = 0; t < 4; t++) { pb.sample(t * 100 + RENDER_DELAY_MS, frame); ants.update(frame); }
    expectDrawn(expected(frame.tick));
    // A seek: a fresh Playback and Frame from a snapshot at tick 18, where flyer 3 hovers.
    pb = new Playback(); frame = new Frame();
    feed(pb, 18);
    expect(pb.sample(18 * 100 + RENDER_DELAY_MS, frame)).toBe(true);
    ants.update(frame);
    expect(frame.tick).toBe(18);
    expectDrawn(expected(18));
    expect(mesh("flyers-hovering0").thinInstanceCount).toBe(1);
    // A join: the first message the live page gets is a snapshot at tick 8, with flyer 3 in flight.
    const live = new Playback({ live: true }), joined = new Frame();
    feed(live, 8);
    let first: number | null = null;
    for (let ms = 800; first === null && ms < 8000; ms += 50) {
      if (live.sample(ms, joined) && joined.count > 0) { ants.update(joined); first = joined.tick; }
    }
    expect(first).not.toBeNull();
    expectDrawn(expected(first!));
    expect(expected(first!).find((a) => a.colony === 0 && a.state === "flying")).toBeTruthy();
    expect(mesh("flyers-flying0").thinInstanceCount).toBe(2);
  });

  it("reads each flyer's state by its id in a one-colony view, which drops ants out of sight", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const pb = new Playback(), frame = new Frame(), view = new TeamView();
    feed(pb, 0);
    view.choice = 0;
    for (const t of [2, 10, 20, 27, 35]) {
      expect(pb.sample(t * 100 + RENDER_DELAY_MS, frame)).toBe(true);
      const shown = view.apply(frame);
      expect(shown.count).toBe(3);
      expect(shown.ants!.count).toBe(6);
      for (let i = 0; i < shown.count; i++) {
        const actor = ACTORS.find((a) => a.id === shown.id[i])!;
        const state = actor.at(t).state;
        expect(flyerOf(shown, i)?.state ?? null, `ant ${actor.id} at ${t}`).toBe(state === "worker" || state === "soldier" ? null : state);
      }
      ants.update(shown);
      expectDrawn(expected(t, 0));
    }
  });

  it("draws a flyer-free frame with the worker and soldier herds only", () => {
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    const m = message(3, true);
    delete m.ants.flyers;
    m.ants.caste = Uint8Array.from([0, 1, 0, 0, 0, 0]);
    const pb = new Playback(), frame = new Frame();
    pb.push(m, 0);
    expect(pb.sample(RENDER_DELAY_MS + 300, frame)).toBe(true);
    ants.update(frame);
    expectDrawn([{ colony: 0, state: "worker" }, { colony: 1, state: "soldier" }, { colony: 0, state: "worker" },
      { colony: 1, state: "worker" }, { colony: 1, state: "worker" }, { colony: 0, state: "worker" }]);
  });

  it("gives landed, flying and hovering flyers wings of their own outline, a worker none", () => {
    const extent = (wings: WingPose | null) => {
      const p = buildAntGeometry(scene, COLONY_RGB[0]!, false, 4, false, 3, wings).positions!;
      let span = 0, top = 0;
      for (let i = 0; i < p.length; i += 3) { span = Math.max(span, Math.abs(p[i + 2]!)); top = Math.max(top, p[i + 1]!); }
      return { vertices: p.length / 3, span, top };
    };
    const worker = extent(null), landed = extent("folded"), flying = extent("swept"), hovering = extent("spread");
    for (const flyer of [landed, flying, hovering]) expect(flyer.vertices).toBeGreaterThan(worker.vertices);
    // Folded: within the worker's width, over its back. Swept: raised highest. Spread: widest by far.
    expect(landed.span).toBeLessThanOrEqual(worker.span);
    expect(landed.top).toBeGreaterThan(worker.top);
    expect(flying.top).toBeGreaterThan(landed.top + 0.1);
    expect(hovering.span).toBeGreaterThan(flying.span + 0.1);
    expect(hovering.span).toBeGreaterThan(worker.span + 0.1);
    // Each herd draws its own pose; the wing colour appears on every flyer herd and no worker's.
    const ants = new Ants3D(scene, ground, 0.5, COLONY_RGB);
    expect(ants.casters.map((h) => h.name)).toEqual(["ants0", "ants1", "soldiers0", "soldiers1"]);
    const pale = (name: string) => {
      const c = mesh(name).getVerticesData(VertexBuffer.ColorKind)!;
      for (let i = 0; i < c.length; i += 4) if (c[i]! > 0.89 && c[i + 1]! > 0.94 && c[i + 2]! > 0.99) return true;
      return false;
    };
    for (const name of NAMES) expect(pale(name), name).toBe(name.startsWith("flyers"));
  });
});
