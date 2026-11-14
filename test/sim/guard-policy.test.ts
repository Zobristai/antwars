import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { houseDirection, queenGuardTargets, rebalanceRoles } from "../../src/sim/houseBot.js";
import { beginLocalGoals, currentLocalGoals } from "../../src/sim/localArrival.js";
import { buildGrid } from "../../src/sim/map.js";
import { addAnt, emptyMatch } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Literal expectations from houseBot.ts at
// 59ed9a6d309b48d31b7c9d09e283d6b1a5fcbab5: queenGuardTargets,
// rebalanceQueenGuards and guardDirection. No second implementation call is
// used as an oracle. Native fine-grid units are intentional.
const rules = newMatchConfig(recordedHousePlan(rulesConfig("redesign")));
function scenario(config: SimConfig = rules) {
  const state = emptyMatch(100, { ...config, startAnts: 0, terrain: undefined,
    foodLayout: undefined, foodPatches: [] });
  state.colonies[0].queens![0] = { ...state.colonies[0].queens![0]!, queenX: 20_000, queenY: 20_000 };
  return state;
}

// Column order follows the public diagnostic shape, not a recomputed formula.
const targets = [
  { population: 10, eligible: 10, queens: 2, expected: [4, 8, 6, 6, true, false] },
  { population: 5, eligible: 1, queens: 2, expected: [2, 4, 3, 1, true, true] },
  { population: 1, eligible: 1, queens: 1, expected: [2, 2, 0, 0, true, true] },
  { population: 10, eligible: 10, queens: 0, expected: [4, 0, 6, 0, false, false] },
  { population: 19, eligible: 19, queens: 1, expected: [7, 7, 11, 7, false, false] },
  { population: 19, eligible: 3, queens: 4, expected: [7, 28, 11, 3, true, true] },
];
function values(result: ReturnType<typeof queenGuardTargets>) {
  return [result.perQueenTarget, result.requested, result.cap, result.assignedTarget,
    result.clampedByCap, result.clampedByAvailability];
}

describe("guard policy pinned to the movement baseline", () => {
  it.each(targets)("pins all target fields for $population ants, $eligible eligible, $queens queens", ({ population, eligible, queens, expected }) => {
    expect(values(queenGuardTargets(population, eligible, queens, rules))).toEqual(expected);
  });

  it("retains the historical single-budget and uncapped branches", () => {
    const { guardsPerQueen: _perQueen, totalGuardSharePermille: _cap, ...historical } = rules.queenFounding!;
    const config = { ...rules, queenFounding: historical };
    expect(values(queenGuardTargets(10, 10, 3, config))).toEqual([null, 4, null, 4, false, false]);
    expect(values(queenGuardTargets(10, 2, 3, config))).toEqual([null, 4, null, 2, false, true]);
    expect(values(queenGuardTargets(10, 10, 3, { ...config,
      queenFounding: { ...historical, guardsPerQueen: true } })))
      .toEqual([4, 12, null, 10, false, true]);
  });

  it.each([false, true])("pins the odd capped allocation and nearest-ant choices (reversed input: %s)", reversed => {
    const state = scenario();
    state.colonies[0].queens!.push({ ...state.colonies[0].queens![0]!, id: 1, queenX: 40_000 });
    for (let id = 1; id <= 12; id++) addAnt(state, 0, id <= 6 ? 19 : 39, 19, { id });
    if (reversed) state.ants.reverse();
    rebalanceRoles(state);
    const assignments = () => state.ants.filter(a => a.role === "guard")
      .sort((a, b) => a.id - b.id).map(a => [a.id, a.guardQueenId]);
    expect(assignments()).toEqual([[1, 0], [2, 0], [3, 0], [4, 0], [7, 1], [8, 1], [9, 1]]);
    rebalanceRoles(state);
    expect(assignments()).toEqual([[1, 0], [2, 0], [3, 0], [4, 0], [7, 1], [8, 1], [9, 1]]);
    state.colonies[0].queens![1]!.lostTick = state.tick;
    rebalanceRoles(state);
    expect(assignments()).toEqual([[1, 0], [2, 0], [3, 0], [4, 0]]);
  });

  it("counts owned ants in the cap but never assigns them as guards", () => {
    const state = scenario();
    state.colonies[0].queens!.push({ ...state.colonies[0].queens![0]!, id: 1, queenX: 40_000 });
    for (let id = 1; id <= 10; id++) addAnt(state, 0, id % 2 ? 19 : 39, 19,
      { id, ...(id <= 3 ? { squad: "owned" } : id <= 6 ? { claim: 77 } : {}) });
    rebalanceRoles(state);
    expect(state.ants.filter(a => a.role === "guard").map(a => [a.id, a.guardQueenId]))
      .toEqual([[7, 0], [8, 1], [9, 0], [10, 1]]);
    expect(state.ants.slice(0, 6).every(a => a.role === "forager" && a.guardQueenId === undefined)).toBe(true);
  });

  it.each([0, 1] as const)("pins all nine fine-grid posts for colony %i without fixing arrival implementation", colony => {
    const state = scenario();
    state.colonies[colony].queens![0] = { ...state.colonies[colony].queens![0]!, queenX: 40_000, queenY: 40_000 };
    // Colony-relative keys 9..17 cover all nine posts. Rules 24 mirror x
    // around the chosen queen; the literal offsets remain independent of production.
    const expected = [[38000, 38000], [40000, 38000], [42000, 38000],
      [38000, 40000], [40000, 40000], [42000, 40000],
      [38000, 42000], [40000, 42000], [42000, 42000]];
    for (let i = 0; i < 9; i++) addAnt(state, colony, 39, 39,
      { id: 9 + i + colony, role: "guard", guardQueenId: 0 });
    beginLocalGoals(state);
    const grid = buildGrid(state);
    for (const ant of state.ants) houseDirection(state, grid, [], ant);
    expect(state.ants.map(ant => {
      const goal = currentLocalGoals(state).get(ant.id);
      return [goal?.x, goal?.y];
    })).toEqual(colony === 0 ? expected : expected.map(([x, y]) => [80_000 - x!, y]));
  });
});
