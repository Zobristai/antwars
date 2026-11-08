import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolveCombat } from "../../src/sim/combat.js";
import { COLONY_NAMES, DEFAULT_CONFIG, PUBLIC_CONFIG, QUEEN_HP_RULES, QUEEN_RULES, RULES_V4_CONFIG, SUB } from "../../src/sim/config.js";
import { applyInput, defaultAllocator, fillSquads, foundQueen } from "../../src/sim/agents.js";
import { forageDirection, hatch, pickupAndDeliver } from "../../src/sim/forage.js";
import { guardBudget, houseFounding, houseFoundingReserve, rebalanceRoles, type HouseFoundingDecision } from "../../src/sim/houseBot.js";
import { foundingDecisionMetrics, queenDurationVerdict, queenGuardSnapshot, queenOutcome, queenReportMetrics, queenRunChecks } from "./queen-report.js";
import { activeQueens, buildGrid, cloneState, createMatch, queenFoundingCost, queensOf } from "../../src/sim/map.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { updateOverrun, decideTimeUp, queensKilled } from "../../src/sim/territory.js";
import { step } from "../../src/sim/step.js";
import { takeView } from "../../src/sim/view.js";
import type { SimEvent, SimInput } from "../../src/sim/types.js";
import { PRE_FRONTLINE_PUBLIC_CONFIG, addAnt, emptyMatch, setOwner } from "./fixtures.js";
import { playable } from "../playable.ts";

const config = { ...PUBLIC_CONFIG, startAnts: 0, commandFloorTicks: 1 };
// Every match plays at grid scale 2: config is the reference template that emptyMatch and
// playable build at grid scale 2, and every tile distance doubles. Colony 0's queen at reference tile
// (8, 24) stands in fine tile (16, 49), one subunit homeward of the tile's centre; reference tile (x, y)
// is placed at fine (X(x), Y(y)) so its offsets from her tile double exactly.
const X = (x: number) => 2 * x, Y = (y: number) => 2 * y + 1;
function prepared() {
  const s = emptyMatch(QUEEN_RULES.firstFoundTick! + 1, config);
  s.colonies[0].foodStore = QUEEN_RULES.cost * 10;
  setOwner(s, X(18), Y(10), 0); setOwner(s, X(18), Y(38), 0);
  for (let i = 0; i < s.owner.length; i++) if (s.owner[i] !== -1) s.lastVisit[i] = s.tick;
  return s;
}

