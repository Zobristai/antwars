import { deepStrictEqual } from "node:assert";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RESULT_BEAT_MS, resultShownAt } from "../../web/src/buffer.ts";
import { linkLine } from "../../web/src/compose.ts";
import { openFeed } from "../../web/src/feed.ts";
import { INBOX_CAP } from "../../web/src/inbox.ts";
import { LIVE_BUFFER_MS } from "../../web/src/playout.ts";
import type { EventSourceLike, LinkState } from "../../web/src/stream.ts";
import { Waiting } from "../../web/src/waiting.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const specimen = decodeMessage(scale2Packets(1)[0]!);
function message(tick: number, full = false, match = 42): StreamMessage {
  const m = structuredClone(specimen);
  m.tick = tick;
  m.events = [];
  if (full) { m.full!.match = match; m.full!.result = null; }
  else m.full = null;
  return m;
}
class Source implements EventSourceLike {
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  readyState = 1;
  emit(m: StreamMessage): void {
    if (this.readyState !== 2) this.onmessage?.({ data: deflateRawSync(encodeMessage(m)).toString("base64") } as MessageEvent<string>);
  }
  close(): void { this.readyState = 2; }
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("stream delivery timed out");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function client() {
  const sources: Source[] = [], states: LinkState[] = [];
  let now = 0;
  const feed = openFeed("/live/current", () => now, state => states.push(state), {
    source: () => { const s = new Source(); sources.push(s); return s; },
  });
  const playback = new Playback({ live: true }), frame = new Frame();
  const panel = { hidden: false }, waiting = new Waiting(panel);
  const draw = (at: number) => {
    now = at;
    for (const arrival of feed.take()) playback.push(arrival.m, arrival.at);
    const drew = playback.sample(now, frame);
    waiting.frame(drew);
    return drew;
  };
  const deliver = async (m: StreamMessage, at: number) => {
    now = at;
    const count = feed.inbox.size;
    sources.at(-1)!.emit(m);
    await until(() => feed.inbox.size > count || sources.at(-1)!.readyState === 2);
  };
  const start = async () => {
    sources[0]!.onopen?.(new Event("open"));
    await deliver(message(0, true), 0);
    await feed.first;
    expect(draw(0)).toBe(false);
    for (let tick = 1; tick <= 20; tick++) {
      await deliver(message(tick), tick * TICK_MS);
      draw(tick * TICK_MS);
    }
    expect(panel.hidden).toBe(true);
    expect(frame.board).not.toBeNull();
  };
  const overflow = async () => {
    // No draw/take: the same frame gap whether a tab is hidden, a window is covered, or frames stall.
    for (let tick = 21; sources.at(-1)!.readyState !== 2; tick++) await deliver(message(tick), tick * TICK_MS);
    expect(feed.inbox.size).toBe(0);
    expect(feed.inbox.dropped).toBe(INBOX_CAP + 1);
    expect(sources).toHaveLength(1);
  };
  return { sources, states, feed, playback, frame, panel, draw, deliver, start, overflow };
}

describe("live board across a no-frame inbox overflow", () => {
  it("keeps drawing through reconnect and the entire same-match refill, then resumes at the delayed live snapshot", async () => {
    const c = client();
    try {
      await c.start();
      await c.overflow();
      expect(c.draw(10_000)).toBe(true); // Retained board while the new connection has no full yet.
      expect(c.panel.hidden).toBe(true);
      const held = structuredClone(c.frame);
      c.sources[1]!.onopen?.(new Event("open"));
      await c.deliver(message(100, true), 10_000);
      const refill: { drew: boolean; hidden: boolean; frame: Frame }[] = [];
      for (let offset = 0; offset < LIVE_BUFFER_MS; offset += TICK_MS) {
        if (offset > 0) await c.deliver(message(100 + offset / TICK_MS), 10_000 + offset);
        const drew = c.draw(10_000 + offset);
        refill.push({ drew, hidden: c.panel.hidden, frame: structuredClone(c.frame) });
      }
      await c.deliver(message(115), 11_500);
      expect(c.draw(11_500)).toBe(true);
      expect(refill.map(sample => sample.drew), "board throughout 0–1400 ms refill").toEqual(Array(15).fill(true));
      expect(refill.map(sample => sample.hidden)).toEqual(Array(15).fill(true));
      for (const sample of refill) deepStrictEqual(sample.frame, held);
      expect(c.frame.renderMs).toBe(100 * TICK_MS);
      expect(c.frame.tick).toBe(100);
      expect(c.playback.matches).toBe(1);
      expect(c.panel.hidden).toBe(true);
      c.draw(11_533);
      expect(c.frame.renderMs).toBeGreaterThan(100 * TICK_MS);
      expect(c.frame.renderMs).toBeLessThan(100 * TICK_MS + 36);
    } finally { c.feed.link.close(); }
  });

  it("keeps the last running board when the match ended during the gap, then plays the delayed ending", async () => {
    const c = client();
    try {
      await c.start();
      c.states.length = 0;
      await c.overflow();
      expect(c.draw(10_000)).toBe(true);
      const held = structuredClone(c.frame);
      c.sources[1]!.onopen?.(new Event("open"));
      const ended = message(100, true);
      ended.full!.result = { tick: 99, winner: 0, reason: "overrun", decidedBy: "overrun", nextStartMs: null };
      await c.deliver(ended, 10_000);
      const refill: { drew: boolean; hidden: boolean; frame: Frame }[] = [];
      for (let offset = 0; offset < LIVE_BUFFER_MS; offset += TICK_MS) {
        const drew = c.draw(10_000 + offset);
        refill.push({ drew, hidden: c.panel.hidden, frame: structuredClone(c.frame) });
      }
      expect(refill.map(sample => sample.drew), "board throughout terminal snapshot's 0–1400 ms wait").toEqual(Array(15).fill(true));
      expect(refill.map(sample => sample.hidden)).toEqual(Array(15).fill(true));
      for (const sample of refill) {
        deepStrictEqual(sample.frame, held);
        expect(sample.frame.board!.result).toBeNull();
      }
      expect(c.draw(10_000 + LIVE_BUFFER_MS - 1)).toBe(true);
      deepStrictEqual(structuredClone(c.frame), held);
      expect(c.panel.hidden).toBe(true);
      for (const state of c.states) expect(linkLine(state, false)).not.toMatch(/Connecting|Reconnecting/);

      const resumedAt = 10_000 + LIVE_BUFFER_MS;
      expect(c.draw(resumedAt)).toBe(true);
      expect(c.frame.tick).toBe(100);
      expect(c.frame.renderMs).toBe(100 * TICK_MS);
      expect(c.frame.targetMs).toBe(100 * TICK_MS);
      expect(c.frame.board!.result).toEqual(ended.full!.result);
      expect(c.frame.endShown).toBe(100);
      const revealAt = resultShownAt(c.frame.board!.result!, c.frame.endShown!);
      expect(revealAt).toBe(100 * TICK_MS + RESULT_BEAT_MS);
      expect(c.frame.targetMs).toBeLessThan(revealAt);
      expect(c.draw(resumedAt + RESULT_BEAT_MS - 1)).toBe(true);
      expect(c.frame.targetMs).toBeLessThan(revealAt);
      expect(c.draw(resumedAt + RESULT_BEAT_MS)).toBe(true);
      expect(c.frame.targetMs).toBe(revealAt);
      expect(c.panel.hidden).toBe(true);
      expect(c.playback.matches).toBe(1);
    } finally { c.feed.link.close(); }
  });

  it("does not publish Connecting for overflow resync but preserves initial, explicit-reopen and genuine-error wording", async () => {
    const c = client();
    try {
      expect(c.states).toEqual(["connecting"]);
      await c.start();
      c.states.length = 0;
      await c.overflow();
      c.draw(10_000);
      expect(c.states.map(state => linkLine(state, false))).toEqual([]);
      c.sources[1]!.onerror?.(new Event("error"));
      expect(c.states.at(-1)).toBe("reconnecting");
      expect(linkLine(c.states.at(-1)!, false)).toBe("Reconnecting…");
      c.sources[1]!.onopen?.(new Event("open"));
      expect(c.states.at(-1)).toBe("open");
      c.feed.link.reopen();
      expect(c.states.at(-1)).toBe("connecting");
    } finally { c.feed.link.close(); }
  });

  it("still clears the old match and waits when the overflow's full names a new match", async () => {
    const c = client();
    try {
      await c.start(); await c.overflow(); c.draw(10_000);
      await c.deliver(message(100, true, 43), 10_000);
      expect(c.draw(10_000)).toBe(false);
      expect(c.frame.board).toBeNull();
      expect(c.frame.count).toBe(0);
      expect(c.panel.hidden).toBe(false);
      expect(c.playback.matches).toBe(2);
    } finally { c.feed.link.close(); }
  });

  it("keeps one drawing across repeated same-match fulls and alternate output frames, but never across a match change", () => {
    const p = new Playback({ live: true }), first = new Frame(), next = new Frame();
    p.push(message(0, true), 0);
    for (let tick = 1; tick <= 15; tick++) p.push(message(tick), tick * TICK_MS);
    expect(p.sample(1500, first)).toBe(true);
    const held = structuredClone(first);
    p.push(message(100, true), 10_000);
    expect(p.sample(10_000, next)).toBe(true);
    deepStrictEqual(structuredClone(next), held);
    p.push(message(200, true), 11_000);
    expect(p.sample(11_000, next)).toBe(true);
    deepStrictEqual(structuredClone(next), held);
    p.push(message(200, true, 43), 12_000);
    expect(p.sample(12_000, next)).toBe(false);
    expect(next.board).toBeNull();
    // Same-match data before the new match's first draw must not resurrect match 42.
    p.push(message(201, true, 43), 12_100);
    expect(p.sample(12_100, first)).toBe(false);
    expect(first.board).toBeNull();
  });

  it("never borrows an old board before a first live frame, for unknown matches, or from recording playback", () => {
    for (const mode of ["startup", "unknown match", "recording"] as const) {
      const p = new Playback({ live: mode !== "recording" }), f = new Frame();
      const full = message(0, true);
      if (mode === "unknown match") delete full.full!.match;
      p.push(full, 0);
      if (mode !== "startup") {
        for (let tick = 1; tick <= 15; tick++) p.push(message(tick), tick * TICK_MS);
        expect(p.sample(1500, f)).toBe(true);
      }
      const resumed = message(100, true);
      if (mode === "unknown match") delete resumed.full!.match;
      p.push(resumed, 10_000);
      if (mode === "recording") {
        expect(p.sample(10_000, f)).toBe(true);
        expect(f.targetMs).toBe(100 * TICK_MS - 250);
      } else {
        expect(p.sample(10_000, f)).toBe(false);
        expect(f.board).toBeNull();
      }
    }
  });
});
