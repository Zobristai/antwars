import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateArchive, privateArchiveFromEnv } from "../../src/replays/private-archive.js";
import { privateMediaName, type PrivateMediaIdentity } from "../../src/replays/private-media.js";
import { isReplayId } from "../../src/replays/access.js";
import type { ReplayObject } from "../../src/replays/store.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const id = "2026-10-20T08-00-00-000Z-1";
const identity: PrivateMediaIdentity = { lobbyId: "private-lobby", replayId: id, kind: "recording" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "antwar-archive-test-")); dirs.push(root);
  const objects = new Map<string, ReplayObject>();
  const read = vi.fn(async (name: string) => {
    const object = objects.get(name);
    if (!object) return null;
    const bytes = Buffer.from(object.body);
    return { body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3, 23), bytes.subarray(23)]), contentLength: String(bytes.length) };
  });
  const archive = createPrivateArchive({ create: async object => { objects.set(object.name, object); } }, read, Buffer.alloc(32, 9), root);
  return { archive, objects, root, read };
}
async function consume(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("private recording archive adapter", () => {
  it("is lazy and never enables private storage without its key", () => {
    const request = vi.fn() as unknown as typeof fetch;
    expect(privateArchiveFromEnv({}, request)).toBeUndefined();
    expect(privateArchiveFromEnv({ ANTWAR_REPLAY_BUCKET: "shared" }, request)).toBeUndefined();
    expect(privateArchiveFromEnv({ ANTWAR_REPLAY_BUCKET: "shared", ANTWAR_PRIVATE_REPLAY_KEY: "ab".repeat(32) }, request)).toBeDefined();
    expect(() => privateArchiveFromEnv({ ANTWAR_REPLAY_BUCKET: "shared", ANTWAR_PRIVATE_REPLAY_KEY: "bad" }, request)).toThrow("32 bytes");
    expect(request).not.toHaveBeenCalled();
  });
  it("writes binary and JSON only as non-public ciphertext and restores their exact bytes", async () => {
    const f = await fixture();
    const store = f.archive.forLobby(identity.lobbyId);
    const binary = Buffer.from([31, 139, 0, 42, 255]);
    const json = Buffer.from('{"private":"record"}');
    await store.create({ name: `${id}.bin`, body: binary, contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 });
    await store.create({ name: `${id}.json`, body: json, contentType: "application/json", ifGenerationMatch: 0 });
    expect(f.objects.size).toBe(2);
    expect(f.objects.has(`${id}.bin`) || f.objects.has(`${id}.json`)).toBe(false);
    for (const object of f.objects.values()) {
      expect(object.name).toMatch(/^private\/v1\/[0-9a-f]{64}\.sealed$/);
      expect(object.contentEncoding).toBeUndefined();
      expect(isReplayId(object.name.replace(/\.(bin|json)$/, ""))).toBe(false);
    }
    for (const [kind, original] of [["recording", binary], ["match-record", json]] as const) {
      const opened = await f.archive.open({ ...identity, kind }, new AbortController().signal);
      expect(opened?.contentLength).toBe(String(original.length));
      expect(await consume(opened!.body)).toEqual(original);
    }
    await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]));
  });

  it("exposes no stream on authentication failure and removes its private spool", async () => {
    const f = await fixture();
    await f.archive.forLobby(identity.lobbyId).create({ name: `${id}.bin`, body: Buffer.from("secret"), contentType: "application/octet-stream", ifGenerationMatch: 0 });
    const name = privateMediaName(identity), object = f.objects.get(name)!;
    const damaged = Buffer.from(object.body); damaged[damaged.length - 1] ^= 1;
    f.objects.set(name, { ...object, body: damaged });
    await expect(f.archive.open(identity, new AbortController().signal)).rejects.toThrow("Private media unavailable");
    expect(await readdir(f.root)).toEqual([]);
  });

  it("does not read or allocate files for an already-aborted request", async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort(new Error("canceled"));
    await expect(f.archive.open(identity, abort.signal)).rejects.toThrow("canceled");
    expect(f.read).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });

  it("returns a missing object without a public fallback", async () => {
    const f = await fixture();
    expect(await f.archive.open(identity, new AbortController().signal)).toBeNull();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(privateMediaName(identity), expect.any(AbortSignal));
  });

  it("rejects malformed private writer names before touching storage", async () => {
    const f = await fixture();
    await expect(f.archive.forLobby(identity.lobbyId).create({ name: "../../public.bin", body: Buffer.from("private"), contentType: "application/octet-stream", ifGenerationMatch: 0 })).rejects.toThrow("Invalid private recording object");
    expect(f.objects.size).toBe(0);
  });
});
