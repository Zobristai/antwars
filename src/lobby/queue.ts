import { isHouseOwned } from "../identity/houseOwnership.js";
import { isRankedMode, type RankedMode } from "../rating/ratings.js";
import type { Fields, TransactionRead, TransactionStep, Write } from "../store/firestore.js";
import type { Lobby, LobbyOutcome, LobbySize, Seat } from "./lobbies.js";
import type { WaitState } from "./waits.js";

/**
 * The ranked matchmaking queue, as transaction steps that
 * src/lobby/lobbies.ts commits on the store createLobbies was given.
 *
 * Each identity holds at most one entry, across all modes. A join pairs the joiner
 * with one waiting, unexpired entry of the same mode, chosen uniformly at random
 * among those eligible: a different owner (`ownerId ?? id`, read in the
 * transaction; a missing identity document is never paired), or any entry where
 * the mode's `house` is true. Otherwise the joiner waits. An entry expires 12
 * hours after it joined, or 15 minutes in a house mode; nothing renews it,
 * and expiry is derived, never written. A pair becomes a
 * started, rated public lobby through `queuedMatchWrites`, so slots are handed out
 * only by settleSlots with this transaction's own read. Seating follows the mode's
 * `size`, never its name: each identity holds every seat of its own colony.
 * House modes admit only handles of the antwars username (refused `not_house`
 * otherwise) and pair them with each other.
 *
 * Documents, under the store's namespace:
 *   queueEntries/{identityId}  { mode, joinedAt, state ("waiting" | "matched"), lobbyId }
 *   queueWaiting/{mode}        { entries }  waiting identity ids, oldest first
 */

/** A builder (non-house) mode entry's lifetime from its join: 12 hours, renewed by nothing. */
export const QUEUE_TTL_MS = 12 * 60 * 60 * 1000;
/** A house Benchmark mode entry keeps 15 minutes, so a dead house seat never lingers into a later round's pairing. */
export const HOUSE_QUEUE_TTL_MS = 15 * 60 * 1000;

/** An entry's lifetime from its join, by its mode: HOUSE_QUEUE_TTL_MS for a house mode, QUEUE_TTL_MS otherwise. */
export function queueTtl(mode: string | undefined): number {
  return isRankedMode(mode) && QUEUE_MODES[mode]?.house ? HOUSE_QUEUE_TTL_MS : QUEUE_TTL_MS;
}

export const QUEUE_MODES: Partial<Record<RankedMode, { readonly size: LobbySize; readonly house: boolean }>> = {
  "1v1": { size: 1, house: false },
  "2v2": { size: 2, house: false },
  "3v3": { size: 3, house: false },
  "4v4": { size: 4, house: false },
  "house-1v1": { size: 1, house: true },
  "house-2v2": { size: 2, house: true },
  "house-3v3": { size: 3, house: true },
  "house-4v4": { size: 4, house: true },
};

export type QueueStatus =
  | { readonly state: "none" }
  | { readonly state: "waiting"; readonly mode: RankedMode; readonly joinedAt: number; readonly expiresAt: number }
  | { readonly state: "matched"; readonly mode: RankedMode; readonly lobbyId: string; readonly matchedAt: number }
  | { readonly state: "expired"; readonly mode: RankedMode; readonly expiresAt: number };

/** The lobby a pairing makes, in the caller's transaction: Lobbies.queuedMatchWrites. */
export type QueuedMatchWrites = (
  read: TransactionRead,
  match: { readonly mode: RankedMode; readonly colonies: readonly [readonly Seat[], readonly Seat[]] },
  at: number,
) => Promise<{ readonly writes: readonly Write[]; readonly lobby: Lobby }>;

type Step = TransactionStep<LobbyOutcome<QueueStatus>>;

const entryPath = (identityId: string) => `queueEntries/${identityId}`;
const waitingPath = (mode: string) => `queueWaiting/${mode}`;
const ids = (list: string | undefined) => (list ?? "").split(" ").filter(Boolean);
const isLive = (entry: Fields | null | undefined, at: number) =>
  entry?.state === "waiting" && at < Number(entry.joinedAt) + queueTtl(entry.mode);
const ownerOf = (identityId: string, identity: Fields | null | undefined) => (identity ? identity.ownerId || identityId : undefined);

