import { isReplayId } from "./access.js";
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

// Replay ids encode an exact UTC millisecond and a positive safe-integer sequence. Both
// fit losslessly in doubles; zero sequence denotes a candidate absent from the answer.
export type Candidate = UserMatch | { id: string; seats: [] };
const PAGE_BYTES = 64 * 1024, BUILD_BYTES = 32 * 1024 * 1024, RETAIN_BYTES = 2 * 1024 * 1024;
const ID_BYTES = 16, HEADER = 256;
function listedIds(count: number) {
  const pairs = new Float64Array(count * 2);
  const time = (id: string) => Date.parse(`${id.slice(0, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}.${id.slice(20, 23)}Z`);
  return {
    set(i: number, id: string | undefined) {
      pairs[2 * i] = id ? time(id) : 0;
      pairs[2 * i + 1] = id ? Number(id.slice(25)) : 0;
    },
    listed(i: number) { return pairs[2 * i + 1] !== 0; },
    has(id: string) {
      if (!isReplayId(id)) return false;
      const at = time(id), seq = Number(id.slice(25));
      for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === at && pairs[i + 1] === seq) return true;
      return false;
    },
  };
}
function overLimit(): never {
  console.warn("Users listing exceeds the 32 MiB build limit");
  throw new Error("Users listing contribution limit");
}
export function snapshotContributions() {
  const pages: { buffer: Buffer; used: number }[] = [];
  let allocated = HEADER, indexBytes = 0;
  return {
    add(row: TypedHistorySummary, canContribute: boolean) {
      const { id, startedAt, matchType, seats, winner, reason, decidedBy } = row;
      const text = JSON.stringify(canContribute ? { id, startedAt, matchType, colonies: recordedColonies(row),
        outcome: reason === "abandoned" ? "abandoned" : decidedBy === "draw" ? "draw" : winner,
        seats: seats.map(({ colony, handle, modelLabel, thinkingLevel, serviceTier }) => ({ colony, handle, modelLabel, thinkingLevel, serviceTier })),
      } satisfies UserMatch : { id, seats: [] });
      // Reserve the exact index payload before accepting this candidate. A 256-byte
      // minimum slot (240 tally + 16 index) bounds the index alone to 1/16 of 32 MiB.
      const bytes = Math.max(240, Buffer.byteLength(text) + 1);
      indexBytes += ID_BYTES;
      if (allocated + indexBytes > BUILD_BYTES || indexBytes + HEADER > RETAIN_BYTES) overLimit();
      let page = pages.at(-1);
      if (!page || page.buffer.length - page.used < bytes) {
        // Include unused page space, the id index and a conservative allowance per page header.
        const size = Math.min(Math.max(bytes, PAGE_BYTES), BUILD_BYTES - allocated - indexBytes - HEADER);
        if (size < bytes) overLimit();
        allocated += size + HEADER;
        pages.push(page = { buffer: Buffer.allocUnsafeSlow(size), used: 0 });
      }
      const end = page.used + bytes;
      page.buffer[page.used++] = 10;
      page.used += page.buffer.write(text, page.used);
      page.buffer.fill(32, page.used, end); page.used = end;
    },
    *batches() {
      let batch: Candidate[] = [];
      for (const { buffer, used } of pages) {
        let start = 1;
        while (start < used) {
          const next = buffer.subarray(0, used).indexOf(10, start), end = next < 0 ? used : next;
          batch.push(JSON.parse(buffer.toString("utf8", start, end)) as Candidate);
          if (batch.length === 100) { yield batch; batch = []; }
          start = end + 1;
        }
      }
      if (batch.length) yield batch;
    },
    createIndex() { return listedIds(indexBytes / ID_BYTES); },
    // Keep only verified inputs for expiry: a newly unhidden row waits for a full scan.
    retainListed(ids: ReturnType<typeof listedIds>) {
      if (allocated + indexBytes > RETAIN_BYTES) return false;
      let i = 0;
      for (const page of pages) {
        const data = page.buffer.subarray(0, page.used);
        let write = 0;
        for (let pos = 0; pos < data.length;) {
          const newline = data.indexOf(10, pos + 1), end = newline < 0 ? data.length : newline;
          if (ids.listed(i++)) { data.copyWithin(write, pos, end); write += end - pos; }
          pos = end;
        }
        data.fill(0, write); page.used = write;
      }
      return true;
    },
  };
}
