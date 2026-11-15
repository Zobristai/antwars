/**
 * Fights between airborne flyers are drawn as air fights: an event-confirmed engagement whose two flyers are airborne,
 * on the live and the recorded route, including after a seek, when a pair's bite begun on the ground goes on after
 * both take off, and when joining during an air fight; both boards draw such a fight at the flyers' lifted height,
 * apart from ground fights, with no spark left on the ground beneath it, for as long as the pair stays engaged. The
 * stream names a bite only when it begins (the simulation's own events, from its combat step), so the fight outlasts
 * its event. The real route is exercised end to end: the spectator recorder's messages, encoded to their bytes, played
 * live, from a recording and by a joining viewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { decodeMessage, encodeMessage, encodeReplayMessage, SUB_TILE, type StreamAnts, type StreamFlyer, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState, type TickRecord } from "../../src/live/model.ts";
import { packMessages, TICK_MS } from "../../src/live/snapshot.ts";
import { resolveCombat } from "../../src/sim/combat.ts";
import { tileCentre } from "../../src/sim/geometry.ts";
import { buildGrid, cloneState } from "../../src/sim/map.ts";
import type { FlyerAir, SimEvent, SimState, StepOutput } from "../../src/sim/types.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { decodeData, ManualClock, RecordedServer, served } from "../live/helpers.ts";
import { HISTORICAL_CONFIG, addAnt, emptyMatch } from "../sim/fixtures.ts";
import { flyerOf, isAirborne } from "../../web/src/flyer-state.ts";
import { openRecording, type Recording } from "../../web/src/recording.ts";
import { FIGHT_EFFECT_MS, Frame, Playback, RENDER_DELAY_MS, TickPreparation, type Fight } from "../../web/src/buffer.ts";
import { Ants } from "../../web/src/ants.ts";
import { AIR_FIGHT, Battles, GROUND_SPARK } from "../../web/src/effects.ts";
import { BITE_CONTACT_END_MS, BITE_CONTACT_MS, BITE_MS, Bites, EngagementTracker, airFights } from "../../web/src/bite.ts";
import { AIR_LIFT_2D_LENGTHS, AIR_LIFT_3D_TILES } from "../../web/src/flyer-lift.ts";
import { AIR_RING_3D, Battles3D } from "../../web/src/board3d/effects3d.ts";
import { Ground } from "../../web/src/board3d/ground.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const full = scale2Packets(1).map(decodeMessage)[0]!.full!;
const TICKS = 30;
const byId = (a: number, b: number) => a - b;

/**
 * Two airborne flyers of opposing colonies (ids 1 and 2, flying and hovering) one tile apart, and two ground workers
 * (3 and 4) further along, on every tick. Each pair begins biting on tick 1 and goes on biting; the stream names those
 * bites on tick 1 only, as the simulation does. Tick 0 is a full snapshot.
 */
function messages(): StreamMessage[] {
  const flyers: (StreamFlyer | null)[] = [
    { state: "flying", destX: 14 * SUB_TILE, destY: 10 * SUB_TILE },
    { state: "hovering", destX: 10 * SUB_TILE, destY: 11 * SUB_TILE },
    null, null,
  ];
  return Array.from({ length: TICKS }, (_, tick): StreamMessage => ({
    tick,
    full: tick === 0 ? structuredClone(full) : null,
    events: tick !== 1 ? [] : [
      { kind: "fight", antId: 1, targetId: 2, colony: 0, tileX: 10, tileY: 10, air: true },
      { kind: "fight", antId: 2, targetId: 1, colony: 1, tileX: 10, tileY: 11, air: true },
      { kind: "fight", antId: 3, targetId: 4, colony: 0, tileX: 20, tileY: 10 },
      { kind: "fight", antId: 4, targetId: 3, colony: 1, tileX: 20, tileY: 11 },
    ],
    ants: {
      count: 4, id: Uint32Array.from([1, 2, 3, 4]),
      x: Uint16Array.from([10, 10, 20, 20].map((t) => (t + 0.5) * SUB_TILE)),
      y: Uint16Array.from([10, 11, 10, 11].map((t) => (t + 0.5) * SUB_TILE)),
      heading: Uint8Array.from([64, 192, 64, 192]), colony: Uint8Array.from([0, 1, 0, 1]),
      agent: new Int16Array(4).fill(-1), caste: new Uint8Array(4), carrying: new Uint8Array(4),
      flyers: structuredClone(flyers),
    },
  }));
}

/** The bites of the flyer pair and of the ground pair are both sampled as fights. */
function expectFights(frame: Frame, flyers: readonly number[] = [1, 2]) {
  const isAirPair = (f: Fight) => flyers.includes(f.a) && flyers.includes(f.b);
  expect(frame.fights.some(isAirPair)).toBe(true);
  expect(frame.fights.some((f) => !isAirPair(f))).toBe(true);
}

/** The frame's air fights are exactly these pairs; each ground pair, when named, is engaged and is no air fight. */
function expectAirFights(frame: Frame, air: readonly (readonly number[])[] = [[1, 2]], ground: readonly (readonly number[])[] = [[3, 4]]) {
  const key = (ids: readonly number[]) => [...ids].sort(byId).join(":");
  expect([...airFights(frame).values()].map((f) => key([f.a, f.b])).sort()).toEqual(air.map(key).sort());
  for (const ids of [...air, ...ground]) expect(frame.engagements.some((e) => ids.includes(e.a) && ids.includes(e.b))).toBe(true);
}

