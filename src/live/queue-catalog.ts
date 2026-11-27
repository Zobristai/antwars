import { placeholder } from "../identity/retention.js";
import type { Seat, UnstartedLobby, WaitingAgent } from "../lobby/lobbies.js";
import type { QueueMode } from "../lobby/queue.js";
import type { Rating } from "../rating/ratings.js";

/** A rating as the Waiting view sends it: the figure, its RD and rated-match count; null where the seat shows none. */
export interface PublicRating { readonly rating: number; readonly rd: number; readonly ratedMatches: number }

/**
 * One agent waiting in a queue (a ranked queue or quadrants) as GET /watch/queue sends it: its public display name, the
 * queue's mode, whole seconds waited at the read, when its wait began (epoch milliseconds) and its rating in that mode
 * (not displayed for Free-for-all). Nothing else: no owner, key, identity, queue entry or lobby id.
 */
export interface PublicWaitingAgent {
  readonly displayName: string;
  readonly mode: QueueMode;
  readonly waitingSeconds: number;
  readonly since: number;
  readonly rating: PublicRating | null;
}
/**
 * A public lobby whose match has not begun, as GET /watch/queue sends it: a queue pairing's mode (null for a
 * player-created lobby), agents per colony, seats taken, each colony's seated names and whole seconds since it was
 * created; two colonies, or four in a quadrants lobby. No lobby, identity or owner id.
 */
export interface PublicWaitingLobby {
  readonly mode: QueueMode | null;
  readonly size: number;
  readonly seated: number;
  readonly colonies: readonly (readonly string[])[];
  /** Each seated name's rating, in the same order as colonies (src/live/seat-rating.ts); null where it shows none. */
  readonly ratings: readonly (readonly (PublicRating | null)[])[];
  /** How many of its colony's seats each seated name holds, in the same order as colonies: a queue pairing's one identity
   * per colony holds them all. */
  readonly seats: readonly (readonly number[])[];
  readonly waitingSeconds: number;
  /** When the lobby was made, epoch milliseconds. */
  readonly since: number;
  /** Present only on an unrated house challenge, for the Waiting card's label. */
  readonly challenge?: "house";
  /** Present only where the lobby has its own colony names (a drawn pair, or a quadrants lobby's four);
   * absent means the rated names. */
  readonly colonyNames?: readonly string[];
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
  seat(lobby: UnstartedLobby, colony: number, seat: Seat): Rating | null;
}
const NO_RATINGS: QueueRatings = { agent: () => null, seat: () => null };

/** The public Waiting view: each field picked explicitly, so a wider store row never reaches the page. */
export function publicQueue(agents: readonly WaitingAgent[], at: number, lobbies: readonly UnstartedLobby[] = [],
  ratings: QueueRatings = NO_RATINGS): PublicQueue {
  const seconds = (since: number) => Math.max(0, Math.floor((at - since) / 1000));
  const shown = (rating: Rating | null): PublicRating | null =>
    rating === null ? null : { rating: rating.rating, rd: rating.rd, ratedMatches: rating.ratedMatches };
  const colony = (lobby: UnstartedLobby, index: number) => lobby.colonies[index]!.map(seat => shown(ratings.seat(lobby, index, seat)));
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
      colonies: lobby.colonies.map(seats => seats.map(seat => publicWaitingName(seat.displayName))),
      ratings: lobby.colonies.map((_, index) => colony(lobby, index)),
      seats: lobby.colonies.map(seats => seats.map(seat => seat.seats)),
      waitingSeconds: seconds(lobby.createdAt),
      since: lobby.createdAt,
      ...(lobby.challenge === "house" ? { challenge: "house" as const } : {}),
      ...(lobby.colonyNames === undefined ? {} : { colonyNames: [...lobby.colonyNames] }),
    })),
  };
}
