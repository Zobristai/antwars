import { describe, expect, it } from "vitest";
import { attackDirection, countMarkDirection, squadDirections } from "../../src/sim/agents.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { damagePerTick, DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { forageDirection } from "../../src/sim/forage.js";
import { tileCentre, ZERO, type Vec } from "../../src/sim/geometry.js";
import { houseDirection, localDirection } from "../../src/sim/houseBot.js";
import { beginLocalGoals, readLocalGoal } from "../../src/sim/localArrival.js";
import { activeQueens, buildGrid } from "../../src/sim/map.js";
import { advanceSoftAnts, step } from "../../src/sim/step.js";
import { updateOverrun } from "../../src/sim/territory.js";
import { comparisonOptions } from "../../src/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import type { Agent, Ant, CountMarkVerb, Mark, Order, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

type Group = "free" | "squad" | "count mark";
const groups: Group[] = ["free", "squad", "count mark"];
const orders: Order[] = [{ kind: "hold" }, { kind: "go_to", tileX: 30, tileY: 24 },
  { kind: "attack", tileX: 20, tileY: 24 }, { kind: "forage" }, { kind: "follow_trail" }];
const verbs: CountMarkVerb[] = ["ATTACK", "DEFEND", "GATHER", "FORAGE", "PATROL"];

function scene(group: Group = "free", soft = true) {
  const base = rulesConfig("redesign");
  const config: SimConfig = { ...base,
    terrain: undefined, foodLayout: undefined, foodPatches: [], startAnts: 0,
    softSeparation: soft ? base.softSeparation : undefined, squadSize: group === "squad" ? 1 : 0,
    squadSupplyPermille: 1000, earlyWin: undefined,
    hatchCost: 1_000_000, combatGraceTicks: 0,
    queenHp: { ...base.queenHp!, shieldTicks: 0 },
    countMarks: base.countMarks };
  const state = emptyMatch(100, config);
  for (const colony of state.colonies) colony.foodStore = 0;
  const carrier = addAnt(state, 0, 20, 24, { carrying: true, caste: "worker", hp: 100_000 });
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "attack", tileX: 30, tileY: 24 }, lastCallTick: 100,
    lastCommandTick: 100, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  const mark: Mark = { id: state.nextMarkId++, agentId: "a", colony: 0, tileX: 24, tileY: 24,
    words: [], laidTick: 100, steering: 0, verb: "ATTACK", count: 1 };
  if (group === "squad") { carrier.squad = agent.id; agent.squad.push(carrier.id); }
  if (group === "count mark") { carrier.claim = mark.id; state.marks.push(mark); }
  return { state, carrier, agent, mark };
}
function enemyQueen(state: SimState) {
  const queen = { ...activeQueens(state.colonies[1])[0]!, queenX: tileCentre(21), queenY: tileCentre(24) };
  state.colonies[1].queens = [queen];
  return queen;
}
function plan(state: SimState, carrier: Ant, group: Group, agent: Agent, mark: Mark): Vec {
  const grid = buildGrid(state);
  if (group === "squad") return squadDirections(state, grid, [], agent, state.tick).dirs.get(carrier.id)!;
  if (group === "count mark") return countMarkDirection(state, grid, [], carrier, mark).dir;
  return localDirection(state, grid, carrier).dir;
}

