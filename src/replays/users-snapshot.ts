import type { TypedHistorySummary } from "./history-routes.js";
import { recordedColonies } from "./listed-colonies.js";
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

// Each chunk holds whole newline-prefixed JSON records. A bounded bitmap skips most
// negative id searches; a possible hit is confirmed against the id at the start of a record.
const PAGE_BYTES = 64 * 1024, BUILD_BYTES = 32 * 1024 * 1024, RETAIN_BYTES = 2 * 1024 * 1024;
export function snapshotContributions() {
  const index = new Uint8Array(8192), pages: { buffer: Buffer; used: number }[] = [];
  let allocated = index.byteLength;
  function bit(id: string) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = Math.imul(31, hash) + id.charCodeAt(i);
    return hash & 0xffff;
  }
  return {
    has(id: string) {
      const n = bit(id);
      if (!(index[n >> 3]! & (1 << (n & 7)))) return false;
      const prefix = Buffer.from(`\n{"id":${JSON.stringify(id)},`);
      return pages.some(({ buffer, used }) => buffer.subarray(0, used).includes(prefix));
    },
    add(row: TypedHistorySummary) {
      const { id, startedAt, matchType, seats, winner, reason, decidedBy } = row;
      const text = JSON.stringify({ id, startedAt, matchType, colonies: recordedColonies(row),
        outcome: reason === "abandoned" ? "abandoned" : decidedBy === "draw" ? "draw" : winner,
        seats: seats.map(({ colony, handle, modelLabel, thinkingLevel, serviceTier }) => ({ colony, handle, modelLabel, thinkingLevel, serviceTier })),
      } satisfies UserMatch);
      const bytes = Buffer.byteLength(text) + 1;
      let page = pages.at(-1);
      if (!page || page.buffer.length - page.used < bytes) {
        // Include unused page space, the id index and a conservative allowance per page header.
        const header = 256, size = Math.min(Math.max(bytes, PAGE_BYTES), BUILD_BYTES - allocated - header);
        if (size < bytes) {
          console.warn("Users listing exceeds the 32 MiB build limit");
          throw new Error("Users listing contribution limit");
        }
        allocated += size + header;
        pages.push(page = { buffer: Buffer.allocUnsafeSlow(size), used: 0 });
      }
      page.buffer[page.used++] = 10;
      page.used += page.buffer.write(text, page.used);
      const n = bit(id); index[n >> 3] = index[n >> 3]! | (1 << (n & 7));
    },
    *batches() {
      let batch: UserMatch[] = [];
      for (const { buffer, used } of pages) {
        let start = 1;
        while (start < used) {
          const next = buffer.subarray(0, used).indexOf(10, start), end = next < 0 ? used : next;
          batch.push(JSON.parse(buffer.toString("utf8", start, end)) as UserMatch);
          if (batch.length === 100) { yield batch; batch = []; }
          start = end + 1;
        }
      }
      if (batch.length) yield batch;
    },
    get retainable() { return allocated <= RETAIN_BYTES; },
  };
}
