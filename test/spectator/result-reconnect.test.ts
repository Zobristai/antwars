import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { DESIGNED_RESULT_DELAY_MS, checkResultReconnect, observeResultReconnect } from "../../web/capture/spectator-result-checks.ts";
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RESULT_BEAT_MS, resultShownAt } from "../../web/src/buffer.ts";
import { LIVE_BUFFER_MS } from "../../web/src/playout.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const specimen = decodeMessage(scale2Packets(1)[0]!);
function full(tick: number, match = 42, ended = false): StreamMessage {
  const message = structuredClone(specimen);
  message.tick = tick;
  message.events = [];
  message.full!.match = match;
  message.full!.result = ended ? { tick, winner: 0, reason: "overrun", decidedBy: "overrun", nextStartMs: null } : null;
  return message;
}
function showEnding(p: Playback, f: Frame): number {
  const first = full(0);
  p.push(first, 0);
  for (let tick = 1; tick <= 30; tick++) {
    p.push({ ...first, full: null, tick, events: tick === 30 ? [{ kind: "end", result: full(30, 42, true).full!.result! }] : [] }, tick * TICK_MS);
    p.sample(tick * TICK_MS, f);
  }
  let now = 30 * TICK_MS;
  while (now < 10_000) {
    p.sample(now, f);
    if (f.board?.result && f.targetMs >= resultShownAt(f.board.result, f.endShown ?? undefined)) return now;
    now += 20;
  }
  throw new Error("Ending never became visible");
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("same ended-match live reconnect", () => {
  it("preserves the original buffer and beat before the first result", () => {
    expect(LIVE_BUFFER_MS).toBe(1500);
    expect(RESULT_BEAT_MS).toBe(2500);
    const p = new Playback({ live: true }), f = new Frame();
    const shown = showEnding(p, f);
    expect(shown).toBeGreaterThanOrEqual(3000 + LIVE_BUFFER_MS + RESULT_BEAT_MS);
    expect(shown).toBeLessThanOrEqual(3000 + LIVE_BUFFER_MS + TICK_MS + RESULT_BEAT_MS + 1000);
  });

  for (const frameMs of [200, 333, 500]) {
    it(`keeps the original ending deadline with ${frameMs} ms rendered frames`, () => {
      const p = new Playback({ live: true }), f = new Frame();
      const first = full(0);
      p.push(first, 0);
      let received = 0, visibleAt: number | null = null, endSeenAt: number | null = null;
      for (let now = 0; now <= 8100; now += frameMs) {
        while (received < 30 && (received + 1) * TICK_MS <= now) {
          received++;
          p.push({ ...first, full: null, tick: received, events: received === 30
            ? [{ kind: "end", result: full(30, 42, true).full!.result! }] : [] }, received * TICK_MS);
        }
        p.sample(now, f);
        if (f.board?.result) {
          endSeenAt ??= now;
          if (f.targetMs >= resultShownAt(f.board.result, f.endShown ?? undefined)) { visibleAt = now; break; }
        }
      }
      expect(visibleAt).not.toBeNull();
      expect(visibleAt!).toBeGreaterThanOrEqual(3000 + LIVE_BUFFER_MS + RESULT_BEAT_MS);
      expect(visibleAt!).toBeLessThanOrEqual(3000 + DESIGNED_RESULT_DELAY_MS + 1000);
      expect(endSeenAt!).toBeLessThan(visibleAt!);
    });
  }

  it("renders the full result on the first sample after every ended-match reopen", () => {
    const p = new Playback({ live: true }), f = new Frame();
    let now = showEnding(p, f);
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      now += 30_000;
      p.push(full(30, 42, true), now);
      expect(p.sample(now, f)).toBe(true);
      expect(f.board?.result?.winner).toBe(0);
      expect(f.targetMs).toBeGreaterThanOrEqual(resultShownAt(f.board!.result!, f.endShown ?? undefined));
      expect(p.underrun(now)).toBe(false);
      expect(p.matches).toBe(1);
      expect(f.match).toBe(1);
    }
  });

  it("names on each frame the match it is of: a reconnect keeps it, another match with the same result moves it", () => {
    const p = new Playback({ live: true }), f = new Frame();
    let now = showEnding(p, f);
    expect(f.match).toBe(1);
    now += 30_000;
    p.push(full(30, 42, true), now);
    p.sample(now, f);
    expect(f.match).toBe(1);
    now += 30_000;
    p.push(full(30, 43, true), now);
    expect(p.sample(now + LIVE_BUFFER_MS, f)).toBe(true);
    expect(f.board?.result?.winner).toBe(0);
    expect(f.match).toBe(2);
  });

  it("does not take a first terminal attachment, another match or live reconnect past its beat", () => {
    const p = new Playback({ live: true }), f = new Frame();
    p.push(full(30, 42, true), 0);
    expect(p.sample(0, f)).toBe(false);
    expect(f.board).toBeNull();
    expect(p.sample(LIVE_BUFFER_MS, f)).toBe(true);
    expect(f.targetMs).toBeLessThan(resultShownAt(f.board!.result!));
    p.push(full(30, 43, true), 2000);
    expect(p.sample(2000, f)).toBe(false);
    expect(f.board).toBeNull();
    p.push(full(40, 43, false), 3000);
    expect(p.sample(3000, f)).toBe(false);
    expect(f.board).toBeNull();
  });

  it("does not bypass the ending when the reconnect is the first evidence of the result", () => {
    const p = new Playback({ live: true }), f = new Frame();
    p.push(full(0), 0);
    p.push(full(30, 42, true), 3000);
    expect(p.sample(3000, f)).toBe(false);
    expect(p.sample(4500, f)).toBe(true);
    expect(f.targetMs).toBeLessThan(resultShownAt(f.board!.result!));
  });

  it("keeps recorded terminal snapshots on their deterministic clock", () => {
    const p = new Playback(), f = new Frame();
    p.push(full(30, 42, true), 0);
    p.sample(4000, f);
    p.push(full(30, 42, true), 5000);
    expect(p.sample(5000, f)).toBe(true);
    expect(f.targetMs).toBe(30 * TICK_MS - 250);
    expect(f.targetMs).toBeLessThan(resultShownAt(f.board!.result!));
  });
});

