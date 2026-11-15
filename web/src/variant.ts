/** Rule numbers come from simulation config. Streamed HP identifies redacted
 * redesign boards; named comparisons and historical boards keep their own rules.
 */
import type { StreamQueen, StreamRules28Figures, StreamSetup } from "../../src/live/format.ts";
import { QUEEN_HP_RULES, RULES_NAMES, rulesConfig, type CountMarkRules, type LocalAntRules, type QueenHpRules, type QueenRules, type SimConfig } from "../../src/sim/config.ts";

type RuleBoard = {
  readonly setup: { readonly rules?: string };
  readonly queens?: readonly Pick<StreamQueen, "hp">[];
};

/** Public redesign streams withhold the name but retain HP. Unnamed historical
 * boards without HP keep PUBLIC_CONFIG; unknown comparison names stay unknown.
 */
function variant(board: RuleBoard): SimConfig | null {
  const rules = board.setup.rules === undefined && boardQueenHp(board) !== undefined ? "redesign" : board.setup.rules;
  return rules === undefined || (RULES_NAMES as readonly string[]).includes(rules) ? rulesConfig(rules) : null;
}

/**
 * The redesign figures the renderer needs beyond the board's streamed hatch. A rules-28 match streams its own with its
 * setup marker (stream version 27); a board without the marker was recorded under rules 27 or earlier, whose figures
 * the stream never carried and are frozen here.
 */
export interface RedesignFigures { readonly workerCost: number; readonly soldierCost: number; readonly queenHp: number }
export const RULES27_REDESIGN_FIGURES: RedesignFigures = { workerCost: 3, soldierCost: 6, queenHp: 40_000 };
/** Under rules 27 a redesign soldier took this many of the board's streamed worker hatch intervals. */
export const RULES27_SOLDIER_INTERVAL_MULTIPLIER = 2;
type GenerationBoard = { readonly setup?: { readonly rules?: string } & Pick<StreamSetup, "rules28" | "rules28Figures"> };
function streamedFigures(board: GenerationBoard): StreamRules28Figures | undefined {
  return board.setup?.rules28 === true ? board.setup.rules28Figures : undefined;
}
/** The figures of the board's rules generation: a marked board's own streamed figures, otherwise rules 27's. */
export function redesignFigures(board: GenerationBoard): RedesignFigures {
  const f = streamedFigures(board);
  return f === undefined ? RULES27_REDESIGN_FIGURES : { workerCost: f.workerCost, soldierCost: f.soldierCost, queenHp: f.queenHp };
}
/** A redesign soldier's hatch interval in ticks: a marked board's streamed one, otherwise rules 27's multiple of the worker's. */
export function redesignSoldierIntervalTicks(board: GenerationBoard, workerIntervalTicks: number): number {
  return streamedFigures(board)?.soldierIntervalTicks ?? workerIntervalTicks * RULES27_SOLDIER_INTERVAL_MULTIPLIER;
}

/** Streamed HP selects HP mode, even at zero; historical queens without HP use overrun. Full HP is the board's generation's. */
export function boardQueenHp(board: GenerationBoard & { readonly queens?: readonly Pick<StreamQueen, "hp">[] }): QueenHpRules | undefined {
  if (!board.queens?.some((queen) => queen.hp !== undefined)) return undefined;
  const hp = redesignFigures(board).queenHp;
  return hp === QUEEN_HP_RULES.hp ? QUEEN_HP_RULES : { ...QUEEN_HP_RULES, hp };
}

/** The queen-founding rules a board plays (the public rules found queens); undefined where each colony keeps its one queen. */
export function boardQueenFounding(board: RuleBoard): QueenRules | undefined {
  return variant(board)?.queenFounding;
}

/** The count-mark rules a board plays; undefined where marks steer squads only. */
export function boardCountMarks(board: RuleBoard): CountMarkRules | undefined {
  return variant(board)?.countMarks;
}

/** The autonomous free-ant rules a board plays; undefined where a house bot runs the free ants. */
export function boardLocalAnts(board: RuleBoard): LocalAntRules | undefined {
  return variant(board)?.localAnts;
}

/**
 * The patrol link range a board plays, in its rules' own tiles (before grid scale): a public redesign board's is read
 * from its streamed HP like its other rules; undefined where its rules have no PATROL marks or are unknown.
 */
export function boardPatrolLinkTiles(board: RuleBoard): number | undefined {
  return variant(board)?.patrolLinkTiles;
}