describe(`carrier combat under rules 27`, () => {
  for (const group of groups) describe(group, () => {
    it.each([false, true])("carrying=%s gates outgoing ant damage, not incoming damage", carrying => {
      const { state, carrier } = scene(group);
      carrier.carrying = carrying;
      const enemy = addAnt(state, 1, 21, 24, { hp: 100_000 });
      carrier.lastTargetId = enemy.id;
      const events: SimEvent[] = [];
      resolveCombat(state, buildGrid(state), state.tick, events);
      expect(enemy.hp).toBe(100_000 - (carrying ? 0 : damagePerTick(state.config)));
      expect(carrier.hp).toBe(100_000 - damagePerTick(state.config));
      expect(carrier.lastTargetId).toBe(carrying ? -1 : enemy.id);
      expect(state.stats.bonusHits).toEqual([0, 0]);
      expect(events.some(event => event.type === "fight" && event.antId === carrier.id)).toBe(false);
    });
    it.each([false, true])("carrying=%s gates queen damage while queens can still bite", carrying => {
      const { state, carrier } = scene(group);
      carrier.carrying = carrying;
      carrier.lastTargetId = 123;
      const queen = enemyQueen(state), before = queen.hp!;
      resolveCombat(state, buildGrid(state), state.tick, []);
      expect(queen.hp).toBe(before - (carrying ? 0 : damagePerTick(state.config)));
      expect(carrier.hp).toBe(100_000 - state.config.queenHp!.biteDamage);
      expect(carrier.lastTargetId).toBe(-1);
    });
  });
});

describe("rules-25 carrier delivery planning", () => {
  for (const group of groups) it.each(["ant", "queen"])(`${group} ignores nearby enemy %s and records home, not combat/mark`, enemy => {
    const { state, carrier, agent, mark } = scene(group);
    beginLocalGoals(state);
    const emptyDirection = plan(state, carrier, group, agent, mark);
    if (enemy === "ant") addAnt(state, 1, 21, 24);
    else enemyQueen(state);
    const actual = plan(state, carrier, group, agent, mark);
    expect(actual).toEqual(emptyDirection);
    expect(actual.x).toBeLessThan(0);
    expect(readLocalGoal(state, carrier)).toMatchObject({ kind: "home", targetId: 0, nativeReached: false });
    const motion = advanceSoftAnts(state, new Map([[carrier.id, actual]]), new Set([carrier.id]));
    expect(motion.decisionGoals.get(carrier.id)?.kind).toBe("home");
    expect(motion.directions.get(carrier.id)).toEqual(actual);
    expect(carrier.vx).toBeLessThan(0);
  });

  it.each(["forager", "guard", "fighter"] as const)("house %s carriers deliver", role => {
    const { state, carrier } = scene();
    carrier.role = role;
    addAnt(state, 1, 21, 24);
    beginLocalGoals(state);
    const result = houseDirection(state, buildGrid(state), [], carrier);
    expect(result).toEqual(forageDirection(state, carrier, []));
    expect(readLocalGoal(state, carrier)?.kind).toBe("home");
  });

  it("local and attack planners keep home goals, including non-adjacent queen defence", () => {
    for (const adjacent of [false, true]) {
      const { state, carrier } = scene();
      const home = activeQueens(state.colonies[0])[0]!;
      // Grid scale 2: one reference tile is two fine tiles, so combat reach and every distance double.
      carrier.x = home.queenX + 2 * SUB; carrier.y = home.queenY;
      addAnt(state, 1, Math.floor(carrier.x / SUB) + (adjacent ? 2 : 4), Math.floor(carrier.y / SUB));
      for (const route of [() => localDirection(state, buildGrid(state), carrier).dir,
        () => attackDirection(state, buildGrid(state), carrier, Math.floor(carrier.x / SUB), Math.floor(carrier.y / SUB), 6)]) {
        beginLocalGoals(state);
        const dir = route();
        expect(dir.x).toBeLessThan(0); expect(readLocalGoal(state, carrier)?.kind).toBe("home");
      }
    }
  });

  it.each(orders)("squad $kind prioritises delivery", order => {
    {
      const { state, carrier, agent } = scene("squad");
      agent.order = order;
      state.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 23, tileY: 24,
        words: ["GO", "E"], laidTick: 100, steering: 0 });
      addAnt(state, 1, 21, 24);
      beginLocalGoals(state);
      const dir = squadDirections(state, buildGrid(state), [], agent, state.tick).dirs.get(carrier.id)!;
      expect(dir.x).toBeLessThan(0);
      expect(readLocalGoal(state, carrier)?.kind).toBe("home");
    }
  });

  it.each(verbs)("count mark %s prioritises delivery without replacing home goals or advancing PATROL", verb => {
    for (const linked of verb === "PATROL" ? [false, true] : [false]) {
      const { state, carrier, mark } = scene("count mark");
      mark.verb = verb;
      if (linked) state.marks.push({ ...mark, id: mark.id + 1, tileX: 26 });
      addAnt(state, 1, 21, 24);
      beginLocalGoals(state);
      const { dir } = countMarkDirection(state, buildGrid(state), [], carrier, mark);
      expect(dir.x).toBeLessThan(0);
      expect(readLocalGoal(state, carrier)?.kind).toBe("home");
      expect(carrier.patrolWaypoint).toBeUndefined();
    }
  });

  for (const group of groups) it.each([false, true])(`${group} physically delivers through step with soft separation=%s`, soft => {
    const { state: initial, carrier, agent, mark } = scene(group, soft);
    agent.order = { kind: "hold" };
    mark.verb = "GATHER";
    addAnt(initial, 1, 21, 24, { carrying: true, hp: 100_000 });
    let state = initial;
    const first = step(state).state;
    expect(first.ants.find(ant => ant.id === carrier.id)!.x).toBeLessThan(carrier.x);
    state = first;
    for (let i = 0; i < 100 && state.stats.delivered[0] === 0; i++) state = step(state).state;
    expect(state.stats.delivered[0]).toBe(1);
    expect(state.colonies[0].foodStore).toBe(1);
    expect(state.ants.find(ant => ant.id === carrier.id)?.carrying).toBe(false);
    // step is pure: the original ant is still carrying at its original position.
    expect(carrier.carrying).toBe(true);
    expect(carrier.x).toBe(tileCentre(20));
  });

  it("does not stop a non-carrier from attacking, and resumes biting after delivery", () => {
    const { state, carrier } = scene();
    const enemy = addAnt(state, 1, 21, 24, { hp: 100_000 });
    resolveCombat(state, buildGrid(state), state.tick, []);
    expect(enemy.hp).toBe(100_000);
    carrier.carrying = false;
    beginLocalGoals(state);
    expect(localDirection(state, buildGrid(state), carrier).dir).toEqual(ZERO);
    expect(readLocalGoal(state, carrier)?.kind).toBe("combat");
    resolveCombat(state, buildGrid(state), state.tick + 1, []);
    expect(enemy.hp).toBe(100_000 - damagePerTick(state.config));
  });
});

