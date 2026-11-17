import type { Store } from "../store/firestore.js";
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

/** Undefined means off: callers retain their original behavior and perform no additional reads. */
export function createPublicVisibility(store: Store, registry: Pick<WatchRegistry, "replayLobby">,
  ownerIds: readonly string[]): PublicVisibility | undefined {
  if (ownerIds.length === 0) return undefined;
  const excluded = new Set(ownerIds);
  const unavailable = () => new Error("Public visibility temporarily unavailable");
  const identitiesVisible = async (ids: readonly string[]): Promise<boolean> => {
    if (ids.some(id => excluded.has(id))) return false;
    const unique = [...new Set(ids)];
    return store.transaction(async read => {
      const docs = await read(unique.map(id => `identities/${id}`));
      const owners = unique.map(id => {
        const fields = docs.get(`identities/${id}`);
        // Read retained identity relations directly, independently of current name/credential validity.
        if (!fields || (fields.kind !== "username" && fields.kind !== "handle") ||
          (fields.kind === "handle" && !fields.ownerId)) throw unavailable();
        return fields.kind === "handle" ? fields.ownerId! : id;
      });
      return { result: owners.every(id => !excluded.has(id)), writes: [] };
    });
  };
  const lobbyVisible = async (id: string): Promise<boolean> => {
    const lobby = await store.get(`lobbies/${id}`);
    if (!lobby) throw unavailable();
    let seats: unknown;
    try { seats = JSON.parse(lobby.seats ?? "[]"); } catch { throw unavailable(); }
    if (!Array.isArray(seats)) throw unavailable();
    const ids = seats.map((seat: unknown) => {
      if (typeof seat !== "object" || seat === null || !("id" in seat) || typeof seat.id !== "string") throw unavailable();
      return seat.id;
    });
    return identitiesVisible(ids);
  };
  const safe = <T>(read: (value: T) => Promise<boolean>) => async (value: T): Promise<boolean> => {
    try { return await read(value); } catch { throw unavailable(); }
  };
  return {
    identitiesVisible: safe(identitiesVisible), lobbyVisible: safe(lobbyVisible),
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

/** Stable order and continuation ownership stay with the caller. Rejections fail the read, not open the policy. */
export async function publiclyVisible<T>(rows: readonly T[], visible: (row: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) if (await visible(row)) out.push(row);
  return out;
}
