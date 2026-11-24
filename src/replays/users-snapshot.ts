import type { TypedHistorySummary } from "./history-routes.js";
import type { UserMatch } from "./public-users.js";

// Writers and listing routes can be constructed separately. One process-local stamp also
// fences builds that were in progress when the write committed. Other instances recheck on expiry.
let revision = 0;
export const usersRevision = () => revision;
export function invalidateUsers() { ++revision; }

/** Only the old listing's tally inputs, not a source for the next storage scan. If the complete
 * set won't fit, keep none: a partial set must never certify the counts of a whole snapshot. */
export function snapshotContributions() {
  let bytes = 0, entries: string[] | undefined = [];
  return {
    add({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats }: TypedHistorySummary) {
      if (!entries) return;
      const text = JSON.stringify({ id, startedAt, status, winner, reason, decidedBy, matchType, colonyNames, seats } satisfies UserMatch);
      bytes += Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024) entries = undefined;
      else entries.push(text);
    },
    rows: () => entries?.map(text => JSON.parse(text) as UserMatch),
    get available() { return entries !== undefined; },
  };
}
