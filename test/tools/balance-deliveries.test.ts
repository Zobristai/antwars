import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { playBalanceMatch, type BalanceRecord, type BalanceSpec } from "./balance.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, SimInput } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

// Only APIs present on baseline b0bb28f: this measurement commit stands alone.
// The 25-tick fixture ends before the next 100-tick scripted observe cadence.
const config: SimConfig = playable({
  ...rulesConfig("v4"),
  terrain: undefined,
  foodLayout: undefined,
  matchTicks: 25,
  squadSize: 1,
  startAnts: 12,
  colonyCap: 12,
  hatchCost: 1_000_000,
  hatchIntervalTicks: 1_000_000,
  guardCount: 0,
  guardSharePermille: 0,
  foodJitter: 0,
  foodPatches: [{ tileX: 8, tileY: 24, radius: 5, perTile: 100 }],
  foodRegrowTicks: 1_000_000,
  groundFoodIntervalTicks: 1,
});

/** Independent short reference: explicit commands, not balance loop/measurement code. */
function terminalReference(spec: BalanceSpec) {
  let state = createMatch(spec.seed, { ...spec.config, earlyWin: undefined });
  if (spec.handicap !== undefined) {
    let n = 0;
    state.ants = state.ants.filter(ant => ant.colony !== spec.handicap || n++ % 2 === 0);
  }
  const agents = ([0, 1] as const).flatMap(colony => [0, 1].map(slot => ({ id: `side-${colony}-seat-${slot}`, colony })));
  while (state.result === null) {
    const tick = state.tick;
    const inputs: SimInput[] = tick === 0
      ? agents.map(agent => ({ type: "join", agentId: agent.id, placement: agent.colony }))
      : tick === 1
        ? agents.map(agent => ({ type: "observe", agentId: agent.id }))
        : tick === 2
          ? agents.map(agent => ({ type: "order", agentId: agent.id, order: { kind: "forage" }, brood: "workers" }))
          : [];
    state = step(state, inputs).state;
  }
  return state;
}

const specFor = (rules = config, handicap?: ColonyId): BalanceSpec => ({
  seed: 7001, strategies: ["workers", "workers"], config: rules,
  ...(handicap === undefined ? {} : { handicap }),
});

describe("balance deliveries measurement", () => {
  it.each([undefined, 0, 1] as const)("copies actual terminal receipts in colony order (handicap %s)", handicap => {
    const spec = specFor(config, handicap), final = terminalReference(spec), record = playBalanceMatch(spec);
    expect(final.stats.delivered.every(value => value > 0)).toBe(true);
    if (handicap !== undefined) expect(final.stats.delivered[handicap]).toBeLessThan(final.stats.delivered[1 - handicap]!);
    expect(record.deliveries).toEqual(final.stats.delivered);
    expect(record.naturalResult).toEqual(final.result);
    expect(record.naturalEndTick).toBe(final.tick);
    expect(record.deliveries).not.toEqual(final.colonies.map(colony => colony.foodStore));
  });

  it("records measured zeros rather than food stores or territory income", () => {
    const spec = specFor({ ...config, foodPatches: [] }), final = terminalReference(spec), record = playBalanceMatch(spec);
    expect(final.colonies.some(colony => colony.foodStore > 0)).toBe(true);
    expect(final.stats.delivered).toEqual([0, 0]);
    expect(record.deliveries).toEqual([0, 0]);
    expect(record.naturalResult).toEqual(final.result);
  });

  it("reads the actual natural early end, not an invented full-horizon value", () => {
    const early = { ...config, overrunGraceTicks: 0, overrunRadiusTiles: 1000, overrunTicks: 1 };
    const spec = specFor(early, 0), final = terminalReference(spec), record = playBalanceMatch(spec);
    expect(final.tick).toBeLessThan(early.matchTicks);
    expect(record.naturalEndTick).toBe(final.tick);
    expect(record.naturalResult).toEqual(final.result);
    expect(record.deliveries).toEqual(final.stats.delivered);
  });

  it("does not require a delivery field on historical records or invent their missing measurement", () => {
    const record = playBalanceMatch(specFor());
    const { deliveries: _unrecorded, ...historical }: BalanceRecord = record;
    const acceptedHistorical: BalanceRecord = historical;
    expect(acceptedHistorical.deliveries).toBeUndefined();
    expect(JSON.parse(JSON.stringify(acceptedHistorical))).not.toHaveProperty("deliveries");
  });

  it("retains per-colony deliveries through the actual sweep CLI worker JSON", () => {
    const spec = specFor(config, 0), direct = playBalanceMatch(spec);
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--single"], {
      input: JSON.stringify(spec), encoding: "utf8", timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const worker = JSON.parse(result.stdout) as BalanceRecord;
    expect(worker.deliveries).toEqual(terminalReference(spec).stats.delivered);
    const { computeSeconds: _directTime, ...directStable } = direct;
    const { computeSeconds: _workerTime, ...workerStable } = worker;
    expect(workerStable).toEqual(directStable);
    // These are the same whole-record forms written to per-match JSON and JSONL.
    expect(JSON.parse(JSON.stringify({ index: 0, ...worker })).deliveries).toEqual(direct.deliveries);
  });
});
