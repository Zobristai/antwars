/**
 * The SSE smoke test: a client
 * connected to /live/:match for a running in-process match first receives a
 * full snapshot, then one message per tick carrying every ant with its agent
 * and squad plus the step's events; a client connecting mid-match decodes the
 * whole board, the roster and the death count from its first message alone.
 * The stream also carries each ant's carrying flag, the food on every
 * tile and each colony's store and next hatch tick, sent on change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES_V4_CONFIG, SUB, rulesConfig } from "../../src/sim/config.ts";
import { HISTORICAL_CONFIG as DEFAULT_CONFIG } from "../sim/fixtures.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { hatch } from "../../src/sim/forage.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { CALL_KINDS, decodeMessage, encodeMessage, GRID_SCALE_STREAM_VERSION, HOUSE_IDLE_STREAM_VERSION, isIdle, STREAM_VERSION, SUB_TILE, type StreamEvent, type StreamMessage, type StreamStore } from "../../src/live/format.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder, SpectatorState, storesOf } from "../../src/live/model.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";

import { playable } from "../playable.ts";
// Seed 6007 since squads start on forage: with new squads starting on forage and marks steering no free ants,
// seed 6006 ends by overrun at tick 921, before the mid-match connect below (tick 950 or later).
const SCRIPT: ScriptOptions = { seed: 6007, config: playable(DEFAULT_CONFIG), agents: 10, ticks: DEFAULT_CONFIG.matchTicks, attack: true };
/** Joins at tick 0 and never calls again, so it is idle once the squad timer runs out. */
const LAZY = "agent-lazy";

/** What the sim says at one tick, kept for comparison with what the stream delivered. */
interface Truth {
  ids: number[];
  agentOf: number[];
  carrying: number[];
  food: Uint32Array;
  stores: [StreamStore, StreamStore];
}

interface Run {
  early: SseClient;
  late: SseClient;
  lateTick: number;
  lateState: SimState;
  /** Each agent's latest intent line as of the mid-match connect. */
  intents: Map<string, string>;
  truth: Map<number, Truth>;
  final: SimState;
}

let run: Run;
let server: RecordedServer;
let hub: LiveHub;

function truthOf(state: SimState): Truth {
  const ants = state.ants.slice().sort((a, b) => a.id - b.id);
  const index = new Map(state.agents.map((a, i) => [a.id, i]));
  return {
    ids: ants.map((a) => a.id),
    agentOf: ants.map((a) => (a.squad === null ? -1 : index.get(a.squad)!)),
    carrying: ants.map((a) => (a.carrying ? 1 : 0)),
    food: Uint32Array.from(state.food),
    stores: storesOf(state),
  };
}

beforeAll(async () => {
  const clock = new ManualClock();
  hub = new LiveHub({ config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 }, clock });
  server = new RecordedServer(hub, clock);
  await server.listen();

  let state = createMatch(SCRIPT.seed, playable(SCRIPT.config));
  hub.startMatch(1, state);
  const early = await SseClient.connect(server.url("/live/1"));
  const earlyServed = await served(server, 1);

  const truth = new Map<number, Truth>([[0, truthOf(state)]]);
  const intents = new Map<string, string>();
  let late: SseClient | null = null;
  let lateTick = -1;
  let lateState: SimState | null = null;
  let lateIntents = new Map<string, string>();
  while (state.result === null) {
    const inputs: SimInput[] = scriptedInputs(state, SCRIPT);
    if (state.tick === 0) inputs.push({ type: "join", agentId: LAZY, modelLabel: "lazy-model" });
    for (const input of inputs) if (input.type === "order") intents.set(input.agentId, input.intent ?? "");
    const out = step(state, inputs);
    hub.pushTick(1, out);
    clock.advance(100);
    state = out.state;
    truth.set(state.tick, truthOf(state));
    // Connect mid-match once the lazy agent is idle and an overrun is under way.
    if (late === null && state.tick >= 950 && state.colonies.some((c) => c.overrunTicks > 0)) {
      late = await SseClient.connect(server.url("/live/1"));
      await delivered(late, await served(server, 2));
      lateTick = state.tick;
      lateState = structuredClone(state);
      lateIntents = new Map(intents);
    }
    if (state.tick % 100 === 0) await delivered(early, earlyServed);
  }
  await delivered(early, earlyServed);
  if (late === null || lateState === null) throw new Error("no mid-match moment with an overrun under way");
  await delivered(late, server.responses[1]!);
  run = { early, late, lateTick, lateState, intents: lateIntents, truth, final: state };
}, 120_000);