describe("queen founding is atomic and colony-wide", () => {
  it.each([
    [-1, Y(10), "bad_order"], [X(18) + 0.5, Y(10), "bad_order"], [NaN, Y(10), "bad_order"],
    [X(64), Y(10), "bad_order"], [X(18), Y(11), "queen_tile_not_held"],
  ])("refuses fine tile (%s,%s) without spending or creating", (x, y, code) => {
    const s = prepared(), before = stateHash(s), events: SimEvent[] = [];
    expect(foundQueen(s, 0, x as number, y as number, s.tick, events)?.code).toBe(code);
    expect(stateHash(s)).toBe(before); expect(events).toEqual([]);
  });
  it("requires 16 tiles from standing nests of both colonies but allows replacing a lost site", () => {
    const s = prepared();
    for (const [x, y] of [[9, 24], [54, 24]]) {
      setOwner(s, X(x!), Y(y!), 0);
      expect(foundQueen(s, 0, X(x!), Y(y!), s.tick, [])?.code).toBe("queen_too_close");
    }
    setOwner(s, X(24), Y(24), 0);
    expect(foundQueen(s, 0, X(24), Y(24), s.tick, [])).toBeNull(); // exactly 16 tiles
    s.tick += QUEEN_RULES.cooldownTicks;
    expect(foundQueen(s, 0, X(24), Y(24), s.tick, [])?.code).toBe("queen_too_close");
    s.colonies[0].queens![1]!.lostTick = s.tick;
    expect(foundQueen(s, 0, X(24), Y(24), s.tick, [])).toBeNull();
    expect(s.colonies[0].queens![1]!.lostTick).not.toBeNull(); // new identity, not resurrection
  });
  it("opens at tick 3000 and rejects early founding without any mutation", () => {
    const s = prepared(), events: SimEvent[] = [], before = stateHash(s);
    expect(foundQueen(s, 0, X(18), Y(10), 2999, events)).toMatchObject({ code: "queen_too_early", nextAllowedTick: 3000 });
    expect(stateHash(s)).toBe(before); expect(events).toEqual([]);
    houseFounding(s, 2999, events); expect(events).toEqual([]);
    expect(foundQueen(s, 0, X(18), Y(10), 3000, events)).toBeNull();
    expect(events[0]).toMatchObject({ foodCost: 400 });
    const after = stateHash(s);
    expect(foundQueen(s, 0, X(18), Y(38), 4799, [])).toMatchObject({ code: "queen_cooldown", nextAllowedTick: 4800 });
    expect(stateHash(s)).toBe(after);
    expect(foundQueen(s, 0, X(18), Y(38), 4800, [])).toBeNull();
  });

  it("keeps explicit live pricing capped at four with 400/800/1600 slots, including replacements", () => {
    const initial = prepared();
    const liveRules = { ...initial.config.queenFounding!, costBasis: "live" as const, maxLiveQueens: 4 };
    const s = { ...initial, config: { ...initial.config, queenFounding: liveRules } }, metrics = queenReportMetrics(s), events: SimEvent[] = [];
    const before = s.colonies[0].foodStore;
    for (const [i, [x, y]] of [[18, 10], [18, 38], [36, 24]].entries()) {
      s.tick = 3001 + i * QUEEN_RULES.cooldownTicks;
      setOwner(s, X(x!), Y(y!), 0);
      const batch: SimEvent[] = [];
      expect(foundQueen(s, 0, X(x!), Y(y!), s.tick, batch)).toBeNull();
      events.push(...batch); metrics.record(s, batch);
    }
    expect(events.map((e) => e.type === "queen_founded" ? e.foodCost : null)).toEqual([400, 800, 1600]);
    expect(s.colonies[0].foodStore).toBe(before - 2800);
    setOwner(s, X(45), Y(5), 0); const hash = stateHash(s), refused: SimEvent[] = [];
    expect(foundQueen(s, 0, X(45), Y(5), s.tick + 1800, refused)?.code).toBe("queen_limit");
    expect(stateHash(s)).toBe(hash); expect(refused).toEqual([]);
    expect(metrics.finish(s).colonies[0]).toMatchObject({ peakLiveQueens: 4, foodSpentOnFounding: 2800 });
    s.colonies[0].queens![1]!.lostTick = s.tick;
    expect(queenFoundingCost(s.colonies[0], liveRules)).toBe(1600);
    s.colonies[0].foodStore = 1600; s.tick += 1800;
    const replacement: SimEvent[] = [];
    expect(foundQueen(s, 0, X(18), Y(10), s.tick, replacement)).toBeNull();
    expect(replacement[0]).toMatchObject({ queenId: 4, foodCost: 1600 });
    expect(queenFoundingCost(s.colonies[0], s.config.queenFounding!)).toBe(1600);
    expect(s.colonies[0].foodStore).toBe(0); expect(activeQueens(s.colonies[0])).toHaveLength(4);
  });

  it.each([[1, 400], [2, 800], [3, 1600]])("prices a replacement with %s standing queens at %s food", (survivors, cost) => {
    const s = prepared();
    for (const [i, [x, y]] of [[18, 10], [18, 38], [36, 24]].entries()) {
      setOwner(s, X(x!), Y(y!), 0);
      expect(foundQueen(s, 0, X(x!), Y(y!), 3001 + i * 1800, [])).toBeNull();
    }
    const site = s.colonies[0].queens![survivors]!;
    for (const q of s.colonies[0].queens!.slice(survivors)) q.lostTick = 7000;
    s.colonies[0].foodStore = cost;
    const events: SimEvent[] = [];
    expect(foundQueen(s, 0, Math.floor(site.queenX / SUB), Math.floor(site.queenY / SUB), 8401, events)).toBeNull();
    expect(events[0]).toMatchObject({ queenId: 4, foodCost: cost });
    expect(s.colonies[0].foodStore).toBe(0);
    expect(activeQueens(s.colonies[0])).toHaveLength(survivors + 1);
  });

  it("retains fixed price, pre-opening and lost-site behavior for historical queen configs", () => {
    const old = { cost: 180, cooldownTicks: 600, minDistanceTiles: 8 };
    const s = createMatch(7, playable({ ...PUBLIC_CONFIG, startAnts: 0, queenFounding: old }));
    setOwner(s, X(16), Y(24), 0); s.colonies[0].foodStore = 1000;
    const events: SimEvent[] = [];
    expect(foundQueen(s, 0, X(16), Y(24), 0, events)).toBeNull();
    expect(events[0]).not.toHaveProperty("foodCost");
    s.colonies[0].queens![1]!.lostTick = 1;
    expect(queenFoundingCost(s.colonies[0], old)).toBe(180);
    expect(foundQueen(s, 0, X(16), Y(24), 600, [])?.code).toBe("queen_too_close");
  });

  it("charges once, shares cooldown across agents, and deep-clones queen state", () => {
    let s = prepared();
    s = step(s, [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "b", placement: 0 }]).state;
    const before = cloneState(s);
    const out = step(s, [{ type: "found_queen", agentId: "a", tileX: X(18), tileY: Y(10) }, { type: "found_queen", agentId: "b", tileX: X(18), tileY: Y(38) }]);
    expect(out.results[0]?.ok).toBe(true);
    expect(out.results[1]).toMatchObject({ ok: false, error: { code: "queen_cooldown" } });
    expect(out.state.colonies[0].foodStore).toBe(s.colonies[0].foodStore - QUEEN_RULES.cost);
    expect(out.events.filter((e) => e.type === "queen_founded")).toHaveLength(1);
    expect(stateHash(s)).toBe(stateHash(before));
    expect(queensOf(out.state.colonies[0])).toHaveLength(2);
    expect(queensOf(s.colonies[0])).toHaveLength(1);
  });
  it("refuses insufficient food, and shares the order command floor", () => {
    const s = prepared(); s.colonies[0].foodStore = QUEEN_RULES.cost - 1;
    expect(foundQueen(s, 0, X(18), Y(10), s.tick, [])?.code).toBe("queen_food");
    const joined = step(s, [{ type: "join", agentId: "a" }, { type: "order", agentId: "a", order: { kind: "hold" } }, { type: "found_queen", agentId: "a", tileX: X(18), tileY: Y(10) }]);
    expect(joined.results[2]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });
});

