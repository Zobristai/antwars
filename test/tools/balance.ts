import { createHash } from "node:crypto";
import { defaultAllocator } from "../../src/sim/agents.js";
import { SUB, rulesConfig, type EarlyWinRules, type SimConfig } from "../../src/sim/config.js";
import { activeQueens, createMatch } from "../../src/sim/map.js";
import { gridScaleOf as balanceGridScale } from "../../src/sim/gridScale.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { localSoldierAssignments } from "../../src/sim/houseBot.js";
import { step } from "../../src/sim/step.js";
import { territoryCounts } from "../../src/sim/territory.js";
import type { Brood, ColonyId, CountMarkAvailability, CountMarkVerb, InputResult, MatchResult, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import type { AgentView } from "../../src/sim/view.js";

export const BALANCE_STRATEGIES = ["workers", "soldiers", "soldier-heavy", "mixed", "rush", "count-mark army", "strike"] as const;
export type BalanceStrategy = (typeof BALANCE_STRATEGIES)[number];
export const SOLDIER_HEAVY_DEFINITION = "Fixed five-minute brood-time cycle: four minutes soldiers, then one minute workers; accepted forage/brood order each 10 seconds. No worker-rescue controller. This is an approximation, not a captured LLM policy.";

/** Preserve the historical half-open physical lane [18, 31) original cells. */
function outsideCentralLane(y: number, config: SimConfig): boolean {
  const row = Math.floor(y / (SUB * balanceGridScale(config)));
  return row < 18 || row > 30;
}

/** The brood a strategy chooses at this tick. */
export function balanceBrood(strategy: BalanceStrategy, tick: number, config: SimConfig): Brood {
  return strategy === "workers" ? "workers" : strategy === "soldiers" || strategy === "rush" || strategy === "strike" ? "soldiers"
    : strategy === "soldier-heavy" ? (Math.floor(tick / (60 * config.ticksPerSecond)) % 5 < 4 ? "soldiers" : "workers") : "mixed";
}

/** Rules 27: each queen's owner sets her brood with set_brood, so orders carry none. */
function perQueenBrood(config: SimConfig): boolean {
  return config.castes !== undefined;
}

/**
 * Rules 27: the strategy's brood choice, sent with set_brood to every live
 * queen the seat owns whose brood differs (unset breeds mixed). Empty without castes.
 */
export function balanceBroodInputs(strategy: BalanceStrategy, view: AgentView, config: SimConfig): Extract<SimInput, { type: "set_brood" }>[] {
  if (!perQueenBrood(config)) return [];
  const brood = balanceBrood(strategy, view.tick, config);
  return (view.queens ?? []).filter((queen) => queen.lostTick === null && queen.owner === view.agentId && (queen.brood ?? "mixed") !== brood)
    .map((queen) => ({ type: "set_brood", agentId: view.agentId, brood, queenId: queen.queenId }));
}

/** Fixed policies use only observe, memory, and the declared mirrored-nest prior. */
export function balanceCommand(strategy: BalanceStrategy, view: AgentView, config: SimConfig): SimInput | null {
  const agentId = view.agentId;
  const tps = config.ticksPerSecond;
  const initial = view.tick <= 2;
  // Rules 27: the brood goes with set_brood (balanceBroodInputs), never on the order.
  const brood: { brood?: Brood } = perQueenBrood(config) ? {} : { brood: balanceBrood(strategy, view.tick, config) };
  if (initial || strategy === "soldier-heavy") return { type: "order", agentId, order: { kind: "forage" }, ...brood };
  if (strategy === "workers" || strategy === "soldiers" || strategy === "mixed") return null;
  if (view.tick < 5 * 60 * tps) return null;
  // Scaled physical centres may lie halfway between fine cells. Commands
  // require integer cells: choose the lower left-home cell, mirror it for
  // the right home, and choose the lower row on both sides. This preserves
  // horizontal symmetry without submitting fractional attack targets.
  const leftHomeX = Math.floor(config.nestTileX), targetY = Math.floor(config.nestTileY);
  const enemyX = view.colony === 0 ? config.mapWidth - 1 - leftHomeX : leftHomeX;
  if (strategy === "rush") return { type: "order", agentId, order: { kind: "attack", tileX: enemyX, tileY: targetY }, ...brood };
  if (strategy === "strike") {
    const seen = view.cells.some((c) => c.tileX === enemyX && c.tileY === targetY);
    // The measured scripted policy's 20-ant request.
    return seen ? { type: "count_mark", agentId, verb: "ATTACK", count: 20, tileX: enemyX, tileY: targetY }
      : { type: "order", agentId, order: { kind: "attack", tileX: enemyX, tileY: targetY }, ...brood };
  }
  // The army aims at the furthest visible tile occupied by its own colony. It does not read hidden state.
  const own = view.cells.filter((c) => c.ants.some((a) => a.colony === view.colony))
    .sort((a, b) => (view.colony === 0 ? b.tileX - a.tileX : a.tileX - b.tileX) || a.tileY - b.tileY)[0];
  if (own === undefined) return null;
  const targetX = Math.max(0, Math.min(config.mapWidth - 1, own.tileX + (view.colony === 0 ? 1 : -1) * balanceGridScale(config)));
  if (!view.squad.some((ant) => (ant.tileX - targetX) ** 2 + (ant.tileY - own.tileY) ** 2 <= config.sightTiles ** 2)) return null;
  return { type: "count_mark", agentId, verb: "ATTACK", count: 20, tileX: targetX, tileY: own.tileY };
}

export const BALANCE_FOUNDING_POLICY = "One existing founder seat per colony, shared by every strategy and hatch arm: spend the quoted founding cost with no reserve at normal command opportunities; first held dry site in row order, mirrored horizontally by colony. Keep initial brood orders and keep-alives; use only the agent view and mirrored original-nest prior. Validator refusals remain recorded.";
export type BalanceFoundingPolicy = "off" | "shared";

/** No hidden state or strategy-specific economy. The validator handles changes since observation. */
export function balanceFoundingCommand(view: AgentView, config: SimConfig): Extract<SimInput, { type: "found_queen" }> | null {
  const rules = view.queenFounding;
  const live = view.queens?.filter(queen => queen.lostTick === null) ?? [];
  if (rules === undefined || live.length === 0 || view.tick <= 2 || view.tick < view.nextCommandTick ||
      view.tick < (rules.firstFoundTick ?? 0) || view.tick < rules.nextFoundTick || rules.foodStore < rules.cost ||
      live.length >= (rules.maxLiveQueens ?? Infinity)) return null;
  const nests = (config.queenFounding?.standingNestsOnly ? live : view.queens ?? []).map(queen => ({ x: queen.tileX, y: queen.tileY }));
  // Enemy nests are known only where visible, plus the declared mirrored opening prior.
  nests.push({ x: view.colony === 0 ? config.mapWidth - 1 - config.nestTileX : config.nestTileX, y: config.nestTileY });
  for (const cell of view.cells) if (cell.queen !== undefined && cell.queen !== view.colony) nests.push({ x: cell.tileX, y: cell.tileY });
  const obstacles = [...view.terrain?.water ?? [], ...view.terrain?.rocks ?? []];
  for (let y = 0; y < config.mapHeight; y++) for (let offset = 0; offset < config.mapWidth; offset++) {
    const x = view.colony === 0 ? offset : config.mapWidth - 1 - offset;
    if (view.territoryRows[y]?.[x] !== "#" || obstacles.some(([ox, oy, width, height]) => x >= ox && x < ox + width && y >= oy && y < oy + height) ||
        nests.some(nest => (x - nest.x) ** 2 + (y - nest.y) ** 2 < rules.minDistanceTiles ** 2)) continue;
    return { type: "found_queen", agentId: view.agentId, tileX: x, tileY: y };
  }
  return null;
}

export interface BalanceFoundingExposure {
  readonly policy: BalanceFoundingPolicy;
  readonly colonies: readonly {
    readonly colony: ColonyId;
    readonly attempted: number;
    readonly accepted: number;
    readonly refusals: readonly { readonly tick: number; readonly tileX: number; readonly tileY: number; readonly reason: string }[];
    readonly queenCounts: readonly { readonly tick: number; readonly live: number }[];
    /** Hatches while a second or later live queen exists, attributed by her actual timer advance. */
    readonly additionalQueenHatches: number;
  }[];
}

/** Reissue the current order, never a count mark: full claim caps cannot refuse it.
 * Leave one decision interval of slack, and never count an attempted command as activity.
 * The order is repeated alone: brood belongs to each queen.
 */
export function balanceKeepAlive(view: AgentView, config: SimConfig, lastAcceptedTick: number | null, cadence: number): Extract<SimInput, { type: "order" }> | null {
  if (config.commandIdleTicks === undefined || lastAcceptedTick === null ||
      view.tick + cadence - lastAcceptedTick < config.commandIdleTicks || view.tick < view.nextCommandTick) return null;
  return { type: "order", agentId: view.agentId, order: view.order };
}


export interface IdleFloorFiring {
  readonly agentId: string;
  readonly colony: ColonyId;
  readonly strategy: BalanceStrategy;
  readonly tick: number;
  readonly lastAcceptedTick: number | null;
}
export interface SeatActivity {
  readonly floorEnabled: boolean;
  readonly floorFirings: readonly IdleFloorFiring[];
  readonly seats: readonly { readonly agentId: string; readonly colony: ColonyId; readonly strategy: BalanceStrategy;
    readonly idleTicks: number; readonly maxAcceptedCommandGapTicks: number }[];
  readonly keepAlives: { readonly attempted: number; readonly accepted: number; readonly refused: number;
    readonly refusals: readonly { readonly agentId: string; readonly colony: ColonyId; readonly strategy: BalanceStrategy;
      readonly tick: number; readonly reason: string }[] };
}

/** Observe the exact pre-input expiry boundary used by step/lapseSquads, without
 * changing the simulator. Post-step idle alone misses expiry followed by a wake
 * in the same tick, and squad_released alone misses seats with empty squads.
 */
export function balanceActivityTracker(strategies: readonly [BalanceStrategy, BalanceStrategy], config: SimConfig) {
  const floorFirings: IdleFloorFiring[] = [];
  const seats = new Map<string, { agentId: string; colony: ColonyId; strategy: BalanceStrategy;
    idleTicks: number; maxAcceptedCommandGapTicks: number }>();
  const refusals: { agentId: string; colony: ColonyId; strategy: BalanceStrategy; tick: number; reason: string }[] = [];
  let attempted = 0, accepted = 0;
  return {
    beforeStep(state: SimState): void {
      if (state.result !== null) return;
      for (const agent of state.agents) {
        const seat = seats.get(agent.id) ?? { agentId: agent.id, colony: agent.colony, strategy: strategies[agent.colony],
          idleTicks: 0, maxAcceptedCommandGapTicks: 0 };
        seats.set(agent.id, seat);
        const since = agent.lastCommandTick ?? agent.joinedTick ?? agent.lastCallTick;
        seat.maxAcceptedCommandGapTicks = Math.max(seat.maxAcceptedCommandGapTicks, state.tick - since);
        if (config.commandIdleTicks !== undefined && !agent.idle && state.tick - since >= config.commandIdleTicks) {
          floorFirings.push({ agentId: agent.id, colony: agent.colony, strategy: strategies[agent.colony],
            tick: state.tick, lastAcceptedTick: agent.lastCommandTick });
        }
      }
    },
    afterStep(state: SimState): void {
      for (const agent of state.agents) if (agent.idle) {
        const seat = seats.get(agent.id);
        if (seat !== undefined) seat.idleTicks++;
      }
    },
    keepAlive(colony: ColonyId, agentId: string, tick: number, result: InputResult): void {
      attempted++;
      if (result.ok) accepted++;
      else refusals.push({ agentId, colony, strategy: strategies[colony], tick, reason: result.error.code });
    },
    report(): SeatActivity {
      return { floorEnabled: config.commandIdleTicks !== undefined, floorFirings: floorFirings.slice(),
        seats: [...seats.values()].map((seat) => ({ ...seat })),
        keepAlives: { attempted, accepted, refused: refusals.length, refusals: refusals.slice() } };
    },
  };
}

export interface TerritoryPoint { readonly tick: number; readonly held: readonly [number, number] }
export interface EarlyAssessment {
  readonly rules: EarlyWinRules;
  readonly fireTick: number | null;
  readonly winner: ColonyId | null;
  readonly laterLeadChange: boolean;
}
/** Exact consecutive-tick replay, not sampled checkpoints; runs after natural full-length matches. */
export function assessEarlyWin(points: readonly TerritoryPoint[], rules: EarlyWinRules, leadHoldTicks?: number): EarlyAssessment {
  let leader: ColonyId | null = null;
  let ticks = 0;
  let fireTick: number | null = null;
  let winner: ColonyId | null = null;
  let laterLeadChange = false, reversalTicks = 0, lastTick: number | null = null;
  for (const point of points) {
    const contiguous = lastTick !== null && point.tick === lastTick + 1;
    lastTick = point.tick;
    const held = point.held;
    const now = held[0] > held[1] ? 0 : held[1] > held[0] ? 1 : null;
    if (fireTick !== null) {
      if (leadHoldTicks === undefined) {
        // Retain the original measurement for comparison and exact historical diagnostics.
        if (now !== winner) laterLeadChange = true;
      } else {
        reversalTicks = now !== null && now !== winner ? (contiguous ? reversalTicks + 1 : 1) : 0;
        if (reversalTicks >= leadHoldTicks) laterLeadChange = true;
      }
      continue;
    }
    const qualifies = point.tick >= rules.minTick && now !== null && held[now] >= rules.minHeldTiles &&
      held[now] * 1000 >= Math.max(1, held[now === 0 ? 1 : 0]) * rules.territoryRatioPermille;
    if (!qualifies) { leader = null; ticks = 0; continue; }
    ticks = leader === now ? ticks + 1 : 1;
    leader = now;
    if (ticks >= rules.holdTicks) { fireTick = point.tick; winner = now; }
  }
  return { rules, fireTick, winner, laterLeadChange };
}

export interface LeadPersistence {
  /** Minimum consecutive strict-lead duration used for the held measurement. */
  readonly minHoldTicks: number;
  readonly changesHeld: number;
  readonly longestRegainedLeadTicks: readonly [number, number];
}

/** Consecutive strict leads: ties and missing ticks interrupt a hold, without rewriting the raw flip count. */
export function leadPersistence(points: readonly TerritoryPoint[], afterTick: number, minHoldTicks: number): LeadPersistence {
  const runs: { leader: ColonyId | null; start: number; end: number }[] = [];
  for (const point of points) {
    const leader = point.held[0] > point.held[1] ? 0 : point.held[1] > point.held[0] ? 1 : null;
    const last = runs.at(-1);
    if (last !== undefined && last.leader === leader && last.end + 1 === point.tick) last.end = point.tick;
    else runs.push({ leader, start: point.tick, end: point.tick });
  }
  let lastHeld: ColonyId | null = null, changesHeld = 0;
  const trailed = [false, false], longest: [number, number] = [0, 0];
  for (const run of runs) {
    if (run.leader === null) continue;
    if (run.end - run.start + 1 >= minHoldTicks) {
      // A brief opposing flicker never replaces the last established leader, so its
      // return is not counted as another change merely because that return lasts.
      if (lastHeld !== null && lastHeld !== run.leader && run.start >= afterTick) changesHeld++;
      lastHeld = run.leader;
    }
    if (trailed[run.leader]) longest[run.leader] = Math.max(longest[run.leader], Math.max(0, run.end - Math.max(run.start, afterTick) + 1));
    trailed[run.leader === 0 ? 1 : 0] = true;
  }
  return { minHoldTicks, changesHeld, longestRegainedLeadTicks: longest };
}

export interface CountMarkDispositions {
  readonly refused: number;
  readonly refusalReasons: Readonly<Record<string, number>>;
  /** Accepted observations (including re-lays), not physical marks or claimed ants. */
  readonly withdrawalReasons: Readonly<Partial<Record<CountMarkWithdrawalReason, number>>>;
}
export interface CountMarkAssessment {
  readonly accepted: number;
  readonly assessed: number;
  readonly zeroClaimed: number;
  readonly withdrawn: number;
  readonly unfinished: number;
  /** Assessed marks only; withdrawn and unfinished observations are never treated as claims. */
  readonly zeroClaimedShare: number | null;
  /** Absent on historical configs/reports, never inferred as zero. */
  readonly dispositions?: CountMarkDispositions;
  readonly noReason?: { readonly explained: number; readonly unexplained: number; readonly shareOfAssessed: number | null; readonly shareOfUnclaimed: number | null };
}

export interface ZeroClaimedProbe {
  readonly markId: number;
  readonly acceptedTick: number;
  readonly assessedTick: number;
  readonly peakClaimed: number;
  readonly lastClaimedTick: number | null;
  /** Actual private acceptance metadata delivered in that command's result, not reconstructed later. */
  readonly acceptanceAvailability?: CountMarkAvailability;
}
export interface ZeroClaimedDiagnostic extends ZeroClaimedProbe {
  readonly colony: ColonyId;
  readonly verb: CountMarkVerb;
  readonly requested: number;
  readonly liveAnts: number;
  readonly squadAnts: number;
  readonly claimedElsewhere: number;
  readonly protectedGuards: number;
  readonly freeEligible: number;
  /** Availability AFTER movement, casualties and hatching, not at the earlier claim pass. */
  readonly availabilityAt: "post_step";
  readonly availability: "no_live_ants" | "no_free_ants" | "eligible_after_step";
  readonly explanationAtAcceptance?: "free_zero_reported" | null;
}

/** Explain the observed state without assigning a cause not recorded at the claim pass. */
export function zeroClaimedDiagnostic(state: SimState, probe: ZeroClaimedProbe): ZeroClaimedDiagnostic {
  const mark = state.marks.find((m) => m.id === probe.markId);
  if (mark?.verb === undefined || mark.count === undefined || state.config.countMarks === undefined) {
    throw new Error("A zero-claimed probe requires a live count mark");
  }
  const ants = state.ants.filter((a) => a.colony === mark.colony);
  const claimedElsewhere = ants.filter((a) => a.claim !== undefined && a.claim !== mark.id).length;
  const squadAnts = ants.filter((a) => a.squad !== null).length;
  const planner = !localRulesSide(state, mark.colony);
  const protectedGuards = ants.filter((a) => a.squad === null && a.claim === undefined && planner && a.role === "guard").length;
  const freeEligible = ants.filter((a) => a.squad === null && a.claim === undefined && !(planner && a.role === "guard")).length;
  const availability = ants.length === 0 ? "no_live_ants" : freeEligible === 0 ? "no_free_ants" : "eligible_after_step";
  return { ...probe, colony: mark.colony, verb: mark.verb, requested: mark.count, liveAnts: ants.length,
    squadAnts, claimedElsewhere, protectedGuards, freeEligible, availabilityAt: "post_step", availability,
    ...(state.config.countMarks.reportClaimAvailability ? { explanationAtAcceptance:
      availability === "no_free_ants" && probe.acceptanceAvailability?.freeAntsNow === 0 ? "free_zero_reported" as const : null } : {}) };
}

/** Conservative no-reason count: later deaths, newly eligible ants and missing notices remain findings. */
export function unclaimedReasonAssessment(assessment: Pick<CountMarkAssessment, "assessed" | "zeroClaimed">, diagnoses: readonly ZeroClaimedDiagnostic[]) {
  const explained = diagnoses.filter((d) => d.explanationAtAcceptance != null).length;
  const unexplained = Math.max(0, assessment.zeroClaimed - explained);
  return { explained, unexplained, shareOfAssessed: assessment.assessed === 0 ? null : unexplained / assessment.assessed,
    shareOfUnclaimed: assessment.zeroClaimed === 0 ? null : unexplained / assessment.zeroClaimed };
}

export type CountMarkWithdrawalReason = "expired" | "replaced" | "expiry_or_replacement" | "unknown";

/** Only observed disappearance is classified; coincident expiry/replacement is not guessed. */
export function countMarkWithdrawals(before: SimState, after: SimState, events: readonly SimEvent[]): ReadonlyMap<number, CountMarkWithdrawalReason> {
  const live = new Set(after.marks.map((m) => m.id));
  return new Map(before.marks.filter((m) => m.count !== undefined && !live.has(m.id)).map((mark) => {
    const expired = after.tick - mark.laidTick >= before.config.markLifetimeTicks;
    const laid = events.some((event) => event.type === "mark_laid" && event.agentId === mark.agentId);
    return [mark.id, expired ? laid ? "expiry_or_replacement" : "expired" : laid ? "replaced" : "unknown"];
  }));
}

/** Each accepted command, including a re-lay, gets its own 30-second observation. */
export function countMarkTracker(delayTicks: number, onZero?: (probe: ZeroClaimedProbe) => void, trackDispositions = false) {
  const pending: { markId: number | null; acceptedTick: number; due: number; peakClaimed: number; lastClaimedTick: number | null; acceptanceAvailability?: CountMarkAvailability }[] = [];
  let accepted = 0, assessed = 0, zeroClaimed = 0, withdrawn = 0;
  let refused = 0;
  const refusalReasons: Record<string, number> = {};
  const withdrawalReasons: Partial<Record<CountMarkWithdrawalReason, number>> = {};
  return {
    refuse(reason: string): void {
      refused++; refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1;
    },
    accept(markId: number | null, tick: number, acceptanceAvailability?: CountMarkAvailability): void {
      accepted++;
      pending.push({ markId, acceptedTick: tick, due: tick + delayTicks, peakClaimed: 0, lastClaimedTick: null,
        ...(acceptanceAvailability === undefined ? {} : { acceptanceAvailability }) });
    },
    observe(tick: number, liveClaims: ReadonlyMap<number, number>, withdrawals?: ReadonlyMap<number, CountMarkWithdrawalReason>): void {
      for (let i = pending.length - 1; i >= 0; i--) {
        const probe = pending[i]!;
        if (probe.markId === null || !liveClaims.has(probe.markId)) {
          withdrawn++;
          const reason = probe.markId === null ? "unknown" : withdrawals?.get(probe.markId) ?? "unknown";
          withdrawalReasons[reason] = (withdrawalReasons[reason] ?? 0) + 1;
          pending.splice(i, 1);
          continue;
        }
        const claimed = liveClaims.get(probe.markId)!;
        probe.peakClaimed = Math.max(probe.peakClaimed, claimed);
        if (claimed > 0) probe.lastClaimedTick = tick;
        if (tick >= probe.due) {
          assessed++;
          if (claimed === 0) {
            zeroClaimed++;
            onZero?.({ markId: probe.markId, acceptedTick: probe.acceptedTick, assessedTick: tick,
              peakClaimed: probe.peakClaimed, lastClaimedTick: probe.lastClaimedTick,
              ...(probe.acceptanceAvailability === undefined ? {} : { acceptanceAvailability: probe.acceptanceAvailability }) });
          }
          pending.splice(i, 1);
        }
      }
    },
    report(): CountMarkAssessment {
      return { accepted, assessed, zeroClaimed, withdrawn, unfinished: pending.length,
        zeroClaimedShare: assessed === 0 ? null : zeroClaimed / assessed,
        ...(trackDispositions ? { dispositions: { refused, refusalReasons: { ...refusalReasons }, withdrawalReasons: { ...withdrawalReasons } } } : {}) };
    },
  };
}

export interface MinuteTenPopulation {
  readonly live: number;
  readonly offLane: number;
  readonly queens: number;
  /** Available for live-share configs; selected targets are distinct from actual off-lane positions. */
  readonly soldiers?: { readonly free: number; readonly front: number; readonly patches: number; readonly frontOffLane: number };
}

/** Read-only checkpoint: assignment quotas and the ants' actual positions are separate evidence. */
export function balancePopulationAtCheckpoint(state: SimState): [MinuteTenPopulation, MinuteTenPopulation] {
  const assignments = localSoldierAssignments(state);
  return ([0, 1] as const).map((colony) => {
    const live = state.ants.filter((a) => a.colony === colony);
    const free = live.filter((a) => a.caste === "soldier" && a.squad === null && a.claim === undefined);
    const offLane = (ant: (typeof live)[number]): boolean => outsideCentralLane(ant.y, state.config);
    return { live: live.length, offLane: live.filter(offLane).length, queens: activeQueens(state.colonies[colony]).length,
      ...(assignments === null ? {} : { soldiers: { free: free.length,
        front: free.filter((a) => assignments.front.has(a.id)).length,
        patches: free.filter((a) => assignments.patches.has(a.id)).length,
        frontOffLane: free.filter((a) => assignments.front.has(a.id) && offLane(a)).length } }) };
  }) as [MinuteTenPopulation, MinuteTenPopulation];
}

export interface MinuteFivePopulation {
  readonly live: number;
  readonly soldiers: number;
  /** Undefined denominator is reported as null, never zero. */
  readonly soldierShare: number | null;
  readonly foodStore: number;
}

/** Read-only post-step checkpoint; never inferred from eventual match totals. */
export function balanceBroodAtCheckpoint(state: SimState): [MinuteFivePopulation, MinuteFivePopulation] {
  return ([0, 1] as const).map(colony => {
    const ants = state.ants.filter(ant => ant.colony === colony);
    const soldiers = ants.filter(ant => ant.caste === "soldier").length;
    return { live: ants.length, soldiers, soldierShare: ants.length === 0 ? null : soldiers / ants.length,
      foodStore: state.colonies[colony].foodStore };
  }) as [MinuteFivePopulation, MinuteFivePopulation];
}

export interface BalanceRecord {
  readonly mapId?: string;
  readonly mapName?: string;
  readonly seed: number;
  readonly strategies: readonly [BalanceStrategy, BalanceStrategy];
  readonly configDigest: string;
  readonly handicap: ColonyId | null;
  readonly naturalResult: MatchResult;
  readonly naturalEndTick: number;
  /** Cumulative actual food deliveries at the natural end, colony 0 then 1. Absent historical records are unmeasured. */
  readonly deliveries?: readonly [number, number];
  /** Absent in historical records; null when elimination prevented the checkpoint. */
  readonly minuteFivePopulation?: readonly [MinuteFivePopulation, MinuteFivePopulation] | null;
  readonly early: readonly EarlyAssessment[];
  /** Same early-end firing, with subsequent reversals counted only after a strict 30-second lead. */
  readonly earlyHeld?: readonly EarlyAssessment[];
  readonly leadChangesAfterTen: number;
  readonly handicapComebackAfterTen: boolean;
  readonly leadPersistence?: LeadPersistence;
  readonly offLaneAtTen: readonly [number | null, number | null];
  /** A recorded zero-ant denominator is not a missed checkpoint, and still cannot pass the spread criterion. */
  readonly minuteTenPopulation?: readonly [MinuteTenPopulation, MinuteTenPopulation] | null;
  readonly zeroClaimedDiagnostics?: readonly ZeroClaimedDiagnostic[];
  readonly minuteTenStatus: "observed" | "not_applicable_elimination" | "not_reached";
  readonly longestZeroWorkerTicks: readonly [number, number];
  readonly acceptedCommands: readonly [number, number];
  readonly rejectedCommands: readonly [number, number];
  readonly computeSeconds: number;
  readonly countMarkAssessment: CountMarkAssessment;
  /** Absent on historical sweep records, never inferred as zero firings. */
  readonly seatActivity?: SeatActivity;
  /** Absent historical records are unmeasured, never assumed to exercise extra queens. */
  readonly founding?: BalanceFoundingExposure;
}
export interface BalanceSpec {
  readonly seed: number;
  readonly strategies: readonly [BalanceStrategy, BalanceStrategy];
  readonly config: SimConfig;
  readonly earlyCandidates?: readonly EarlyWinRules[];
  /** CLI experiments opt in for every arm; absent preserves historical scripted behaviour. */
  readonly founding?: BalanceFoundingPolicy;
  /** This colony starts with half its original ants; no ongoing boost, income or rule changes. */
  readonly handicap?: ColonyId;
}
export function configDigest(config: SimConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** Full natural trajectory. Disabling the end only leaves all other rules and agent decisions unchanged. */
export function playBalanceMatch(spec: BalanceSpec): BalanceRecord {
  const started = performance.now();
  const { config } = spec;
  const shadowConfig: SimConfig = { ...config, earlyWin: undefined };
  let state = createMatch(spec.seed, shadowConfig);
  if (spec.handicap !== undefined) {
    let n = 0;
    state.ants = state.ants.filter((ant) => ant.colony !== spec.handicap || n++ % 2 === 0);
  }
  if (config.commandIdleTicks !== undefined && config.commandIdleTicks <= Math.max(2, config.commandFloorTicks)) {
    throw new Error("Scripted seats need an idle window longer than the command floor and initial command delay");
  }
  const agents = ([0, 1] as const).flatMap((colony) => [0, 1].map((slot) => ({ id: `side-${colony}-seat-${slot}`, colony,
    pending: null as { input: SimInput; keepAlive: boolean } | null, lastAcceptedTick: null as number | null,
    /** Rules 27: set_brood calls for the seat's own queens, sent with its next command. */
    broods: [] as SimInput[] })));
  const activity = balanceActivityTracker(spec.strategies, config);
  const founding = { policy: spec.founding ?? "off", colonies: ([0, 1] as const).map(colony => ({ colony,
    attempted: 0, accepted: 0, refusals: [] as { tick: number; tileX: number; tileY: number; reason: string }[],
    queenCounts: [{ tick: 0, live: activeQueens(state.colonies[colony]).length }], additionalQueenHatches: 0 })) };
  const ten = 10 * 60 * config.ticksPerSecond;
  const cadence = config.commandIdleTicks === undefined ? 10 * config.ticksPerSecond
    : Math.min(10 * config.ticksPerSecond, Math.max(1, Math.floor((config.commandIdleTicks - config.commandFloorTicks) / 2)));
  const points: TerritoryPoint[] = [];
  const zeroStart: [number | null, number | null] = [null, null];
  const longestZero: [number, number] = [0, 0];
  const offLane: [number | null, number | null] = [null, null];
  let minuteTenPopulation: [MinuteTenPopulation, MinuteTenPopulation] | null = null;
  let minuteFivePopulation: [MinuteFivePopulation, MinuteFivePopulation] | null = null;
  const zeroClaimedDiagnostics: ZeroClaimedDiagnostic[] = [];
  const accepted: [number, number] = [0, 0];
  const rejected: [number, number] = [0, 0];
  const countMarks = countMarkTracker(30 * config.ticksPerSecond, (probe) => {
    zeroClaimedDiagnostics.push(zeroClaimedDiagnostic(state, probe));
  }, config.countMarks?.reportClaimAvailability === true);
  let leader: ColonyId | null = null;
  let lastStrictLeader: ColonyId | null = null;
  let changes = 0;
  let handicapWasBehind = false;
  let comeback = false;
  while (state.result === null) {
    const tick = state.tick;
    const inputs: SimInput[] = [];
    const owners: typeof agents = [];
    const keepAliveInputs = new Set<number>();
    for (const agent of agents) {
      if (tick === 0) { inputs.push({ type: "join", agentId: agent.id, placement: agent.colony }); owners.push(agent); }
      if (agent.pending !== null) {
        if (agent.pending.keepAlive) keepAliveInputs.add(inputs.length);
        inputs.push(agent.pending.input); owners.push(agent); agent.pending = null;
      }
      for (const input of agent.broods) { inputs.push(input); owners.push(agent); }
      agent.broods = [];
      if (tick % cadence === 1 % cadence) { inputs.push({ type: "observe", agentId: agent.id }); owners.push(agent); }
    }
    const before = state;
    activity.beforeStep(before);
    const out = step(state, inputs, defaultAllocator);
    state = out.state;
    activity.afterStep(state);
    const withdrawals = countMarkWithdrawals(before, state, out.events);
    out.results.forEach((result, i) => {
      const input = inputs[i]!;
      const agent = owners[i]!;
      if (input.type === "observe" && result.ok) {
        const command = balanceCommand(spec.strategies[agent.colony], result.view, config);
        // Normal orders already refresh the clock. A count mark may be refused,
        // so near expiry prefer the unchanged order.
        const keepAlive = command === null || command.type === "count_mark"
          ? balanceKeepAlive(result.view, config, agent.lastAcceptedTick, cadence) : null;
        // A founder uses one existing seat, not another command budget. Brood goes to its own
        // queens with set_brood, never on an order; founding preserves the seat's current order.
        const found = founding.policy === "shared" && agent.id === `side-${agent.colony}-seat-0`
          ? balanceFoundingCommand(result.view, config) : null;
        const next = keepAlive ?? found ?? command;
        agent.pending = next === null ? null : { input: next, keepAlive: keepAlive !== null };
        agent.broods = balanceBroodInputs(spec.strategies[agent.colony], result.view, config);
      } else if (input.type !== "join" && input.type !== "set_brood") {
        (result.ok ? accepted : rejected)[agent.colony]++;
        if (result.ok) agent.lastAcceptedTick = tick;
        if (input.type === "found_queen") {
          const exposure = founding.colonies[agent.colony]!;
          exposure.attempted++;
          if (result.ok) exposure.accepted++;
          else exposure.refusals.push({ tick, tileX: input.tileX, tileY: input.tileY, reason: result.error.code });
        }
        if (keepAliveInputs.has(i)) {
          activity.keepAlive(agent.colony, agent.id, tick, result);
        } else if (result.ok && input.type === "count_mark") {
          const mark = state.marks.find((m) => m.agentId === input.agentId && m.verb === input.verb &&
            (input.tileX === undefined || m.tileX === input.tileX) && (input.tileY === undefined || m.tileY === input.tileY));
          const notice = result.view.events.findLast((event) => event.type === "count_mark_accepted");
          countMarks.accept(mark?.id ?? (notice?.type === "count_mark_accepted" ? notice.markId : null), state.tick,
            notice?.type === "count_mark_accepted" ? notice.availability : undefined);
        } else if (!result.ok && input.type === "count_mark") countMarks.refuse(result.error.code);
      }
    });
    for (const exposure of founding.colonies) {
      const queens = activeQueens(state.colonies[exposure.colony]);
      if (exposure.queenCounts.at(-1)!.live !== queens.length) exposure.queenCounts.push({ tick, live: queens.length });
      // step is pure. A timer changing to this event tick proves a hatch at that
      // queen; a newly founded queen's initial timer is not a hatch.
      exposure.additionalQueenHatches += queens.slice(1).filter(queen => queen.foundedTick < tick && queen.lastHatchTick === tick &&
        before.colonies[exposure.colony].queens?.find(prior => prior.id === queen.id)?.lastHatchTick !== tick).length;
    }
    const held = territoryCounts(state);
    points.push({ tick, held });
    const now = held[0] > held[1] ? 0 : held[1] > held[0] ? 1 : null;
    if (now !== null && now !== lastStrictLeader) {
      if (lastStrictLeader !== null && state.tick > ten) changes++;
      lastStrictLeader = now;
    }
    leader = now;
    if (spec.handicap !== undefined) {
      if (leader !== null && leader !== spec.handicap) handicapWasBehind = true;
      if (state.tick > ten && handicapWasBehind && leader === spec.handicap) comeback = true;
    }
    const live: [number, number] = [0, 0], workers: [number, number] = [0, 0], off: [number, number] = [0, 0];
    const claims = new Map(state.marks.filter((m) => m.verb !== undefined).map((m) => [m.id, 0]));
    for (const ant of state.ants) {
      if (ant.claim !== undefined && claims.has(ant.claim)) claims.set(ant.claim, claims.get(ant.claim)! + 1);
      live[ant.colony]++;
      if (ant.caste !== "soldier") workers[ant.colony]++;
      if (outsideCentralLane(ant.y, config)) off[ant.colony]++;
    }
    countMarks.observe(state.tick, claims, withdrawals);
    if (state.tick === 5 * 60 * config.ticksPerSecond) minuteFivePopulation = balanceBroodAtCheckpoint(state);
    if (state.tick === ten) minuteTenPopulation = balancePopulationAtCheckpoint(state);
    for (const colony of [0, 1] as const) {
      if (workers[colony] === 0 && activeQueens(state.colonies[colony]).length > 0) {
        zeroStart[colony] ??= state.tick;
        longestZero[colony] = Math.max(longestZero[colony], state.tick - zeroStart[colony]! + 1);
      } else zeroStart[colony] = null;
      if (state.tick === ten) offLane[colony] = live[colony] === 0 ? null : off[colony] / live[colony];
    }
  }
  const candidates = spec.earlyCandidates ?? (config.earlyWin === undefined ? [] : [config.earlyWin]);
  const assessment = countMarks.report();
  const holdTicks = 30 * config.ticksPerSecond;
  return { seed: spec.seed, strategies: spec.strategies, configDigest: configDigest(config), handicap: spec.handicap ?? null,
    ...(state.terrain === undefined ? {} : { mapId: state.terrain.mapId, mapName: state.terrain.mapName }),
    naturalResult: state.result, naturalEndTick: state.tick, deliveries: [state.stats.delivered[0], state.stats.delivered[1]],
    early: candidates.map((rules) => assessEarlyWin(points, rules)),
    earlyHeld: candidates.map((rules) => assessEarlyWin(points, rules, holdTicks)),
    leadChangesAfterTen: changes, handicapComebackAfterTen: comeback, offLaneAtTen: offLane,
    leadPersistence: leadPersistence(points, ten, holdTicks),
    minuteFivePopulation, minuteTenPopulation, zeroClaimedDiagnostics, founding,
    minuteTenStatus: state.tick >= ten ? "observed" : state.result.reason === "queens_killed" ? "not_applicable_elimination" : "not_reached",
    longestZeroWorkerTicks: longestZero, acceptedCommands: accepted, rejectedCommands: rejected,
    computeSeconds: (performance.now() - started) / 1000, seatActivity: activity.report(), countMarkAssessment: { ...assessment,
      ...(config.countMarks?.reportClaimAvailability ? { noReason: unclaimedReasonAssessment(assessment, zeroClaimedDiagnostics) } : {}) } };
}

export function earlyCandidates(config: SimConfig): EarlyWinRules[] {
  const base = config.earlyWin!;
  return [3000, 4000, 6000].flatMap((territoryRatioPermille) => [180, 240, 300].map((seconds) => ({
    ...base, territoryRatioPermille, holdTicks: seconds * config.ticksPerSecond,
  })));
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function balanceActivitySummary(records: readonly BalanceRecord[]) {
  const measured = records.filter((record) => record.seatActivity !== undefined);
  const floorFirings = measured.flatMap((record) => record.seatActivity!.floorFirings.map((firing) => ({
    seed: record.seed, strategies: record.strategies, handicap: record.handicap, ...firing,
  })));
  return { measuredMatches: measured.length, unmeasuredMatches: records.length - measured.length,
    byStrategy: BALANCE_STRATEGIES.map((strategy) => {
      const matches = measured.filter((record) => record.strategies.includes(strategy));
      return { strategy, measuredMatches: matches.length,
        floorEnabledMatches: matches.filter((record) => record.seatActivity!.floorEnabled).length,
        matchesWithFloorFirings: matches.filter((record) => record.seatActivity!.floorFirings.some((firing) => firing.strategy === strategy)).length,
        floorFirings: floorFirings.filter((firing) => firing.strategy === strategy).length };
    }),
    floorFirings,
    keepAlives: { attempted: measured.reduce((sum, record) => sum + record.seatActivity!.keepAlives.attempted, 0),
      accepted: measured.reduce((sum, record) => sum + record.seatActivity!.keepAlives.accepted, 0),
      refused: measured.reduce((sum, record) => sum + record.seatActivity!.keepAlives.refused, 0),
      refusals: measured.flatMap((record) => record.seatActivity!.keepAlives.refusals.map((refusal) => ({
        seed: record.seed, strategies: record.strategies, handicap: record.handicap, ...refusal,
      }))) },
  };
}

/** The CLI and tests share this rendering so table.md cannot omit the measurement. */
export function balanceActivityTable(activity: ReturnType<typeof balanceActivitySummary>): string[] {
  return ["", "## Scripted seat activity", "",
    `Activity measured in ${activity.measuredMatches} matches; unmeasured: ${activity.unmeasuredMatches}.`,
    "| Strategy | Matches measured | Floor enabled | Matches with floor firings | Floor firings |",
    "|---|---:|---:|---:|---:|",
    ...activity.byStrategy.map((row) => `| ${row.strategy} | ${row.measuredMatches} | ${row.floorEnabledMatches} | ${row.matchesWithFloorFirings} | ${row.floorFirings} |`),
    `Keep-alives: ${activity.keepAlives.attempted} attempted, ${activity.keepAlives.accepted} accepted, ${activity.keepAlives.refused} refused. Refusals are separate from count-mark metrics.`,
    ...activity.floorFirings.map((firing) => `Idle floor fired: strategy ${firing.strategy}, seed ${firing.seed}, colony ${firing.colony}, seat ${firing.agentId}, tick ${firing.tick}, handicap ${firing.handicap ?? "none"}.`),
    ...activity.keepAlives.refusals.map((refusal) => `Keep-alive refused: strategy ${refusal.strategy}, seed ${refusal.seed}, seat ${refusal.agentId}, tick ${refusal.tick}, reason ${refusal.reason}.`), ""];
}

/** Additional hatch experiment figures; does not change any acceptance threshold. */
export function hatchExperimentSummary(records: readonly BalanceRecord[], config: SimConfig) {
  const regular = records.filter(record => record.handicap === null);
  const lengths = regular.map(record => {
    const early = record.early.find(entry => JSON.stringify(entry.rules) === JSON.stringify(config.earlyWin));
    // fireTick is the event tick; naturalEndTick counts completed steps.
    return { seed: record.seed, strategies: record.strategies, mapId: record.mapId,
      effectiveTicks: early?.fireTick == null ? record.naturalEndTick : early.fireTick + 1,
      naturalTicks: record.naturalEndTick };
  });
  const range = (values: number[]) => ({ median: median(values), min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null });
  const colonies = regular.flatMap(record => ([0, 1] as const).map(colony => ({ seed: record.seed,
    mapId: record.mapId, strategies: record.strategies, colony, strategy: record.strategies[colony],
    population: record.minuteFivePopulation?.[colony] ?? null,
    status: record.minuteFivePopulation === undefined ? "unmeasured" : record.minuteFivePopulation !== null ? "observed"
      : record.naturalResult.reason === "queens_killed" && record.naturalEndTick < 5 * 60 * config.ticksPerSecond
        ? "not_applicable_elimination" : "not_reached" })));
  const measured = regular.filter(record => record.founding !== undefined);
  return { checkpointTick: 5 * 60 * config.ticksPerSecond, colonies, lengths,
    founding: { measuredMatches: measured.length, unmeasuredMatches: regular.length - measured.length,
      colonies: measured.flatMap(record => record.founding!.colonies.map(exposure => ({ seed: record.seed, mapId: record.mapId,
        strategies: record.strategies, strategy: record.strategies[exposure.colony], policy: record.founding!.policy, ...exposure }))) },
    effectiveMatchTicks: range(lengths.map(entry => entry.effectiveTicks)),
    naturalMatchTicks: range(lengths.map(entry => entry.naturalTicks)) };
}

/** Acceptance reports never turn missing observations or incomplete cells into passes. */
export function balanceSummary(records: readonly BalanceRecord[], config: SimConfig) {
  const regular = records.filter((r) => r.handicap === null);
  const cells = BALANCE_STRATEGIES.flatMap((row) => BALANCE_STRATEGIES.filter((column) => column !== row).map((column) => {
    const games = regular.filter((r) => r.strategies.includes(row) && r.strategies.includes(column));
    const wins = games.filter((r) => {
      const early = r.early.find((e) => JSON.stringify(e.rules) === JSON.stringify(config.earlyWin));
      const winner = early?.fireTick !== null && early?.fireTick !== undefined ? early.winner : r.naturalResult.winner;
      return winner !== null && r.strategies[winner] === row;
    }).length;
    return { row, column, played: games.length, wins };
  }));
  const complete = cells.every((cell) => cell.played === 8);
  const dominatedBy = BALANCE_STRATEGIES.filter((row) => cells.filter((cell) => cell.row === row).every((cell) => cell.played === 8 && cell.wins > 6));
  const ten = 10 * 60 * config.ticksPerSecond;
  const earlyElimination = (r: BalanceRecord): boolean => r.naturalResult.reason === "queens_killed" && r.naturalEndTick < ten;
  const applicableOffLane = regular.filter((r) => !earlyElimination(r));
  const offLaneNotApplicable = regular.filter(earlyElimination).length;
  const offLaneMissing = applicableOffLane.filter((r) => r.minuteTenStatus !== "observed" || r.minuteTenPopulation == null ||
    r.offLaneAtTen.some((v, colony) => v === null && r.minuteTenPopulation![colony]!.live >= 50)).length;
  const zeroAntCheckpoints = applicableOffLane.flatMap((r) => ([0, 1] as const)
    .filter((colony) => r.minuteTenPopulation?.[colony]?.live === 0)
    .map((colony) => ({ seed: r.seed, strategies: r.strategies, colony, ...r.minuteTenPopulation![colony] })));
  const smallColonyCheckpoints = applicableOffLane.flatMap((r) => ([0, 1] as const)
    .filter((colony) => r.minuteTenPopulation?.[colony] !== undefined && r.minuteTenPopulation[colony]!.live < 50)
    .map((colony) => ({ seed: r.seed, strategies: r.strategies, colony, population: r.minuteTenPopulation![colony]! })));
  const fails = (r: BalanceRecord, colony: ColonyId): boolean =>
    (r.minuteTenPopulation?.[colony] === undefined || r.minuteTenPopulation[colony]!.live >= 50) &&
    (r.offLaneAtTen[colony] === null || r.offLaneAtTen[colony]! < .25);
  const offLaneFailingMatches = applicableOffLane.filter((r) => ([0, 1] as const).some((colony) => fails(r, colony))).length;
  const offLaneByColony = applicableOffLane.flatMap((r) => ([0, 1] as const)
    .filter((colony) => fails(r, colony))
    .map((colony) => ({ seed: r.seed, strategies: r.strategies, colony, share: r.offLaneAtTen[colony],
      checkpoint: r.minuteTenPopulation?.[colony] ?? null })));
  const offLaneFailures = offLaneByColony.length;
  const eliminationMatches = records.filter((r) => r.naturalResult.reason === "queens_killed").map((r) => ({
    seed: r.seed, strategies: r.strategies, handicap: r.handicap, winner: r.naturalResult.winner,
    endTick: r.naturalResult.tick, completedTicks: r.naturalEndTick, endSeconds: r.naturalEndTick / config.ticksPerSecond,
    minuteTenStatus: earlyElimination(r) ? "not_applicable_elimination" : r.minuteTenStatus,
  }));
  const heavyZero = records.flatMap((r) => ([0, 1] as const).filter((c) => r.strategies[c] === "soldier-heavy").map((c) => r.longestZeroWorkerTicks[c] / config.ticksPerSecond));
  const medianHeavyZeroSeconds = median(heavyZero);
  const earlyOld = records.map((r) => r.early.find((e) => JSON.stringify(e.rules) === JSON.stringify(config.earlyWin))).filter((e): e is EarlyAssessment => e !== undefined);
  const early = records.map((r) => r.earlyHeld?.find((e) => JSON.stringify(e.rules) === JSON.stringify(config.earlyWin))).filter((e): e is EarlyAssessment => e !== undefined);
  const fired = early.filter((e) => e.fireTick !== null);
  const comebacksOld = records.filter((r) => r.handicap !== null && r.handicapComebackAfterTen).length;
  const lateChangesOld = regular.reduce((n, r) => n + r.leadChangesAfterTen, 0);
  const holdTicks = 30 * config.ticksPerSecond;
  const persistentRecords = records.filter((r) => r.leadPersistence?.minHoldTicks === holdTicks);
  const measured = persistentRecords.length === records.length;
  const lateChanges = measured ? persistentRecords.filter((r) => r.handicap === null).reduce((sum, r) => sum + r.leadPersistence!.changesHeld, 0) : null;
  const comebacks = measured ? persistentRecords.filter((r) => r.handicap !== null && r.leadPersistence!.longestRegainedLeadTicks[r.handicap] >= holdTicks).length : null;
  const leadMeasurement = {
    minHoldSeconds: 30, measuredMatches: persistentRecords.length,
    lopsided: persistentRecords.filter((r) => r.handicap !== null).map((r) => ({ seed: r.seed, strategies: r.strategies,
      handicap: r.handicap, longestRegainedLeadSeconds: r.leadPersistence!.longestRegainedLeadTicks[r.handicap!] / config.ticksPerSecond,
      held: r.leadPersistence!.longestRegainedLeadTicks[r.handicap!] >= holdTicks })),
  };
  const marks = records.reduce((total, record) => ({
    accepted: total.accepted + record.countMarkAssessment.accepted,
    assessed: total.assessed + record.countMarkAssessment.assessed,
    zeroClaimed: total.zeroClaimed + record.countMarkAssessment.zeroClaimed,
    withdrawn: total.withdrawn + record.countMarkAssessment.withdrawn,
    unfinished: total.unfinished + record.countMarkAssessment.unfinished,
  }), { accepted: 0, assessed: 0, zeroClaimed: 0, withdrawn: 0, unfinished: 0 });
  const dispositions: CountMarkDispositions | undefined = records.every((r) => r.countMarkAssessment.dispositions !== undefined) && config.countMarks?.reportClaimAvailability
    ? records.reduce((total, record) => {
      const d = record.countMarkAssessment.dispositions!;
      const addReasons = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> => {
        const sum = { ...a }; for (const [key, value] of Object.entries(b)) sum[key] = (sum[key] ?? 0) + value; return sum;
      };
      return { refused: total.refused + d.refused,
        refusalReasons: addReasons(total.refusalReasons, d.refusalReasons), withdrawalReasons: addReasons(total.withdrawalReasons, d.withdrawalReasons) };
    }, { refused: 0, refusalReasons: {}, withdrawalReasons: {} }) : undefined;
  const diagnoses = records.flatMap((r) => r.zeroClaimedDiagnostics ?? []);
  const countMarkAssessment = { ...marks, zeroClaimedShare: marks.assessed === 0 ? null : marks.zeroClaimed / marks.assessed,
    ...(dispositions === undefined ? {} : { dispositions }),
    ...(config.countMarks?.reportClaimAvailability ? { noReason: unclaimedReasonAssessment(marks, diagnoses) } : {}) };
  const availability = ["no_live_ants", "no_free_ants", "eligible_after_step"] as const;
  const earlyCandidateSummary = (config.earlyWin === undefined ? [] : earlyCandidates(config)).map((rules) => {
    const old = records.flatMap((r) => r.early.filter((e) => JSON.stringify(e.rules) === JSON.stringify(rules)));
    const assessments = records.flatMap((r) => (r.earlyHeld ?? []).filter((e) => JSON.stringify(e.rules) === JSON.stringify(rules)));
    return { rules, assessed: assessments.length, fired: assessments.filter((e) => e.fireTick !== null).length,
      laterLeadChanges: assessments.filter((e) => e.fireTick !== null && e.laterLeadChange).length,
      oldLaterLeadChanges: old.filter((e) => e.fireTick !== null && e.laterLeadChange).length };
  });
  return { countMarkAssessment, seatActivity: balanceActivitySummary(records), earlyCandidateSummary, leadMeasurement, offLaneByColony,
    smallColonyCount: smallColonyCheckpoints.length, smallColonyCheckpoints, lateChangesOld, comebacksOld,
    earlyOldAssessed: earlyOld.length, earlyOldFired: earlyOld.filter((e) => e.fireTick !== null).length,
    earlyOldLaterLeadChanges: earlyOld.filter((e) => e.fireTick !== null && e.laterLeadChange).length,
    zeroClaimedDiagnosed: diagnoses.length,
    zeroClaimedPreviouslyClaimed: diagnoses.filter((d) => d.peakClaimed > 0).length,
    zeroClaimedAvailability: Object.fromEntries(availability.map((reason) => [reason, diagnoses.filter((d) => d.availability === reason).length])),

    silentCountMarkFinding: config.countMarks?.reportClaimAvailability
      ? countMarkAssessment.noReason!.unexplained > 0 ? `${countMarkAssessment.noReason!.unexplained} of ${marks.assessed} assessed accepted marks were still empty without a matching acceptance-time explanation; later deaths, newly eligible ants and missing notices remain findings.` : null
      : marks.zeroClaimed > 0 ? `${marks.zeroClaimed} of ${marks.assessed} assessed accepted count marks still had zero claimed ants after 30 seconds; accepted marks can silently do nothing.` : null,
    hatchExperiment: hatchExperimentSummary(records, config),
    strategyWins: BALANCE_STRATEGIES.map(strategy => {
      const pairings = cells.filter(cell => cell.row === strategy);
      const wins = pairings.reduce((sum, cell) => sum + cell.wins, 0);
      const played = pairings.reduce((sum, cell) => sum + cell.played, 0);
      return { strategy, wins, played, winShare: played === 0 ? null : wins / played };
    }),
    complete, cells, dominatedBy, lateChanges, offLaneMissing, zeroAntCheckpoints, offLaneFailures, offLaneFailingMatches, offLaneNotApplicable, eliminationMatches,
    medianHeavyZeroSeconds, zeroWorkerByMatch: records.map((r) => ({ seed: r.seed, strategies: r.strategies, handicap: r.handicap, seconds: r.longestZeroWorkerTicks.map((v) => v / config.ticksPerSecond) })),
    lopsidedMatches: records.filter((r) => r.handicap !== null).length, comebacks,
    earlyAssessed: early.length, earlyFired: fired.length, earlyFireRate: early.length ? fired.length / early.length : null,
    earlyLaterLeadChanges: fired.filter((e) => e.laterLeadChange).length,
    accepted: complete && dominatedBy.length === 0 && lateChanges !== null && lateChanges > 0 && offLaneFailures === 0 && offLaneMissing === 0 && comebacks !== null && comebacks > 0 &&
      medianHeavyZeroSeconds !== null && medianHeavyZeroSeconds <= 180 && early.length === records.length && fired.every((e) => !e.laterLeadChange),
  };
}

export const DEFAULT_BALANCE_CONFIG = rulesConfig("redesign");
