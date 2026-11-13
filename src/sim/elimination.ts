/**
 * Four-colony match ends. A colony whose last queen dies, or whose seats the server finds idle, leaves the
 * match on that tick: its ants are removed (no deaths, no corpses, no kill credit), its queens retire, its
 * squads are released and its tiles turn neutral. The last colony with a queen wins; a colony holding more
 * than half of all owned territory for the hold time wins; at time-up the colonies are ranked. Two-colony
 * matches never come here (src/sim/territory.ts keeps their rules).
 */
import { clearLostQueenSpawn } from "./map.js";
import { physicalTileArea } from "./gridScale.js";
import type { ServerTerminal } from "./step.js";
import type { ColonyId, ColonyScores, ColonyState, EliminationReason, MatchResult, SimState } from "./types.js";

/** Each colony's held physical original-tile area, by colony id. */
function territoryByColony(state: SimState): number[] {
  const counts = state.colonies.map(() => 0);
  for (const owner of state.owner) if (owner !== -1) counts[owner]! += 1;
  const area = physicalTileArea(state.config);
  return counts.map(count => count / area);
}

/** Every colony's current time-up scores, by colony id. */
export function colonyScores(state: SimState): ColonyScores[] {
  const territory = territoryByColony(state), ants = state.colonies.map(() => 0);
  for (const ant of state.ants) ants[ant.colony]! += 1;
  return state.colonies.map((colony, id) => ({ kills: colony.kills ?? 0, territory: territory[id]!, ants: ants[id]!, delivered: state.stats.delivered[id]! }));
}

type Step = MatchResult["decidedBy"];

/** The four-colony time-up order, in every four-colony config: kills, then territory, living ants, food delivered.
 * The config's adjudication field only governs two-colony scoring (src/sim/territory.ts). */
const SCORE_STEPS: readonly [Step, (s: ColonyScores) => number][] = [
  ["kills", s => s.kills], ["territory", s => s.territory], ["ants_alive", s => s.ants], ["food_delivered", s => s.delivered]];

/** The step that first separates a from b (negative: a ranks higher), or null when they tie through every step. */
function separate(_state: SimState, a: ColonyScores, b: ColonyScores): { step: Step; order: number } | null {
  for (const [step, value] of SCORE_STEPS) if (value(a) !== value(b)) return { step, order: value(b) - value(a) };
  return null;
}

export interface RankedColony {
  readonly colony: ColonyId;
  readonly scores: ColonyScores;
  /** Absent for a surviving colony. */
  readonly eliminatedTick?: number;
}

/**
 * Every colony in time-up order. Surviving colonies rank by their current scores; eliminated colonies rank below
 * every survivor, the latest eliminated highest, and colonies eliminated on the same tick by their scores just
 * before that tick's removal. Colonies tied through every step keep colony order.
 */
export function rankColonies(state: SimState): RankedColony[] {
  const current = colonyScores(state);
  const ranked = state.colonies.map((colony, id): RankedColony => colony.eliminated === undefined
    ? { colony: id, scores: current[id]! } : { colony: id, scores: colony.eliminated.scores, eliminatedTick: colony.eliminated.tick });
  return ranked.sort((a, b) => {
    if ((a.eliminatedTick === undefined) !== (b.eliminatedTick === undefined)) return a.eliminatedTick === undefined ? -1 : 1;
    if (a.eliminatedTick !== b.eliminatedTick) return b.eliminatedTick! - a.eliminatedTick!;
    return separate(state, a.scores, b.scores)?.order ?? a.colony - b.colony;
  });
}

/** The winner of a ranked group of at least two colonies: its first colony, or a draw when the first two tie through every step. */
function decide(state: SimState, group: readonly RankedColony[], reason: MatchResult["reason"], tick: number): MatchResult {
  const [first, second] = group;
  if (first === undefined || second === undefined) throw new Error(`tick ${tick}: a ranked decision needs two colonies`);
  const split = separate(state, first.scores, second.scores);
  return split === null ? { winner: null, reason, decidedBy: "draw", tick } : { winner: first.colony, reason, decidedBy: split.step, tick };
}

/** Remove a colony from the match on this tick, after snapshotting its scores. */
function eliminate(state: SimState, colony: ColonyState, tick: number, reason: EliminationReason, scores: ColonyScores): void {
  colony.eliminated = { tick, reason, scores };
  // Removed, not killed: no death count, corpse food or kill credit.
  state.ants = state.ants.filter(ant => ant.colony !== colony.id);
  for (const queen of colony.queens ?? []) {
    if (queen.lostTick !== null) continue;
    queen.lostTick = tick;
    clearLostQueenSpawn(state, colony.id, queen);
  }
  for (const agent of state.agents) if (agent.colony === colony.id) agent.squad = [];
  for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === colony.id) state.owner[i] = -1;
}

/** More than half of all owned territory, from the opening tick and floor of the territory win, held for its hold time. */
function majorityHold(state: SimState, tick: number): MatchResult | null {
  const rules = state.config.earlyWin;
  if (rules === undefined) return null;
  const held = territoryByColony(state), owned = held.reduce((sum, value) => sum + value, 0);
  const leader = held.findIndex(value => value * 2 > owned);
  const qualifies = tick >= rules.minTick && leader !== -1 && held[leader]! >= rules.minHeldTiles;
  const previous = state.earlyWinProgress;
  const progress = qualifies ? { leader, ticks: previous?.leader === leader ? previous.ticks + 1 : 1 } : { leader: null, ticks: 0 };
  state.earlyWinProgress = progress;
  if (!qualifies || progress.ticks < rules.holdTicks) return null;
  return { winner: leader, reason: "sustained_territory", decidedBy: "territory", tick };
}

/**
 * Phase 10 of a four-colony tick. Colonies whose last queen died this tick, and colonies the server ends idle,
 * leave the match; then the last colony standing wins, or the majority hold, or time-up ranks the colonies.
 * A server abandonment still abandons.
 */
export function fourColonyEnd(state: SimState, tick: number, stopNow: ServerTerminal): MatchResult | null {
  if (stopNow === "abandoned") return { winner: null, reason: "abandoned", decidedBy: "draw", tick };
  const idle = typeof stopNow === "object" ? stopNow.idle : [];
  // A colony whose last queen died this tick leaves for that, even if the server also found it idle.
  const leaving = state.colonies.filter(colony => colony.eliminated === undefined).flatMap((colony): { colony: ColonyState; reason: EliminationReason }[] => {
    if ((colony.queens ?? []).every(queen => queen.lostTick !== null)) return [{ colony, reason: "queens_killed" }];
    return idle.includes(colony.id) ? [{ colony, reason: "idle" }] : [];
  });
  if (leaving.length > 0) {
    // Every leaving colony's scores as they stood before any of this tick's removals.
    const scores = colonyScores(state);
    for (const { colony, reason } of leaving) eliminate(state, colony, tick, reason, scores[colony.id]!);
    const remaining = state.colonies.filter(colony => colony.eliminated === undefined);
    if (remaining.length <= 1) {
      const reason = leaving.every(leave => leave.reason === "idle") ? "idle" : "queens_killed";
      if (remaining.length === 1) return { winner: remaining[0]!.id, reason, decidedBy: reason, tick };
      return decide(state, rankColonies(state), reason, tick);
    }
  }
  const hold = majorityHold(state, tick);
  if (hold !== null) return hold;
  if (stopNow === true || tick + 1 >= state.config.matchTicks) {
    return decide(state, rankColonies(state).filter(ranked => ranked.eliminatedTick === undefined), "time_up", tick);
  }
  return null;
}
