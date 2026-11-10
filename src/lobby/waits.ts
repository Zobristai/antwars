/// <reference types="node" />
import { randomBytes } from "node:crypto";
import type { RankedMode } from "../rating/ratings.js";
import type { Fields, Store, Write } from "../store/firestore.js";
import type { Lobby } from "./lobbies.js";

/**
 * Waiting tokens: join_queue, join_lobby and request_challenge each return one, and the public
 * wait stream (src/accounts/waitStream.ts) reports that one wait's state for it. A token is not a
 * secret: it names one wait and grants nothing, never a seat, a lobby read or a key. It is random,
 * so it reveals nothing by itself, and the stream never sends a private lobby's id, a seat or an address.
 *
 * Documents, under the store's namespace:
 *   waits/{token}  { kind: "queue", identityId, joinedAt, expiresAt }  a ranked queue entry, by the join that made it
 *                  { kind: "lobby", lobbyId, expiresAt }                a lobby seat, a challenger's included
 * written in the same transaction as the join or the challenge request, so a returned token always resolves.
 * expiresAt (expiryField) is the wait's own limit plus WAIT_GRACE_MS. Once the wait is read final it is lowered to that
 * read plus WAIT_GRACE_MS, so a reconnect within the grace still learns the outcome; sweepExpiredWaits then removes it.
 * A queue wait whose entry a later join replaces, or leave_queue deletes, is removed with it (Lobbies.joinQueue/leaveQueue).
 * A queue wait found paired is re-pointed, once, to a lobby wait on the paired lobby (Lobbies.waitStatus), so
 * the token keeps following that lobby after the identity leaves or rejoins the queue:
 *                  { kind: "lobby", lobbyId, paired: "true" }
 * Its states then carry lobbyId, so an agent that never received paired still learns its queue lobby. The id
 * of a lobby joined directly is never sent: that lobby may be private.
 */

/** A wait's state. Only paired, slot_ready and expired are final. */
export type WaitState =
  /** A queue entry still waiting for a pairing, until expiresAt. */
  | { readonly state: "waiting"; readonly mode: RankedMode; readonly expiresAt: number }
  /** A lobby open for seats or waiting for a match slot; an open or waiting lobby expires at expiresAt. */
  | { readonly state: "waiting"; readonly lobby: "open" | "waiting"; readonly expiresAt: number; readonly lobbyId?: string }
  /**
   * The queue entry was paired with lobbyId. lobbyWait: the same token is now a wait on that lobby, so
   * reconnecting with it sends the lobby's current state, then slot_ready or expired.
   */
  | { readonly state: "paired"; readonly lobbyId: string; readonly lobbyWait: true }
  /** The lobby holds a match slot; its match starts at startsAt. */
  | { readonly state: "slot_ready"; readonly startsAt: number; readonly lobbyId?: string }
  /**
 * The wait ended without a match: time_limit when its own time ran out, ended for any other reason.
 * On a queue token after its pairing, every lobby state also carries the paired lobbyId (see waits/{token}).
 */
  | { readonly state: "expired"; readonly reason: ExpiredReason; readonly lobbyId?: string };

/** Fixed reasons only: no stored or reported text is ever carried. */
export type ExpiredReason = "time_limit" | "ended";

export const isFinal = (wait: WaitState): boolean => wait.state !== "waiting";

/** 16 random bytes, base64url: 22 characters. */
const WAIT_TOKEN = /^[A-Za-z0-9_-]{22}$/;

export const newWaitToken = (): string => randomBytes(16).toString("base64url");
export const isWaitToken = (token: string): boolean => WAIT_TOKEN.test(token);
export const waitPath = (token: string): string => `waits/${token}`;

/** How long a wait's record stays readable past its own limit, or past the read that first found it final. */
export const WAIT_GRACE_MS = 10 * 60 * 1000;
/** Expired records one sweep reads and removes at most: more than the one record each join adds. */
export const WAIT_SWEEP_PAGE = 25;

/** A record's expiresAt as stored: zero-padded milliseconds, so the store orders it as a number. */
export const expiryField = (at: number): string => String(Math.max(0, Math.floor(at))).padStart(16, "0");
const isPast = (expiresAt: string | undefined, at: number): boolean => expiresAt !== undefined && Number(expiresAt) <= at;

export type WaitRecord =
  | { readonly kind: "queue"; readonly identityId: string; readonly joinedAt: string }
  | { readonly kind: "lobby"; readonly lobbyId: string };

/** The token's document, created in the caller's transaction; limit is the wait's own limit, in ms. */
export function waitWrite(token: string, record: WaitRecord, limit: number): Write {
  return { op: "create", path: waitPath(token), fields: { ...record, expiresAt: expiryField(limit + WAIT_GRACE_MS) } };
}

/**
 * Turns a stored queue wait into a lobby wait on the lobby its entry was paired with, in the caller's transaction;
 * lobbyLimit is that lobby's own limit.
 */
export function repointWrite(token: string, lobbyId: string, lobbyLimit: number): Write {
  return { op: "update", path: waitPath(token), fields: { kind: "lobby", lobbyId, paired: "true", identityId: "", joinedAt: "", expiresAt: expiryField(lobbyLimit + WAIT_GRACE_MS) } };
}

/** The write lowering a record read final at `at` to expire WAIT_GRACE_MS later, or none when it already does by then. */
export function endedWrite(token: string, record: Fields | null | undefined, at: number): Write[] {
  if (!record) return [];
  const by = at + WAIT_GRACE_MS;
  return record.expiresAt !== undefined && Number(record.expiresAt) <= by ? [] : [{ op: "update", path: waitPath(token), fields: { expiresAt: expiryField(by) } }];
}

/**
 * Removes up to WAIT_SWEEP_PAGE records past their expiresAt, earliest first: one ordered page, each rechecked in the
 * deleting transaction, so a record re-pointed or lowered meanwhile is judged by its stored value. Returns how many.
 */
export async function sweepExpiredWaits(store: Store, at: number): Promise<number> {
  const { rows } = await store.query("waits", { orderBy: "expiresAt", direction: "ASCENDING", limit: WAIT_SWEEP_PAGE });
  const due = rows.filter((row) => isPast(row.fields.expiresAt, at)).map((row) => row.path);
  if (due.length === 0) return 0;
  return store.transaction<number>(async (read) => {
    const docs = await read(due);
    const gone = due.filter((path) => isPast(docs.get(path)?.expiresAt, at));
    return { result: gone.length, writes: gone.map((path): Write => ({ op: "delete", path })) };
  });
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

/** A lobby wait's state with the paired queue lobby's id added: only for a re-pointed queue token. */
export const withPairedLobby = (wait: WaitState, lobbyId: string): WaitState => (wait.state === "paired" ? wait : { ...wait, lobbyId });
