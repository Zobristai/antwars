import { describe, expect, it } from "vitest";
import { houseMatch, timing } from "./colonyScale.js";
import { selectHatchArm } from "./hatchVariants.js";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimEvent } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

const shortMatch: SimConfig = playable({ ...PUBLIC_CONFIG, foodLayout: undefined, startAnts: 6, colonyCap: 8,
  matchTicks: 600, hatchIntervalTicks: 3,
  queenFounding: { ...PUBLIC_CONFIG.queenFounding!, cost: 2, costMultiplier: 3,
    firstFoundTick: 0, cooldownTicks: 0, minDistanceTiles: 1, houseReserveFood: 0, maxLiveQueens: 4 } });

/** The report must observe the real simulation, not replace it or infer prices from the final queen count. */
function directMatch(config: SimConfig) {
  let state = createMatch(6006, config);
  const events: SimEvent[] = [];
  while (state.result === null) {
    const out = step(state);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

function proveIncome(config: SimConfig) {
  const direct = directMatch(config);
  const report = houseMatch(6006, config);
  expect(stateHash(report.final)).toBe(stateHash(direct.state));
  const foundations = direct.events.flatMap(event => event.type === "queen_founded"
    ? [{ colony: event.colony, foodCost: event.foodCost }] : []);
  for (const row of report.income) {
    const costs = foundations.filter(event => event.colony === row.colony)
      .map(event => event.foodCost ?? config.queenFounding!.cost);
    const expectedFounding = costs.reduce((total, cost) => total + cost, 0);
    expect(row.queenFoundingSpending).toBe(expectedFounding);
    expect(row.total - row.hatchSpending - row.queenFoundingSpending - row.finalStore).toBe(0);
    expect(row.reconciled).toBe(true);
  }
  return { report, foundations };
}

describe("colony-scale income reconciliation", () => {
  it("preserves main's exact timing result shape; p99 is measured separately", () => {
    expect(timing(Array.from({ length: 200 }, (_, i) => 200 - i))).toEqual({ samples: 200, meanMs: 100.5,
      medianMs: 100.5, p95Ms: 190, maxMs: 200 });
    expect(timing([2])).toEqual({ samples: 1, meanMs: 2, medianMs: 2, p95Ms: 2, maxMs: 2 });
  });

  it.each(["main", "A"] as const)("observes the unchanged real houseMatch path and reconciles %s spending", arm => {
    proveIncome(selectHatchArm(shortMatch, arm));
  });

  it("counts each colony's recorded escalating founding costs, separately from hatch spending", () => {
    const { report, foundations } = proveIncome(shortMatch);
    for (const colony of [0, 1] as const) {
      const costs = foundations.filter(event => event.colony === colony).map(event => event.foodCost);
      expect(costs).toEqual([2, 6, 18]);
      const row = report.income[colony]!;
      expect(row.queenFoundingSpending).toBe(26);
      expect(row.hatchSpending).toBeGreaterThan(0);
      // This is the exact false deficit from the old hatch-only reconciliation.
      expect(row.total - row.hatchSpending - row.finalStore).toBe(26);
    }
  });

  it("uses the configured fixed cost, not a constant, when historical events omit foodCost", () => {
    const config = { ...shortMatch, queenFounding: { ...shortMatch.queenFounding!, cost: 7, costMultiplier: undefined } };
    const { report, foundations } = proveIncome(config);
    expect(foundations).toHaveLength(6);
    expect(foundations.every(event => event.foodCost === undefined)).toBe(true);
    expect(report.income.map(row => row.queenFoundingSpending)).toEqual([21, 21]);
  });

  it("preserves zero founding spend and reconciliation when founding is disabled", () => {
    const { report, foundations } = proveIncome({ ...shortMatch, queenFounding: undefined });
    expect(foundations).toEqual([]);
    expect(report.income.map(row => row.queenFoundingSpending)).toEqual([0, 0]);
  });
});