describe("reconnect capture observer", () => {
  async function probe() {
    class Source extends EventTarget {
      readyState = 1;
      close() { this.readyState = 2; }
    }
    const animations: Animation[] = [];
    const ancestor = { offsetLeft: 0, offsetTop: 0, offsetWidth: 500, offsetHeight: 600, scrollLeft: 0, scrollTop: 0, offsetParent: null };
    const panel = { hidden: false, offsetLeft: 1, offsetTop: 2, offsetWidth: 300, offsetHeight: 200, scrollLeft: 0, scrollTop: 0,
      offsetParent: ancestor, getAnimations: () => animations, getBoundingClientRect: () => ({ x: 1, y: 2, width: 300, height: 200 }) };
    // The board's area, as window.__antwar.boardArea() reports it.
    const area = { x0: 3, y0: 4, x1: 503, y1: 54 };
    const elements = new Map([['.d1-result', panel], ['.d1-ratings', panel]]);
    let mutation!: () => void, frame!: () => void;
    vi.stubGlobal('window', { EventSource: Source, __antwar: { boardArea: () => ({ ...area }) } });
    vi.stubGlobal('location', { href: 'http://localhost/' });
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('document', { querySelector: (selector: string) => elements.get(selector), addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', transform: 'none' }));
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frame = callback; });
    vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { mutation = callback; } observe() {} });
    await observeResultReconnect({ addInitScript: async (callback: () => void) => callback() } as unknown as Page);
    const source = new window.EventSource('/watch/live/test');
    return { panel, ancestor, area, elements, animations, source, mutate: () => mutation(), frame: () => frame(),
      animationStart: (animationName = 'aw-reveal') => listeners.get('animationstart')?.({ target: panel, animationName }), observer: window.__spectatorReconnect };
  }

  function reveal() {
    return { animationName: 'aw-reveal', playState: 'running', currentTime: 150, playbackRate: 1, pending: false,
      effect: { getTiming: () => ({ duration: 520 }) } };
  }

  it("observes layout continuously through only the initial reveal, then fixes screen geometry", async () => {
    const { panel, animations, frame, observer } = await probe();
    const animation = reveal(); animations.push(animation as unknown as Animation);
    observer.start();
    panel.getBoundingClientRect = () => ({ x: 2, y: 8, width: 298, height: 199 });
    animation.currentTime = 300; frame(); // Designed transform, not intrinsic movement.
    animation.playState = 'finished'; animation.currentTime = 520; animations.length = 0;
    panel.getBoundingClientRect = () => ({ x: 1, y: 2, width: 300, height: 200 });
    frame(); frame();
    expect(observer.finish().violations).toEqual([]);
  });

  for (const change of ['card', 'ancestor', 'hidden', 'stage', 'missing'] as const) {
    it(`does not hide ${change} movement/disappearance behind the initial animation`, async () => {
      const { panel, ancestor, area, elements, animations, frame, observer } = await probe();
      const animation = reveal(); animations.push(animation as unknown as Animation);
      observer.start();
      if (change === 'card') panel.offsetTop++;
      if (change === 'ancestor') ancestor.offsetTop++;
      if (change === 'hidden') panel.hidden = true;
      if (change === 'stage') { area.y0 += 2; area.y1 += 2; }
      if (change === 'missing') elements.delete('.d1-result');
      frame();
      animation.playState = 'finished'; animation.currentTime = 520; animations.length = 0;
      const result = observer.finish();
      expect(result.violations.some(value => !value.includes('never settled'))).toBe(true);
    });
  }

  it("never resets the settled baseline when a later animation or reconnect moves the card", async () => {
    const { panel, animations, frame, source, animationStart, observer } = await probe();
    const animation = reveal(); animations.push(animation as unknown as Animation);
    observer.start(); animation.playState = 'finished'; animation.currentTime = 520; animations.length = 0; frame();
    source.dispatchEvent(new MessageEvent('message', { data: 'full-result' }));
    animationStart();
    panel.getBoundingClientRect = () => ({ x: 1, y: 4, width: 300, height: 200 });
    frame();
    const result = observer.finish();
    expect(result.violations.some(value => value.includes('animation restarted'))).toBe(true);
    expect(result.violations.some(value => value.startsWith('.d1-result moved'))).toBe(true);
  });

  it("fails a stuck, interrupted, reversed or unknown reveal rather than waiting blindly", async () => {
    for (const fault of ['stuck', 'interrupted', 'reversed', 'unknown']) {
      const { animations, frame, observer } = await probe();
      const animation = reveal(); animations.push(animation as unknown as Animation);
      if (fault === 'unknown') animation.animationName = 'different';
      observer.start();
      if (fault === 'interrupted') animation.playState = 'paused';
      if (fault === 'reversed') animation.currentTime = 0;
      frame();
      expect(observer.finish().violations.length).toBeGreaterThan(0);
    }
  });

  it("uses the unchanged buffer plus next tick and beat for both engines' timing deadline", () => {
    expect(DESIGNED_RESULT_DELAY_MS).toBe(4100);
  });

  it("records actual stream events and a stable card while exercising the closed-stream error path", async () => {
    const { source, frame, observer } = await probe();
    expect(observer.start().connection).toBe(1);
    source.dispatchEvent(new MessageEvent('message', { data: 'full-result' }));
    expect(observer.receipts[0]).toMatchObject({ connection: 1, path: '/watch/live/test', characters: 11 });
    let closed = false;
    source.addEventListener('error', () => { closed = source.readyState === 2; });
    observer.interrupt();
    expect(closed).toBe(true);
    frame();
    const result = observer.finish();
    expect(result.samples).toBeGreaterThan(1);
    expect(result.violations).toEqual([]);
  });

  it("takes the baseline before the interruption while retaining receipt and stability checks", async () => {
    const { observer } = await probe();
    const order: string[] = [];
    const writes: Parameters<typeof checkResultReconnect>[3][number][] = [];
    const start = observer.start.bind(observer), interrupt = observer.interrupt.bind(observer);
    observer.start = () => { order.push("baseline"); return start(); };
    observer.interrupt = () => {
      order.push("interrupt"); interrupt();
      writes.push({ lobbyId: "test", origin: "http://localhost", requestId: 2, writtenAt: Date.now(), clockAt: 123, tick: 30, full: true });
      new window.EventSource("/watch/live/test").dispatchEvent(new MessageEvent("message", { data: "full-result" }));
    };
    const page = {
      evaluate: async (callback: (value: unknown) => unknown, arg: unknown) => callback(arg),
      waitForTimeout: async (ms: number) => { expect(ms).toBe(5100); order.push("observe"); },
    } as unknown as Page;
    const checks: Parameters<typeof checkResultReconnect>[2] = [];
    await checkResultReconnect(page, "connection-recovery", checks, writes, { lobbyId: "test", origin: "http://localhost" });
    expect(order).toEqual(["baseline", "interrupt", "observe"]);
    expect(checks[0]).toMatchObject({ kind: "connection-recovery", receivedCharacters: 11, violationCount: 0, violations: [] });
    expect(checks[0]!.ownerFullResultWrittenAt).toBeDefined();
    expect(checks[0]!.fullResultReceivedAt).toBeDefined();
  });

  it("counts every failure and retains its first and last evidence beyond the sample cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T01:00:00.000Z"));
    const { panel, frame, observer } = await probe();
    observer.start();
    panel.offsetTop++;
    for (let i = 0; i < 32; i++) { vi.advanceTimersByTime(10); frame(); }
    const result = observer.finish(); // The final observation is also counted.
    expect(result.violationCount).toBe(33);
    expect(result.violations).toHaveLength(20);
    expect(result.firstViolation).toBe("Result layout moved at 2026-10-21T01:00:00.010Z");
    expect(result.lastViolation).toBe("Result layout moved at 2026-10-21T01:00:00.320Z");
    expect(result.violations.at(-1)).not.toBe(result.lastViolation);
    observer.start(); // A separate observation gets its own statistics.
    expect(observer.finish()).toMatchObject({ violationCount: 0, violations: [], firstViolation: undefined, lastViolation: undefined });
  });

  it("keeps its original baseline when an interrupted connection changes layout", async () => {
    const { panel, source, frame, observer } = await probe();
    observer.start(); observer.interrupt();
    source.dispatchEvent(new MessageEvent("message", { data: "reconnected-result" }));
    panel.offsetTop++;
    frame(); frame();
    expect(observer.finish().violationCount).toBe(3);
  });

  it("catches hiding and geometry movement even before another animation frame", async () => {
    const { panel, area, mutate, observer } = await probe();
    observer.start();
    panel.hidden = true;
    mutate();
    panel.hidden = false;
    area.y0 += 1; area.y1 += 1;
    mutate();
    const result = observer.finish();
    expect(result.violations.some(value => value.startsWith('Result hidden'))).toBe(true);
    expect(result.violations.some(value => value.startsWith('board area moved'))).toBe(true);
  });
});
