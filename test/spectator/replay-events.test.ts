import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamFull, StreamMessage, StreamQueen } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { advance, type ServerTerminal } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { FIGHT_MIN_DEATHS, FIGHT_QUIET_TICKS, FOOD_LEAD_FLOOR, ReplayEventScan } from "../../web/src/replay-events.ts";

const START = 1000;
const queen = (colony: 0 | 1, id: number, lostTick: number | null = null): StreamQueen =>
  ({ id, colony, x: 0, y: 0, foundedTick: 0, lostTick, overrun: 0 });
const opening = (full: Partial<StreamFull> = {}): StreamMessage => ({ tick: START, ants: {} as StreamMessage["ants"], events: [],
  full: { setup: { queens: [[0, 0], [0, 0]] }, queens: [queen(0, 0), queen(1, 0)],
    stores: [{ food: 0, nextHatchTick: 0, nextCost: 10 }, { food: 0, nextHatchTick: 0, nextCost: 10 }], ...full } as StreamFull });
const delta = (tick: number, events: StreamEvent[] = []): StreamMessage => ({ tick, ants: {} as StreamMessage["ants"], full: null, events });
const bite: StreamEvent = { kind: "fight", antId: 1, targetId: 2, colony: 0, tileX: 0, tileY: 0 };
const death: StreamEvent = { kind: "death", antId: 2, colony: 1, x: 0, y: 0 };
const store = (colony: 0 | 1, food: number): StreamEvent => ({ kind: "store", colony, food, nextHatchTick: 0, nextCost: 10 });

/** Plays a recording given as tick → events, every tick in between present (as recordings are). */
function scan(by: Map<number, StreamEvent[]>, last: number, first = opening()) {
  const s = new ReplayEventScan();
  s.push(first);
  for (let t = START + 1; t <= last; t++) s.push(delta(t, by.get(t) ?? []));
  return s.events();
}
const add = (by: Map<number, StreamEvent[]>, tick: number, ...events: StreamEvent[]) => by.set(tick, [...(by.get(tick) ?? []), ...events]);

describe("fights", () => {
  it("marks a run of bites at its first bite once enough ants died in it, with the time from the first tick", () => {
    const by = new Map<number, StreamEvent[]>();
    for (let t = 1100; t <= 1130; t += 10) add(by, t, bite);
    for (let i = 0; i < FIGHT_MIN_DEATHS; i++) add(by, 1105 + i, death);
    expect(scan(by, 1300)).toEqual([{ kind: "fight", tick: 1100, ms: 10_000, colony: null }]);
  });
  it("does not mark a run with fewer deaths", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1100, bite);
    for (let i = 0; i < FIGHT_MIN_DEATHS - 1; i++) add(by, 1101 + i, death);
    expect(scan(by, 1300)).toEqual([]);
  });
  it("keeps one fight through gaps up to the quiet time and starts another after it", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1100, bite, ...Array(FIGHT_MIN_DEATHS).fill(death));
    add(by, 1100 + FIGHT_QUIET_TICKS, bite); // still the same fight
    const next = 1100 + 2 * FIGHT_QUIET_TICKS + 1;
    add(by, next, bite, ...Array(FIGHT_MIN_DEATHS).fill(death)); // a new one
    expect(scan(by, 1500).map(e => e.tick)).toEqual([1100, next]);
  });
  it("closes a fight still running when the recording ends", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1290, bite, ...Array(FIGHT_MIN_DEATHS).fill(death));
    expect(scan(by, 1295).map(e => [e.kind, e.tick])).toEqual([["fight", 1290]]);
  });
});