afterAll(async () => {
  run?.early.close();
  run?.late.close();
  hub.close();
  await server.close();
});

describe("live stream at /live/:match", () => {
  it("serves an event stream whose first message is a full snapshot of the board", () => {
    const { early } = run;
    expect(early.status).toBe(200);
    expect(early.headers["content-type"]).toBe("text/event-stream");
    const first = early.messages[0]!;
    expect(first.tick).toBe(0);
    expect(first.full).not.toBeNull();
    const f = first.full!;
    // The reference board, doubled at grid scale 2.
    expect(f.setup.gridScale).toBe(2);
    expect(f.setup.mapW).toBe(DEFAULT_CONFIG.mapWidth * 2);
    expect(f.territory.length).toBe(DEFAULT_CONFIG.mapWidth * 2 * DEFAULT_CONFIG.mapHeight * 2);
    expect(first.ants.count).toBe(createMatch(SCRIPT.seed, playable(SCRIPT.config)).ants.length);
    expect(first.ants.count).toBeGreaterThan(0);
    expect(f.result).toBeNull();
  });

  it("then sends one message per tick with every ant, its agent and squad, and no full board", () => {
    const rest = run.early.messages.slice(1);
    expect(rest.map((m) => m.tick)).toEqual(Array.from({ length: run.final.tick }, (_, i) => i + 1));
    let squadAnts = 0;
    for (const m of rest) {
      expect(m.full).toBeNull();
      const t = run.truth.get(m.tick)!;
      expect(Array.from(m.ants.id)).toEqual(t.ids);
      expect(Array.from(m.ants.agent)).toEqual(t.agentOf);
      squadAnts += t.agentOf.filter((a) => a >= 0).length;
    }
    expect(squadAnts).toBeGreaterThan(0);
  });

  it("carries marks laid, fights, deaths, overrun progress, intent lines, joins with model labels, calls and the match end", () => {
    const events = run.early.messages.flatMap((m) => m.events);
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["mark", "fight", "death", "overrun", "order", "join", "call", "end"] as const) expect(kinds, k).toContain(k);
    const joins = events.filter((e): e is Extract<StreamEvent, { kind: "join" }> => e.kind === "join");
    expect(joins.map((j) => j.modelLabel)).toEqual(run.final.agents.map((a) => a.modelLabel ?? ""));
    const orders = events.filter((e): e is Extract<StreamEvent, { kind: "order" }> => e.kind === "order");
    expect(orders.some((o) => o.intent.length > 0)).toBe(true);
    const end = events.find((e): e is Extract<StreamEvent, { kind: "end" }> => e.kind === "end")!;
    expect(end.result.winner).toBe(run.final.result!.winner);
    expect(run.early.messages.at(-1)!.events).toContainEqual(end);
  });

  it("gives a mid-match client the board, squads, intent lines, overrun, roster with idle state and death count in its first message", () => {
    const { late, lateTick, lateState: s } = run;
    const first = late.messages[0]!;
    expect(first.tick).toBe(lateTick);
    expect(first.full).not.toBeNull();
    const f = first.full!;
    // Board: ants with their squads, territory and marks.
    const t = run.truth.get(lateTick)!;
    expect(Array.from(first.ants.id)).toEqual(t.ids);
    expect(Array.from(first.ants.agent)).toEqual(t.agentOf);
    const byId = new Map(s.ants.map((a) => [a.id, a]));
    for (let i = 0; i < first.ants.count; i++) {
      const a = byId.get(first.ants.id[i]!)!;
      expect(Math.abs(first.ants.x[i]! - (a.x * SUB_TILE) / SUB)).toBeLessThanOrEqual(0.5);
      expect(first.ants.colony[i]).toBe(a.colony);
    }
    expect(Array.from(f.territory)).toEqual(s.owner.map((o) => o + 1));
    expect(f.marks.map((m) => [m.id, m.answered]).sort()).toEqual(s.marks.map((m) => [m.id, m.steering]).sort());
    expect(f.marks.length).toBeGreaterThan(0);
    // Roster: every agent with its model label, intent line and idle state.
    expect(f.agents.map((a) => a.modelLabel)).toEqual(s.agents.map((a) => a.modelLabel ?? ""));
    expect(f.agents.map((a) => a.intent)).toEqual(s.agents.map((a) => run.intents.get(a.id) ?? ""));
    const idle = f.agents.map((a) => isIdle(a, first.tick, f.setup.idleTicks));
    expect(idle).toEqual(s.agents.map((a) => a.idle));
    expect(idle[s.agents.findIndex((a) => a.id === LAZY)]).toBe(true);
    expect(idle.filter((x) => !x).length).toBeGreaterThan(0);
    // Overrun in progress and the death count so far.
    expect(f.overrun).toEqual([s.colonies[0].overrunTicks, s.colonies[1].overrunTicks]);
    expect(Math.max(...f.overrun)).toBeGreaterThan(0);
    expect(f.overrunRequired).toBe(DEFAULT_CONFIG.overrunTicks);
    expect(f.deaths).toEqual(s.stats.deaths);
    expect(f.deaths[0] + f.deaths[1]).toBeGreaterThan(0);
    expect(f.result).toBeNull();
    // Its next message is an ordinary per-tick one.
    expect(late.messages[1]!.tick).toBe(lateTick + 1);
    expect(late.messages[1]!.full).toBeNull();
  });

  it("builds the same board from the first full snapshot plus every message since as the mid-match snapshot carries", () => {
    const [first, ...rest] = run.early.messages as [StreamMessage, ...StreamMessage[]];
    const board = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
    for (const m of rest) {
      if (m.tick > run.lateTick) break;
      board.apply(m);
    }
    const late = run.late.messages[0]!.full!;
    expect(board.full.territory).toEqual(late.territory);
    expect(board.full.marks.slice().sort((a, b) => a.id - b.id)).toEqual(late.marks.slice().sort((a, b) => a.id - b.id));
    expect(board.full.agents).toEqual(late.agents);
    expect(board.full.overrun).toEqual(late.overrun);
    expect(board.full.deaths).toEqual(late.deaths);
  });

  it("carries each ant's carrying flag and the food, hatch rule and stores, matching the sim at every tick for early and late joiners", () => {
    const { early, late, lateTick } = run;
    const [first, ...rest] = early.messages as [StreamMessage, ...StreamMessage[]];
    const t0 = run.truth.get(0)!;
    expect(first.full!.food).toEqual(t0.food);
    expect(first.full!.stores).toEqual(t0.stores);
    expect(first.full!.hatch).toEqual({ cost: DEFAULT_CONFIG.hatchCost, intervalTicks: DEFAULT_CONFIG.hatchIntervalTicks, cap: DEFAULT_CONFIG.colonyCap });
    const board = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
    let carried = 0;
    let foodEvents = 0;
    let storeEvents = 0;
    let prev = t0;
    // Plain loops, one assertion at the end: a deep compare of every tile at every tick is too slow.
    const wrong: string[] = [];
    const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    for (const m of rest) {
      board.apply(m);
      const t = run.truth.get(m.tick)!;
      if (!same(m.ants.carrying!, t.carrying)) wrong.push(`carrying at tick ${m.tick}`);
      if (!same(board.full.food!, t.food)) wrong.push(`food at tick ${m.tick}`);
      if (JSON.stringify(board.full.stores) !== JSON.stringify(t.stores)) wrong.push(`stores at tick ${m.tick}`);
      // Switch off: every hatch costs hatchCost, so that is the next cost on every tick.
      if (board.full.stores!.some((st) => st.nextCost !== DEFAULT_CONFIG.hatchCost)) wrong.push(`nextCost at tick ${m.tick}`);
      // Sent on change only: a food event exactly when some tile changed, naming exactly those tiles; a store event per colony that changed.
      const changed: number[] = [];
      for (let i = 0; i < t.food.length; i++) if (t.food[i] !== prev.food[i]) changed.push(i);
      const food = m.events.filter((e): e is Extract<StreamEvent, { kind: "food" }> => e.kind === "food");
      if (!same(food.flatMap((e) => e.tiles), changed)) wrong.push(`food event at tick ${m.tick}`);
      const stores = m.events.filter((e): e is Extract<StreamEvent, { kind: "store" }> => e.kind === "store");
      const storesChanged = ([0, 1] as const).filter(
        (c) => t.stores[c].food !== prev.stores[c].food || t.stores[c].nextHatchTick !== prev.stores[c].nextHatchTick || t.stores[c].nextCost !== prev.stores[c].nextCost,
      );
      if (!same(stores.map((e) => e.colony), storesChanged)) wrong.push(`store events at tick ${m.tick}`);
      for (const c of t.carrying) carried += c;
      foodEvents += food.length;
      storeEvents += stores.length;
      prev = t;
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(carried).toBeGreaterThan(0);
    expect(foodEvents).toBeGreaterThan(0);
    expect(storeEvents).toBeGreaterThan(0);
    // The mid-match joiner's first message carries the same economy as the sim at that tick.
    const lt = run.truth.get(lateTick)!;
    const lf = late.messages[0]!;
    expect(Array.from(lf.ants.carrying!)).toEqual(lt.carrying);
    expect(lf.full!.food).toEqual(lt.food);
    expect(lf.full!.stores).toEqual(lt.stores);
    expect(lf.full!.hatch).toEqual(first.full!.hatch);
  });

  it("answers 404 for a match it is not streaming and serves the current match at /live/current", async () => {
    const missing = await SseClient.connect(server.url("/live/99"));
    expect(missing.status).toBe(404);
    missing.close();
    const current = await SseClient.connect(server.url("/live/current"));
    expect(current.status).toBe(200);
    expect(current.headers["x-antwar-match"]).toBe("1");
    current.close();
  });
});

