import { describe, expect, it } from "vitest";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { spectatorDelaySeconds } from "../../src/live/match-access.ts";

import { holdMatch, memoryWatchStore as memory } from "./watch-fixtures.ts";

const id = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const replayId = "2026-10-20T10-00-00-000Z-1";
const match = { lobbyId: id, visibility: "public" as const, rated: true, startedAt: 1000, origin: "http://127.0.0.1:9001", slot: "public-0", runId: "run-one" };

describe("durable spectator match identity", () => {
  it("retains the original stream origin and unfinished playback through immediate slot reuse", async () => {
    const { docs, store } = memory();
    const first = createWatchRegistry(store), other = createWatchRegistry(store);
    await first.register(match);
    holdMatch(docs, id, match.runId);
    await other.register({ ...match, lobbyId: nextId, startedAt: 2000, origin: "http://127.0.0.1:9002" });
    expect((await other.read(id))?.origin).toBe(match.origin);
    expect((await other.publicMatches()).map(row => row.lobbyId)).toEqual([id, nextId]);
    expect(await first.playbackFinished(id, match.runId)).toBe(true);
    expect((await other.publicMatches()).map(row => row.lobbyId)).toEqual([nextId]);
    expect(await first.replaySaved(id, match.runId, replayId)).toBe(true);
    expect(await other.read(id)).toMatchObject({ ...match, playbackFinished: true, replayId });
    await expect(first.replaySaved(id, match.runId, "2026-10-20T10-00-00-000Z-2")).rejects.toThrow("recording identity changed");
    await first.register(match); // Retry must not reset delayed completion or erase the recording.
    expect(await other.read(id)).toMatchObject({ playbackFinished: true, replayId });
  });
  it.each(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const)("round-trips immutable %s policy through the store and public index", async mode => {
    const { store } = memory(); const registry = createWatchRegistry(store);
    await registry.register({ ...match, mode });
    const reader = createWatchRegistry(store);
    expect(await reader.read(id)).toMatchObject({ mode });
    expect((await reader.publicMatches()).map(spectatorDelaySeconds)).toEqual([0]);
    await registry.register({ ...match, mode });
    await expect(registry.register({ ...match, mode: "1v1" })).rejects.toThrow("identity changed");
    await expect(registry.register(match)).rejects.toThrow("identity changed");
  });

  it("reads and retries legacy rows without granting a house exception or rewriting them", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    await registry.register(match);
    for (const path of [`watchMatches/${id}`, `watchPublic/${id}`]) {
      const { mode: _mode, ...legacy } = docs.get(path)!;
      docs.set(path, legacy);
    }
    const stored = structuredClone([...docs]);
    expect(spectatorDelaySeconds((await registry.read(id))!)).toBe(300);
    expect((await registry.publicMatches()).map(spectatorDelaySeconds)).toEqual([300]);
    await registry.register(match);
    expect([...docs]).toEqual(stored);
    await expect(registry.register({ ...match, mode: "house-1v1" })).rejects.toThrow("identity changed");
    docs.set(`watchMatches/${id}`, { ...docs.get(`watchMatches/${id}`)!, mode: "house-invented" });
    await expect(registry.read(id)).rejects.toThrow("Invalid spectator match access policy");
  });

  it("carries the seat labels its holding run publishes, on the match and its public listing, and reads a row without them as none", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    await registry.register(match);
    // A row written before labels were published, as an older server writes it, has none.
    expect((await registry.read(id))?.modelLabels).toBeUndefined();
    expect((await registry.publicMatches())[0]?.modelLabels).toBeUndefined();
    // Only the run holding the match may write them.
    expect(await registry.seatLabels(id, match.runId, { "kestrel-harness": "openai/gpt-6.1-terra" })).toBe(false);
    expect(docs.get(`watchMatches/${id}`)?.modelLabels).toBeUndefined();
    holdMatch(docs, id, match.runId);
    expect(await registry.seatLabels(id, "other-run", { "kestrel-harness": "openai/gpt-6.1-terra" })).toBe(false);
    expect(await registry.seatLabels(id, match.runId, { "kestrel-harness": "openai/gpt-6.1-terra" })).toBe(true);
    const labels = { "kestrel-harness": "openai/gpt-6.1-terra" };
    expect((await createWatchRegistry(store).read(id))?.modelLabels).toEqual(labels);
    expect((await createWatchRegistry(store).publicMatches())[0]?.modelLabels).toEqual(labels);
    // A handover keeps them; a malformed stored value reads as none rather than failing the catalog.
    expect(await registry.resumed({ ...match, origin: "http://127.0.0.1:9002" })).toBe(true);
    expect((await registry.read(id))?.modelLabels).toEqual(labels);
    for (const bad of ["not json", "[\"a\"]", "null", "{\"a\":3,\"b\":\"\"}"]) {
      docs.set(`watchPublic/${id}`, { ...docs.get(`watchPublic/${id}`)!, modelLabels: bad });
      const [row] = await registry.publicMatches();
      expect(row?.lobbyId).toBe(id);
      expect(Object.keys(row?.modelLabels ?? {})).toEqual([]);
    }
    // Playback's end still removes the listing.
    expect(await registry.playbackFinished(id, match.runId)).toBe(true);
    expect(await registry.publicMatches()).toEqual([]);
  });

  it("never writes a private public-list row and rejects replacement identity/origin", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    await registry.register({ ...match, visibility: "private", slot: "private-0" });
    expect(docs.has(`watchPublic/${id}`)).toBe(false);
    expect(await registry.publicMatches()).toEqual([]);
    await expect(registry.register(match)).rejects.toThrow("identity changed");
    expect(await registry.read("../private")).toBeNull();
    await expect(registry.register({ ...match, origin: "https://user:password@example.test" })).rejects.toThrow("origin");
  });
});

