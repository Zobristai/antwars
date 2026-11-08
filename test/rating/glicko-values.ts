/**
 * The first rated result between two unrated players, 1500 ± 350 each, by Glicko-1
 *: the winner's and the loser's rating and RD, exactly as the store writes
 * them. test/rating/glicko.test.ts derives both from the formula written out independently.
 */
export const FIRST_WIN = { rating: 1662.2120026057648, rd: 290.2305060910912 } as const;
export const FIRST_LOSS = { rating: 1337.7879973942352, rd: 290.2305060910912 } as const;