describe("capped guard allocation and founding diagnostics", () => {
  it.each([1, 2, 3, 4])("keeps the hard ceiling with %s queens, odd/small colonies and squads", (queens) => {
    for (const population of [1, 2, 3, 5, 9, 19, 31, 511, 512]) {
      const s = prepared(); s.colonies[0].foodStore = 10000;
      for (const [i, [x, y]] of [[18, 10], [18, 38], [36, 24]].slice(0, queens - 1).entries()) {
        setOwner(s, X(x!), Y(y!), 0); expect(foundQueen(s, 0, X(x!), Y(y!), 3001 + i * 1800, [])).toBeNull();
      }
      for (let i = 0; i < population; i++) addAnt(s, 0, X(8), Y(24), { squad: i < Math.floor(population / 4) ? "seated" : null });
      rebalanceRoles(s); const sample = queenGuardSnapshot(s, 0);
      expect(sample.houseGuards).toBeLessThanOrEqual(Math.floor(population * 600 / 1000));
      expect(sample.nonHouseGuardAnts).toBeGreaterThanOrEqual(Math.ceil(population * 400 / 1000));
      expect(sample.perQueenTarget).toBe(guardBudget(population, config));
      const counts = sample.queens.map((q) => q.assignedGuards);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(s.ants.filter((a) => a.squad !== null).every((a) => a.role === "forager")).toBe(true);
    }
  });

  it("restores the hard ceiling after non-guard casualties within a real step", () => {
    const s = prepared(); foundQueen(s, 0, X(18), Y(10), s.tick, []); s.colonies[0].foodStore = 0;
    for (let i = 0; i < 6; i++) addAnt(s, 0, X(i < 3 ? 8 : 18), Y(i < 3 ? 24 : 10));
    for (let i = 0; i < 4; i++) addAnt(s, 0, X(30), Y(24), { hp: 1 });
    for (let i = 0; i < 8; i++) addAnt(s, 1, X(30), Y(24));
    const next = step(s).state, sample = queenGuardSnapshot(next, 0);
    expect(next.stats.deaths[0]).toBeGreaterThan(0);
    expect(sample.houseGuards).toBeLessThanOrEqual(sample.totalCap!);
    expect(sample.nonHouseGuardAnts).toBeGreaterThanOrEqual(Math.ceil(sample.colonyAnts * 400 / 1000));
  });

  it.each(["food_reserve", "opening", "cooldown", "no_held_tile", "spacing", "live_cap", "no_live_queen"] as const)("reports %s from the exact existing decision branch", (reason) => {
    const s = prepared(); let tick = s.tick;
    if (reason === "food_reserve") s.colonies[0].foodStore = 599;
    if (reason === "opening") tick = 2999;
    if (reason === "cooldown") { foundQueen(s, 0, X(18), Y(10), tick, []); tick++; }
    if (reason === "no_held_tile" || reason === "spacing") { s.owner.fill(-1); if (reason === "spacing") setOwner(s, X(8), Y(24), 0); }
    if (reason === "live_cap") {
      Object.assign(s, { config: { ...s.config, queenFounding: { ...s.config.queenFounding!, maxLiveQueens: 4 } } });
      s.colonies[0].foodStore = 10000;
      for (const [i, [x, y]] of [[18, 10], [18, 38], [36, 24]].entries()) {
        setOwner(s, X(x!), Y(y!), 0); foundQueen(s, 0, X(x!), Y(y!), 3001 + i * 1800, []);
      }
      tick = 10000;
    }
    if (reason === "no_live_queen") s.colonies[0].queens![0]!.lostTick = 1;
    const before = stateHash(s), decisions: HouseFoundingDecision[] = [], events: SimEvent[] = [];
    houseFounding(s, tick, events, (d) => decisions.push(d));
    const d = decisions.find((item) => item.colony === 0)!;
    expect(d.reason).toBe(reason); expect(stateHash(s)).toBe(before); expect(events).toEqual([]);
    if (reason === "spacing") expect(d).toMatchObject({ searchedHeldTiles: 1, eligibleSites: 0, threshold: 600 });
    const metrics = foundingDecisionMetrics(); metrics.record(d);
    expect(metrics.colonies[0]!.counts[reason]).toBe(1);
    if (d.foodStore >= d.threshold) expect(metrics.colonies[0]!.lastAffordableBlocked).toEqual(d);
  });

  it("observes the real founding phase without changing state or events", () => {
    const s = prepared(), decisions: HouseFoundingDecision[] = [];
    const plain = step(s), observed = step(s, [], defaultAllocator, (d) => decisions.push(d));
    expect(stateHash(observed.state)).toBe(stateHash(plain.state)); expect(observed.events).toEqual(plain.events);
    expect(decisions.find((d) => d.colony === 0)).toMatchObject({ reason: "founded", tick: s.tick, foodStore: 4000, price: 400 });
    expect(observed.state).not.toHaveProperty("foundingDecisions");
    const seated: HouseFoundingDecision[] = [];
    step(s, [{ type: "join", agentId: "a", placement: 0 }], defaultAllocator, (d) => seated.push(d));
    expect(seated.find((d) => d.colony === 0)?.reason).toBe("agent_controlled");
  });

  it("separates affordable fourth-queen blockers from earlier founding refusals", () => {
    const s = prepared(); foundQueen(s, 0, X(18), Y(10), 3001, []); foundQueen(s, 0, X(18), Y(38), 4801, []);
    const metrics = foundingDecisionMetrics();
    houseFounding(s, 4802, [], (d) => metrics.record(d));
    expect(metrics.colonies[0]!.affordableFourthQueenBlockers).toEqual({ cooldown: 1 });
    expect(metrics.colonies[0]!.lastAffordableBlocked).toMatchObject({ liveQueens: 3, price: 1600, threshold: 1800, nextFoundTick: 6601 });
  });

});

