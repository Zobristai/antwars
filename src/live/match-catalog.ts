import { isHouseMatch, isPublicMatch, spectatorDelaySeconds, type MatchAccess } from "./match-access.js";
import { harnessPhaseAt, type HarnessPhase } from "../rating/harnessPhase.js";

/** Match identity is its lobby, not the slot or whichever sequence runs there next. */
export interface CatalogMatch extends MatchAccess {
  readonly startedAt: number;
  /** True only after the delayed final frame has been released. */
  readonly playbackFinished: boolean;
}

/** Structural subset of a shared-store lobby. Extra store fields never reach discovery. */
export interface CatalogLobby {
  readonly id: string;
  readonly kind: "public" | "private";
  readonly size: number;
  readonly state: string;
  readonly colonies: readonly (readonly { readonly displayName: string }[])[];
}

/**
 * One seated player as the Matches page's Live now row names it: the stream's seat display name, the model label the
 * seat self-reported when it joined (null, or absent from a caller, before it joins or where it reported none), and the player's rating, RD and
 * rated-match count in the match's ranked mode; the three are null for an unrated match.
 */
export type PublicSeat = { readonly displayName: string; readonly modelLabel?: string | null } & (
  | { readonly rating: number; readonly rd: number; readonly ratedMatches: number }
  | { readonly rating: null; readonly rd: null; readonly ratedMatches: null });
/** A live match's seats by colony. */
export type PublicColonies = readonly [readonly PublicSeat[], readonly PublicSeat[]];

/** What the HUD's match directory reads of a listed match (web/src/match-directory.ts). */
export interface PublicMatchEntry {
  readonly lobbyId: string;
  readonly startedAt: number;
  readonly rated: boolean;
  readonly delaySeconds: number;
}
/** A listed match as the catalog sends it: with its players, which the Matches page shows. */
export interface PublicLiveMatch extends PublicMatchEntry {
  /** Both empty when the match's lobby could not be read. */
  readonly colonies: PublicColonies;
  /** Present only on a Model Index match: its harness phase by its start (src/rating/harnessPhase.ts). */
  readonly harnessPhase?: HarnessPhase;
}
export interface PublicLobbyEntry {
  readonly id: string;
  readonly size: number;
  readonly state: "open" | "waiting";
  readonly colonies: readonly (readonly string[])[];
}
export interface PublicMatchCatalog {
  readonly matches: readonly PublicMatchEntry[];
  readonly lobbies: readonly PublicLobbyEntry[];
}
/** The catalog as /watch/catalog sends it: every listed match with its players. */
export interface PublicLiveCatalog extends PublicMatchCatalog {
  readonly matches: readonly PublicLiveMatch[];
}

/** Authenticated private/public status consumed by the lobby controls, without game-state disclosure. */
export interface MatchWatchStatus {
  readonly lobbyId: string;
  readonly started: boolean;
  readonly playbackFinished: boolean;
  readonly delaySeconds: number;
}

/** Phase comes from the retained feed, never from the lobby countdown's timestamp. */
export function matchWatchStatus(match: MatchAccess, phase: "waiting" | "started" | "finished"): MatchWatchStatus {
  return { lobbyId: match.lobbyId, started: phase !== "waiting", playbackFinished: phase === "finished", delaySeconds: spectatorDelaySeconds(match) };
}

/**
 * Only this explicit projection is public. In particular, no raw store row,
 * invite verifier, result, initial queen coordinates or instance secret is sent.
 * The store/hub owner supplies playbackFinished; slot reuse does not end a row.
 */
export function publicMatchCatalog(
  matches: readonly CatalogMatch[], lobbies: readonly CatalogLobby[], players: ReadonlyMap<string, PublicColonies> = new Map(),
): PublicLiveCatalog {
  return {
    matches: listedMatches(matches).map(match => ({
      lobbyId: match.lobbyId, startedAt: match.startedAt, rated: match.rated, delaySeconds: spectatorDelaySeconds(match),
      colonies: publicColonies(players.get(match.lobbyId)),
      ...(isHouseMatch(match) ? { harnessPhase: harnessPhaseAt(match.startedAt) } : {}),
    })),
    lobbies: lobbies.filter(lobby => lobby.kind === "public" && (lobby.state === "open" || lobby.state === "waiting"))
      .map(lobby => ({ id: lobby.id, size: lobby.size, state: lobby.state as "open" | "waiting", colonies: lobby.colonies.map(colony => colony.map(seat => seat.displayName)) })),
  };
}

/** The matches discovery lists, oldest first: public, with playback not yet finished. Only these have players read. */
export function listedMatches<T extends CatalogMatch>(matches: readonly T[]): T[] {
  return matches.filter(match => isPublicMatch(match) && !match.playbackFinished)
    .sort((a, b) => a.startedAt - b.startedAt || a.lobbyId.localeCompare(b.lobbyId));
}

/** An explicit copy of each seat's five public fields; anything else a caller attached is dropped. */
function publicColonies(colonies: PublicColonies | undefined): PublicColonies {
  const seats = (list: readonly PublicSeat[] | undefined): PublicSeat[] => (list ?? []).map(seat => seat.rating === null
    ? { displayName: seat.displayName, modelLabel: seat.modelLabel ?? null, rating: null, rd: null, ratedMatches: null }
    : { displayName: seat.displayName, modelLabel: seat.modelLabel ?? null, rating: seat.rating, rd: seat.rd, ratedMatches: seat.ratedMatches });
  return [seats(colonies?.[0]), seats(colonies?.[1])];
}
