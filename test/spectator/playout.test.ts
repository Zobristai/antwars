import { describe, expect, it } from "vitest";
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { LIVE_BUFFER_MS, LIVE_RATE_LIMIT, Playout } from "../../web/src/playout.ts";
import { gpuReadback } from "../../web/src/timing.ts";
import { Waiting } from "../../web/src/waiting.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const first = decodeMessage(scale2Packets(1)[0]!);
const startMs = first.tick * 100;
function message(i: number): StreamMessage {
  return { ...first, tick: first.tick + i, full: i === 0 ? structuredClone(first.full) : null, events: [],
    ants: { ...first.ants, x: first.ants.x.map((x) => x + i) } };
}

function run(fps: number, openingTicks: number, pause: number) {
  const p = new Playout(); p.reset(startMs, 0);
  const arrivals: number[] = [];
  for (let tick = 0; tick <= 200; tick++) {
    const at = tick < openingTicks ? tick * 100 : Math.max(tick * 100, (openingTicks - 1) * 100 + pause);
    const jitter = tick === 50 ? 133 : tick === 90 ? 50 : 0;
    arrivals.push(Math.max(arrivals.at(-1) ?? 0, at + jitter));
  }
  let received = 0;
  const drawn: { at: number; target: number; rate: number; newest: number }[] = [];
  for (let k = 0; k < fps * 18; k++) {
    const now = Math.round(k * 1000 / fps);
    while (received + 1 < arrivals.length && arrivals[received + 1]! <= now) received++;
    const target = p.at(now, startMs + received * 100, false);
    if (target !== null) drawn.push({ at: now, target, rate: p.rate, newest: startMs + received * 100 });
  }
  return drawn;
}

describe("live buffered playout", () => {
  for (const fps of [30, 60]) for (const ticks of [2, 5]) for (const pause of [978, 1191]) {
    it(`${fps} fps, ${ticks} opening ticks and ${pause} ms pause: no freeze or whole-tick catch-up after startup`, () => {
      const drawn = run(fps, ticks, pause);
      expect(drawn[0]!.at).toBeGreaterThanOrEqual(LIVE_BUFFER_MS);
      expect(drawn[0]!.target).toBe(startMs);
      for (let i = 1; i < drawn.length; i++) {
        const prev = drawn[i - 1]!, f = drawn[i]!;
        const dt = f.at - prev.at;
        expect(f.target).toBeLessThanOrEqual(f.newest);
        expect(f.target - prev.target).toBeGreaterThanOrEqual(dt * (1 - LIVE_RATE_LIMIT) - 1e-8);
        expect(f.target - prev.target).toBeLessThanOrEqual(dt * (1 + LIVE_RATE_LIMIT) + 1e-8);
        expect(Math.abs(f.rate - prev.rate)).toBeLessThan(0.02);
      }
    });
  }

  it("adjusts speed for sustained arrival drift instead of an arrival-offset jump", () => {
    const p = new Playout(); p.reset(0, 0);
    let newest = 1500;
    p.at(1500, newest, false);
    let prev = 0;
    for (let now = 1530; now < 60_000; now += 30) {
      newest = 1500 + Math.floor((now - 1500) * 0.97 / 100) * 100;
      const target = p.at(now, newest, false)!;
      expect(target - prev).toBeGreaterThan(27);
      expect(target - prev).toBeLessThan(33);
      prev = target;
    }
    expect(p.rate).toBeLessThan(0.985);
    expect(p.rate).toBeGreaterThan(0.955);
  });

  it("is idempotent, does not run backward or predict, and consumes a clock gap without extrapolating", () => {
    const p = new Playout(); p.reset(0, 0);
    expect(p.at(1499, 1400, false)).toBeNull();
    expect(p.at(1500, 1500, false)).toBe(0);
    expect(p.at(1533, 1500, false)).toBe(p.at(1533, 1500, false));
    const before = p.at(1533, 1500, false)!;
    const after = p.at(1_000_000, 2000, false)!;
    expect(after).toBe(2000);
    expect(after).toBeGreaterThan(before);
    expect(p.at(1533, 2000, false)).toBe(after);
    // A stalled stream may eventually hold, but a late tick never teleports the cursor.
    for (let now = 1_000_033; now < 1_004_000; now += 33) p.at(now, 2000, false);
    const held = p.at(1_004_000, 2000, false)!;
    expect(held).toBe(2000);
    expect(p.at(1_004_033, 4000, false)! - held).toBeLessThan(36);
  });

  for (const frameMs of [200, 333, 500]) {
    it(`keeps elapsed time at ${frameMs} ms per frame instead of losing the excess over 100 ms`, () => {
      const p = new Playout(); p.reset(0, 0);
      expect(p.at(1500, 1500, false)).toBe(0);
      let previous = 0;
      for (let now = 1500 + frameMs; now <= 6000; now += frameMs) {
        const target = p.at(now, now, false)!;
        expect(target - previous).toBeGreaterThanOrEqual(frameMs * (1 - LIVE_RATE_LIMIT));
        expect(target - previous).toBeLessThanOrEqual(frameMs * (1 + LIVE_RATE_LIMIT));
        expect(target).toBeLessThanOrEqual(now);
        previous = target;
      }
    });
  }

  it("a terminal snapshot with less than a buffer starts after the wait, then its ending clock continues", () => {
    const p = new Playout(); p.reset(2000, 10);
    expect(p.at(1509, 2000, true)).toBeNull();
    expect(p.at(1510, 2000, true)).toBe(2000);
    expect(p.at(1543, 2000, true)).toBe(2033);
    p.reset(0, 2000);
    expect(p.at(2000, 0, false)).toBeNull();
  });

  it("a running stream the page cannot fill starts after the same wait, then never extrapolates", () => {
    const p = new Playout(); p.reset(2000, 10);
    expect(p.at(1509, 2200, false)).toBeNull();
    expect(p.at(1510, 2200, false)).toBe(2000);
    expect(p.at(2010, 2200, false)).toBe(2200);
    expect(p.at(5000, 2300, false)).toBe(2300);
    // A running stream with nothing newer than its snapshot does not start on elapsed time alone.
    p.reset(2000, 10);
    expect(p.at(100_000, 2000, false)).toBeNull();
    expect(p.at(100_001, 2100, false)).toBe(2000);
  });
});

