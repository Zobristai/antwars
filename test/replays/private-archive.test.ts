import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateArchive, privateArchiveFromEnv } from "../../src/replays/private-archive.js";
import { privateMediaName, type PrivateMediaIdentity } from "../../src/replays/private-media.js";
import { isReplayId } from "../../src/replays/access.js";
import type { ReplayObject } from "../../src/replays/store.js";
import { scanRecord } from "../../src/accounts/postMortemRecord.js";

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

describe("private record streamed into a consumer (post-mortem)", () => {
  const recordIdentity: PrivateMediaIdentity = { lobbyId: "private-lobby", replayId: id, kind: "match-record" };
  /** A sealed private record of about 40 KiB: an early secret, a long events array, then its replies. */
  const plaintext = Buffer.from(JSON.stringify({ id, secret: "PLAINTEXT-MARKER", rules: { config: { ticksPerSecond: 10 } }, seats: [],
    events: Array.from({ length: 400 }, (_, tick) => ({ tick, event: { kind: "move", text: "z".repeat(80) } })),
    agentSeats: { "agent-a": 0 }, replies: [{ type: "stub", agentId: "agent-a", tick: null, tool: "join", receivedAt: 1, answeredAt: 2, code: "call_rate" }] }));
  async function sealed() {
    const f = await fixture();
    await f.archive.forLobby(recordIdentity.lobbyId).create({ name: `${id}.json`, body: plaintext, contentType: "application/json", ifGenerationMatch: 0 });
    const name = privateMediaName(recordIdentity);
    return { ...f, name, bytes: Buffer.from(f.objects.get(name)!.body) };
  }
  const consumeScan = (f: Awaited<ReturnType<typeof sealed>>, who = recordIdentity) =>
    f.archive.consume!(who, new AbortController().signal, plain => scanRecord(plain));

  it("returns the consumer's result for an intact record, with no file written", async () => {
    const f = await sealed();
    const scan = await consumeScan(f);
    expect(scan?.refusals).toEqual([{ seat: 0, tick: null, tool: "join", receivedAt: 1, code: "call_rate" }]);
    expect(await readdir(f.root)).toEqual([]);
  });

  // Credible regression: a consumer result returned before the tag verifies would release unauthenticated plaintext.
  it.each([
    ["an early structural corruption the scan meets before the tag", (b: Buffer) => { b[60] ^= 0x41; }],
    ["a late byte", (b: Buffer) => { b[b.length - 5] ^= 1; }],
    ["a tag byte", (b: Buffer) => { b[35] ^= 1; }],
    ["truncation", (b: Buffer) => b.subarray(0, b.length - 100)],
  ])("gives one fixed error for %s, releases nothing and writes nothing", async (_name, damage) => {
    const f = await sealed();
    const bytes = Buffer.from(f.bytes);
    const damaged = damage(bytes) ?? bytes;
    f.objects.set(f.name, { ...f.objects.get(f.name)!, body: damaged });
    let released: unknown = "nothing";
    const error = await f.archive.consume!(recordIdentity, new AbortController().signal, async plain => { released = await scanRecord(plain); return released; })
      .then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe("Private media unavailable");
    expect(String(error?.stack)).not.toContain("PLAINTEXT-MARKER");
    expect(await readdir(f.root)).toEqual([]);
  });

  it("gives the same error for another identity's object, and null for a missing one", async () => {
    const f = await sealed();
    f.objects.set(privateMediaName({ ...recordIdentity, lobbyId: "other-lobby" }), f.objects.get(f.name)!);
    await expect(consumeScan(f, { ...recordIdentity, lobbyId: "other-lobby" })).rejects.toThrow("Private media unavailable");
    expect(await consumeScan(f, { ...recordIdentity, replayId: "2026-10-20T08-00-00-000Z-2" })).toBeNull();
  });

  it("refuses a consumer that stops before the end, since the tag was never checked", async () => {
    const f = await sealed();
    await expect(f.archive.consume!(recordIdentity, new AbortController().signal, async plain => {
      for await (const _chunk of plain) return "first chunk only";
      return "none";
    })).rejects.toThrow("Private media unavailable");
  });
});

