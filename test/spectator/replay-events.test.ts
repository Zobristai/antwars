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

describe("food lead", () => {
  it("counts food gathered, so spending on a hatch never moves the lead, and skips the first lead", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1010, store(0, 200)); // colony 0 leads: the first lead, not a mark
    add(by, 1020, store(0, 0)); // a hatch spends it; gathered stays 200
    add(by, 1030, store(1, 200)); // level
    add(by, 1040, store(1, 260 + FOOD_LEAD_FLOOR)); // colony 1 has gathered 310 to 200: more than the floor ahead, a change
    const out = scan(by, 1100);
    expect(out).toEqual([{ kind: "food", tick: 1040, ms: 4000, colony: 1 }]);
  });
  it("needs more than the larger of 2% of all gathered food and the floor", () => {
    const run = (a: number, b: number) => {
      const by = new Map<number, StreamEvent[]>();
      add(by, 1010, store(0, a));
      add(by, 1020, store(1, b));
      return scan(by, 1030);
    };
    // The first lead (colony 0) then colony 1 ahead by exactly the floor: no change; one more food: a change.
    expect(run(100, 100 + FOOD_LEAD_FLOOR)).toEqual([]);
    expect(run(100, 101 + FOOD_LEAD_FLOOR)).toHaveLength(1);
    // Large totals, where 2% is above the floor: 408 ahead of 20_408 gathered is not more than 2%; 409 of 20_409 is.
    expect(run(10_000, 10_408)).toEqual([]);
    expect(run(10_000, 10_409)).toHaveLength(1);
  });
  it("gives no food marks for a recording without stores", () => {
    const by = new Map<number, StreamEvent[]>();
    add(by, 1010, store(0, 500));
    add(by, 1020, store(1, 2000));
    expect(scan(by, 1030, opening({ stores: undefined }))).toEqual([]);
  });
});
