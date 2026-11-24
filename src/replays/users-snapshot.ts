import type { TypedHistorySummary } from "./history-routes.js";
import type { UserMatch } from "./public-users.js";

// Writers and listing routes can be constructed separately. One process-local stamp also
// fences builds that were in progress when the write committed. Other instances recheck on expiry.
let revision = 0;
export const usersRevision = () => revision;
export function invalidateUsers() { ++revision; }

/** Keep the complete inputs until publication, even if they're too large to retain for expiry.
 * Each database check decodes only one batch. Nothing here can replace a storage scan. */
export function snapshotContributions() {
  let bytes = 0;
  const entries: string[] = [];
  return {
    add({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats }: TypedHistorySummary) {
      const text = JSON.stringify({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats } satisfies UserMatch);
      entries.push(text);
      bytes += Buffer.byteLength(text);
    },
    *batches() {
      for (let i = 0; i < entries.length; i += 100) yield entries.slice(i, i + 100).map(text => JSON.parse(text) as UserMatch);
    },
    get retainable() { return bytes <= 2 * 1024 * 1024; },
  };
}