describe("the economy in the stream format", () => {
  it("round-trips carrying on bit 3 of the bits byte, food tiles and amounts, the hatch rule, stores and food and store events", () => {
    const m: StreamMessage = {
      tick: 7,
      ants: {
        count: 3,
        id: Uint32Array.of(1, 2, 9),
        x: Uint16Array.of(10, 20, 30),
        y: Uint16Array.of(11, 21, 31),
        heading: Uint8Array.of(0, 64, 128),
        colony: Uint8Array.of(0, 1, 1),
        agent: Int16Array.of(-1, 3, -1),
        carrying: Uint8Array.of(1, 1, 0),
      },
      full: {
        setup: { gridScale: 2, mapW: 4, mapH: 3, ticksPerSecond: 10, matchTicks: 100, idleTicks: 50, overrunRadiusTiles: 2, queens: [[8, 8], [40, 24]] },
        territory: new Uint8Array(12),
        marks: [],
        agents: [],
        overrun: [0, 0],
        overrunRequired: 30,
        deaths: [0, 0],
        // Every grid-scale-2 full snapshot carries hatch totals and queens.
        hatched: [0, 0],
        queens: [],
        result: null,
        food: Uint32Array.of(0, 3, 0, 0, 0, 0, 200, 0, 0, 0, 0, 1),
        hatch: { cost: 3, intervalTicks: 18, cap: 150 },
        stores: [
          { food: 7, nextHatchTick: 42, nextCost: 3 },
          { food: 0, nextHatchTick: 0, nextCost: 6 },
        ],
      },
      events: [
        { kind: "food", tiles: [1, 6, 11], amounts: [2, 0, 300] },
        { kind: "store", colony: 1, food: 4, nextHatchTick: 25, nextCost: 6 },
      ],
    };
    const bytes = encodeMessage(m);
    expect(decodeMessage(bytes)).toEqual(m);
    // Bit 2 of the bits byte (another field's) does not read as carrying. Bits start after
    // the 5-byte header, the count, 3 id deltas, 6 u16 positions and 3 headings.
    const bitsAt = 5 + 1 + 3 + 12 + 3;
    expect(Array.from(bytes.subarray(bitsAt, bitsAt + 3))).toEqual([0b1000, 0b1011, 0b0001]);
    const other = bytes.slice();
    for (let i = 0; i < 3; i++) other[bitsAt + i]! |= 4;
    const d = decodeMessage(other);
    expect(Array.from(d.ants.carrying!)).toEqual([1, 1, 0]);
    expect(Array.from(d.ants.colony)).toEqual([0, 1, 1]);
    expect(Array.from(d.ants.agent)).toEqual([-1, 3, -1]);
  });

  it("decodes a sender's message without economy fields with no carrying, no food and empty stores", () => {
    const m: StreamMessage = {
      tick: 1,
      ants: { count: 1, id: Uint32Array.of(5), x: Uint16Array.of(1), y: Uint16Array.of(2), heading: Uint8Array.of(3), colony: Uint8Array.of(1), agent: Int16Array.of(-1) },
      full: {
        setup: { gridScale: 2, mapW: 2, mapH: 2, ticksPerSecond: 10, matchTicks: 100, idleTicks: 50, overrunRadiusTiles: 2, queens: [[1, 1], [9, 9]] },
        territory: new Uint8Array(4),
        marks: [],
        agents: [],
        overrun: [0, 0],
        overrunRequired: 30,
        deaths: [0, 0],
        hatched: [0, 0],
        result: null,
      },
      events: [],
    };
    const d = decodeMessage(encodeMessage(m));
    expect(Array.from(d.ants.carrying!)).toEqual([0]);
    expect(d.full!.food).toEqual(new Uint32Array(4));
    expect(d.full!.hatch).toEqual({ cost: 0, intervalTicks: 0, cap: 0 });
    expect(d.full!.stores).toEqual([
      { food: 0, nextHatchTick: 0, nextCost: 0 },
      { food: 0, nextHatchTick: 0, nextCost: 0 },
    ]);
  });
});

