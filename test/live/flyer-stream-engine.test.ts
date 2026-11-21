/**
 * Flyers on the spectator stream through the real engine: accepted count-mark commands, the simulation's step, the
 * spectator recorder, the stream's bytes, the hub's board for a joining viewer and the spectator's playback. Live is
 * the recorder's message as the hub sends it; recorded is the same message decoded from the bytes a recording stores.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import {
  FLYER_STREAM_VERSION, QUEEN_KILLS_STREAM_VERSION, SUB_TILE, decodeMessage, encodeMessage, encodeReplayMessage, type StreamFlyer, type StreamMessage,
} from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { packMessages, TICK_MS } from "../../src/live/snapshot.ts";
import { FLYER_RULES, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.ts";
import { tileCentre, type Vec } from "../../src/sim/geometry.ts";
import { linkPatrolMarks } from "../../src/sim/patrol.ts";
import { step } from "../../src/sim/step.ts";
import type { Agent, Ant, Mark, SimInput, SimState, StepOutput, Terrain } from "../../src/sim/types.ts";
import { Frame, Playback, RENDER_DELAY_MS, TickPreparation } from "../../web/src/buffer.ts";
import { airFights } from "../../web/src/bite.ts";
import { openRecording, type Recording } from "../../web/src/recording.ts";
import { addAnt, antById, emptyMatch } from "../sim/fixtures.ts";
import { ManualClock, RecordedServer, SseClient, delivered, served } from "./helpers.ts";

/**
 * Every spot the engine's flyer LINE rule gives a flyer while a step runs, passed through unchanged, so the stream's
 * destination for a LINE flyer can be checked against the spot the rule gave it on that tick.
 */
const lineSpots = vi.hoisted(() => ({ given: null as Map<number, Vec | null> | null }));
vi.mock("../../src/sim/lineMarks.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/sim/lineMarks.ts")>();
  return {
    ...real,
    flyerLineSpotOf: (state: SimState, mark: Mark, ant: Ant): Vec | null => {
      const spot = real.flyerLineSpotOf(state, mark, ant);
      lineSpots.given?.set(ant.id, spot);
      return spot;
    },
  };
});

/** The lockout after a landing, in ticks. */
const LOCKOUT = FLYER_RULES.lockoutTicks;
/** A sim position in the stream's sub-tile units, converted as the recorder converts ant positions. */
const toStream = (v: number) => Math.round((v * SUB_TILE) / SUB);

/** Two agents, colony 0's "a" and colony 1's "b", whose last command was long enough ago for the next to be accepted. */
function seat(state: SimState): void {
  for (const colony of [0, 1] as const) {
    const agent: Agent = { id: colony === 0 ? "a" : "b", colony, joinSeq: colony, modelLabel: null, parentAgentId: null, squad: [],
      order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: state.tick - state.config.commandFloorTicks, idle: false, pendingEvents: [] };
    state.agents.push(agent);
  }
}

/** An agent's flyer GATHER count mark on a tile. */
const gather = (agentId: "a" | "b", tileX: number, tileY: number): SimInput =>
  ({ type: "count_mark", agentId, verb: "GATHER", caste: "flyer", count: 1, tileX, tileY });

/** One step, every command it carries accepted. */
function stepAccepted(state: SimState, inputs: readonly SimInput[] = []): StepOutput {
  const out = step(state, inputs);
  for (const result of out.results) expect(result.ok ? null : result.error).toBeNull();
  return out;
}

