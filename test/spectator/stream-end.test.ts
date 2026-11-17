/**
 * The slot ends a finished match's stream after its final frames, so the
 * browser link closes once it has the result and does not reconnect to that match.
 * A stream dropped before the result still reconnects as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { decodeMessage, encodePublicMessage, type StreamMessage, type StreamResult } from "../../src/live/format.ts";
import { decodeMessage as oldDecode } from "../live/fixtures/pre-queen-ranking-format.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";
import { Frame, Playback, resultShownAt, TickPreparation } from "../../web/src/buffer.ts";
import { openSource, CONNECT_MS } from "../../web/src/source.ts";
import { resultHeadline } from "../../web/src/ui/format.ts";
import { resultHow } from "../../web/src/story.ts";
import { openLive, type EventSourceLike, type LinkState } from "../../web/src/stream.ts";

/** An EventSource the test drives: emit() is one SSE message, drop() an error with the given readyState. */
class Source implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  readyState = 0;
  closes = 0;
  open(): void { this.readyState = 1; this.onopen?.(new Event("open")); }
  emit(data: string): void { if (this.readyState !== 2) this.onmessage?.({ data } as MessageEvent<string>); }
  /** CONNECTING (0): the browser retries itself, as after a clean server end. CLOSED (2): it gave up. */
  drop(readyState: 0 | 2): void { this.readyState = readyState; this.onerror?.(new Event("error")); }
  close(): void { this.closes++; this.readyState = 2; }
}

const result = { tick: 9, winner: 0, reason: "overrun", decidedBy: "overrun", nextStartMs: null };
const messages: Record<string, StreamMessage> = {
  full: { tick: 0, full: { result: null }, events: [], ants: [] } as unknown as StreamMessage,
  delta: { tick: 1, full: null, events: [], ants: [] } as unknown as StreamMessage,
  end: { tick: 9, full: null, events: [{ kind: "end", result }], ants: [] } as unknown as StreamMessage,
  finished: { tick: 9, full: { result }, events: [], ants: [] } as unknown as StreamMessage,
};

function harness(decodeMs = 0) {
  const sources: Source[] = [];
  const delivered: StreamMessage[] = [];
  const states: LinkState[] = [];
  let resets = 0;
  const link = openLive("/watch/live/lobby", m => { delivered.push(m); }, s => { states.push(s); }, {
    source: () => { const s = new Source(); sources.push(s); return s; },
    decode: async data => { if (decodeMs) await new Promise(resolve => setTimeout(resolve, decodeMs)); return messages[data]!; },
    onReset: () => { resets++; },
  });
  return { link, sources, delivered, states, resets: () => resets };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("live link after a match's result", () => {
  it.each([
    ["the final delta", ["full", "delta", "end"]],
    ["a late attachment's finished snapshot", ["finished"]],
  ])("closes after %s and does not reconnect when the server ends the stream", async (_, sent) => {
    const h = harness();
    h.sources[0]!.open();
    for (const data of sent) h.sources[0]!.emit(data);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toEqual(sent.map(data => messages[data]));
    expect(h.sources[0]!.closes).toBe(1);
    // The server's clean end and a later refusal: neither reopens, nor does the browser's own retry.
    h.sources[0]!.drop(0);
    h.sources[0]!.drop(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sources).toHaveLength(1);
    // The page keeps its open link and its playback: no reconnecting state, no reset of delivered work.
    expect(h.states).toEqual(["connecting", "open"]);
    expect(h.resets()).toBe(1); // Only the initial connect.
    h.link.close();
  });

  it("keeps the page's link open when the server's end arrives before the result has finished decoding", async () => {
    const h = harness(50);
    h.sources[0]!.open();
    h.sources[0]!.emit("full");
    h.sources[0]!.emit("end");
    h.sources[0]!.drop(2); // The end reached the transport while the result was still decoding.
    expect(h.states.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.delivered).toEqual([messages.full, messages.end]);
    expect(h.states.at(-1)).toBe("open");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sources).toHaveLength(1);
    expect(h.resets()).toBe(1);
    h.link.close();
  });

  it.each(["end", "finished"])("keeps an accepted %s through raw overflow and a queued server-close callback", async terminal => {
    const sources: Source[] = [], delivered: StreamMessage[] = [];
    let resets = 0, overflows = 0;
    const link = openLive("/watch/live/lobby", m => delivered.push(m), () => {}, {
      maxPending: 2,
      source: () => { const s = new Source(); sources.push(s); return s; },
      decode: async data => { await new Promise(r => setTimeout(r, 50)); return messages[data]!; },
      onReset: () => { resets++; }, onOverflow: () => { overflows++; },
    });
    try {
      sources[0]!.emit("full"); sources[0]!.emit(terminal); sources[0]!.emit("delta");
      sources[0]!.drop(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(delivered).toEqual([messages.full, messages[terminal]]);
      expect(sources).toHaveLength(1);
      expect(resets).toBe(1);
      expect(overflows).toBe(0);
    } finally { link.close(); }
  });

  it("explicit close cancels accepted work even while overflow is draining", async () => {
    const sources: Source[] = [], delivered: StreamMessage[] = [];
    const overflow = vi.fn();
    const link = openLive("/watch/live/lobby", m => delivered.push(m), () => {}, {
      maxPending: 1,
      source: () => { const s = new Source(); sources.push(s); return s; },
      decode: async data => { await new Promise(r => setTimeout(r, 50)); return messages[data]!; },
      onOverflow: overflow,
    });
    sources[0]!.emit("full"); sources[0]!.emit("delta");
    await vi.advanceTimersByTimeAsync(1);
    link.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toEqual([]);
    expect(overflow).not.toHaveBeenCalled();
  });

  it("still reconnects a stream dropped before the result", async () => {
    const h = harness();
    h.sources[0]!.open();
    h.sources[0]!.emit("full");
    h.sources[0]!.emit("delta");
    await vi.advanceTimersByTimeAsync(0);
    h.sources[0]!.drop(2);
    expect(h.states.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.open();
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "connecting", "open"]);
    expect(h.sources[0]!.closes).toBe(1); // Abandoned by the reconnect, not by a result.
    h.link.close();
  });

  it("reopens on request after the result, for a fresh snapshot", async () => {
    const h = harness();
    h.sources[0]!.open();
    h.sources[0]!.emit("finished");
    await vi.advanceTimersByTimeAsync(0);
    h.link.reopen();
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.open();
    h.sources[1]!.emit("full");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toEqual([messages.finished, messages.full]);
    h.sources[1]!.drop(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.sources).toHaveLength(3);
    h.link.close();
  });
});

