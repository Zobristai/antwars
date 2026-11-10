/// <reference types="node" />
import { randomBytes } from "node:crypto";
import type { RankedMode } from "../rating/ratings.js";
import type { Fields, Store, TransactionRead, Write } from "../store/firestore.js";
import type { Lobby } from "./lobbies.js";

/**
 * Waiting tokens: join_queue, join_lobby and request_challenge each return one, and the public
 * wait stream (src/accounts/waitStream.ts) reports that one wait's state for it. A token is not a
 * secret: it names one wait and grants nothing, never a seat, a lobby read or a key. It is random,
 * so it reveals nothing by itself, and the stream never sends a private lobby's id, a seat or an address.
 *
 * Documents, under the store's namespace:
 *   waits/{token}  { kind: "queue", identityId, joinedAt, expiresAt }  a ranked queue entry, by the join that made it
 *                  { kind: "lobby", lobbyId, identityId, expiresAt }    a lobby seat, a challenger's included, by the joiner
 * written in the same transaction as the join or the challenge request, so a returned token always resolves.
 *   waits/seat_{lobbyId}_{identityId}  { token, expiresAt }  the lobby wait that identity holds on that lobby, written
 *                  with every lobby wait record and re-point (lobbyWaitWrites, repointWrites), with its expiresAt, so a
 *                  leave can find exactly the leaver's token (Lobbies.leave). Never a token: isWaitToken refuses its id.
 *   waits/mine_{kind}_{identityId}  { tokens, expiresAt }  the identity's wait records of one kind (queue, lobby or
 *                  challenge; a challenger's lobby wait is kind challenge here), space-separated, read by exact path, so a
 *                  join finds its identity's earlier records without a field query (WaitIndexes). Rewritten in the
 *                  transaction that adds or prunes an entry, with an expiresAt no earlier than any listed record's.
 * Records per identity are bounded by its joins, not by the sweep: join_queue removes the identity's previous queue
 * record and request_challenge its previous challenge record, live or ended (replacedWaitWrites); join_lobby and
 * join_queue remove its lobby records that have ended (left, read final, or past expiry) and keep the live ones, so its
 * lobby records number the seats it holds plus the ones ended since its last join (prunedLobbyWaitWrites).
 * A lobby wait whose identity left the lobby is marked ended: "true" and reads expired: ended from then on.
 * expiresAt (expiryField) is the wait's own limit plus WAIT_GRACE_MS. Once the wait is read final it is lowered to that
 * read plus WAIT_GRACE_MS, so a reconnect within the grace still learns the outcome; the server's timed sweep
 * (startWaitSweep, Lobbies.sweepWaits) then removes it, whether or not anyone joins.
 * A queue wait whose entry a later join replaces is removed with it (Lobbies.joinQueue); one whose entry leave_queue
 * deletes is kept, read ended, until a grace after the leave (Lobbies.leaveQueue). A waiting partner's queue wait is
 * re-pointed to the lobby in the transaction that pairs it (joinQueueStep).
 * A queue wait found paired is re-pointed, once, to a lobby wait on the paired lobby (Lobbies.waitStatus), so
 * the token keeps following that lobby after the identity leaves or rejoins the queue:
 *                  { kind: "lobby", lobbyId, identityId, paired: "true" }  identityId: the queued identity, kept
 * A waiting partner's queue wait is re-pointed by the pairing itself, and a matched joiner's by its identity's next
 * join (Lobbies.joinQueue), with paired: "unread", so its next read still reports paired once, then follows the lobby.
 * Its states then carry lobbyId, so an agent that never received paired still learns its queue lobby. The id
 * of a lobby joined directly is never sent: that lobby may be private. A record's identityId is stored only:
 * every state is built from the queue entry or the lobby, never from record fields, so it is never sent.
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
/** Expired records one sweep page reads and removes at most. */
export const WAIT_SWEEP_PAGE = 25;

/** A record's expiresAt as stored: zero-padded milliseconds, so the store orders it as a number. */
export const expiryField = (at: number): string => String(Math.max(0, Math.floor(at))).padStart(16, "0");
const isPast = (expiresAt: string | undefined, at: number): boolean => expiresAt !== undefined && Number(expiresAt) <= at;

export type WaitRecord =
  | { readonly kind: "queue"; readonly identityId: string; readonly joinedAt: string }
  | { readonly kind: "lobby"; readonly lobbyId: string; readonly identityId: string };

/** The token's document, created in the caller's transaction; limit is the wait's own limit, in ms. */
export function waitWrite(token: string, record: WaitRecord, limit: number): Write {
  return { op: "create", path: waitPath(token), fields: { ...record, expiresAt: expiryField(limit + WAIT_GRACE_MS) } };
}

