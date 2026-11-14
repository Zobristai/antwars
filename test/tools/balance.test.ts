import { describe, expect, it } from "vitest";
import { BALANCE_STRATEGIES, assessEarlyWin, leadPersistence, balanceBrood, balanceBroodInputs, balanceCommand, balancePopulationAtCheckpoint, balanceSummary, countMarkTracker, countMarkWithdrawals, median, playBalanceMatch, zeroClaimedDiagnostic, unclaimedReasonAssessment, type ZeroClaimedProbe } from "./balance.js";
import { MAPS, TERRAIN_RULES, rulesConfig } from "../../src/sim/config.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { localSoldierAssignments } from "../../src/sim/houseBot.js";
import { step } from "../../src/sim/step.js";
import { takeView } from "../../src/sim/view.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { playable } from "../playable.ts";
import { recordedHousePlan } from "../house-plan.ts";
import { spawnSync } from "node:child_process";

const rules = playable(rulesConfig("redesign"));
describe("balance sweep evidence", () => {
  it.each(MAPS)("pins $name in each record without replacing the fixed acceptance seeds or declaring short runs accepted", map => {
    const config = { ...rules, terrain: { ...TERRAIN_RULES, mapId: map.id }, matchTicks: 25 };
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config });
    expect(record).toMatchObject({ seed: 7001, mapId: map.id, mapName: map.name, naturalEndTick: 25 });
    expect(balanceSummary([record], config).accepted).toBe(false);
  });

  it("keeps all seven strategies and never accepts an incomplete matrix", () => {
    expect(BALANCE_STRATEGIES).toHaveLength(7);
    const summary = balanceSummary([], rules);
    expect(summary.complete).toBe(false); expect(summary.accepted).toBe(false);
    expect(summary.earlyFireRate).toBeNull();
    expect(summary.medianHeavyZeroSeconds).toBeNull();
    expect(summary.cells).toHaveLength(42);
  });
  it("detects counterfactual lost leads, including ties, after an early win would have ended the match", () => {
    const early = { minTick: 1, holdTicks: 2, territoryRatioPermille: 3000, minHeldTiles: 10 };
    const first = [{ tick: 0, held: [40, 10] as const }, { tick: 1, held: [40, 10] as const }, { tick: 2, held: [40, 10] as const }];
    expect(assessEarlyWin(first, early)).toMatchObject({ fireTick: 2, winner: 0, laterLeadChange: false });
    expect(assessEarlyWin([...first, { tick: 3, held: [10, 40] }], early).laterLeadChange).toBe(true);
    expect(assessEarlyWin([...first, { tick: 3, held: [10, 10] }], early).laterLeadChange).toBe(true);
    expect(assessEarlyWin([...first.slice(0, 2), { tick: 2, held: [20, 20] }, { tick: 3, held: [40, 10] }], early).fireTick).toBeNull();
  });
  it("applies the 30-second held measurement while retaining the old raw counts for comparison", () => {
    const leaders = [0, 0, 0, null, 1, 1, null, 0, 0, 0, 1, 1, 1, null, 1, 1, 1];
    const points = leaders.map((leader, tick) => ({ tick,
      held: (leader === null ? [10, 10] : leader === 0 ? [11, 10] : [10, 11]) as [number, number] }));
    expect(leadPersistence(points, 3, 3)).toEqual({ minHoldTicks: 3, changesHeld: 1, longestRegainedLeadTicks: [3, 3] }); // A two-tick flicker and return are not two changes.
    const spanning = Array.from({ length: 9 }, (_, tick) => ({ tick, held: (tick === 0 ? [11, 10] : [10, 11]) as [number, number] }));
    expect(leadPersistence(spanning, 5, 3)).toEqual({ minHoldTicks: 3, changesHeld: 0, longestRegainedLeadTicks: [0, 4] });
    const short = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...rules, matchTicks: 25 } });
    const record = { ...short, handicap: 0 as const, handicapComebackAfterTen: true,
      leadPersistence: { minHoldTicks: 300, changesHeld: 0, longestRegainedLeadTicks: [1, 0] as const } };
    const summary = balanceSummary([record], rules);
    expect(summary.comebacksOld).toBe(1);
    expect(summary.comebacks).toBe(0);
    expect(summary.leadMeasurement).toMatchObject({ minHoldSeconds: 30, measuredMatches: 1 });
    expect(summary.leadMeasurement.lopsided[0]).toMatchObject({ held: false, longestRegainedLeadSeconds: .1 });
    const unmeasured = balanceSummary([{ ...record, leadPersistence: undefined }], rules);
    expect(unmeasured.leadMeasurement.measuredMatches).toBe(0);
    expect(unmeasured.comebacks).toBeNull();
  });
  it("counts an early-end reversal only after the opponent's complete held lead, not a tie or a brief flip", () => {
    const rule = { minTick: 1, holdTicks: 2, territoryRatioPermille: 3000, minHeldTiles: 10 };
    const start = [0, 1, 2].map((tick) => ({ tick, held: [40, 10] as const }));
    const flicker = [...start, { tick: 3, held: [10, 40] as const }, { tick: 4, held: [10, 40] as const }, { tick: 5, held: [10, 10] as const }];
    expect(assessEarlyWin(flicker, rule).laterLeadChange).toBe(true);
    expect(assessEarlyWin(flicker, rule, 3)).toMatchObject({ fireTick: 2, laterLeadChange: false });
    const held = [...flicker, { tick: 6, held: [10, 40] as const }, { tick: 7, held: [10, 40] as const }, { tick: 8, held: [10, 40] as const }];
    expect(assessEarlyWin(held.slice(0, -1), rule, 3).laterLeadChange).toBe(false);
    expect(assessEarlyWin(held, rule, 3)).toMatchObject({ fireTick: 2, laterLeadChange: true });
    expect(assessEarlyWin([...flicker, { tick: 6, held: [10, 40] }, { tick: 8, held: [10, 40] }, { tick: 9, held: [10, 40] }], rule, 3).laterLeadChange).toBe(false);
  });
  it("reports old and held lead counts and early-end reversals side by side from the same game trajectory", () => {
    const short = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...rules, matchTicks: 25 } });
    const early = { rules: rules.earlyWin!, fireTick: 7000, winner: 0 as const, laterLeadChange: true };
    const record = { ...short, leadChangesAfterTen: 99,
      leadPersistence: { minHoldTicks: 300, changesHeld: 2, longestRegainedLeadTicks: [300, 300] as const },
      early: [early], earlyHeld: [{ ...early, laterLeadChange: false }] };
    const summary = balanceSummary([record], rules);
    expect(summary).toMatchObject({ lateChangesOld: 99, lateChanges: 2, earlyOldLaterLeadChanges: 1, earlyLaterLeadChanges: 0,
      earlyOldFired: 1, earlyFired: 1, earlyAssessed: 1 });
  });
  it("defines soldier-heavy as four soldier minutes then one worker minute, not a hidden rescue policy", () => {
    for (const [seconds, brood] of [[0, "soldiers"], [239, "soldiers"], [240, "workers"], [299, "workers"], [300, "soldiers"]] as const) {
      expect(balanceBrood("soldier-heavy", seconds * rules.ticksPerSecond, rules)).toBe(brood);
    }
  });
  it("sends each brood choice with set_brood for every live queen the seat owns, and orders carry none", () => {
    const state = step(createMatch(7001, rules), [{ type: "join", agentId: "a", placement: 0 }]).state;
    const view = takeView(state, buildGrid(state), state.agents[0]!);
    const queen = { queenId: 0, tileX: 1, tileY: 1, foundedTick: 0, lostTick: null, overrunTicks: 0 };
    const queens = [{ ...queen, owner: "a" }, { ...queen, queenId: 1, owner: "a", brood: "soldiers" as const }, { ...queen, queenId: 2, owner: "b" },
      { ...queen, queenId: 3 }, { ...queen, queenId: 4, owner: "a", lostTick: 5 }, { ...queen, queenId: 5, owner: "a", brood: "workers" as const }];
    for (const [seconds, brood, queenIds] of [[0, "soldiers", [0, 5]], [240, "workers", [0, 1]]] as const) {
      const at = { ...view, tick: seconds * rules.ticksPerSecond, queens };
      expect(balanceBroodInputs("soldier-heavy", at, rules)).toEqual(queenIds.map((queenId) => ({ type: "set_brood", agentId: "a", brood, queenId })));
      const order = balanceCommand("soldier-heavy", at, rules);
      expect(order).toMatchObject({ type: "order", order: { kind: "forage" } });
      expect(order).not.toHaveProperty("brood");
    }
    // An unset queen already breeds mixed, so a mixed seat sets only queens set otherwise; without castes it sends no set_brood.
    expect(balanceBroodInputs("mixed", { ...view, queens }, rules)).toEqual([1, 5].map((queenId) => ({ type: "set_brood", agentId: "a", brood: "mixed", queenId })));
    expect(balanceBroodInputs("soldiers", { ...view, queens }, { ...rules, castes: undefined })).toEqual([]);
  });
  it("retains full natural results and treats missing minute-ten observations as missing, not passed", () => {
    const config = { ...rules, matchTicks: 25 };
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldier-heavy"], config });
    expect(record.naturalEndTick).toBe(25);
    expect(record.naturalResult.reason).toBe("time_up");
    expect(record.offLaneAtTen).toEqual([null, null]);
    expect(record.acceptedCommands.every((n) => n > 0)).toBe(true);
    expect(balanceSummary([record], config).offLaneMissing).toBe(1);
    expect(balanceSummary([record], config).accepted).toBe(false);
  });
  it("separately reports natural elimination ticks and excludes pre-minute-ten eliminations, without inventing minute-ten values", () => {
    const short = { ...rules, matchTicks: 25 };
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: short });
    const eliminated = { ...record, naturalResult: { winner: 0 as const, reason: "queens_killed" as const, decidedBy: "queens_killed" as const, tick: 24 },
      minuteTenStatus: "not_applicable_elimination" as const };
    const summary = balanceSummary([eliminated], rules);
    expect(summary.offLaneMissing).toBe(0); expect(summary.offLaneFailures).toBe(0); expect(summary.offLaneNotApplicable).toBe(1);
    expect(eliminated.offLaneAtTen).toEqual([null, null]);
    expect(summary.eliminationMatches).toEqual([{ seed: 7001, strategies: ["workers", "soldiers"], handicap: null, winner: 0,
      endTick: 24, completedTicks: 25, endSeconds: 2.5, minuteTenStatus: "not_applicable_elimination" }]);
    // Elimination after minute ten does not excuse an absent checkpoint.
    const later = { ...eliminated, naturalEndTick: 7000, minuteTenStatus: "observed" as const };
    expect(balanceSummary([later], rules).offLaneMissing).toBe(1);
    expect(balanceSummary([later], rules).offLaneNotApplicable).toBe(0);
  });

  it("assesses each accepted mark at 30 seconds with withdrawn and unfinished observations kept out of the denominator", () => {
    const tracker = countMarkTracker(300);
    tracker.accept(1, 0); tracker.accept(2, 0); tracker.accept(3, 0); tracker.accept(4, 100);
    tracker.observe(299, new Map([[1, 0], [2, 5], [4, 0]])); // mark 3 was withdrawn
    expect(tracker.report()).toEqual({ accepted: 4, assessed: 0, zeroClaimed: 0, withdrawn: 1, unfinished: 3, zeroClaimedShare: null });
    tracker.observe(300, new Map([[1, 0], [2, 5], [4, 0]]));
    expect(tracker.report()).toEqual({ accepted: 4, assessed: 2, zeroClaimed: 1, withdrawn: 1, unfinished: 1, zeroClaimedShare: .5 });
    tracker.accept(1, 300); // accepted re-lays are separate observations
    tracker.observe(600, new Map([[1, 2], [4, 0]]));
    expect(tracker.report()).toEqual({ accepted: 5, assessed: 4, zeroClaimed: 2, withdrawn: 1, unfinished: 0, zeroClaimedShare: .5 });
  });

  it("reports refused commands and reasoned withdrawals without counting them as claimed or assessed", () => {
    const tracker = countMarkTracker(300, undefined, true);
    tracker.refuse("bad_count_mark"); tracker.refuse("bad_count_mark"); tracker.refuse("count_mark_not_visible");
    tracker.accept(1, 0); tracker.accept(1, 1); tracker.accept(2, 0);
    tracker.observe(2, new Map([[2, 3]]), new Map([[1, "expired"]])); // Both accepted observations of mark 1 expire.
    tracker.observe(301, new Map([[2, 3]]));
    expect(tracker.report()).toEqual({ accepted: 3, assessed: 1, zeroClaimed: 0, withdrawn: 2, unfinished: 0, zeroClaimedShare: 0,
      dispositions: { refused: 3, refusalReasons: { bad_count_mark: 2, count_mark_not_visible: 1 }, withdrawalReasons: { expired: 2 } } });
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...rules, matchTicks: 25 } });
    const withMeasurements = { ...record, countMarkAssessment: tracker.report() };
    const summary = balanceSummary([withMeasurements, withMeasurements], rules);
    expect(summary.countMarkAssessment.dispositions).toEqual({ refused: 6,
      refusalReasons: { bad_count_mark: 4, count_mark_not_visible: 2 }, withdrawalReasons: { expired: 4 } });
    expect(summary.countMarkAssessment).toMatchObject({ accepted: 6, assessed: 2, withdrawn: 4, zeroClaimed: 0 });
    const old = { ...record, countMarkAssessment: { ...tracker.report(), dispositions: undefined } };
    expect(balanceSummary([withMeasurements, old], rules).countMarkAssessment.dispositions).toBeUndefined();
    expect(summary.accepted).toBe(false); // Withdrawals cannot manufacture balance acceptance.
  });


  it("reports expiry, replacement and unknown withdrawals from observed state without manufacturing a cause", () => {
    const before = emptyMatch(0, rules);
    before.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 8, tileY: 24, words: [], laidTick: 0, steering: 0, verb: "GATHER", count: 2 });
    const after = { ...before, marks: [], tick: 10 };
    const laid = { type: "mark_laid" as const, tick: 9, markId: 2, agentId: "a", colony: 0 as const, words: [], tileX: 8, tileY: 24 };
    expect(countMarkWithdrawals(before, after, []).get(1)).toBe("unknown");
    expect(countMarkWithdrawals(before, after, [laid]).get(1)).toBe("replaced");
    expect(countMarkWithdrawals(before, { ...after, tick: rules.markLifetimeTicks }, []).get(1)).toBe("expired");
    expect(countMarkWithdrawals(before, { ...after, tick: rules.markLifetimeTicks }, [laid]).get(1)).toBe("expiry_or_replacement");
    const tracker = countMarkTracker(300, undefined, true);
    for (const id of [1, 2, 3, 4]) tracker.accept(id, 0);
    tracker.observe(10, new Map([[4, 1]]), new Map([[1, "expired"], [2, "replaced"]]));
    expect(tracker.report()).toMatchObject({ withdrawn: 3, unfinished: 1,
      dispositions: { withdrawalReasons: { expired: 1, replaced: 1, unknown: 1 } } });
  });

  it("retains a zero-ant checkpoint as an undefined ratio and counts it separately under the population floor", () => {
    const short = { ...rules, matchTicks: 25 };
    const record = playBalanceMatch({ seed: 7001, strategies: ["soldier-heavy", "strike"], config: short });
    const observed = { ...record, naturalEndTick: 18000, minuteTenStatus: "observed" as const,
      offLaneAtTen: [.4, null] as const,
      minuteTenPopulation: [{ live: 100, offLane: 40, queens: 1 }, { live: 0, offLane: 0, queens: 1 }] as const };
    const summary = balanceSummary([observed], rules);
    expect(summary.offLaneMissing).toBe(0);
    expect(summary.offLaneFailures).toBe(0);
    expect(summary.offLaneByColony).toEqual([]);
    expect(summary.smallColonyCount).toBe(1);
    expect(summary.smallColonyCheckpoints[0]).toMatchObject({ colony: 1, population: { live: 0, offLane: 0 } });
    expect(summary.zeroAntCheckpoints).toEqual([{ seed: 7001, strategies: ["soldier-heavy", "strike"], colony: 1, live: 0, offLane: 0, queens: 1 }]);
    expect(summary.accepted).toBe(false);
    expect(balanceSummary([{ ...observed, minuteTenPopulation: null }], rules).offLaneMissing).toBe(1);
  });

  it("applies the 25% spread criterion at 50 ants, reports 49 separately, and refuses missing population coverage", () => {
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...rules, matchTicks: 25 } });
    const measured = (population: number, off: number) => ({ ...record, naturalEndTick: 18000, minuteTenStatus: "observed" as const,
      offLaneAtTen: [off / population, .5] as const,
      minuteTenPopulation: [{ live: population, offLane: off, queens: 1 }, { live: 100, offLane: 50, queens: 1 }] as const });
    expect(balanceSummary([measured(49, 0)], rules)).toMatchObject({ offLaneFailures: 0, smallColonyCount: 1, offLaneMissing: 0 });
    expect(balanceSummary([measured(50, 0)], rules)).toMatchObject({ offLaneFailures: 1, smallColonyCount: 0 });
    expect(balanceSummary([measured(50, 13)], rules).offLaneFailures).toBe(0);
    expect(balanceSummary([measured(51, 12)], rules).offLaneFailures).toBe(1);
    const unknown = balanceSummary([{ ...measured(50, 13), minuteTenPopulation: null }], rules);
    expect(unknown.offLaneMissing).toBe(1); expect(unknown.accepted).toBe(false);
  });

  it("counts failing colonies separately from failing matches when both colonies miss the spread threshold", () => {
    const base = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: { ...rules, matchTicks: 25 } });
    const record = { ...base, naturalEndTick: 18000, minuteTenStatus: "observed" as const,
      offLaneAtTen: [.1, .2] as const,
      minuteTenPopulation: [{ live: 100, offLane: 10, queens: 1 }, { live: 100, offLane: 20, queens: 1 }] as const };
    const summary = balanceSummary([record], rules);
    expect(summary.offLaneFailures).toBe(2);
    expect(summary.offLaneByColony).toHaveLength(2);
    expect(summary.offLaneFailingMatches).toBe(1);
    expect(summary.accepted).toBe(false);
  });

  it("keeps live allocation quotas separate from observed off-lane positions in the checkpoint", () => {
    // The house plan's soldier allocation, as recorded matches still re-simulate it.
    const rules = recordedHousePlan(playable(rulesConfig("redesign")));
    const state = emptyMatch(6000, rules);
    // Every ant starts on the colony-0 nest tile, inside the central lane.
    const nestX = Math.floor(rules.nestTileX), nestY = Math.floor(rules.nestTileY);
    Array.from({ length: 100 }, () => addAnt(state, 0, nestX, nestY, { caste: "soldier" }));
    addAnt(state, 0, nestX, nestY, { caste: "worker" });
    addAnt(state, 0, nestX, nestY, { caste: "soldier", squad: "a" });
    const selected = localSoldierAssignments(state)!;
    state.ants.find((a) => selected.front.has(a.id))!.y = 9500;
    expect(balancePopulationAtCheckpoint(state)).toEqual([
      { live: 102, offLane: 1, queens: 1, soldiers: { free: 100, front: 50, patches: 45, frontOffLane: 1 } },
      { live: 0, offLane: 0, queens: 1, soldiers: { free: 0, front: 0, patches: 0, frontOffLane: 0 } },
    ]);
    const old = { ...state, config: { ...rules, localAnts: { ...rules.localAnts!, soldierAllocation: undefined } } };
    expect(balancePopulationAtCheckpoint(old)[0]).toEqual({ live: 102, offLane: 1, queens: 1 });
  });

  it("distinguishes a mark that never claimed from one empty after previously claiming, without changing the metric", () => {
    const probes: ZeroClaimedProbe[] = [];
    const tracker = countMarkTracker(300, (probe) => probes.push(probe));
    tracker.accept(1, 0); tracker.accept(2, 0);
    tracker.observe(1, new Map([[1, 3], [2, 0]]));
    tracker.observe(300, new Map([[1, 0], [2, 0]]));
    expect(tracker.report()).toEqual({ accepted: 2, assessed: 2, zeroClaimed: 2, withdrawn: 0, unfinished: 0, zeroClaimedShare: 1 });
    expect(probes).toContainEqual({ markId: 1, acceptedTick: 0, assessedTick: 300, peakClaimed: 3, lastClaimedTick: 1 });
    expect(probes).toContainEqual({ markId: 2, acceptedTick: 0, assessedTick: 300, peakClaimed: 0, lastClaimedTick: null });
  });

  it("records post-step free-pool limits without treating a snapshot as claim-pass causality", () => {
    // A house-planned colony's guards, as recorded matches still re-simulate them.
    const state = emptyMatch(300, recordedHousePlan(rules));
    state.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 40, tileY: 24, words: [], laidTick: 0, steering: 0, verb: "ATTACK", count: 20 });
    const probe = { markId: 1, acceptedTick: 0, assessedTick: 300, peakClaimed: 0, lastClaimedTick: null };
    expect(zeroClaimedDiagnostic(state, probe)).toMatchObject({ availability: "no_live_ants", liveAnts: 0, availabilityAt: "post_step" });
    addAnt(state, 0, 8, 24, { squad: "a" });
    addAnt(state, 0, 8, 24, { squad: "a" });
    expect(zeroClaimedDiagnostic(state, probe)).toMatchObject({ availability: "no_free_ants", liveAnts: 2, squadAnts: 2, freeEligible: 0 });
    state.ants[0]!.squad = null;
    state.ants[0]!.role = "forager";
    expect(zeroClaimedDiagnostic(state, probe)).toMatchObject({ availability: "eligible_after_step", freeEligible: 1 });
    state.ants[0]!.role = "guard";
    expect(zeroClaimedDiagnostic(state, probe)).toMatchObject({ availability: "no_free_ants", protectedGuards: 1 });
    expect(state.ants[0]!.claim).toBeUndefined();
    expect(() => zeroClaimedDiagnostic(state, { ...probe, markId: 999 })).toThrow("live count mark");
  });

  it.each([
    ["--phase", "diagnostic"],
    ["--phase", "preliminary", "--diagnose-existing", "unused"],
    ["--phase", "acceptance", "--diagnose-existing", "unused"],
  ])("refuses a mismatched diagnostic mode before any match can start (%s)", (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", ...args], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Diagnostic replay requires both");
    expect(result.stdout).toBe("");
  });

  it("rejects comeback-only replay outside diagnostic mode before reading or running anything", () => {
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--phase", "preliminary", "--diagnose-comebacks"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--diagnose-comebacks requires diagnostic mode");
    expect(result.stdout).toBe("");
  });

  it("only explains unclaimed marks with matching messages actually given at acceptance, retaining all other cases as findings", () => {
    const state = emptyMatch(300, rules);
    state.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 40, tileY: 24, words: [], laidTick: 0, steering: 0, verb: "ATTACK", count: 20 });
    addAnt(state, 0, 8, 24, { squad: "a" }); addAnt(state, 0, 8, 24, { squad: "b" });
    const probe = { markId: 1, acceptedTick: 0, assessedTick: 300, peakClaimed: 0, lastClaimedTick: null };
    const acceptance = { claimedAnts: 2, freeAntsNow: 3 };
    expect(zeroClaimedDiagnostic(state, probe).explanationAtAcceptance).toBeNull(); // No notice recorded: no explanation inferred.
    const freeZero = zeroClaimedDiagnostic(state, { ...probe, acceptanceAvailability: { ...acceptance, freeAntsNow: 0 } });
    expect(freeZero.explanationAtAcceptance).toBe("free_zero_reported");
    const newlyEmpty = zeroClaimedDiagnostic(state, { ...probe, acceptanceAvailability: acceptance });
    expect(newlyEmpty.explanationAtAcceptance).toBeNull(); // Free at acceptance is not the exact zero-free warning.
    const assessment = { assessed: 10, zeroClaimed: 4 };
    expect(unclaimedReasonAssessment(assessment, [freeZero, newlyEmpty])).toEqual({ explained: 1, unexplained: 3,
      shareOfAssessed: .3, shareOfUnclaimed: .75 }); // Missing diagnoses also remain unexplained.
  });

  it("has explicit empty/even/odd median behaviour", () => {
    expect(median([])).toBeNull(); expect(median([5, 1, 3])).toBe(3); expect(median([4, 2])).toBe(3);
  });
});