describe("nests lost", () => {
  it("marks each queen lost once, in the losing colony, at the message that reports it", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1200, { kind: "queenLost", queen: queen(1, 0, 1199) });
    add(by, 1201, { kind: "queenLost", queen: queen(1, 0, 1199) });
    add(by, 1250, { kind: "queenLost", queen: queen(1, 3, 1249) });
    expect(scan(by, 1300)).toEqual([
      { kind: "nest", tick: 1200, ms: 20_000, colony: 1 },
      { kind: "nest", tick: 1250, ms: 25_000, colony: 1 },
    ]);
  });
  it("marks the overrun end in a recording without a queen list, and not otherwise", () => {
    const end = (reason: "overrun" | "double_overrun" | "time_up", winner: 0 | 1 | null): StreamEvent =>
      ({ kind: "end", result: { winner, reason, decidedBy: "overrun", tick: 1299, nextStartMs: null } } as StreamEvent);
    const legacy = opening({ queens: undefined });
    expect(scan(new Map([[1300, [end("overrun", 0)]]]), 1300, legacy)).toEqual([{ kind: "nest", tick: 1300, ms: 30_000, colony: 1 }]);
    expect(scan(new Map([[1300, [end("double_overrun", null)]]]), 1300, legacy).map(e => e.colony)).toEqual([0, 1]);
    expect(scan(new Map([[1300, [end("time_up", 1)]]]), 1300, legacy)).toEqual([]);
    expect(scan(new Map([[1300, [end("overrun", 0)]]]), 1300)).toEqual([]);
  });
});

/** Ants as one message carries them, ids ascending. */
function antsOf(list: { id: number; colony: number; carrying: boolean }[], flags = true): StreamMessage["ants"] {
  const sorted = [...list].sort((x, y) => x.id - y.id);
  return {
    count: sorted.length, id: Uint32Array.from(sorted.map(a => a.id)), colony: Uint8Array.from(sorted.map(a => a.colony)),
    x: new Uint16Array(sorted.length), y: new Uint16Array(sorted.length), heading: new Uint8Array(sorted.length),
    agent: new Int16Array(sorted.length).fill(-1),
    ...(flags ? { carrying: Uint8Array.from(sorted.map(a => a.carrying ? 1 : 0)) } : {}),
  };
}
/** Food delivered home: at each listed tick, `n` ants of a colony carrying food the tick before put it down.
 * `extra` adds events at a tick (a hatch's store drop, a store rise with no delivery); `dying` carriers vanish instead. */
function foodScan(deliveries: [tick: number, colony: number, n: number][], last: number,
  { extra = new Map<number, StreamEvent[]>(), dying = [] as [number, number, number][], flags = true, first = opening() } = {}) {
  let next = 100;
  const plan = [...deliveries.map(([t, c, n]) => ({ t, c, n, dies: false })), ...dying.map(([t, c, n]) => ({ t, c, n, dies: true }))]
    .map(d => ({ ...d, ids: Array.from({ length: d.n }, () => next++) }));
  const antsAt = (tick: number) => antsOf(plan.flatMap((d): { id: number; colony: number; carrying: boolean }[] =>
    d.t === tick + 1 ? d.ids.map(id => ({ id, colony: d.c, carrying: true }))
      : d.t === tick && !d.dies ? d.ids.map(id => ({ id, colony: d.c, carrying: false })) : []), flags);
  const s = new ReplayEventScan();
  s.push({ ...first, ants: antsAt(START) });
  for (let t = START + 1; t <= last; t++) s.push({ ...delta(t, extra.get(t) ?? []), ants: antsAt(t) });
  return s.events();
}

