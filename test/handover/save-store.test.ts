// Save format and store: the saved match for Wide Plain with both
// colonies at their 1,024-ant cap is accepted by the store, with every Firestore document, field value and
// request within Firestore's limits, sized by
// Firestore's storage-size rules, with the spectator meta at its 65,536-byte maximum. Acceptance by
// Firestore itself needs the emulator (`firebase emulators:exec`); without it the store runs on the
// in-memory stand-in in helpers.ts and the sizes are still measured from the requests the client sends.
import { describe, expect, it } from "vitest";
import { createMatchSaves, type MatchSave } from "../../src/handover/saveStore.js";
import { SPECTATOR_SAVE_META_BYTES } from "../../src/live/handover.js";
import { memoryObjects, testFirestore, wideMatch, type RecordedRequest } from "./helpers.js";

/** Firestore's documented limits, in bytes or counts. */
const LIMITS = {
  documentName: 6 * 1024,
  document: 1_048_576,
  fieldName: 1_500,
  fieldValue: 1_048_487,
  request: 10 * 1024 * 1024,
  indexEntriesPerDocument: 40_000,
  indexEntry: 7.5 * 1024,
  indexEntriesSum: 8 * 1024 * 1024,
  indexedValue: 1_500,
} as const;

/** Storage-size rules: a string is its UTF-8 bytes + 1. */
const stringSize = (text: string) => Buffer.byteLength(text, "utf8") + 1;
/** A document name: each collection and document ID in its path, + 16. */
const nameSize = (path: string) => path.split("/").reduce((sum, id) => sum + stringSize(id), 16);

interface DocumentAccount {
  readonly name: number;
  readonly document: number;
  readonly largestFieldValue: number;
  readonly largestFieldName: number;
  readonly indexEntries: number;
  readonly largestIndexEntry: number;
  readonly indexEntriesSum: number;
}

/**
 * One written document by storage-size rules. Every field is a string (the wrapper writes only strings, so
 * no field nests). Each field gets the two automatic single-field index entries, ascending and descending,
 * scoped to its collection; an indexed string value counts at most 1,500 bytes, as longer ones are truncated.
 */
function account(path: string, fields: Readonly<Record<string, { stringValue: string }>>): DocumentAccount {
  const name = nameSize(path);
  const parent = nameSize(path.split("/").slice(0, -2).join("/"));
  const entries = Object.entries(fields);
  const entrySizes = entries.map(([key, value]) =>
    name + parent + stringSize(key) + Math.min(stringSize(value.stringValue), LIMITS.indexedValue + 1) + 32);
  return {
    name,
    document: name + entries.reduce((sum, [key, value]) => sum + stringSize(key) + stringSize(value.stringValue), 0) + 32,
    largestFieldValue: Math.max(...entries.map(([, value]) => stringSize(value.stringValue))),
    largestFieldName: Math.max(...entries.map(([key]) => stringSize(key))),
    indexEntries: 2 * entries.length,
    largestIndexEntry: Math.max(...entrySizes),
    indexEntriesSum: 2 * entrySizes.reduce((sum, size) => sum + size, 0),
  };
}

/** Every document the recorded commits wrote, by its path under the namespace. */
function committed(requests: readonly RecordedRequest[], namespace: string): Map<string, Readonly<Record<string, { stringValue: string }>>> {
  const docs = new Map<string, Readonly<Record<string, { stringValue: string }>>>();
  for (const request of requests) {
    if (!request.url.endsWith(":commit")) continue;
    for (const write of (request.body as { writes: { update?: { name: string; fields: Record<string, { stringValue: string }> } }[] }).writes) {
      if (write.update === undefined) continue;
      const name = write.update.name;
      docs.set(name.slice(name.indexOf("/documents/") + "/documents/".length), write.update.fields);
      expect(name).toContain(`/namespaces/${namespace}/`);
    }
  }
  return docs;
}

/** JSON text of exactly SPECTATOR_SAVE_META_BYTES UTF-8 bytes, with quotes and multi-byte characters that JSON escaping and UTF-8 enlarge. */
function maximalMeta(): string {
  const head = "{\"stream\":\"", tail = "\"}";
  let body = "";
  const unit = "\\\"é—𝄞";
  while (Buffer.byteLength(head + body + unit + tail, "utf8") <= SPECTATOR_SAVE_META_BYTES) body += unit;
  while (Buffer.byteLength(head + body + tail, "utf8") < SPECTATOR_SAVE_META_BYTES) body += "a";
  const meta = head + body + tail;
  expect(Buffer.byteLength(meta, "utf8")).toBe(SPECTATOR_SAVE_META_BYTES);
  JSON.parse(meta);
  return meta;
}

