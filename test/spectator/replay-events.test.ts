import { describe, expect, it } from "vitest";
import type { StreamEvent, StreamFull, StreamMessage, StreamQueen } from "../../src/live/format.ts";
import { FIGHT_MIN_DEATHS, FIGHT_QUIET_TICKS, FOOD_LEAD_FLOOR, ReplayEventScan } from "../../web/src/replay-events.ts";

const START = 1000;
const queen = (colony: 0 | 1, id: number, lostTick: number | null = null): StreamQueen =>
  ({ id, colony, x: 0, y: 0, foundedTick: 0, lostTick, overrun: 0 });
const opening = (full: Partial<StreamFull> = {}): StreamMessage => ({ tick: START, ants: {} as StreamMessage["ants"], events: [],
  full: { queens: [queen(0, 0), queen(1, 0)], stores: [{ food: 0, nextHatchTick: 0, nextCost: 10 }, { food: 0, nextHatchTick: 0, nextCost: 10 }], ...full } as StreamFull });
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
function antsOf(list: { id: number; colony: 0 | 1; carrying: boolean }[], flags = true): StreamMessage["ants"] {
  const sorted = [...list].sort((x, y) => x.id - y.id);
  return {
    count: sorted.length, id: Uint32Array.from(sorted.map(a => a.id)), colony: Uint8Array.from(sorted.map(a => a.colony)),
    x: new Uint16Array(sorted.length), y: new Uint16Array(sorted.length), heading: new Uint8Array(sorted.length),
    agent: new Int16Array(sorted.length).fill(-1),
    ...(flags ? { carrying: Uint8Array.from(sorted.map(a => a.carrying ? 1 : 0)) } : {}),
  };
}
/** Food delivered home: at each listed tick, `n` ants of a colony carrying food the tick before put it down.
 * `extra` adds events at a tick (a hatch's store drop, ground income); `dying` carriers vanish instead. */
function foodScan(deliveries: [tick: number, colony: 0 | 1, n: number][], last: number,
  { extra = new Map<number, StreamEvent[]>(), dying = [] as [number, 0 | 1, number][], flags = true } = {}) {
  let next = 100;
  const plan = [...deliveries.map(([t, c, n]) => ({ t, c, n, dies: false })), ...dying.map(([t, c, n]) => ({ t, c, n, dies: true }))]
    .map(d => ({ ...d, ids: Array.from({ length: d.n }, () => next++) }));
  const antsAt = (tick: number) => antsOf(plan.flatMap((d): { id: number; colony: 0 | 1; carrying: boolean }[] =>
    d.t === tick + 1 ? d.ids.map(id => ({ id, colony: d.c, carrying: true }))
      : d.t === tick && !d.dies ? d.ids.map(id => ({ id, colony: d.c, carrying: false })) : []), flags);
  const s = new ReplayEventScan();
  s.push({ ...opening(), ants: antsAt(START) });
  for (let t = START + 1; t <= last; t++) s.push({ ...delta(t, extra.get(t) ?? []), ants: antsAt(t) });
  return s.events();
}

describe("food lead", () => {
  it("counts food delivered home and skips the first lead", () => {
    // Colony 0 leads first (no mark); colony 1 then gathers 310 to 200: more than the floor ahead, a change.
    const out = foodScan([[1010, 0, 200], [1030, 1, 200], [1040, 1, 60 + FOOD_LEAD_FLOOR]], 1100);
    expect(out).toEqual([{ kind: "food", tick: 1040, ms: 4000, colony: 1 }]);
  });
  it("counts a delivery in the tick a hatch spends the store, and not ground income or a carrier that died", () => {
    const extra = new Map<number, StreamEvent[]>([
      [1040, [store(1, 0), { kind: "birth", antId: 9 }]], // colony 1 delivers 110 and hatches in one tick: its store falls
      [1050, [store(0, 5000)]], // ground income: the store rises with no delivery
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
