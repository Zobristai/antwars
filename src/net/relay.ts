/** A stream's first chunks, holding at least the requested bytes unless it ended first, and an iterator over the rest. */
export interface Peeked {
  readonly head: Uint8Array[];
  readonly length: number;
  /** The remaining chunks, unread; `[...head, ...rest]` is the stream's bytes unchanged. */
  readonly rest: AsyncIterableIterator<Uint8Array | string>;
}

/**
 * Read only until `bytes` bytes have arrived, even across chunk boundaries, skipping empty chunks. Byte chunks are kept
 * as views, never decoded, copied or collected, so the caller can relay head then rest with backpressure; a string chunk
 * (an encoding-set stream) is taken as its UTF-8 bytes. Cancellation is the caller's (destroy).
 */
export async function peek(body: AsyncIterable<Uint8Array | string>, bytes: number): Promise<Peeked> {
  const rest = body[Symbol.asyncIterator]() as AsyncIterableIterator<Uint8Array | string>;
  const head: Uint8Array[] = [];
  let length = 0;
  while (length < bytes) {
    const next = await rest.next();
    if (next.done) break;
    const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
    if (chunk.byteLength === 0) continue;
    head.push(chunk); length += chunk.byteLength;
  }
  return { head, length, rest };
}

/** Gzip by its magic bytes, which may be split across the first two chunks; never by a stored label. */
export function isGzip(head: readonly Uint8Array[]): boolean {
  return head[0]?.[0] === 0x1f && (head[0].byteLength > 1 ? head[0][1] : head[1]?.[0]) === 0x8b;
}

/** The peeked bytes followed by the rest, as one source for a pipeline. */
export async function* relayed({ head, rest }: Peeked): AsyncGenerator<Uint8Array | string> { yield* head; yield* rest; }

/**
 * A 503 is logged with the method, the route class and the cause, as server.ts logs a 500: never the URL.
 * Warn, not error: the route answered cleanly; an upstream it depends on did not.
 */
export function logUnavailable(method: string | undefined, route: string, cause: unknown): void {
  console.warn(`antwar 503 ${method} ${route}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
}
