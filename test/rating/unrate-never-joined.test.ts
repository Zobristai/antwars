import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { ratingWrites, ratingCollection, RANKED_MODES, type MatchResult } from "../../src/rating/ratings.ts";
import { correct, type CorrectionDeps } from "../../src/rating/unrateNeverJoined.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import type { RecordingObjects, StoredObject } from "../../src/replays/abandonRecording.ts";
import { binaryRecord } from "../../src/replays/history.ts";
import { parseArguments } from "../../scripts/unrate-never-joined.ts";
import { ratedRecording, REPLAY_ID } from "../replays/never-joined-fixture.ts";

// Runs inside `firebase emulators:exec --only firestore` (FIRESTORE_EMULATOR_HOST); buckets are in memory.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
let counter = 0;
const freshNamespace = () => `u${process.pid}-${Date.now().toString(36)}-${counter++}`;

/** An in-memory bucket with GCS generations: replace succeeds only at the stored generation. */
function memoryBucket(initial: Record<string, Omit<StoredObject, "generation">> = {}) {
  const objects = new Map<string, StoredObject>();
  let next = 1;
  for (const [name, object] of Object.entries(initial)) objects.set(name, { ...object, generation: String(next++) });
  const bucket: RecordingObjects & { objects: Map<string, StoredObject>; touch(name: string): void } = {
    objects,
    touch(name) { const object = objects.get(name)!; objects.set(name, { ...object, generation: String(next++) }); },
    async read(name) { return objects.get(name) ?? null; },
    async exists(name) { return objects.has(name); },
    async replace(name, object, generation) {
      if (objects.get(name)?.generation !== generation) throw new Error(`object ${name} changed since it was verified; nothing replaced`);
      objects.set(name, { ...object, generation: String(next++) });
    },
  };
  return bucket;
}

async function write(store: Store, writes: { op: "create" | "update"; path: string; fields: Fields }[]): Promise<void> {
  await store.transaction(async () => ({ result: undefined, writes }));
}
async function rate(store: Store, result: MatchResult): Promise<void> {
  await store.transaction(read => ratingWrites(read, result));
}

/** Every document the correction reads or writes, as stored now. */
async function documents(store: Store, lobbyId: string, ids: readonly string[]): Promise<Record<string, Fields | null>> {
  const paths = [`lobbies/${lobbyId}`, `ratedMatches/${lobbyId}`, `watchMatches/${lobbyId}`, `watchPublic/${lobbyId}`,
    ...ids.flatMap(id => RANKED_MODES.map(mode => `${ratingCollection(mode)}/${id}`))];
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await store.get(path)] as const)));
}

/** A rated ranked 1v1 lobby (colony 0 absent, colony 1 joined and won) with its rating writes, watch entry and recording. */
async function world(options: { joined?: readonly (0 | 1)[] } = {}) {
  const namespace = freshNamespace();
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const ids: string[] = [];
  for (const name of ["absent-player", "joined-player", "third-player"]) {
    const claimed = await identities.claimUsername(name);
    if (!claimed.ok) throw new Error(claimed.reason);
    ids.push(claimed.value.identity.id);
  }
  const [absent, joined, third] = ids as [string, string, string];
  const lobbyId = randomUUID();
  const startsAt = Date.parse("2026-11-09T13:26:59.840Z");
  await write(store, [
    { op: "create", path: `lobbies/${lobbyId}`, fields: { kind: "public", size: "1", state: "ended", rated: "true", slot: "",
      seats: JSON.stringify([{ id: absent, colony: 0 }, { id: joined, colony: 1 }]), outcome: "colony_1_won", mode: "1v1",
      createdAt: String(startsAt - 60_000), startsAt: String(startsAt), matchRunId: "run-1" } },
    { op: "create", path: `watchMatches/${lobbyId}`, fields: { visibility: "public", rated: "true", mode: "1v1", startedAt: String(startsAt),
      playbackFinished: "true", origin: "https://example.test", slot: "public-1", runId: "run-1", replayId: REPLAY_ID } },
  ]);
  await rate(store, { matchId: lobbyId, teams: [[absent], [joined]], winner: "b", mode: "1v1", at: startsAt });
  const recording = ratedRecording(options.joined ?? [1]);
  const recordings = memoryBucket({
    [`${REPLAY_ID}.bin`]: { body: recording.binary, contentType: "application/octet-stream", contentEncoding: "gzip" },
    [`${REPLAY_ID}.json`]: { body: recording.recordBody, contentType: "application/json" },
  });
  const recordInputs = memoryBucket();
  const deps: CorrectionDeps = { store, recordings, recordInputs };
  return { store, deps, recordings, recordInputs, lobbyId, absent, joined, third, startsAt, recording, ids: [absent, joined] };
}

