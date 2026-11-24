interface ColonyEvidence {
  readonly winner?: number | null;
  readonly seats?: readonly { colony: number }[];
  readonly matchType?: { kind: string; size?: number | null } | null;
  readonly colonyNames?: readonly string[] | null;
}

/** How many colonies a listed recording has: four for a four-colony (Quadrants) match, which its type, its four names, its
 * winner or a seat of colony 2 or 3 shows; three only when explicitly named, two otherwise.
 * Never reinterpret an incomplete four-colony record as a three-colony match. */
export function recordedColonies(r: ColonyEvidence): 2 | 3 | 4 {
  if (r.colonyNames?.length === 3 && r.matchType?.kind !== "quadrants" && (r.winner ?? 0) < 3
    && !(r.seats ?? []).some(seat => seat.colony === 3)) return 3;
  const four = r.matchType?.kind === "quadrants" || r.colonyNames?.length === 4 || (r.winner ?? 0) > 1 || (r.seats ?? []).some(seat => seat.colony > 1);
  return four ? 4 : 2;
}

/** A match known never joined: a "complete" record (its seats verified against the match log) that holds no seat for one
 * of its colonies, or none at all. Such a match was never played. Any other record keeps its row: a "partial" record may
 * lack a colony that joined after the replay stopped, and an "unavailable" record carries no seat data, so neither shows
 * that a colony never joined. */
export const neverJoined = (r: ColonyEvidence & { status: string; seats: readonly { colony: number }[] }): boolean =>
  r.status === "complete" && Array.from({ length: recordedColonies(r) }, (_, colony) => colony).some(colony => !r.seats.some(seat => seat.colony === colony));
