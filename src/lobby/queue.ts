import { isHouseOwned } from "../identity/houseOwnership.js";
import type { RankedMode } from "../rating/ratings.js";
import type { Fields, TransactionRead, TransactionStep, Write } from "../store/firestore.js";
import type { Lobby, LobbyOutcome, LobbySize, Seat } from "./lobbies.js";
import { isWaitToken, matchedQueueWaitWrites, repointWrites, waitPath, type WaitIndexes, type WaitState } from "./waits.js";

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
 * Quadrants is an unrated four-colony mode: a join waits until three waiting entries
 * exist whose owners differ from each other and from the joiner's, then the four become
 * one public lobby of four one-seat colonies. It is refused `no_quadrant_map` while its
 * map rotation holds no quadrant map.
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
  return isQueueMode(mode) && QUEUE_MODES[mode]?.house ? HOUSE_QUEUE_TTL_MS : QUEUE_TTL_MS;
}

/** A queue's mode: a ranked mode, or the unrated four-colony quadrants. */
export type QueueMode = RankedMode | "quadrants";

export const QUEUE_MODES: Partial<Record<QueueMode, { readonly size: LobbySize; readonly house: boolean; readonly colonies: 2 | 4 }>> = {
  "1v1": { size: 1, house: false, colonies: 2 },
  "2v2": { size: 2, house: false, colonies: 2 },
  "3v3": { size: 3, house: false, colonies: 2 },
  "4v4": { size: 4, house: false, colonies: 2 },
  "house-1v1": { size: 1, house: true, colonies: 2 },
  "house-2v2": { size: 2, house: true, colonies: 2 },
  "house-3v3": { size: 3, house: true, colonies: 2 },
  "house-4v4": { size: 4, house: true, colonies: 2 },
  quadrants: { size: 1, house: false, colonies: 4 },
};

export function isQueueMode(mode: unknown): mode is QueueMode {
  return typeof mode === "string" && Object.hasOwn(QUEUE_MODES, mode);
}

/** Whether a join in mode is refused no_quadrant_map: a four-colony mode while its map rotation cannot serve a match. */
export function lacksQuadrantMap(mode: string, quadrantMapReady: boolean): boolean {
  return isQueueMode(mode) && QUEUE_MODES[mode]?.colonies === 4 && !quadrantMapReady;
}

export type QueueStatus =
  | { readonly state: "none" }
  | { readonly state: "waiting"; readonly mode: QueueMode; readonly joinedAt: number; readonly expiresAt: number }
  | { readonly state: "matched"; readonly mode: QueueMode; readonly lobbyId: string; readonly matchedAt: number }
  | { readonly state: "expired"; readonly mode: QueueMode; readonly expiresAt: number };

