import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { peek } from "../net/relay.js";
import { createGcsObjectReader, isReplayId, type ReplayGet, type ReplayRead } from "./access.js";
import { createGcsReplayStore, type ReplayStore } from "./store.js";
import { PRIVATE_MEDIA_HEADER_BYTES, privateMediaDecipher, privateMediaKey, privateMediaName, sealPrivateMedia, type PrivateMediaIdentity } from "./private-media.js";

export interface PrivateArchive {
  /** Adapter for ReplayRecording: both its binary and readable JSON go to isolated ciphertext. */
  forLobby(lobbyId: string): ReplayStore;
  /** Caller must authorize the current invite before invoking this read. */
  open(identity: PrivateMediaIdentity, signal: AbortSignal): Promise<ReplayRead | null>;
  /**
   * Caller must authorize before invoking this read. Streams the plaintext into consume with no copy on disk, and
   * returns its result only once the whole GCM tag has verified; null when the object is missing. Any failure, of the
   * object, the tag or consume itself, is one fixed error carrying no detail, and consume's result is discarded:
   * consume must keep what it reads to itself until it returns.
   */
  consume?<T>(identity: PrivateMediaIdentity, signal: AbortSignal, consume: (plaintext: AsyncIterable<Uint8Array>) => Promise<T>): Promise<T | null>;
}
export type ObjectReader = (name: string, signal: AbortSignal) => Promise<ReplayRead | null>;

/** Optional and lazy: absence disables private recording, never substitutes the public writer. */
export function privateArchiveFromEnv(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch, get?: ReplayGet): PrivateArchive | undefined {
  const bucket = env.ANTWAR_REPLAY_BUCKET;
  const key = privateMediaKey(env.ANTWAR_PRIVATE_REPLAY_KEY);
  if (!bucket || !key) return undefined;
  return createPrivateArchive(createGcsReplayStore(bucket, request), createGcsObjectReader(bucket, request, get), key);
}

/** Same bucket may be used safely: no private plaintext or legacy public alias is ever written. */
export function createPrivateArchive(
  writer: ReplayStore,
  read: ObjectReader,
  key: Uint8Array,
  scratchRoot: string = tmpdir(),
): PrivateArchive {
  if (key.byteLength !== 32) throw new Error("Private media encryption is not configured");
  const secret = Buffer.from(key);
  return {
    forLobby(lobbyId) {
      if (!lobbyId) throw new Error("Invalid private lobby");
      return {
        async create(object) {
          const suffix = object.name.endsWith(".bin") ? ".bin" : object.name.endsWith(".json") ? ".json" : null;
          const id = suffix === null ? "" : object.name.slice(0, -suffix.length);
          if (!isReplayId(id)) throw new Error("Invalid private recording object");
          const identity: PrivateMediaIdentity = { lobbyId, replayId: id, kind: suffix === ".bin" ? "recording" : "match-record" };
          await writer.create({
            name: privateMediaName(identity), body: sealPrivateMedia(identity, object.body, secret),
            contentType: "application/octet-stream", ifGenerationMatch: 0,
          });
        },
      };
    },
    async open(identity, signal) {
      if (!isReplayId(identity.replayId)) throw new Error("Invalid private recording id");
      signal.throwIfAborted();
      const object = await read(privateMediaName(identity), signal);
      if (object === null) return null;
      let directory: string | undefined;
      try {
        signal.throwIfAborted();
        directory = await mkdtemp(join(scratchRoot, "antwar-private-"));
        const file = join(directory, "media");
        const { head, length, rest } = await peek(object.body, PRIVATE_MEDIA_HEADER_BYTES);
        if (length < PRIVATE_MEDIA_HEADER_BYTES) throw new Error("Invalid private media");
        const prefix = Buffer.concat(head);
        const decoder = privateMediaDecipher(identity, prefix.subarray(0, PRIVATE_MEDIA_HEADER_BYTES), secret);
        const encrypted = Readable.from((async function* () { yield prefix.subarray(PRIVATE_MEDIA_HEADER_BYTES); yield* rest; })(), { objectMode: false });
        // GCM plaintext is untrusted until final(). Spool with private permissions
        // and return nothing to the HTTP caller before the whole tag verifies.
        await pipeline(encrypted, decoder, createWriteStream(file, { mode: 0o600, flags: "wx" }), { signal });
        signal.throwIfAborted();
        const contentLength = String((await stat(file)).size);
        const ownedDirectory = directory;
        const body = createReadStream(file, { signal });
        body.on("error", () => {});
        body.once("close", () => { void rm(ownedDirectory, { recursive: true, force: true }).catch(() => {}); });
        return { body, contentLength };
      } catch {
        if (directory) await rm(directory, { recursive: true, force: true });
        if (signal.aborted) throw signal.reason;
        // Neither cryptographic details nor potentially sensitive upstream errors escape.
        throw new Error("Private media unavailable");
      } finally {
        object.body.destroy();
      }
    },
    async consume<T>(identity: PrivateMediaIdentity, signal: AbortSignal, consume: (plaintext: AsyncIterable<Uint8Array>) => Promise<T>): Promise<T | null> {
      if (!isReplayId(identity.replayId)) throw new Error("Invalid private recording id");
      signal.throwIfAborted();
      const object = await read(privateMediaName(identity), signal);
      if (object === null) return null;
      try {
        const { head, length, rest } = await peek(object.body, PRIVATE_MEDIA_HEADER_BYTES);
        if (length < PRIVATE_MEDIA_HEADER_BYTES) throw new Error("Invalid private media");
        const prefix = Buffer.concat(head);
        const decoder = privateMediaDecipher(identity, prefix.subarray(0, PRIVATE_MEDIA_HEADER_BYTES), secret);
        const encrypted = Readable.from((async function* () { yield prefix.subarray(PRIVATE_MEDIA_HEADER_BYTES); yield* rest; })(), { objectMode: false });
        // GCM plaintext is untrusted until final(): the pipeline settles only after the decoder's final() has verified
        // the tag, and a failed tag rejects it, so consume's result is returned only for authenticated bytes.
        let result: { value: T } | undefined;
        await pipeline(encrypted, decoder, async (plaintext: AsyncIterable<Uint8Array>) => { result = { value: await consume(plaintext) }; }, { signal });
        signal.throwIfAborted();
        // A consume that returned before reading to the end never saw the tag verified.
        if (result === undefined || !decoder.readableEnded) throw new Error("Private media unavailable");
        return result.value;
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new Error("Private media unavailable");
      } finally {
        object.body.destroy();
      }
    },
  };
}
