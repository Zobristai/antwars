import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { countMarkDirection } from "../../src/sim/agents.js";
import { forageDirection, pickupAndDeliver } from "../../src/sim/forage.js";
import { type Vec } from "../../src/sim/geometry.js";
import { beginLocalGoals } from "../../src/sim/localArrival.js";
import { buildGrid, createMatch, newAnt } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { advanceSoftAnts } from "../../src/sim/step.js";
import type { Agent, Ant, ColonyId, Mark, SimState } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

// Baseline: the cluster retarget and FORAGE job (step.ts advanceSoftAnts retarget predicate, forage.ts
// retargetClusterForager). Rules 27 removes the retarget for agent-seated colonies only.
const scene27: SimConfig = { ...playable(rulesConfig("redesign")), pointArrival: undefined, startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] };

function scene(config: SimConfig, seated: readonly ColonyId[]): SimState {
  const state = createMatch(10, config);
  state.ants = []; state.food.fill(0);
  for (const colony of seated) state.agents.push({ id: `seat-${colony}`, colony, joinSeq: colony, modelLabel: null,
    parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false,
    pendingEvents: [] } satisfies Agent);
  return state;
}
function worker(state: SimState, colony: ColonyId, x: number, y: number, target: number): Ant {
  const ant = newAnt(state.config, state.nextAntId++, colony, x, y, "worker");
  ant.foodTarget = target; state.ants.push(ant); return ant;
}
const tile = (state: SimState, x: number, y: number) => y * state.config.mapWidth + x;
function forageMark(id: number, colony: ColonyId, tileX: number, tileY: number): Mark {
  return { id, agentId: `seat-${colony}`, colony, tileX, tileY, words: [], laidTick: 0, steering: 0, verb: "FORAGE", count: 2 };
}
/** One soft frame: claimed ants follow their mark, free ants forage from `known`. */
function frame(state: SimState, known: readonly number[]) {
  beginLocalGoals(state);
  const grid = buildGrid(state), dirs = new Map<number, Vec>(), foraging = new Set<number>();
  for (const ant of state.ants) {
    const mark = state.marks.find(m => m.id === ant.claim);
    const choice = mark === undefined ? { dir: forageDirection(state, ant, known, true), foraging: true }
      : countMarkDirection(state, grid, known, ant, mark);
    dirs.set(ant.id, choice.dir);
    if (choice.foraging) foraging.add(ant.id);
  }
  return { frame: advanceSoftAnts(state, dirs, foraging), foraging };
}

describe("rules 27: no crowding retarget for agent-seated workers", () => {
  // a stands on the target's tile (natively reached); b, 20 subunits away in the next
  // (empty) tile, is cluster-arrived only: exactly the case the captured retarget fires on.
  // The alternative lies off b's tile, so b could only take it through the retarget.
  function crowd(config: SimConfig, seated: readonly ColonyId[], colony: ColonyId, claimed = false) {
    const state = scene(config, seated);
    const target = tile(state, 20, 20), other = tile(state, 17, 20);
    state.food[target] = 5; state.food[other] = 3;
    const a = worker(state, colony, 20010, 20500, target), b = worker(state, colony, 19990, 20500, target);
    if (claimed) { state.marks = [forageMark(1, colony, 20, 20)]; a.claim = 1; b.claim = 1; }
    return { state, target, other, a, b };
  }

  it("a free worker of a seated colony keeps the crowded food it chose", () => {
    const s = crowd(scene27, [0], 0);
    expect(localRulesSide(s.state, 0)).toBe(true);
    const { frame: f } = frame(s.state, [s.target, s.other]);
    expect(f.decisionArrival.get(s.b.id)).toMatchObject({ arrived: true, native: false });
    expect(f.retargeted).not.toContain(s.b.id);
    expect(s.b.foodTarget).toBe(s.target);
    expect(f.goals.get(s.b.id)).toMatchObject({ kind: "food", targetId: s.target });
  });

  it("a worker claimed by a FORAGE count mark keeps the crowded food it chose", () => {
    const s = crowd(scene27, [0], 0, true);
    const { frame: f } = frame(s.state, [s.target, s.other]);
    expect(f.decisionArrival.get(s.b.id)).toMatchObject({ arrived: true, native: false });
    expect(f.retargeted).not.toContain(s.b.id);
    expect(s.b.claim).toBe(1);
    expect(s.b.foodTarget).toBe(s.target);
    expect(f.goals.get(s.b.id)).toMatchObject({ kind: "food", targetId: s.target });
  });

  it("the waiting worker later takes its food from the cell it chose, not the alternative", () => {
    for (const claimed of [false, true]) {
      const s = crowd(scene27, [0], 0, claimed);
      for (let tick = 0; tick < 40 && !s.b.carrying; tick++) {
        s.state.tick = tick;
        const { frame: f, foraging } = frame(s.state, [s.target, s.other]);
        expect(f.retargeted).toEqual([]);
        if (!s.b.carrying) expect(s.b.foodTarget).toBe(s.target);
        pickupAndDeliver(s.state, foraging);
      }
      expect(s.b.carrying).toBe(true);
      expect(s.state.food[s.target]).toBe(3);
      expect(s.state.food[s.other]).toBe(3);
    }
  });

  it("an unseated (house-bot) colony in the same rules-27 match keeps the retarget", () => {
    const state = scene(scene27, [0]);
    const target = tile(state, 40, 30), other = tile(state, 37, 30), seatedTarget = tile(state, 20, 20);
    state.food[target] = 5; state.food[other] = 3; state.food[seatedTarget] = 5;
    worker(state, 1, 40010, 30500, target);
    const house = worker(state, 1, 39990, 30500, target);
    worker(state, 0, 20010, 20500, seatedTarget);
    const seated = worker(state, 0, 19990, 20500, seatedTarget);
    expect(localRulesSide(state, 1)).toBe(false);
    const { frame: f } = frame(state, [target, other, seatedTarget]);
    expect(f.retargeted).toEqual([house.id]);
    expect(house.foodTarget).toBe(other);
    expect(seated.foodTarget).toBe(seatedTarget);
  });

});