/**
 * Turns a stored queue wait into a lobby wait on the lobby its entry was paired with, in the caller's transaction,
 * keeping identityId, the identity that holds the token; lobbyLimit is that lobby's own limit. paired "unread", written
 * by the pairing or a rejoin before any read, means paired was not yet reported: the next read reports it once and sets "true" (Lobbies.waitStatus).
 */
export function repointWrite(token: string, lobbyId: string, identityId: string, lobbyLimit: number, paired: "true" | "unread" = "true"): Write {
  return { op: "update", path: waitPath(token), fields: { kind: "lobby", lobbyId, paired, identityId, joinedAt: "", expiresAt: expiryField(lobbyLimit + WAIT_GRACE_MS) } };
}

/** The key finding the lobby wait an identity holds on a lobby (waits/{token} above). */
export const seatKeyPath = (lobbyId: string, identityId: string): string => `waits/seat_${lobbyId}_${identityId}`;

async function seatKeyWrite(read: TransactionRead, lobbyId: string, identityId: string, token: string, limit: number): Promise<Write> {
  const path = seatKeyPath(lobbyId, identityId);
  const existing = (await read([path])).get(path);
  return { op: existing ? "update" : "create", path, fields: { token, expiresAt: expiryField(limit + WAIT_GRACE_MS) } };
}

/** Which per-identity index lists a record (waits/mine_{kind}_{identityId} above). */
export type WaitIndexKind = "queue" | "lobby" | "challenge";

export const waitIndexPath = (kind: WaitIndexKind, identityId: string): string => `waits/mine_${kind}_${identityId}`;

/**
 * One transaction's edits to identities' wait indexes, collected so each index document is written at most once, by
 * writes(), after every other wait write of the transaction is decided.
 */
export interface WaitIndexes {
  /** The tokens an index lists as stored, before this transaction's edits. */
  stored(kind: WaitIndexKind, identityId: string): Promise<readonly string[]>;
  /** Lists token, whose record expires at expiresAt (ms). */
  add(kind: WaitIndexKind, identityId: string, token: string, expiresAt: number): void;
  /** Stops listing token. */
  remove(kind: WaitIndexKind, identityId: string, token: string): void;
  /**
   * The write for each edited index: its listed tokens, and an expiresAt no earlier than the latest of its records' (an
   * added record's, or the stored index's own while a stored token stays listed); an index left empty is deleted.
   */
  writes(): Promise<Write[]>;
}

export function waitIndexes(read: TransactionRead): WaitIndexes {
  const edits = new Map<string, { added: Map<string, number>; removed: Set<string> }>();
  const docOf = async (path: string) => (await read([path])).get(path) ?? null;
  const listed = (doc: Fields | null): string[] => (doc?.tokens ? doc.tokens.split(" ").filter(isWaitToken) : []);
  const editOf = (path: string) => {
    let edit = edits.get(path);
    if (!edit) edits.set(path, edit = { added: new Map(), removed: new Set() });
    return edit;
  };
  return {
    stored: async (kind, identityId) => listed(await docOf(waitIndexPath(kind, identityId))),
    add(kind, identityId, token, expiresAt) {
      const edit = editOf(waitIndexPath(kind, identityId));
      edit.removed.delete(token);
      edit.added.set(token, Math.max(expiresAt, edit.added.get(token) ?? 0));
    },
    remove(kind, identityId, token) {
      const edit = editOf(waitIndexPath(kind, identityId));
      edit.added.delete(token);
      edit.removed.add(token);
    },
    async writes() {
      const writes: Write[] = [];
      for (const [path, { added, removed }] of edits) {
        const doc = await docOf(path);
        const kept = listed(doc).filter((token) => !removed.has(token) && !added.has(token));
        const tokens = [...kept, ...added.keys()];
        if (tokens.length === 0) {
          if (doc) writes.push({ op: "delete", path });
          continue;
        }
        const expiresAt = Math.max(0, ...added.values(), kept.length > 0 && doc?.expiresAt !== undefined ? Number(doc.expiresAt) : 0);
        const fields = { tokens: tokens.join(" "), expiresAt: expiryField(expiresAt) };
        if (doc && doc.tokens === fields.tokens && doc.expiresAt === fields.expiresAt) continue;
        writes.push({ op: doc ? "update" : "create", path, fields });
      }
      return writes;
    },
  };
}

/**
 * A new lobby wait record and its seat key, in the caller's transaction, listed in its identity's index of `kind`
 * (lobby for join_lobby, challenge for a challenger's); limit is the lobby's own limit.
 */
export async function lobbyWaitWrites(
  read: TransactionRead, indexes: WaitIndexes, token: string, lobbyId: string, identityId: string, limit: number, kind: "lobby" | "challenge" = "lobby",
): Promise<Write[]> {
  indexes.add(kind, identityId, token, limit + WAIT_GRACE_MS);
  return [waitWrite(token, { kind: "lobby", lobbyId, identityId }, limit), await seatKeyWrite(read, lobbyId, identityId, token, limit)];
}