describe("text limits on the stream", () => {
  const cat = "猫"; // 3 bytes in UTF-8
  const smile = "\u{1F600}"; // 4 bytes in UTF-8
  // [sent, expected on the stream]
  const LABELS: [string, string][] = [
    ["a".repeat(64), "a".repeat(64)],
    ["b".repeat(65), "b".repeat(64)],
    [cat.repeat(21) + "é", cat.repeat(21)],
    [smile.repeat(16) + "x", smile.repeat(16)],
    ["x" + smile.repeat(16), "x" + smile.repeat(15)],
    ["short label", "short label"],
  ];
  const INTENTS: [string, string][] = [
    ["i".repeat(80), "i".repeat(80)],
    [cat.repeat(27), cat.repeat(26)],
    [smile.repeat(21), smile.repeat(20)],
    ["x" + smile.repeat(20), "x" + smile.repeat(19)],
    ["hold the centre", "hold the centre"],
    [cat.repeat(26) + "ab", cat.repeat(26) + "ab"],
  ];
  const id = (i: number): string => `agent-text-${i}`;

  it("cuts model labels to 64 and intent lines to 80 UTF-8 bytes at a character boundary in the full snapshot and in join and order events, and sends shorter text whole", async () => {
    const clock = new ManualClock();
    const h = new LiveHub({ config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 }, clock });
    const srv = new RecordedServer(h, clock);
    await srv.listen();
    try {
      let state = createMatch(SCRIPT.seed, playable(SCRIPT.config));
      h.startMatch(1, state);
      const early = await SseClient.connect(srv.url("/live/1"));
      const earlyRes = await served(srv, 1);
      const cx = Math.floor(SCRIPT.config.mapWidth / 2);
      const cy = Math.floor(SCRIPT.config.mapHeight / 2);
      for (let t = 0; t < 3; t++) {
        const inputs: SimInput[] =
          t === 0
            ? LABELS.map(([label], i): SimInput => ({ type: "join", agentId: id(i), modelLabel: label }))
            : t === 1
              ? INTENTS.map(([intent], i): SimInput => ({ type: "order", agentId: id(i), order: { kind: "go_to", tileX: cx, tileY: cy }, intent }))
              : [];
        const out = step(state, inputs);
        h.pushTick(1, out);
        clock.advance(100);
        state = out.state;
      }
      // The sim kept the text as sent: the cut is the stream's.
      expect(state.agents.map((a) => a.modelLabel)).toEqual(LABELS.map(([l]) => l));
      const late = await SseClient.connect(srv.url("/live/1"));
      const lateRes = await served(srv, 2);
      await delivered(early, earlyRes);
      await delivered(late, lateRes);
      early.close();
      late.close();

      const events = early.messages.flatMap((m) => m.events);
      const joins = events.flatMap((e) => (e.kind === "join" ? [e.modelLabel] : []));
      const orders = events.flatMap((e) => (e.kind === "order" ? [e.intent] : []));
      expect(joins).toEqual(LABELS.map(([, want]) => want));
      expect(orders).toEqual(INTENTS.map(([, want]) => want));
      const full = late.messages[0]!.full!;
      expect(full.agents.map((a) => a.modelLabel)).toEqual(LABELS.map(([, want]) => want));
      expect(full.agents.map((a) => a.intent)).toEqual(INTENTS.map(([, want]) => want));
      for (const a of full.agents) {
        expect(Buffer.byteLength(a.modelLabel)).toBeLessThanOrEqual(64);
        expect(Buffer.byteLength(a.intent)).toBeLessThanOrEqual(80);
      }
    } finally {
      h.close();
      await srv.close();
    }
  });
});

