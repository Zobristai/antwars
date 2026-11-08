import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createPrivateArchive } from "../../src/replays/private-archive.ts";
import { openPrivateMedia, privateMediaName } from "../../src/replays/private-media.ts";
import { ReplayCreateError, type ReplayObject, type ReplayStore } from "../../src/replays/store.ts";

const ID = "2026-10-21T10-00-00-000Z-409";
const checkpoint = new Uint8Array(gzipSync(new Uint8Array([1, 2, 3])));

describe("record-service replay publication", () => {
  it("reads an existing released binary without creating or overwriting it, even after grace", async () => {
    const existing = new Uint8Array([9, 8, 7]), writes: ReplayObject[] = [];
    const target = createRecordReplayStore({ publicStore: { create: async object => { writes.push(object); } }, readPublic: async () => existing }).forMatch(ID, null)!;
    expect(await target.resolve(checkpoint, false)).toBe(existing);
    expect(await target.resolve(checkpoint, true)).toBe(existing);
    expect(writes).toEqual([]);
  });

  it("does not create until fallback is allowed; then writes gzip create-only", async () => {
    const writes: ReplayObject[] = [];
    const target = createRecordReplayStore({ publicStore: { create: async object => { writes.push(object); } }, readPublic: async () => null }).forMatch(ID, null)!;
    expect(await target.resolve(checkpoint, false)).toBeNull();
    expect(writes).toEqual([]);
    expect(await target.resolve(checkpoint, true)).toBe(checkpoint);
    expect(writes).toEqual([{ name: `${ID}.bin`, body: checkpoint, contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 }]);
  });

  it("reads the normal writer's winning bytes after a 412 race instead of building from the checkpoint", async () => {
    let normal: Uint8Array | null = null;
    const winner = new Uint8Array([9]);
    const target = createRecordReplayStore({ publicStore: { create: async () => { normal = winner; throw new ReplayCreateError(412); } }, readPublic: async () => normal }).forMatch(ID, null)!;
    expect(await target.resolve(checkpoint, true)).toBe(winner);
  });

  it("propagates read/create failures and missing collision winners for retry, never treating them as absent or saved", async () => {
    for (const status of [403, 503]) {
      const target = createRecordReplayStore({ publicStore: { create: async () => { throw new ReplayCreateError(status); } }, readPublic: async () => null }).forMatch(ID, null)!;
      await expect(target.resolve(checkpoint, true)).rejects.toThrow(`HTTP ${status}`);
    }
    let creates = 0;
    const target = createRecordReplayStore({ publicStore: { create: async () => { creates++; } }, readPublic: async () => { throw new Error("read denied"); } }).forMatch(ID, null)!;
    await expect(target.resolve(checkpoint, true)).rejects.toThrow("read denied");
    expect(creates).toBe(0);
    const vanished = createRecordReplayStore({ publicStore: { create: async () => { throw new ReplayCreateError(412); } }, readPublic: async () => null }).forMatch(ID, null)!;
    await expect(vanished.resolve(checkpoint, true)).rejects.toThrow("winning replay is missing");
  });

  it("creates and re-reads only authenticated sealed private binaries, with no public aliases", async () => {
    const objects = new Map<string, Uint8Array>(), key = new Uint8Array(32).fill(4);
    const writer: ReplayStore = { create: async object => {
      if (objects.has(object.name)) throw new ReplayCreateError(412);
      objects.set(object.name, object.body);
    } };
    const archive = createPrivateArchive(writer, async name => objects.has(name) ? { body: Readable.from([objects.get(name)!]) } : null, key);
    const deps = { publicStore: writer, readPublic: async () => { throw new Error("private input attempted a public read"); }, privateArchive: archive };
    const target = createRecordReplayStore(deps).forMatch(ID, "secret-lobby")!;
    expect(await target.resolve(checkpoint, false)).toBeNull();
    expect(await target.resolve(checkpoint, true)).toEqual(checkpoint);
    const identity = { lobbyId: "secret-lobby", replayId: ID, kind: "recording" as const };
    expect([...objects.keys()]).toEqual([privateMediaName(identity)]);
    expect(new Uint8Array(gunzipSync(openPrivateMedia(identity, objects.get(privateMediaName(identity))!, key)))).toEqual(new Uint8Array([1, 2, 3]));
    // New adapter/process authenticates the stored bytes instead of re-publishing.
    expect(await createRecordReplayStore(deps).forMatch(ID, "secret-lobby")!.resolve(checkpoint, true)).toEqual(checkpoint);
    expect(createRecordReplayStore({ publicStore: writer, readPublic: async () => null }).forMatch(ID, "secret-lobby")).toBeUndefined();
  });
});