describe("each live queen is an independent nest", () => {
  it("hatches at each live nest, charges brood costs, and obeys the colony cap", () => {
    const s = prepared(); expect(foundQueen(s, 0, X(18), Y(10), s.tick, [])).toBeNull();
    s.colonies[0].foodStore = 100;
    const events: SimEvent[] = [];
    hatch(s, s.tick + config.hatchIntervalTicks, events);
    expect(events.filter((e) => e.type === "hatch").map((e) => [e.tileX, e.tileY])).toEqual([[X(8), Y(24)], [X(18), Y(10)]]);
    expect(s.colonies[0].foodStore).toBe(100 - config.hatchCost - config.castes!.soldierCost);
    expect(s.ants.filter((a) => a.colony === 0).map((a) => a.caste)).toEqual(["worker", "soldier"]);
    const capped = { ...s, config: { ...s.config, colonyCap: 3 } };
    hatch(capped, s.tick + 2 * config.hatchIntervalTicks, []);
    expect(capped.ants.filter((a) => a.colony === 0)).toHaveLength(3);
  });
  it("returns and delivers to the nearest live nest and ignores a lost nest", () => {
    const s = prepared(); foundQueen(s, 0, X(18), Y(10), s.tick, []);
    const carrier = addAnt(s, 0, X(19), Y(10), { carrying: true });
    expect(forageDirection(s, carrier, []).x).toBeLessThan(0);
    const food = s.colonies[0].foodStore;
    pickupAndDeliver(s, new Set());
    expect(carrier.carrying).toBe(false); expect(s.colonies[0].foodStore).toBe(food + 1);
    s.colonies[0].queens![1]!.lostTick = s.tick; carrier.carrying = true;
    pickupAndDeliver(s, new Set());
    expect(carrier.carrying).toBe(true); expect(forageDirection(s, carrier, []).y).toBeGreaterThan(0);
    hatch(s, 1000, []);
    expect(s.ants.filter((a) => a.colony === 0 && a.x === (X(18) + 0.5) * SUB)).toHaveLength(0);
  });
  it("allocates guards to every queen and retires a lost queen's assignments", () => {
    const s = prepared(); foundQueen(s, 0, X(18), Y(10), s.tick, []);
    for (let i = 0; i < 8; i++) addAnt(s, 0, X(i < 4 ? 8 : 18), Y(i < 4 ? 24 : 10));
    rebalanceRoles(s);
    const budget = guardBudget(8, config);
    const total = Math.min(2 * budget, Math.floor(8 * 0.6));
    expect(s.ants.filter((a) => a.role === "guard")).toHaveLength(total);
    for (const queenId of [0, 1]) expect(s.ants.filter((a) => a.role === "guard" && a.guardQueenId === queenId)).toHaveLength(total / 2);
    s.colonies[0].queens![0]!.lostTick = s.tick; rebalanceRoles(s);
    expect(s.ants.some((a) => a.role === "guard" && a.guardQueenId === 0)).toBe(false);
  });
  it("preserves the one-budget split for recorded configs without the new switch", () => {
    const { guardsPerQueen: _, totalGuardSharePermille: __, ...oldRules } = QUEEN_RULES;
    const s = { ...prepared(), config: playable({ ...config, queenFounding: oldRules }) };
    foundQueen(s, 0, X(18), Y(10), s.tick, []);
    foundQueen(s, 0, X(18), Y(38), s.tick + QUEEN_RULES.cooldownTicks, []);
    for (let i = 0; i < 512; i++) addAnt(s, 0, X(8 + i % 20), Y(2 + i % 40), i < 100 ? { squad: "seated" } : {});
    rebalanceRoles(s);
    const guards = s.ants.filter((a) => a.role === "guard" && a.squad === null);
    const budget = guardBudget(512, config);
    expect(guards).toHaveLength(budget);
    const allocations = activeQueens(s.colonies[0]).map((q) => guards.filter((a) => a.guardQueenId === q.id).length);
    expect(Math.max(...allocations) - Math.min(...allocations)).toBeLessThanOrEqual(1);
    const before = guards.map((a) => [a.id, a.guardQueenId]);
    rebalanceRoles(s);
    expect(s.ants.filter((a) => a.role === "guard" && a.squad === null).map((a) => [a.id, a.guardQueenId])).toEqual(before);
    // The budget counts squad ants, but can never steal them when spares run out.
    for (const [i, ant] of s.ants.entries()) ant.squad = i < 4 ? null : "seated";
    rebalanceRoles(s);
    expect(s.ants.filter((a) => a.role === "guard" && a.squad === null)).toHaveLength(4);
  });
  it.each([2, 3, 4])("gives %s live queens their full target or a fair available-ant clamp without touching squads", (count) => {
    const s = prepared();
    for (const [i, [x, y]] of [[18, 10], [18, 38], [36, 24]].slice(0, count - 1).entries()) {
      setOwner(s, X(x!), Y(y!), 0); expect(foundQueen(s, 0, X(x!), Y(y!), s.tick + i * 1800, [])).toBeNull();
    }
    for (let i = 0; i < 512; i++) addAnt(s, 0, X(8 + i % 20), Y(2 + i % 40), { squad: i < 100 ? "seated" : null });
    const squadBefore = structuredClone(s.ants.slice(0, 100));
    rebalanceRoles(s);
    const snapshot = queenGuardSnapshot(s, 0), budget = guardBudget(512, config);
    expect(snapshot).toMatchObject({ perQueenTarget: budget, totalTarget: budget * count,
      eligibleAnts: 412, totalCap: 307, clamped: true, clampedByCap: true });
    const allocations = snapshot.queens.map((q) => q.assignedGuards);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(Math.min(307, 412, budget * count));
    expect(Math.max(...allocations) - Math.min(...allocations)).toBeLessThanOrEqual(1);
    expect(snapshot.nonHouseGuardAnts).toBeGreaterThanOrEqual(Math.ceil(512 * 0.4));
    expect(s.ants.slice(0, 100)).toEqual(squadBefore);
    const assigned = s.ants.map((a) => [a.id, a.role, a.guardQueenId]);
    rebalanceRoles(s); expect(s.ants.map((a) => [a.id, a.role, a.guardQueenId])).toEqual(assigned);
    expect(s.ants).toHaveLength(512);
  });

  it("reports per-queen guard peaks, physical presence and any target clamping separately", () => {
    const s = prepared(); foundQueen(s, 0, X(18), Y(10), s.tick, []);
    for (let i = 0; i < 20; i++) addAnt(s, 0, X(i < 10 ? 8 : 18), Y(i < 10 ? 24 : 10));
    rebalanceRoles(s);
    const metrics = queenReportMetrics(s);
    s.tick++; metrics.record(s, []);
    for (const [i, ant] of s.ants.entries()) ant.squad = i < 4 ? null : "seated";
    rebalanceRoles(s); s.tick++; metrics.record(s, []);
    const report = metrics.finish(s).colonies[0]!.guards;
    expect(report).toMatchObject({ clampedAnyTick: true, clampedTicks: 2, ceilingViolations: 0,
      atPeakColonyPopulation: { colonyAnts: 20, perQueenTarget: 8, totalCap: 12, clamped: true } });
    for (const q of report.queens) expect(q).toMatchObject({ peakAssignedGuards: 6,
      peakGuardsWithinOverrunRadius: 6, guardsWithinOverrunRadiusAtAssignedPeak: 6,
      perQueenTargetAtAssignedPeak: 8, clampedAnyTick: true });
    expect(JSON.parse(JSON.stringify(report)).queens).toHaveLength(2);
  });

  it("loses a queen independently, then the colony only on its last queen", () => {
    const s = { ...prepared(), config: playable({ ...config, overrunTicks: 2, overrunGraceTicks: 0 }) };
    foundQueen(s, 0, X(18), Y(10), s.tick, []);
    addAnt(s, 1, X(8), Y(24));
    const events: SimEvent[] = [];
    expect(updateOverrun(s, buildGrid(s), 100, events)).toBeNull();
    expect(updateOverrun(s, buildGrid(s), 101, events)).toBeNull();
    expect(activeQueens(s.colonies[0])).toHaveLength(1);
    expect(events.filter((e) => e.type === "queen_lost")).toHaveLength(1);
    addAnt(s, 1, X(18), Y(10));
    expect(updateOverrun(s, buildGrid(s), 102, events)).toBeNull();
    expect(updateOverrun(s, buildGrid(s), 103, events)).toMatchObject({ reason: "overrun", winner: 1 });
    expect(foundQueen(s, 0, X(18), Y(38), 5000, [])?.code).toBe("no_active_queen");
  });
  it("uses the match-start grace for founded queens, with no new grace period", () => {
    const s = { ...prepared(), config: playable({ ...config, overrunGraceTicks: 7200, overrunTicks: 1 }) };
    foundQueen(s, 0, X(18), Y(10), 7199, []); addAnt(s, 1, X(18), Y(10));
    expect(updateOverrun(s, buildGrid(s), 7199, [])).toBeNull();
    expect(s.colonies[0].queens![1]!.overrunTicks).toBe(0);
    updateOverrun(s, buildGrid(s), 7200, []);
    expect(s.colonies[0].queens![1]!.lostTick).toBe(7200);
  });
  it("uses the shipped 600-tick overrun interval", () => {
    const s = { ...prepared(), config: playable(PUBLIC_CONFIG) };
    addAnt(s, 1, X(8), Y(24)); const events: SimEvent[] = [];
    for (let t = 7200; t < 7799; t++) expect(updateOverrun(s, buildGrid(s), t, events)).toBeNull();
    expect(s.colonies[0].queens![0]!.overrunTicks).toBe(599);
    expect(updateOverrun(s, buildGrid(s), 7799, events)).toMatchObject({ reason: "overrun", tick: 7799 });
    expect(events.at(-2)).toMatchObject({ type: "overrun_progress", requiredTicks: 600 });
  });

  it("settles simultaneous last-queen losses with the existing tiebreak order", () => {
    const s = { ...prepared(), config: playable({ ...config, overrunTicks: 1, overrunGraceTicks: 0 }) };
    addAnt(s, 1, X(8), Y(24)); addAnt(s, 0, X(55), Y(24));
    const result = updateOverrun(s, buildGrid(s), 100, []);
    expect(result).toMatchObject({ reason: "double_overrun", winner: 0, decidedBy: "territory" });
    s.owner.fill(-1); expect(decideTimeUp(s, 100, "time_up").decidedBy).toBe("draw");
    s.stats.delivered[1] = 2; expect(decideTimeUp(s, 100, "time_up")).toMatchObject({ winner: 1, decidedBy: "food_delivered" });
    addAnt(s, 0, X(1), Y(1)); expect(decideTimeUp(s, 100, "time_up")).toMatchObject({ winner: 0, decidedBy: "ants_alive" });
  });
});