describe("air bites in sampled fights and engagements", () => {
  it("recorded playback: the air bites stay air fights, and the air fight lasts as long as the pair stays engaged", () => {
    const pb = new Playback(), frame = new Frame();
    for (const m of messages()) pb.push(m, m.tick * TICK_MS);
    for (const tick of [1, 5]) {
      expect(pb.sample(tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
      expectFights(frame);
      expectAirFights(frame);
    }
    // Long after the bites' own effect, with no event since: still an air fight, still engaged.
    for (const tick of [15, 25]) {
      expect(tick * TICK_MS - TICK_MS).toBeGreaterThan(FIGHT_EFFECT_MS);
      expect(pb.sample(tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
      expect(frame.fights).toEqual([]);
      expectAirFights(frame);
    }
  });

  it("live playback (prepared off the page thread) carries the same air fight", () => {
    const live = new Playback({ live: true }), prepare = new TickPreparation(), frame = new Frame();
    const rows = messages();
    for (const m of rows) live.pushPrepared(prepare.prepare(m)!, m.tick * TICK_MS);
    const arrived = rows.at(-1)!.tick * TICK_MS;
    expect(live.sample(arrived, frame)).toBe(true);
    expect(live.sample(arrived + 1200, frame)).toBe(true);
    expect(frame.tick * TICK_MS - TICK_MS).toBeGreaterThan(FIGHT_EFFECT_MS);
    expectAirFights(frame);
  });

  it("a seek shows the same air fight as watching throughout", () => {
    const rows = messages(), at = 20 * TICK_MS + 40;
    // Watched throughout: each message arrives in turn and is drawn up to the target time.
    const watched = new Playback(), watchedFrame = new Frame();
    for (const m of rows.filter((r) => r.tick <= 21)) { watched.push(m, m.tick * TICK_MS); watched.sample(Math.min(m.tick * TICK_MS, at) + RENDER_DELAY_MS, watchedFrame); }
    expect(watched.sample(at + RENDER_DELAY_MS, watchedFrame)).toBe(true);
    // A seek: a fresh player fed every message up to the target at once.
    const sought = new Playback(), soughtFrame = new Frame();
    for (const m of rows) sought.push(m, m.tick * TICK_MS);
    expect(sought.sample(at + RENDER_DELAY_MS, soughtFrame)).toBe(true);
    expect(soughtFrame.engagements).toEqual(watchedFrame.engagements);
    expect([...airFights(soughtFrame)]).toEqual([...airFights(watchedFrame)]);
    expectAirFights(soughtFrame);
  });
});

/**
 * Real stream match length in messages, the step on which the second pair of flyers takes off, and the step on which
 * every pair is parted and stops biting.
 */
const MATCH_TICKS = 40, TAKE_OFF = 8, BITES_UNTIL = 30;

/**
 * A match as the hub records it. Two flyers of opposing colonies hover over neighbouring tiles; two more stand on
 * neighbouring tiles and take off together on TAKE_OFF to hover where they stood; two ground workers stand further along.
 * Each pair is in reach of itself only. The simulation's combat step runs every step: each ant bites its enemy on every
 * step and names the bite only when it begins, so the second flyer pair's bite, begun on the ground, goes on in the air
 * with no new event. On BITES_UNTIL the second of each pair is moved ten tiles away, out of reach, and the biting stops.
 * The spectator recorder turns each step into the message the live stream sends and a recording stores; each is encoded
 * to its bytes. The steps themselves are kept, for pushing the match into the live hub.
 */
function streamedMatch() {
  const initial: SimState = emptyMatch(0, { ...HISTORICAL_CONFIG, combatGraceTicks: 0 });
  const hover = (tx: number, ty: number): FlyerAir => ({ destX: tileCentre(tx), destY: tileCentre(ty), hovering: true, released: false });
  // Enough HP that nobody dies in the match.
  const hp = 1_000_000;
  const flyerA = addAnt(initial, 0, 10, 10, { flyer: true, air: hover(10, 10), hp });
  const flyerB = addAnt(initial, 1, 10, 11, { flyer: true, air: hover(10, 11), hp });
  const workerA = addAnt(initial, 0, 20, 10, { hp }), workerB = addAnt(initial, 1, 20, 11, { hp });
  const riserA = addAnt(initial, 0, 30, 10, { flyer: true, hp }), riserB = addAnt(initial, 1, 30, 11, { flyer: true, hp });
  const everyone = [flyerA, flyerB, workerA, workerB, riserA, riserB];
  const recorder = new SpectatorRecorder(initial);
  const opening: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  const records: TickRecord[] = [], hpAfter: number[][] = [], steps: StepOutput[] = [];
  let state = initial;
  for (let t = 0; t < MATCH_TICKS - 1; t++) {
    state = cloneState(state);
    const ant = (id: number) => state.ants.find((a) => a.id === id)!;
    const events: SimEvent[] = [];
    if (t === TAKE_OFF) {
      for (const [r, ty] of [[riserA, 10], [riserB, 11]] as const) {
        ant(r.id).air = hover(30, ty);
        events.push({ type: "flyer_takeoff", tick: t, antId: r.id, colony: r.colony, tileX: 30, tileY: ty });
      }
    }
    if (t === BITES_UNTIL) {
      ant(flyerB.id).y = tileCentre(21); ant(flyerB.id).air = hover(10, 21);
      ant(workerB.id).y = tileCentre(21);
      ant(riserB.id).y = tileCentre(21); ant(riserB.id).air = hover(30, 21);
    }
    resolveCombat(state, buildGrid(state), t, events);
    state.tick = t + 1;
    steps.push({ state, events, results: [] });
    records.push(recorder.record(steps.at(-1)!));
    hpAfter.push(everyone.map((a) => ant(a.id).hp));
  }
  const deltas = records.map((r) => encodeMessage({ ...r, full: null }));
  return {
    initial, steps, opening, deltas, packets: [encodeReplayMessage(opening), ...deltas], hpAfter,
    flyers: [flyerA.id, flyerB.id], ground: [workerA.id, workerB.id], risers: [riserA.id, riserB.id],
    width: initial.config.mapWidth, height: initial.config.mapHeight,
  };
}

/** The flyers' sampled flyer state, looked up by ant id as the boards do. */
function flyerStates(frame: Frame, ids: readonly number[]) {
  return ids.map((id) => {
    const i = Array.from(frame.id.subarray(0, frame.count)).indexOf(id);
    return i < 0 ? null : flyerOf(frame, i);
  });
}

describe("air fights through the real stream: simulation, recorder, bytes, playback, both boards", () => {
  const match = streamedMatch();
  const active: Recording[] = [];
  afterEach(() => { for (const r of active.splice(0)) r.close(); });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const airborne = (frame: Frame, ids: readonly number[]) => flyerStates(frame, ids).map((f) => f !== null && isAirborne(f));
  /**
   * What a frame at this tick must show once the bites have begun (on the first step, in the message of tick 1): the
   * first flyer pair fighting in the air, the second on the ground until it has taken off, then in the air.
   */
  const expectAt = (frame: Frame) => {
    if (frame.tick >= TAKE_OFF + 2) {
      expectAirFights(frame, [match.flyers, match.risers], [match.ground]);
      expect(airborne(frame, match.risers)).toEqual([true, true]);
    } else if (frame.tick >= 2 && frame.tick <= TAKE_OFF - 1) {
      expectAirFights(frame, [match.flyers], [match.ground, match.risers]);
      expect(airborne(frame, match.risers)).toEqual([false, false]);
    }
    expect(airborne(frame, match.flyers)).toEqual([true, true]);
  };

  it("the simulation bites on every step but names each bite once, when it begins; the bytes flag the air bites only", () => {
    // Every ant loses HP on every step until the pairs are parted, and none after.
    for (let t = 1; t < MATCH_TICKS - 1; t++) {
      for (let k = 0; k < 6; k++) {
        if (t < BITES_UNTIL) expect(match.hpAfter[t]![k]).toBeLessThan(match.hpAfter[t - 1]![k]!);
        else if (t > BITES_UNTIL) expect(match.hpAfter[t]![k]).toBe(match.hpAfter[t - 1]![k]);
      }
    }
    const fights = match.deltas.map((b) => decodeMessage(b).events.filter((e) => e.kind === "fight"));
    expect(fights[0]).toHaveLength(6);
    expect(fights.slice(1).flat()).toEqual([]);
    for (const e of fights[0]!) {
      if (e.kind !== "fight") continue;
      if (match.flyers.includes(e.antId)) expect(e.air).toBe(true);
      else expect(Object.hasOwn(e, "air")).toBe(false);
    }
    // The second pair takes off with its bite under way: two take-offs, and no fight event.
    const takeoffs = match.deltas.map((b) => decodeMessage(b).events.filter((e) => e.kind === "takeoff").map((e) => e.kind === "takeoff" ? e.antId : -1));
    expect(takeoffs[TAKE_OFF]).toEqual(match.risers);
    expect(takeoffs.flat()).toEqual(match.risers);
  });

  it("live playback of the streamed bytes shows each air fight for as long as its flyers bite in the air", () => {
    const live = new Playback({ live: true }), prepare = new TickPreparation(), frame = new Frame();
    for (const bytes of match.packets) {
      const m = decodeMessage(bytes);
      live.pushPrepared(prepare.prepare(m)!, m.tick * TICK_MS);
    }
    // Played on, frame by frame, from the last arrival: each tick drawn is checked.
    const arrived = (MATCH_TICKS - 1) * TICK_MS, seen = new Set<number>();
    for (let ms = arrived; ms < arrived + 10_000 && frame.tick < MATCH_TICKS - 1; ms += 50) {
      expect(live.sample(ms, frame)).toBe(true);
      seen.add(frame.tick);
      if (frame.tick < BITES_UNTIL) {
        expectAt(frame);
        // Well after the only bite events.
        if (frame.tick * TICK_MS - TICK_MS > FIGHT_EFFECT_MS) expect(frame.fights).toEqual([]);
      }
      // Parted: no fight at all.
      if (frame.tick > BITES_UNTIL + 1) {
        expect(airFights(frame).size).toBe(0);
        expect(frame.engagements).toEqual([]);
      }
    }
    expect([...seen].some((t) => t >= 2 && t <= TAKE_OFF - 1)).toBe(true);
    expect([...seen].some((t) => t * TICK_MS - TICK_MS > FIGHT_EFFECT_MS && t >= TAKE_OFF + 2 && t < BITES_UNTIL)).toBe(true);
    expect([...seen].some((t) => t > BITES_UNTIL + 1)).toBe(true);
  });

  it("a recording shows the same air fights, and after seeking forward and back", async () => {
    const bytes = packMessages(match.packets);
    const r = openRecording("/recording", undefined, async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } })),
      { controls: true, endTick: async () => MATCH_TICKS - 1 });
    active.push(r);
    await r.first;
    await vi.waitFor(() => expect(r.duration).toBe((MATCH_TICKS - 1) * TICK_MS));
    const seek = async (ms: number) => {
      r.seek(ms);
      const playback = new Playback(), frame = new Frame();
      for (let i = 0; i < 100; i++) {
        await turn();
        for (const arrival of r.take(i * 16)) playback.push(arrival.m, arrival.at);
        playback.sample(r.time, frame);
        if (!r.seeking) return frame;
      }
      throw new Error("Seek never completed");
    };
    for (const [ms, before] of [[2500, false], [500, true], [1200, false], [2000, false]] as const) {
      const frame = await seek(ms);
      expect(frame.tick <= TAKE_OFF - 1).toBe(before);
      if (!before) {
        expect(frame.tick).toBeGreaterThanOrEqual(TAKE_OFF + 2);
        expect(frame.fights).toEqual([]);
      }
      expectAt(frame);
    }
    // After the pairs part: no fight at all.
    const parted = await seek((MATCH_TICKS - 1) * TICK_MS);
    expect(airFights(parted).size).toBe(0);
    expect(parted.engagements).toEqual([]);
  });

  /** The hub's board at the join, built from the stream as it went out; its message is the newcomer's first. */
  function board(join: number): SpectatorState {
    const first = decodeMessage(match.packets[0]!);
    const state = new SpectatorState(first.full!, first.tick, first.ants);
    for (const bytes of match.deltas.slice(0, join)) state.apply(decodeMessage(bytes));
    return state;
  }
  const restated = (m: StreamMessage) => m.events.map((e) => e.kind === "fight" ? [e.antId, e.targetId, e.air] : e.kind);

  it("the hub's board restates each bite under way between flyers for a viewer who joins, and nothing once the pair has parted", () => {
    const [a, b] = match.flyers, [c, d] = match.risers;
    // Before the second pair takes off, the first pair's bite is in the air and the second pair's on the ground; the
    // ground workers' bite is not restated.
    expect(restated(decodeMessage(encodeMessage(board(TAKE_OFF - 2).message())))).toEqual([[a, b, true], [b, a, true], [c, d, undefined], [d, c, undefined]]);
    // After: the second pair's bite, begun on the ground, is restated as the air bite it now is.
    const during = decodeMessage(encodeMessage(board(20).message()));
    expect(during.tick).toBe(20);
    expect(restated(during)).toEqual([[a, b, true], [b, a, true], [c, d, true], [d, c, true]]);
    // A saved board read back (a resumed match) keeps them.
    const resumed = new SpectatorState(during.full!, during.tick, during.ants, during.events);
    expect(resumed.message().events).toEqual(during.events);
    // Parted, the bites are over: the board restates none.
    expect(board(BITES_UNTIL + 3).message().events).toEqual([]);
  });

  /** What a viewer sees who joined at tick join, given its first message and the stream's deltas after it: both air fights, on both boards. */
  function expectJoinerSeesAirFights(first: StreamMessage, join: number) {
    const joined = [encodeReplayMessage(first), ...match.deltas.slice(join)].map(decodeMessage);
    expect(joined[0]!.tick).toBe(join);
    // No bite begins after the join: what the newcomer sees comes from its first message alone.
    expect(joined.slice(1).flatMap((m) => m.events).filter((e) => e.kind === "fight")).toEqual([]);
    const playback = new Playback(), frame = new Frame();
    for (const m of joined) playback.push(m, m.tick * TICK_MS);
    const at = (join + 3) * TICK_MS + BITE_CONTACT_MS;
    expect(playback.sample(at + RENDER_DELAY_MS, frame)).toBe(true);
    expect([...airFights(frame).values()].map((f) => [f.a, f.b].sort(byId))).toEqual([[...match.flyers].sort(byId), [...match.risers].sort(byId)].sort((p, q) => p[0]! - q[0]!));
    expect(airborne(frame, [...match.flyers, ...match.risers])).toEqual([true, true, true, true]);
    const pairs = [...airFights(frame).values()];

    // 2D: each air fight's ring is drawn at its flyers' lifted height, on their lifted bodies, with nothing at their ground contact.
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10);
    ants.update(frame); battles.update(frame);
    const kids = battles.layer.particleChildren as Particle[], lift = AIR_LIFT_2D_LENGTHS;
    const bodies = ants.antLayer.particleChildren as Particle[], ids = Array.from(frame.id.subarray(0, frame.count));
    expect(kids.filter((p) => p.tint === 0x000000)).toHaveLength(AIR_FIGHT.dots * pairs.length);
    for (const { a, b, x, y } of pairs) {
      const backing = kids.filter((k) => k.tint === 0x000000 && Math.hypot(k.x - x, k.y - (y - lift)) < 1);
      expect(backing).toHaveLength(AIR_FIGHT.dots);
      for (const p of backing) expect(Math.hypot(p.x - x, p.y - (y - lift)) * 10).toBeCloseTo(AIR_FIGHT.ringR);
      expect(kids.some((p) => near(p, x, y))).toBe(false);
      // The ring sits on the flyers' lifted bodies, as the ant renderer draws them, not on their shadows.
      const drawn = [a, b].map((id) => bodies[ids.indexOf(id)]!);
      [a, b].forEach((id, k) => expect(drawn[k]!.y).toBeCloseTo(frame.y[ids.indexOf(id)]! - lift, 1));
      const ringAt = { x: backing.reduce((t, p) => t + p.x, 0) / backing.length, y: backing.reduce((t, p) => t + p.y, 0) / backing.length };
      expect(ringAt.y).toBeCloseTo((drawn[0]!.y + drawn[1]!.y) / 2, 1);
      expect(ringAt.x).toBeCloseTo((drawn[0]!.x + drawn[1]!.x) / 2, 1);
    }

    // 3D: each ring is AIR_LIFT_3D_TILES above the ground at its pair.
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const ground = new Ground(scene, match.width, match.height), battles3d = new Battles3D(scene, ground);
      const bites = new Bites(); bites.update(frame); bites.publishContacts(0.5, "3d");
      battles3d.update(frame, 10);
      const ring = scene.getMeshByName("air-fight-ring") as Mesh, data = ring._thinInstanceDataStorage.matrixData!;
      expect(ring.thinInstanceCount).toBe(pairs.length);
      pairs.forEach(({ x, y }, k) => {
        expect(data[k * 16 + 12]).toBeCloseTo(x);
        expect(data[k * 16 + 14]).toBeCloseTo(ground.mapH - y);
        expect(data[k * 16 + 13]).toBeCloseTo(ground.heightAt(x, y) + 0.09 + AIR_LIFT_3D_TILES);
      });
    } finally { scene.dispose(); engine.dispose(); }
  }

  it("a viewer joining on the hub's board during the air fights sees each on both boards", () => {
    expectJoinerSeesAirFights(board(20).message(), 20);
  });

  it("a viewer joining on the hub's board while the second pair still bites on the ground sees both air fights once it has taken off", () => {
    expectJoinerSeesAirFights(board(TAKE_OFF - 2).message(), TAKE_OFF - 2);
  });

  it("after a handover saved while the second pair still bit on the ground, a viewer joining once it has taken off sees both air fights", async () => {
    const [a, b] = match.flyers, [c, d] = match.risers, save = 5, join = 20;
    expect(save).toBeLessThan(TAKE_OFF);
    const clock = new ManualClock(), config = { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 };
    const first = new LiveHub({ clock, config });
    first.startMatch(1, match.initial);
    for (const out of match.steps.slice(0, save)) { first.pushTick(1, out); clock.advance(TICK_MS); }
    // The handover: saved on the first server with the second pair's bite under way on the ground, and resumed on the next.
    const saved = await first.saveMatch(1);
    first.close();
    const next = new LiveHub({ clock, config }), server = new RecordedServer(next, clock);
    await server.listen();
    try {
      await next.resumeMatch(1, match.steps[save - 1]!.state, saved);
      // The second pair takes off and bites on in the air; no bite is named again after the handover.
      for (const out of match.steps.slice(save, join)) { next.pushTick(1, out); clock.advance(TICK_MS); }
      expect(match.steps.slice(save).flatMap((out) => out.events).filter((e) => e.type === "fight")).toEqual([]);
      const abort = new AbortController();
      const response = await fetch(server.url("/live/1"), { signal: abort.signal });
      expect(response.status).toBe(200);
      const watcher = await served(server, 1);
      for (let i = 0; i < 20_000 && !watcher.writes.some((w) => w.text.startsWith("data: ")); i++) await new Promise((r) => setImmediate(r));
      abort.abort();
      const joined = decodeData(watcher.writes.find((w) => w.text.startsWith("data: "))!.text.slice(6).trim());
      expect(joined.tick).toBe(join);
      // The next server restates both air bites, the one begun on the ground before the handover among them, as the
      // first server would have with no handover.
      expect(restated(joined)).toEqual([[a, b, true], [b, a, true], [c, d, true], [d, c, true]]);
      expect(restated(joined)).toEqual(restated(board(join).message()));
      expectJoinerSeesAirFights(joined, join);
    } finally {
      next.close();
      await server.close();
    }
  });
});

