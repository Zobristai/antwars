import { placeholder } from "../identity/retention.js";
import type { Seat, UnstartedLobby, WaitingAgent } from "../lobby/lobbies.js";
import type { RankedMode, Rating } from "../rating/ratings.js";

/** A rating as the Waiting view sends it: the figure, its RD and rated-match count; null where the seat shows none. */
export interface PublicRating { readonly rating: number; readonly rd: number; readonly ratedMatches: number }

/**
 * One agent waiting in a ranked queue as GET /watch/queue sends it: its public display name, the queue's mode, whole
 * seconds waited at the read, when its wait began (epoch milliseconds) and its rating in that mode. Nothing else: no
 * owner, key, identity, queue entry or lobby id.
 */
export interface PublicWaitingAgent {
  readonly displayName: string;
  readonly mode: RankedMode;
  readonly waitingSeconds: number;
  readonly since: number;
  readonly rating: PublicRating | null;
}
/**
 * A public lobby whose match has not begun, as GET /watch/queue sends it: a queue pairing's mode (null for a
 * player-created lobby), agents per colony, seats taken, each colony's seated names and whole seconds since it was
 * created. No lobby, identity or owner id.
 */
export interface PublicWaitingLobby {
  readonly mode: RankedMode | null;
  readonly size: number;
  readonly seated: number;
  readonly colonies: readonly [readonly string[], readonly string[]];
  /** Each seated name's rating, in the same order as colonies (src/live/seat-rating.ts); null where it shows none. */
  readonly ratings: readonly [readonly (PublicRating | null)[], readonly (PublicRating | null)[]];
  readonly waitingSeconds: number;
  /** When the lobby was made, epoch milliseconds. */
  readonly since: number;
  /** Present only on an unrated house challenge, for the Waiting card's label. */
  readonly challenge?: "house";
}
export interface PublicQueue { readonly waiting: readonly PublicWaitingAgent[]; readonly lobbies: readonly PublicWaitingLobby[] }

/** A released owner's name displays as its placeholder, which embeds the owner id (identity/retention.ts). */
const PLACEHOLDER = placeholder("");
export const RELEASED_NAME = "released account";

/**
 * The name the public Waiting view shows: the identity's display name, except that a released owner's placeholder prefix
 * (`account:<owner id>`, alone or before `/<handle>`) becomes RELEASED_NAME, so no id is ever sent. A claimed name cannot
 * contain ":" (identities.ts parseName), so only a placeholder matches.
 */
export function publicWaitingName(displayName: string): string {
  if (!displayName.startsWith(PLACEHOLDER)) return displayName;
  const slash = displayName.indexOf("/");
  return slash < 0 ? RELEASED_NAME : `${RELEASED_NAME}${displayName.slice(slash)}`;
}

/** The ratings the Waiting view shows, already read: an agent's in its queue's mode, a lobby seat's by its colony. */
export interface QueueRatings {
  agent(agent: WaitingAgent): Rating | null;
  seat(lobby: UnstartedLobby, colony: 0 | 1, seat: Seat): Rating | null;
}
const NO_RATINGS: QueueRatings = { agent: () => null, seat: () => null };

/** The public Waiting view: each field picked explicitly, so a wider store row never reaches the page. */
export function publicQueue(agents: readonly WaitingAgent[], at: number, lobbies: readonly UnstartedLobby[] = [],
  ratings: QueueRatings = NO_RATINGS): PublicQueue {
  const seconds = (since: number) => Math.max(0, Math.floor((at - since) / 1000));
  const shown = (rating: Rating | null): PublicRating | null =>
    rating === null ? null : { rating: rating.rating, rd: rating.rd, ratedMatches: rating.ratedMatches };
  const colony = (lobby: UnstartedLobby, index: 0 | 1) => lobby.colonies[index].map(seat => shown(ratings.seat(lobby, index, seat)));
  return {
    waiting: agents.map(agent => ({
      displayName: publicWaitingName(agent.displayName),
      mode: agent.mode,
      waitingSeconds: seconds(agent.joinedAt),
      since: agent.joinedAt,
      rating: shown(ratings.agent(agent)),
    })),
    lobbies: lobbies.map(lobby => ({
      mode: lobby.mode,
      size: lobby.size,
      seated: lobby.seated,
      colonies: [lobby.colonies[0].map(seat => publicWaitingName(seat.displayName)), lobby.colonies[1].map(seat => publicWaitingName(seat.displayName))],
      ratings: [colony(lobby, 0), colony(lobby, 1)],
      waitingSeconds: seconds(lobby.createdAt),
      since: lobby.createdAt,
      ...(lobby.challenge === "house" ? { challenge: "house" as const } : {}),
    })),
  };
}