describe("food lead", () => {
  it("counts food delivered home and skips the first lead", () => {
    // Colony 0 leads first (no mark); colony 1 then gathers 310 to 200: more than the floor ahead, a change.
    const out = foodScan([[1010, 0, 200], [1030, 1, 200], [1040, 1, 60 + FOOD_LEAD_FLOOR]], 1100);
    expect(out).toEqual([{ kind: "food", tick: 1040, ms: 4000, colony: 1 }]);
  });
  it("counts a delivery in the tick a hatch spends the store, and not a store rise without a delivery or a carrier that died", () => {
    const extra = new Map<number, StreamEvent[]>([
      [1040, [store(1, 0), { kind: "birth", antId: 9 }]], // colony 1 delivers 110 and hatches in one tick: its store falls
      [1050, [store(0, 5000)]], // older recordings: the store rises with no delivery
    ]);
    const out = foodScan([[1010, 0, 200], [1030, 1, 200], [1040, 1, 110]], 1100, { extra, dying: [[1060, 0, 500]] });
    expect(out).toEqual([{ kind: "food", tick: 1040, ms: 4000, colony: 1 }]);
  });
  it("needs more than the larger of 2% of all gathered food and the floor", () => {
    const run = (a: number, b: number) => foodScan([[1010, 0, a], [1020, 1, b]], 1030);
    // The first lead (colony 0) then colony 1 ahead by exactly the floor: no change; one more food: a change.
    expect(run(100, 100 + FOOD_LEAD_FLOOR)).toEqual([]);
    expect(run(100, 101 + FOOD_LEAD_FLOOR)).toHaveLength(1);
    // Large totals, where 2% is above the floor: 408 ahead of 20_408 gathered is not more than 2%; 409 of 20_409 is.
    expect(run(10_000, 10_408)).toEqual([]);
    expect(run(10_000, 10_409)).toHaveLength(1);
  });
  it("gives no food marks for a recording without carrying flags", () => {
    expect(foodScan([[1010, 0, 200], [1020, 1, 2000]], 1030, { flags: false })).toEqual([]);
  });
});

describe("four colonies", () => {
  /** A four-colony match's queen, colony 0 to 3 (the stream's colony ids). */
  const queen4 = (colony: number, id: number, lostTick: number | null = null): StreamQueen =>
    ({ id, colony, x: 0, y: 0, foundedTick: 0, lostTick, overrun: 0 });
  /** Its first message: one nest per colony in its setup, so the colony count is four. */
  const quadrants = (): StreamMessage => opening({
    setup: { queens: [[0, 0], [0, 0], [0, 0], [0, 0]] } as StreamFull["setup"],
    queens: [0, 1, 2, 3].map(c => queen4(c, 0)),
  });
  const lost = (colony: number, tick: number): StreamEvent => ({ kind: "queenLost", queen: queen4(colony, 0, tick - 1) });
  const end = (winner: number | null, tick: number, reason = "idle"): StreamEvent =>
    ({ kind: "end", result: { winner, reason, decidedBy: reason, tick: tick - 1, nextStartMs: null } }) as StreamEvent;

  it("marks every colony's nest lost, in that colony, at the message that reports it", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1100, lost(2, 1100));
    add(by, 1200, lost(3, 1200));
    add(by, 1250, lost(0, 1250));
    expect(scan(by, 1300, quadrants())).toEqual([
      { kind: "nest", tick: 1100, ms: 10_000, colony: 2 },
      { kind: "nest", tick: 1200, ms: 20_000, colony: 3 },
      { kind: "nest", tick: 1250, ms: 25_000, colony: 0 },
    ]);
  });
  it("makes no nest-lost mark for the winner in a same-tick all-idle end, and marks the colonies it outlasted", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1100, lost(2, 1100));
    add(by, 1300, lost(0, 1300), lost(1, 1300), lost(3, 1300), end(3, 1300));
    // A later full snapshot repeats the winner's queen as lost: still no mark.
    const after: StreamMessage = { ...delta(1301), full: { queens: [queen4(0, 0, 1299), queen4(1, 0, 1299), queen4(2, 0, 1099), queen4(3, 0, 1299)] } as StreamFull };
    const s = new ReplayEventScan();
    s.push(quadrants());
    for (let t = START + 1; t <= 1300; t++) s.push(delta(t, by.get(t) ?? []));
    s.push(after);
    expect(s.events().map(e => [e.kind, e.tick, e.colony])).toEqual([["nest", 1100, 2], ["nest", 1300, 0], ["nest", 1300, 1]]);
  });
  it("makes no nest-lost mark for the winner for a nest it lost before its result either", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1100, { kind: "queenLost", queen: queen4(1, 4, 1099) });
    add(by, 1300, lost(0, 1300), lost(2, 1300), lost(3, 1300), end(1, 1300, "queens_killed"));
    expect(scan(by, 1300, quadrants()).map(e => [e.tick, e.colony])).toEqual([[1300, 0], [1300, 2], [1300, 3]]);
  });
  it("keeps a two-colony winner's nest lost in its result's message marked, as before", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1300, { kind: "queenLost", queen: queen(1, 0, 1299) }, { kind: "queenLost", queen: queen(0, 2, 1299) },
      { kind: "end", result: { winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick: 1299, nextStartMs: null } } as StreamEvent);
    expect(scan(by, 1300).map(e => e.colony)).toEqual([1, 0]);
  });
  it("gives the food lead to the colony ahead of every other by more than the margin", () => {
    const run = (deliveries: [number, number, number][]) => foodScan(deliveries, 1100, { first: quadrants() });
    // Colony 0 leads first (no mark); colony 2 then gathers more than the floor ahead of every other colony.
    expect(run([[1010, 0, 200], [1020, 1, 150], [1030, 2, 260], [1040, 3, 100]])).toEqual([{ kind: "food", tick: 1030, ms: 3000, colony: 2 }]);
    // Ahead of colony 0 by more than the floor but not of colony 3: no change.
    expect(run([[1010, 0, 200], [1020, 3, 240], [1030, 2, 260]])).toEqual([]);
    // Then colony 3 takes it from colony 2.
    expect(run([[1010, 0, 200], [1030, 2, 260], [1050, 3, 120], [1060, 3, 200]])).toEqual([
      { kind: "food", tick: 1030, ms: 3000, colony: 2 }, { kind: "food", tick: 1060, ms: 6000, colony: 3 },
    ]);
  });
});

