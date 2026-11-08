import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BALANCE_STRATEGIES, balanceActivityTable, balanceActivityTracker, balanceKeepAlive, balanceSummary, playBalanceMatch } from "./balance.js";
import { rulesConfig } from "../../src/sim/config.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { takeView } from "../../src/sim/view.js";
import type { SimConfig } from "../../src/sim/config.js";
import type { SimInput } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

const rules = rulesConfig("redesign");
// A long, stationary fixture crosses the five-minute strategy transition and
// eleven real idle windows without paying for thousands of hatches or combat.
const stationary: SimConfig = playable({ ...rules, ticksPerSecond: 1, commandIdleTicks: 60, commandFloorTicks: 1,
  matchTicks: 660, colonyCap: 30, antSpeedTilesPerSecond: 0 });

function joined(config = stationary) {
  return step(createMatch(7001, config), [{ type: "join", agentId: "a", placement: 0 },
    { type: "join", agentId: "b", placement: 1 }]).state;
}

describe("scripted seat activity", () => {
  it.each(BALANCE_STRATEGIES)("keeps every %s seat active for multiple idle windows", (strategy) => {
    const record = playBalanceMatch({ seed: 7001, strategies: [strategy, strategy], config: stationary });
    expect(record.naturalEndTick).toBe(stationary.matchTicks);
    expect(record.seatActivity!.floorEnabled).toBe(true);
    expect(record.seatActivity!.floorFirings).toEqual([]);
    expect(record.seatActivity!.seats).toHaveLength(4);
    for (const seat of record.seatActivity!.seats) {
      expect(seat.idleTicks).toBe(0);
      expect(seat.maxAcceptedCommandGapTicks).toBeLessThan(stationary.commandIdleTicks!);
    }
    expect(record.seatActivity!.keepAlives.refused).toBe(0);
    if (strategy !== "soldier-heavy") expect(record.seatActivity!.keepAlives.accepted).toBeGreaterThan(0);
    const summary = balanceSummary([record], stationary);
    expect(summary.seatActivity.byStrategy.find((row) => row.strategy === strategy)).toMatchObject({
      measuredMatches: 1, floorEnabledMatches: 1, matchesWithFloorFirings: 0, floorFirings: 0,
    });
  }, 20_000);

  it("uses the configured deadline and repeats the unchanged current order", () => {
    let state = joined();
    state = step(state, [{ type: "order", agentId: "a", order: { kind: "attack", tileX: 55, tileY: 24 }, brood: "soldiers" }]).state;
    const view = takeView(state, buildGrid(state), state.agents[0]!);
    // Rules 27: brood belongs to each queen, so the keep-alive repeats the order alone.
    const current = { type: "order", agentId: "a", order: view.order };
    expect(balanceKeepAlive({ ...view, tick: 50 }, stationary, 1, 10)).toBeNull();
    expect(balanceKeepAlive({ ...view, tick: 51 }, stationary, 1, 10)).toEqual(current);
    expect(balanceKeepAlive({ ...view, tick: 51 }, { ...stationary, commandIdleTicks: 120 }, 1, 10)).toBeNull();
    expect(balanceKeepAlive({ ...view, tick: 111 }, { ...stationary, commandIdleTicks: 120 }, 1, 10)).toEqual(current);
    expect(balanceKeepAlive(view, { ...stationary, commandIdleTicks: undefined }, 1, 10)).toBeNull();
    expect(balanceKeepAlive({ ...view, tick: 51, nextCommandTick: 52 }, stationary, 1, 10)).toBeNull();
  });



  it("records an actual floor expiry even when an accepted command wakes the seat in that same step", () => {
    const config = { ...stationary, commandIdleTicks: 12, commandFloorTicks: 2 };
    const tracker = balanceActivityTracker(["workers", "mixed"], config);
    let state = joined(config);
    for (; state.tick <= 14;) {
      const tick = state.tick;
      const inputs: SimInput[] = tick === 2 ? [{ type: "order", agentId: "a", order: { kind: "forage" }, brood: "workers" }]
        : tick === 14 ? [{ type: "order", agentId: "a", order: { kind: "forage" }, brood: "workers" }] : [];
      tracker.beforeStep(state);
      state = step(state, inputs).state;
      tracker.afterStep(state);
    }
    expect(state.agents[0]!.idle).toBe(false);
    expect(state.agents[1]!.idle).toBe(true);
    const activity = tracker.report();
    expect(activity.floorFirings).toEqual([
      { agentId: "b", colony: 1, strategy: "mixed", tick: 12, lastAcceptedTick: null },
      { agentId: "a", colony: 0, strategy: "workers", tick: 14, lastAcceptedTick: 2 },
    ]);
    const short = playBalanceMatch({ seed: 7001, strategies: ["workers", "mixed"], config: { ...stationary, matchTicks: 25 } });
    const summary = balanceSummary([{ ...short, seatActivity: activity }], config);
    expect(summary.seatActivity.byStrategy.find((row) => row.strategy === "workers")).toMatchObject({
      matchesWithFloorFirings: 1, floorFirings: 1,
    });
    expect(summary.seatActivity.floorFirings[1]).toMatchObject({ seed: 7001, strategy: "workers", tick: 14 });
    expect(balanceActivityTable(summary.seatActivity).join("\n")).toContain("strategy workers, seed 7001, colony 0, seat a, tick 14");
  });

  it("counts a refused keep-alive separately and never treats it as an accepted command", () => {
    const config = { ...stationary, commandFloorTicks: 10 };
    let state = joined(config);
    const command = { type: "order", agentId: "a", order: { kind: "forage" }, brood: "workers" } as const;
    state = step(state, [command]).state;
    // This intentionally too-soon command is diagnostic evidence, not the scheduler.
    const out = step(state, [command]);
    expect(out.results[0]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(out.state.agents[0]!.lastCommandTick).toBe(1);
    const tracker = balanceActivityTracker(["workers", "mixed"], config);
    tracker.keepAlive(0, "a", state.tick, out.results[0]!);
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "mixed"], config: { ...stationary, matchTicks: 25 } });
    const summary = balanceSummary([{ ...record, seatActivity: tracker.report() }], config);
    expect(summary.seatActivity.keepAlives).toMatchObject({ attempted: 1, accepted: 0, refused: 1,
      refusals: [{ seed: 7001, strategy: "workers", agentId: "a", tick: 2, reason: "rate_limited" }] });
    expect(summary.countMarkAssessment).toEqual(balanceSummary([record], config).countMarkAssessment);
    expect(balanceActivityTable(summary.seatActivity).join("\n")).toContain("1 attempted, 0 accepted, 1 refused");
  });

  it("reports absent historical activity as unmeasured, not a zero-floor match", () => {
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "mixed"], config: { ...stationary, matchTicks: 25 } });
    const summary = balanceSummary([{ ...record, seatActivity: undefined }], stationary);
    expect(summary.seatActivity).toMatchObject({ measuredMatches: 0, unmeasuredMatches: 1 });
    expect(summary.seatActivity.byStrategy.every((row) => row.measuredMatches === 0)).toBe(true);
  });

  it("wires activity through the CLI worker JSON and the table renderer", () => {
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--single"], {
      input: JSON.stringify({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...stationary, matchTicks: 125 } }),
      encoding: "utf8", timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout) as ReturnType<typeof playBalanceMatch>;
    expect(record.seatActivity!.keepAlives.accepted).toBeGreaterThan(0);
    expect(record.seatActivity!.floorFirings).toEqual([]);
    const summary = balanceSummary([record], stationary);
    expect(balanceActivityTable(summary.seatActivity).join("\n")).toContain("| workers | 1 | 1 | 0 | 0 |");
    expect(readFileSync("test/tools/balance-sweep.mjs", "utf8")).toContain("...balanceActivityTable(summary.seatActivity)");
  }, 20_000);
});
