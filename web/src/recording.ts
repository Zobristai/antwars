/** Incremental packed-recording reader. HTTP gzip decoding belongs to the browser, not this module. */
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import type { Arrival } from "./inbox.ts";
import { RENDER_DELAY_MS } from "./buffer.ts";

export const RECORDING_AHEAD = 20;
export const MAX_RECORDING_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Arbitrary network boundaries, including a split u32 prefix; retain only the current chunk and packet. */
export async function* recordingMessages(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ message: StreamMessage; bytes: number }> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let chunk: Uint8Array = new Uint8Array();
  let offset = 0;
  const read = async (size: number, eofAllowed = false): Promise<Uint8Array | null> => {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (filled === 0 && eofAllowed) return null;
          throw new Error("Recording download ended partway through a message.");
        }
        chunk = next.value;
        offset = 0;
        continue;
      }
      const count = Math.min(size - filled, chunk.length - offset);
      out.set(chunk.subarray(offset, offset + count), filled);
      offset += count;
      filled += count;
    }
    return out;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const prefix = await read(4, true);
      if (prefix === null) return;
      const length = new DataView(prefix.buffer).getUint32(0, true);
      if (length === 0 || length > MAX_RECORDING_MESSAGE_BYTES) throw new Error("Recording message size is invalid.");
      const bytes = (await read(length))!;
      yield { message: decodeMessage(bytes), bytes: length + 4 };
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface RecordingStats {
  decodedBytes: number;
  messages: number;
  bufferedMessages: number;
  bufferedBytes: number;
  peakBufferedMessages: number;
  peakBufferedBytes: number;
}

export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;
export type PlaybackRate = typeof PLAYBACK_RATES[number];

export interface Recording {
  readonly first: Promise<StreamMessage>;
  readonly stats: Readonly<RecordingStats>;
  readonly time: number;
  /** EOF or an independently recorded end tick, never an empty queue or the configured time limit. */
  readonly lastTick: number;
  readonly complete: boolean;
  readonly error: Error | null;
  readonly duration: number | null;
  readonly durationError: string | null;
  readonly position: number;
  readonly rate: PlaybackRate;
  readonly seeking: boolean;
  /** Changes synchronously on seek; consumers rebuild their derived playback state. */
  readonly generation: number;
  setRate(rate: PlaybackRate): void;
  seek(positionMs: number): void;
  take(realMs: number): Arrival[];
  close(): void;
}

export interface RecordingOptions {
  /** Only explicit replay pages opt in; live stand-ins keep their original stream and clocks. */
  controls?: boolean;
  /** Recorded terminal tick, not setup.matchTicks (which is only the time limit). */
  endTick?: (signal: AbortSignal) => Promise<number | null>;
  /** Applied to every played message in order, once settled; null plays the recording as it is. */
  restate?: Promise<((m: StreamMessage) => StreamMessage) | null>;
}

