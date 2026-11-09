import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { ratingWrites, ratingCollection, RANKED_MODES, type MatchResult } from "../../src/rating/ratings.ts";
import { correct, type CorrectionDeps } from "../../src/rating/unrateNeverJoined.ts";
import { createFirestore, type Fields, type Store, type Write } from "../../src/store/firestore.ts";
import { abandonBinary, abandonRecord, serializeRecord, type RecordingObjects, type StoredObject } from "../../src/replays/abandonRecording.ts";
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
    async generation(name) { return objects.get(name)?.generation ?? null; },
    async replace(name, object, generation) {
      if (objects.get(name)?.generation !== generation) throw new Error(`object ${name} changed since it was verified; nothing replaced`);
      const written = String(next++);
      objects.set(name, { ...object, generation: written });
      return written;
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
  const paths = [`lobbies/${lobbyId}`, `ratedMatches/${lobbyId}`, `watchMatches/${lobbyId}`, `ratingCorrections/${lobbyId}`,
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
  const deps: CorrectionDeps = { store, recordings };
  return { store, deps, recordings, lobbyId, absent, joined, third, startsAt, recording, ids: [absent, joined] };
}

const failed = (checks: readonly { name: string; ok: boolean }[]) => checks.filter(check => !check.ok).map(check => check.name);

describe.skipIf(!host)("unrating a never-joined ranked lobby", () => {
  it("passes read-only, reports the never-joined player and writes nothing", async () => {
    const w = await world();
    const before = await documents(w.store, w.lobbyId, w.ids);
    const bucket = new Map(w.recordings.objects);
    const result = await correct(w.deps, w.lobbyId, { apply: false, replayId: REPLAY_ID });
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
    const result = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(result.applied).toBe(true);
    const lobby = (await w.store.get(`lobbies/${w.lobbyId}`))!;
    expect(lobby).toMatchObject({ outcome: "abandoned", rated: "false", state: "ended" });
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("false");
    expect(await w.store.get(`ratedMatches/${w.lobbyId}`)).toBeNull();
    for (const id of w.ids) expect(await w.store.get(`ratings/${id}`)).toBeNull();
    expect(await w.store.get(`ratingCorrections/${w.lobbyId}`)).toMatchObject({ kind: "unrate-never-joined", lobbyId: w.lobbyId,
      replayId: REPLAY_ID, runId: "run-1", mode: "1v1", identities: JSON.stringify(w.ids), neverJoined: JSON.stringify([w.absent]),
      binaryGeneration: "1", recordGeneration: "2" });
    const binary = w.recordings.objects.get(`${REPLAY_ID}.bin`)!;
    expect(binary).toMatchObject({ contentType: "application/octet-stream", contentEncoding: "gzip" });
    const decoded = binaryRecord({ id: REPLAY_ID, binary: binary.body });
    expect(decoded.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: w.recording.record.result!.tick });
    expect(decoded.setup!.rated).toBe(false);
    const record = JSON.parse(new TextDecoder().decode(w.recordings.objects.get(`${REPLAY_ID}.json`)!.body));
    expect(record).toMatchObject({ status: "complete", setup: { rated: false }, result: { winner: null, reason: "abandoned", decidedBy: "draw" } });
    expect(record.result.ratingChanges).toBeUndefined();
    expect(record.seats).toEqual(w.recording.record.seats);
    // A second run reads the committed correction, finds nothing left to write and writes nothing.
    const again = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(again.verification.ok).toBe(true);
    expect(again.verification.stage).toBe("corrected");
    expect(again.writes).toEqual([]);
    expect(again.applied).toBe(false);
  });

  async function refuses(w: Awaited<ReturnType<typeof world>>, check: string): Promise<void> {
    const before = await documents(w.store, w.lobbyId, [...w.ids, w.third]);
    const bucket = new Map(w.recordings.objects);
    const result = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(failed(result.verification.checks)).toContain(check);
    expect(result.applied).toBe(false);
    expect(await documents(w.store, w.lobbyId, [...w.ids, w.third])).toEqual(before);
    expect(w.recordings.objects).toEqual(bucket);
  }

  it("refuses when both colonies joined", async () => {
    await refuses(await world({ joined: [0, 1] }), "never joined");
  });

  it("refuses when colony 0 joined and colony 1 did not", async () => {
    await refuses(await world({ joined: [0] }), "never joined");
  });

  it("refuses when the watch entry names another recording", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `watchMatches/${w.lobbyId}`, fields: { replayId: "2026-11-09T13-26-59-841Z-1" } }]);
    await refuses(w, "watch entry");
  });

  it("refuses when the watch entry belongs to another run than the lobby's match", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `watchMatches/${w.lobbyId}`, fields: { runId: "run-other" } }]);
    await refuses(w, "watch entry");
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

  it("refuses when the match record is missing or unavailable", async () => {
    const w = await world();
    w.recordings.objects.delete(`${REPLAY_ID}.json`);
    await refuses(w, "match record");
    const v = await world();
    const record = { ...v.recording.record, status: "unavailable", source: "unavailable" };
    v.recordings.objects.set(`${REPLAY_ID}.json`, { ...v.recordings.objects.get(`${REPLAY_ID}.json`)!,
      body: new TextEncoder().encode(JSON.stringify(record) + "\n") });
    await refuses(v, "match record");
  });

  it("refuses when the watch entry is not rated", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `watchMatches/${w.lobbyId}`, fields: { rated: "false" } }]);
    await refuses(w, "watch entry");
  });

  it("refuses a lobby that is not rated", async () => {
    const w = await world();
    await write(w.store, [{ op: "update", path: `lobbies/${w.lobbyId}`, fields: { rated: "false" } }]);
    await refuses(w, "lobby");
  });

  /** The store with its commit transaction (the third: snapshot, rating rows, commit) replaced by `commit`. */
  const atCommit = (w: Awaited<ReturnType<typeof world>>, commit: Store["transaction"]): CorrectionDeps => {
    let calls = 0;
    return { ...w.deps, store: { ...w.store, namespace: w.store.namespace, get: w.store.get, query: w.store.query,
      transaction: (step) => (++calls === 3 ? commit : w.store.transaction)(step) } };
  };
  /** The bucket with replace of names matching `name` replaced by `replace`. */
  const replacing = (w: Awaited<ReturnType<typeof world>>, name: RegExp, replace: RecordingObjects["replace"]): CorrectionDeps =>
    ({ ...w.deps, recordings: { ...w.recordings, read: w.recordings.read, replace: (n, o, g) => (name.test(n) ? replace : w.recordings.replace)(n, o, g) } });
  const firestoreCorrected = async (w: Awaited<ReturnType<typeof world>>) => {
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!).toMatchObject({ outcome: "abandoned", rated: "false" });
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("false");
    expect(await w.store.get(`ratedMatches/${w.lobbyId}`)).toBeNull();
    for (const id of w.ids) expect(await w.store.get(`ratings/${id}`)).toBeNull();
  };
  const recordingAbandoned = (w: Awaited<ReturnType<typeof world>>) => {
    const decoded = binaryRecord({ id: REPLAY_ID, binary: w.recordings.objects.get(`${REPLAY_ID}.bin`)!.body });
    expect(decoded.result).toMatchObject({ winner: null, reason: "abandoned", decidedBy: "draw" });
    expect(decoded.setup!.rated).toBe(false);
    expect(w.recordings.objects.get(`${REPLAY_ID}.json`)!.body).toEqual(serializeRecord(abandonRecord(w.recording.record)));
  };
  const recordingUntouched = (w: Awaited<ReturnType<typeof world>>) => {
    expect(w.recordings.objects.get(`${REPLAY_ID}.bin`)!.body).toEqual(w.recording.binary);
    expect(w.recordings.objects.get(`${REPLAY_ID}.json`)!.body).toEqual(w.recording.recordBody);
  };

  it("writes nothing to Firestore or the recording when a document changed after verification", async () => {
    const w = await world();
    const racing = atCommit(w, async (step) => {
      await write(w.store, [{ op: "update", path: `ratings/${w.joined}`, fields: { thinkingLevel: "changed" } }]);
      return w.store.transaction(step);
    });
    await expect(correct(racing, w.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/changed since verification; nothing written to Firestore or the recording/);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    expect((await w.store.get(`watchMatches/${w.lobbyId}`))!.rated).toBe("true");
    expect(await w.store.get(`ratings/${w.absent}`)).not.toBeNull();
    // The recording was never written: the Firestore check runs before any recording write.
    recordingUntouched(w);
  });

  it("leaves the recording untouched when the commit fails, and a rerun completes the whole correction", async () => {
    const w = await world();
    await expect(correct(atCommit(w, async () => { throw new Error("commit failed"); }), w.lobbyId, { apply: true, replayId: REPLAY_ID }))
      .rejects.toThrow(/Firestore commit outcome unknown \(commit failed\); the recording was not touched/);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    recordingUntouched(w);
    const rerun = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(rerun.verification.stage).toBe("rated");
    expect(rerun.applied).toBe(true);
    await firestoreCorrected(w);
    recordingAbandoned(w);
  });

  it("when a commit response is lost after Firestore committed, a rerun reads the commit and completes only the recording", async () => {
    const w = await world();
    const lost = atCommit(w, async (step) => { await w.store.transaction(step); throw new Error("DEADLINE_EXCEEDED"); });
    await expect(correct(lost, w.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/outcome unknown \(DEADLINE_EXCEEDED\); the recording was not touched/);
    await firestoreCorrected(w);
    recordingUntouched(w);
    const readOnly = await correct(w.deps, w.lobbyId, { apply: false, replayId: REPLAY_ID });
    expect(failed(readOnly.verification.checks)).toEqual([]);
    expect(readOnly.verification.stage).toBe("corrected");
    expect(readOnly.writes).toEqual([`replace ${REPLAY_ID}.bin at generation 1`, `replace ${REPLAY_ID}.json at generation 2`]);
    const rerun = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(rerun.applied).toBe(true);
    await firestoreCorrected(w);
    recordingAbandoned(w);
  });

  it("writes nothing to Firestore or the recording when a recording object changed after verification", async () => {
    const w = await world();
    const original = w.deps.recordings;
    let reads = 0;
    const racing: RecordingObjects = { ...original, read: async name => {
      const object = await original.read(name);
      if (name.endsWith(".json") && ++reads === 1) w.recordings.touch(name);
      return object;
    } };
    await expect(correct({ ...w.deps, recordings: racing }, w.lobbyId, { apply: true, replayId: REPLAY_ID }))
      .rejects.toThrow(/recording changed since verification; nothing written to Firestore or the recording/);
    expect((await w.store.get(`lobbies/${w.lobbyId}`))!.rated).toBe("true");
    expect(await w.store.get(`ratings/${w.absent}`)).not.toBeNull();
    expect(await w.store.get(`ratingCorrections/${w.lobbyId}`)).toBeNull();
    recordingUntouched(w);
  });

  it("in the remaining window (object replaced after the transaction's re-read), Firestore is corrected and a rerun completes the recording", async () => {
    const w = await world();
    const window = replacing(w, /\.bin$/, async (name, object, generation) => {
      w.recordings.touch(name);
      return w.recordings.replace(name, object, generation);
    });
    await expect(correct(window, w.lobbyId, { apply: true, replayId: REPLAY_ID }))
      .rejects.toThrow(/not confirmed replaced \(object .*\.bin changed since it was verified; nothing replaced\)\. Rerun with --apply/);
    await firestoreCorrected(w);
    expect((await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID })).applied).toBe(true);
    recordingAbandoned(w);
  });

  it("a rerun after a partial run refuses when a player has played another rated match since", async () => {
    const w = await world();
    const lost = atCommit(w, async (step) => { await w.store.transaction(step); throw new Error("DEADLINE_EXCEEDED"); });
    await expect(correct(lost, w.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/outcome unknown/);
    await firestoreCorrected(w);
    await rate(w.store, { matchId: randomUUID(), teams: [[w.joined], [w.third]], winner: "a", mode: "1v1", at: w.startsAt + 3_600_000 });
    await refuses(w, `only rated match: ${w.joined}`);
    recordingUntouched(w);
  });

  it("a rerun after a partial run refuses when the correction marker names another recording", async () => {
    const w = await world();
    const lost = atCommit(w, async (step) => { await w.store.transaction(step); throw new Error("DEADLINE_EXCEEDED"); });
    await expect(correct(lost, w.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/outcome unknown/);
    await write(w.store, [{ op: "update", path: `ratingCorrections/${w.lobbyId}`, fields: { replayId: "2026-11-09T13-26-59-841Z-1" } }]);
    await refuses(w, "correction marker");
  });

  it("does not take an abandoned, unrated lobby without this tool's correction marker as corrected", async () => {
    const w = await world();
    await w.store.transaction(async () => ({ result: undefined, writes: <Write[]>[
      { op: "update", path: `lobbies/${w.lobbyId}`, fields: { outcome: "abandoned", rated: "false" } },
      { op: "update", path: `watchMatches/${w.lobbyId}`, fields: { rated: "false" } },
      ...w.ids.map(id => ({ op: "delete" as const, path: `ratings/${id}` })),
      { op: "delete" as const, path: `ratedMatches/${w.lobbyId}` },
    ] }));
    await refuses(w, "correction marker");
  });

  it("when an upload was stored but its response lost, a rerun checks both objects and rewrites only the one still rated", async () => {
    const w = await world();
    // The record upload lands but its response is lost; the binary upload fails outright.
    const uncertain = replacing(w, /\.(bin|json)$/, async (name, object, generation) => {
      if (name.endsWith(".bin")) throw new Error("connection reset");
      await w.recordings.replace(name, object, generation);
      throw new Error("response lost");
    });
    await expect(correct(uncertain, w.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/\.bin not confirmed replaced \(connection reset\)/);
    // Simulate the opposite order too: the record already abandoned while the binary is still rated.
    const json = w.recordings.objects.get(`${REPLAY_ID}.json`)!;
    await w.recordings.replace(`${REPLAY_ID}.json`, { ...json, body: serializeRecord(abandonRecord(w.recording.record)) }, json.generation);
    const readOnly = await correct(w.deps, w.lobbyId, { apply: false, replayId: REPLAY_ID });
    expect(failed(readOnly.verification.checks)).toEqual([]);
    expect(readOnly.writes).toEqual([`replace ${REPLAY_ID}.bin at generation 1`]);
    const rerun = await correct(w.deps, w.lobbyId, { apply: true, replayId: REPLAY_ID });
    expect(rerun.writes).toEqual([`replace ${REPLAY_ID}.bin at generation 1`]);
    await firestoreCorrected(w);
    recordingAbandoned(w);
    // And the binary abandoned while the record is still rated: only the record is rewritten.
    const v = await world();
    await expect(correct(replacing(v, /\.json$/, async (name, object, generation) => {
      await v.recordings.replace(name, object, generation); throw new Error("response lost");
    }), v.lobbyId, { apply: true, replayId: REPLAY_ID })).rejects.toThrow(/\.json not confirmed replaced \(response lost\)/);
    const vJson = v.recordings.objects.get(`${REPLAY_ID}.json`)!;
    await v.recordings.replace(`${REPLAY_ID}.json`, { ...vJson, body: v.recording.recordBody }, vJson.generation);
    expect((await correct(v.deps, v.lobbyId, { apply: true, replayId: REPLAY_ID })).writes).toEqual([`replace ${REPLAY_ID}.json at generation 5`]);
    recordingAbandoned(v);
  });
});

describe("command line", () => {
  const all = ["--lobby", "l", "--replay", "x", "--project", "p", "--namespace", "n", "--replay-bucket", "r"];
  it("requires every target argument and is read-only unless --apply", () => {
    expect(parseArguments(all)).toEqual({ lobby: "l", replay: "x", project: "p", namespace: "n", replayBucket: "r", apply: false });
    expect(parseArguments([...all, "--apply"]).apply).toBe(true);
    expect(() => parseArguments(all.slice(2))).toThrow("missing required argument(s): --lobby");
    expect(() => parseArguments([])).toThrow("missing required argument(s): --lobby, --replay, --project, --namespace, --replay-bucket");
    expect(() => parseArguments([...all, "--project", ""])).toThrow("--project");
    expect(() => parseArguments([...all, "--force"])).toThrow();
  });
});