/**
 * Ants 81 (colony 0) and 17 (colony 1), both flyers, bite each other in the air one tile apart; 5 and 6 on the ground.
 * grounded: flyers whose state is grounded instead (landed), the pair still engaged.
 */
function boardFrame(renderMs = 10 * TICK_MS + BITE_CONTACT_MS, grounded: readonly number[] = []): Frame {
  const f = new Frame(); f.ensure(4); f.count = 4;
  f.tick = Math.floor(renderMs / TICK_MS); f.renderMs = renderMs;
  f.id.set([81, 17, 5, 6]); f.x.set([2, 2, 6, 6]); f.y.set([2, 3, 2, 3]);
  f.alpha.fill(1); f.agent.fill(-1); f.colony.set([0, 1, 0, 1]);
  f.engagements = [{ a: 81, b: 17, tick: 10 }, { a: 17, b: 81, tick: 10 }, { a: 5, b: 6, tick: 10 }, { a: 6, b: 5, tick: 10 }];
  f.fights = [
    { a: 81, b: 17, x: 2, y: 2.5, tick: 10, ageMs: 0 },
    { a: 17, b: 81, x: 2, y: 2.5, tick: 10, ageMs: 0 },
    { a: 5, b: 6, x: 6, y: 2.5, tick: 10, ageMs: 0 },
    { a: 6, b: 5, x: 6, y: 2.5, tick: 10, ageMs: 0 },
  ];
  const flyer = (id: number): StreamFlyer => grounded.includes(id) ? { state: "grounded" } : { state: "hovering", destX: 0, destY: 0 };
  const ants: StreamAnts = {
    count: 4, id: Uint32Array.from([81, 17, 5, 6]), x: new Uint16Array(4), y: new Uint16Array(4), heading: new Uint8Array(4),
    colony: Uint8Array.from([0, 1, 0, 1]), agent: new Int16Array(4).fill(-1), flyers: [flyer(81), flyer(17), null, null],
  };
  f.ants = ants;
  return f;
}
const renderer = { resolution: 1, generateTexture: () => Texture.WHITE } as unknown as Renderer;
const near = (p: Particle, x: number, y: number) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;
const radiusPx = (p: Particle, tilePx: number) => p.scaleX * 14 * tilePx;

