import type { TypedHistorySummary } from "./history-routes.js";
import type { UserMatch } from "./public-users.js";

// A new recording normally isn't in a listing yet. Remember which recording changed so that
// unrelated publications don't invalidate a checked answer. On overflow recheck conservatively.
const writes: string[] = [], limit = 1024;
let revision = 0;
export const usersRevision = () => revision;
export function invalidateUsers(id: string) { writes[revision++ % limit] = id; }
export function needsUsersCheck(since: number, facts?: { has(id: string): boolean }) {
  if (revision - since > limit) return true;
  for (let n = since; n < revision; n++) if (!facts || facts.has(writes[n % limit]!)) return true;
  return false;
}

/** Keep the complete inputs until publication, even if they're too large to retain for expiry.
 * Each database check decodes only one batch. Nothing here can replace a storage scan. */
export function snapshotContributions() {
  let bytes = 0;
  const entries: string[] = [], ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    add({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats }: TypedHistorySummary) {
      const text = JSON.stringify({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats } satisfies UserMatch);
      ids.add(id); entries.push(text);
      bytes += Buffer.byteLength(text);
    },
    *batches() {
      for (let i = 0; i < entries.length; i += 100) yield entries.slice(i, i + 100).map(text => JSON.parse(text) as UserMatch);
    },
    get retainable() { return bytes <= 2 * 1024 * 1024; },
  };
}
