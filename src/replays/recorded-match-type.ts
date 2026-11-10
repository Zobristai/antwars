import { HOUSE_USERNAME } from "../identity/houseOwnership.js";

/** What kind of match a recording was; the web words it (web/src/ui/format.ts), so no mode slug is ever shown. */
export type RecordingMatchKind = "index" | "ranked" | "unranked" | "challenge" | "unrated";
/** A recording's match type and agents per colony; size null where neither the lobby nor recorded seats tell it. */
export interface RecordingMatchType { readonly kind: RecordingMatchKind; readonly size: 1 | 2 | 3 | 4 | null }

/** The recorded facts a recording with no readable lobby is typed by. */
export interface RecordedMatch {
  readonly seats: readonly { readonly colony: 0 | 1; readonly handle: string | null }[];
  /** The record's setup.rated: false where its setup omits it, null (or absent) where it has no setup. */
  readonly rated?: boolean | null;
  /** The record's setup.modelIndex marker. */
  readonly modelIndex?: boolean;
}

const isHouseHandle = (handle: string) => handle === HOUSE_USERNAME || handle.startsWith(`${HOUSE_USERNAME}/`);

/**
 * A recording's match type from its own recorded facts, for a recording whose lobby cannot be read: its Model Index
 * marker, then unrated; rated with every seat handle an antwars one is the Index, rated with any other handle is Ranked.
 * Null (no badge) where that cannot be told: a rated record with no marker, no non-house handle and a blank handle (never
 * "Ranked" on the rated flag alone), and a record with no setup, whose rated flag is unknown.
 */
export function recordedMatchType(record: RecordedMatch): RecordingMatchType | null {
  const perColony = Math.max(...([0, 1] as const).map(colony => record.seats.filter(seat => seat.colony === colony).length));
  const size = perColony >= 1 && perColony <= 4 ? perColony as 1 | 2 | 3 | 4 : null;
  if (record.rated == null) return null;
  if (record.modelIndex) return { kind: "index", size };
  if (!record.rated) return { kind: "unrated", size };
  const handles = record.seats.map(seat => seat.handle);
  if (handles.some(handle => handle !== null && !isHouseHandle(handle))) return { kind: "ranked", size };
  if (handles.length > 0 && handles.every(handle => handle !== null)) return { kind: "index", size };
  return null;
}

/** "name #seat" is one identity holding several seats (web/src/compose.ts SEAT); the handle is the name alone. */
const SEAT_SUFFIX = /^(.+) #\d+$/;
export function seatHandle(identity: { readonly displayName: string } | undefined): string | null {
  if (identity === undefined) return null;
  return SEAT_SUFFIX.exec(identity.displayName)?.[1] ?? identity.displayName;
}
