import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { MAX_RECORDING_MESSAGE_BYTES, RECORDING_AHEAD, RESUME_RETRY_MS, openRecording, recordingMessages, type Recording } from "../../web/src/recording.ts";
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

describe("a download that drops partway", () => {
  const ticks = packets.map((p) => decodeMessage(p).tick);
  /** Byte offset just past each message, length prefix included. */
  const ends = packets.reduce<number[]>((out, p) => [...out, (out.at(-1) ?? 0) + 4 + p.length], []);
  /** Partway through message `k`: messages before it arrive whole. */
  const mid = (k: number) => ends[k]! - 2;
  /** The recording's first `cut` bytes, then the connection drops as a browser reports it. */
  function dropping(cut: number, size = 719): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream({ pull(controller) {
      if (at >= cut) { controller.error(new TypeError("network error")); return; }
      const end = Math.min(cut, at + size);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    } });
  }
  /** Lets streams, promises and zero-delay timers run without moving the clock. */
  const settle = async () => { for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise((resolve) => setImmediate(resolve)); } };
  /** Plays on in 100ms frames until `until` holds, collecting each played tick. */
  async function playUntil(r: Recording, played: number[], clock: { real: number }, until: () => boolean) {
    for (let i = 0; i < 400 && !until(); i++) {
      for (const { m } of r.take(clock.real)) played.push(m.tick);
      clock.real += 100;
      await settle();
    }
    expect(until()).toBe(true);
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reopens after the first wait and resumes from the furthest tick reached, playing every tick once, in order, to the end", async () => {
    const responses = [dropping(mid(10)), dropping(mid(30)), body(bytes)];
    let requests = 0;
    const errors: Error[] = [];
    const r = openRecording("/replays/drop", (e) => errors.push(e), async () => new Response(responses[requests++]!));
    const played: number[] = [];
    const clock = { real: 0 };
    await playUntil(r, played, clock, () => played.length === 10);
    await settle();
    expect(requests).toBe(1);
    expect(r.error).toBeNull();
    await vi.advanceTimersByTimeAsync(RESUME_RETRY_MS[0]! - 1); await settle();
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(requests).toBe(2);
    // The reopen reached new ticks before it dropped too, so the next reopen waits the first wait again.
    await playUntil(r, played, clock, () => played.length === 30);
    await settle();
    await vi.advanceTimersByTimeAsync(RESUME_RETRY_MS[0]! - 1); await settle();
    expect(requests).toBe(2);
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(requests).toBe(3);
    await playUntil(r, played, clock, () => r.complete && r.stats.bufferedMessages === 0);
    expect(played).toEqual(ticks);
    expect(r.error).toBeNull();
    expect(errors).toEqual([]);
    expect(r.lastTick).toBe(ticks.at(-1));
    r.close();
  });

  it("does not start the waits over for ticks a reopen only reads again, and gives up after the last wait", async () => {
    let requests = 0;
    const errors: Error[] = [];
    // The first download reaches message 8; every reopen drops before it gets that far again.
    const r = openRecording("/replays/drop", (e) => errors.push(e), async () => new Response(requests++ === 0 ? dropping(mid(8)) : dropping(mid(5))));
    await r.first;
    await settle();
    for (const [i, wait] of RESUME_RETRY_MS.entries()) {
      expect(r.error).toBeNull();
      await vi.advanceTimersByTimeAsync(wait - 1); await settle();
      expect(requests).toBe(1 + i);
      await vi.advanceTimersByTimeAsync(1); await settle();
      expect(requests).toBe(2 + i);
    }
    expect(r.error?.message).toBe("network error");
    expect(errors).toEqual([r.error]);
    expect(r.take(1e6)).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(requests).toBe(1 + RESUME_RETRY_MS.length);
    r.close();
  });

  const undecodable = new Uint8Array([...packMessages([packets[0]!]), 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const failures: [string, () => Promise<Response>, RegExp][] = [
    ["a first request refused with HTTP 404", async () => new Response(null, { status: 404 }), /^This recording was not found \(HTTP 404\)\.$/],
    ["a first request refused with HTTP 503", async () => new Response(null, { status: 503 }), /^Recording unavailable \(HTTP 503\)\.$/],
    ["a first request that fails", async () => { throw new TypeError("Failed to fetch"); }, /^Failed to fetch$/],
    ["an empty recording", async () => new Response(body(new Uint8Array())), /^Recording is empty\.$/],
    ["a recording without an opening snapshot", async () => new Response(body(packMessages([packets[1]!]))), /^Recording has no opening snapshot\.$/],
    ["a recording with a gap in its ticks", async () => new Response(body(packMessages([packets[0]!, packets[2]!]))), /^Recording ticks are not continuous\.$/],
    ["a recording whose body ends cleanly partway through a message", async () => new Response(body(bytes.slice(0, mid(3)))), /^Recording download ended partway through a message\.$/],
    ["a recording with an undecodable message", async () => new Response(body(undecodable)), /^not a stream message$/],
  ];
  for (const [name, respond, text] of failures) it(`fails at once, never reopening, on ${name}`, async () => {
    let requests = 0;
    const errors: Error[] = [];
    const r = openRecording("/replays/bad", (e) => errors.push(e), async () => { requests++; return respond(); });
    await settle();
    expect(errors).toHaveLength(1);
    expect(r.error?.message).toMatch(text);
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(requests).toBe(1);
    expect(errors).toHaveLength(1);
    r.close();
  });

  it("ends a pending wait on close, never reopening or failing", async () => {
    let requests = 0;
    const errors: Error[] = [];
    const r = openRecording("/replays/drop", (e) => errors.push(e), async () => { requests++; return new Response(dropping(mid(5))); });
    await r.first;
    await settle();
    r.close();
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
    expect(r.error).toBeNull();
  });

  it("ends a pending wait on seek: the seek downloads at once and the dropped download is never reopened", async () => {
    const signals: AbortSignal[] = [];
    const r = openRecording("/replays/drop", undefined, async (_url, init) => {
      signals.push(init!.signal!);
      return new Response(signals.length === 1 ? dropping(mid(RECORDING_AHEAD + 2)) : body(bytes));
    }, { controls: true, endTick: async () => ticks.at(-1)!, marksWorker: null });
    const played: number[] = [];
    const clock = { real: 0 };
    // Every tick before the drop played, so the download has dropped and waits; the settled end lets the slider seek.
    await playUntil(r, played, clock, () => r.duration !== null && played.length === RECORDING_AHEAD + 2);
    await settle();
    const dropped = signals[0]!;
    const before = signals.length;
    r.seek(0);
    await settle();
    expect(signals.length).toBe(before + 1);
    expect(dropped.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000); await settle();
    expect(signals.filter((s) => s === dropped)).toHaveLength(1);
    expect(signals.length).toBe(before + 1);
    expect(r.error).toBeNull();
    played.length = 0;
    await playUntil(r, played, clock, () => r.complete && r.stats.bufferedMessages === 0);
    expect(played).toEqual(ticks);
    r.close();
  });

  it("reopens at once when the browser reports it is back online", async () => {
    const browser = new EventTarget();
    vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
    vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
    const responses = [dropping(mid(5)), body(bytes)];
    let requests = 0;
    const r = openRecording("/replays/drop", undefined, async () => new Response(responses[requests++]!));
    const played: number[] = [];
    const clock = { real: 0 };
    await playUntil(r, played, clock, () => played.length === 5);
    await settle();
    expect(requests).toBe(1);
    browser.dispatchEvent(new Event("online"));
    await settle();
    expect(requests).toBe(2);
    await playUntil(r, played, clock, () => r.complete && r.stats.bufferedMessages === 0);
    expect(played).toEqual(ticks);
    r.close();
  });
});