describe("Each ant's caste on the stream (bit 2)", () => {
  // The recorder's messages for a short v4 match, alongside the sim's castes at each tick.
  function playV4(ticks: number): { messages: StreamMessage[]; soldiers: Map<number, number[]> } {
    const o: ScriptOptions = { seed: 6007, config: playable(RULES_V4_CONFIG), agents: 6, ticks, attack: true };
    let state = createMatch(o.seed, playable(o.config));
    const recorder = new SpectatorRecorder(state);
    const messages: StreamMessage[] = [{ ...recorder.initial(), full: recorder.initialFull() }];
    const soldiers = new Map<number, number[]>();
    while (state.tick < ticks && state.result === null) {
      const out = step(state, scriptedInputs(state, o));
      state = out.state;
      const rec = recorder.record(out);
      messages.push({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events });
      soldiers.set(state.tick, state.ants.filter((a) => a.caste === "soldier").map((a) => a.id).sort((x, y) => x - y));
    }
    return { messages, soldiers };
  }

  it("with the switch on, a soldier's bit 2 decodes to caste 1 for exactly the sim's soldiers, and messages round-trip", () => {
    const { messages, soldiers } = playV4(1200);
    let withSoldiers = 0;
    for (const m of messages) {
      const bytes = encodeMessage(m);
      const decoded = decodeMessage(bytes);
      expect(encodeMessage(decoded)).toEqual(bytes);
      const ids = [...decoded.ants.id].filter((_, i) => decoded.ants.caste?.[i] === 1);
      expect(ids).toEqual(m.full === null ? soldiers.get(m.tick) : []);
      if (ids.length > 0) withSoldiers += 1;
      // Bit 2 leaves colony and squad decoding untouched.
      expect([...decoded.ants.colony]).toEqual([...m.ants.colony]);
      expect([...decoded.ants.agent]).toEqual([...m.ants.agent]);
    }
    expect(withSoldiers).toBeGreaterThan(0);
  }, 60_000);

  it("a message with no soldier carries no caste and the same bytes as without the field", () => {
    const { messages } = playV4(5);
    const m = messages.at(-1)!;
    expect(m.ants.caste).toBeUndefined();
    const zeros = { ...m, ants: { ...m.ants, caste: new Uint8Array(m.ants.count) } };
    expect(encodeMessage(zeros)).toEqual(encodeMessage(m));
    expect(decodeMessage(encodeMessage(m)).ants).not.toHaveProperty("caste");
  });
});