describe("2D board: air fights at the flyers' lifted bodies", () => {
  it("draws the air fight's spark and ring lifted by the flyers' lift, and nothing on the ground beneath", () => {
    // 10 CSS px ants at 10 CSS px per tile: a worker body is one tile long.
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10), f = boardFrame();
    ants.update(f); battles.update(f);
    const lift = AIR_LIFT_2D_LENGTHS * 1;
    const kids = battles.layer.particleChildren as Particle[];
    // The ground pair: one small spark at its heads' contact, exactly as before.
    const ground = kids.filter((p) => p.tint === GROUND_SPARK.tint);
    expect(ground).toHaveLength(1);
    expect(near(ground[0]!, 6, 2.5)).toBe(true);
    expect(radiusPx(ground[0]!, 10)).toBeCloseTo(GROUND_SPARK.r);
    // Nothing at the air pair's ground contact.
    expect(kids.some((p) => near(p, 2, 2.5))).toBe(false);
    // The air pair: a pale, larger spark at the contact, lifted; a ring of dots around it on a dark backing.
    const spark = kids.filter((p) => near(p, 2, 2.5 - lift));
    expect(spark).toHaveLength(1);
    expect(spark[0]!.tint).toBe(AIR_FIGHT.tint);
    expect(radiusPx(spark[0]!, 10)).toBeGreaterThan(GROUND_SPARK.r);
    const ring = kids.filter((p) => p.tint === AIR_FIGHT.tint && !near(p, 2, 2.5 - lift));
    const backing = kids.filter((p) => p.tint === 0x000000);
    expect(ring).toHaveLength(AIR_FIGHT.dots);
    expect(backing).toHaveLength(AIR_FIGHT.dots);
    for (const p of [...ring, ...backing]) expect(Math.hypot(p.x - 2, p.y - (2.5 - lift)) * 10).toBeCloseTo(AIR_FIGHT.ringR);
    // Its backing is drawn beneath its dots.
    expect(kids.indexOf(backing.at(-1)!)).toBeLessThan(kids.indexOf(ring[0]!));
    expect(kids).toHaveLength(1 + 1 + 2 * AIR_FIGHT.dots);
  });

  it("keeps the ring between bites and while the pair stays engaged, ends it with the engagement, and follows the bodies' size, not the zoom", () => {
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10);
    // Between contacts: no sparks at all, the air fight's ring stays.
    let f = boardFrame(10 * TICK_MS + BITE_CONTACT_END_MS);
    ants.update(f); battles.update(f);
    let kids = battles.layer.particleChildren as Particle[];
    expect(kids.filter((p) => p.tint === GROUND_SPARK.tint)).toHaveLength(0);
    expect(kids.filter((p) => p.tint === AIR_FIGHT.tint)).toHaveLength(AIR_FIGHT.dots);
    // Long after the bite that began it, with no fight event since, the pair is still engaged: the ring is at full strength.
    f = boardFrame(20 * TICK_MS + BITE_MS + BITE_CONTACT_MS);
    f.fights = [];
    ants.update(f); battles.update(f);
    kids = battles.layer.particleChildren as Particle[];
    const dots = kids.filter((k) => k.tint === AIR_FIGHT.tint && !near(k, 2, 2.5 - AIR_LIFT_2D_LENGTHS));
    expect(dots).toHaveLength(AIR_FIGHT.dots);
    for (const p of dots) expect(p.alpha).toBeCloseTo(AIR_FIGHT.alpha);
    // The engagement over (the pair parted), the ring is gone, though a fresh air bite event is still in the frame.
    f = boardFrame();
    f.engagements = f.engagements.filter((e) => e.a < 10);
    ants.update(f); battles.update(f);
    expect((battles.layer.particleChildren as Particle[]).filter((p) => p.tint === AIR_FIGHT.tint || p.tint === 0x000000)).toEqual([]);
    // Longer bodies (15 CSS px at 10 per tile: 1.5 tiles) are lifted further; zooming in leaves the lift alone.
    const big = new Ants(renderer, 15, 10), zoomed = new Battles(renderer, 10);
    zoomed.setTilePx(40);
    f = boardFrame(); big.update(f); zoomed.update(f);
    kids = zoomed.layer.particleChildren as Particle[];
    const y = 2.5 - AIR_LIFT_2D_LENGTHS * 1.5;
    expect(kids.filter((p) => near(p, 2, y)).map((p) => p.tint)).toEqual([AIR_FIGHT.tint]);
    for (const p of kids.filter((k) => k.tint === 0x000000)) expect(Math.hypot(p.x - 2, p.y - y) * 40).toBeCloseTo(AIR_FIGHT.ringR);
  });

  it("draws no air fight for an engaged pair of which one flyer has landed", () => {
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10), f = boardFrame(undefined, [17]);
    ants.update(f); battles.update(f);
    const kids = battles.layer.particleChildren as Particle[];
    expect(kids.filter((p) => p.tint === AIR_FIGHT.tint || p.tint === 0x000000)).toEqual([]);
    expect(kids.some((p) => p.y < 2.5 - 1e-6 && Math.abs(p.x - 2) < 1e-6)).toBe(false);
  });

  it("draws no air fight where the ant renderer has drawn no bodies, and nothing new for ground-only fights", () => {
    const battles = new Battles(renderer, 10), f = boardFrame();
    battles.update(f);
    expect(battles.layer.particleChildren).toHaveLength(0);
    const ants = new Ants(renderer, 10, 10), ground = boardFrame();
    ground.fights = ground.fights.filter((x) => x.a < 10);
    ground.engagements = ground.engagements.filter((e) => e.a < 10);
    ants.update(ground); battles.update(ground);
    const kids = battles.layer.particleChildren as Particle[];
    expect(kids).toHaveLength(1);
    expect(near(kids[0]!, 6, 2.5)).toBe(true);
    expect(kids[0]!.tint).toBe(GROUND_SPARK.tint);
  });
});

