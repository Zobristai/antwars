/**
 * Glicko-1 (Mark Glickman, "Parameter estimation in large dynamic paired comparison
 * experiments", 1999; the worked example in "The Glicko system", 1995), the rating
 * system chess.com uses: every player has a rating and a rating deviation
 * (RD) that shrinks as results arrive and grows again while the player is inactive.
 *
 * Antwars applies each rated match as its own rating period, in the order it was
 * rated. Before a match a player's RD grows by its time since that player's previous
 * rated match in the mode: RD = min(sqrt(RD^2 + C^2 * days), MAX_RD). C is chosen so
 * that an RD of 50 returns to the starting 350 after 365 days without a rated match.
 */

export const INITIAL_RD = 350;
export const MAX_RD = 350;
/** Per day: sqrt((350^2 - 50^2) / 365). */
export const RD_GROWTH_PER_DAY = Math.sqrt((350 ** 2 - 50 ** 2) / 365);
export const DAY_MS = 86_400_000;

const Q = Math.LN10 / 400;

export interface GlickoRating {
  readonly rating: number;
  readonly rd: number;
}

export interface GlickoOpponent extends GlickoRating {
  /** 1 win, 0.5 draw, 0 loss, for the player being rated. */
  readonly score: number;
}

/** The RD a player carries into a match after `elapsedMs` without a rated match; no growth for a missing or negative gap. */
export function inflatedRd(rd: number, elapsedMs: number | null): number {
  if (elapsedMs === null || !(elapsedMs > 0)) return Math.min(rd, MAX_RD);
  return Math.min(Math.sqrt(rd * rd + RD_GROWTH_PER_DAY * RD_GROWTH_PER_DAY * (elapsedMs / DAY_MS)), MAX_RD);
}

const g = (rd: number) => 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));

/** Expected score of `rating` against an opponent rated `opponent` with deviation `opponentRd`. */
export const glickoExpected = (rating: number, opponent: number, opponentRd: number) => 1 / (1 + 10 ** (-g(opponentRd) * (rating - opponent) / 400));

/** One rating period's update for one player against every opponent it met in that period. */
export function glickoUpdate(player: GlickoRating, opponents: readonly GlickoOpponent[]): GlickoRating {
  if (opponents.length === 0) return player;
  let dInverse = 0;
  let sum = 0;
  for (const opponent of opponents) {
    const gj = g(opponent.rd);
    const expected = glickoExpected(player.rating, opponent.rating, opponent.rd);
    dInverse += Q * Q * gj * gj * expected * (1 - expected);
    sum += gj * (opponent.score - expected);
  }
  const precision = 1 / (player.rd * player.rd) + dInverse;
  return { rating: player.rating + (Q / precision) * sum, rd: Math.sqrt(1 / precision) };
}

/** A team as one opponent: its mean rating, and the root mean square of its RDs. */
export function teamAsOpponent(members: readonly GlickoRating[]): GlickoRating {
  const n = members.length;
  return {
    rating: members.reduce((total, member) => total + member.rating, 0) / n,
    rd: Math.sqrt(members.reduce((total, member) => total + member.rd * member.rd, 0) / n),
  };
}