function overrunScene(founded: boolean) {
  const base = rulesConfig("count-marks");
  return emptyMatch(100, { ...base,
    queenFounding: founded ? base.queenFounding : undefined, overrunGraceTicks: 0, overrunTicks: 2,
    terrain: undefined, foodLayout: undefined, foodPatches: [], startAnts: 0 });
}
function groupPatch(group: Group): Partial<Ant> {
  return group === "squad" ? { squad: "a" } : group === "count mark" ? { claim: 1 } : {};
}

for (const founded of [false, true]) {
  describe(`overrun, founded=${founded}`, () => {
    for (const group of groups) it.each([false, true])(`${group}, carrying=%s: only non-carriers can overrun an enemy queen`, carrying => {
      const state = overrunScene(founded);
      const target = activeQueens(state.colonies[0])[0]!;
      addAnt(state, 1, Math.floor(target.queenX / SUB), Math.floor(target.queenY / SUB),
        { ...groupPatch(group), carrying });
      const clock = founded ? state.colonies[0].queens![0]! : state.colonies[0];
      const events: SimEvent[] = [];
      expect(updateOverrun(state, buildGrid(state), 100, events)).toBeNull();
      expect(clock.overrunTicks).toBe(carrying ? 0 : 1);
      const result = updateOverrun(state, buildGrid(state), 101, events);
      if (carrying) {
        expect(result).toBeNull(); expect(clock.overrunTicks).toBe(0);
        expect(events).toEqual([]);
        if (founded) expect(state.colonies[0].queens![0]!.lostTick).toBeNull();
      } else {
        expect(result).toMatchObject({ winner: 1, reason: "overrun" });
        expect(clock.overrunTicks).toBe(2);
        if (founded) expect(state.colonies[0].queens![0]!.lostTick).toBe(101);
      }
    });

    for (const group of groups) it(`${group} carrier defenders keep full defensive weight in mixed majorities`, () => {
      const state = overrunScene(founded);
      const target = activeQueens(state.colonies[0])[0]!;
      const x = Math.floor(target.queenX / SUB), y = Math.floor(target.queenY / SUB);
      addAnt(state, 0, x, y, { ...groupPatch(group), carrying: true });
      addAnt(state, 1, x, y, { carrying: false });
      const enemyCarrier = addAnt(state, 1, x, y, { carrying: true });
      const clock = founded ? state.colonies[0].queens![0]! : state.colonies[0];
      expect(updateOverrun(state, buildGrid(state), 100, [])).toBeNull();
      // Rules25 has one attacker versus one carrier defender, not a 1:0 majority.
      expect(clock.overrunTicks).toBe(0);
      // Two non-carriers still overcome the carrier defender.
      clock.overrunTicks = 0;
      enemyCarrier.carrying = false;
      expect(updateOverrun(state, buildGrid(state), 101, [])).toBeNull();
      expect(clock.overrunTicks).toBe(1);
    });

    it("resets existing progress when all enemy attackers become carriers", () => {
      const state = overrunScene(founded);
      const target = activeQueens(state.colonies[0])[0]!;
      const ant = addAnt(state, 1, Math.floor(target.queenX / SUB), Math.floor(target.queenY / SUB));
      const clock = founded ? state.colonies[0].queens![0]! : state.colonies[0];
      expect(updateOverrun(state, buildGrid(state), 100, [])).toBeNull();
      ant.carrying = true;
      const events: SimEvent[] = [];
      const result = updateOverrun(state, buildGrid(state), 101, events);
      expect(clock.overrunTicks).toBe(0);
      expect(events.find(event => event.type === "overrun_progress")).toMatchObject({ progressTicks: 0 });
      expect(result?.winner ?? null).toBe(null);
    });
  });
}