describe("caste-correct hatch countdown", () => {
  it.each([undefined, 2, 3])("streams the same ready tick as a real soldier hatch with multiplier %s", multiplier => {
    const config = { ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined, startAnts: 0,
      hatchIntervalTicks: 10, hatchTiming: multiplier === undefined ? undefined : { soldierIntervalMultiplier: multiplier } };
    const state = createMatch(7001, playable(config));
    const colony = state.colonies[0];
    colony.foodStore = 100;
    colony.mixedNext = "soldier";
    colony.queens![0]!.lastHatchTick = 0;
    const expected = 10 * (multiplier ?? 1);
    const recorder = new SpectatorRecorder(state);
    const wire = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    expect(wire.full!.stores![0]).toEqual({ food: 100, nextHatchTick: expected, nextCost: config.castes!.soldierCost });
    const events: Parameters<typeof hatch>[2] = [];
    hatch(state, expected - 1, events);
    expect(events.filter(event => event.type === "hatch" && event.colony === 0)).toEqual([]);
    hatch(state, expected, events);
    expect(events.filter(event => event.type === "hatch" && event.colony === 0)).toMatchObject([{ tick: expected, caste: "soldier" }]);
    // Mixed brood flips to worker, whose base interval is unchanged at every nest.
    expect(storesOf(state)[0].nextHatchTick).toBe(expected + 10);
    colony.queens!.push({ ...colony.queens![0]!, id: 1, lastHatchTick: 5, queenX: 20500 });
    expect(storesOf(state)[0].nextHatchTick).toBe(15);
    colony.queens![1]!.lostTick = expected;
    expect(storesOf(state)[0].nextHatchTick).toBe(expected + 10);
  });
});