/** A new queue wait record, listed in its identity's queue index; limit is the entry's own limit. */
export function queueWaitWrite(indexes: WaitIndexes, token: string, identityId: string, joinedAt: number, limit: number): Write {
  indexes.add("queue", identityId, token, limit + WAIT_GRACE_MS);
  return waitWrite(token, { kind: "queue", identityId, joinedAt: String(joinedAt) }, limit);
}

/**
 * repointWrite and the re-pointed wait's seat key, in the caller's transaction; the token moves from its identity's queue
 * index to its lobby index, with the lobby's limit.
 */
export async function repointWrites(
  read: TransactionRead, indexes: WaitIndexes, token: string, lobbyId: string, identityId: string, lobbyLimit: number, paired: "true" | "unread" = "true",
): Promise<Write[]> {
  indexes.remove("queue", identityId, token);
  indexes.add("lobby", identityId, token, lobbyLimit + WAIT_GRACE_MS);
  return [repointWrite(token, lobbyId, identityId, lobbyLimit, paired), await seatKeyWrite(read, lobbyId, identityId, token, lobbyLimit)];
}

/** Deletes a record and, while its seat key still names it, that key; keepKey is a key this transaction writes itself. */
async function deleteWaitWrites(read: TransactionRead, token: string, record: Fields, keepKey?: string): Promise<Write[]> {
  const writes: Write[] = [{ op: "delete", path: waitPath(token) }];
  if (record.kind !== "lobby" || !record.lobbyId || !record.identityId) return writes;
  const keyPath = seatKeyPath(record.lobbyId, record.identityId);
  if (keyPath === keepKey) return writes;
  if ((await read([keyPath])).get(keyPath)?.token === token) writes.push({ op: "delete", path: keyPath });
  return writes;
}

/**
 * A join of `kind` by identityId replaces the identity's previous record of that kind, live or ended, in the caller's
 * transaction: each token its index lists is unlisted and its record deleted (with its seat key while the key names it).
 * A listed queue token whose record is no longer kind queue was re-pointed to a lobby and is only unlisted: its lobby
 * index holds it now. handled names records this transaction already writes, which are only unlisted.
 */
export async function replacedWaitWrites(
  read: TransactionRead, indexes: WaitIndexes, kind: "queue" | "challenge", identityId: string, handled: ReadonlySet<string> = new Set(),
): Promise<Write[]> {
  const writes: Write[] = [];
  for (const token of await indexes.stored(kind, identityId)) {
    indexes.remove(kind, identityId, token);
    if (handled.has(token)) continue;
    const record = (await read([waitPath(token)])).get(waitPath(token));
    if (!record || (kind === "queue" && record.kind !== "queue")) continue;
    writes.push(...(await deleteWaitWrites(read, token, record)));
  }
  return writes;
}

/**
 * A join by identityId removes the identity's lobby records that have ended, in the caller's transaction: left (ended),
 * read final (final), or past expiry; each is deleted with its seat key while the key names it, and unlisted. Live lobby
 * waits, on lobbies it still sits in, are kept. keepKey: the seat key this transaction writes for the join itself.
 */
export async function prunedLobbyWaitWrites(read: TransactionRead, indexes: WaitIndexes, identityId: string, at: number, keepKey?: string): Promise<Write[]> {
  const writes: Write[] = [];
  for (const token of await indexes.stored("lobby", identityId)) {
    const record = (await read([waitPath(token)])).get(waitPath(token));
    if (!record || record.kind !== "lobby") {
      indexes.remove("lobby", identityId, token);
      continue;
    }
    if (record.ended !== "true" && record.final !== "true" && !isPast(record.expiresAt, at)) continue;
    indexes.remove("lobby", identityId, token);
    writes.push(...(await deleteWaitWrites(read, token, record, keepKey)));
  }
  return writes;
}

/**
 * The writes a leave makes in its transaction: the leaver's seat key on the lobby is deleted, and the lobby wait it names
 * is marked ended, expiring a grace from `at`, only while that record is still this identity's wait on this lobby.
 * No other identity's record or key is read or written.
 */
export async function leftLobbyWaitWrites(read: TransactionRead, lobbyId: string, identityId: string, at: number): Promise<Write[]> {
  const keyPath = seatKeyPath(lobbyId, identityId);
  const key = (await read([keyPath])).get(keyPath);
  if (!key) return [];
  const writes: Write[] = [{ op: "delete", path: keyPath }];
  if (key.token && isWaitToken(key.token)) {
    const wait = (await read([waitPath(key.token)])).get(waitPath(key.token));
    if (wait?.kind === "lobby" && wait.lobbyId === lobbyId && wait.identityId === identityId) {
      const by = Math.min(at + WAIT_GRACE_MS, wait.expiresAt === undefined ? Infinity : Number(wait.expiresAt));
      writes.push({ op: "update", path: waitPath(key.token), fields: { ended: "true", expiresAt: expiryField(by) } });
    }
  }
  return writes;
}