/** House mode admits only a handle whose ownerId is the antwars username. */
async function admitsHouse(read: TransactionRead, identity: Fields | null | undefined, identityId: string): Promise<boolean> {
  return !!identity?.ownerId && await isHouseOwned(read, identityId);
}

/** Each colony is one identity's seat repeated once per seat of the mode's size. */
export function pairColonies(size: LobbySize, first: Seat, second: Seat): [Seat[], Seat[]] {
  return [Array.from({ length: size }, () => first), Array.from({ length: size }, () => second)];
}

/** The entry's status at `at`; a matched entry's time is its lobby's creation. */
async function statusOf(read: TransactionRead, entry: Fields | null, at: number): Promise<QueueStatus> {
  if (!entry || !isRankedMode(entry.mode)) return { state: "none" };
  const mode = entry.mode;
  const joinedAt = Number(entry.joinedAt);
  if (entry.state === "matched" && entry.lobbyId) {
    const lobby = (await read([`lobbies/${entry.lobbyId}`])).get(`lobbies/${entry.lobbyId}`);
    return { state: "matched", mode, lobbyId: entry.lobbyId, matchedAt: lobby ? Number(lobby.createdAt) : joinedAt };
  }
  if (entry.state !== "waiting") return { state: "none" };
  const expiresAt = joinedAt + queueTtl(mode);
  return at < expiresAt ? { state: "waiting", mode, joinedAt, expiresAt } : { state: "expired", mode, expiresAt };
}

export async function joinQueueStep(
  read: TransactionRead, joiner: Seat, mode: string, at: number, random: () => number, queuedMatchWrites: QueuedMatchWrites,
): Promise<Step> {
  const table = isRankedMode(mode) ? QUEUE_MODES[mode] : undefined;
  if (!isRankedMode(mode) || !table) return { result: { ok: false, reason: "invalid_mode" }, writes: [] };
  const docs = await read([entryPath(joiner.id), waitingPath(mode), `identities/${joiner.id}`]);
  if (table.house && !(await admitsHouse(read, docs.get(`identities/${joiner.id}`), joiner.id))) {
    return { result: { ok: false, reason: "not_house" }, writes: [] };
  }
  const own = docs.get(entryPath(joiner.id)) ?? null;
  // Only a live waiting entry blocks a join; a matched or expired one is replaced.
  if (isLive(own, at)) return { result: { ok: false, reason: "already_queued" }, writes: [] };
  const waitingDoc = docs.get(waitingPath(mode)) ?? null;
  const queued = ids(waitingDoc?.entries).filter((id) => id !== joiner.id);
  const candidateDocs = queued.length > 0
    ? await read(queued.flatMap((id) => [entryPath(id), `identities/${id}`]))
    : new Map<string, Fields | null>();
  // Entries that left, matched, expired or moved mode are pruned from the list.
  const waiting = queued.filter((id) => {
    const entry = candidateDocs.get(entryPath(id));
    return isLive(entry, at) && entry!.mode === mode;
  });
  const joinerOwner = ownerOf(joiner.id, docs.get(`identities/${joiner.id}`));
  const eligible = waiting.filter((id) => {
    const owner = ownerOf(id, candidateDocs.get(`identities/${id}`));
    return owner !== undefined && joinerOwner !== undefined && (table.house || owner !== joinerOwner);
  });
  const listWrite = (entries: string[]): Write[] => {
    const value = entries.join(" ");
    if (waitingDoc === null) return value ? [{ op: "create", path: waitingPath(mode), fields: { entries: value } }] : [];
    return value === waitingDoc.entries ? [] : [{ op: "update", path: waitingPath(mode), fields: { entries: value } }];
  };
  const ownWrite = (fields: Fields): Write => ({ op: own ? "update" : "create", path: entryPath(joiner.id), fields });

  if (eligible.length === 0) {
    const fields = { mode, joinedAt: String(at), state: "waiting", lobbyId: "" };
    return {
      result: { ok: true, value: { state: "waiting", mode, joinedAt: at, expiresAt: at + queueTtl(mode) } },
      writes: [ownWrite(fields), ...listWrite([...waiting, joiner.id])],
    };
  }
  const pick = eligible[Math.min(eligible.length - 1, Math.max(0, Math.floor(random() * eligible.length)))]!;
  const partner = candidateDocs.get(`identities/${pick}`)!;
  const made = await queuedMatchWrites(read, {
    mode, colonies: pairColonies(table.size, { id: pick, displayName: partner.displayName ?? "" }, joiner),
  }, at);
  const lobbyId = made.lobby.id;
  return {
    result: { ok: true, value: { state: "matched", mode, lobbyId, matchedAt: at } },
    writes: [
      ...made.writes,
      { op: "update", path: entryPath(pick), fields: { state: "matched", lobbyId } },
      ownWrite({ mode, joinedAt: String(at), state: "matched", lobbyId }),
      ...listWrite(waiting.filter((id) => id !== pick)),
    ],
  };
}