describe("Playback's opt-in live wiring", () => {
  it("keeps the waiting state until enough tick history exists, then smoothly samples actual ants", () => {
    const p = new Playback({ live: true }), f = new Frame();
    const panel = { hidden: false }, waiting = new Waiting(panel);
    p.push(message(0), 0);
    waiting.frame(p.sample(0, f));
    expect(panel.hidden).toBe(false);
    expect(f.board).toBeNull();
    for (let tick = 1; tick <= 15; tick++) p.push(message(tick), tick * 100);
    waiting.frame(p.sample(1500, f));
    expect(panel.hidden).toBe(true);
    expect(f.renderMs).toBe(startMs);
    expect(f.tick).toBe(first.tick);
    expect(f.x[0]).toBeCloseTo(first.ants.x[0]! / 256, 5);
    p.sample(1533, f);
    expect(f.renderMs).toBeGreaterThan(startMs + 30);
    expect(f.renderMs).toBeLessThan(startMs + 36);
    // A full reconnect clears old overlays and buffers again; it cannot show an old match while waiting.
    p.push({ ...message(0), tick: first.tick + 100 }, 2000);
    waiting.frame(p.sample(2000, f));
    expect(panel.hidden).toBe(false);
    expect(f.board).toBeNull();
    expect(f.count).toBe(0);
  });

  it("does not alter recording sample times or the default constructor's contract", () => {
    const p = new Playback(), f = new Frame();
    p.push(message(0), 0); p.push(message(1), 100);
    expect(p.sample(RENDER_DELAY_MS + 50, f)).toBe(true);
    expect(f.renderMs).toBe(startMs + 50);
  });
});

describe("GPU finish readback is opt-in outside normal capture", () => {
  it("normal pages and JS-only measurements do not synchronize the GPU", () => {
    expect(gpuReadback(new URLSearchParams())).toBe(false);
    expect(gpuReadback(new URLSearchParams("capture&gpuTiming=0"))).toBe(false);
    expect(gpuReadback(new URLSearchParams("capture"))).toBe(true);
    expect(gpuReadback(new URLSearchParams("gpuTiming=1"))).toBe(true);
  });
});
