/**
 * Flyers on the 2D board: a flyer has its own look on the ground (grounded or locked out),
 * flying and hovering; an airborne flyer is drawn up the screen from its position with its
 * shadow left there. Constructed stream messages, through live and recorded Playback, both in
 * memory and encoded and decoded as the live stream and a recording carry them, joining while
 * flyers are airborne and starting again from a later snapshot as a seek does; no match is simulated. The atlas is the Graphics it is baked from, read as draw instructions.
 */
import { describe, expect, it } from "vitest";
import { Texture, type Container, type Graphics, type Particle, type Renderer } from "pixi.js";
import {
  FLYER_STREAM_VERSION, SUB_TILE, decodeMessage, encodePublicMessage, encodeReplayMessage, type StreamAnts, type StreamFlyer,
  type StreamMessage,
} from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { Ants } from "../../web/src/ants.ts";
import { flyerOf } from "../../web/src/flyer-state.ts";
import { AIR_LIFT_2D_LENGTHS } from "../../web/src/flyer-lift.ts";
import { TeamView } from "../../web/src/team-view.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const full = decodeMessage(scale2Packets(1)[0]!).full!;
const ANT_PX = 20, TILE_PX = 10;
/** An airborne flyer's lift in tiles: AIR_LIFT_2D_LENGTHS ant lengths of ANT_PX at TILE_PX. */
const LIFT = AIR_LIFT_2D_LENGTHS * ANT_PX / TILE_PX;
/** The tick from which the cast's second set of states holds (flyerState). */
const CHANGE = 40;

type State = StreamFlyer["state"];
interface Cast { id: number; x: number; y: number; colony: 0 | 1; soldier?: true; flyer?: (tick: number) => State }
/**
 * A worker and a soldier beside flyers in every state; a far worker of colony 1 that colony 0 cannot see.
 * From CHANGE the grounded flyer takes off, the flyer flying stops to hover and the hoverer lands.
 */
const CAST: readonly Cast[] = [
  { id: 1, x: 70, y: 60, colony: 1 },
  { id: 2, x: 4, y: 4, colony: 0 },
  { id: 3, x: 6, y: 4, colony: 1, soldier: true },
  { id: 4, x: 8, y: 4, colony: 0, flyer: (t) => t < CHANGE ? "grounded" : "flying" },
  { id: 5, x: 10, y: 4, colony: 1, flyer: () => "lockedOut" },
  { id: 6, x: 4, y: 8, colony: 0, flyer: (t) => t < CHANGE ? "flying" : "hovering" },
  { id: 7, x: 10, y: 8, colony: 1, flyer: (t) => t < CHANGE ? "hovering" : "grounded" },
];
/** What each ant should look like at a tick. */
type Look = "worker" | "soldier" | "ground" | "flying" | "hovering";
function expected(tick: number): Map<number, Look> {
  return new Map(CAST.map((a) => {
    const state = a.flyer?.(tick);
    return [a.id, state === undefined ? (a.soldier ? "soldier" : "worker") : state === "flying" ? "flying" : state === "hovering" ? "hovering" : "ground"];
  }));
}

function castFlyer(a: Cast, tick: number): StreamFlyer | null {
  const state = a.flyer?.(tick);
  if (state === undefined) return null;
  if (state === "lockedOut") return { state, takeOffTick: tick + 20 };
  if (state === "flying" || state === "hovering") return { state, destX: 30 * SUB_TILE, destY: 20 * SUB_TILE };
  return { state };
}

/** The cast at one tick; the airborne ants drift a little so playback interpolates them. */
function message(tick: number, snapshot: boolean, flyers = true): StreamMessage {
  const n = CAST.length;
  const drift = (a: Cast) => a.flyer?.(tick) === "flying" ? 0.05 * tick : 0;
  const ants: StreamAnts = {
    count: n, id: Uint32Array.from(CAST.map((a) => a.id)),
    x: Uint16Array.from(CAST.map((a) => Math.round((a.x + drift(a)) * SUB_TILE))),
    y: Uint16Array.from(CAST.map((a) => Math.round(a.y * SUB_TILE))),
    heading: new Uint8Array(n), colony: Uint8Array.from(CAST.map((a) => a.colony)), agent: new Int16Array(n).fill(-1),
    caste: Uint8Array.from(CAST.map((a) => (a.soldier ? 1 : 0))), carrying: new Uint8Array(n),
    ...(flyers ? { flyers: CAST.map((a) => castFlyer(a, tick)) } : {}),
  };
  return { tick, full: snapshot ? structuredClone(full) : null, ants, events: [] };
}

