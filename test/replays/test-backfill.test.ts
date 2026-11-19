import { describe, expect, it } from "vitest";
import type { ReplayLobby } from "../../src/live/watch-registry.ts";
import { backfillTestRecordings, startTestBackfill, TEST_BACKFILL_MARKER } from "../../src/replays/testBackfill.ts";
import { TEST_BACKFILL_IDS } from "../../src/replays/testBackfillIds.ts";
import { isReplayId } from "../../src/replays/access.ts";
import { createTestRecordings, testRecordingPath } from "../../src/replays/test-recordings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

// Fixtures shaped like the listed matches: a challenge with a lobby, a Free-for-all with a lobby, an unranked 1v1 with no
// scripted seat whose lobby is unreadable, and a rated match. The ids are synthetic.
const challenge = "2026-11-01T10-00-00-000Z-1", ffa = "2026-11-01T11-00-00-000Z-2", noLobby = "2026-11-01T12-00-00-000Z-3";
const rated = "2026-11-01T13-00-00-000Z-4", other = "2026-11-01T14-00-00-000Z-5";

function world() {
  const { store, docs } = memoryWatchStore();
  const lobbyOf: Record<string, ReplayLobby> = {
    [challenge]: { state: "found", lobbyId: "lobby-challenge" }, [ffa]: { state: "found", lobbyId: "lobby-ffa" },
    [noLobby]: { state: "none" }, [rated]: { state: "found", lobbyId: "lobby-rated" }, [other]: { state: "found", lobbyId: "lobby-other" },
  };
  docs.set("lobbies/lobby-challenge", { rated: "false", outcome: "colony_0_won", challengeId: "r" });
  docs.set("lobbies/lobby-ffa", { rated: "false", outcome: "colony_2_won", mode: "quadrants" });
  docs.set("lobbies/lobby-rated", { rated: "true", outcome: "draw", mode: "1v1" });
  docs.set("lobbies/lobby-other", { rated: "false", outcome: "colony_1_won" });
  const registry = { replayLobby: async (id: string) => lobbyOf[id] ?? { state: "none" as const } };
  return { store, docs, registry };
}

describe("the test recording backfill", () => {
  it("lists only well-formed public match ids, each once", () => {
    expect(TEST_BACKFILL_IDS.length).toBe(27);
    expect(new Set(TEST_BACKFILL_IDS).size).toBe(TEST_BACKFILL_IDS.length);
    expect(TEST_BACKFILL_IDS.every(isReplayId)).toBe(true);
  });

  it("marks every listed id with or without a lobby, counts rated ones, leaves others alone and logs no id", async () => {
    const w = world(), logged: unknown[] = [];
    const ids = [challenge, ffa, noLobby, rated];
    await startTestBackfill(w.store, w.registry, ids, (message, detail) => logged.push([message, detail]));
    for (const id of ids) expect(w.docs.has(testRecordingPath(id))).toBe(true);
    expect(w.docs.has(testRecordingPath(other))).toBe(false);
    expect(logged).toEqual([["antwar test recordings backfilled", { listed: 4, marked: 4, alreadyMarked: 0, rated: 1, withoutLobby: 1 }]]);
    for (const id of [...ids, other, "lobby-"]) expect(JSON.stringify(logged)).not.toContain(id);
    expect(w.docs.get(TEST_BACKFILL_MARKER)).toMatchObject({ listed: "4", marked: "4", rated: "1", withoutLobby: "1" });
    // Lobbies and ratings are unchanged: only markers were written.
    expect(w.docs.get("lobbies/lobby-rated")).toEqual({ rated: "true", outcome: "draw", mode: "1v1" });
    const marked = await createTestRecordings(w.store).marked([...ids, other]);
    expect([...marked].sort()).toEqual([...ids].sort());
  });

  it("does nothing once its marker is written, and an id already marked is not written again", async () => {
    const w = world(), logged: unknown[] = [];
    await createTestRecordings(w.store).mark(challenge);
    expect(await backfillTestRecordings(w.store, w.registry, [challenge, ffa])).toMatchObject({ listed: 2, marked: 1, alreadyMarked: 1 });
    await startTestBackfill(w.store, w.registry, [challenge], (message, detail) => logged.push([message, detail]));
    const before = new Map(w.docs);
    await startTestBackfill(w.store, w.registry, [other], (message, detail) => logged.push([message, detail]));
    expect(logged).toHaveLength(1);
    expect(new Map(w.docs)).toEqual(before);
    expect(w.docs.has(testRecordingPath(other))).toBe(false);
  });

  it("a failed run writes no marker, so the next start runs it again", async () => {
    const w = world();
    const failing = { replayLobby: async () => { throw new Error("store unavailable"); } };
    await startTestBackfill(w.store, failing, [challenge], () => {});
    expect(w.docs.has(TEST_BACKFILL_MARKER)).toBe(false);
    await startTestBackfill(w.store, w.registry, [challenge], () => {});
    expect(w.docs.has(TEST_BACKFILL_MARKER)).toBe(true);
    expect(w.docs.has(testRecordingPath(challenge))).toBe(true);
  });
});
