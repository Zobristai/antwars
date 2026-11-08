import { isRankedMode, type RankedMode } from "../rating/ratings.js";

/** Immutable match admission policy, independent of the slot's next occupant. */
export interface MatchAccess {
  readonly lobbyId: string;
  readonly visibility: "public" | "private";
  readonly rated: boolean;
  /** Absent on legacy records and unrated lobbies; never infer house mode from ownership. */
  readonly mode?: RankedMode | null;
}

export const RATED_DELAY_SECONDS = 300;
export const UNRATED_DELAY_SECONDS = 60;

/** Capture at match creation, never by looking up whichever lobby holds a slot now. */
export function captureMatchAccess(value: MatchAccess): Readonly<MatchAccess> {
  if (!value.lobbyId || !["public", "private"].includes(value.visibility) || typeof value.rated !== "boolean" ||
    (value.mode != null && !isRankedMode(value.mode))) {
    throw new Error("Invalid spectator match access policy");
  }
  return Object.freeze({ lobbyId: value.lobbyId, visibility: value.visibility, rated: value.rated,
    ...(value.mode == null ? {} : { mode: value.mode }) });
}

export function isHouseMatch(match: MatchAccess): boolean {
  return match.mode === "house-1v1" || match.mode === "house-2v2" || match.mode === "house-3v3" || match.mode === "house-4v4";
}

export function spectatorDelaySeconds(match: MatchAccess): number {
  return isHouseMatch(match) ? 0 : match.rated ? RATED_DELAY_SECONDS : UNRATED_DELAY_SECONDS;
}

/** Discovery and legacy current-match selection must never infer public from missing metadata. */
export function isPublicMatch(match: MatchAccess | null | undefined): boolean {
  return match?.visibility === "public";
}

export type WatchAdmission = "allowed" | "refused" | "unavailable";
export type CurrentInvite = (lobbyId: string, token: string) => Promise<boolean>;

/**
 * Call once for EACH new stream or media request. An allowed live stream keeps
 * its attachment until closed; there is no token cache and no seat-key mutation.
 * An unavailable store is not permission and is not a fabricated bad token.
 */
export async function admitMatchWatch(
  match: MatchAccess | null | undefined,
  token: string | undefined,
  currentInvite: CurrentInvite,
): Promise<WatchAdmission> {
  if (!match) return "refused";
  if (match.visibility === "public") return "allowed";
  if (match.visibility !== "private" || !token) return "refused";
  try {
    return await currentInvite(match.lobbyId, token) ? "allowed" : "refused";
  } catch {
    return "unavailable";
  }
}