describe("Each colony's next hatch cost with the rules switch on", () => {
  const { hatchCost } = RULES_V4_CONFIG;
  const soldierCost = RULES_V4_CONFIG.castes!.soldierCost;

  it("streams, before every hatch, the cost of the caste the sim then hatches, alternating under a mixed brood", () => {
    // The scripted agents set no brood, so each colony breeds mixed: worker, soldier, worker, ...
    const o: ScriptOptions = { seed: 6007, config: playable(RULES_V4_CONFIG), agents: 6, ticks: 1200, attack: true };
    let state = createMatch(o.seed, playable(o.config));
    const recorder = new SpectatorRecorder(state);
    const full = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const board = new SpectatorState(structuredClone(full.full!), full.tick, full.ants);
    expect(board.full.stores!.map((st) => st.nextCost)).toEqual([hatchCost, hatchCost]);
    const wrong: string[] = [];
    const flips = { toSoldier: 0, toWorker: 0 };
    while (state.tick < o.ticks && state.result === null) {
      const before = board.full.stores!.map((st) => st.nextCost);
      const out = step(state, scriptedInputs(state, o));
      state = out.state;
      const rec = recorder.record(out);
      board.apply(decodeMessage(encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events })));
      for (const e of out.events) {
        if (e.type !== "hatch") continue;
        const charged = e.caste === "soldier" ? soldierCost : hatchCost;
        if (before[e.colony] !== charged) wrong.push(`tick ${e.tick} colony ${e.colony}: streamed ${before[e.colony]}, hatch charged ${charged}`);
        const after = board.full.stores![e.colony]!.nextCost;
        const expected = e.caste === "soldier" ? hatchCost : soldierCost;
        if (after !== expected) wrong.push(`tick ${e.tick} colony ${e.colony}: after a ${e.caste} streamed ${after}, expected ${expected}`);
        if (e.caste === "worker") flips.toSoldier += 1;
        else flips.toWorker += 1;
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    // Both directions of the alternation happened: 3 to 6 after a worker, 6 to 3 after a soldier.
    expect(flips.toSoldier).toBeGreaterThan(0);
    expect(flips.toWorker).toBeGreaterThan(0);
  }, 60_000);

  it("sends one store event when only a brood vote changes the next cost", () => {
    let state = createMatch(6007, playable(RULES_V4_CONFIG));
    const recorder = new SpectatorRecorder(state);
    const play = (inputs: SimInput[]) => {
      const out = step(state, inputs);
      state = out.state;
      // Through the wire, so the event's new varint round-trips too.
      const rec = recorder.record(out);
      const m = decodeMessage(encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events }));
      return m.events.filter((e): e is Extract<StreamEvent, { kind: "store" }> => e.kind === "store");
    };
    expect(play([{ type: "join", agentId: "voter", placement: 0 }])).toEqual([]);
    const was = storesOf(state)[0];
    expect(was.nextCost).toBe(hatchCost);
    const events = play([{ type: "order", agentId: "voter", order: { kind: "hold" }, brood: "soldiers" }]);
    expect(state.agents.find((a) => a.id === "voter")!.brood).toBe("soldiers");
    // Food and the next hatch tick are unchanged: the vote alone moved the cost.
    expect(events).toEqual([{ kind: "store", colony: 0, food: was.food, nextHatchTick: was.nextHatchTick, nextCost: soldierCost }]);
  });
});