describe("an air fight a viewer joins before it takes off", () => {
  // The served rules-28 configuration, with its command floor and combat grace, on an open map with no starting ants.
  const config: SimConfig = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0, terrain: undefined, foodLayout: undefined,
    foodPatches: [], earlyWin: undefined };
  /** The first tick, just past the combat grace; the join, after the ground fight began; the take-off; the end. */
  const START = config.combatGraceTicks + 10, JOIN = START + 6, TAKE_OFF = START + 12, END = START + 40;

  /**
   * Two grounded flyers of opposing colonies on neighbouring tiles bite each other from the first tick. On TAKE_OFF
   * each agent lays a flyer GATHER mark one tile above its flyer, so both take off together, fly up side by side and
   * hover there, biting on in the air with the same targets. The simulation names each bite once, when it begins, so
   * no fight event follows the take-off. Their HP is raised so that neither dies while the fight is watched.
   */
  function match() {
    const initial = emptyMatch(START, config);
    seat(initial);
    const hp = 1_000_000;
    const ours = addAnt(initial, 0, 40, 30, { flyer: true, hp }).id, theirs = addAnt(initial, 1, 41, 30, { flyer: true, hp }).id;
    const steps: StepOutput[] = [];
    let state = initial;
    while (state.tick < END) {
      const out = stepAccepted(state, state.tick === TAKE_OFF ? [gather("a", 40, 29), gather("b", 41, 29)] : []);
      steps.push(out);
      state = out.state;
    }
    return { initial, steps, ours, theirs };
  }
  const m = match();
  const pair = [m.ours, m.theirs].sort((a, b) => a - b);
  const fightsOf = (out: StepOutput) => out.events.flatMap((e) => (e.type === "fight" ? [[e.antId, e.targetId, e.air === true]] : []));

  it("is a real fight that begins on the ground and goes on in the air with no new fight event", () => {
    expect(fightsOf(m.steps[0]!)).toEqual([[m.ours, m.theirs, false], [m.theirs, m.ours, false]]);
    expect(m.steps.slice(1).flatMap(fightsOf)).toEqual([]);
    const takeOffs = m.steps.flatMap((out) => out.events.flatMap((e) => (e.type === "flyer_takeoff" ? [[e.tick, e.antId]] : [])));
    expect(takeOffs).toEqual([[TAKE_OFF, m.ours], [TAKE_OFF, m.theirs]]);
    // Both lose HP on every tick, on the ground and in the air.
    const hpOf = (k: number) => [m.ours, m.theirs].map((id) => antById(m.steps[k]!.state, id)!.hp);
    for (let k = 1; k < m.steps.length; k++) for (const [i, hp] of hpOf(k).entries()) expect(hp).toBeLessThan(hpOf(k - 1)[i]!);
    for (const id of [m.ours, m.theirs]) expect(antById(m.steps.at(-1)!.state, id)!.air?.hovering).toBe(true);
  });

  /** A viewer's frames from its first message on, sampled at each tick after it, by the live or the recorded route. */
  function frames(messages: readonly StreamMessage[], route: "live" | "recorded"): Frame[] {
    const out: Frame[] = [];
    const first = messages[0]!.tick, last = messages.at(-1)!.tick;
    if (route === "recorded") {
      const playback = new Playback();
      for (const message of messages) playback.push(message, message.tick * TICK_MS);
      for (let tick = first + 1; tick <= last; tick++) {
        const frame = new Frame();
        expect(playback.sample(tick * TICK_MS + RENDER_DELAY_MS, frame)).toBe(true);
        out.push(frame);
      }
      return out;
    }
    // Live: prepared off the page thread, as a live page does, then played on frame by frame from the last arrival.
    const playback = new Playback({ live: true }), prepare = new TickPreparation();
    for (const message of messages) playback.pushPrepared(prepare.prepare(message)!, message.tick * TICK_MS);
    for (let ms = last * TICK_MS; ms < last * TICK_MS + 20_000 && out.at(-1)?.tick !== last; ms += 50) {
      const frame = new Frame();
      expect(playback.sample(ms, frame)).toBe(true);
      if (frame.tick > first && frame.tick !== out.at(-1)?.tick) out.push(frame);
    }
    return out;
  }

  /** Whatever route: engaged on the ground until both are airborne, then an air fight for as long as they bite. */
  function expectFightSeen(seen: readonly Frame[]) {
    const ticks = new Set<number>();
    for (const frame of seen) {
      ticks.add(frame.tick);
      const engaged = frame.engagements.filter((e) => pair.includes(e.a) && pair.includes(e.b)).map((e) => [e.a, e.b]);
      expect(engaged.length, `engaged on tick ${frame.tick}`).toBeGreaterThan(0);
      const air = [...airFights(frame).values()].map((f) => [f.a, f.b].sort((a, b) => a - b));
      // A message's tick counts completed ticks: the message of tick TAKE_OFF + 1 is the first with both airborne.
      expect(air, `air fights on tick ${frame.tick}`).toEqual(frame.tick > TAKE_OFF ? [pair] : []);
    }
    expect([...ticks].some((t) => t <= TAKE_OFF)).toBe(true);
    expect([...ticks].some((t) => t > TAKE_OFF + 10)).toBe(true);
  }

  it("the hub serves a viewer joining during the ground fight a first message that names it, and the viewer sees it go on in the air", async () => {
    const clock = new ManualClock(), hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 } });
    const server = new RecordedServer(hub, clock);
    await server.listen();
    try {
      hub.startMatch(1, m.initial);
      let viewer: SseClient | null = null;
      for (const out of m.steps) {
        hub.pushTick(1, out);
        clock.advance(TICK_MS);
        if (out.state.tick === JOIN) {
          viewer = await SseClient.connect(server.url("/live/1"));
          await delivered(viewer, await served(server, 1));
        }
      }
      await delivered(viewer!, server.responses[0]!);
      viewer!.close();
      const received = viewer!.messages;
      const first = received[0]!;
      expect(first.full).not.toBeNull();
      expect(first.tick).toBe(JOIN);
      // The first message restates the bite under way, and no message after it names one.
      const named = (message: StreamMessage) => message.events.flatMap((e) => (e.kind === "fight" ? [[e.antId, e.targetId, e.air === true]] : []));
      expect(named(first)).toEqual([[m.ours, m.theirs, false], [m.theirs, m.ours, false]]);
      expect(received.slice(1).flatMap(named)).toEqual([]);
      expect(received.at(-1)!.tick).toBe(END);
      expectFightSeen(frames(received, "live"));
      expectFightSeen(frames(received, "recorded"));
    } finally {
      hub.close();
      await server.close();
    }
  });

  it("a recording of the match, and the hub's board as a recording stores it, show the same fight", async () => {
    const recorder = new SpectatorRecorder(m.initial);
    const opening: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
    const deltas = m.steps.map((out) => encodeMessage({ ...recorder.record(out), full: null }));
    // The hub's board at the join, built from the stream as it went out, stored and read back as a recording's first message.
    const board = new SpectatorState(decodeMessage(encodeReplayMessage(opening)).full!, opening.tick, opening.ants);
    for (const bytes of deltas.slice(0, JOIN - START)) board.apply(decodeMessage(bytes));
    const joined = [encodeReplayMessage(board.message()), ...deltas.slice(JOIN - START)].map(decodeMessage);
    expect(joined[0]!.tick).toBe(JOIN);
    // A public match's opening carries its queen kills, zero included, so it is written at the queen-kills version.
    expect(encodeMessage(board.message())[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expectFightSeen(frames(joined, "recorded"));
    // A recording played from its start, then sought into the ground fight and played on past the take-off.
    const bytes = packMessages([encodeReplayMessage(opening), ...deltas]);
    const recording = openRecording("/recording", undefined, async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } })),
      { controls: true, endTick: async () => END });
    active.push(recording);
    await recording.first;
    await vi.waitFor(() => expect(recording.duration).toBe((END - START) * TICK_MS));
    recording.seek((JOIN - START) * TICK_MS);
    const playback = new Playback(), seen: Frame[] = [];
    for (let i = 0; i < 400 && seen.at(-1)?.tick !== END; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const arrival of recording.take(i * 16)) playback.push(arrival.m, arrival.at);
      const frame = new Frame();
      if (!recording.seeking && playback.sample(recording.time, frame) && frame.tick > JOIN && frame.tick !== seen.at(-1)?.tick) seen.push(frame);
    }
    expect(seen.length).toBeGreaterThan(0);
    expectFightSeen(seen);
  });
  const active: Recording[] = [];
  afterEach(() => { for (const r of active.splice(0)) r.close(); });
});

