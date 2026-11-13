import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { foodTiles } from "../../src/sim/forage.js";
import { enforceQueenGuardCap, houseDirection, queenGuardTargets, rebalanceRoles } from "../../src/sim/houseBot.js";
import { distance } from "../../src/sim/geometry.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { activeQueens, buildGrid, cloneState } from "../../src/sim/map.js";
import { playScripted } from "../../src/live/record.js";
import { step } from "../../src/sim/step.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Every match plays at grid scale 2: rules is the reference-grid template that emptyMatch builds
// at grid scale 2. An ant at reference tile (tx, ty) stands at that tile's centre (fine 2t + 0.5), and
// every subunit position doubles.
const put = (s: SimState, colony: 0 | 1, tx: number, ty: number, patch: Partial<Ant> = {}) => addAnt(s, colony, 2 * tx + 0.5, 2 * ty + 0.5, patch);

const rules: SimConfig = { ...recordedHousePlan(rulesConfig("redesign")), foodLayout: undefined, foodPatches: [],
  startAnts: 0, squadSize: 0, hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  rallyStartPermille: 800, rallyEndPermille: 800 };
function scenario(config = rules) {
  const state: SimState = { ...emptyMatch(0, config), terrain: undefined };
  state.food.fill(0);
  return state;
}
const direction = (s: SimState, a: Ant) => houseDirection(s, buildGrid(s), foodTiles(s), a);