describe("stored rating outcome deltas", () => {
  it("retains the exact original transaction result after further matches and duplicate submission", async () => {
    const { docs, store } = memory();
    docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
    const ratings = createRatings(store);
    const result = { matchId: "first", teams: [["a"], ["b"]] as const, winner: "a" as const };
    const applied = await ratings.applyResult(result);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("fixture did not rate");
    expect(await ratings.readMatchChanges("first")).toEqual(applied.changes);
    await ratings.applyResult({ ...result, matchId: "second", winner: "b" });
    expect(await ratings.applyResult(result)).toEqual({ status: "already_applied" });
    expect(await ratings.readMatchChanges("first")).toEqual(applied.changes);
    expect((await ratings.readRating("a")).rating).not.toBe(applied.changes[0]!.after);
    expect(await ratings.readMatchChanges("missing")).toBeNull();
    docs.set("ratedMatches/legacy", {});
    expect(await ratings.readMatchChanges("legacy")).toBeNull();
  });
});

describe("lobby by recording id", () => {
  // The recording id names its stream's start: 2026-10-27T14:22:32.000Z.
  const startedAt = Date.parse("2026-10-27T14:22:32.000Z");
  const recording = "2026-10-27T14-22-32-000Z-77";
  it("finds the lobby whose saved recording it is, among matches started in the same and adjacent milliseconds", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    const lobbies = ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b", "00000000-0000-4000-8000-00000000000c", "00000000-0000-4000-8000-00000000000d"];
    for (const lobbyId of lobbies) holdMatch(docs, lobbyId, match.runId);
    const starts = [startedAt - 1, startedAt, startedAt, startedAt + 1];
    for (const [index, lobbyId] of lobbies.entries()) {
      await registry.register({ ...match, lobbyId, startedAt: starts[index]! });
      await registry.playbackFinished(lobbyId, match.runId);
    }
    await registry.replaySaved(lobbies[0]!, match.runId, "2026-10-27T14-22-31-999Z-77");
    await registry.replaySaved(lobbies[1]!, match.runId, "2026-10-27T14-22-32-000Z-5");
    await registry.replaySaved(lobbies[2]!, match.runId, recording);
    await registry.replaySaved(lobbies[3]!, match.runId, "2026-10-27T14-22-32-001Z-77");
    expect(await registry.findByReplay(recording)).toBe(lobbies[2]);
    expect(await registry.findByReplay("2026-10-27T14-22-31-999Z-77")).toBe(lobbies[0]);
    expect(await registry.findByReplay("2026-10-27T14-22-32-000Z-6")).toBeNull();
    expect(await registry.findByReplay("not-a-replay")).toBeNull();
  });
  it("classifies a miss: pending while a match started that millisecond has no replay id yet, none otherwise", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    const lobbies = ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"];
    for (const lobbyId of lobbies) holdMatch(docs, lobbyId, match.runId);
    // Nothing registered in that millisecond (a scheduled match): none.
    expect(await registry.replayLobby(recording)).toEqual({ state: "none" });
    await registry.register({ ...match, lobbyId: lobbies[0]!, startedAt: startedAt - 1 });
    expect(await registry.replayLobby(recording)).toEqual({ state: "none" }); // A neighbouring millisecond is not its lobby.
    // Registered, replay link not yet published: pending.
    await registry.register({ ...match, lobbyId: lobbies[1]!, startedAt });
    expect(await registry.replayLobby(recording)).toEqual({ state: "pending" });
    // Published under another id: that lobby is not this recording's, so none.
    await registry.replaySaved(lobbies[1]!, match.runId, "2026-10-27T14-22-32-000Z-5");
    expect(await registry.replayLobby(recording)).toEqual({ state: "none" });
    expect(await registry.replayLobby("2026-10-27T14-22-32-000Z-5")).toEqual({ state: "found", lobbyId: lobbies[1] });
    expect(await registry.replayLobby("not-a-replay")).toEqual({ state: "none" });
  });
  it("does not attribute an id whose timestamp names another start to the lobby holding it", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    await registry.register({ ...match, startedAt });
    holdMatch(docs, id, match.runId);
    await registry.replaySaved(id, match.runId, "2026-10-27T14-22-33-000Z-77");
    expect(await registry.findByReplay("2026-10-27T14-22-33-000Z-77")).toBeNull();
  });
});