/** At most two seconds decoded ahead; seeks replay every delta in bounded frame-sized batches. */
export function openRecording(url: string, onError: (error: Error) => void = () => {}, request: typeof fetch = fetch, options: RecordingOptions = {}): Recording {
  let abort = new AbortController();
  const lifetime = new AbortController();
  let resolveFirst!: (message: StreamMessage) => void;
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<StreamMessage>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  void first.catch(() => undefined);
  const queue: { m: StreamMessage; at: number; bytes: number }[] = [];
  const stats: RecordingStats = { decodedBytes: 0, messages: 0, bufferedMessages: 0, bufferedBytes: 0, peakBufferedMessages: 0, peakBufferedBytes: 0 };
  let changed: (() => void) | null = null;
  let firstTick: number | null = null;
  let newestTick = -1;
  let endTick: number | null = null;
  let done = false;
  let closed = false;
  let error: Error | null = null;
  let durationError: string | null = null;
  let time = 0;
  let real: number | null = null;
  let deliveredAt = 0;
  let rate: PlaybackRate = 1;
  let generation = 0;
  let seekTo: number | null = null;
  const notify = () => { changed?.(); changed = null; };
  const duration = () => firstTick === null || endTick === null ? null : (endTick - firstTick) * TICK_MS;
  // Duration discovery retains no messages or boards. Missing/private/legacy history
  // falls back to a cancellable streaming scan, independent of playback backpressure.
  const discoverEnd = async () => {
    try {
      const known = await options.endTick?.(lifetime.signal).catch(() => null);
      if (closed || endTick !== null) return;
      if (known !== undefined && known !== null && Number.isSafeInteger(known) && known >= firstTick!) {
        endTick ??= known;
        return;
      }
      const response = await request(url, { signal: lifetime.signal });
      if (!response.ok || !response.body) throw new Error("Replay duration unavailable; playback can continue.");
      let previous: number | null = null;
      let count = 0;
      for await (const { message: m } of recordingMessages(response.body, lifetime.signal)) {
        if (closed) return;
        if (previous === null ? m.full === null || m.tick !== firstTick : m.full !== null || m.tick !== previous + 1) {
          throw new Error("Recording ticks are not continuous.");
        }
        previous = m.tick;
        // A cached response must also yield to input and rendering.
        if (++count % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (previous === null) throw new Error("Recording is empty.");
      if (!closed) endTick = previous;
    } catch (cause) {
      if (!closed) durationError = cause instanceof Error ? cause.message : String(cause);
    }
  };
  const pump = async (version: number, signal: AbortSignal) => {
    try {
      const response = await request(url, { signal });
      if (closed || version !== generation) { await response.body?.cancel(); return; }
      if (!response.ok) throw new Error(response.status === 404 ? "This recording was not found (HTTP 404)." : `Recording unavailable (HTTP ${response.status}).`);
      if (!response.body) throw new Error("This browser cannot stream the recording.");
      const messages = recordingMessages(response.body, signal);
      let previous: number | null = null;
      try {
        const restate = await options.restate;
        for (;;) {
          if (queue.length >= RECORDING_AHEAD) await new Promise<void>((resolve) => { changed = resolve; });
          if (closed || version !== generation) return;
          const next = await messages.next();
          if (closed || version !== generation) return;
          if (next.done) {
            if (previous === null) throw new Error("Recording is empty.");
            done = true;
            endTick = newestTick;
            break;
          }
          const { bytes } = next.value;
          const m = restate ? restate(next.value.message) : next.value.message;
          if (previous === null) {
            if (m.full === null) throw new Error("Recording has no opening snapshot.");
            if (firstTick !== null && m.tick !== firstTick) throw new Error("Recording opening tick changed.");
            firstTick = m.tick;
          } else if (m.tick !== previous + 1 || m.full !== null) throw new Error("Recording ticks are not continuous.");
          previous = newestTick = m.tick;
          queue.push({ m, at: (m.tick - firstTick!) * TICK_MS, bytes });
          stats.messages++;
          stats.decodedBytes += bytes;
          stats.bufferedMessages = queue.length;
          stats.bufferedBytes += bytes;
          stats.peakBufferedMessages = Math.max(stats.peakBufferedMessages, queue.length);
          stats.peakBufferedBytes = Math.max(stats.peakBufferedBytes, stats.bufferedBytes);
          if (stats.messages === 1) {
            resolveFirst(m);
            if (m.full?.result) endTick = m.full.result.tick + 1;
          }
          // Short recordings reach EOF without any second request. Discover an
          // end independently only when the normal reader reaches backpressure.
          if (stats.messages === RECORDING_AHEAD && options.controls && endTick === null) void discoverEnd();
        }
      } finally { await messages.return(undefined); }
      if (firstTick === null) throw new Error("Recording is empty.");
    } catch (cause: unknown) {
      if (closed || version !== generation) return;
      error = cause instanceof Error ? cause : new Error(String(cause));
      rejectFirst(error);
      onError(error);
    }
  };
  void pump(generation, abort.signal);
  return {
    first, stats,
    get time() { return time; },
    get lastTick() { return endTick ?? Number.POSITIVE_INFINITY; },
    get complete() { return done; },
    get error() { return error; },
    get duration() { return duration(); },
    get durationError() { return durationError; },
    get position() { return Math.min(duration() ?? Infinity, Math.max(0, time - RENDER_DELAY_MS)); },
    get rate() { return rate; },
    get seeking() { return seekTo !== null; },
    get generation() { return generation; },
    setRate(value) {
      if (!(PLAYBACK_RATES as readonly number[]).includes(value)) throw new Error("Unsupported replay speed.");
      rate = value;
      real = null; // Never retroactively scale a suspended frame.
    },
    seek(positionMs) {
      const length = duration();
      if (!options.controls || closed || error || length === null || !Number.isFinite(positionMs)) return;
      generation++;
      abort.abort();
      notify();
      abort = new AbortController();
      queue.length = 0;
      stats.bufferedMessages = stats.bufferedBytes = 0;
      done = false;
      newestTick = firstTick! - 1;
      deliveredAt = time = 0;
      real = null;
      seekTo = Math.max(0, Math.min(length, positionMs)) + RENDER_DELAY_MS;
      void pump(generation, abort.signal);
    },
    take(realMs) {
      if (closed || error !== null) return [];
      const elapsed = real === null ? 0 : Math.max(0, Math.min(250, realMs - real)) * rate;
      real = realMs;
      const available = queue.at(-1)?.at ?? deliveredAt;
      if (seekTo !== null) {
        // Sampling each batch discards unreachable history; a fresh Playback on
        // generation change removes future story, trails and effect state.
        time = Math.min(seekTo, available + RENDER_DELAY_MS);
      } else time = done ? time + elapsed : Math.min(time + elapsed, available);
      const out: Arrival[] = [];
      while (queue.length && queue[0]!.at <= time) {
        const item = queue.shift()!;
        out.push({ m: item.m, at: item.at });
        deliveredAt = item.at;
        stats.bufferedBytes -= item.bytes;
      }
      if (seekTo !== null && (available >= seekTo || done)) {
        time = Math.min(seekTo, available + RENDER_DELAY_MS);
        seekTo = null;
      }
      stats.bufferedMessages = queue.length;
      if (out.length) notify();
      return out;
    },
    close() {
      closed = true;
      abort.abort();
      lifetime.abort();
      queue.length = 0;
      stats.bufferedMessages = stats.bufferedBytes = 0;
      rejectFirst(new Error("Recording closed."));
      notify();
    },
  };
}