describe("3D board: air fights above the ground", () => {
  let engine: NullEngine, scene: Scene, ground: Ground;
  beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine); ground = new Ground(scene, 8, 8); });
  afterEach(() => { scene.dispose(); engine.dispose(); });
  const mesh = (name: string) => scene.getMeshByName(name) as Mesh;
  const positions = (name: string) => {
    const m = mesh(name), data = m._thinInstanceDataStorage.matrixData!;
    return Array.from({ length: m.thinInstanceCount }, (_, i) => ({ x: data[i * 16 + 12]!, y: data[i * 16 + 13]!, z: data[i * 16 + 14]!, s: data[i * 16]! }));
  };

  function frame3d(air = true): Frame {
    const f = boardFrame(undefined, air ? [] : [81, 17]);
    const bites = new Bites(); bites.update(f); bites.publishContacts(0.5, "3d");
    return f;
  }

  it("lifts the air fight's spark and ring AIR_LIFT_3D_TILES above the ground; the ground fight's spark stays", () => {
    const battles = new Battles3D(scene, ground);
    battles.update(frame3d(), 10);
    const sparks = positions("fight-sparks");
    expect(sparks).toHaveLength(2);
    const air = sparks.find((p) => Math.abs(p.x - 2) < 1e-6)!, low = sparks.find((p) => Math.abs(p.x - 6) < 1e-6)!;
    expect(low.y).toBeCloseTo(ground.heightAt(6, 2.5) + 0.09);
    expect(air.y).toBeCloseTo(ground.heightAt(2, 2.5) + 0.09 + AIR_LIFT_3D_TILES);
    expect(air.s).toBeGreaterThan(low.s);
    const rings = positions("air-fight-ring");
    expect(rings).toHaveLength(1);
    expect(rings[0]!.x).toBeCloseTo(2);
    expect(rings[0]!.z).toBeCloseTo(ground.mapH - 2.5);
    expect(rings[0]!.y).toBeCloseTo(ground.heightAt(2, 2.5) + 0.09 + AIR_LIFT_3D_TILES);
    expect(rings[0]!.s).toBeCloseTo(AIR_RING_3D.r);
    expect(mesh("air-fight-ring").isEnabled()).toBe(true);
  });

  it("draws no ring for ground fights and keeps the empty ring mesh disabled", () => {
    const battles = new Battles3D(scene, ground);
    battles.update(new Frame(), 10);
    expect(mesh("air-fight-ring").thinInstanceCount).toBe(0);
    expect(mesh("air-fight-ring").isEnabled()).toBe(false);
    battles.update(frame3d(false), 10);
    expect(mesh("air-fight-ring").isEnabled()).toBe(false);
    for (const p of positions("fight-sparks")) expect(p.y).toBeCloseTo(ground.heightAt(p.x, ground.mapH - p.z) + 0.09);
    battles.update(frame3d(), 10); battles.setVisible(false);
    expect(mesh("air-fight-ring").isVisible).toBe(false);
  });
});