describe("queen rules, fog and house controller", () => {
  it("does not re-anchor a new squad and expand its visible ant payload merely because another nest exists", () => {
    const make = (many: boolean) => {
      const s = createMatch(6006, playable({ ...PUBLIC_CONFIG, startAnts: 0 }));
      for (const colony of [0, 1] as const) for (let i = 0; i < 512; i++) {
        const x = colony === 0 ? 4 + i % 24 : s.config.mapWidth - 5 - i % 24;
        addAnt(s, colony, x, 2 + Math.floor(i / 24) % (s.config.mapHeight - 4));
      }
      if (many) for (const [i, [x, y]] of [[18, 10], [18, 38]].entries()) {
        setOwner(s, X(x!), Y(y!), 0); s.colonies[0].foodStore = queenFoundingCost(s.colonies[0], QUEEN_RULES);
        expect(foundQueen(s, 0, X(x!), Y(y!), QUEEN_RULES.firstFoundTick! + i * QUEEN_RULES.cooldownTicks, [])).toBeNull();
      }
      s.tick = 6000;
      applyInput(s, { type: "join", agentId: "a", placement: 0 }, s.tick, defaultAllocator, []);
      fillSquads(s, defaultAllocator, s.tick, []);
      return takeView(s, buildGrid(s), s.agents[0]!);
    };
    const single = make(false), extra = make(true);
    const visible = (view: typeof single) => view.cells.flatMap((c) => c.ants.map((a) => a.antId));
    expect(new Set(visible(extra)).size).toBe(visible(extra).length); // no per-nest duplication
    expect(extra.squad.map((a) => a.antId)).toEqual(single.squad.map((a) => a.antId));
    expect(visible(extra)).toEqual(visible(single));
  });

  it("keeps one-nest states without queen founding", () => {
    expect(createMatch(1, playable(DEFAULT_CONFIG)).colonies[0].queens).toBeUndefined();
  });
  it("reveals own queens globally but not an enemy queen outside colony sight", () => {
    let s = prepared(); s = step(s, [{ type: "join", agentId: "a" }]).state;
    const out = step(s, [{ type: "found_queen", agentId: "a", tileX: X(18), tileY: Y(10) }]);
    const view = takeView(out.state, buildGrid(out.state), out.state.agents[0]!);
    expect(view.queens).toHaveLength(2);
    // A free hatch grants colony sight even when the caller has no squad.
    expect(view.cells.some(cell => cell.queen === 0)).toBe(true);
    expect(view.cells.some(cell => cell.queen === 1)).toBe(false);
    expect(out.results[0]).toMatchObject({ ok: true, view: { events: [expect.objectContaining({ type: "queen_founded", colony: 0 })] } });
    expect(JSON.stringify(view.queens)).not.toContain('"tileX":111'); // the enemy queen's fine tile
  });
  it("uses the founding validator for house-only colonies, not agents' shared stores", () => {
    const s = prepared(), events: SimEvent[] = [];
    houseFounding(s, s.tick, events);
    expect(events.some((e) => e.type === "queen_founded")).toBe(true);
    let seated = prepared(); seated = step(seated, [{ type: "join", agentId: "a" }]).state;
    const before = seated.colonies[0].foodStore; houseFounding(seated, 2000, []);
    expect(seated.colonies[0].foodStore).toBe(before); expect(seated.colonies[0].queens).toHaveLength(1);
  });
  it("spends house surplus at cost plus exactly 200, respecting cooldown and held sites", () => {
    const s = prepared(), events: SimEvent[] = [];
    const reserve = houseFoundingReserve(s);
    expect(reserve).toBe(200);
    s.colonies[0].foodStore = QUEEN_RULES.cost + reserve - 1;
    houseFounding(s, s.tick, events);
    expect(events).toEqual([]);
    s.colonies[0].foodStore++;
    houseFounding(s, s.tick, events);
    expect(events).toHaveLength(1);
    expect(s.colonies[0].foodStore).toBe(reserve);
    s.colonies[0].foodStore = 1000;
    houseFounding(s, s.tick + QUEEN_RULES.cooldownTicks - 1, events);
    expect(events).toHaveLength(1);
    houseFounding(s, s.tick + QUEEN_RULES.cooldownTicks, events);
    expect(events).toHaveLength(2);
    s.owner.fill(-1);
    houseFounding(s, s.tick + 2 * QUEEN_RULES.cooldownTicks, events);
    expect(events).toHaveLength(2);
    expect(s.colonies[0].foodStore).toBe(1000 - 2 * QUEEN_RULES.cost);
  });

  it("turns a recorded larger ground payout into a paid house queen on the next tick", () => {
    const s = createMatch(6006, playable({ ...PRE_FRONTLINE_PUBLIC_CONFIG, startAnts: 0 }));
    s.tick = QUEEN_RULES.firstFoundTick!;
    s.owner.fill(-1); s.lastVisit.fill(s.tick);
    // Ground pays per reference tile: four fine cells each at grid scale 2.
    for (let i = 0; i < 4 * (QUEEN_RULES.cost + houseFoundingReserve(s) + 20); i++) s.owner[i] = 0;
    for (let i = 4 * 1000; i < 4 * (1000 + QUEEN_RULES.cost - 20); i++) s.owner[i] = 1;
    const paid = step(s);
    expect(paid.state.colonies[0].foodStore).toBeGreaterThan(QUEEN_RULES.cost + houseFoundingReserve(s));
    expect(paid.state.colonies[1].foodStore).toBeLessThan(QUEEN_RULES.cost);
    const metrics = queenReportMetrics(paid.state);
    const founded = step(paid.state); metrics.record(founded.state, founded.events);
    expect(founded.events.flatMap((e) => e.type === "queen_founded" ? [e.colony] : [])).toEqual([0]);
    const report = metrics.finish(founded.state);
    expect(report.colonies.map((c) => c.foodSpentOnFounding)).toEqual([QUEEN_RULES.cost, 0]);
    expect(report.territoryFoundingComparison).toMatchObject({ moreGroundColony: 0, moreGroundFoundedMore: true });
  });

  it("reports actual founding spend, losses, held-ground samples and the end reason", () => {
    const initial = prepared();
    const s = { ...initial, config: { ...initial.config, queenFounding: { ...initial.config.queenFounding!, firstFoundTick: 0 }, overrunTicks: 1, overrunGraceTicks: 0 }, tick: 0 };
    const metrics = queenReportMetrics(s);
    const events: SimEvent[] = [];
    const before = s.colonies[0].foodStore;
    houseFounding(s, s.tick, events);
    const founded = events.find((e) => e.type === "queen_founded");
    if (founded?.type !== "queen_founded") throw new Error("house founding did not produce its lifecycle event");
    s.tick = 1; metrics.record(s, events);
    const lost: SimEvent[] = [];
    addAnt(s, 1, founded.tileX, founded.tileY);
    updateOverrun(s, buildGrid(s), 10, lost);
    s.tick = 11; metrics.record(s, lost);
    s.tick = config.ticksPerSecond * 60; metrics.record(s, []);
    s.result = decideTimeUp(s, s.tick, "time_up");
    const report = metrics.finish(s);
    expect(report.colonies[0]!.foodSpentOnFounding).toBe(before - s.colonies[0].foodStore);
    expect(report.colonies[0]!.queensFounded).toEqual([expect.objectContaining({ tick: 0, tileX: founded.tileX, tileY: founded.tileY, foodCost: QUEEN_RULES.cost })]);
    expect(report.colonies[0]!.queensLost).toEqual([expect.objectContaining({ tick: 10, tileX: founded.tileX, tileY: founded.tileY })]);
    expect(report.colonies[1]!.foodSpentOnFounding).toBe(0);
    expect(report.territorySamples.map((sample) => sample.tick)).toEqual([0, config.ticksPerSecond * 60]);
    expect(report.end).toMatchObject({ tick: s.tick, reason: "time_up" });
    expect(report.territoryFoundingComparison.moreGroundColony).toBe(0);
    expect(report.territoryFoundingComparison.moreGroundFoundedMore).toBe(true);
  });

  it("counts the transient live peak when founding and loss occur in the same step", () => {
    const initial = prepared();
    const s = { ...initial, config: { ...initial.config, overrunTicks: 1, overrunGraceTicks: 0 } };
    const metrics = queenReportMetrics(s), events: SimEvent[] = [];
    expect(foundQueen(s, 0, X(18), Y(10), s.tick, events)).toBeNull();
    addAnt(s, 1, X(18), Y(10));
    updateOverrun(s, buildGrid(s), s.tick, events);
    metrics.record(s, events);
    const report = metrics.finish(s).colonies[0]!;
    expect(report).toMatchObject({ peakLiveQueens: 2, liveQueensAtEnd: 1, foodSpentOnFounding: 400 });
    expect(report.guards.queens.find((q) => q.queenId === 1)).toMatchObject({ samples: 0, peakAssignedGuards: 0 });
  });

  it("requires the complete four-seed duration set and preserves failures", () => {
    const runs = [6006, 6007, 10, 11].map((seed, i) => ({ seed, ticks: [7200, 12000, 12000, 18000][i]!, reason: i === 3 ? "time_up" as const : "overrun" as const, exitCode: 0 }));
    expect(queenDurationVerdict(runs, PUBLIC_CONFIG)).toMatchObject({ exitCode: 0, medianEndTick: 12000 });
    expect(queenDurationVerdict(runs.slice(1), PUBLIC_CONFIG).exitCode).toBe(1);
    expect(queenDurationVerdict(runs.map((r, i) => i === 0 ? { ...r, ticks: 7199 } : r), PUBLIC_CONFIG).exitCode).toBe(1);
    expect(queenDurationVerdict(runs.map((r) => ({ ...r, reason: "overrun" as const })), PUBLIC_CONFIG).exitCode).toBe(0);
    expect(queenDurationVerdict(runs.map((r, i) => i === 1 ? { ...r, ticks: 11999 } : r), PUBLIC_CONFIG).exitCode).toBe(1);
    expect(queenDurationVerdict(runs.map((r, i) => i === 0 ? { ...r, exitCode: 1 } : r), PUBLIC_CONFIG).exitCode).toBe(1);
    expect(queenDurationVerdict(runs.map((r) => ({ ...r, seed: 6006 })), PUBLIC_CONFIG).exitCode).toBe(1);
    expect(queenDurationVerdict(runs.map((r, i) => i === 0 ? { ...r, reason: null } : r), PUBLIC_CONFIG).exitCode).toBe(1);
    const atTwentyFive = runs.map((r, i) => ({ ...r, reason: "overrun" as const, ticks: i === 3 ? 15000 : r.ticks }));
    expect(queenDurationVerdict(atTwentyFive, PUBLIC_CONFIG)).toMatchObject({ exitCode: 1,
      checks: { includesMatchPastTwentyFiveMinutes: false } });
    const pastTwentyFive = atTwentyFive.map((r, i) => i === 3 ? { ...r, ticks: 15001 } : r);
    expect(queenDurationVerdict(pastTwentyFive, PUBLIC_CONFIG)).toMatchObject({ exitCode: 0, medianEndTick: 12000,
      checks: { includesMatchPastTwentyFiveMinutes: true } });
    expect(queenDurationVerdict(pastTwentyFive, PUBLIC_CONFIG).checks).not.toHaveProperty("includesTimeUp");
  });

  it.each([0, 1] as const)("names winning colony %s and an overrun explicitly in the report", (winner) => {
    expect(queenOutcome(6006, 15001, { winner, reason: "overrun", decidedBy: "overrun", tick: 15000 }))
      .toEqual({ seed: 6006, endTick: 15001, status: "complete", winner, winnerName: COLONY_NAMES[winner],
        reason: "overrun", decidedBy: "overrun", decisionTick: 15000 });
  });

  it.each(["territory", "ants_alive", "food_delivered"] as const)("reports the %s time-up tiebreak", (decidedBy) => {
    expect(queenOutcome(11, 18000, { winner: 1, reason: "time_up", decidedBy, tick: 17999 }))
      .toMatchObject({ seed: 11, status: "complete", winner: 1, winnerName: COLONY_NAMES[1], reason: "time_up", decidedBy });
  });

  it("distinguishes a draw, a double overrun and an unfinished match", () => {
    expect(queenOutcome(10, 18000, { winner: null, reason: "time_up", decidedBy: "draw", tick: 17999 }))
      .toMatchObject({ status: "complete", winner: null, winnerName: null, decidedBy: "draw" });
    expect(queenOutcome(10, 15001, { winner: 0, reason: "double_overrun", decidedBy: "territory", tick: 15000 }))
      .toMatchObject({ status: "complete", winner: 0, reason: "double_overrun", decidedBy: "territory" });
    expect(queenOutcome(6007, 400, null)).toEqual({ seed: 6007, endTick: 400, status: "unfinished" });
    expect(queenOutcome(6007, 400, null)).not.toHaveProperty("winner");
  });

  it.each(["--rule-set", "--diagnose-rejected"])("rejects removed report control %s before any match runs", (flag) => {
    // Invalid head is a second fail-closed guard: even a regression cannot launch a match here.
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/sim/queen-report.ts",
      "--head", "invalid", flag, ...(flag === "--rule-set" ? ["1'+2"] : [])], { encoding: "utf8", timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION"); expect(result.stderr).toContain(flag);
  });

  it("records only the shipped capped-guard rules with a 60-second overrun", () => {
    expect(PUBLIC_CONFIG.overrunTicks).toBe(600);
    expect(PUBLIC_CONFIG.queenFounding).toMatchObject({ guardsPerQueen: true, totalGuardSharePermille: 600 });
    expect(PUBLIC_CONFIG.queenFounding).not.toHaveProperty("foundingProtectionTicks");
    expect(JSON.parse(headerLine(6006, PUBLIC_CONFIG)).config).toEqual(PUBLIC_CONFIG);
    const short = playable({ ...PUBLIC_CONFIG, matchTicks: 20, startAnts: 4 });
    let state = createMatch(7, short); for (let i = 0; i < 20; i++) state = step(state).state;
    expect(stateHash(replay([headerLine(7, short)], 20))).toBe(stateHash(state));
  });

  it("requires a yes/no ground association and the corrected 100 ms tick budget", () => {
    const good = { founded: 2, finished: true, withinCap: true, hasObserve: true, slowestTickMs: 7.21, moreGroundFoundedMore: true, guardCeiling: true };
    expect(Object.values(queenRunChecks(good)).every(Boolean)).toBe(true);
    expect(queenRunChecks({ ...good, slowestTickMs: 100 }).tickBudget).toBe(true);
    expect(queenRunChecks({ ...good, slowestTickMs: 100.01 }).tickBudget).toBe(false);
    expect(queenRunChecks({ ...good, moreGroundFoundedMore: false }).moreGroundFoundedMore).toBe(false);
    const tied = queenReportMetrics(createMatch(7, playable(config))).finish(createMatch(7, playable(config)));
    expect(tied.territoryFoundingComparison).toMatchObject({ moreGroundColony: null, moreGroundFoundedMore: false, comparisonApplicable: false });
  });

  it("replays a successful founding from seeded inputs exactly", () => {
    const c = playable({ ...config, startAnts: 10, matchTicks: 20, queenFounding: { cost: 0, minDistanceTiles: 1, cooldownTicks: 2 } });
    const join: SimInput[] = [{ type: "join", agentId: "a" }];
    let s = step(createMatch(31, c), join).state;
    // A held tile clear of the nest by the founding distance (one reference tile, two fine tiles).
    const queen = s.colonies[0].queens![0]!, qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
    const t = s.owner.findIndex((owner, i) => owner === 0 &&
      (i % c.mapWidth - qx) ** 2 + (Math.floor(i / c.mapWidth) - qy) ** 2 >= c.queenFounding!.minDistanceTiles ** 2);
    expect(t).toBeGreaterThanOrEqual(0);
    const input: SimInput[] = [{ type: "found_queen", agentId: "a", tileX: t % c.mapWidth, tileY: Math.floor(t / c.mapWidth) }];
    const out = step(s, input); s = out.state;
    expect(out.results[0]?.ok).toBe(true);
    expect(out.events.some((e) => e.type === "queen_founded" && e.colony === 0)).toBe(true);
    for (let i = 2; i < 20; i++) s = step(s).state;
    const log = [headerLine(31, c), tickLine(0, join), tickLine(1, input)];
    expect(stateHash(replay(log, 20))).toBe(stateHash(s));
  });
});