type Point = readonly [number, number];
const centre = (mark: { tileX: number; tileY: number }): Point => [tileCentre(mark.tileX), tileCentre(mark.tileY)];
const airborne = (f: StreamFlyer | null | undefined) => f?.state === "flying" || f?.state === "hovering";

/**
 * A match stepped by the real engine and streamed tick by tick, with the displayed-state checks of the flyer test
 * plan run on every message, live and recorded: each flyer's streamed state matches its motion (flying when it
 * moved, hovering on its destination, locked out with the tick its lockout from its streamed landing ends, then
 * grounded; airborne exactly when the engine has it in the air, taking off and landing with an event), and while
 * airborne its streamed destination is where its order sends it, read from the order itself: the GATHER, ATTACK or
 * lone PATROL mark's tile; on a PATROL chain, a waypoint of the chain it is on now, kept until it is reached and then
 * the next in laid order; the spot the LINE rule gave it on that tick; or, once its order has ended in flight, the
 * destination it was heading for then. A viewer joining on the hub's board at any tick places every flyer and its
 * destination exactly as the stream carries them.
 */
class StreamedMatch {
  state: SimState;
  private readonly recorder: SpectatorRecorder;
  /** Each message, by the tick it carries: as sent live, and decoded from its bytes. */
  readonly live: StreamMessage[] = [];
  readonly recorded: StreamMessage[] = [];
  /** The hub's board, built from the stream as it goes out. */
  private readonly board: SpectatorState;
  /** Each flyer's last streamed landing tick, and its destination while last ordered. */
  private readonly landed = new Map<number, number>();
  private readonly ordered = new Map<number, Point>();
  /** Each PATROL flyer's chain (its mark ids, in laid order) and the waypoint it is heading for on it. */
  private readonly patrol = new Map<number, { chain: string; waypoint: number | null }>();
  /** The spots the LINE rule gave flyers in the last step. */
  private given = new Map<number, Vec | null>();
  /**
   * The marks the last step's flight read: those standing after it, and those whose lifetime ended with it, since
   * marks expire at the end of a step, after the flyers have flown.
   */
  private flown: readonly Mark[] = [];

  constructor(state: SimState) {
    this.state = state;
    this.recorder = new SpectatorRecorder(state);
    const opening: StreamMessage = { ...this.recorder.initial(), full: this.recorder.initialFull() };
    this.live.push(opening);
    this.recorded.push(decodeMessage(encodeReplayMessage(opening)));
    this.board = new SpectatorState(this.recorded[0]!.full!, opening.tick, this.recorded[0]!.ants);
  }

  /** The PATROL chain a mark was in when the flyers flew, in laid order, by the shared chain rule. */
  private chainOf(mark: Mark): readonly Mark[] {
    return linkPatrolMarks(this.flown, this.state.config.patrolLinkTiles!).get(mark.id)?.chain ?? [mark];
  }

  tick(inputs: readonly SimInput[] = []): void {
    lineSpots.given = new Map();
    const before = this.state, out = stepAccepted(before, inputs);
    this.given = lineSpots.given;
    lineSpots.given = null;
    this.state = out.state;
    const standing = new Set(out.state.marks.map((m) => m.id)), lifetime = out.state.config.markLifetimeTicks;
    this.flown = [...out.state.marks, ...before.marks.filter((m) => !standing.has(m.id) && out.state.tick - m.laidTick >= lifetime)];
    const live: StreamMessage = { ...this.recorder.record(out), full: null };
    const bytes = encodeMessage(live);
    expect(bytes[2]).toBe(FLYER_STREAM_VERSION);
    const recorded = decodeMessage(bytes);
    expect(recorded.ants.flyers).toEqual(live.ants.flyers);
    expect([Array.from(recorded.ants.id), Array.from(recorded.ants.x), Array.from(recorded.ants.y)])
      .toEqual([Array.from(live.ants.id), Array.from(live.ants.x), Array.from(live.ants.y)]);
    expect(recorded.events).toEqual(live.events);
    for (const e of live.events) if (e.kind === "landing") this.landed.set(e.antId, live.tick - 1);
    this.check(this.live.at(-1)!, live);
    this.check(this.recorded.at(-1)!, recorded);
    this.live.push(live);
    this.recorded.push(recorded);
    // A viewer joining now: its first message, as the hub sends it and as a recording stores it.
    this.board.apply(recorded);
    for (const first of [encodeMessage(this.board.message()), encodeReplayMessage(this.board.message())].map(decodeMessage)) {
      expect(first.tick).toBe(live.tick);
      expect([first.ants.flyers, Array.from(first.ants.x), Array.from(first.ants.y)])
        .toEqual([live.ants.flyers, Array.from(live.ants.x), Array.from(live.ants.y)]);
    }
  }