describe("a four-colony match as the recorder sends it", () => {
  /** Test-only quadrant geometry (as in test/live/four-colony-recorder.test.ts); no quadrant map ships. */
  const QUADRANTS: MapDefinition = {
    id: "fixture-quadrants", name: "Fixture Quadrants",
    water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
    quadrant: {
      referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
      startArea: { x: 2, y: 4, width: 12, height: 15 },
      foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
      centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
    },
  };
  const LIVE = newMatchConfig(rulesConfig("redesign"));
  const CONFIG: SimConfig = { ...LIVE, terrain: { ...LIVE.terrain!, maps: [QUADRANTS] } };
  const JOINS: SimInput[] = [0, 1, 2, 3].map(c => ({ type: "join", agentId: `a${c}`, modelLabel: `model ${c}` }));

  it("marks the nest of a colony eliminated for idleness, and of every colony the winner outlasted, and none of the winner's", () => {
    const state = createMatch(404, CONFIG);
    const recorder = new SpectatorRecorder(state);
    const opening = recorder.initial();
    const messages: StreamMessage[] = [{ ...opening, full: recorder.initialFull() }];
    const play = (inputs: readonly SimInput[] = [], terminal: ServerTerminal = false) => {
      const rec = recorder.record(advance(state, inputs, undefined, undefined, undefined, terminal, true));
      messages.push({ ...rec, full: null });
      return rec.tick;
    };
    for (let t = 0; t < 100; t++) play(t === 0 ? JOINS : []);
    // Colony 2 is ended idle: the engine retires its queen with no queen loss of its own.
    const idle = play([], { idle: [2] });
    for (let t = 0; t < 10; t++) play();
    // Colonies 0, 1 and 3 go idle on one tick: the result names a winner among them, whose queen is lost with theirs.
    const end = play([], { idle: [0, 1, 3] });
    const winner = state.result!.winner!;
    expect([0, 1, 3]).toContain(winner);

    const scan = new ReplayEventScan();
    for (const m of messages) scan.push(m);
    const nests = scan.events().filter(e => e.kind === "nest").map(e => [e.tick, e.colony]);
    expect(nests).toEqual([[idle, 2], ...[0, 1, 3].filter(c => c !== winner).map(c => [end, c])]);
  });
});