/** The lobby a pairing makes, in the caller's transaction: Lobbies.queuedMatchWrites. */
export type QueuedMatchWrites = (
  read: TransactionRead,
  match: { readonly mode: QueueMode; readonly colonies: readonly (readonly Seat[])[] },
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
  if (!entry || !isQueueMode(entry.mode)) return { state: "none" };
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

/**
 * waitToken: the join's waiting token (src/lobby/waits.ts), kept on the entry so a later join or leave can remove its wait;
 * indexes: the transaction's wait index edits, which a re-pointed partner's token moves through. A join matched here
 * writes its own wait as a lobby wait on the paired lobby (matchedQueueWaitWrites); the caller writes a waiting join's.
 * quadrantMapReady: whether the quadrants map rotation can serve a match; quadrants is refused before any read while not.
 */
export async function joinQueueStep(
  read: TransactionRead, joiner: Seat, mode: string, at: number, random: () => number, queuedMatchWrites: QueuedMatchWrites, indexes: WaitIndexes, waitToken = "",
  quadrantMapReady = false,
): Promise<Step> {
  const table = isQueueMode(mode) ? QUEUE_MODES[mode] : undefined;
  if (!isQueueMode(mode) || !table) return { result: { ok: false, reason: "invalid_mode" }, writes: [] };
  if (lacksQuadrantMap(mode, quadrantMapReady)) return { result: { ok: false, reason: "no_quadrant_map" }, writes: [] };
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

  // Quadrants needs three partners whose owners differ from each other and from the joiner's, picked in a random order.
  const picks = table.colonies === 4
    ? distinctOwners(shuffled(eligible, random), (id) => ownerOf(id, candidateDocs.get(`identities/${id}`))!, joinerOwner!, 3)
    : eligible.length === 0 ? [] : [eligible[Math.min(eligible.length - 1, Math.max(0, Math.floor(random() * eligible.length)))]!];
  if (picks.length < table.colonies - 1) {
    const fields = { mode, joinedAt: String(at), state: "waiting", lobbyId: "", waitToken };
    return {
      result: { ok: true, value: { state: "waiting", mode, joinedAt: at, expiresAt: at + queueTtl(mode) } },
      writes: [ownWrite(fields), ...listWrite([...waiting, joiner.id])],
    };
  }
  const seatOf = (id: string): Seat => ({ id, displayName: candidateDocs.get(`identities/${id}`)!.displayName ?? "" });
  // Partners take the first colonies in pick order and the joiner the last; each holds every seat of its colony.
  const made = await queuedMatchWrites(read, {
    mode, colonies: table.colonies === 4 ? [...picks.map((id) => [seatOf(id)]), [joiner]] : pairColonies(table.size, seatOf(picks[0]!), joiner),
  }, at);
  const lobbyId = made.lobby.id;
  // A waiting partner may not read its token again for hours: its record follows the lobby from this commit, with the
  // lobby's own limit, so it is never swept on its queue expiry while the lobby still waits (src/lobby/waits.ts).
  const partnerWrites: Write[] = [];
  for (const pick of picks) {
    partnerWrites.push({ op: "update", path: entryPath(pick), fields: { state: "matched", lobbyId } });
    const partnerToken = candidateDocs.get(entryPath(pick))?.waitToken;
    const partnerWait = partnerToken && isWaitToken(partnerToken) ? (await read([waitPath(partnerToken)])).get(waitPath(partnerToken)) : null;
    if (partnerWait?.kind === "queue" && partnerWait.joinedAt === candidateDocs.get(entryPath(pick))?.joinedAt) {
      partnerWrites.push(...await repointWrites(read, indexes, partnerToken!, lobbyId, pick, made.lobby.expiresAt, "unread"));
    }
  }
  // The joiner's own token is bound to the paired lobby the same way, from its first write.
  const ownWait = waitToken && isWaitToken(waitToken)
    ? await matchedQueueWaitWrites(read, indexes, waitToken, lobbyId, joiner.id, made.lobby.expiresAt)
    : [];
  return {
    result: { ok: true, value: { state: "matched", mode, lobbyId, matchedAt: at } },
    writes: [
      ...made.writes,
      ...partnerWrites,
      ...ownWait,
      ownWrite({ mode, joinedAt: String(at), state: "matched", lobbyId, waitToken }),
      ...listWrite(waiting.filter((id) => !picks.includes(id))),
    ],
  };
}

/** The list in a uniformly random order (Fisher-Yates with the queue's random). */
function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The first `count` ids, in order, whose owners differ from each other and from `taken`; fewer when there are not enough. */
function distinctOwners(ids: readonly string[], ownerOfId: (id: string) => string, taken: string, count: number): string[] {
  const owners = new Set([taken]);
  const picked: string[] = [];
  for (const id of ids) {
    if (picked.length === count) break;
    const owner = ownerOfId(id);
    if (owners.has(owner)) continue;
    owners.add(owner);
    picked.push(id);
  }
  return picked;
}

/**
 * A queue wait (src/lobby/waits.ts), from the identity's entry as stored now and the joinedAt of the join that
 * issued its token. An entry from another join (left, or replaced by a later join) or none at all ended; a matched
 * entry is paired (the caller re-points the token to its lobby); a waiting one waits until its lifetime ends, then ran out of time. Reads nothing, writes nothing.
 */
export function queueWait(entry: Fields | null, joinedAt: string, at: number): WaitState {
  if (!entry || entry.joinedAt !== joinedAt || !isQueueMode(entry.mode)) return { state: "expired", reason: "ended" };
  if (entry.state === "matched" && entry.lobbyId) return { state: "paired", lobbyId: entry.lobbyId, lobbyWait: true };
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
export interface WaitingEntry { readonly identityId: string; readonly mode: QueueMode; readonly joinedAt: number }

/**
 * Every live waiting entry across QUEUE_MODES, oldest first, read without a transaction and writing nothing.
 * Liveness is isLive at `at`, as every queue step derives it: an expired entry keeps its stored state "waiting" for good
 * and may still be listed until the next join prunes it, so neither the
 * stored state nor queueWaiting is trusted alone.
 */
export async function waitingEntries(get: (path: string) => Promise<Fields | null>, at: number): Promise<WaitingEntry[]> {
  const modes = Object.keys(QUEUE_MODES).filter(isQueueMode);
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