describe("new-match queen rules", () => {
  it("default, v4 and count-marks use overrun; redesign and default house/server use HP", () => {
    // Raw legacy-sized defaults have no terrain; newMatchConfig requires the public recipe.
    for (const config of [DEFAULT_CONFIG, RULES_V4_CONFIG]) {
      expect(config.queenHp).toBeUndefined();
    }
    const overrun = [PUBLIC_CONFIG, rulesConfig(undefined), rulesConfig("v4"), rulesConfig("count-marks")];
    const hp = [rulesConfig("redesign"), comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!];
    for (const config of overrun) {
      expect(config.queenHp).toBeUndefined();
    }
    for (const config of hp) {
      expect(config.queenHp).toBeDefined();
    }
  });

  it("checks each founded queen's own enemy tally without removing carrier defence", () => {
    const state = overrunScene(true);
    const queens = state.colonies[0].queens!;
    queens.push({ ...queens[0]!, id: 1, queenX: tileCentre(30), queenY: tileCentre(24) });
    addAnt(state, 1, 30, 24, { carrying: true });
    addAnt(state, 0, 8, 24, { carrying: true });
    addAnt(state, 1, 8, 24);
    expect(updateOverrun(state, buildGrid(state), 100, [])).toBeNull();
    expect(queens.map(queen => queen.overrunTicks)).toEqual([0, 0]);
    expect(queens.every(queen => queen.lostTick === null)).toBe(true);
  });
});