/** Steps of the split match, and the step on which one fighter of each pair changes layer. */
const SPLIT_TICKS = 16, SPLIT = 8;

/**
 * One fighter of each pair takes off or lands mid-fight, the other staying where it was. Two flyers of opposing colonies
 * hover over neighbouring tiles and bite each other in the air; a grounded flyer and an enemy ground worker stand on
 * neighbouring tiles further along and bite each other on the ground. On SPLIT the second air flyer lands where it hovered
 * and the grounded flyer takes off to hover where it stood: each pair is still in reach of itself, but the air is a
 * separate fight, so both bites stop at once. The simulation's combat step runs every step, the spectator recorder turns
 * each step into its message, and each is encoded to its bytes.
 */
function splitMatch() {
  const initial: SimState = emptyMatch(0, { ...HISTORICAL_CONFIG, combatGraceTicks: 0 });
  const hover = (tx: number, ty: number): FlyerAir => ({ destX: tileCentre(tx), destY: tileCentre(ty), hovering: true, released: false });
  const hp = 1_000_000;
  const high = addAnt(initial, 0, 10, 10, { flyer: true, air: hover(10, 10), hp });
  const lander = addAnt(initial, 1, 10, 11, { flyer: true, air: hover(10, 11), hp });
  const riser = addAnt(initial, 0, 20, 10, { flyer: true, hp });
  const worker = addAnt(initial, 1, 20, 11, { hp });
  const everyone = [high, lander, riser, worker];
  const recorder = new SpectatorRecorder(initial);
  const opening: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  const deltas: Uint8Array[] = [], hpAfter: number[][] = [];
  let state = initial;
  for (let t = 0; t < SPLIT_TICKS - 1; t++) {
    state = cloneState(state);
    const ant = (id: number) => state.ants.find((a) => a.id === id)!;
    const events: SimEvent[] = [];
    if (t === SPLIT) {
      ant(lander.id).air = undefined; ant(lander.id).takeOffTick = t + 100;
      events.push({ type: "flyer_landing", tick: t, antId: lander.id, colony: lander.colony, tileX: 10, tileY: 11 });
      ant(riser.id).air = hover(20, 10);
      events.push({ type: "flyer_takeoff", tick: t, antId: riser.id, colony: riser.colony, tileX: 20, tileY: 10 });
    }
    resolveCombat(state, buildGrid(state), t, events);
    state.tick = t + 1;
    deltas.push(encodeMessage({ ...recorder.record({ state, events, results: [] }), full: null }));
    hpAfter.push(everyone.map((a) => ant(a.id).hp));
  }
  return {
    deltas, packets: [encodeReplayMessage(opening), ...deltas], hpAfter,
    air: [high.id, lander.id], ground: [riser.id, worker.id], lander: lander.id, riser: riser.id,
    width: initial.config.mapWidth, height: initial.config.mapHeight,
  };
}

