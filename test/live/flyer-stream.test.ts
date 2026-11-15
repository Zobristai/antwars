// Flyers on the spectator stream (version 28). Live is the recorder fed step outputs; recorded is the same messages
// decoded from the bytes a recording stores. The flights are scripted step outputs that follow the flight engine's
// phase timing: a flyer taking off on tick t is airborne on t, one landing on t is on the ground on t with
// takeOffTick t + its lockout, and a tick is processed once the state's tick has passed it.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FLYER_STREAM_VERSION, RULES28_STREAM_VERSION, STREAM_COUNT_CASTES, decodeMessage, encodeMessage, encodeReplayMessage,
  type StreamEvent, type StreamFlyer, type StreamMark, type StreamMessage,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState, type TickRecord } from "../../src/live/model.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { FLYER_RULES, SUB, rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { tileCentre } from "../../src/sim/geometry.ts";
import { cloneState, createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { Agent, Ant, SimEvent, SimInput, SimState } from "../../src/sim/types.ts";
import { HISTORICAL_CONFIG, addAnt, emptyMatch } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

/** The lockout after a landing, in ticks (3 s at 10 ticks a second). */
const LOCKOUT = FLYER_RULES.lockoutTicks;
/** Flight speed in the sim's sub-tile units per tick: 8 tiles a second at 10 ticks a second. */
const SPEED = (FLYER_RULES.speedTilesPerSecond * SUB) / HISTORICAL_CONFIG.ticksPerSecond;

type Point = readonly [number, number];
const centre = (tx: number, ty: number): Point => [tileCentre(tx), tileCentre(ty)];

/** What a scripted flyer is told to do on a tick: fly to a point, then hover there, land there or go on. */
interface Order { readonly to: Point; readonly arrive: "hover" | "land" | "pass"; readonly released?: true }
type Script = (tick: number, ant: Ant) => Order | null;

/**
 * One scripted step: each scripted flyer takes off when it has an order and is free to (not locked out), moves
 * straight toward its order's point at SPEED, hovers there or lands there on arrival, and pushes its take-off and
 * landing events; extra events are added as given.
 */
function scriptedStep(state: SimState, scripts: ReadonlyMap<number, Script>, extra: (tick: number) => SimEvent[] = () => []) {
  const next = cloneState(state);
  const t = state.tick;
  const events: SimEvent[] = [];
  for (const ant of next.ants) {
    const script = scripts.get(ant.id);
    if (script === undefined) continue;
    ant.vx = 0; ant.vy = 0;
    const order = script(t, ant);
    const tile = () => ({ tick: t, tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) });
    if (ant.air === undefined) {
      if (order === null || (ant.takeOffTick !== undefined && t < ant.takeOffTick)) continue;
      events.push({ type: "flyer_takeoff", antId: ant.id, colony: ant.colony, ...tile() });
    }
    if (order === null) throw new Error("an airborne scripted flyer needs an order");
    const [dx, dy] = [order.to[0] - ant.x, order.to[1] - ant.y];
    const distance = Math.hypot(dx, dy);
    const hovering = distance === 0 && order.arrive === "hover";
    if (!hovering && distance > 0) {
      const stepLength = Math.min(SPEED, distance);
      ant.vx = (dx / distance) * stepLength; ant.vy = (dy / distance) * stepLength;
      ant.x = distance <= SPEED ? order.to[0] : ant.x + ant.vx;
      ant.y = distance <= SPEED ? order.to[1] : ant.y + ant.vy;
    }
    if (order.arrive === "land" && ant.x === order.to[0] && ant.y === order.to[1]) {
      delete ant.air;
      ant.takeOffTick = t + LOCKOUT;
      ant.holdPoint = { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
      events.push({ type: "flyer_landing", antId: ant.id, colony: ant.colony, ...tile() });
      continue;
    }
    ant.air = { destX: order.to[0], destY: order.to[1], hovering, released: order.released === true };
  }
  next.tick = t + 1;
  return { state: next, events: [...events, ...extra(t)], results: [] };
}

interface Run { readonly states: SimState[]; readonly records: TickRecord[]; readonly opening: StreamMessage }

/** Record a scripted match: states[k] and records[k] are the state and record at message tick k. */
function runScripted(initial: SimState, ticks: number, scripts: ReadonlyMap<number, Script>, extra?: (tick: number) => SimEvent[]): Run {
  const recorder = new SpectatorRecorder(initial);
  const opening = { ...recorder.initial(), full: recorder.initialFull() };
  const states = [cloneState(initial)];
  const records = [recorder.initial()];
  let state = initial;
  for (let k = 0; k < ticks; k++) {
    const out = scriptedStep(state, scripts, extra);
    state = out.state;
    states.push(state);
    records.push(recorder.record(out));
  }
  return { states, records, opening };
}

const delta = (record: TickRecord): StreamMessage => ({ ...record, full: null });
/** The record as a recording reads it back: its stored bytes, decoded. */
const recorded = (record: TickRecord) => decodeMessage(encodeMessage(delta(record)));
const toStream = (v: number) => Math.round((v * 256) / SUB);
const flyerOf = (message: { ants: StreamMessage["ants"] }, antId: number): StreamFlyer | null | undefined =>
  message.ants.flyers?.[message.ants.id.indexOf(antId)];
const positionOf = (message: { ants: StreamMessage["ants"] }, antId: number): Point => {
  const i = message.ants.id.indexOf(antId);
  return [message.ants.x[i]!, message.ants.y[i]!];
};

// The A/B/C flight: take-off at A toward a GATHER hover, hover from B, re-ordered onto an ATTACK mark at D, landing
// there at C. Flying 8 tiles takes 10 ticks: A to A + 9, then D to D + 9 = C.
const A = 3, B = 13, D = 20, C = 29;
const GATHER = centre(13, 10), ATTACK = centre(13, 18);

function abcMatch() {
  const initial = emptyMatch(0, HISTORICAL_CONFIG);
  const flyer = addAnt(initial, 0, 5, 10, { flyer: true });
  // An enemy flyer taking off at tick 0 to hover over its own tile, beside the GATHER hover: the two bite in the air.
  const enemy = addAnt(initial, 1, 14, 10, { flyer: true });
  // A ground worker beside the ATTACK mark, which bites the landed flyer.
  const worker = addAnt(initial, 1, 14, 18);
  const scripts = new Map<number, Script>([
    // Once landed it stays on the ground: no later order flies it again.
    [flyer.id, (t, ant) => t < A || (ant.air === undefined && ant.takeOffTick !== undefined) ? null
      : t < D ? { to: GATHER, arrive: "hover" } : { to: ATTACK, arrive: "land" }],
    [enemy.id, () => ({ to: centre(14, 10), arrive: "hover" })],
    [worker.id, () => null],
  ]);
  const fights = (t: number): SimEvent[] => [
    ...(t >= B && t < D ? [
      { type: "fight", tick: t, tileX: 13, tileY: 10, antId: flyer.id, targetId: enemy.id, colony: 0, air: true },
      { type: "fight", tick: t, tileX: 14, tileY: 10, antId: enemy.id, targetId: flyer.id, colony: 1, air: true },
    ] as const : []),
    ...(t === C + 5 ? [{ type: "fight", tick: t, tileX: 14, tileY: 18, antId: worker.id, targetId: flyer.id, colony: 1 }] as const : []),
  ];
  return { run: runScripted(initial, C + LOCKOUT + 6, scripts, fights), flyer: flyer.id, enemy: enemy.id, worker: worker.id };
}

describe("flyers on the spectator stream", () => {
  it("is a new version above the rules-28 marker's, with flyer appended to the count-mark castes", () => {
    expect(FLYER_STREAM_VERSION).toBe(RULES28_STREAM_VERSION + 1);
    expect(STREAM_COUNT_CASTES).toEqual(["any", "worker", "soldier", "flyer"]);
  });

  it("reads flying from A, hovering from B, locked out from C with take-off tick C+30, and grounded from C+30", () => {
    const { run, flyer } = abcMatch();
    // Message tick k carries the state once tick k - 1 is processed.
    const states = run.records.map((record) => recorded(record)).map((message) => flyerOf(message, flyer)!.state);
    const firstAt = (state: string, from = 0) => states.findIndex((s, k) => k >= from && s === state) - 1;
    expect(firstAt("flying")).toBe(A);
    expect(firstAt("hovering")).toBe(B);
    expect(firstAt("lockedOut")).toBe(C);
    expect(firstAt("grounded", C + 1)).toBe(C + LOCKOUT);
    for (const [k, state] of states.entries()) {
      const t = k - 1;
      expect(state, `tick ${t}`).toBe(t < A ? "grounded" : t < B ? "flying" : t < D ? "hovering" : t < C ? "flying" : t < C + LOCKOUT ? "lockedOut" : "grounded");
    }
    const lockedOut = run.records.slice(C + 1, C + LOCKOUT + 1).map((record) => flyerOf(recorded(record), flyer));
    expect(lockedOut).toEqual(Array(LOCKOUT).fill({ state: "lockedOut", takeOffTick: C + LOCKOUT }));
  });

  it("matches each flyer's streamed state to its motion every tick: never hovering while moving or flying while grounded", () => {
    const { run, flyer, enemy } = abcMatch();
    for (let k = 1; k < run.records.length; k++) {
      const [before, now] = [recorded(run.records[k - 1]!), recorded(run.records[k]!)];
      for (const id of [flyer, enemy]) {
        const ant = run.states[k]!.ants.find((a) => a.id === id)!;
        const f = flyerOf(now, id)!;
        const moved = positionOf(now, id).some((v, axis) => v !== positionOf(before, id)[axis]);
        const where = `ant ${id} on tick ${k - 1}`;
        expect(f.state === "flying" || f.state === "hovering", where).toBe(ant.air !== undefined);
        if (f.state === "hovering") expect(moved, where).toBe(false);
        if (f.state === "flying") expect(moved, where).toBe(true);
        if (ant.air !== undefined) expect([f.destX, f.destY], where).toEqual([toStream(ant.air.destX), toStream(ant.air.destY)]);
        else expect(f, where).not.toHaveProperty("destX");
      }
    }
  });

  it("carries take-offs, landings and air fights, and a ground fight without the air flag", () => {
    const { run, flyer, enemy, worker } = abcMatch();
    const events = run.records.flatMap((record) => recorded(record).events.map((event) => ({ tick: record.tick - 1, event })));
    const flights = events.filter(({ event }) => event.kind === "takeoff" || event.kind === "landing");
    expect(flights).toEqual([
      { tick: 0, event: { kind: "takeoff", antId: enemy, colony: 1, x: toStream(tileCentre(14)), y: toStream(tileCentre(10)) } },
      // At its position once the tick is done: one step along its row from the tile it left.
      { tick: A, event: { kind: "takeoff", antId: flyer, colony: 0, x: toStream(tileCentre(5) + SPEED), y: toStream(tileCentre(10)) } },
      { tick: C, event: { kind: "landing", antId: flyer, colony: 0, x: toStream(ATTACK[0]), y: toStream(ATTACK[1]) } },
    ]);
    const fights = events.filter(({ event }) => event.kind === "fight");
    expect(fights.filter(({ event }) => event.kind === "fight" && event.air === true)).toHaveLength(2 * (D - B));
    expect(fights.filter(({ event }) => event.kind === "fight" && event.air === undefined)).toEqual([
      { tick: C + 5, event: { kind: "fight", antId: worker, targetId: flyer, colony: 1, tileX: 14, tileY: 18 } },
    ]);
  });

  it("decodes every recorded message to exactly what the recorder sent live, with no flyer entry for any other ant", () => {
    const { run, worker } = abcMatch();
    for (const record of run.records) {
      const bytes = encodeMessage(delta(record));
      expect(bytes[2]).toBe(FLYER_STREAM_VERSION);
      const message = decodeMessage(bytes);
      expect(message.ants.flyers).toEqual(record.ants.flyers);
      expect(message.events).toEqual(record.events);
      expect(Array.from(message.ants.x)).toEqual(Array.from(record.ants.x));
      expect(flyerOf(message, worker)).toBeNull();
    }
    const opening = decodeMessage(encodeReplayMessage(run.opening));
    expect(opening.ants.flyers).toEqual(run.opening.ants.flyers);
  });

  it("carries no lifetime: a flyer's entry is its state, its take-off tick when locked out and its destination when airborne", () => {
    const { run } = abcMatch();
    for (const record of run.records) {
      for (const f of recorded(record).ants.flyers ?? []) {
        if (f === null) continue;
        const fields = f.state === "lockedOut" ? ["state", "takeOffTick"] : f.state === "grounded" ? ["state"] : ["state", "destX", "destY"];
        expect(Object.keys(f).sort()).toEqual(fields.sort());
      }
    }
    // On the wire a grounded flyer costs its flag bit and one state byte, nothing else.
    const ants = run.records[1]!.ants;
    const length = (flyer: (i: number) => boolean) => encodeMessage({ tick: 1, full: null, events: [],
      ants: { ...ants, flyers: Array.from({ length: ants.count }, (_, i) => (flyer(i) ? { state: "grounded" as const } : null)) } }).length;
    expect(length(() => true) - length((i) => i === 0)).toBe(ants.count - 1);
  });

  it("lets a viewer joining mid-flight place every airborne flyer and its destination from its first message alone", () => {
    const { run, flyer, enemy } = abcMatch();
    const join = 8; // tick 7 processed: the flyer is on its way to the GATHER hover, the enemy hovers.
    // The hub's board at the playback position, built from the stream as it went out, then sent to the newcomer.
    const first = decodeMessage(encodeMessage(run.opening));
    const board = new SpectatorState(first.full!, first.tick, first.ants);
    for (const record of run.records.slice(1, join + 1)) board.apply(recorded(record));
    for (const bytes of [encodeMessage(board.message()), encodeReplayMessage(board.message())]) {
      const message = decodeMessage(bytes);
      expect(message.tick).toBe(join);
      const airborne = message.ants.flyers!.flatMap((f, i) => f !== null && (f.state === "flying" || f.state === "hovering")
        ? [{ antId: message.ants.id[i]!, state: f.state, at: [message.ants.x[i]!, message.ants.y[i]!], to: [f.destX, f.destY] }] : []);
      expect(airborne).toEqual([
        { antId: flyer, state: "flying", at: [toStream(tileCentre(5) + SPEED * (join - A)), toStream(tileCentre(10))], to: GATHER.map(toStream) },
        { antId: enemy, state: "hovering", at: centre(14, 10).map(toStream), to: centre(14, 10).map(toStream) },
      ]);
    }
  });
});

describe("displayed states through flyer orders", () => {
  // A flyer PATROL between two waypoints, cancelled mid-leg; a LINE flyer whose spot moves; each read every tick.
  const W0 = centre(40, 40), W1 = centre(48, 40);
  const CANCEL = 25;
  const SPOT = centre(60, 44), MOVED_SPOT = centre(64, 44);
  function ordersMatch() {
    const initial = emptyMatch(0, HISTORICAL_CONFIG);
    const patrol = addAnt(initial, 0, 40, 40, { flyer: true });
    const line = addAnt(initial, 0, 60, 40, { flyer: true });
    let heading: Point = W1;
    const scripts = new Map<number, Script>([
      // Sweeps from waypoint to waypoint without pausing; once released it flies on to the waypoint it was heading for and lands.
      [patrol.id, (t, ant) => {
        if (t < 2) return null;
        if (ant.air === undefined && ant.takeOffTick !== undefined) return null;
        if (t >= CANCEL) return { to: heading, arrive: "land", released: true };
        if (ant.x === heading[0] && ant.y === heading[1]) heading = heading === W1 ? W0 : W1;
        return { to: heading, arrive: "pass" };
      }],
      [line.id, (t) => t < 2 ? null : { to: t < 15 ? SPOT : MOVED_SPOT, arrive: "hover" }],
    ]);
    return { run: runScripted(initial, 70, scripts), patrol: patrol.id, line: line.id };
  }

  it("streams each flyer's current waypoint, spot or fixed destination, and a state that matches its motion", () => {
    const { run, patrol, line } = ordersMatch();
    const read = run.records.map((record) => recorded(record));
    const at = (antId: number, tick: number) => flyerOf(read[tick + 1]!, antId);
    // The patrol flyer reaches W1 on tick 11 and heads straight back to W0, arrives on 21 and turns again, without hovering.
    expect(at(patrol, 2)).toEqual({ state: "flying", destX: toStream(W1[0]), destY: toStream(W1[1]) });
    expect(at(patrol, 12)).toEqual({ state: "flying", destX: toStream(W0[0]), destY: toStream(W0[1]) });
    expect(at(patrol, 22)).toEqual({ state: "flying", destX: toStream(W1[0]), destY: toStream(W1[1]) });
    expect(read.some((message) => flyerOf(message, patrol)?.state === "hovering")).toBe(false);
    // Cancelled on tick 25 with W1 its fixed destination, it lands there on tick 31 and is locked out.
    expect(at(patrol, CANCEL)).toEqual({ state: "flying", destX: toStream(W1[0]), destY: toStream(W1[1]) });
    expect(at(patrol, 31)).toEqual({ state: "lockedOut", takeOffTick: 31 + LOCKOUT });
    expect(at(patrol, 31 + LOCKOUT)).toEqual({ state: "grounded" });
    expect(positionOf(read[32]!, patrol)).toEqual(W1.map(toStream));
    // The LINE flyer flies to its spot, hovers over it, then flies to the spot's new place and hovers there.
    expect(at(line, 6)).toEqual({ state: "flying", destX: toStream(SPOT[0]), destY: toStream(SPOT[1]) });
    expect(at(line, 7)).toEqual({ state: "hovering", destX: toStream(SPOT[0]), destY: toStream(SPOT[1]) });
    expect(at(line, 15)).toEqual({ state: "flying", destX: toStream(MOVED_SPOT[0]), destY: toStream(MOVED_SPOT[1]) });
    expect(at(line, 20)).toEqual({ state: "hovering", destX: toStream(MOVED_SPOT[0]), destY: toStream(MOVED_SPOT[1]) });
    for (let k = 1; k < read.length; k++) {
      for (const id of [patrol, line]) {
        const f = flyerOf(read[k]!, id)!;
        const moved = positionOf(read[k]!, id).some((v, axis) => v !== positionOf(read[k - 1]!, id)[axis]);
        const ant = run.states[k]!.ants.find((a) => a.id === id)!;
        expect(f.state === "hovering" ? !moved : f.state === "flying" ? moved : ant.air === undefined, `ant ${id} on tick ${k - 1}`).toBe(true);
        if (ant.air !== undefined) expect([f.destX, f.destY]).toEqual([toStream(ant.air.destX), toStream(ant.air.destY)]);
      }
    }
  });
});

describe("flyer marks on the stream", () => {
  it("sends a flyer mark as caste flyer, and re-sends it moved with its new tile, id and laid tick, at the flyer version", () => {
    const config: SimConfig = { ...rulesConfig("redesign"), flyers: FLYER_RULES, startAnts: 0, squadSize: 0, terrain: undefined,
      foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, combatGraceTicks: 99_999, earlyWin: undefined };
    let state = emptyMatch(100, config);
    const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
      order: { kind: "hold" }, lastCallTick: 100, lastCommandTick: null, idle: false, pendingEvents: [] };
    state.agents.push(agent);
    addAnt(state, 0, 40, 40, { caste: "worker" }); // A scout: the marks' tiles are in the colony's sight.
    const recorder = new SpectatorRecorder(state);
    const markEvents = (inputs: SimInput[]) => {
      const out = step(state, inputs);
      state = out.state;
      const bytes = encodeMessage(delta(recorder.record(out)));
      return { version: bytes[2], marks: decodeMessage(bytes).events.filter((e) => e.kind === "mark") };
    };
    const laid = markEvents([{ type: "count_mark", agentId: "a", verb: "GATHER", caste: "flyer", count: 2, tileX: 40, tileY: 40 }]);
    expect(laid.version).toBe(FLYER_STREAM_VERSION);
    expect(laid.marks).toEqual([{ kind: "mark", mark: expect.objectContaining({ caste: "flyer", tileX: 40, tileY: 40, revision: 0 }) }]);
    const { id, laidTick } = (laid.marks[0] as Extract<StreamEvent, { kind: "mark" }>).mark;
    const moved = markEvents([{ type: "count_mark", agentId: "a", verb: "GATHER", markId: id, count: 3, tileX: 44, tileY: 42 }]);
    expect(moved.version).toBe(FLYER_STREAM_VERSION);
    expect(moved.marks).toEqual([{ kind: "mark", mark: expect.objectContaining({ id, laidTick, caste: "flyer", tileX: 44, tileY: 42, count: 3, revision: 1 }) }]);
  });
});