// stream.ts and source.ts are unchanged from the frozen decoder's build. Substitute
// only that old decode boundary; the actual stream, lobby waiting and playback run.
const oldData = async (data: string): Promise<StreamMessage> => oldDecode(inflateRawSync(Buffer.from(data, "base64")));
const wire = (message: StreamMessage) => deflateRawSync(encodePublicMessage(message)).toString("base64");
const start = decodeMessage(scale2Packets(1)[0]!);
const queenResult: StreamResult = { winner: 1, reason: "time_up", decidedBy: "queen_kills", tick: 9, nextStartMs: null };
const queenEnd: StreamMessage = { tick: 10, ants: start.ants, full: null, events: [{ kind: "end", result: queenResult }] };
const queenSnapshot: StreamMessage = { ...queenEnd, full: { ...start.full!, result: queenResult }, events: [] };

function expectEndCard(delivered: StreamMessage[]) {
  const playback = new Playback({ live: true }), frame = new Frame();
  for (const m of delivered) playback.push(m, m.tick * 100);
  // Start the live playout clock, then advance frames through its terminal beat.
  for (let now = 0; now < 10_000; now += 100) playback.sample(now, frame);
  expect(playback.sample(10_000, frame)).toBe(true);
  const result = frame.board!.result!;
  expect(result).toEqual({ ...queenResult, decidedBy: "kills" });
  // These are the HUD's end-card visibility condition and text helpers.
  expect(frame.targetMs).toBeGreaterThanOrEqual(resultShownAt(result, frame.endShown ?? undefined));
  expect(resultHeadline(result)).toContain("wins");
  expect(resultHow(result, true)).toBe("Time-up · decided on kills");
}

it.each(["final delta", "finished snapshot"])("keeps the end card on an old page receiving a queen-kill %s", async kind => {
  const es = new Source(), delivered: StreamMessage[] = [];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const link = openLive("/watch/live/compatibility", m => delivered.push(m), () => {}, { source: () => es, decode: oldData });
  if (kind === "final delta") es.emit(wire(start));
  es.emit(wire(kind === "final delta" ? queenEnd : queenSnapshot));
  await vi.advanceTimersByTimeAsync(0);
  expectEndCard(delivered);
  expect(es.closes).toBe(1);
  expect(errors).not.toHaveBeenCalled();
  link.close();
});

it("an old page waiting for a lobby receives its later queen-kill end card without reloading", async () => {
  const line = { textContent: "" }, reload = vi.fn(), errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const doc = { title: "", querySelector: () => line, getElementById: () => null,
    defaultView: { addEventListener: () => {}, location: { hash: "", origin: "https://example.test", reload },
      sessionStorage: { getItem: () => null, removeItem: () => {} } } } as unknown as Document;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ lobbyId: "waiting", delaySeconds: 60, playbackFinished: false })));
  const es = new Source(), reject = vi.fn();
  let preparation = new TickPreparation();
  const opening = openSource(new URLSearchParams({ lobby: "waiting" }), { now: () => 0 }, doc, reject, {
    source: () => es,
    intake: {
      async decode(data) {
        const m = await oldData(data);
        return { kind: "tick", generation: 0, id: 0, m, prepared: preparation.prepare(m), workerMs: 0, deliveryMs: 0 };
      },
      reset() { preparation = new TickPreparation(); }, close() {},
    },
  });
  await vi.advanceTimersByTimeAsync(CONNECT_MS + 1);
  expect(line.textContent).toBe("Live match starting");
  es.emit(wire(start));
  await vi.advanceTimersByTimeAsync(0);
  const source = await opening;
  expect(source).not.toBeNull();
  const delivered = source!.take(0).map(a => a.m);
  es.emit(wire(queenEnd));
  await vi.advanceTimersByTimeAsync(0);
  delivered.push(...source!.take(1000).map(a => a.m));
  expectEndCard(delivered);
  expect(es.closes).toBe(1);
  expect(reload).not.toHaveBeenCalled();
  expect(reject).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  source!.close();
});
