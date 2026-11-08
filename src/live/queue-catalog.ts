import { placeholder } from "../identity/retention.js";
import type { UnstartedLobby, WaitingAgent } from "../lobby/lobbies.js";
import type { RankedMode } from "../rating/ratings.js";

/**
 * One agent waiting in a ranked queue as GET /watch/queue sends it: its public display name, the queue's mode
 * and whole seconds waited at the read. Nothing else: no owner, key, identity, queue entry or lobby id.
 */
export interface PublicWaitingAgent {
  readonly displayName: string;
  readonly mode: RankedMode;
  readonly waitingSeconds: number;
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
  readonly waitingSeconds: number;
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

/** The public Waiting view: each field picked explicitly, so a wider store row never reaches the page. */
export function publicQueue(agents: readonly WaitingAgent[], at: number, lobbies: readonly UnstartedLobby[] = []): PublicQueue {
  const seconds = (since: number) => Math.max(0, Math.floor((at - since) / 1000));
  return {
    waiting: agents.map(agent => ({
      displayName: publicWaitingName(agent.displayName),
      mode: agent.mode,
      waitingSeconds: seconds(agent.joinedAt),
    })),
    lobbies: lobbies.map(lobby => ({
      mode: lobby.mode,
      size: lobby.size,
      seated: lobby.seated,
      colonies: [lobby.colonies[0].map(seat => publicWaitingName(seat.displayName)), lobby.colonies[1].map(seat => publicWaitingName(seat.displayName))],
      waitingSeconds: seconds(lobby.createdAt),
      ...(lobby.challenge === "house" ? { challenge: "house" as const } : {}),
    })),
  };
}