/**
 * A queue wait (src/lobby/waits.ts), from the identity's entry as stored now and the joinedAt of the join that
 * issued its token. An entry from another join (left, or replaced by a later join) or none at all ended; a matched
 * entry is paired; a waiting one waits until its lifetime ends, then ran out of time. Reads nothing, writes nothing.
 */
export function queueWait(entry: Fields | null, joinedAt: string, at: number): WaitState {
  if (!entry || entry.joinedAt !== joinedAt || !isRankedMode(entry.mode)) return { state: "expired", reason: "ended" };
  if (entry.state === "matched" && entry.lobbyId) return { state: "paired", lobbyId: entry.lobbyId };
  if (entry.state !== "waiting") return { state: "expired", reason: "ended" };
  const expiresAt = Number(joinedAt) + queueTtl(entry.mode);
  return at < expiresAt ? { state: "waiting", mode: entry.mode, expiresAt } : { state: "expired", reason: "time_limit" };
}

/** The stored path of an identity's queue entry. */
export const queueEntryPath = (identityId: string): string => entryPath(identityId);

export async function queueStatusStep(read: TransactionRead, identityId: string, at: number): Promise<Step> {
  const entry = (await read([entryPath(identityId)])).get(entryPath(identityId)) ?? null;
  return { result: { ok: true, value: await statusOf(read, entry, at) }, writes: [] };
}

/** One live waiting entry, as the public Waiting view reads it. */
export interface WaitingEntry { readonly identityId: string; readonly mode: RankedMode; readonly joinedAt: number }

/**
 * Every live waiting entry across QUEUE_MODES, oldest first, read without a transaction and writing nothing.
 * Liveness is isLive at `at`, as every queue step derives it: an expired entry keeps its stored state "waiting" for good
 * and may still be listed until the next join prunes it, so neither the
 * stored state nor queueWaiting is trusted alone.
 */
export async function waitingEntries(get: (path: string) => Promise<Fields | null>, at: number): Promise<WaitingEntry[]> {
  const modes = Object.keys(QUEUE_MODES).filter(isRankedMode);
  const perMode = await Promise.all(modes.map(async (mode) => {
    const listed = ids((await get(waitingPath(mode)))?.entries);
    const entries = await Promise.all(listed.map(async (identityId) => ({ identityId, entry: await get(entryPath(identityId)) })));
    return entries.filter(({ entry }) => isLive(entry, at) && entry!.mode === mode)
      .map(({ identityId, entry }) => ({ identityId, mode, joinedAt: Number(entry!.joinedAt) }));
  }));
  return perMode.flat().sort((a, b) => a.joinedAt - b.joinedAt);
}

/** Removes a live waiting entry; any other status is returned unchanged. */
export async function leaveQueueStep(read: TransactionRead, identityId: string, at: number): Promise<Step> {
  const entry = (await read([entryPath(identityId)])).get(entryPath(identityId)) ?? null;
  if (!entry || !isLive(entry, at)) return { result: { ok: true, value: await statusOf(read, entry, at) }, writes: [] };
  const waitingDoc = (await read([waitingPath(entry.mode!)])).get(waitingPath(entry.mode!)) ?? null;
  const remaining = ids(waitingDoc?.entries).filter((id) => id !== identityId).join(" ");
  const writes: Write[] = [{ op: "delete", path: entryPath(identityId) }];
  if (waitingDoc !== null && remaining !== waitingDoc.entries) writes.push({ op: "update", path: waitingPath(entry.mode!), fields: { entries: remaining } });
  return { result: { ok: true, value: { state: "none" } }, writes };
}
