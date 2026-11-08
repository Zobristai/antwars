import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { buildGrid, cloneState } from "../../src/sim/map.js";
import { claimCountMarks, expireMarks } from "../../src/sim/marks.js";
import type { Agent, Ant, ColonyId, Mark, SimEvent, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";
import { addAnt, emptyMatch } from "./fixtures.js";

const RULES: SimConfig = { ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined,
  combatGraceTicks: 0, defenderBonusPermille: 1000, commandFloorTicks: 1, squadSize: 1 };
function scene(config: SimConfig = RULES) { return emptyMatch(2000, config); }
function mark(state: SimState, colony: ColonyId, patch: Partial<Mark> = {}): Mark {
  const result: Mark = { id: state.nextMarkId++, colony, agentId: `seat-${colony}`, tileX: 30, tileY: 20,
    laidTick: state.tick, steering: 0, words: [], verb: "GATHER", count: 2,
    antsLost: 0, enemiesKilled: 0, ...patch };
  state.marks.push(result);
  return result;
}
function fighter(state: SimState, colony: ColonyId, claim?: Mark, patch: Partial<Ant> = {}) {
  return addAnt(state, colony, 30 + colony, 20, { caste: "worker", ...(claim ? { claim: claim.id } : {}), ...patch });
}
function fight(state: SimState) {
  const events: SimEvent[] = [];
  resolveCombat(state, buildGrid(state), state.tick, events);
  return events;
}
function seat(state: SimState, id = "seat-0", colony: ColonyId = 0, tx = 30): Agent {
  const ant = addAnt(state, colony, tx, 20, { squad: id });
  const agent: Agent = { id, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null,
    squad: [ant.id], order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: null,
    idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return agent;
}
function lay(state: SimState, agent: Agent, count: number, caste?: "worker" | "soldier") {
  const result = applyInput(state, { type: "count_mark", agentId: agent.id, verb: "GATHER", count,
    ...(caste ? { caste } : {}) }, state.tick, defaultAllocator, []);
  expect(result.error).toBeNull();
  return state.marks.at(-1)!;
}

describe("count-mark combat totals", () => {
  it("counts both kills and losses when claimed ants kill each other simultaneously", () => {
    const state = scene();
    const own = mark(state, 0), enemy = mark(state, 1);
    fighter(state, 0, own, { hp: 100 }); fighter(state, 1, enemy, { hp: 100 });
    expect(fight(state).filter(e => e.type === "death")).toHaveLength(2);
    expect(state.ants).toHaveLength(0);
    for (const result of [own, enemy]) expect(result).toMatchObject({ antsLost: 1, enemiesKilled: 1 });
    // No additional credit on the next resolution.
    fight(state);
    for (const result of [own, enemy]) expect(result).toMatchObject({ antsLost: 1, enemiesKilled: 1 });
  });

  it.each([false, true])("credits one strongest attacker, independent of iteration order (reverse=%s)", reverse => {
    const state = scene();
    const weaker = mark(state, 0), stronger = mark(state, 0);
    fighter(state, 0, weaker); fighter(state, 0, stronger, { caste: "soldier" });
    fighter(state, 1, undefined, { hp: 200 });
    if (reverse) state.ants.reverse();
    fight(state);
    expect(weaker.enemiesKilled).toBe(0); expect(stronger.enemiesKilled).toBe(1);
  });

  it.each([false, true])("breaks equal ant damage by lowest id, once per victim (reverse=%s)", reverse => {
    const state = scene();
    const first = mark(state, 0), second = mark(state, 0);
    fighter(state, 0, first); fighter(state, 0, second);
    fighter(state, 1, undefined, { hp: 150 });
    if (reverse) state.ants.reverse();
    fight(state);
    expect(first.enemiesKilled).toBe(1); expect(second.enemiesKilled).toBe(0);
  });

  it("does not give a mark multiple kills for multiple members hitting the same victim", () => {
    const state = scene(), own = mark(state, 0);
    fighter(state, 0, own); fighter(state, 0, own); fighter(state, 1, undefined, { hp: 150 });
    fight(state);
    expect(own.enemiesKilled).toBe(1);
  });

  it("uses damage after the defender bonus rather than caste or attacker order", () => {
    const state = scene({ ...RULES, defenderBonusPermille: 2000 });
    const worker = mark(state, 0), soldier = mark(state, 0);
    const a = fighter(state, 0, worker, { x: 29 * SUB + 500 });
    fighter(state, 0, soldier, { caste: "soldier" });
    addAnt(state, 1, 30, 20, { hp: 300 });
    state.owner[20 * state.config.mapWidth + Math.floor(a.x / SUB)] = 0;
    fight(state);
    expect(worker.enemiesKilled).toBe(1); expect(soldier.enemiesKilled).toBe(0);
  });

  it("does not credit previous-tick damage or nonlethal hits", () => {
    const state = scene(), earlier = mark(state, 0), final = mark(state, 0);
    const a = fighter(state, 0, earlier);
    fighter(state, 1, undefined, { hp: 200 });
    fight(state);
    expect(earlier.enemiesKilled).toBe(0);
    a.x = 10 * SUB; state.tick++;
    fighter(state, 0, final);
    fight(state);
    expect(earlier.enemiesKilled).toBe(0); expect(final.enemiesKilled).toBe(1);
  });

  it("gives no mark kill when the dominant attacker is unclaimed", () => {
    const state = scene(), own = mark(state, 0);
    fighter(state, 0, own); fighter(state, 0, undefined, { caste: "soldier" });
    fighter(state, 1, undefined, { hp: 200 });
    fight(state);
    expect(own.enemiesKilled).toBe(0);
  });

  it.each(["expired", "future", "word", "other-colony", "released", "squad"] as const)("ignores %s claims", kind => {
    const state = scene(), own = mark(state, 0);
    const a = fighter(state, 0, own, { hp: 100 });
    fighter(state, 1, undefined, { hp: 100 });
    if (kind === "expired") state.tick += state.config.markLifetimeTicks;
    if (kind === "future") state.tick--;
    if (kind === "word") { delete own.count; delete own.verb; }
    if (kind === "other-colony") state.marks[0] = { ...own, colony: 1 };
    if (kind === "released") delete a.claim;
    if (kind === "squad") a.squad = "squad";
    fight(state);
    expect(own).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
    expect(state.marks[0]).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
  });

  it("credits only the current mark after reassignment", () => {
    const state = scene(), old = mark(state, 0), current = mark(state, 0);
    const a = fighter(state, 0, old, { hp: 100 });
    a.claim = current.id;
    fighter(state, 1, undefined, { hp: 100 });
    fight(state);
    expect(old).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
    expect(current).toMatchObject({ antsLost: 1, enemiesKilled: 1 });
  });

  it.each([100, 150, 200])("includes queen bites in kill credit (queen damage %s)", biteDamage => {
    const state = scene({ ...RULES, queenHp: { ...RULES.queenHp!, biteDamage } });
    const own = mark(state, 0), enemy = mark(state, 1);
    const queen = state.colonies[0].queens![0]!;
    const x = Math.floor(queen.queenX / SUB), y = Math.floor(queen.queenY / SUB);
    addAnt(state, 0, x, y, { caste: "soldier", claim: own.id });
    addAnt(state, 1, x + 1, y, { hp: 200, claim: enemy.id });
    fight(state);
    expect(enemy.antsLost).toBe(1);
    expect(own.enemiesKilled).toBe(biteDamage < 150 ? 1 : 0);
  });

  it("counts a claimed ant lost to a queen alone, without crediting any mark with that kill", () => {
    const state = scene(), own = mark(state, 0), enemy = mark(state, 1);
    const queen = state.colonies[0].queens![0]!;
    addAnt(state, 1, Math.floor(queen.queenX / SUB) + 1, Math.floor(queen.queenY / SUB), { hp: 100, claim: enemy.id });
    fight(state);
    expect(enemy.antsLost).toBe(1); expect(own.enemiesKilled).toBe(0);
  });

  it("records no combat totals during grace", () => {
    const state = scene({ ...RULES, combatGraceTicks: 2001 }), own = mark(state, 0);
    fighter(state, 0, own, { hp: 100 }); fighter(state, 1, undefined, { hp: 100 });
    expect(fight(state)).toEqual([]);
    expect(own).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
  });
});

describe("count-mark lifetime and observe", () => {
  it("initializes at laying and retains totals across count/caste adjustments while releasing excluded ants", () => {
    const state = scene(), agent = seat(state);
    const worker = addAnt(state, 0, 30, 21, { caste: "worker" });
    const soldier = addAnt(state, 0, 31, 20, { caste: "soldier" });
    const own = lay(state, agent, 2);
    expect(own).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
    claimCountMarks(state, state.tick);
    expect([worker.claim, soldier.claim]).toEqual([own.id, own.id]);
    own.antsLost = 2; own.enemiesKilled = 3;
    state.tick++;
    lay(state, agent, 2, "worker");
    claimCountMarks(state, state.tick);
    expect(state.marks).toHaveLength(1);
    expect(state.marks[0]).toMatchObject({ id: own.id, laidTick: 2000, revision: 1, antsLost: 2, enemiesKilled: 3 });
    expect(worker.claim).toBe(own.id); expect(soldier.claim).toBeUndefined();
    state.tick++;
    lay(state, agent, 1);
    expect(state.marks[0]).toMatchObject({ antsLost: 2, enemiesKilled: 3, count: 1, revision: 2 });
  });

  it("ends old totals at replacement and expiry", () => {
    const state = scene({ ...RULES, marksPerAgent: 1 }), agent = seat(state);
    const old = lay(state, agent, 1);
    old.antsLost = 2; old.enemiesKilled = 3;
    state.tick++;
    expect(applyInput(state, { type: "count_mark", agentId: agent.id, verb: "DEFEND", count: 1 }, state.tick, defaultAllocator, []).error).toBeNull();
    expect(state.marks).toHaveLength(1);
    expect(state.marks[0]!.id).not.toBe(old.id);
    expect(state.marks[0]).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
    const expired = state.marks[0]!;
    fighter(state, 0, expired, { hp: 100 }); fighter(state, 1, undefined, { hp: 100 });
    state.tick = expired.laidTick + state.config.markLifetimeTicks;
    expireMarks(state, state.tick);
    fight(state);
    expect(state.marks).toEqual([]);
    expect(expired).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
  });

  it("keeps previous-state counters isolated when a cloned state fights", () => {
    const state = scene(), own = mark(state, 0);
    fighter(state, 0, own, { hp: 100 }); fighter(state, 1, undefined, { hp: 100 });
    const after = cloneState(state);
    fight(after);
    expect(state.marks[0]).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
    expect(after.marks[0]).toMatchObject({ antsLost: 1, enemiesKilled: 1 });
  });

  it("returns cumulative zero-inclusive totals and existing own food without widening mark visibility", () => {
    const state = scene(), agent = seat(state);
    const own = mark(state, 0, { antsLost: 2, enemiesKilled: 3 });
    const teammate = mark(state, 0, { agentId: "teammate" });
    const far = mark(state, 0, { tileX: 60 });
    mark(state, 1);
    const word = mark(state, 0); delete word.verb; delete word.count; delete word.antsLost; delete word.enemiesKilled;
    state.colonies[0].foodStore = 123; state.colonies[1].foodStore = 999;
    for (let call = 0; call < 2; call++) {
      const view = takeView(state, buildGrid(state), agent);
      expect(view.queenFounding!.foodStore).toBe(123);
      expect(view).not.toHaveProperty("foodStore");
      expect(view.marks.map(m => m.markId)).toEqual([own.id, teammate.id, word.id]);
      expect(view.marks.find(m => m.markId === own.id)).toMatchObject({ lost: 2, kills: 3 });
      expect(view.marks.find(m => m.markId === teammate.id)).toMatchObject({ lost: 0, kills: 0 });
      expect(view.myMarks.find(m => m.markId === far.id)).toMatchObject({ lost: 0, kills: 0 });
      expect(view.myMarks.find(m => m.markId === own.id)).toMatchObject({ lost: 2, kills: 3 });
      expect(view.marks.find(m => m.markId === word.id)).not.toHaveProperty("lost");
      expect(view.myMarks.find(m => m.markId === word.id)).not.toHaveProperty("kills");
    }
  });
});
