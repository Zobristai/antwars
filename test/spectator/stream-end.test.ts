/**
 * The slot ends a finished match's stream after its final frames, so the
 * browser link closes once it has the result and does not reconnect to that match.
 * A stream dropped before the result still reconnects as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "../../src/live/format.ts";
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
afterEach(() => { vi.useRealTimers(); });

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
