import { createHash } from "node:crypto";
import { readMany, type Fields, type Store } from "../store/firestore.js";
import { boundedReads } from "../store/join-reads.js";
import { ownershipPath, replayOwners, readReplayOwners, type WatchRegistry } from "../live/watch-registry.js";

/** A username identity id as stored: a lowercase UUID. */
const IDENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Private operator configuration. Its contents never belong in an error or public response. */
export function publicExcludedOwnerIdsFromEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const value = env.ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS;
  if (value === undefined || value.trim() === "") return [];
  const ids = value.split(",").map(id => id.trim().toLowerCase());
  if (ids.some(id => !IDENTITY_ID.test(id))) {
    throw new Error("invalid ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: use comma-separated username identity UUIDs");
  }
  return [...new Set(ids)];
}

/** Read the configuration as one snapshot, binding its digest to the very policy that filters the build. */
export function usersOwnerPolicy(read: () => readonly string[], store?: Store, registry?: Pick<WatchRegistry, "replayLobby">) {
  return () => {
    const ids = [...new Set(read())].sort();
    if (ids.length && (!store || !registry)) throw new Error("Public visibility unavailable");
    const digest = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
    return { digest, visibility: store && registry ? createPublicVisibility(store, registry, ids) : undefined };
  };
}

/** The hide list applies to every public view of a match, without changing play or ratings. */
export interface PublicVisibility {
  replaysVisibleEach?(ids: readonly string[], signal: AbortSignal, lobbyLimit?: number): Promise<ReadonlySet<string>>;
  identitiesVisible(ids: readonly string[]): Promise<boolean>;
  lobbyVisible(id: string): Promise<boolean>;
  replayVisible(id: string, signal?: AbortSignal): Promise<boolean>;
}