/** How a message reaches Playback: as built, or encoded as the live stream or a recording carries it and decoded. */
type Path = "in memory" | "live bytes" | "recorded bytes";
/** A flyer-bearing message on the wire is the flyer stream version; decoding gives back every ant's flyer state. */
function carry(m: StreamMessage, path: Path): StreamMessage {
  if (path === "in memory") return m;
  const bytes = path === "live bytes" ? encodePublicMessage(m) : encodeReplayMessage(m);
  expect(bytes[2]).toBe(FLYER_STREAM_VERSION);
  const decoded = decodeMessage(bytes);
  expect(decoded.ants.flyers).toEqual(m.ants.flyers);
  return decoded;
}

/** Messages from tick `from` to `to`, the first a full snapshot (a join, or where a seek starts again). */
function messages(from: number, to: number, path: Path = "in memory"): StreamMessage[] {
  return Array.from({ length: to - from + 1 }, (_, k) => carry(message(from + k, k === 0), path));
}

/** The textures of each look, and the board each ant is drawn on: which cells it uses and where. */
let holder: Container | null = null;
const renderer = { resolution: 1, generateTexture: (o: { target: Container }) => ((holder = o.target), Texture.WHITE) } as unknown as Renderer;

/** The atlas cell a texture was cut from: its origin, in drawing units. */
const cellOf = (t: Texture) => [t.frame.x - (t.trim?.x ?? 0), t.frame.y] as const;

/** Wing membranes drawn in one atlas cell: each wing's farthest point from the body's centre line and its rearmost x, relative to the cell. */
function wingsIn(x0: number, y0: number): { tipX: number; reach: number; minX: number }[] {
  const fl = holder!.children[4] as Graphics;
  type Ins = { action: string; data: { style: { color: number }; path: { shapePath: { shapePrimitives: { shape: { type: string; points?: number[] } }[] } } } };
  const wings: { tipX: number; reach: number; minX: number }[] = [];
  for (const ins of fl.context.instructions as unknown as Ins[]) {
    // The membrane colour (ants.ts WING).
    if (ins.action !== "fill" || ins.data.style.color !== 0xd6e9f5) continue;
    for (const { shape } of ins.data.path.shapePath.shapePrimitives) {
      const p = shape.points ?? [];
      if (p.length < 6) continue;
      const xs = p.filter((_, k) => k % 2 === 0), ys = p.filter((_, k) => k % 2 === 1);
      if (Math.min(...xs) < x0 || Math.max(...xs) > x0 + 64 || Math.min(...ys) < y0 || Math.max(...ys) > y0 + 48) continue;
      let far = 0;
      for (let k = 1; k < ys.length; k++) if (Math.abs(ys[k]! - y0 - 24) > Math.abs(ys[far]! - y0 - 24)) far = k;
      wings.push({ tipX: xs[far]! - x0, reach: Math.abs(ys[far]! - y0 - 24), minX: Math.min(...xs) - x0 });
    }
  }
  return wings;
}

/**
 * The look a texture's cell draws: no wings for a worker or soldier; wings folded along the body (within 8 units of
 * its centre line, back to the abdomen's end) on the ground; spread wide and swept back (tips behind the thorax,
 * x < 25) flying; spread wide and held straight out (every tip beside the thorax) hovering.
 */
function drawnLook(t: Texture): "wingless" | "ground" | "flying" | "hovering" | "unclear" {
  const wings = wingsIn(...cellOf(t));
  if (wings.length === 0) return "wingless";
  if (wings.every((w) => w.reach <= 8 && w.minX <= 10)) return "ground";
  if (wings.every((w) => w.reach >= 10)) {
    if (wings.every((w) => w.tipX < 25)) return "flying";
    if (wings.every((w) => w.tipX >= 25)) return "hovering";
  }
  return "unclear";
}

function sample(pb: Playback, nowMs: number, frame = new Frame()): Frame {
  expect(pb.sample(nowMs, frame)).toBe(true);
  return frame;
}