describe("one fighter takes off or lands mid-fight: the bite ends, on both boards, live and recorded", () => {
  const match = splitMatch();
  const everyone = [...match.air, ...match.ground];
  const active: Recording[] = [];
  let engine: NullEngine, scene: Scene, battles3d: Battles3D;
  beforeEach(() => {
    engine = new NullEngine(); scene = new Scene(engine);
    battles3d = new Battles3D(scene, new Ground(scene, match.width, match.height));
  });
  afterEach(() => {
    for (const r of active.splice(0)) r.close();
    scene.dispose(); engine.dispose();
  });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** The message tick from which a pair is split: the message of step SPLIT. */
  const split = SPLIT + 1;

  /** What each board draws for this frame: the 2D battle layer's particles, and the 3D sparks and air rings. */
  function drawn(frame: Frame) {
    const ants = new Ants(renderer, 10, 10), battles = new Battles(renderer, 10);
    ants.update(frame); battles.update(frame);
    const flat = [...battles.layer.particleChildren as Particle[]];
    const bites = new Bites(); bites.update(frame); bites.publishContacts(0.5, "3d");
    battles3d.update(frame, 10);
    const sparks = (scene.getMeshByName("fight-sparks") as Mesh).thinInstanceCount, rings = (scene.getMeshByName("air-fight-ring") as Mesh).thinInstanceCount;
    const posed = everyone.map((id) => bites.pose(Array.from(frame.id.subarray(0, frame.count)).indexOf(id), 1, "3d") !== null);
    return { flat, sparks, rings, posed };
  }
  const engaged = (frame: Frame, [a, b]: readonly number[]) => frame.engagements.filter((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)).length;

  /** Before the split both pairs bite, the air pair in the air; from the split on, neither pair is engaged and no board draws a bite. */
  function expectSplitAt(frame: Frame) {
    if (frame.tick >= 2 && frame.tick <= SPLIT) {
      expect(engaged(frame, match.air)).toBe(2);
      expect(engaged(frame, match.ground)).toBe(2);
      expect([...airFights(frame).keys()]).toEqual([[...match.air].sort(byId).join(":")]);
      expect(drawn(frame).posed).toEqual([true, true, true, true]);
    } else if (frame.tick >= split) {
      expect(frame.engagements).toEqual([]);
      expect(airFights(frame).size).toBe(0);
      const d = drawn(frame);
      expect(d.posed).toEqual([false, false, false, false]);
      expect(d.flat).toEqual([]);
      expect([d.sparks, d.rings]).toEqual([0, 0]);
    }
  }

  it("the simulation stops both bites on the step one fighter changes layer, and names no bite again", () => {
    for (let t = 1; t < SPLIT_TICKS - 1; t++) {
      for (let k = 0; k < 4; k++) {
        if (t < SPLIT) expect(match.hpAfter[t]![k]).toBeLessThan(match.hpAfter[t - 1]![k]!);
        else expect(match.hpAfter[t]![k]).toBe(match.hpAfter[t - 1]![k]);
      }
    }
    const events = match.deltas.map((b) => decodeMessage(b).events);
    expect(events[0]!.filter((e) => e.kind === "fight")).toHaveLength(4);
    expect(events.slice(1).flat().filter((e) => e.kind === "fight")).toEqual([]);
    expect(events[SPLIT]!.map((e) => e.kind === "takeoff" || e.kind === "landing" ? [e.kind, e.antId] : e.kind))
      .toEqual(expect.arrayContaining([["landing", match.lander], ["takeoff", match.riser]]));
    // The split message: the lander on the ground beside its airborne enemy, the riser airborne beside its ground enemy.
    const at = decodeMessage(match.deltas[SPLIT]!), state = (id: number) => at.ants.flyers?.[Array.from(at.ants.id).indexOf(id)]?.state;
    expect(at.tick).toBe(split);
    expect(match.air.map(state)).toEqual(["hovering", "lockedOut"]);
    expect(match.ground.map(state)).toEqual(["hovering", undefined]);
  });

  it("recorded playback draws both bites until the split, then none: no air fight, and no spark left on the ground", () => {
    const pb = new Playback();
    for (const bytes of match.packets) { const m = decodeMessage(bytes); pb.push(m, m.tick * TICK_MS); }
    // Each instant is a head contact on the shared bite clock.
    const contact = (tick: number) => {
      const ms = Math.ceil((tick * TICK_MS - BITE_CONTACT_MS) / BITE_MS) * BITE_MS + BITE_CONTACT_MS;
      expect(Math.floor(ms / TICK_MS)).toBe(tick);
      const frame = new Frame();
      expect(pb.sample(ms + RENDER_DELAY_MS, frame)).toBe(true);
      expect(frame.tick).toBe(tick);
      return frame;
    };
    // Before: the air pair's lifted spark and ring on the 2D board, the ground pair's ground spark; on the 3D board one
    // spark for each pair and one ring.
    const before = contact(6);
    expectSplitAt(before);
    const d = drawn(before);
    expect(d.flat.filter((p) => p.tint === GROUND_SPARK.tint)).toHaveLength(1);
    expect(d.flat.filter((p) => p.tint === 0x000000)).toHaveLength(AIR_FIGHT.dots);
    expect([d.sparks, d.rings]).toEqual([2, 1]);
    // After: nothing, at every contact.
    for (const tick of [9, 11, 14]) expectSplitAt(contact(tick));
  });

  it("live playback of the streamed bytes shows the same, frame by frame", () => {
    const live = new Playback({ live: true }), prepare = new TickPreparation(), frame = new Frame();
    for (const bytes of match.packets) {
      const m = decodeMessage(bytes);
      live.pushPrepared(prepare.prepare(m)!, m.tick * TICK_MS);
    }
    const arrived = (SPLIT_TICKS - 1) * TICK_MS, seen = new Set<number>();
    for (let ms = arrived; ms < arrived + 10_000 && frame.tick < SPLIT_TICKS - 1; ms += 50) {
      expect(live.sample(ms, frame)).toBe(true);
      seen.add(frame.tick);
      expectSplitAt(frame);
    }
    expect([...seen].some((t) => t >= 2 && t <= SPLIT)).toBe(true);
    expect([...seen].some((t) => t >= split)).toBe(true);
  });

  it("a recording shows the same after seeking forward and back", async () => {
    const bytes = packMessages(match.packets);
    const r = openRecording("/recording", undefined, async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } })),
      { controls: true, endTick: async () => SPLIT_TICKS - 1 });
    active.push(r);
    await r.first;
    await vi.waitFor(() => expect(r.duration).toBe((SPLIT_TICKS - 1) * TICK_MS));
    const seek = async (ms: number) => {
      r.seek(ms);
      const playback = new Playback(), frame = new Frame();
      for (let i = 0; i < 100; i++) {
        await turn();
        for (const arrival of r.take(i * 16)) playback.push(arrival.m, arrival.at);
        playback.sample(r.time, frame);
        if (!r.seeking) return frame;
      }
      throw new Error("Seek never completed");
    };
    for (const [ms, after] of [[1300, true], [500, false], [1000, true], [700, false]] as const) {
      const frame = await seek(ms);
      expect(frame.tick >= split).toBe(after);
      if (!after) expect(frame.tick).toBeGreaterThanOrEqual(2);
      expectSplitAt(frame);
    }
  });
});