// set_brood calls are recorded under a new stream call index beyond the seven earlier call kinds. Index 7, in the call event's existing layout:
// no new stream version and no new wire field, so the base's feature-based version selection (src/live/format.ts:847 at
// 0f902d99) picks the same version for a message whichever call kind it carries. Older recordings: writer-compatibility.test.ts.
describe("Set_brood on the stream", () => {
  it("keeps the seven captured call indexes and appends set_brood at index 7", () => {
    expect(CALL_KINDS.slice(0, 7)).toEqual(["join", "rejoin", "observe", "order", "mark", "found_queen", "count_mark"]);
    expect(CALL_KINDS.indexOf("set_brood")).toBe(7);
    expect(CALL_KINDS).toHaveLength(8);
  });

  it("writes a set_brood call as index 7 in the same bytes and version an observe call takes, and reads it back", () => {
    const r = new SpectatorRecorder(createMatch(6007, playable(rulesConfig("redesign"))));
    const opening = { ...r.initial(), full: r.initialFull() };
    const delta: StreamMessage = { tick: 3, full: null, ants: opening.ants, events: [] };
    const cases: [StreamMessage, Extract<StreamEvent, { kind: "call" }>, number][] = [
      [delta, { kind: "call", agent: 0, call: "set_brood", accepted: true }, STREAM_VERSION],
      [delta, { kind: "call", agent: 1, call: "set_brood", accepted: false }, STREAM_VERSION],
      [delta, { kind: "call", agent: 0, call: "set_brood", accepted: true, houseActivityTick: 2 }, HOUSE_IDLE_STREAM_VERSION],
      [opening, { kind: "call", agent: 0, call: "set_brood", accepted: true }, GRID_SCALE_STREAM_VERSION],
    ];
    for (const [message, call, version] of cases) {
      const brood = encodeMessage({ ...message, events: [...message.events, call] });
      const observe = encodeMessage({ ...message, events: [...message.events, { ...call, call: "observe" }] });
      expect(brood[2]).toBe(version);
      expect(brood).toHaveLength(observe.length);
      const differ = [...brood.keys()].filter((i) => brood[i] !== observe[i]);
      expect(differ).toHaveLength(1);
      expect([observe[differ[0]!], brood[differ[0]!]]).toEqual([2, 7]);
      expect(decodeMessage(brood).events.at(-1)).toEqual(call);
    }
  });
});