/** The n-th lobby id; startedAt orders them. */
const lobbyN = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("public listing read limit", () => {
  it("lists at most 999 unfinished public matches per read and fails the whole listing at 1,000", async () => {
    const { store } = memory(); const registry = createWatchRegistry(store);
    for (let n = 1; n <= 999; n++) await registry.register({ ...match, lobbyId: lobbyN(n), startedAt: n });
    expect(await registry.publicMatches()).toHaveLength(999);
    await registry.register({ ...match, lobbyId: lobbyN(1000), startedAt: 1000 });
    await expect(registry.publicMatches()).rejects.toThrow("Spectator catalog exceeds its read limit");
  });
});

describe("stale public listing sweep", () => {
  const serving = (docs: Map<string, Record<string, string>>, slot: string, runId: string) => docs.set(`instances/${slot}`, { runId });
  const lobbyAt = (docs: Map<string, Record<string, string>>, lobbyId: string, state: string, slot: string, runId: string) =>
    docs.set(`lobbies/${lobbyId}`, { state, slot, matchRunId: runId });

  it("removes only listings whose slot serves another run and whose lobby no longer holds the slot", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    const [ended, handingOver, delayed, unserved] = [1, 2, 3, 4].map(lobbyN) as [string, string, string, string];
    await registry.register({ ...match, lobbyId: ended, startedAt: 1 });
    lobbyAt(docs, ended, "ended", "", "run-one"); // Finished or released, and its run is gone from the slot.
    await registry.register({ ...match, lobbyId: handingOver, startedAt: 2 });
    lobbyAt(docs, handingOver, "holding", "public-0", "run-one"); // A successor may still adopt and resume it.
    await registry.register({ ...match, lobbyId: delayed, startedAt: 3, runId: "run-two" });
    lobbyAt(docs, delayed, "ended", "", "run-two"); // Released, its delayed playback still on the slot's current run.
    await registry.register({ ...match, lobbyId: unserved, startedAt: 4, slot: "public-1" }); // No instance ever registered.
    serving(docs, "public-0", "run-two");
    expect((await registry.publicMatches()).map(row => row.lobbyId)).toEqual([handingOver, delayed, unserved]);
    expect(docs.has(`watchPublic/${ended}`)).toBe(false);
    expect(await registry.read(ended)).toMatchObject({ lobbyId: ended, runId: "run-one", playbackFinished: false });
    expect([handingOver, delayed, unserved].every(lobbyId => docs.has(`watchPublic/${lobbyId}`))).toBe(true);
  });

  it("keeps a listing whose run was resumed before the sweep's own transaction", async () => {
    const { docs, store } = memory();
    await createWatchRegistry(store).register(match);
    serving(docs, "public-0", "run-two");
    lobbyAt(docs, id, "ended", "", "run-one");
    // The listing moves to the serving run between the candidate read and the sweep's transaction.
    const racing: typeof store = { ...store, async transaction(step) {
      docs.set(`watchPublic/${id}`, { ...docs.get(`watchPublic/${id}`)!, runId: "run-two" });
      return store.transaction(step);
    } };
    expect((await createWatchRegistry(racing).publicMatches()).map(row => row.lobbyId)).toEqual([id]);
    expect(docs.has(`watchPublic/${id}`)).toBe(true);
  });

  it("sweeps each page before the read limit fails, so a backlog over 1,000 clears over repeated calls", async () => {
    const { docs, store } = memory(); const registry = createWatchRegistry(store);
    for (let n = 1; n <= 1150; n++) {
      await registry.register({ ...match, lobbyId: lobbyN(n), startedAt: n });
      lobbyAt(docs, lobbyN(n), "ended", "", "run-one");
    }
    const live = lobbyN(1151);
    await registry.register({ ...match, lobbyId: live, startedAt: 1151, runId: "run-two" });
    serving(docs, "public-0", "run-two");
    const listed = () => [...docs.keys()].filter(path => path.startsWith("watchPublic/")).length;
    await expect(registry.publicMatches()).rejects.toThrow("Spectator catalog exceeds its read limit");
    expect(listed()).toBe(151);
    expect((await registry.publicMatches()).map(row => row.lobbyId)).toEqual([live]);
    expect(listed()).toBe(1);
  });
});