  private check(before: StreamMessage, now: StreamMessage): void {
    const processed = now.tick - 1;
    for (let i = 0; i < now.ants.count; i++) {
      const f = now.ants.flyers?.[i];
      if (f === null || f === undefined) continue;
      const id = now.ants.id[i]!, ant = antById(this.state, id)!, where = `flyer ${id} on tick ${processed}`;
      const at: Point = [now.ants.x[i]!, now.ants.y[i]!];
      const j = Array.from(before.ants.id).indexOf(id);
      const was = j < 0 ? null : before.ants.flyers?.[j] ?? null;
      const moved = j < 0 || before.ants.x[j] !== at[0] || before.ants.y[j] !== at[1];
      const events = now.events.filter((e) => (e.kind === "takeoff" || e.kind === "landing") && e.antId === id).map((e) => e.kind);
      // Airborne exactly when the engine has it in the air; it leaves the ground and comes down with an event.
      expect(airborne(f), where).toBe(ant.air !== undefined);
      expect(events, where).toEqual(airborne(f) && !airborne(was) ? ["takeoff"] : !airborne(f) && airborne(was) ? ["landing"] : []);
      if (f.state === "flying") expect(moved, `${where}: flying without moving`).toBe(true);
      if (f.state === "hovering") expect([f.destX, f.destY], `${where}: hovering off its destination`).toEqual(at);
      const landed = this.landed.get(id);
      if (f.state === "lockedOut") expect(f, where).toEqual({ state: "lockedOut", takeOffTick: landed! + LOCKOUT });
      if (f.state === "lockedOut") expect(processed, where).toBeLessThan(landed! + LOCKOUT);
      if (f.state === "grounded") expect(f, where).toEqual({ state: "grounded" });
      if (f.state === "grounded" && landed !== undefined) expect(processed, where).toBeGreaterThanOrEqual(landed + LOCKOUT);
      // It comes down where it stands at the end of the tick.
      for (const e of now.events) if (e.kind === "landing" && e.antId === id) expect([e.x, e.y], where).toEqual(at);
      if (!airborne(f)) {
        expect(f, where).not.toHaveProperty("destX");
        continue;
      }
      expect([f.destX, f.destY], `${where}: the engine's destination`).toEqual([toStream(ant.air!.destX), toStream(ant.air!.destY)]);
      const ordered = this.destinationOf(ant).map(([x, y]) => [toStream(x), toStream(y)]);
      expect(ordered, `${where}: where its order sends it`).toContainEqual([f.destX, f.destY]);
    }
  }

  /**
   * Where the flyer's order sends it on this tick: one point, or, on the first tick on a PATROL chain before it reaches
   * a waypoint, any of the chain's, after which it keeps that one.
   */
  private destinationOf(ant: Ant): Point[] {
    const mark = ant.claim === undefined ? undefined : this.state.marks.find((m) => m.id === ant.claim);
    // An order that ended in flight (the mark gone, re-cast, lowered or its seat lapsed): where it was heading then.
    if (mark === undefined || ant.air!.released) {
      this.patrol.delete(ant.id);
      return [this.ordered.get(ant.id)!];
    }
    let dest: Point[];
    const chain = mark.verb === "PATROL" ? this.chainOf(mark) : [];
    if (mark.verb === "LINE") {
      expect(this.given.has(ant.id), `LINE flyer ${ant.id} asked for its spot`).toBe(true);
      const spot = this.given.get(ant.id)!;
      dest = [spot === null ? this.ordered.get(ant.id)! : [spot.x, spot.y]];
    } else if (chain.length > 1) {
      const key = chain.map((m) => m.id).join(","), on = chain.findIndex((m) => ant.x === tileCentre(m.tileX) && ant.y === tileCentre(m.tileY));
      let memory = this.patrol.get(ant.id);
      if (memory?.chain !== key) this.patrol.set(ant.id, memory = { chain: key, waypoint: null });
      if (on >= 0) memory.waypoint = chain[(on + 1) % chain.length]!.id;
      const waypoint = chain.find((m) => m.id === memory.waypoint);
      dest = waypoint === undefined ? chain.map(centre) : [centre(waypoint)];
      if (waypoint === undefined) memory.waypoint = chain.find((m) => toStream(tileCentre(m.tileX)) === toStream(ant.air!.destX) && toStream(tileCentre(m.tileY)) === toStream(ant.air!.destY))?.id ?? null;
    } else {
      this.patrol.delete(ant.id);
      dest = [centre(mark)];
    }
    this.ordered.set(ant.id, [ant.air!.destX, ant.air!.destY]);
    return dest;
  }

  /** The spot the LINE rule gave a flyer in the last step: null when no tile passed, undefined when it was not asked. */
  spotGiven(id: number): Vec | null | undefined {
    return this.given.get(id);
  }

  /** Each flyer's streamed entry at a processed tick, live; the recorded entry is checked equal on every tick. */
  flyerAt(id: number, processed: number): StreamFlyer | null | undefined {
    const message = this.live[processed - this.live[0]!.tick + 1]!;
    return message.ants.flyers?.[Array.from(message.ants.id).indexOf(id)];
  }

  /** The processed ticks of a flyer's streamed take-offs or landings. */
  moments(kind: "takeoff" | "landing", id: number): number[] {
    return this.recorded.flatMap((m) => m.events.some((e) => e.kind === kind && e.antId === id) ? [m.tick - 1] : []);
  }
}