describe("handover save store", () => {
  it("accepts the saved Wide Plain match at both colonies' 1,024-ant cap within every recorded Firestore limit", async () => {
    const { game, clock } = await wideMatch({ seed: 21 });
    for (let i = 0; i < 100; i++) { clock.now += 100; game.tick(); }
    const state = game.match!.state;
    expect([0, 1].map(colony => state.ants.filter(ant => ant.colony === colony).length)).toEqual([1024, 1024]);
    expect(state.config.colonyCap).toBe(1024);

    const firestore = testFirestore();
    const objects = memoryObjects();
    const saves = createMatchSaves(firestore.store, objects);
    const parts = new Map([["stream", new Uint8Array(3 << 20).fill(7)], ["recording-frames", new Uint8Array(1 << 20).fill(9)]]);
    const save: MatchSave = { format: 1, lobbyId: "lobby-wide", revision: "antwar-00042-abc", savedByRunId: "0f0e4a5c-6d6e-4b8f-9d3c-1a2b3c4d5e6f",
      tick: 100, savedAt: clock.now, game: game.saveMatch(), spectator: { meta: maximalMeta(), parts } };
    await saves.write(save);
    const read = await saves.read("lobby-wide");
    expect(read).toStrictEqual(save);

    const docs = committed(firestore.requests, firestore.namespace);
    expect([...docs.keys()]).toEqual([`namespaces/${firestore.namespace}/matchSaves/lobby-wide`]);
    for (const [path, fields] of docs) {
      const size = account(path, fields);
      console.log(`save-store limits (${firestore.backend} Firestore): manifest ${path} ${size.document} bytes; largest field value ${size.largestFieldValue}; ` +
        `index entries ${size.indexEntries}, largest ${size.largestIndexEntry}, sum ${size.indexEntriesSum}; game save object ${objects.objects.get("handover/lobby-wide/" + save.savedByRunId + "/game")!.byteLength} bytes`);
      expect(size.name).toBeLessThanOrEqual(LIMITS.documentName);
      expect(size.document).toBeLessThanOrEqual(LIMITS.document);
      expect(size.largestFieldValue).toBeLessThanOrEqual(LIMITS.fieldValue);
      expect(size.largestFieldName).toBeLessThanOrEqual(LIMITS.fieldName);
      expect(size.indexEntries).toBeLessThanOrEqual(LIMITS.indexEntriesPerDocument);
      expect(size.largestIndexEntry).toBeLessThanOrEqual(LIMITS.indexEntry);
      expect(size.indexEntriesSum).toBeLessThanOrEqual(LIMITS.indexEntriesSum);
    }
    expect(firestore.requests.length).toBeGreaterThan(0);
    console.log(`save-store limits: largest of ${firestore.requests.length} Firestore requests is ${Math.max(...firestore.requests.map(request => request.bytes))} bytes, limit ${LIMITS.request}`);
    for (const request of firestore.requests) expect(request.bytes).toBeLessThanOrEqual(LIMITS.request);
    // Every bulky part is in the bucket, under the save's own folder; none of it went to Firestore.
    expect([...objects.objects.keys()].sort()).toEqual([
      `handover/lobby-wide/${save.savedByRunId}/game`,
      `handover/lobby-wide/${save.savedByRunId}/spectator/recording-frames`,
      `handover/lobby-wide/${save.savedByRunId}/spectator/stream`,
    ]);
  }, 120_000);

  it("a later save of the lobby replaces the earlier one whole", async () => {
    const { game, clock } = await wideMatch({ seed: 22 });
    const firestore = testFirestore();
    const saves = createMatchSaves(firestore.store, memoryObjects());
    const first: MatchSave = { format: 1, lobbyId: "lobby-x", revision: "r1", savedByRunId: "run-a", tick: 0, savedAt: 1,
      game: game.saveMatch(), spectator: { meta: "{\"a\":1}", parts: new Map([["a", new Uint8Array([1])], ["b", new Uint8Array([2])]]) } };
    await saves.write(first);
    clock.now += 100;
    game.tick();
    const second: MatchSave = { format: 1, lobbyId: "lobby-x", revision: "r1", savedByRunId: "run-b", tick: 1, savedAt: 2, game: game.saveMatch(), spectator: null };
    await saves.write(second);
    expect(await saves.read("lobby-x")).toStrictEqual(second);
    expect(await saves.read("lobby-y")).toBeNull();
  }, 60_000);

  it("reads no save whose bucket object is missing or altered", async () => {
    const { game } = await wideMatch({ seed: 23 });
    const objects = memoryObjects();
    const saves = createMatchSaves(testFirestore().store, objects);
    const save: MatchSave = { format: 1, lobbyId: "lobby-z", revision: "r1", savedByRunId: "run-a", tick: 0, savedAt: 1,
      game: game.saveMatch(), spectator: { meta: "{}", parts: new Map([["stream", new Uint8Array([1, 2, 3])]]) } };
    await saves.write(save);
    objects.objects.set("handover/lobby-z/run-a/spectator/stream", new Uint8Array([1, 2, 4]));
    expect(await saves.read("lobby-z")).toBeNull();
    objects.objects.delete("handover/lobby-z/run-a/spectator/stream");
    expect(await saves.read("lobby-z")).toBeNull();
  }, 60_000);

  it("rejects a save it cannot store whole, and writes no manifest for it", async () => {
    const { game } = await wideMatch({ seed: 24 });
    const save = (spectator: MatchSave["spectator"]): MatchSave =>
      ({ format: 1, lobbyId: "lobby-f", revision: "r1", savedByRunId: "run-a", tick: 0, savedAt: 1, game: game.saveMatch(), spectator });
    const { store } = testFirestore();
    await expect(createMatchSaves(store, undefined).write(save(null))).rejects.toThrow("ANTWAR_RECORD_INPUT_BUCKET");
    const failing = { put: async () => { throw new Error("bucket unavailable"); }, get: async () => null };
    await expect(createMatchSaves(store, failing).write(save(null))).rejects.toThrow("bucket unavailable");
    const saves = createMatchSaves(store, memoryObjects());
    await expect(saves.write(save({ meta: "x".repeat(SPECTATOR_SAVE_META_BYTES + 1), parts: new Map() }))).rejects.toThrow("too large");
    await expect(saves.write(save({ meta: "{}", parts: new Map([["Bad Name", new Uint8Array(1)]]) }))).rejects.toThrow("part name");
    expect(await saves.read("lobby-f")).toBeNull();
  }, 60_000);
});
