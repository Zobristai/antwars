import { beforeAll, describe, expect, it } from "vitest";
import { SUB } from "../../src/sim/config.js";
import { chebyshev } from "../../src/sim/geometry.js";
import { foodTiles } from "../../src/sim/forage.js";
import { houseDirection } from "../../src/sim/houseBot.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, SimEvent, SimState } from "../../src/sim/types.js";
import { HISTORICAL_CONFIG, SNAPSHOT_EVERY, addAnt, emptyMatch, run, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: distances below are fine tiles, reference distances doubled.
// This file plays its own house-only match on the shared fixture's config with seed 1. Under the one current rules
// generation it ends by overrun at tick 2886.
const HOUSE_SEED = 1;
let memo: { initial: SimState; final: SimState; snapshots: ReadonlyMap<number, SimState>; events: readonly SimEvent[] } | null = null;
function houseOnlyMatch() {
  if (memo !== null) return memo;
  const initial = createMatch(HOUSE_SEED, playable(HISTORICAL_CONFIG));
  const snapshots = new Map<number, SimState>([[0, initial]]);
  const events: SimEvent[] = [];
  let state = initial;
  while (state.result === null) {
    const out = step(state);
    state = out.state;
    events.push(...out.events);
    if (state.tick % SNAPSHOT_EVERY === 0) snapshots.set(state.tick, state);
  }
  memo = { initial, final: state, snapshots, events };
  return memo;
}
/** Reference tile t's centre, in fine tiles. */
const ref = (t: number) => 2 * t + 0.5;

beforeAll(() => {
  houseOnlyMatch();
}, 120_000);

/** Mean distance, in fine tiles, that a colony's ants stand forward of their own queen. */
function advance(state: SimState, colony: ColonyId): number {
  const queen = state.colonies[colony];
  const sign = colony === 0 ? 1 : -1;
  const ants = state.ants.filter((a) => a.colony === colony);
  return ants.reduce((sum, a) => sum + sign * (a.x - queen.queenX), 0) / ants.length / SUB;
}

describe("a house-only match plays itself to a result", () => {
  it("reaches a result with deliveries, hatching, fights and territory changing hands", () => {
    const { final, events } = houseOnlyMatch();
    expect(final.result).not.toBeNull();
    expect(events.filter((e) => e.type === "match_end")).toHaveLength(1);
    for (const c of [0, 1] as const) {
      expect(final.stats.delivered[c]).toBeGreaterThan(0);
      expect(final.stats.hatched[c]).toBeGreaterThan(0);
      expect(final.stats.deaths[c]).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === "fight")).toBe(true);
    expect(final.stats.ownerChanges).toBeGreaterThan(0);
  });

  it("has the house bot moving both colonies throughout", () => {
    for (const [tick, snap] of houseOnlyMatch().snapshots) {
      if (tick === 0) continue;
      for (const c of [0, 1] as const) {
        expect(snap.ants.some((a) => a.colony === c && (a.vx !== 0 || a.vy !== 0))).toBe(true);
      }
    }
  });
});

