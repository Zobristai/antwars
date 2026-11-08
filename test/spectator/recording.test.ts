import { describe, expect, it, vi } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { MAX_RECORDING_MESSAGE_BYTES, RECORDING_AHEAD, openRecording, recordingMessages } from "../../web/src/recording.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const packets = scale2Packets(45);
const bytes = packMessages(packets);
function body(bytes: Uint8Array, size = 719): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({ pull(controller) { if (at === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(at, at + size)); at = Math.min(bytes.length, at + size); } } });
}
const request = (stream: ReadableStream<Uint8Array>): typeof fetch => async () => new Response(stream);

it("decodes split length prefixes and payloads exactly, releasing the reader at EOF", async () => {
  const stream = body(bytes, 3);
  const out = [];
  // The recording is public (as stored recordings are), so its own public encoder reproduces each packet exactly.
  for await (const value of recordingMessages(stream)) out.push(encodePublicMessage(value.message));
  expect(out).toEqual(packets.map((packet) => new Uint8Array(packet)));
  expect(stream.locked).toBe(false);
});

describe("corrupt and failed recordings", () => {
  for (const cut of [1, 2, 3, bytes.length - 1]) it(`rejects truncation at byte ${cut}`, async () => {
    await expect(async () => { for await (const _ of recordingMessages(body(bytes.slice(0, cut)))) { /* drain */ } }).rejects.toThrow(/partway/);
  });
  it("rejects an oversized prefix before allocating the payload", async () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, MAX_RECORDING_MESSAGE_BYTES + 1, true);
    await expect(recordingMessages(body(prefix)).next()).rejects.toThrow(/size/);
  });
  for (const status of [404, 503]) it(`surfaces HTTP ${status} without falling back to live`, async () => {
    const errors: Error[] = [];
    const r = openRecording("/replays/missing", (e) => errors.push(e), async () => new Response(null, { status }));
    await expect(r.first).rejects.toThrow(`HTTP ${status}`);
    expect(errors).toHaveLength(1);
    expect(r.error).toBe(errors[0]);
  });
  it("rejects an empty stream and a delta-only opening", async () => {
    const empty = openRecording("/replays/empty", undefined, request(body(new Uint8Array())));
    await expect(empty.first).rejects.toThrow(/empty/);
    const delta = openRecording("/replays/delta", undefined, request(body(packMessages([packets[1]!]))));
    await expect(delta.first).rejects.toThrow(/opening snapshot/);
  });
});

it("bounds decoded read-ahead and frame catch-up, preserves every tick and detects EOF only after reading it", async () => {
  const r = openRecording("/replays/full", undefined, request(body(bytes)));
  await r.first;
  await vi.waitFor(() => expect(r.stats.bufferedMessages).toBe(RECORDING_AHEAD));
  expect(r.complete).toBe(false);
  expect(r.lastTick).toBe(Infinity);
  const playback = new Playback();
  const frame = new Frame();
  const ticks: number[] = [];
  let real = 0;
  const drain = () => {
    for (const { m, at } of r.take(real)) { ticks.push(m.tick); playback.push(m, at); }
    playback.sample(r.time, frame);
  };
  drain();
  real = 1e9; drain();
  expect(r.time).toBe(250);
  expect(ticks).toHaveLength(3);
  for (let i = 0; i < 50; i++) {
    real += 100; drain();
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(ticks).toEqual(packets.map((p) => decodeMessage(p).tick));
  expect(r.complete).toBe(true);
  expect(frame.tick).toBe(decodeMessage(packets.at(-1)!).tick);
  expect(r.stats.peakBufferedMessages).toBeLessThanOrEqual(RECORDING_AHEAD);
  expect(r.stats.bufferedBytes).toBe(0);
  r.close();
});

it("freezes the playback clock at a network stall and resumes continuously, without declaring an end", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(packMessages(packets.slice(0, 2))); } });
  const r = openRecording("/replays/slow", undefined, request(stream));
  await r.first;
  await vi.waitFor(() => expect(r.stats.messages).toBe(2));
  r.take(0); r.take(100); r.take(1000);
  expect(r.time).toBe(100);
  expect(r.lastTick).toBe(Infinity);
  controller.enqueue(packMessages(packets.slice(2, 5)));
  controller.close();
  await vi.waitFor(() => expect(r.complete).toBe(true));
  expect(r.take(1100).map(({ m }) => m.tick)).toEqual([decodeMessage(packets[2]!).tick]);
  expect(r.time).toBe(200);
  r.close();
});

it("aborts downloads and releases a full queue on close", async () => {
  let signal: AbortSignal | null | undefined;
  const r = openRecording("/replays/cancel", undefined, async (_url, options) => { signal = options?.signal; return new Response(body(bytes)); });
  await r.first;
  await vi.waitFor(() => expect(r.stats.bufferedMessages).toBe(RECORDING_AHEAD));
  r.close();
  expect(signal?.aborted).toBe(true);
  expect(r.stats.bufferedMessages).toBe(0);
  expect(r.take(100)).toEqual([]);
});