/** Many checks answered with one identities read, so a page of rows costs a fixed number of reads. */
export interface BatchPublicVisibility extends PublicVisibility {
  /** Each id's own visibility. */
  identitiesVisibleEach(ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, boolean>>;
  /** Each lobby's visibility from its already-read record; a missing (null) record fails the check. */
  lobbiesVisibleEach(lobbies: ReadonlyMap<string, Fields | null>, signal?: AbortSignal): Promise<ReadonlyMap<string, boolean>>;
}

/** Undefined means off: callers retain their original behavior and perform no additional reads. */
export function createPublicVisibility(store: Store, registry: Pick<WatchRegistry, "replayLobby">,
  ownerIds: readonly string[]): BatchPublicVisibility | undefined {
  if (ownerIds.length === 0) return undefined;
  const excluded = new Set(ownerIds);
  const unavailable = () => new Error("Public visibility temporarily unavailable");
  /**
   * The stored records cannot say who played (no readable seats, or a seat identity that does not resolve). Every public
   * check fails on it as unavailable, except a recording's, which is then hidden (replayVisible).
   */
  class Undetermined extends Error {}
  const undetermined = () => new Undetermined("Public visibility undetermined");
  /**
   * Whether every id of each group is visible. A group naming an excluded id is hidden without reading it; the
   * rest are read together in one transaction.
   */
  function ownerOf(id: string, fields: Fields | null | undefined) {
    if (fields?.kind === "username") return id;
    if (fields?.kind === "handle" && IDENTITY_ID.test(fields.ownerId ?? "")) return fields.ownerId!;
    throw undetermined();
  }
  const groupsVisible = async (groups: readonly (readonly string[])[], signal?: AbortSignal): Promise<boolean[]> => {
    const open = groups.map(ids => !ids.some(id => excluded.has(id)));
    const unique = [...new Set(groups.filter((_, index) => open[index]).flat())];
    if (unique.length === 0) return open;
    const owners = await store.transaction(async read => {
      const docs = await read(unique.map(id => `identities/${id}`));
      const result = new Map(unique.map(id => {
        return [id, ownerOf(id, docs.get(`identities/${id}`))];
      }));
      return { result, writes: [] };
    }, signal);
    return groups.map((ids, index) => open[index]! && ids.every(id => !excluded.has(owners.get(id)!)));
  };
  const seatIds = (lobby: Fields | null): string[] => {
    // A lobby whose seats are not recorded cannot show who played, so it is not shown at all.
    if (!lobby || lobby.seats === undefined) throw undetermined();
    let seats: unknown;
    try { seats = JSON.parse(lobby.seats); } catch { throw undetermined(); }
    if (!Array.isArray(seats)) throw undetermined();
    return seats.map((seat: unknown) => {
      if (typeof seat !== "object" || seat === null || !("id" in seat) || typeof seat.id !== "string") throw undetermined();
      return seat.id;
    });
  };
  const identitiesVisible = async (ids: readonly string[]) => (await groupsVisible([ids]))[0]!;
  const lobbyVisible = async (id: string) => (await groupsVisible([seatIds(await store.get(`lobbies/${id}`))]))[0]!;
  const safe = <T, R>(read: (value: T, signal?: AbortSignal) => Promise<R>) => async (value: T, signal?: AbortSignal): Promise<R> => {
    try { return await read(value, signal); } catch { throw unavailable(); }
  };
  return {
    identitiesVisible: safe(identitiesVisible), lobbyVisible: safe(lobbyVisible),
    identitiesVisibleEach: safe(async (ids: readonly string[], signal) => {
      const unique = [...new Set(ids)];
      const visible = await groupsVisible(unique.map(id => [id]), signal);
      return new Map(unique.map((id, index) => [id, visible[index]!]));
    }),
    lobbiesVisibleEach: safe(async (lobbies: ReadonlyMap<string, Fields | null>, signal) => {
      const ids = [...lobbies.keys()];
      const visible = await groupsVisible(ids.map(id => seatIds(lobbies.get(id)!)), signal);
      return new Map(ids.map((id, index) => [id, visible[index]!]));
    }),
    async replaysVisibleEach(ids, signal, lobbyLimit = 20) {
      try {
        const ownership = await readMany(store, ids.map(ownershipPath), signal);
        const visible = new Set<string>(), legacy: string[] = [];
        for (const id of ids) {
          const owners = replayOwners(ownership.get(ownershipPath(id)) ?? null);
          if (!owners) legacy.push(id);
          else if (owners.every(owner => !excluded.has(owner))) visible.add(id);
        }
        const links = await boundedReads(legacy, Math.min(20, lobbyLimit), async id => ({ id, lobby: await registry.replayLobby(id, signal) }), signal);
        const linked = links.flatMap(({ id, lobby }) => lobby.state === "found" ? [{ id, path: `lobbies/${lobby.lobbyId}` }] : []);
        const lobbies = await readMany(store, linked.map(link => link.path), signal);
        const groups = linked.flatMap(({ id, path }) => {
          try {
            const seats = seatIds(lobbies.get(path) ?? null);
            return seats.length && !seats.some(seat => excluded.has(seat)) ? [{ id, seats }] : [];
          } catch (error) { if (error instanceof Undetermined) return []; throw error; }
        });
        const identities = await readMany(store, [...new Set(groups.flatMap(group => group.seats.map(seat => `identities/${seat}`)))], signal);
        for (const { id, seats } of groups) {
          try {
            if (seats.every(seat => !excluded.has(ownerOf(seat, identities.get(`identities/${seat}`))))) visible.add(id);
          } catch (error) { if (!(error instanceof Undetermined)) throw error; }
        }
        return visible;
      } catch { throw unavailable(); }
    },
    replayVisible: safe(async (id: string, signal) => {
      const owners = await readReplayOwners(store, id, signal);
      if (owners !== null) return owners.every(owner => !excluded.has(owner));
      const found = await registry.replayLobby(id, signal);
      // A recording without ownership is shown only when its lobby establishes every player and none is excluded. One
      // whose players cannot be established is hidden rather than failing the read: no lobby link (a scheduled match, or
      // a link never published), a link still pending (in flight or never completed), or a lobby whose seats are missing,
      // unreadable or empty, or whose seat identities do not resolve. A failed read still fails.
      if (found.state !== "found") return false;
      try {
        const seats = seatIds(await store.get(`lobbies/${found.lobbyId}`, signal));
        if (seats.length === 0) return false;
        return (await groupsVisible([seats], signal))[0]!;
      } catch (error) {
        if (error instanceof Undetermined) return false;
        throw error;
      }
    }),
  };
}

/**
 * Stable order and continuation ownership stay with the caller. Rejections fail the read, not open the policy. Once signal
 * aborts, no further check starts and the read fails.
 */
export async function publiclyVisible<T>(rows: readonly T[], visible: (row: T) => Promise<boolean>, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) { signal?.throwIfAborted(); if (await visible(row)) out.push(row); }
  return out;
}