/** Checks one drawn frame against the cast's states at its tick; returns each look's textures. */
function check(ants: Ants, frame: Frame) {
  const want = expected(frame.tick);
  const bodies = ants.antLayer.particleChildren as Particle[];
  const shadows = ants.shadowLayer.particleChildren as Particle[];
  const textures = new Map<Look, Set<Texture>>();
  const airborne: number[] = [];
  for (let i = 0; i < frame.count; i++) {
    const look = want.get(frame.id[i]!)!;
    const p = bodies[i]!;
    const gx = frame.drawX?.[i] ?? frame.x[i]!, gy = frame.drawY?.[i] ?? frame.y[i]!;
    const lifted = look === "flying" || look === "hovering";
    expect(drawnLook(p.texture), `ant ${frame.id[i]} at tick ${frame.tick}`).toBe(look === "worker" || look === "soldier" ? "wingless" : look);
    expect(p.x).toBeCloseTo(gx, 5);
    expect(p.y).toBeCloseTo(lifted ? gy - LIFT : gy, 5);
    if (lifted) airborne.push(i);
    if (!textures.has(look)) textures.set(look, new Set());
    textures.get(look)!.add(p.texture);
  }
  // One shadow for each airborne flyer, on the ground at its position and facing its way.
  expect(shadows.length).toBe(airborne.length);
  airborne.forEach((i, k) => {
    const gx = frame.drawX?.[i] ?? frame.x[i]!, gy = frame.drawY?.[i] ?? frame.y[i]!;
    expect([shadows[k]!.x, shadows[k]!.y, shadows[k]!.rotation]).toEqual([
      expect.closeTo(gx, 5), expect.closeTo(gy, 5), expect.closeTo(bodies[i]!.rotation, 5)]);
    expect(shadows[k]!.alpha).toBe(bodies[i]!.alpha);
  });
  return textures;
}

