import { parseName } from "../identity/identities.js";
import { identityDisplay, nameState } from "../identity/retention.js";
import { readMany, type Store } from "../store/firestore.js";
import type { RecordingLobby, RecordingLobbyLookup, TypedHistorySummary } from "./history-routes.js";
import { isHouseHandle } from "./recorded-match-type.js";
import { joinReads } from "../store/join-reads.js";

type Seat = RecordingLobby["colonies"][number][number];
export type CurrentRosterSeats = (seats: readonly Seat[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

/** Read the current name of each stable lobby seat in two batched reads. The name index must still name
 * that seat's owner, and its retention period must not have expired (even before tombstone cleanup). */
export function currentRosterSeats(store: Store, now = Date.now): CurrentRosterSeats {
  return async (seats, signal) => {
    const paths = new Set<string>();
    for (const { id, displayName } of seats) {
      const name = parseName(displayName.split("/", 1)[0]!);
      if (!name || isHouseHandle(name.canonical)) continue;
      paths.add(`identities/${id}`); paths.add(`usernames/${name.canonical}`);
    }
    const docs = await readMany(store, [...paths], signal);
    const missing = new Set<string>();
    for (const { id } of seats) {
      const child = docs.get(`identities/${id}`);
      if (child?.kind === "handle" && child.ownerId && !docs.has(`identities/${child.ownerId}`)) missing.add(`identities/${child.ownerId}`);
    }
    const owners = await readMany(store, [...missing], signal), at = now();
    const names = new Map<string, string>();
    for (const { id, displayName } of seats) {
      const seat = docs.get(`identities/${id}`), name = parseName(displayName.split("/", 1)[0]!);
      const ownerId = seat?.kind === "username" ? id : seat?.kind === "handle" ? seat.ownerId : undefined;
      if (!seat || !ownerId || !name || docs.get(`usernames/${name.canonical}`)?.identityId !== ownerId) continue;
      const key = `identities/${ownerId}`, owner = docs.get(key) ?? owners.get(key);
      if (owner?.kind !== "username" || owner.canonical !== name.canonical || nameState(owner, at) !== "claimed") continue;
      const current = identityDisplay(id, seat, ownerId, owner);
      if (current === displayName) names.set(id, current);
    }
    return names;
  };
}

export type AttributeRoster = (rows: TypedHistorySummary[], lookup: RecordingLobbyLookup | undefined, signal: AbortSignal) => Promise<TypedHistorySummary[]>;
/** Join by colony and the immutable lobby seat's recorded name, never by the ordering of stream joins.
 * An absent or ambiguous seat provides no attribution. The recorded model remains available for display. */
export function attributeRoster(current: CurrentRosterSeats): AttributeRoster {
  return async (rows, lookup, signal) => {
    const lobbies = await joinReads(rows.map(row => lookup?.(row.id, signal)));
    const seats = lobbies.flatMap(lobby => lobby && lobby !== "pending" && !lobby.test ? lobby.colonies.flat() : []);
    const names = await current(seats, signal);
    return rows.map((row, i) => {
      const lobby = lobbies[i];
      return { ...row, seats: row.seats.map(seat => {
        if (!seat.handle || isHouseHandle(seat.handle.toLowerCase())) return seat;
        const evidence = lobby && lobby !== "pending" && !lobby.test ? lobby.colonies[seat.colony]?.filter(s => s.displayName === seat.handle) : undefined;
        return evidence?.length && evidence.every(s => names.get(s.id) === seat.handle) ? seat : { ...seat, handle: null };
      }) };
    });
  };
}