describe("messages without flyers", () => {
  // A historical match through real steps (fights, marks, squads), then one message with a soldier PATROL mark and a
  // ground fight. Their bytes as the encoder wrote them before flyers: count, total length, versions and SHA-256.
  const BEFORE_FLYERS = { messages: 1502, bytes: 931866, versions: [18, 4, 13], sha256: "72fce0f22afd9ad3e483182abd0fdf81cb41a6b7d873d2c07c52f897da5c8d21" };
  function withoutFlyers(): Uint8Array[] {
    const o: ScriptOptions = { seed: 6007, config: playable(HISTORICAL_CONFIG), agents: 4, ticks: 1500, attack: true };
    let state = createMatch(o.seed, o.config);
    const recorder = new SpectatorRecorder(state);
    const payloads = [encodeReplayMessage({ ...recorder.initial(), full: recorder.initialFull() })];
    for (let t = 0; t < o.ticks && state.result === null; t++) {
      const out = step(state, scriptedInputs(state, o));
      state = out.state;
      payloads.push(encodeMessage(delta(recorder.record(out))));
    }
    const mark: StreamMark = { id: 3, agent: 0, colony: 1, tileX: 9, tileY: 30, words: [], laidTick: 4, answered: 0,
      verb: "PATROL", count: 4, claimed: 1, revision: 2, caste: "soldier" };
    const events: StreamEvent[] = [{ kind: "fight", antId: 4, targetId: 9, colony: 0, tileX: 9, tileY: 30 }, { kind: "mark", mark }];
    payloads.push(encodeMessage({ tick: state.tick, ants: recorder.initial().ants, full: null, events }));
    return payloads;
  }

  it("keeps its version and bytes", () => {
    const payloads = withoutFlyers();
    const hash = createHash("sha256");
    for (const payload of payloads) hash.update(payload);
    expect({ messages: payloads.length, bytes: payloads.reduce((n, p) => n + p.length, 0), versions: [...new Set(payloads.map((p) => p[2]))],
      sha256: hash.digest("hex") }).toEqual(BEFORE_FLYERS);
    for (const payload of payloads) expect(decodeMessage(payload).ants).not.toHaveProperty("flyers");
  });

  it("refuses flyer fields in a message written below the flyer version", () => {
    const takeoff = encodeMessage({ tick: 1, ants: emptyAnts(), full: null, events: [{ kind: "takeoff", antId: 1, colony: 0, x: 5, y: 5 }] });
    expect(takeoff[2]).toBe(FLYER_STREAM_VERSION);
    const older = takeoff.slice(); older[2] = RULES28_STREAM_VERSION;
    expect(() => decodeMessage(older)).toThrow("take-off and landing events need version 28");
    const mark: StreamMark = { id: 1, agent: 0, colony: 0, tileX: 2, tileY: 2, words: [], laidTick: 0, answered: 0, verb: "GATHER", count: 1, caste: "flyer" };
    const flyerMark = encodeMessage({ tick: 1, ants: emptyAnts(), full: null, events: [{ kind: "mark", mark }] });
    const olderMark = flyerMark.slice(); olderMark[2] = RULES28_STREAM_VERSION;
    expect(() => decodeMessage(olderMark)).toThrow("unknown count-mark caste");
  });

  it("refuses a flyer entry whose fields do not match its state, rather than dropping them", () => {
    const ants = { ...emptyAnts(1), flyers: [{ state: "flying" as const }] };
    expect(() => encodeMessage({ tick: 1, ants, full: null, events: [] })).toThrow("stream flyer fields do not match its state flying");
    const lockedOut = { ...emptyAnts(1), flyers: [{ state: "grounded" as const, takeOffTick: 4 }] };
    expect(() => encodeMessage({ tick: 1, ants: lockedOut, full: null, events: [] })).toThrow("stream flyer fields do not match its state grounded");
  });
});

function emptyAnts(count = 0): StreamMessage["ants"] {
  return { count, id: Uint32Array.from({ length: count }, (_, i) => i + 1), x: new Uint16Array(count), y: new Uint16Array(count),
    heading: new Uint8Array(count), colony: new Uint8Array(count), agent: new Int16Array(count).fill(-1) };
}
