import type { Fields, Store, TransactionStep, Write } from "../store/firestore.js";
import type { WatchRegistry } from "../live/watch-registry.js";
import { testRecordingPath } from "./test-recordings.js";
import { TEST_BACKFILL_IDS } from "./testBackfillIds.js";

/** Written once the backfill has run; while it is present a start reads nothing else. */
export const TEST_BACKFILL_MARKER = "migrations/testRecordingBackfill";

/** A match result a rating step rates (src/lobby/lobbies.ts endMatch). */
const RATED_RESULT = /^(?:draw|colony_[0-3]_won)$/;

/** What one backfill did, by count only: no match id is ever logged. */
export interface TestBackfillCounts {
  /** Ids in the list. */
  readonly listed: number;
  /** Markers this run wrote. */
  readonly marked: number;
  /** Ids already marked. */
  readonly alreadyMarked: number;
  /** Listed matches whose lobby shows a rated result; their ratings and records are unchanged. */
  readonly rated: number;
  /** Listed matches whose lobby could not be read: marked all the same. */
  readonly withoutLobby: number;
}

/**
 * Marks each listed recording test (src/replays/test-recordings.ts), whether or not its lobby record exists. It writes only
 * the markers: no lobby, rating or record is changed, so a rated match keeps its rating and record and its leaderboard form
 * entry links no recording. Marking an id already marked changes nothing.
 */
export async function backfillTestRecordings(store: Store, registry: Pick<WatchRegistry, "replayLobby">,
  ids: readonly string[] = TEST_BACKFILL_IDS): Promise<TestBackfillCounts> {
  const unique = [...new Set(ids)];
  let rated = 0, withoutLobby = 0;
  for (const id of unique) {
    const found = await registry.replayLobby(id);
    const lobby = found.state === "found" ? await store.get(`lobbies/${found.lobbyId}`) : null;
    if (lobby === null) { withoutLobby++; continue; }
    if (lobby.rated === "true" && RATED_RESULT.test(lobby.outcome ?? "")) rated++;
  }
  const marked = await store.transaction(async (read): Promise<TransactionStep<number>> => {
    const docs = await read(unique.map(testRecordingPath));
    const writes: Write[] = unique.filter(id => !docs.get(testRecordingPath(id)))
      .map(id => ({ op: "create", path: testRecordingPath(id), fields: { version: "1" } }));
    return { result: writes.length, writes };
  });
  return { listed: unique.length, marked, alreadyMarked: unique.length - marked, rated, withoutLobby };
}

/**
 * backfillTestRecordings as the server runs it at start, once: with TEST_BACKFILL_MARKER present it reads nothing else.
 * Otherwise it marks, logs the counts (never an id), then writes the marker, so a later start never runs it again. A run
 * that fails is logged, never thrown, and writes no marker, so the next start tries again.
 */
export async function startTestBackfill(store: Store, registry: Pick<WatchRegistry, "replayLobby">,
  ids: readonly string[] = TEST_BACKFILL_IDS, log: (message: string, detail: object) => void = console.info): Promise<void> {
  try {
    if (await store.get(TEST_BACKFILL_MARKER) !== null) return;
    const counts = await backfillTestRecordings(store, registry, ids);
    log("antwar test recordings backfilled", counts);
    const fields: Fields = { completedAt: new Date().toISOString(), ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, String(value)])) };
    await store.transaction(async (read): Promise<TransactionStep<void>> => {
      const done = (await read([TEST_BACKFILL_MARKER])).get(TEST_BACKFILL_MARKER);
      return { result: undefined, writes: done ? [] : [{ op: "create", path: TEST_BACKFILL_MARKER, fields }] };
    });
  } catch (error) {
    console.warn("antwar test recording backfill failed", error instanceof Error ? error.message : String(error));
  }
}
