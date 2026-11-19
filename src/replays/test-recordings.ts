import type { Store } from "../store/firestore.js";
import { isReplayId } from "./access.js";

/**
 * The recording-level test marker: testRecordings/<replay id> exists exactly when that recording is of a test match. A slot
 * writes it before the recording is published (src/live/watch-controller.ts), and the one-time backfill
 * (src/replays/testBackfill.ts) writes it for test matches recorded before the match type existed, so a recording is known
 * to be a test whether or not a lobby record exists. A test recording is left out of every public list; its direct links
 * still serve it.
 */
export const TEST_RECORDINGS = "testRecordings";
export const testRecordingPath = (replayId: string) => `${TEST_RECORDINGS}/${replayId}`;

export interface TestRecordings {
  /** The ids among replayIds recorded as test, read in one batch; ids answered recently come from the cache. */
  marked(replayIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Record replayId as a test recording; marking it again changes nothing. */
  mark(replayId: string): Promise<void>;
}

/**
 * How long a "not test" answer is kept before it is read again: a recording made before the match type existed is marked
 * by the backfill as a server starts, so another server may still hold its earlier answer for this long. A "test" answer
 * is kept for good: a marker is never removed.
 */
export const UNMARKED_RECORDING_MS = 60_000;

export function createTestRecordings(store: Store, options: { readonly unmarkedMs?: number; readonly now?: () => number } = {}): TestRecordings {
  const unmarkedMs = options.unmarkedMs ?? UNMARKED_RECORDING_MS, now = options.now ?? Date.now;
  /** Replay id -> true (marked, kept for good) or the time a "not marked" answer expires. */
  const cache = new Map<string, true | number>();
  return {
    async marked(replayIds) {
      const unique = [...new Set(replayIds)].filter(isReplayId);
      const at = now();
      const unknown = unique.filter(id => { const hit = cache.get(id); return hit === undefined || (hit !== true && hit <= at); });
      if (unknown.length > 0) {
        // A transaction with no writes is rolled back: this is one batched read.
        const docs = await store.transaction(async read => ({ result: await read(unknown.map(testRecordingPath)), writes: [] }));
        for (const id of unknown) cache.set(id, docs.get(testRecordingPath(id)) ? true : at + unmarkedMs);
      }
      return new Set(unique.filter(id => cache.get(id) === true));
    },
    async mark(replayId) {
      if (!isReplayId(replayId)) throw new Error("Invalid test recording id");
      await store.transaction(async read => {
        const before = (await read([testRecordingPath(replayId)])).get(testRecordingPath(replayId));
        return { result: undefined, writes: before ? [] : [{ op: "create" as const, path: testRecordingPath(replayId), fields: { version: "1" } }] };
      });
      cache.set(replayId, true);
    },
  };
}
