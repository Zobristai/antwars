/// <reference types="node" />
import { setImmediate as yieldTurn } from "node:timers/promises";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { constants, createGunzip, createGzip } from "node:zlib";

const CHUNK_BYTES = 64 * 1024;

function framePrefix(frame: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, frame.length, true);
  return prefix;
}

/** One body from chunks, copied a bounded part at a time with a yield after each part. */
export async function joinChunks(chunks: readonly Uint8Array[], length: number): Promise<Uint8Array> {
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    for (let start = 0; start < chunk.length; start += CHUNK_BYTES) {
      const part = chunk.subarray(start, start + CHUNK_BYTES);
      body.set(part, offset); offset += part.length;
      await yieldTurn();
    }
  }
  return body;
}

/** The existing u32-length-prefixed recording format, packed a bounded chunk at a time. */
async function* packedChunks(messages: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  let chunk = new Uint8Array(CHUNK_BYTES), used = 0;
  for (const message of messages) {
    for (const bytes of [framePrefix(message), message]) {
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(chunk.length - used, bytes.length - offset);
        chunk.set(bytes.subarray(offset, offset + count), used);
        used += count; offset += count;
        if (used === chunk.length) {
          yield chunk;
          await yieldTurn();
          chunk = new Uint8Array(CHUNK_BYTES); used = 0;
        }
      }
    }
  }
  if (used > 0) yield chunk.subarray(0, used);
}

/**
 * No synchronous whole-recording allocation/copy on the match timer. Packing
 * yields every 64 KiB; gzip uses zlib's worker pool with stream backpressure.
 * The store still accepts one compressed body, assembled with bounded copies.
 */
export async function gzipMessages(messages: readonly Uint8Array[]): Promise<Uint8Array> {
  // Even a small recording starts after the hub's final release returns.
  await yieldTurn();
  const compressed: Uint8Array[] = [];
  let length = 0;
  await pipeline(Readable.from(packedChunks(messages), { objectMode: false }), createGzip(), async (source) => {
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      compressed.push(bytes); length += bytes.length;
    }
  });
  return joinChunks(compressed, length);
}

/**
 * One gzip member whose gunzip is the gunzips of bodies in order, each body one or more whole gzip
 * members, recompressed on zlib's thread pool: readers that stop after a first member read it all.
 */
export async function joinGzip(bodies: readonly Uint8Array[]): Promise<Uint8Array> {
  const compressed: Uint8Array[] = [];
  let length = 0;
  await pipeline(Readable.from(bodies, { objectMode: false }), createGunzip(), createGzip(), async (source) => {
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      compressed.push(bytes); length += bytes.length;
    }
  });
  return joinChunks(compressed, length);
}

/**
 * A copy's compressed output is held in blocks of this size, so a handover save takes the full
 * blocks as its parts as they are; only the output since the last full block, at most this size, is joined
 * for the save, so a late match's recording is never copied whole in the server's memory.
 */
export const GZIP_BLOCK_BYTES = 16 * 1024 * 1024;

/**
 * One recording copy held as a single gzip stream of u32 little-endian length-prefixed frames,
 * compressed on zlib's thread pool as each frame arrives (sync flush per frame), never synchronously.
 */
export class GzipFrames {
  private readonly gzip = createGzip();
  /** Compressed output in order: full blocks of GZIP_BLOCK_BYTES, then the output since, as zlib gave it (no unused capacity). */
  private blocks: Uint8Array[] = [];
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private compressed = 0;
  private queued = 0;
  private flushed: Promise<void> = Promise.resolve();
  private open = true;
  private dropped = false;

  /** onError is called at most once if compression fails; the copy is then unusable. */
  constructor(onError: (error: unknown) => void) {
    this.gzip.on("data", (chunk: Buffer) => this.hold(chunk));
    let reported = false;
    this.gzip.on("error", error => {
      this.open = false;
      if (!reported) { reported = true; onError(error); }
    });
  }

  /** Queues one frame (prefix, then bytes) and returns at once. Ignored after finish or destroy. */
  push(frame: Uint8Array): void {
    if (!this.open) return;
    const bytes = 4 + frame.length;
    this.queued += bytes;
    this.gzip.write(framePrefix(frame));
    this.gzip.write(frame);
    // A destroyed or failed stream still calls back, so settled() never hangs.
    this.flushed = new Promise(resolve => this.gzip.flush(constants.Z_SYNC_FLUSH, () => { this.queued -= bytes; resolve(); }));
  }

  /** Bytes held now: compressed output held plus bytes of frames queued but not yet compressed.
   * Excludes zlib's fixed working memory. */
  get heldBytes(): number {
    return this.dropped ? 0 : this.compressed + this.queued;
  }

  /** Resolves once every frame pushed so far is reflected in compressed output (test seam). */
  settled(): Promise<void> {
    return this.flushed;
  }

  /** Ends the stream; resolves to the whole gzip body, whose gunzip equals the framed bytes
   * gzipMessages packs for the same frames. Assembles the body with bounded, yielding copies. */
  async finish(): Promise<Uint8Array> {
    const blocks = await this.finishBlocks();
    return joinChunks(blocks, blocks.reduce((sum, block) => sum + block.byteLength, 0));
  }

  /**
   * Ends the stream like finish, resolving to the same body as the held full blocks in order, uncopied, then
   * the output since the last of them joined into one block; the copy holds nothing afterwards.
   */
  async finishBlocks(): Promise<Uint8Array[]> {
    if (this.dropped) throw new Error("recording copy was dropped");
    this.open = false;
    this.gzip.end();
    await finished(this.gzip);
    const blocks = this.tailBytes === 0 ? this.blocks : [...this.blocks, Buffer.concat(this.tail, this.tailBytes)];
    this.blocks = []; this.tail = []; this.tailBytes = 0; this.compressed = 0;
    return blocks;
  }

  /** Drops everything held. finish after destroy rejects. */
  destroy(): void {
    this.open = false;
    this.dropped = true;
    this.blocks = []; this.tail = []; this.tailBytes = 0; this.compressed = 0;
    this.gzip.destroy();
  }

  /** Holds compressed output, joining it into a full block each time GZIP_BLOCK_BYTES of it has arrived. */
  private hold(chunk: Uint8Array): void {
    if (this.dropped) return;
    this.compressed += chunk.byteLength;
    for (let offset = 0; offset < chunk.byteLength;) {
      const count = Math.min(chunk.byteLength - offset, GZIP_BLOCK_BYTES - this.tailBytes);
      this.tail.push(offset === 0 && count === chunk.byteLength ? chunk : chunk.subarray(offset, offset + count));
      this.tailBytes += count; offset += count;
      if (this.tailBytes === GZIP_BLOCK_BYTES) { this.blocks.push(Buffer.concat(this.tail, GZIP_BLOCK_BYTES)); this.tail = []; this.tailBytes = 0; }
    }
  }
}
