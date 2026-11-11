import type { RankedMode, Rating } from "../rating/ratings.js";

/**
 * The rating a seat shows before and during its match, wherever it is shown (the match stream, Live now, Waiting): a house
 * challenge's held seat shows its handle's Model Index 1v1 rating, and none before the Index has rated it; every other seat
 * shows its rating in the match's mode, a modeless match's (a challenge's builder, a player-made lobby) in public 1v1.
 */
export async function seatRating(readRating: (identityId: string, mode: RankedMode) => Promise<Rating>,
  identityId: string, mode: RankedMode | null, heldHouseSeat: boolean): Promise<Rating | null> {
  const read = await readRating(identityId, heldHouseSeat ? "house-1v1" : mode ?? "1v1");
  return heldHouseSeat && read.ratedMatches === 0 ? null : read;
}