describe("displayed states on the stream through the real engine", () => {
  // The served rules-28 flyer rules on an open map, combat held off so that only motion and state are read, and no
  // command floor, so a scenario's orders follow each other tick by tick.
  const config: SimConfig = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0, terrain: undefined, foodLayout: undefined,
    foodPatches: [], commandFloorTicks: 0, combatGraceTicks: 99_999, earlyWin: undefined };
  const T0 = 100;
  function scene(terrain?: Terrain, rules: Partial<SimConfig> = {}): SimState {
    const state = emptyMatch(T0, { ...config, ...rules });
    if (terrain !== undefined) (state as { terrain?: Terrain }).terrain = terrain;
    seat(state);
    return state;
  }
  /** A mark laid before the scenario starts, as the agent would have laid it: colony 0's flyer mark unless told otherwise. */
  function mark(state: SimState, verb: NonNullable<Mark["verb"]>, tileX: number, tileY: number, options: Partial<Mark> = {}): Mark {
    const item: Mark = { id: state.nextMarkId++, agentId: options.colony === 1 ? "b" : "a", colony: 0, tileX, tileY, words: [],
      laidTick: T0 - 1, steering: 0, verb, count: 1, revision: 0, caste: "flyer", ...options };
    state.marks.push(item);
    return item;
  }
  const flyer = (state: SimState, colony: 0 | 1, tx: number, ty: number, patch: Partial<Ant> = {}): number =>
    addAnt(state, colony, tx, ty, { flyer: true, ...patch }).id;
  const command = (verb: string, tileX: number, tileY: number, extra: Partial<Extract<SimInput, { type: "count_mark" }>> = {}): SimInput =>
    ({ type: "count_mark", agentId: "a", verb, tileX, tileY, count: 1, caste: "flyer", ...extra });
  const remove = (markId: number): SimInput => ({ type: "count_mark", agentId: "a", verb: "REMOVE", count: 0, markId });
  const markAt = (state: SimState, tileX: number, tileY: number) => state.marks.find((m) => m.tileX === tileX && m.tileY === tileY)!.id;

  it("reads flying from take-off at A, hovering from a GATHER hover at B, locked out from landing on an ATTACK mark at C with take-off C+30, grounded from C+30", () => {
    const game = new StreamedMatch(scene());
    const id = addAnt(game.state, 0, 20, 40, { flyer: true }).id;
    // Grounded for three ticks; at A an accepted GATHER mark four tiles along claims it.
    for (let i = 0; i < 3; i++) game.tick();
    const A = game.state.tick;
    game.tick([command("GATHER", 24, 40)]);
    const gatherId = markAt(game.state, 24, 40);
    while (game.state.tick < A + 20) game.tick();
    // The GATHER order ends: the hovering flyer lands under it at R. The next tick an ATTACK mark ten tiles away claims
    // it during its lockout; it takes off once the lockout ends and lands on the mark at C.
    const R = game.state.tick;
    game.tick([remove(gatherId)]);
    game.tick([command("ATTACK", 24, 50)]);
    while (game.moments("landing", id).length < 2) game.tick();
    const C = game.moments("landing", id)[1]!;
    while (game.state.tick <= C + LOCKOUT + 5) game.tick();
    // Four tiles at 0.8 tiles a tick: on the fifth step it is over the tile, hovering. Ten tiles: thirteen steps.
    const B = A + 4;
    expect(game.moments("takeoff", id)).toEqual([A, R + LOCKOUT]);
    expect(game.moments("landing", id)).toEqual([R, C]);
    expect(C).toBe(R + LOCKOUT + 12);
    const GATHER = [toStream(tileCentre(24)), toStream(tileCentre(40))], ATTACK = [toStream(tileCentre(24)), toStream(tileCentre(50))];
    for (let t = T0; t < game.state.tick; t++) {
      const expected = t < A ? { state: "grounded" }
        : t < B ? { state: "flying", destX: GATHER[0], destY: GATHER[1] }
          : t < R ? { state: "hovering", destX: GATHER[0], destY: GATHER[1] }
            : t < R + LOCKOUT ? { state: "lockedOut", takeOffTick: R + LOCKOUT }
              : t < C ? { state: "flying", destX: ATTACK[0], destY: ATTACK[1] }
                : t < C + LOCKOUT ? { state: "lockedOut", takeOffTick: C + LOCKOUT } : { state: "grounded" };
      expect(game.flyerAt(id, t), `tick ${t}`).toEqual(expected);
    }
  });

  it("sweeps a two-mark PATROL and loops a four-mark one toward each next waypoint, never hovering, a lone mark hovering", () => {
    for (const tiles of [[[20, 40], [30, 40]], [[20, 40], [26, 40], [26, 46], [20, 46]]] as const) {
      const state = scene();
      const id = addAnt(state, 0, 20, 40, { flyer: true }).id;
      const game = new StreamedMatch(state);
      // Laid one a tick: the first claims the flyer standing on it, a lone mark it hovers over; each later one joins the chain.
      for (const [x, y] of tiles) game.tick([command("PATROL", x, y)]);
      while (game.state.tick < T0 + 120) game.tick();
      const shown = Array.from({ length: game.state.tick - T0 }, (_, k) => game.flyerAt(id, T0 + k)!.state);
      expect(shown[0]).toBe("hovering");
      expect(shown.slice(1)).toEqual(Array(shown.length - 1).fill("flying"));
      // Each turn for the next waypoint (checked against laid order on every tick): round the chain more than twice.
      const flown = Array.from({ length: game.state.tick - T0 }, (_, k) => game.flyerAt(id, T0 + k)!);
      const turns = flown.filter((f, k) => k > 0 && (f.destX !== flown[k - 1]!.destX || f.destY !== flown[k - 1]!.destY));
      expect(turns.length).toBeGreaterThan(2 * tiles.length);
      expect(game.moments("landing", id)).toEqual([]);
    }
  });

  it("hovers each LINE flyer over the spot the LINE rule gives it, flying until it is there", () => {
    const state = scene();
    const ids = [42, 44, 46].map((y) => addAnt(state, 0, 30, y, { flyer: true }).id);
    const game = new StreamedMatch(state);
    game.tick([command("LINE", 36, 40, { toTileX: 40, toTileY: 40, count: 3 })]);
    while (game.state.tick < T0 + 40) game.tick();
    const last = game.state.tick - 1;
    const spots = ids.map((id) => game.flyerAt(id, last)!);
    for (const f of spots) expect(f.state).toBe("hovering");
    expect(spots.map((f) => [f.destX, f.destY]).sort((p, q) => p[0]! - q[0]!)).toEqual([36, 38, 40].map((x) => [toStream(tileCentre(x)), toStream(tileCentre(40))]));
    for (const id of ids) expect(game.moments("landing", id)).toEqual([]);
  });

  it("flies a PATROL flyer whose order ends over water on to the waypoint it was heading for, lands there, and keeps that lockout when a GATHER claims it", () => {
    // A lake across the leg, tiles 25 to 28.
    const lake: Terrain = { mapId: "test", mapName: "test", water: [{ x: 25, y: 30, width: 4, height: 20 }] };
    const state = scene(lake);
    const id = addAnt(state, 0, 22, 40, { flyer: true }).id;
    const game = new StreamedMatch(state);
    for (const [x, y] of [[22, 40], [32, 40]] as const) game.tick([command("PATROL", x, y)]);
    const chain = [markAt(game.state, 22, 40), markAt(game.state, 32, 40)];
    while (Math.floor(antById(game.state, id)!.x / SUB) < 26) game.tick();
    const over = Math.floor(antById(game.state, id)!.x / SUB);
    expect(over).toBeLessThan(29);
    expect(game.flyerAt(id, game.state.tick - 1)).toEqual({ state: "flying", destX: toStream(tileCentre(32)), destY: toStream(tileCentre(40)) });
    // Both marks removed while it is over the water: it flies on to (32, 40), not toward the nearer shore.
    const cancel = game.state.tick;
    game.tick([remove(chain[0]!), remove(chain[1]!)]);
    while (game.moments("landing", id).length === 0) game.tick();
    const L = game.moments("landing", id)[0]!;
    for (let t = cancel; t < L; t++) expect(game.flyerAt(id, t), `tick ${t}`).toEqual({ state: "flying", destX: toStream(tileCentre(32)), destY: toStream(tileCentre(40)) });
    expect(antById(game.state, id)).toMatchObject({ x: tileCentre(32), y: tileCentre(40) });
    // Ten ticks into its lockout a GATHER mark claims it: still locked out with the same take-off tick, then flying.
    while (game.state.tick < L + 10) game.tick();
    game.tick([command("GATHER", 32, 44)]);
    while (game.state.tick < L + LOCKOUT + 10) game.tick();
    for (let t = L; t < L + LOCKOUT; t++) expect(game.flyerAt(id, t), `tick ${t}`).toEqual({ state: "lockedOut", takeOffTick: L + LOCKOUT });
    expect(game.flyerAt(id, L + LOCKOUT)).toEqual({ state: "flying", destX: toStream(tileCentre(32)), destY: toStream(tileCentre(44)) });
    expect(game.flyerAt(id, L + LOCKOUT + 5)).toEqual({ state: "hovering", destX: toStream(tileCentre(32)), destY: toStream(tileCentre(44)) });
    expect(game.moments("takeoff", id)).toEqual([T0, L + LOCKOUT]);
  });
  it("streams a PATROL flyer in an air fight over water and rock flying on to its waypoint when its order ends there, by each way an order ends", () => {
    const terrain: Terrain = { mapId: "test", mapName: "test",
      water: [{ x: 24, y: 30, width: 4, height: 20 }], rocks: [{ x: 31, y: 30, width: 3, height: 20, appearance: 0 }] };
    // Combat is live; every flyer has HP enough to stay in the fight throughout.
    const tough = { hp: 1_000_000 };
    for (const cancel of ["REMOVE", "expiry", "lower count", "lapsed seat", "re-cast"] as const) {
      for (const over of ["water", "rock"] as const) {
        const label = `${cancel} over ${over}`;
        const state = scene(terrain, { combatGraceTicks: 0 });
        // A two-mark leg across the lake (tiles 24 to 27) and the rock band (31 to 33), and enemy flyers hovering on land
        // within reach of the leg over the lake's last tile, or over the rock band's first two tiles.
        const id = flyer(state, 0, 22, 40, tough);
        const a = mark(state, "PATROL", 22, 40, { count: 2, laidTick: T0 - 2 });
        mark(state, "PATROL", 34, 40, { count: 2 });
        const ex = over === "water" ? 29 : 30;
        mark(state, "GATHER", ex, 42, { colony: 1, count: 2 });
        const enemies = [flyer(state, 1, ex, 42, tough), flyer(state, 1, ex, 42, tough)];
        const blocked = over === "water" ? (x: number) => x >= 24 && x < 28 : (x: number) => x >= 31 && x < 34;
        const game = new StreamedMatch(state);
        // In contact on a tick: airborne after it, it bit an enemy flyer and lost HP to their bites.
        let contact = -1;
        const fly = (inputs: readonly SimInput[] = []) => {
          const hp = antById(game.state, id)!.hp;
          game.tick(inputs);
          const ant = antById(game.state, id)!;
          if (ant.air !== undefined && enemies.includes(ant.lastTargetId) && ant.hp < hp) contact = game.state.tick - 1;
        };
        const tileX = () => Math.floor(antById(game.state, id)!.x / SUB);
        for (let i = 0; i < 30 && !(blocked(tileX()) && contact === game.state.tick - 1); i++) fly();
        expect(blocked(tileX()) && contact === game.state.tick - 1, label).toBe(true);
        const cancelTick = game.state.tick;
        expect(game.flyerAt(id, cancelTick - 1), label).toEqual({ state: "flying", destX: toStream(tileCentre(34)), destY: toStream(tileCentre(40)) });
        const target = game.state.marks.find((m) => m.id === a.id)!;
        if (cancel === "expiry") Object.assign(target, { laidTick: cancelTick - config.markLifetimeTicks });
        // Lowered to 1 beside a member standing on the mark: the patrol flyer is the farther, so it goes.
        if (cancel === "lower count") flyer(game.state, 0, 22, 40, { claim: a.id });
        if (cancel === "lapsed seat") game.state.agents[0]!.lastCommandTick = cancelTick - config.commandIdleTicks!;
        fly(cancel === "REMOVE" ? [remove(a.id)] : cancel === "lower count" ? [command("PATROL", 22, 40)]
          : cancel === "re-cast" ? [command("PATROL", 22, 40, { count: 2, caste: "soldier" })] : []);
        while (game.moments("landing", id).length === 0 && game.state.tick < cancelTick + 40) fly();
        const landed = game.moments("landing", id);
        expect(landed, label).toHaveLength(1);
        // From the cancel to its landing it streams its fixed destination, and lands there.
        for (let t = cancelTick; t < landed[0]!; t++) expect(game.flyerAt(id, t), `${label}, tick ${t}`).toEqual({ state: "flying", destX: toStream(tileCentre(34)), destY: toStream(tileCentre(40)) });
        expect(game.flyerAt(id, landed[0]!), label).toEqual({ state: "lockedOut", takeOffTick: landed[0]! + LOCKOUT });
        // The air fight is on the stream: the patrol flyer's bites on the enemy flyers are flagged as air bites.
        const bites = game.recorded.flatMap((m) => m.events).filter((e) => e.kind === "fight" && e.antId === id);
        expect(bites.length, label).toBeGreaterThan(0);
        for (const e of bites) expect(e.kind === "fight" && enemies.includes(e.targetId) && e.air === true, label).toBe(true);
      }
    }
  });

  it("streams a re-laid PATROL chain: a mark re-cast away and back, a ground mark re-cast to flyers, the oldest mark expiring", () => {
    const state = scene();
    const a = mark(state, "PATROL", 20, 40, { laidTick: T0 - 4 });
    const b = mark(state, "PATROL", 30, 40, { laidTick: T0 - 3 });
    const c = mark(state, "PATROL", 26, 46, { laidTick: T0 - 2 });
    // A ground PATROL mark beside the chain, held by a worker.
    const g = mark(state, "PATROL", 34, 46, { caste: "worker", laidTick: T0 - 1 });
    addAnt(state, 0, 34, 46, { claim: g.id });
    const [onA, onB, onC] = [[20, 40, a], [30, 40, b], [26, 46, c]].map(([x, y, m]) => flyer(state, 0, x as number, y as number, { claim: (m as Mark).id }));
    const game = new StreamedMatch(state);
    const laid = (id: number) => game.state.marks.find((m) => m.id === id);
    for (let i = 0; i < 5; i++) game.tick();
    // The middle mark re-laid as caste soldier: its flyer is released in flight, the rest re-target the chain left.
    game.tick([command("PATROL", 30, 40, { caste: "soldier" })]);
    expect(laid(b.id)).toMatchObject({ caste: "soldier", laidTick: b.laidTick, revision: 1 });
    while (game.state.tick < T0 + 20) game.tick();
    // Back to flyers: it recruits its released flyer, which waits out its lockout.
    game.tick([command("PATROL", 30, 40)]);
    expect(laid(b.id)).toMatchObject({ caste: "flyer", laidTick: b.laidTick, revision: 2 });
    // The ground mark re-laid as caste flyer joins the flyer chain.
    game.tick([command("PATROL", 34, 46)]);
    expect(laid(g.id)).toMatchObject({ caste: "flyer", laidTick: g.laidTick });
    while (game.state.tick < T0 + 40) game.tick();
    // The oldest mark's lifetime ends: its flyer is released, the rest fly the chain left.
    Object.assign(laid(a.id)!, { laidTick: game.state.tick - config.markLifetimeTicks });
    while (game.state.tick < T0 + 120) game.tick();
    expect(laid(a.id)).toBeUndefined();
    const states = (id: number) => Array.from({ length: game.state.tick - T0 }, (_, k) => game.flyerAt(id, T0 + k)!.state);
    // Each released flyer landed once, where it was heading; onB flew again once its lockout ended, on the restored mark.
    expect(game.moments("landing", onB)).toHaveLength(1);
    expect(game.moments("takeoff", onB)).toEqual([T0, game.moments("landing", onB)[0]! + LOCKOUT]);
    expect(game.moments("landing", onA)).toHaveLength(1);
    expect(game.moments("landing", onC)).toEqual([]);
    expect(states(onC).every((s) => s === "flying")).toBe(true);
    expect(states(onB)).toContain("lockedOut");
  });

  it("keeps a lockout on the stream while PATROL, LINE and GATHER marks re-claim the flyer and are re-counted, re-cast and moved", () => {
    for (const change of ["count", "caste", "move"] as const) {
      for (const verb of ["PATROL", "LINE", "GATHER"] as const) {
        const label = `${verb} ${change}`;
        const state = scene();
        const id = flyer(state, 0, 38, 40);
        const attack = mark(state, "ATTACK", 40, 40);
        const game = new StreamedMatch(state);
        for (let i = 0; i < 3; i++) game.tick();
        const landed = game.moments("landing", id)[0]!;
        while (game.state.tick < landed + 10) game.tick();
        const line = (x: number, y: number) => (verb === "LINE" ? { toTileX: x + 4, toTileY: y } : {});
        game.tick([remove(attack.id), command(verb, 44, 44, line(44, 44))]);
        const next = game.state.marks.at(-1)!;
        while (game.state.tick < landed + 20) game.tick();
        game.tick([change === "count" ? command(verb, 44, 44, { count: 3, ...line(44, 44) })
          : change === "caste" ? command(verb, 44, 44, { caste: "soldier", ...line(44, 44) })
          : command(verb, 46, 46, { markId: next.id, ...line(46, 46) })]);
        while (game.state.tick < landed + LOCKOUT + 10) game.tick();
        for (let t = landed; t < landed + LOCKOUT; t++) expect(game.flyerAt(id, t), `${label}, tick ${t}`).toEqual({ state: "lockedOut", takeOffTick: landed + LOCKOUT });
        // Re-cast released it: it finishes its lockout on the ground and stays there. Otherwise it flies at its take-off tick.
        expect(game.flyerAt(id, landed + LOCKOUT)?.state, label).toBe(change === "caste" ? "grounded" : "flying");
        expect(game.moments("takeoff", id), label).toEqual(change === "caste" ? [T0] : [T0, landed + LOCKOUT]);
      }
    }
  });

  it("streams each LINE flyer's spot on every tick as sight, members and count change: ends seen by scouts, the middle unseen", () => {
    // The LINE rule's own check is the engine's; here the stream carries each flyer's spot as the rule gave it.
    const terrain: Terrain = { mapId: "test", mapName: "test",
      water: [{ x: 86, y: 30, width: 10, height: 37 }], rocks: [{ x: 60, y: 40, width: 6, height: 17, appearance: 0 }] };
    const state = scene(terrain);
    const A = { x: 8, y: 48 }, B = { x: 118, y: 48 }, HOME = { x: 8, y: 52 };
    // Scouts held on DEFEND marks at both ends; the middle is unseen.
    for (const end of [A, B]) {
      mark(state, "DEFEND", end.x, end.y, { caste: "worker" });
      addAnt(state, 0, end.x, end.y);
    }
    const scoutB = state.ants.at(-1)!.id;
    for (let i = 0; i < 5; i++) flyer(state, 0, HOME.x, HOME.y);
    const order = (count: number): SimInput => command("LINE", A.x, A.y, { toTileX: B.x, toTileY: B.y, count });
    const game = new StreamedMatch(state);
    const members = () => game.state.ants.filter((ant) => ant.claim === game.state.marks.find((m) => m.verb === "LINE")?.id);
    for (let t = 0; t < 220; t++) {
      const inputs: SimInput[] = [];
      if (t === 0) inputs.push(order(5));
      // A member killed, the count raised to 6 (two more flyers wait at home), lowered to 3, and one end's scout killed.
      if (t === 10) game.state.ants = game.state.ants.filter((ant) => ant.id !== members()[2]!.id);
      if (t === 20) { for (let i = 0; i < 2; i++) flyer(game.state, 0, HOME.x, HOME.y); inputs.push(order(6)); }
      if (t === 30) inputs.push(order(3));
      if (t === 40) game.state.ants = game.state.ants.filter((ant) => ant.id !== scoutB);
      game.tick(inputs);
      if (t === 0 || t === 10 || t === 20 || t === 30) expect(members().length, `tick ${t}`).toBe([5, 4, 6, 3][[0, 10, 20, 30].indexOf(t)]);
    }
    // By the end the three left hover on their spots.
    const last = game.state.tick - 1;
    expect(members().map((ant) => game.flyerAt(ant.id, last)!.state)).toEqual(["hovering", "hovering", "hovering"]);
  });

  it("streams a LINE flyer that sees no land keeping its last spot, and a released one flying on to that spot and landing on it", () => {
    // A lake across the whole map between the flyer and its LINE, seen at first by scouts held on DEFEND marks at both ends.
    const lake: Terrain = { mapId: "test", mapName: "test", water: [{ x: 30, y: 0, width: 60, height: 96 }] };
    const spot = { destX: toStream(tileCentre(95)), destY: toStream(tileCentre(48)) };
    for (const ending of ["kept", "released"] as const) {
      const state = scene(lake);
      const scouts = [40, 56].map((y) => {
        mark(state, "DEFEND", 95, y, { caste: "worker" });
        return addAnt(state, 0, 95, y).id;
      });
      const id = flyer(state, 0, 25, 48);
      const game = new StreamedMatch(state);
      // An accepted LINE order of count 1 between the scouts: its one spot is the middle, (95, 48).
      game.tick([command("LINE", 95, 40, { toTileX: 95, toTileY: 56 })]);
      const line = game.state.marks.find((m) => m.verb === "LINE")!.id;
      expect(game.spotGiven(id), ending).toEqual({ x: tileCentre(95), y: tileCentre(48) });
      expect(game.flyerAt(id, T0), ending).toEqual({ state: "flying", ...spot });
      while (antById(game.state, id)!.x < tileCentre(60)) game.tick();
      // The scouts die: over open water the flyer itself sees no land at all.
      game.state.ants = game.state.ants.filter((ant) => !scouts.includes(ant.id));
      const blindFrom = game.state.tick;
      if (ending === "released") {
        // Released while it sees no land: it flies on to the spot it held, lands there and starts its lockout.
        game.tick([remove(line)]);
        expect(antById(game.state, id)!.air?.released).toBe(true);
        while (game.moments("landing", id).length === 0 && game.state.tick < blindFrom + 60) game.tick();
        const landed = game.moments("landing", id);
        expect(landed).toHaveLength(1);
        const L = landed[0]!;
        for (let t = blindFrom; t < L; t++) expect(game.flyerAt(id, t), `released, tick ${t}`).toEqual({ state: "flying", ...spot });
        const landing = game.recorded.flatMap((m) => m.events).find((e) => e.kind === "landing" && e.antId === id);
        expect(landing).toMatchObject({ x: spot.destX, y: spot.destY });
        expect(antById(game.state, id)).toMatchObject({ x: tileCentre(95), y: tileCentre(48) });
        while (game.state.tick <= L + LOCKOUT + 2) game.tick();
        for (let t = L; t < L + LOCKOUT; t++) expect(game.flyerAt(id, t), `released, tick ${t}`).toEqual({ state: "lockedOut", takeOffTick: L + LOCKOUT });
        // No order claims it again: it finishes its lockout on the ground and stays there.
        expect(game.flyerAt(id, L + LOCKOUT + 2)).toEqual({ state: "grounded" });
        continue;
      }
      // Still claimed, the LINE rule gives it no spot while no land is in its colony's sight: it keeps its last one.
      let blind = 0;
      while (blind < 60) {
        game.tick();
        if (game.spotGiven(id) !== null) break;
        blind++;
        expect(antById(game.state, id)!.claim, `kept, tick ${game.state.tick - 1}`).toBe(line);
        expect(game.flyerAt(id, game.state.tick - 1), `kept, tick ${game.state.tick - 1}`).toEqual({ state: "flying", ...spot });
      }
      // Blind from x 60 until land at x 90 is within its sight: about 18 tiles of flight.
      expect(blind).toBeGreaterThan(15);
      // Land comes into sight again: its spot follows the seen land to the middle of the LINE, where it hovers, never landing.
      while (game.flyerAt(id, game.state.tick - 1)!.state !== "hovering" && game.state.tick < blindFrom + 120) game.tick();
      expect(game.flyerAt(id, game.state.tick - 1)).toEqual({ state: "hovering", ...spot });
      expect(game.moments("landing", id)).toEqual([]);
    }
  });
});