describe("flyers on the 2D board", () => {
  for (const [mode, path] of [["live", "in memory"], ["recorded", "in memory"], ["live", "live bytes"], ["recorded", "recorded bytes"]] as const) {
    it(`${mode}, ${path}: tells landed, flying and hovering flyers apart from the first frame of a join while flyers are airborne, and follows each change of state`, () => {
      const pb = new Playback({ live: mode === "live" });
      const ants = new Ants(renderer, ANT_PX, TILE_PX);
      const rows = messages(0, 80, path);
      let first: Frame | null = null;
      const seen = new Set<string>();
      for (const m of rows) {
        pb.push(m, m.tick * TICK_MS);
        const f = new Frame();
        if (!pb.sample(m.tick * TICK_MS, f)) continue;
        ants.update(f);
        const textures = check(ants, f);
        for (const look of textures.keys()) seen.add(`${look}:${f.tick < CHANGE ? "before" : "after"}`);
        first ??= f;
      }
      // The first frame drawn is of the snapshot the viewer joined on, flyers already in the air.
      expect(first?.tick).toBe(0);
      for (const look of ["worker", "soldier", "ground", "flying", "hovering"]) {
        expect(seen.has(`${look}:before`)).toBe(true);
        expect(seen.has(`${look}:after`)).toBe(true);
      }
    });

    it(`${mode}, ${path}: starting again from a later snapshot, as a seek does, draws the states of that moment`, () => {
      for (const from of [10, CHANGE + 5]) {
        const pb = new Playback({ live: mode === "live" });
        const ants = new Ants(renderer, ANT_PX, TILE_PX);
        for (const m of messages(from, from + 30, path)) pb.push(m, m.tick * TICK_MS);
        // The first frame drawn after the seek is of its own snapshot (live: once the buffer fills).
        const f = sample(pb, mode === "live" ? (from + 30) * TICK_MS : from * TICK_MS + RENDER_DELAY_MS);
        expect(f.tick).toBe(from);
        ants.update(f);
        check(ants, f);
        const g = sample(pb, (from + 30) * TICK_MS + 60_000);
        ants.update(g);
        check(ants, g);
      }
    });
  }

  it("draws each look from its own cells: flyers never from a worker's or soldier's, flying never as hovering", () => {
    const ants = new Ants(renderer, ANT_PX, TILE_PX);
    const looks = new Map<Look, Set<Texture>>();
    for (const tick of [5, CHANGE + 5]) {
      const pb = new Playback();
      for (const m of messages(0, CHANGE + 10)) pb.push(m, m.tick * TICK_MS);
      const f = sample(pb, tick * TICK_MS + RENDER_DELAY_MS);
      ants.update(f);
      for (const [look, set] of check(ants, f)) for (const t of set) (looks.get(look) ?? looks.set(look, new Set()).get(look)!).add(t);
    }
    const all = [...looks.keys()];
    expect(all.sort()).toEqual(["flying", "ground", "hovering", "soldier", "worker"]);
    for (const a of all) for (const b of all) if (a !== b) {
      for (const t of looks.get(a)!) expect(looks.get(b)!.has(t), `${a} shares a texture with ${b}`).toBe(false);
    }
  });

  it("draws workers and soldiers exactly as a message without flyers draws them", () => {
    const pb = new Playback(), plain = new Playback();
    for (const m of messages(0, 30)) {
      pb.push(m, m.tick * TICK_MS);
      plain.push(message(m.tick, m.full !== null, false), m.tick * TICK_MS);
    }
    const f = sample(pb, 20 * TICK_MS + RENDER_DELAY_MS), g = sample(plain, 20 * TICK_MS + RENDER_DELAY_MS);
    const a = new Ants(renderer, ANT_PX, TILE_PX), b = new Ants(renderer, ANT_PX, TILE_PX);
    a.update(f); b.update(g);
    expect(b.shadowLayer.particleChildren.length).toBe(0);
    const want = expected(f.tick);
    for (let i = 0; i < f.count; i++) {
      if (!["worker", "soldier"].includes(want.get(f.id[i]!)!)) continue;
      const p = (a.antLayer.particleChildren as Particle[])[i]!, q = (b.antLayer.particleChildren as Particle[])[i]!;
      expect([cellOf(p.texture), p.x, p.y, p.rotation, p.tint, p.alpha]).toEqual([cellOf(q.texture), q.x, q.y, q.rotation, q.tint, q.alpha]);
    }
  });

  it("finds each ant's flyer state by id in one colony's view, which leaves out the ants it cannot see", () => {
    const pb = new Playback();
    for (const m of messages(0, 30)) pb.push(m, m.tick * TICK_MS);
    const f = sample(pb, 20 * TICK_MS + RENDER_DELAY_MS);
    const view = new TeamView();
    view.choice = 0;
    const out = view.apply(f);
    // The far colony-1 worker, first in id order, is out of colony 0's sight: every later ant moves up one place.
    expect(out.count).toBe(f.count - 1);
    expect([...out.id.subarray(0, out.count)]).not.toContain(1);
    for (let i = 0; i < out.count; i++) expect(flyerOf(out, i)).toEqual(castFlyer(CAST.find((a) => a.id === out.id[i])!, f.tick));
    const ants = new Ants(renderer, ANT_PX, TILE_PX);
    ants.update(out);
    check(ants, out);
  });

  it("keeps a biting flyer's look and lift: its body and head are both drawn up the screen from its position", () => {
    // The flyer flying (colony 0) bites the hoverer (colony 1) beside it, each tick, in the air.
    const fight = (tick: number): StreamMessage => {
      const m = message(tick, tick === 0);
      const i = CAST.findIndex((a) => a.id === 6), j = CAST.findIndex((a) => a.id === 7);
      m.ants.x[i] = m.ants.x[j]! - SUB_TILE;
      m.ants.y[i] = m.ants.y[j]!;
      m.events = [{ kind: "fight", antId: 6, targetId: 7, colony: 0, tileX: Math.floor(m.ants.x[j]! / SUB_TILE), tileY: Math.floor(m.ants.y[j]! / SUB_TILE) }];
      return m;
    };
    const pb = new Playback();
    for (let t = 0; t < 30; t++) pb.push(fight(t), t * TICK_MS);
    const ants = new Ants(renderer, ANT_PX, TILE_PX);
    let posed = 0;
    for (let at = 5 * TICK_MS; at < 25 * TICK_MS; at += 20) {
      const f = sample(pb, at + RENDER_DELAY_MS);
      ants.update(f);
      const i = [...f.id.subarray(0, f.count)].indexOf(6);
      const drawn = ants.antLayer.particleChildren as Particle[];
      const body = drawn[i]!, head = drawn[f.count + i]!;
      expect(drawnLook(body.texture)).toBe("flying");
      if (head.alpha === 0) continue;
      posed++;
      // The head piece is cut from a flyer's flying bite cell, beside its body piece.
      const [bx, by] = cellOf(body.texture), [hx, hy] = cellOf(head.texture);
      expect([hx, hy]).toEqual([bx, by]);
      const shadow = (ants.shadowLayer.particleChildren as Particle[]).find((s) => Math.abs(s.x - body.x) < 1e-6);
      expect(shadow).toBeDefined();
      expect(body.y).toBeCloseTo(shadow!.y - LIFT, 5);
      expect(head.y).toBeLessThan(shadow!.y - LIFT / 2);
    }
    expect(posed).toBeGreaterThan(0);
  });
});