const failed = (checks: readonly { name: string; ok: boolean }[]) => checks.filter(check => !check.ok).map(check => check.name);

describe.skipIf(!host)("unrating a never-joined ranked lobby", () => {
  it("passes read-only, reports the never-joined player and writes nothing", async () => {
    const w = await world();
    const before = await documents(w.store, w.lobbyId, w.ids);
    const bucket = new Map(w.recordings.objects);
    const result = await correct(w.deps, w.lobbyId, { apply: false });
    expect(failed(result.verification.checks)).toEqual([]);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.neverJoined).toEqual([w.absent]);
    expect(result.applied).toBe(false);
    expect(result.writes).toEqual(expect.arrayContaining([`update watchMatches/${w.lobbyId} {"rated":"false"}`, `delete ratings/${w.absent}`]));
    expect(await documents(w.store, w.lobbyId, w.ids)).toEqual(before);
    expect(w.recordings.objects).toEqual(bucket);
  });

  it("applies: lobby abandoned and unrated, watch entry unrated, players unrated, recording abandoned and unrated", async () => {
    const w = await world();
    const result = await correct(w.deps, w.lobbyId, { apply: true });
    expect(result.applied).toBe(true);
    const lobby = (await w.store.get(`lobbies/${w.lobbyId}`))!;
    expect(lobby).toMatchObject({ outcome: "abandoned", rated: "false", state: "ended" });
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("false");
    expect(await w.store.get(`ratedMatches/${w.lobbyId}`)).toBeNull();
    for (const id of w.ids) expect(await w.store.get(`ratings/${id}`)).toBeNull();
    const binary = w.recordings.objects.get(`${REPLAY_ID}.bin`)!;
    expect(binary).toMatchObject({ contentType: "application/octet-stream", contentEncoding: "gzip" });
    const decoded = binaryRecord({ id: REPLAY_ID, binary: binary.body });
    expect(decoded.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: w.recording.record.result!.tick });
    expect(decoded.setup!.rated).toBe(false);
    const record = JSON.parse(new TextDecoder().decode(w.recordings.objects.get(`${REPLAY_ID}.json`)!.body));
    expect(record).toMatchObject({ status: "complete", setup: { rated: false }, result: { winner: null, reason: "abandoned", decidedBy: "draw" } });
    expect(record.result.ratingChanges).toBeUndefined();
    expect(record.seats).toEqual(w.recording.record.seats);
    // A second run finds nothing to correct and writes nothing.
    const again = await correct(w.deps, w.lobbyId, { apply: true });
    expect(again.verification.ok).toBe(false);
    expect(again.applied).toBe(false);
  });

  it("finishes a run interrupted after the recording was rewritten", async () => {
    const w = await world();
    const reads = w.deps.recordings;
    let replaced = 0;
    const interrupted: CorrectionDeps = { ...w.deps, store: { ...w.store, namespace: w.store.namespace, get: w.store.get,
      query: w.store.query, transaction: async (step) => {
        // The third transaction is the correction's write: fail it as an interrupted run would.
        if (++replaced === 3) throw new Error("interrupted");
        return w.store.transaction(step);
      } } };
    await expect(correct({ ...interrupted, recordings: reads }, w.lobbyId, { apply: true })).rejects.toThrow("interrupted");
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    const resumed = await correct(w.deps, w.lobbyId, { apply: true });
    expect(resumed.verification.recordingCorrected).toBe(true);
    expect(resumed.applied).toBe(true);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.outcome).toBe("abandoned");
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("false");
  });

  async function refuses(w: Awaited<ReturnType<typeof world>>, check: string): Promise<void> {
    const before = await documents(w.store, w.lobbyId, [...w.ids, w.third]);
    const bucket = new Map(w.recordings.objects);
    const result = await correct(w.deps, w.lobbyId, { apply: true });
    expect(failed(result.verification.checks)).toContain(check);
    expect(result.applied).toBe(false);
    expect(await documents(w.store, w.lobbyId, [...w.ids, w.third])).toEqual(before);
    expect(w.recordings.objects).toEqual(bucket);
  }

  it("refuses when both colonies joined", async () => {
    await refuses(await world({ joined: [0, 1] }), "never joined");
  });

  it("refuses when a player has another rated 1v1 match", async () => {
    const w = await world();
    await rate(w.store, { matchId: randomUUID(), teams: [[w.joined], [w.third]], winner: "a", mode: "1v1", at: w.startsAt + 3_600_000 });
    await refuses(w, `only rated match: ${w.joined}`);
  });

  it("refuses when a player is rated in another ranked mode", async () => {
    const w = await world();
    await rate(w.store, { matchId: randomUUID(), teams: [[w.absent], [w.third]], winner: "a", mode: "2v2", at: w.startsAt });
    await refuses(w, `only rated match: ${w.absent}`);
  });

  it("refuses when a rating changed since the match", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `ratings/${w.joined}`, fields: { rating: (await w.store.get(`ratings/${w.absent}`))!.rating! } }]);
    await refuses(w, `only rated match: ${w.joined}`);
  });

  it("refuses when the rating change record names other identities", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `ratedMatches/${w.lobbyId}`, fields: { changes: JSON.stringify([{ identityId: w.third, before: 1500, after: 1600 }]) } }]);
    await refuses(w, "rating change record");
  });

  it("refuses when the match record is missing", async () => {
    const w = await world();
    w.recordings.objects.delete(`${REPLAY_ID}.json`);
    await refuses(w, "match record");
  });

  it("refuses while the record service still holds the match's input", async () => {
    const w = await world();
    w.recordInputs.objects.set(`${REPLAY_ID}.input`, { body: new Uint8Array([1]), generation: "1", contentType: "application/octet-stream" });
    await refuses(w, "no record input");
  });

  it("refuses while playback has not finished or the match is publicly listed", async () => {
    const w = await world();
    await write(w.store, [{ op: "create", path: `watchPublic/${w.lobbyId}`, fields: { runId: "run-1" } }]);
    await refuses(w, "watch entry");
    const v = await world();
    await write(v.store, [{ op: "update", path: `watchMatches/${v.lobbyId}`, fields: { playbackFinished: "false" } }]);
    await refuses(v, "watch entry");
  });

  it("refuses a lobby that is not rated", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `lobbies/${w.lobbyId}`, fields: { rated: "false" } }]);
    await refuses(w, "lobby");
  });

  it("writes nothing to Firestore when a recording object changed after verification", async () => {
    const w = await world();
    const original = w.deps.recordings;
    let reads = 0;
    const racing: RecordingObjects = { ...original, read: async name => {
      const object = await original.read(name);
      if (name.endsWith(".bin") && ++reads === 1) w.recordings.touch(name);
      return object;
    } };
    await expect(correct({ ...w.deps, recordings: racing }, w.lobbyId, { apply: true })).rejects.toThrow(/changed since it was verified/);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("true");
  });

  it("writes nothing to Firestore when a document changed after verification", async () => {
    const w = await world();
    let calls = 0;
    const racing: CorrectionDeps = { ...w.deps, store: { ...w.store, namespace: w.store.namespace, get: w.store.get, query: w.store.query,
      transaction: async (step) => {
        if (++calls === 3) await write(w.store, [{ op: "update", path: `ratings/${w.joined}`, fields: { thinkingLevel: "changed" } }]);
        return w.store.transaction(step);
      } } };
    await expect(correct(racing, w.lobbyId, { apply: true })).rejects.toThrow(/changed since verification/);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("true");
    expect(await w.store.get(`ratings/${w.absent}`)).not.toBeNull();
  });
});

describe("command line", () => {
  const all = ["--lobby", "l", "--project", "p", "--namespace", "n", "--replay-bucket", "r", "--record-input-bucket", "i"];
  it("requires every target argument and is read-only unless --apply", () => {
    expect(parseArguments(all)).toEqual({ lobby: "l", project: "p", namespace: "n", replayBucket: "r", recordInputBucket: "i", apply: false });
    expect(parseArguments([...all, "--apply"]).apply).toBe(true);
    expect(() => parseArguments(all.slice(2))).toThrow("missing required argument(s): --lobby");
    expect(() => parseArguments([])).toThrow("--lobby, --project, --namespace, --replay-bucket, --record-input-bucket");
    expect(() => parseArguments([...all, "--project", ""])).toThrow("--project");
    expect(() => parseArguments([...all, "--force"])).toThrow();
  });
});