describe("house bot behaviour", () => {
  it("keeps foragers delivering food and a guard near its queen", () => {
    const snaps = [...houseOnlyMatch().snapshots.entries()].filter(([tick]) => tick > 0);
    let previous = houseOnlyMatch().initial;
    for (const [, snap] of snaps) {
      for (const c of [0, 1] as const) {
        expect(snap.ants.some((a) => a.colony === c && a.role === "forager")).toBe(true);
        expect(snap.stats.delivered[c]).toBeGreaterThan(previous.stats.delivered[c]);
        const queen = snap.colonies[c];
        const qx = Math.floor(queen.queenX / SUB);
        const qy = Math.floor(queen.queenY / SUB);
        const guard = snap.ants.some(
          (a) => a.colony === c && a.role === "guard" && chebyshev(Math.floor(a.x / SUB), Math.floor(a.y / SUB), qx, qy) <= 4, // two reference tiles
        );
        expect(guard).toBe(true);
      }
      previous = snap;
    }
  });

  it("sends a fighter forward where its side is locally stronger, and not where it is weaker", () => {
    const stronger = emptyMatch(1000);
    const scout = addAnt(stronger, 0, ref(30), ref(20), { role: "fighter" });
    addAnt(stronger, 0, ref(29), ref(20), { role: "fighter" });
    addAnt(stronger, 1, ref(33), ref(20), { role: "fighter" });
    const ahead = houseDirection(stronger, buildGrid(stronger), foodTiles(stronger), scout);
    expect(ahead.x).toBeGreaterThan(0);

    const weaker = emptyMatch(1000);
    const lone = addAnt(weaker, 0, ref(30), ref(20), { role: "fighter" });
    for (const y of [19, 20, 21]) addAnt(weaker, 1, ref(33), ref(y), { role: "fighter" });
    const back = houseDirection(weaker, buildGrid(weaker), foodTiles(weaker), lone);
    expect(back.x).toBeLessThan(0);
  });

  // Rules 27: seed 1 is decided by overrun at tick 2886, so the losing colony is pushed back late in
  // the match. Both colonies advance until they meet; the winner keeps pressing forward to the end.
  it("moves its ants toward the front as the match goes on", () => {
    const { initial, final, snapshots } = houseOnlyMatch();
    const early = snapshots.get(300)!;
    const met = snapshots.get(1200)!;
    for (const c of [0, 1] as const) {
      expect(advance(met, c)).toBeGreaterThan(advance(early, c) + 4); // two reference tiles
    }
    const winner = final.result!.winner!;
    const last = snapshots.get(Math.max(...snapshots.keys()))!;
    expect(last.tick).toBeGreaterThan(met.tick);
    expect(advance(last, winner)).toBeGreaterThan(advance(met, winner) + 8); // four reference tiles
    expect(initial.config.fighterShareEndPermille).toBeGreaterThan(initial.config.fighterShareStartPermille);
  });
});

/** The join tick: a shared-fixture snapshot, so the agent match shares the house-only history. */
const JOIN_TICK = 900;

describe("the house bot with agents", () => {
  it("on the join tick gives every non-squad ant the same direction as the house-only match", () => {
    const before = houseOnlyMatch().snapshots.get(JOIN_TICK)!;
    expect(before.tick).toBe(JOIN_TICK);
    const houseOnly = step(before).state;
    const joined = step(before, [{ type: "join", agentId: "a", colony: 0 }]).state;

    const squad = squadOf(joined, "a");
    expect(squad.length).toBeGreaterThan(0);
    // The squad takes at least one of the house bot's guards, so roles are exercised.
    const drafted = new Set(squad.map((a) => a.id));
    expect(before.ants.some((a) => drafted.has(a.id) && a.role === "guard")).toBe(true);
    expect(joined.agents[0]?.order).toEqual({ kind: "forage" });

    let compared = 0;
    for (const ant of joined.ants) {
      if (ant.squad !== null) continue;
      const twin = houseOnly.ants.find((a) => a.id === ant.id)!;
      expect([ant.vx, ant.vy]).toEqual([twin.vx, twin.vy]);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("never directs a held squad, and keeps directing both colonies while agents play", () => {
    const before = houseOnlyMatch().snapshots.get(JOIN_TICK)!;
    let s = step(before, [
      { type: "join", agentId: "a", colony: 0 },
      { type: "join", agentId: "b", colony: 1 },
      { type: "order", agentId: "a", order: { kind: "hold" } },
      { type: "order", agentId: "b", order: { kind: "hold" } },
    ]).state;
    expect(s.ants.filter((a) => a.squad !== null)).toHaveLength(12);
    // A squad ant already carrying food still takes it home under any order; every other held ant stays put.
    const held = new Map(s.ants.filter((a) => a.squad !== null && !a.carrying).map((a) => [a.id, [a.x, a.y]]));
    expect(held.size).toBeGreaterThan(0);
    for (let i = 0; i < 300; i += 1) {
      s = run(s, 1).state;
      for (const ant of s.ants) {
        if (held.has(ant.id)) expect([ant.x, ant.y]).toEqual(held.get(ant.id));
      }
      for (const c of [0, 1] as const) {
        expect(s.ants.some((a) => a.colony === c && a.squad === null && (a.vx !== 0 || a.vy !== 0))).toBe(true);
      }
    }
  });
});
