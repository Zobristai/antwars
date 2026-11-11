/**
 * A rated replay shows its match's stored rating change record: matches rated before the
 * Glicko switch recorded Elo figures, and the recompute rewrote only the stored record, never
 * the immutable recording. The page reads that record once and restates the recorded figures with it,
 * so every renderer (player labels, the Agents table, result lines) shows it unchanged in form.
 * Without a record, or on any failure, the recording's own figures stay.
 */
import type { StreamIdentity, StreamMessage, StreamResult } from "../../src/live/format.ts";
import type { Colony } from "../../src/live/snapshot.ts";

export interface StoredRating { readonly before: number; readonly after: number }

/**
 * Stored figures by seat: keyed by colony and stream display name, the pair the recording carries
 * for every agent, so two identities sharing a name on opposite colonies each get their own. Rows from a
 * server that sends no colony are keyed by display name alone, as before.
 */
export interface StoredRatings { readonly byColony: boolean; readonly ratings: ReadonlyMap<string, StoredRating> }

const seatKey = (byColony: boolean, colony: Colony | undefined, displayName: string | undefined): string | undefined =>
  displayName === undefined ? undefined : byColony ? `${colony}:${displayName}` : displayName;

/** Null when the match has no stored record, it could not be read, or two seats share a key. */
export async function storedReplayRatings(replayId: string, invite: string | null, signal: AbortSignal, request: typeof fetch = fetch): Promise<StoredRatings | null> {
  try {
    const response = await request(`/watch/ratings/${encodeURIComponent(replayId)}`, {
      headers: invite ? { "x-antwar-invite": invite } : {},
      credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("ratings" in value) || !Array.isArray(value.ratings)) return null;
    const rows = value.ratings as unknown[];
    const byColony = rows.some(row => typeof row === "object" && row !== null && "colony" in row);
    const ratings = new Map<string, StoredRating>();
    for (const row of rows) {
      if (typeof row !== "object" || row === null) return null;
      const { colony, displayName, before, after } = row as Record<string, unknown>;
      if (typeof displayName !== "string" || (byColony && colony !== 0 && colony !== 1)) return null;
      const key = seatKey(byColony, colony as Colony, displayName)!;
      if (ratings.has(key) || typeof before !== "number" || !Number.isFinite(before) || typeof after !== "number" || !Number.isFinite(after)) return null;
      ratings.set(key, { before, after });
    }
    return ratings.size === 0 ? null : { byColony, ratings };
  } catch { return null; }
}

/**
 * Restates each message's pre-match ratings (identity.elo := stored before) and result changes
 * (stored before → after), matched by seat key. Agent keys are learnt from each full snapshot
 * and join event, in message order; a recording always opens, and every seek restarts, with a full snapshot.
 */
export function restateRatings({ byColony, ratings }: StoredRatings): (m: StreamMessage) => StreamMessage {
  let keys: (string | undefined)[] = [];
  const identity = <T extends { colony: Colony; identity?: StreamIdentity }>(value: T): T => {
    const rating = ratings.get(seatKey(byColony, value.colony, value.identity?.displayName) ?? "");
    return rating ? { ...value, identity: { ...value.identity!, elo: rating.before } } : value;
  };
  const result = (value: StreamResult): StreamResult => value.ratingChanges === undefined ? value : {
    ...value, ratingChanges: value.ratingChanges.map(change => {
      const rating = ratings.get(keys[change.agent] ?? "");
      return rating ? { ...change, before: rating.before, after: rating.after } : change;
    }),
  };
  return m => {
    if (m.full) keys = m.full.agents.map(agent => seatKey(byColony, agent.colony, agent.identity?.displayName));
    for (const event of m.events) if (event.kind === "join") keys[event.agent] = seatKey(byColony, event.colony, event.identity?.displayName);
    const full = m.full && { ...m.full, agents: m.full.agents.map(identity), result: m.full.result && result(m.full.result) };
    const events = m.events.map(event => event.kind === "join" ? identity(event) : event.kind === "end" ? { ...event, result: result(event.result) } : event);
    return { ...m, full, events };
  };
}
