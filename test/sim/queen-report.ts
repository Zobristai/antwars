/** Private in-process evidence. Four seeds run sequentially; no public server or LLM seats.
 * node --import ./src/ts-resolve.mjs test/sim/queen-report.ts --head SHA --out out/queens
 */
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PUBLIC_CONFIG, COLONY_NAMES, RULES_VERSION, SUB, type SimConfig } from "../../src/sim/config.ts";
import { activeQueens, createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { defaultAllocator } from "../../src/sim/agents.ts";
import { headerLine, stateHash } from "../../src/sim/log.ts";
import { encodeMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { territoryCounts } from "../../src/sim/territory.ts";
import { houseFoundingReserve, queenGuardTargets, type HouseFoundingDecision, type HouseFoundingReason } from "../../src/sim/houseBot.ts";
import { durationChecks, DURATION_SEEDS } from "../tools/colonyScale.ts";
import { measureQueenObserve, type ObserveMeasurement } from "../mcp/queen-payload.ts";
import type { ColonyId, SimEvent, SimState, WinReason } from "../../src/sim/types.ts";

type QueenLifecycle = Extract<SimEvent, { type: "queen_founded" | "queen_lost" }>;
type QueenRecord = { tick: number; tileX: number; tileY: number; queenId: number; heldTiles: number };

/** Post-step assignment counts and physical guard presence are distinct evidence. */
export function queenGuardSnapshot(state: SimState, colony: ColonyId) {
  const ants = state.ants.filter((a) => a.colony === colony);
  const eligible = ants.filter((a) => a.squad === null);
  const queens = activeQueens(state.colonies[colony]);
  const target = queenGuardTargets(ants.length, eligible.length, queens.length, state.config);
  const houseGuards = eligible.filter((a) => a.role === "guard").length;
  const clamped = target.clampedByCap || target.clampedByAvailability;
  return { tick: state.tick, colonyAnts: ants.length, eligibleAnts: eligible.length,
    perQueenTarget: target.perQueenTarget, totalTarget: target.requested, totalCap: target.cap,
    assignedTarget: target.assignedTarget, houseGuards, nonHouseGuardAnts: ants.length - houseGuards,
    clampedByCap: target.clampedByCap, clampedByAvailability: target.clampedByAvailability, clamped,
    queens: queens.map((q) => {
      const guards = eligible.filter((a) => a.role === "guard" && a.guardQueenId === q.id);
      const radius = state.config.overrunRadiusTiles;
      return { queenId: q.id, assignedGuards: guards.length,
        guardsWithinOverrunRadius: guards.filter((a) => Math.abs(Math.floor(a.x / SUB) - Math.floor(q.queenX / SUB)) <= radius &&
          Math.abs(Math.floor(a.y / SUB) - Math.floor(q.queenY / SUB)) <= radius).length };
    }) };
}

type QueenGuardPeak = { queenId: number; samples: number; peakAssignedGuards: number; peakAssignedTick: number;
  guardsWithinOverrunRadiusAtAssignedPeak: number; perQueenTargetAtAssignedPeak: number | null;
  peakGuardsWithinOverrunRadius: number; peakNearbyTick: number; clampedAnyTick: boolean };

export function queenRunChecks(input: { founded: number; finished: boolean; withinCap: boolean; hasObserve: boolean;
  slowestTickMs: number; moreGroundFoundedMore: boolean; guardCeiling: boolean }) {
  return { foundedQueens: input.founded > 0, finished: input.finished, withinQueenCap: input.withinCap,
    measuredObserve: input.hasObserve, tickBudget: input.slowestTickMs <= 100,
    moreGroundFoundedMore: input.moreGroundFoundedMore, guardCeiling: input.guardCeiling };
}

export function foundingDecisionMetrics() {
  const colonies = [0, 1].map(() => ({ counts: {} as Partial<Record<HouseFoundingReason, number>>,
    examples: {} as Partial<Record<HouseFoundingReason, { first: HouseFoundingDecision; last: HouseFoundingDecision }>>,
    affordableFourthQueenBlockers: {} as Partial<Record<HouseFoundingReason, number>>,
    lastDecision: null as HouseFoundingDecision | null, lastAffordableBlocked: null as HouseFoundingDecision | null,
    richestAffordableBlocked: null as HouseFoundingDecision | null }));
  return { colonies, record(d: HouseFoundingDecision) {
    const c = colonies[d.colony]!;
    c.counts[d.reason] = (c.counts[d.reason] ?? 0) + 1;
    const example = c.examples[d.reason];
    if (example) example.last = d; else c.examples[d.reason] = { first: d, last: d };
    c.lastDecision = d;
    if (d.foodStore >= d.threshold && d.reason !== "founded") {
      if (d.liveQueens === 3) c.affordableFourthQueenBlockers[d.reason] = (c.affordableFourthQueenBlockers[d.reason] ?? 0) + 1;
      c.lastAffordableBlocked = d;
      if (!c.richestAffordableBlocked || d.foodStore > c.richestAffordableBlocked.foodStore) c.richestAffordableBlocked = d;
    }
  } };
}

/** Debit accounting uses actual events, not a guessed constant or net food balance. */
export function queenReportMetrics(initial: SimState) {
  const colonies = initial.colonies.map((c) => ({
    colony: c.id, colonyName: COLONY_NAMES[c.id], foodSpentOnFounding: 0,
    queensFounded: [] as (QueenRecord & { foodCost: number })[], queensLost: [] as QueenRecord[],
    peakLiveQueens: activeQueens(c).length, heldTileTicks: 0,
  }));
  const guardMetrics = initial.colonies.map((c) => ({ clampedAnyTick: false, clampedTicks: 0, ceilingViolations: 0,
    atPeakColonyPopulation: queenGuardSnapshot(initial, c.id), queens: new Map<number, QueenGuardPeak>() }));
  const recordGuards = (state: SimState, countTick: boolean) => {
    for (const c of state.colonies) {
      const sample = queenGuardSnapshot(state, c.id), metrics = guardMetrics[c.id]!;
      metrics.clampedAnyTick ||= sample.clamped;
      if (countTick && sample.clamped) metrics.clampedTicks++;
      if (sample.totalCap !== null && sample.houseGuards > sample.totalCap) metrics.ceilingViolations++;
      if (sample.colonyAnts > metrics.atPeakColonyPopulation.colonyAnts) metrics.atPeakColonyPopulation = sample;
      for (const q of sample.queens) {
        let peak = metrics.queens.get(q.queenId);
        if (!peak) {
          peak = { queenId: q.queenId, samples: 0, peakAssignedGuards: q.assignedGuards, peakAssignedTick: sample.tick,
            guardsWithinOverrunRadiusAtAssignedPeak: q.guardsWithinOverrunRadius, perQueenTargetAtAssignedPeak: sample.perQueenTarget,
            peakGuardsWithinOverrunRadius: q.guardsWithinOverrunRadius, peakNearbyTick: sample.tick, clampedAnyTick: sample.clamped };
          metrics.queens.set(q.queenId, peak);
        }
        peak.samples++;
        peak.clampedAnyTick ||= sample.clamped;
        if (q.assignedGuards > peak.peakAssignedGuards) {
          peak.peakAssignedGuards = q.assignedGuards; peak.peakAssignedTick = sample.tick;
          peak.guardsWithinOverrunRadiusAtAssignedPeak = q.guardsWithinOverrunRadius;
          peak.perQueenTargetAtAssignedPeak = sample.perQueenTarget;
        }
        if (q.guardsWithinOverrunRadius > peak.peakGuardsWithinOverrunRadius) {
          peak.peakGuardsWithinOverrunRadius = q.guardsWithinOverrunRadius; peak.peakNearbyTick = sample.tick;
        }
      }
    }
  };
  recordGuards(initial, false);
  const samples: { tick: number; heldTiles: number[]; foodStore: number[]; queensAlive: number[] }[] = [];
  let measuredTicks = 0;
  const liveCounts = initial.colonies.map((c) => activeQueens(c).length);
  const sampleEveryTicks = initial.config.ticksPerSecond * 60;
  const snapshot = (state: SimState, held: number[]) => {
    if (samples.at(-1)?.tick === state.tick) return;
    samples.push({ tick: state.tick, heldTiles: [...held], foodStore: state.colonies.map((c) => c.foodStore),
      queensAlive: state.colonies.map((c) => activeQueens(c).length) });
  };
  snapshot(initial, territoryCounts(initial));
  return {
    record(state: SimState, events: readonly SimEvent[]): void {
      recordGuards(state, true);
      const held = territoryCounts(state);
      for (const c of colonies) {
        c.heldTileTicks += held[c.colony]!;
        c.peakLiveQueens = Math.max(c.peakLiveQueens, activeQueens(state.colonies[c.colony]).length);
      }
      measuredTicks++;
      for (const e of events) {
        if (e.type !== "queen_founded" && e.type !== "queen_lost") continue;
        const c = colonies[e.colony]!;
        const item = { tick: e.tick, tileX: e.tileX, tileY: e.tileY, queenId: e.queenId, heldTiles: held[e.colony]! };
        if (e.type === "queen_founded") {
          const foodCost = e.foodCost ?? state.config.queenFounding!.cost;
          c.foodSpentOnFounding += foodCost;
          c.queensFounded.push({ ...item, foodCost });
          // A queen founded and lost in this same step has no standing sample.
          // Report that explicitly rather than omitting her from guard evidence.
          const guards = guardMetrics[e.colony]!;
          if (!guards.queens.has(e.queenId)) guards.queens.set(e.queenId, { queenId: e.queenId, samples: 0,
            peakAssignedGuards: 0, peakAssignedTick: e.tick, guardsWithinOverrunRadiusAtAssignedPeak: 0,
            perQueenTargetAtAssignedPeak: null, peakGuardsWithinOverrunRadius: 0, peakNearbyTick: e.tick, clampedAnyTick: false });
          liveCounts[e.colony]!++;
          c.peakLiveQueens = Math.max(c.peakLiveQueens, liveCounts[e.colony]!);
        } else {
          c.queensLost.push(item); liveCounts[e.colony]!--;
        }
      }
      if (state.tick % sampleEveryTicks === 0 || state.result !== null) snapshot(state, held);
    },
    finish(state: SimState) {
      snapshot(state, territoryCounts(state));
      const leading = colonies[0]!.heldTileTicks === colonies[1]!.heldTileTicks ? null
        : (colonies[0]!.heldTileTicks > colonies[1]!.heldTileTicks ? 0 : 1) as ColonyId;
      const minuteThree = samples.find((s) => s.tick === initial.config.ticksPerSecond * 180);
      const minuteThreeLeader = !minuteThree || minuteThree.heldTiles[0] === minuteThree.heldTiles[1] ? null
        : minuteThree.heldTiles[0]! > minuteThree.heldTiles[1]! ? 0 : 1;
      return {
        colonies: colonies.map((c) => ({ ...c, foodBankedAtEnd: state.colonies[c.colony].foodStore,
          liveQueensAtEnd: activeQueens(state.colonies[c.colony]).length,
          meanHeldTiles: measuredTicks === 0 ? 0 : c.heldTileTicks / measuredTicks,
          guards: { ...guardMetrics[c.colony]!, queens: [...guardMetrics[c.colony]!.queens.values()],
            method: "Post-step samples each tick; assigned guards and guards physically within the overrun radius are separate. Peaks are first occurrence. Zero samples means founded and lost within one step. Clamping compares all live targets to the total colony ceiling and existing non-squad ants." } })),
        territorySamples: samples, sampleEveryTicks,
        territoryFoundingComparison: { basis: "mean held tiles across every simulated tick, not proof of causation", moreGroundColony: leading,
          moreGroundFoundedMore: leading !== null && colonies[leading]!.queensFounded.length > colonies[1 - leading]!.queensFounded.length,
          comparisonApplicable: leading !== null, tieNote: leading === null ? "Equal mean ground; no ground leader, so this seed does not establish the required association." : null },
        minuteThreeLeader, minuteThreeLeaderWon: minuteThreeLeader === null || state.result === null ? null : state.result.winner === minuteThreeLeader,
        end: { tick: state.tick, reason: state.result?.reason ?? "unfinished", result: state.result },
      };
    },
  };
}

export function queenDurationVerdict(runs: readonly { seed: number; ticks: number; reason: WinReason | null; exitCode: number }[], config: SimConfig) {
  const duration = durationChecks(runs.map((r) => ({ seed: r.seed, endTick: r.ticks, reason: r.reason })), config);
  // Keeps its original time-up check; this report applies the amended queen rule.
  const { includesTimeUp: _, ...commonChecks } = duration.checks;
  const checks = { ...commonChecks, includesMatchPastTwentyFiveMinutes: runs.some((r) => r.ticks > 25 * 60 * config.ticksPerSecond) };
  return { medianEndTick: duration.medianEndTick, checks,
    exitCode: runs.every((r) => r.exitCode === 0 && r.reason !== null) && Object.values(checks).every(Boolean) ? 0 : 1 };
}

export function queenOutcome(seed: number, endTick: number, result: SimState["result"]) {
  if (result === null) return { seed, endTick, status: "unfinished" as const };
  return { seed, endTick, status: "complete" as const, winner: result.winner,
    winnerName: result.winner === null ? null : COLONY_NAMES[result.winner],
    reason: result.reason, decidedBy: result.decidedBy, decisionTick: result.tick };
}

async function runSeed(seed: number, head: string, out: string) {
  const config = PUBLIC_CONFIG;
  const dir = join(out, String(seed)); mkdirSync(dir, { recursive: true });
  const recordingName = `queens-${head}-${seed}`;
  mkdirSync("out/recordings", { recursive: true });
  const recording = resolve("out/recordings", `${recordingName}.bin`);
  const fd = openSync(recording, "w");
  const emit = (message: Uint8Array) => {
    const length = Buffer.allocUnsafe(4); length.writeUInt32LE(message.length);
    writeFileSync(fd, length); writeFileSync(fd, message);
  };
  let state = createMatch(seed, config);
  let peakState = state;
  const recorder = new SpectatorRecorder(state), metrics = queenReportMetrics(state), decisions = foundingDecisionMetrics();
  const lifecycle: QueenLifecycle[] = [], observations: ObserveMeasurement[] = [];
  const sampled = new Set<number>();
  const observe = async (s: SimState) => {
    if (sampled.has(s.tick) || s.result !== null || s.tick + 3 >= s.config.matchTicks) return;
    observations.push(...await measureQueenObserve(s)); sampled.add(s.tick);
  };
  let peakAnts = state.ants.length, peakQueens = 2, peakOverrun = 0, peakOverrunTick = 0;
  let slowestTick = { tick: 0, ms: 0, ants: state.ants.length };
  const started = performance.now();
  try {
    emit(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    await observe(state);
    while (state.result === null && state.tick < config.matchTicks) {
      const pendingDecisions: HouseFoundingDecision[] = [];
      const tick = state.tick, ants = state.ants.length, before = performance.now();
      const result = step(state, [], defaultAllocator, (d) => pendingDecisions.push(d));
      const ms = performance.now() - before;
      if (ms > slowestTick.ms) slowestTick = { tick, ms, ants };
      state = result.state;
      for (const decision of pendingDecisions) decisions.record(decision);
      emit(encodeMessage({ ...recorder.record(result), full: null }));
      metrics.record(state, result.events);
      for (const e of result.events) {
        if (e.type === "queen_founded" || e.type === "queen_lost") lifecycle.push(e);
        if (e.type === "overrun_progress" && e.progressTicks > peakOverrun) { peakOverrun = e.progressTicks; peakOverrunTick = state.tick; }
      }
      peakAnts = Math.max(peakAnts, state.ants.length);
      peakQueens = Math.max(peakQueens, state.colonies.reduce((n, c) => n + activeQueens(c).length, 0));
      if (state.result === null && state.tick + 3 < state.config.matchTicks && state.ants.length > peakState.ants.length) peakState = state;
      if (state.tick % (60 * state.config.ticksPerSecond) === 0 || result.events.some((e) => e.type === "queen_founded" || e.type === "queen_lost")) await observe(state);
    }
    await observe(peakState);
  } finally { closeSync(fd); }
  const counts = metrics.finish(state);
  const founded = lifecycle.filter((e) => e.type === "queen_founded");
  const withinCap = config.queenFounding!.maxLiveQueens === undefined || counts.colonies.every((c) => c.peakLiveQueens <= config.queenFounding!.maxLiveQueens!);
  const largestObserve = observations.reduce<ObserveMeasurement | null>((best, item) => best === null || item.bytes > best.bytes ? item : best, null);
  const checks = queenRunChecks({ founded: founded.length, finished: state.result !== null, withinCap,
    hasObserve: largestObserve !== null, slowestTickMs: slowestTick.ms,
    moreGroundFoundedMore: counts.territoryFoundingComparison.moreGroundFoundedMore,
    guardCeiling: counts.colonies.every((c) => c.guards.ceilingViolations === 0) });
  const report = {
    exitCode: Object.values(checks).every(Boolean) ? 0 : 1, checks, tickBudgetMs: 100,
    head, private: true, kind: "deterministic house-only simulation; observers run only on isolated clones", seed,
    outcome: queenOutcome(seed, state.tick, state.result),
    rulesVersion: RULES_VERSION, config, houseFoundingReserve: houseFoundingReserve(state),
    ...counts, colonies: counts.colonies.map((c) => ({ ...c, foundingDecisions: decisions.colonies[c.colony] })),
    ticks: state.tick, seconds: state.tick / config.ticksPerSecond,
    computeMs: performance.now() - started, slowestTick, peakAnts, peakQueens, peakOverrunTick, peakOverrun,
    queens: lifecycle.map((e) => ({ ...e, colonyName: COLONY_NAMES[e.colony], seconds: e.tick / config.ticksPerSecond })),
    result: state.result, stats: state.stats, territory: territoryCounts(state), endHash: stateHash(state), recording, recordingName,
    largestObserve, observations,
    observeMethod: "Largest measured full UTF-8 JSON tool result (text plus structured content, excluding transport), both colonies with/without map. Samples: minute boundaries, founding/loss ticks and first peak population. Each private clone advances through join and two observe calls; played matches remain house-only. Not an exhaustive all-tick or backlog maximum.",
    reportPath: join(dir, "report.json"),
  };
  writeFileSync(join(dir, "match.jsonl"), `${headerLine(seed, config)}\n`);
  writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`exit code ${report.exitCode}\nseed ${seed}, ticks ${state.tick}, reason ${state.result?.reason ?? "unfinished"}`);
  return report;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { head: { type: "string" }, seeds: { type: "string", default: DURATION_SEEDS.join(",") },
    out: { type: "string", default: "out/queens" } } });
  const config = PUBLIC_CONFIG;
  if (!/^[a-f0-9]{40}$/.test(values.head ?? "")) throw new Error("Supply exact committed --head SHA; it is recorded as given, not read from Git.");
  const seeds = values.seeds.split(",").map(Number);
  if (!seeds.length || seeds.some((s) => !Number.isInteger(s)) || new Set(seeds).size !== seeds.length) throw new Error("seeds must be unique integers");
  const out = resolve(values.out); mkdirSync(out, { recursive: true });
  const runs = [];
  for (const seed of seeds) runs.push(await runSeed(seed, values.head!, out));
  const duration = queenDurationVerdict(runs.map((r) => ({ seed: r.seed, ticks: r.ticks, reason: r.result?.reason ?? null, exitCode: r.exitCode })), config);
  const slowestTick = runs.reduce((best, r) => r.slowestTick.ms > best.ms ? { seed: r.seed, ...r.slowestTick } : best, { seed: runs[0]!.seed, ...runs[0]!.slowestTick });
  const largestObserve = runs.flatMap((r) => r.observations.map((o) => ({ seed: r.seed, ...o }))).reduce((best, o) => best === null || o.bytes > best.bytes ? o : best, null as ({ seed: number } & ObserveMeasurement) | null);
  const report = { exitCode: duration.exitCode, kind: "public-rules acceptance",
    head: values.head, config, seeds, private: true, duration, outcomes: runs.map((r) => r.outcome),
    tickBudgetMs: 100, slowestTick, largestObserve, runs };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`exit code ${report.exitCode}\n${JSON.stringify(report, null, 2)}`); process.exitCode = report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(`exit code 1\n${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 1; });
}