it("agents and house bots can found a fifth live queen at 3,200, with unchanged opening, cooldown and spacing", () => {
  for (const house of [false, true]) {
    const s = prepared();
    s.colonies[0].foodStore = 10000;
    const sites = [[18, 10], [18, 38], [36, 24], [45, 5]] as const;
    const events: SimEvent[] = [];
    for (const [i, [x, y]] of sites.entries()) {
      s.tick = 3000 + 1800 * i;
      s.owner.fill(-1); setOwner(s, X(x), Y(y), 0);
      if (house) houseFounding(s, s.tick, events);
      else expect(foundQueen(s, 0, X(x), Y(y), s.tick, events)).toBeNull();
      expect(activeQueens(s.colonies[0])).toHaveLength(i + 2);
    }
    expect(events.flatMap(e => e.type === "queen_founded" ? [e.foodCost] : [])).toEqual([400, 800, 1600, 3200]);
    expect(s.colonies[0].foodStore).toBe(4000);
    expect(queenFoundingCost(s.colonies[0], QUEEN_RULES)).toBe(6400);
    expect(QUEEN_RULES).toMatchObject({ firstFoundTick: 3000, cooldownTicks: 1800, minDistanceTiles: 16 });
  }
});

it("uses kills for simultaneous double overrun, but never for a one-colony elimination", () => {
  const s = emptyMatch(100, { ...config, overrunTicks: 1, overrunGraceTicks: 0 });
  addAnt(s, 1, X(8), Y(24)); addAnt(s, 0, X(55), Y(24));
  s.owner[0] = 1; s.stats.deaths = [1, 4];
  expect(updateOverrun(s, buildGrid(s), 100, [])).toMatchObject({ winner: 0, reason: "double_overrun", decidedBy: "kills" });
  const single = emptyMatch(100, { ...config, overrunTicks: 1, overrunGraceTicks: 0 });
  addAnt(single, 1, X(8), Y(24)); single.stats.deaths = [1, 40];
  expect(updateOverrun(single, buildGrid(single), 100, [])).toMatchObject({ winner: 1, reason: "overrun", decidedBy: "overrun" });
});


it("uses kills when both last queens die together, but preserves a single elimination", () => {
  const state = emptyMatch(100, config);
  state.owner[0] = 1; state.stats.deaths = [1, 4];
  state.colonies[0].queens![0]!.lostTick = 100;
  expect(queensKilled(state, 100)).toMatchObject({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed" });
  state.colonies[1].queens![0]!.lostTick = 100;
  expect(queensKilled(state, 100)).toMatchObject({ winner: 0, reason: "queens_killed", decidedBy: "kills" });
});

it("counts queen bites as colony kills, not as the victim colony's kills", () => {
  const state = emptyMatch(600, { ...config, queenHp: QUEEN_HP_RULES });
  addAnt(state, 1, X(9), Y(24), { hp: 100 });
  for (const i of [0, 1, state.config.mapWidth, state.config.mapWidth + 1]) state.owner[i] = 1; // one reference tile
  resolveCombat(state, buildGrid(state), 600, []);
  expect(state.stats.deaths).toEqual([0, 1]);
  expect(decideTimeUp(state, 600, "time_up")).toMatchObject({ winner: 0, decidedBy: "kills" });
});
