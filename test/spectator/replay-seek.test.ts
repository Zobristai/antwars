import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { openRecording, RECORDING_AHEAD, type Recording } from "../../web/src/recording.ts";
import { recordedEndTick } from "../../web/src/source.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const first = decodeMessage(scale2Packets(1)[0]!);
const messages: StreamMessage[] = Array.from({ length: 65 }, (_, i) => ({
  ...first, tick: first.tick + i, full: i === 0 ? structuredClone(first.full) : null,
  ants: { ...first.ants, x: first.ants.x.map(x => x + i) },
  events: i === 15 ? [{ kind: "order", agent: 0, order: "hold", tileX: 10, tileY: 10, intent: "Earlier intent" }]
    : i === 64 ? [{ kind: "end", result: { winner: 0, reason: "time_up", decidedBy: "territory", tick: first.tick + 63, nextStartMs: null } }]
    : [],
}));
const bytes = packMessages(messages.map(encodeMessage));
const active: Recording[] = [];
afterEach(() => { for (const r of active.splice(0)) r.close(); });
function stream(data = bytes) {
  let at = 0;
  return new ReadableStream<Uint8Array>({ pull(c) {
    if (at === data.length) c.close();
    else { c.enqueue(data.slice(at, at + 719)); at = Math.min(data.length, at + 719); }
  } });
}
function open(endTick: (() => Promise<number | null>) | undefined = async () => first.tick + 64, request: typeof fetch = async () => new Response(stream())) {
  const r = openRecording("/recording", undefined, request, { controls: true, endTick });
  active.push(r);
  return r;
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Reconstruct with the real production Playback, sampling between bounded batches as both render loops do. */
async function seek(r: Recording, ms: number) {
  r.seek(ms);
  const playback = new Playback(), frame = new Frame();
  for (let i = 0; i < 100; i++) {
    await turn();
    const batch = r.take(i * 16);
    expect(batch.length).toBeLessThanOrEqual(RECORDING_AHEAD);
    for (const arrival of batch) playback.push(arrival.m, arrival.at);
    playback.sample(r.time, frame);
    if (!r.seeking) return frame;
  }
  throw new Error("Seek never completed");
}
function straight(ms: number) {
  const playback = new Playback(), frame = new Frame();
  // Match the source's look-ahead boundary: future terminal/effect metadata must not leak backward.
  for (let i = 0; i < messages.length && i * 100 <= ms + RENDER_DELAY_MS; i++) playback.push(messages[i]!, i * 100);
  playback.sample(ms + RENDER_DELAY_MS, frame);
  return frame;
}

it("seeks forward, back from a result, to zero and to EOF with the same recorded state, story and trails", async () => {
  const r = open();
  await r.first;
  await vi.waitFor(() => expect(r.duration).toBe(6400));
  for (const target of [6400, 1800, 0, 3275, 5500, 99999, -100]) {
    const actual = await seek(r, target), expected = straight(Math.max(0, Math.min(6400, target)));
    expect(actual.tick).toBe(expected.tick);
    expect(actual.board).toEqual(expected.board);
    expect(actual.story).toEqual(expected.story);
    expect(actual.chat).toEqual(expected.chat);
    expect(actual.trails).toEqual(expected.trails);
    expect(actual.corpses).toEqual(expected.corpses);
    expect(actual.lossShown).toEqual(expected.lossShown);
    expect(actual.endShown).toBe(expected.endShown);
    expect([...actual.x.slice(0, actual.count)]).toEqual([...expected.x.slice(0, expected.count)]);
  }
  expect(r.generation).toBe(7);
  expect(r.stats.peakBufferedMessages).toBeLessThanOrEqual(RECORDING_AHEAD);
  // The grid-scale-2 board is four times the cells: the exact whole-board comparisons above take about 2 s
  // per target, not the seeks. The harness limit, not an assertion, is raised.
}, 30_000);

it("uses a known duration at once, and reads the whole recording once for the marks, which also settles an unknown end", async () => {
  const request = vi.fn<typeof fetch>(async () => new Response(stream()));
  const known = open(async () => first.tick + 64, request);
  await known.first;
  await vi.waitFor(() => expect(known.duration).toBe(6400));
  await vi.waitFor(() => expect(known.events).not.toBeNull());
  expect(request).toHaveBeenCalledTimes(2);
  const unknown = open(async () => { throw new Error("History missing"); }, request);
  await unknown.first;
  await vi.waitFor(() => expect(unknown.duration).toBe(6400));
  expect(request).toHaveBeenCalledTimes(4);
  // setup.matchTicks is not the actual end, and the whole-recording read does not drain the playback queue.
  expect(unknown.duration).not.toBe(first.full!.setup.matchTicks * 100);
  expect(unknown.stats.bufferedMessages).toBe(RECORDING_AHEAD);
  expect(unknown.complete).toBe(false);
});

it("cancels stale seeks, blocked reads and the whole-recording read on close", async () => {
  const signals: { url: string; signal: AbortSignal }[] = [];
  let canceled = 0;
  let playbackReads = 0;
  // Playback reads and the marks' read share one URL; the marks' read is the one made with the recording's lifetime
  // signal, after playback has its first two seconds. The second playback read (the first seek) blocks.
  const request: typeof fetch = async (url, options) => {
    signals.push({ url: String(url), signal: options!.signal! });
    if (signals.length === 2) return new Response(stream()); // the marks' read
    if (++playbackReads === 2) return new Response(new ReadableStream<Uint8Array>({ cancel() { canceled++; } }));
    return new Response(stream());
  };
  const r = open(undefined, request);
  await r.first;
  await vi.waitFor(() => expect(r.duration).toBe(6400));
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  r.seek(6000); // blocked reopened stream
  await turn();
  r.seek(100);
  await turn();
  for (let i = 0; i < 10 && r.seeking; i++) { r.take(i * 16); await turn(); }
  expect(r.error).toBeNull();
  expect(r.seeking).toBe(false);
  expect(r.position).toBe(100);
  expect(signals[0]!.signal.aborted).toBe(true); // the first playback read
  expect(signals[2]!.signal.aborted).toBe(true); // the blocked seek
  expect(signals[1]!.signal.aborted).toBe(false); // the marks' read outlives seeks
  expect(canceled).toBe(1);
  let reads = 0;
  const scan = open(async () => null, async (_url, options) => {
    signals.push({ url: "/scan", signal: options!.signal! });
    return reads++ === 0 ? new Response(stream()) : new Response(new ReadableStream<Uint8Array>({ cancel() { canceled++; } }));
  });
  await scan.first;
  await vi.waitFor(() => expect(reads).toBe(2));
  scan.close();
  await turn();
  expect(signals.at(-1)!.signal.aborted).toBe(true);
  expect(canceled).toBe(2);
});

it("exposes scan failure without breaking playback, and reports corrupt seek downloads", async () => {
  let requests = 0;
  const r = open(async () => null, async () => ++requests === 1 ? new Response(stream()) : new Response(null, { status: 503 }));
  await r.first;
  await vi.waitFor(() => expect(r.durationError).toMatch(/unavailable/));
  expect(r.error).toBeNull();
  expect(r.take(0)).toHaveLength(1);
  const bad = open(async () => first.tick + 64, async () => new Response(stream(++requests === 3 ? bytes : bytes.slice(0, 3))));
  await bad.first;
  await vi.waitFor(() => expect(bad.duration).toBe(6400));
  bad.seek(1000);
  await vi.waitFor(() => expect(bad.error?.message).toMatch(/partway/));
});

const id = "2026-10-18T12-34-56-789Z-1";
it("reads only a matching recorded result's completed tick, rejecting missing, wrong and oversized metadata", async () => {
  const controller = new AbortController();
  const record = { format: "antwar.match", version: 1, id, result: { tick: 123 } };
  const request = vi.fn<typeof fetch>(async () => Response.json(record));
  expect(await recordedEndTick(id, controller.signal, request)).toBe(124);
  expect(request.mock.calls[0]![0]).toBe(`/matches/${id}`);
  expect(request.mock.calls[0]![1]).toMatchObject({ credentials: "omit", redirect: "error" });
  for (const value of [{ ...record, id: "other" }, { ...record, result: null }, { ...record, result: { tick: -1 } }, { ...record, result: { tick: 1.5 } }, { ...record, format: "other" }]) {
    expect(await recordedEndTick(id, controller.signal, async () => Response.json(value))).toBeNull();
  }
  expect(await recordedEndTick(id, controller.signal, async () => Response.json({ ...record, events: "x".repeat(256 * 1024) }))).toBeNull();
});

it("rejects an empty reopened stream instead of accepting metadata as a completed seek", async () => {
  let requests = 0;
  const r = open(async () => first.tick + 64, async () => new Response(stream(++requests === 1 ? bytes : new Uint8Array())));
  await r.first;
  await vi.waitFor(() => expect(r.duration).toBe(6400));
  r.seek(1000);
  await vi.waitFor(() => expect(r.error?.message).toBe("Recording is empty."));
  expect(r.complete).toBe(false);
});
