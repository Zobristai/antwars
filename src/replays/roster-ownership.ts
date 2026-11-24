import { parseName } from "../identity/identities.js";
import { identityDisplay, nameState } from "../identity/retention.js";
import { readMany, type Store } from "../store/firestore.js";
import type { RecordingLobby, RecordingLobbyLookup, TypedHistorySummary } from "./history-routes.js";
import { isHouseHandle } from "./recorded-match-type.js";
import { joinReads } from "../store/join-reads.js";

type Seat = RecordingLobby["colonies"][number][number];
export type CurrentRosterSeats = (seats: readonly Seat[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

/** Start from the stable identity in the lobby, never from who holds its recorded name today. Batch the
 * seat, owner and claim reads. A name index must still point to its owner and its claim must not have expired. */
export function currentRosterSeats(store: Store, now = Date.now): CurrentRosterSeats {
  return async (seats, signal) => {
    const seatIds = [...new Set(seats.map(seat => seat.id))];
    const docs = await readMany(store, seatIds.map(id => `identities/${id}`), signal);
    const owners = new Map<string, string>();
    for (const id of seatIds) {
      const seat = docs.get(`identities/${id}`);
      const owner = seat?.kind === "username" ? id : seat?.kind === "handle" ? seat.ownerId : undefined;
      if (owner) owners.set(id, owner);
    }
    const missing = [...new Set(owners.values())].map(id => `identities/${id}`).filter(path => !docs.has(path));
    const parentDocs = await readMany(store, missing, signal);
    const at = now(), candidates: { id: string; handle: string; claim: string; ownerId: string }[] = [];
    for (const [id, ownerId] of owners) {
      const path = `identities/${ownerId}`, owner = docs.get(path) ?? parentDocs.get(path);
      if (owner?.kind !== "username" || !owner.displayName || !owner.canonical || isHouseHandle(owner.canonical)
        || parseName(owner.displayName)?.canonical !== owner.canonical || nameState(owner, at) !== "claimed") continue;
      const handle = identityDisplay(id, docs.get(`identities/${id}`)!, ownerId, owner);
      candidates.push({ id, handle, claim: `usernames/${owner.canonical}`, ownerId });
    }
    const claims = await readMany(store, [...new Set(candidates.map(s => s.claim))], signal);
    return new Map(candidates.filter(s => claims.get(s.claim)?.identityId === s.ownerId).map(s => [s.id, s.handle]));
  };
}

/** A historical name is usable only if every matching seat resolves to the same present identity. */
export function agreedHandles(seats: readonly Seat[], current: ReadonlyMap<string, string>) {
  const targets = new Map<string, string | null>();
  for (const seat of seats) {
    const name = current.get(seat.id) ?? null;
    if (!targets.has(seat.displayName)) targets.set(seat.displayName, name);
    else if (targets.get(seat.displayName) !== name) targets.set(seat.displayName, null);
  }
  return targets;
}

/** Seat order in a stream is join order, not lobby order. Match the historical label inside its colony.
 * The directory counts the current handle; the archive retains the historical text with a separate destination. */
export async function attributeRoster(rows: TypedHistorySummary[], lookup: RecordingLobbyLookup | undefined,
  current: CurrentRosterSeats, signal: AbortSignal, mode: "directory" | "archive"): Promise<TypedHistorySummary[]> {
  const lobbies = await joinReads(rows.map(row => lookup?.(row.id, signal)));
  const eligible = lobbies.map(lobby => lobby && lobby !== "pending" && !lobby.test ? lobby.colonies : []);
  const names = await current(eligible.flat(2), signal);
  return rows.map((row, i) => {
    const colonies = eligible[i]!.map(seats => agreedHandles(seats, names));
    return { ...row, seats: row.seats.map(seat => {
      if (!seat.handle || isHouseHandle(seat.handle.toLowerCase())) return seat;
      const handle = colonies[seat.colony]?.get(seat.handle) ?? null;
      return mode === "directory" ? { ...seat, handle } : { ...seat, rosterUser: handle?.split("/", 1)[0] ?? null };
    }) };
  });
}
