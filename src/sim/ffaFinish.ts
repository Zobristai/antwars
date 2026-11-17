import type { RankedColony } from "./elimination.js";
import type { MatchResult } from "./types.js";

/** Recorded placement policy, not a change to the match's declared winner. */
export interface FfaFinish {
  readonly version: 1;
  /** First through fourth; always a permutation of the four colony ids. */
  readonly order: readonly [number, number, number, number];
  readonly territoryWinnerFirst: boolean;
  /** False for abandonment, a draw, or scores which need an unapproved tie-break. */
  readonly rateable: boolean;
}

/** Validate persisted/network input before using it, including records produced by older servers. */
export function parseFfaFinish(value: unknown): FfaFinish {
  if (typeof value !== "object" || value === null) throw new Error("invalid Free-for-all finish");
  const f = value as Partial<FfaFinish>;
  if (f.version !== 1 || typeof f.territoryWinnerFirst !== "boolean" || typeof f.rateable !== "boolean" ||
      !Array.isArray(f.order) || f.order.length !== 4 || new Set(f.order).size !== 4 ||
      f.order.some(c => !Number.isInteger(c) || c < 0 || c > 3)) throw new Error("invalid Free-for-all finish");
  return { version: 1, order: [...f.order] as [number, number, number, number], territoryWinnerFirst: f.territoryWinnerFirst, rateable: f.rateable };
}

/** The existing ranker supplies deterministic fallback order; it does not authorize rating an exact score tie. */
export function ffaFinish(ranked: readonly RankedColony[], result: MatchResult, territoryWinnerFirst: boolean): FfaFinish {
  if (ranked.length !== 4) throw new Error("a Free-for-all finish needs four colonies");
  const first = territoryWinnerFirst && result.reason === "sustained_territory" ? result.winner : null;
  const ordered = first === null ? [...ranked] : [...ranked.filter(r => r.colony === first), ...ranked.filter(r => r.colony !== first)];
  const scores = first === null ? ordered : ordered.filter(r => r.colony !== first);
  const ambiguous = scores.some((a, i) => scores.slice(i + 1).some(b => a.eliminatedTick === b.eliminatedTick &&
    (a.scores.queenKills ?? 0) === (b.scores.queenKills ?? 0) && a.scores.kills === b.scores.kills));
  return parseFfaFinish({ version: 1, order: ordered.map(r => r.colony), territoryWinnerFirst,
    rateable: !ambiguous && result.winner !== null && result.reason !== "abandoned" });
}