describe("house assignment minimum holds", () => {
  it("holds a chase choice when the intruder leaves, without disabling worker-guard rules", () => {
    const s = scenario(rules);
    const guard = put(s, 0, 10, 24, { role: "guard", caste: "soldier", guardQueenId: 0 });
    const intruder = put(s, 1, 13, 24);
    expect(direction(s, guard).x).toBeGreaterThan(0);
    intruder.x = 34 * SUB;
    s.tick = 1;
    expect(Math.sign(direction(s, guard).x)).toBe(1);
    expect("houseIntentHold" in guard).toBe(true);
    expect(s.config.localAnts?.workerHomeGuardHold).toBe(true);
  });
  it.each([10, 20])("holds chase/post decisions for two seconds at %i ticks/s without renewing", ticksPerSecond => {
    const s = scenario({ ...rules, ticksPerSecond });
    const guard = put(s, 0, 10, 24, { role: "guard", caste: "soldier", guardQueenId: 0 });
    const intruder = put(s, 1, 13, 24);
    expect(direction(s, guard).x).toBeGreaterThan(0);
    intruder.x = 34 * SUB;
    for (let tick = 1; tick < 2 * ticksPerSecond; tick++) {
      s.tick = tick;
      expect(direction(s, guard).x).toBeGreaterThan(0);
    }
    s.tick = 2 * ticksPerSecond;
    expect(direction(s, guard).x).toBeLessThan(0);
    // A new post decision also holds, rather than chasing again on the next tick.
    intruder.x = 26 * SUB;
    s.tick++;
    expect(direction(s, guard).x).toBeLessThan(0);
    s.tick = 4 * ticksPerSecond;
    expect(direction(s, guard).x).toBeGreaterThan(0);
  });

  it("releases a dead chase target immediately and does not hold against adjacent combat", () => {
    const s = scenario(), guard = put(s, 0, 10, 24, { role: "guard", caste: "soldier" });
    const intruder = put(s, 1, 13, 24);
    direction(s, guard);
    s.tick = 1; intruder.hp = 0; s.ants.pop();
    expect(direction(s, guard).x).toBeLessThan(0);
    put(s, 1, 11, 24);
    expect(direction(s, guard)).toEqual({ x: 0, y: 0 });
  });

  it("retains pursuit when an enemy crosses sight range, then permits rally at expiry", () => {
    const s = scenario(), fighter = put(s, 0, 20, 24, { role: "fighter", caste: "soldier" });
    const enemy = put(s, 1, 17, 24);
    expect(direction(s, fighter).x).toBeLessThan(0);
    enemy.x = 20 * SUB;
    s.tick = 19;
    expect(direction(s, fighter).x).toBeLessThan(0);
    s.tick = 20;
    expect(direction(s, fighter).x).toBeGreaterThan(0);
    enemy.x = 34 * SUB;
    s.tick = 21;
    expect(direction(s, fighter).x).toBeGreaterThan(0); // Rally cannot immediately flip back.
    s.tick = 40;
    expect(direction(s, fighter).x).toBeLessThan(0);
  });

  it.each([false, true])("holds attack/retreat when local strength changes (retreat first: %s)", retreatFirst => {
    const s = scenario(), fighter = put(s, 0, 20, 24, { role: "fighter", caste: "soldier" });
    put(s, 1, 23, 24);
    if (retreatFirst) { put(s, 1, 23, 25); put(s, 1, 23, 23); }
    const first = direction(s, fighter).x;
    expect(Math.sign(first)).toBe(retreatFirst ? -1 : 1);
    if (retreatFirst) s.ants.splice(2);
    else { put(s, 1, 23, 25); put(s, 1, 23, 23); }
    for (let tick = 1; tick < 20; tick++) {
      s.tick = tick;
      expect(Math.sign(direction(s, fighter).x)).toBe(Math.sign(first));
    }
    s.tick = 20;
    expect(Math.sign(direction(s, fighter).x)).toBe(-Math.sign(first));
  });

  it("holds the rally queen through a nearest-home change, but not her death", () => {
    const s = scenario({ ...rules, rallyStartPermille: 0, rallyEndPermille: 0 });
    const first = s.colonies[0].queens![0]!;
    s.colonies[0].queens!.push({ ...first, id: 1, queenX: 81_000 });
    const fighter = put(s, 0, 20, 24, { role: "fighter", caste: "soldier" });
    expect(direction(s, fighter).x).toBeLessThan(0);
    fighter.x = 53_000; s.tick = 19;
    expect(direction(s, fighter).x).toBeLessThan(0);
    const copy = cloneState(s);
    copy.colonies[0].queens![0]!.lostTick = 19;
    expect(direction(copy, copy.ants[0]!).x).toBeGreaterThan(0);
    s.tick = 20;
    expect(direction(s, fighter).x).toBeGreaterThan(0);
  });

  it("prefers mature role candidates but always meets the unchanged fighter target", () => {
    let s = scenario({ ...rules, queenFounding: undefined, guardCount: 0,
      guardSharePermille: undefined, fighterShareStartPermille: 500, fighterShareEndPermille: 500 });
    for (let i = 0; i < 2; i++) put(s, 0, 20, 20, { role: "fighter", caste: "worker" });
    rebalanceRoles(s);
    s.tick = 20;
    put(s, 0, 20, 20, { role: "forager", caste: "worker" });
    put(s, 0, 20, 20, { role: "forager", caste: "worker" });
    s = { ...s, config: { ...s.config, fighterShareStartPermille: 750, fighterShareEndPermille: 750 } };
    rebalanceRoles(s);
    expect(s.ants.filter(a => a.role === "fighter")).toHaveLength(3);
    s.tick = 21;
    s = { ...s, config: { ...s.config, fighterShareStartPermille: 500, fighterShareEndPermille: 500 } };
    rebalanceRoles(s);
    expect(s.ants[2]!.role).toBe("fighter"); // Newly promoted, unlike main's highest-id release.
    expect(s.ants.filter(a => a.role === "fighter")).toHaveLength(2);
    s = { ...s, config: { ...s.config, fighterShareStartPermille: 0, fighterShareEndPermille: 0 } };
    rebalanceRoles(s);
    expect(s.ants.every(a => a.role === "forager")).toBe(true); // Required staffing overrides all holds.
  });

  it("retains a newly appointed queen guard before a mature one when the budget shrinks", () => {
    let s = scenario({ ...rules, guardCount: 2, guardSharePermille: 0,
      queenFounding: { ...rules.queenFounding!, guardsPerQueen: false, totalGuardSharePermille: 1000 } });
    for (let i = 0; i < 4; i++) put(s, 0, 9 + i, 24, { role: "forager", caste: "worker" });
    rebalanceRoles(s);
    expect(s.ants.filter(a => a.role === "guard")).toHaveLength(2);
    s.tick = 20;
    s = { ...s, config: { ...s.config, guardCount: 3 } };
    rebalanceRoles(s);
    const newest = s.ants[2]!;
    expect(newest.role).toBe("guard");
    s.tick = 21;
    s = { ...s, config: { ...s.config, guardCount: 2 } };
    rebalanceRoles(s);
    expect(newest.role).toBe("guard");
    expect(s.ants.filter(a => a.role === "guard")).toHaveLength(2);
    expect(s.ants.filter(a => a.guardQueenId === 0)).toHaveLength(2);
  });

  it.each([true, false])("preserves the previous queen-guard ordering with holds enabled=%s", enabled => {
    type RememberedAnt = Ant & { houseRoleHold?: { role: Ant["role"]; changedTick: number } };
    // Reference is the comparator at ecab0ee, before the performance-only change.
    const reference = (state: SimState) => {
      const members = state.ants.filter(a => a.colony === 0 && a.squad === null && a.claim === undefined);
      const held = (ant: Ant) => {
        const old = (ant as RememberedAnt).houseRoleHold;
        return state.config.localAnts?.workerHomeGuardHold === true && old?.role === ant.role &&
          state.tick - old.changedTick < 2 * state.config.ticksPerSecond;
      };
      const queens = activeQueens(state.colonies[0]);
      const queues = queens.map(q => ({ q, next: 0, ordered: [...members].sort((a, b) =>
        Number(b.role === "guard" && b.guardQueenId === q.id) - Number(a.role === "guard" && a.guardQueenId === q.id) ||
        Number(b.role === "guard" && held(b)) - Number(a.role === "guard" && held(a)) ||
        Number(a.role !== "guard" && held(a)) - Number(b.role !== "guard" && held(b)) ||
        distance(a.x, a.y, q.queenX, q.queenY) - distance(b.x, b.y, q.queenX, q.queenY) || a.id - b.id) }));
      const budget = queenGuardTargets(state.ants.length, members.length, queens.length, state.config).assignedTarget;
      const assigned = new Set<Ant>();
      for (let slot = 0; slot < budget; slot++) {
        const queue = queues[slot % queues.length]!;
        while (assigned.has(queue.ordered[queue.next]!)) queue.next++;
        const ant = queue.ordered[queue.next++]!;
        ant.role = "guard"; ant.guardQueenId = queue.q.id; assigned.add(ant);
      }
      for (const ant of members) if (!assigned.has(ant)) {
        delete ant.guardQueenId;
        if (ant.role === "guard") ant.role = ant.caste === "soldier" ? "fighter" : "forager";
      }
    };
    const assignments = (s: SimState) => [...s.ants].sort((a, b) => a.id - b.id)
      .map(a => [a.id, a.role, a.guardQueenId ?? null]);
    for (const tick of [0, 1, 19, 20, 21, 400]) for (const reversed of [false, true]) {
      const s = scenario({ ...rules, guardCount: 5, guardSharePermille: 0,
        localAnts: { ...rules.localAnts!, workerHomeGuardHold: enabled },
        queenFounding: { ...rules.queenFounding!, guardsPerQueen: true, totalGuardSharePermille: 1000 } });
      s.tick = tick;
      const first = s.colonies[0].queens![0]!;
      s.colonies[0].queens!.push({ ...first, id: 1, queenX: 41_000, queenY: 31_000 },
        { ...first, id: 2, queenX: 81_000, queenY: 67_000 });
      for (let i = 0; i < 48; i++) {
        const role = (["guard", "fighter", "forager"] as const)[i % 3]!;
        const ant = put(s, 0, 8 + 4 * (i % 8), 24 + (i % 2), { role,
          caste: i % 4 === 0 ? "soldier" : "worker", guardQueenId: (i % 5) - 1 });
        if (i % 4 !== 0) (ant as RememberedAnt).houseRoleHold = {
          role: i % 7 === 0 ? "forager" : role, changedTick: [0, tick - 19, tick - 20][i % 3]!,
        };
      }
      const expected = cloneState(s);
      reference(expected);
      if (reversed) s.ants.reverse();
      enforceQueenGuardCap(s);
      expect(assignments(s)).toEqual(assignments(expected));
    }
  });

  it.each(["squad", "claim"] as const)("%s ownership clears planner history", owner => {
    const s = scenario(), fighter = put(s, 0, 20, 24, { role: "fighter", caste: "soldier" });
    rebalanceRoles(s); direction(s, fighter);
    expect("houseIntentHold" in fighter).toBe(true);
    if (owner === "squad") fighter.squad = "script";
    else fighter.claim = 1;
    rebalanceRoles(s);
    expect((fighter as { houseIntentHold?: unknown }).houseIntentHold).toBeUndefined();
    expect((fighter as { houseRoleHold?: unknown }).houseRoleHold).toBeUndefined();
  });

  it("isolates shallow-cloned history, resumes serialization, and wires holds through real steps", () => {
    const s = scenario(), guard = put(s, 0, 10, 24, { role: "guard", caste: "soldier" });
    put(s, 1, 13, 24);
    const before = stateHash(s);
    const first = step(s).state;
    expect(stateHash(s)).toBe(before);
    expect("houseIntentHold" in first.ants.find(a => a.id === guard.id)!).toBe(true);
    const hash = stateHash(first), copy = cloneState(first);
    copy.tick = 20;
    direction(copy, copy.ants[0]!);
    expect(stateHash(first)).toBe(hash);
    const resumed = JSON.parse(JSON.stringify(first)) as SimState;
    expect(stateHash(step(resumed).state)).toBe(stateHash(step(first).state));
  });

  it("leaves non-opted-in house choices and state shape unchanged", () => {
    const s = scenario({ ...rules, localAnts: undefined }), fighter = put(s, 0, 20, 24, { role: "fighter" });
    const enemy = put(s, 1, 17, 24);
    expect(direction(s, fighter).x).toBeLessThan(0);
    enemy.x = 20 * SUB; s.tick = 1;
    expect(direction(s, fighter).x).toBeGreaterThan(0);
    rebalanceRoles(s);
    expect((fighter as { houseIntentHold?: unknown }).houseIntentHold).toBeUndefined();
    expect((fighter as { houseRoleHold?: unknown }).houseRoleHold).toBeUndefined();
  });

  it("replays unseated house assignments deterministically", () => {
    const run = playScripted({ seed: 6006, config: playable(recordedHousePlan(rulesConfig("redesign"))), agents: 0, ticks: 120 });
    expect(stateHash(replay(run.lines, run.state.tick))).toBe(stateHash(run.state));
  });
});
