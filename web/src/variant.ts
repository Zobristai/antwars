/** Rule numbers come from simulation config. Streamed HP identifies redacted
 * redesign boards; named comparisons and historical boards keep their own rules.
 */
import type { StreamQueen } from "../../src/live/format.ts";
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

/** Streamed HP selects HP mode, even at zero; historical queens without HP use overrun. */
export function boardQueenHp(board: { readonly queens?: readonly Pick<StreamQueen, "hp">[] }): QueenHpRules | undefined {
  return board.queens?.some((queen) => queen.hp !== undefined) ? QUEEN_HP_RULES : undefined;
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
