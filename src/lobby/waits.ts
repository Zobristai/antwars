/// <reference types="node" />
import { randomBytes } from "node:crypto";
import type { RankedMode } from "../rating/ratings.js";
import type { Write } from "../store/firestore.js";
import type { Lobby } from "./lobbies.js";

/**
 * Waiting tokens: join_queue, join_lobby and request_challenge each return one, and the public
 * wait stream (src/accounts/waitStream.ts) reports that one wait's state for it. A token is not a
 * secret: it names one wait and grants nothing, never a seat, a lobby read or a key. It is random,
 * so it reveals nothing by itself, and the stream never sends a private lobby's id, a seat or an address.
 *
 * Documents, under the store's namespace:
 *   waits/{token}  { kind: "queue", identityId, joinedAt }  a ranked queue entry, by the join that made it
 *                  { kind: "lobby", lobbyId }                a lobby seat, a challenger's included
 * written in the same transaction as the join or the challenge request, so a returned token always resolves.
 * A queue wait found paired is re-pointed, once, to a lobby wait on the paired lobby (Lobbies.waitStatus), so
 * the token keeps following that lobby after the identity leaves or rejoins the queue.
 */

/** A wait's state. Only paired, slot_ready and expired are final. */
export type WaitState =
  /** A queue entry still waiting for a pairing, until expiresAt. */
  | { readonly state: "waiting"; readonly mode: RankedMode; readonly expiresAt: number }
  /** A lobby open for seats or waiting for a match slot; an open or waiting lobby expires at expiresAt. */
  | { readonly state: "waiting"; readonly lobby: "open" | "waiting"; readonly expiresAt: number }
  /**
   * The queue entry was paired with lobbyId. lobbyWait: the same token is now a wait on that lobby, so
   * reconnecting with it sends the lobby's current state, then slot_ready or expired.
   */
  | { readonly state: "paired"; readonly lobbyId: string; readonly lobbyWait: true }
  /** The lobby holds a match slot; its match starts at startsAt. */
  | { readonly state: "slot_ready"; readonly startsAt: number }
  /** The wait ended without a match: time_limit when its own time ran out, ended for any other reason. */
  | { readonly state: "expired"; readonly reason: ExpiredReason };

/** Fixed reasons only: no stored or reported text is ever carried. */
export type ExpiredReason = "time_limit" | "ended";

export const isFinal = (wait: WaitState): boolean => wait.state !== "waiting";

/** 16 random bytes, base64url: 22 characters. */
const WAIT_TOKEN = /^[A-Za-z0-9_-]{22}$/;

export const newWaitToken = (): string => randomBytes(16).toString("base64url");
export const isWaitToken = (token: string): boolean => WAIT_TOKEN.test(token);
export const waitPath = (token: string): string => `waits/${token}`;

export type WaitRecord =
  | { readonly kind: "queue"; readonly identityId: string; readonly joinedAt: string }
  | { readonly kind: "lobby"; readonly lobbyId: string };

/** The token's document, created in the caller's transaction. */
export function waitWrite(token: string, record: WaitRecord): Write {
  return { op: "create", path: waitPath(token), fields: { ...record } };
}

/** Turns a stored queue wait into a lobby wait on the lobby its entry was paired with, in the caller's transaction. */
export function repointWrite(token: string, lobbyId: string): Write {
  return { op: "update", path: waitPath(token), fields: { kind: "lobby", lobbyId, identityId: "", joinedAt: "" } };
}

/**
 * A lobby wait, from the lobby as readLobby returns it (a waiting lobby already settled). A slot held now,
 * or held by a match that was played, is slot_ready; an expired lobby ran out of time; a lobby that ended
 * without a played match (closed, a failed challenge launch, a start that never began) ended.
 */
export function lobbyWait(lobby: Lobby): WaitState {
  switch (lobby.state) {
    case "holding": return { state: "slot_ready", startsAt: lobby.startsAt ?? lobby.createdAt };
    case "expired": return { state: "expired", reason: "time_limit" };
    case "ended":
      return lobby.startsAt !== null && lobby.outcome !== null && lobby.outcome !== "not_played"
        ? { state: "slot_ready", startsAt: lobby.startsAt }
        : { state: "expired", reason: "ended" };
    default: return { state: "waiting", lobby: lobby.state, expiresAt: lobby.expiresAt };
  }
}