/** The state of a lobby wait whose identity left the lobby. */
export const LEFT_LOBBY: WaitState = { state: "expired", reason: "ended" };

/** The write lowering a record read final at `at` to expire WAIT_GRACE_MS later, or none when it already does by then. */
export function endedWrite(token: string, record: Fields | null | undefined, at: number): Write[] {
  if (!record) return [];
  const by = at + WAIT_GRACE_MS;
  return record.expiresAt !== undefined && Number(record.expiresAt) <= by ? [] : [{ op: "update", path: waitPath(token), fields: { expiresAt: expiryField(by) } }];
}

/**
 * The writes ending a lobby wait read final at `at`, in the caller's transaction: its record marked final (so its
 * identity's next join removes it) and lowered as endedWrite does, and its seat key lowered to the same expiry, only while
 * that key still names this token.
 */
export async function endedLobbyWaitWrites(read: TransactionRead, token: string, record: Fields, at: number): Promise<Write[]> {
  const lowered = endedWrite(token, record, at)[0];
  const writes: Write[] = record.final === "true"
    ? (lowered ? [lowered] : [])
    : [{ op: "update", path: waitPath(token), fields: { final: "true", ...(lowered?.op === "update" ? lowered.fields : {}) } }];
  if (!record.lobbyId || !record.identityId) return writes;
  const keyPath = seatKeyPath(record.lobbyId, record.identityId);
  const key = (await read([keyPath])).get(keyPath);
  const by = at + WAIT_GRACE_MS;
  if (key?.token === token && !(key.expiresAt !== undefined && Number(key.expiresAt) <= by)) {
    writes.push({ op: "update", path: keyPath, fields: { expiresAt: expiryField(by) } });
  }
  return writes;
}

/**
 * Removes up to WAIT_SWEEP_PAGE records past their expiresAt, earliest first: one ordered page, each rechecked in the
 * deleting transaction, so a record re-pointed or lowered meanwhile is judged by its stored value. Returns how many.
 */
export async function sweepExpiredWaits(store: Store, at: number): Promise<number> {
  return (await sweepPage(store, at)).removed;
}

async function sweepPage(store: Store, at: number): Promise<{ readonly due: number; readonly removed: number }> {
  const { rows } = await store.query("waits", { orderBy: "expiresAt", direction: "ASCENDING", limit: WAIT_SWEEP_PAGE });
  const due = rows.filter((row) => isPast(row.fields.expiresAt, at)).map((row) => row.path);
  if (due.length === 0) return { due: 0, removed: 0 };
  const removed = await store.transaction<number>(async (read) => {
    const docs = await read(due);
    const gone = due.filter((path) => isPast(docs.get(path)?.expiresAt, at));
    return { result: gone.length, writes: gone.map((path): Write => ({ op: "delete", path })) };
  });
  return { due: due.length, removed };
}

/** Pages one sweep reads at most, so a tick's work is bounded: WAIT_SWEEP_MAX_PAGES * WAIT_SWEEP_PAGE records. */
export const WAIT_SWEEP_MAX_PAGES = 40;
/** How often the server sweeps expired wait records, whether or not anyone joins. */
export const WAIT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Removes every record past its expiresAt, of every kind, page after page until a page holds fewer than WAIT_SWEEP_PAGE
 * due or WAIT_SWEEP_MAX_PAGES pages are read. Each page's deletes are rechecked in their transaction, so instances
 * sweeping at once never delete a record another re-pointed or lowered meanwhile, and a record already deleted is
 * simply not deleted again. Returns how many it removed.
 */
export async function sweepAllExpiredWaits(store: Store, at: number, maxPages = WAIT_SWEEP_MAX_PAGES): Promise<number> {
  let removed = 0;
  for (let page = 0; page < maxPages; page++) {
    const swept = await sweepPage(store, at);
    removed += swept.removed;
    if (swept.due < WAIT_SWEEP_PAGE) break;
  }
  return removed;
}

/**
 * Runs sweep every intervalMs on an unref'd timer, the MCP session sweep's pattern, never overlapping itself; a failed
 * tick logs a fixed warning and the next tick retries. Returns the stop.
 */
export function startWaitSweep(sweep: () => Promise<unknown>, intervalMs = WAIT_SWEEP_INTERVAL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweep()
      .catch((cause: unknown) => console.warn(`antwar wait sweep failed: ${cause instanceof Error ? cause.name : "error"}`))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
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