describe("a killing bite across the layers is not shown", () => {
  const adjacent = (tick: number, ants: { id: number; colony: number; ty: number; flyer: StreamFlyer | null }[], events: StreamMessage["events"]): StreamMessage => ({
    tick, full: null, events,
    ants: {
      count: ants.length, id: Uint32Array.from(ants.map((a) => a.id)),
      x: Uint16Array.from(ants.map(() => 10.5 * SUB_TILE)), y: Uint16Array.from(ants.map((a) => (a.ty + 0.5) * SUB_TILE)),
      heading: new Uint8Array(ants.length), colony: Uint8Array.from(ants.map((a) => a.colony)), agent: new Int16Array(ants.length).fill(-1),
      caste: new Uint8Array(ants.length), flyers: ants.map((a) => a.flyer),
    },
  });
  const air: StreamFlyer = { state: "hovering", destX: 0, destY: 0 }, ground: StreamFlyer = { state: "grounded" };
  const bite = { kind: "fight" as const, antId: 1, targetId: 2, colony: 0 as const, tileX: 10, tileY: 10 };
  const death = { kind: "death" as const, antId: 2, colony: 1 as const, x: 10.5 * SUB_TILE, y: 11.5 * SUB_TILE };
  /** The engagements shown on the tick the target dies, after a bite named on the tick before. */
  const killing = (first: StreamMessage, second: StreamMessage) => {
    const tracker = new EngagementTracker();
    expect(tracker.observe(first)).toEqual([{ a: 1, b: 2, tick: 1 }]);
    return tracker.observe(second);
  };

  it("an attacker that took off on the tick its ground target died shows no final hit", () => {
    expect(killing(
      adjacent(1, [{ id: 1, colony: 0, ty: 10, flyer: ground }, { id: 2, colony: 1, ty: 11, flyer: null }], [bite]),
      adjacent(2, [{ id: 1, colony: 0, ty: 10, flyer: air }], [{ kind: "takeoff", antId: 1, colony: 0, x: 10.5 * SUB_TILE, y: 10.5 * SUB_TILE }, death]),
    )).toEqual([]);
  });

  it("an airborne attacker shows no final hit on a target that landed on the tick it died, and still does on one that died in the air", () => {
    const start = adjacent(1, [{ id: 1, colony: 0, ty: 10, flyer: air }, { id: 2, colony: 1, ty: 11, flyer: air }], [{ ...bite, air: true }]);
    expect(killing(start, adjacent(2, [{ id: 1, colony: 0, ty: 10, flyer: air }],
      [{ kind: "landing", antId: 2, colony: 1, x: 10.5 * SUB_TILE, y: 11.5 * SUB_TILE }, death]))).toEqual([]);
    expect(killing(start, adjacent(2, [{ id: 1, colony: 0, ty: 10, flyer: air }], [death])))
      .toEqual([{ a: 1, b: 2, tick: 1, terminalTick: 2, caste: 0 }]);
  });
});
