import type { Fields, Store } from "../store/firestore.js";
import { readReplayOwners, type WatchRegistry } from "../live/watch-registry.js";

/** Private operator configuration. Its contents never belong in an error or public response. */
export function publicExcludedOwnerIdsFromEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const value = env.ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS;
  if (value === undefined || value.trim() === "") return [];
  const ids = value.split(",").map(id => id.trim().toLowerCase());
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("invalid ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: use comma-separated username identity UUIDs");
  }
  return [...new Set(ids)];
}

/** The hide list applies to every public view of a match, without changing play or ratings. */
export interface PublicVisibility {
  identitiesVisible(ids: readonly string[]): Promise<boolean>;
  lobbyVisible(id: string): Promise<boolean>;
  replayVisible(id: string): Promise<boolean>;
}

/** Many checks answered with one identities read, so a page of rows costs a fixed number of reads. */
export interface BatchPublicVisibility extends PublicVisibility {
  /** Each id's own visibility. */
  identitiesVisibleEach(ids: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** Each lobby's visibility from its already-read record; a missing (null) record fails the check. */
  lobbiesVisibleEach(lobbies: ReadonlyMap<string, Fields | null>): Promise<ReadonlyMap<string, boolean>>;
}

/** Undefined means off: callers retain their original behavior and perform no additional reads. */
export function createPublicVisibility(store: Store, registry: Pick<WatchRegistry, "replayLobby">,
  ownerIds: readonly string[]): BatchPublicVisibility | undefined {
  if (ownerIds.length === 0) return undefined;
  const excluded = new Set(ownerIds);
  const unavailable = () => new Error("Public visibility temporarily unavailable");
  /**
   * Whether every id of each group is visible. A group naming an excluded id is hidden without reading it; the
   * rest are read together in one transaction.
   */
  const groupsVisible = async (groups: readonly (readonly string[])[]): Promise<boolean[]> => {
    const open = groups.map(ids => !ids.some(id => excluded.has(id)));
    const unique = [...new Set(groups.filter((_, index) => open[index]).flat())];
    if (unique.length === 0) return open;
    const owners = await store.transaction(async read => {
      const docs = await read(unique.map(id => `identities/${id}`));
      const result = new Map(unique.map(id => {
        const fields = docs.get(`identities/${id}`);
        // Read retained identity relations directly, independently of current name/credential validity.
        if (!fields || (fields.kind !== "username" && fields.kind !== "handle") ||
          (fields.kind === "handle" && !fields.ownerId)) throw unavailable();
        return [id, fields.kind === "handle" ? fields.ownerId! : id];
      }));
      return { result, writes: [] };
    });
    return groups.map((ids, index) => open[index]! && ids.every(id => !excluded.has(owners.get(id)!)));
  };
  const seatIds = (lobby: Fields | null): string[] => {
    if (!lobby) throw unavailable();
    let seats: unknown;
    try { seats = JSON.parse(lobby.seats ?? "[]"); } catch { throw unavailable(); }
    if (!Array.isArray(seats)) throw unavailable();
    return seats.map((seat: unknown) => {
      if (typeof seat !== "object" || seat === null || !("id" in seat) || typeof seat.id !== "string") throw unavailable();
      return seat.id;
    });
  };
  const identitiesVisible = async (ids: readonly string[]) => (await groupsVisible([ids]))[0]!;
  const lobbyVisible = async (id: string) => (await groupsVisible([seatIds(await store.get(`lobbies/${id}`))]))[0]!;
  const safe = <T, R>(read: (value: T) => Promise<R>) => async (value: T): Promise<R> => {
    try { return await read(value); } catch { throw unavailable(); }
  };
  return {
    identitiesVisible: safe(identitiesVisible), lobbyVisible: safe(lobbyVisible),
    identitiesVisibleEach: safe(async (ids: readonly string[]) => {
      const unique = [...new Set(ids)];
      const visible = await groupsVisible(unique.map(id => [id]));
      return new Map(unique.map((id, index) => [id, visible[index]!]));
    }),
    lobbiesVisibleEach: safe(async (lobbies: ReadonlyMap<string, Fields | null>) => {
      const ids = [...lobbies.keys()];
      const visible = await groupsVisible(ids.map(id => seatIds(lobbies.get(id)!)));
      return new Map(ids.map((id, index) => [id, visible[index]!]));
    }),
    replayVisible: safe(async (id: string) => {
      const owners = await readReplayOwners(store, id);
      if (owners !== null) return owners.every(owner => !excluded.has(owner));
      const found = await registry.replayLobby(id);
      if (found.state === "pending") throw unavailable();
      // Older recordings without ownership retain their historical behavior; pending is not absence.
      return found.state === "none" || lobbyVisible(found.lobbyId);
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
