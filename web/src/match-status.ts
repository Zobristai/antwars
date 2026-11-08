import { discoveryRandom } from "./clock.ts";
import { watchMatchDirectory } from "./match-directory.ts";
import type { PublicMatchCatalog } from "../../src/live/match-catalog.ts";

export type MatchStatus = PublicMatchCatalog["matches"];

/** Only confirmed public catalog responses change selection; failure is never fabricated idleness. */
export function watchMatchStatus(onStatus: (matches: MatchStatus) => void, request: typeof fetch = fetch): () => void {
  return watchMatchDirectory(catalog => onStatus(catalog.matches), () => {}, request);
}

/** Choose once, not on every poll; explicit lobby/invite viewers never use random discovery. */
export function randomMatch(matches: MatchStatus, random: () => number = discoveryRandom): MatchStatus[number] | null {
  return matches.length ? matches[Math.floor(random() * matches.length)]! : null;
}
