/**
 * An explicit live lobby link on a page that cannot keep up with the stream.
 *
 * Observed in production (the watch link hung on connecting): a slow 3D page draws a frame every
 * ~520 ms, and the worker's reply to each decode is only handled between frames, so the page takes
 * about one live message per frame while the server sends ten a second. The bounded inbox then
 * overflows after ~4 s and reconnects; before this fix the reconnect's full snapshot restarted the
 * 1.5 s startup buffer every time, so "Connecting…" stayed until the 3D quality fallback.
 *
 * The page's live path runs here as production wires it: openSource on a ?lobby link, the
 * production WorkerIntake around the production IntakeProcessor, the bounded feed, Playback and
 * the waiting panel. Only the browser is modelled: the SSE connection, the server's 10 messages a
 * second on a simulated clock, and when the main thread gets to handle queued worker replies.
 */
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { IntakeProcessor, WorkerIntake, type IntakeReply, type IntakeRequest, type IntakeWorker } from "../../web/src/intake.ts";
import { LIVE_BUFFER_MS } from "../../web/src/playout.ts";
import { openSource } from "../../web/src/source.ts";
import type { EventSourceLike } from "../../web/src/stream.ts";
import { Waiting } from "../../web/src/waiting.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const specimen = decodeMessage(scale2Packets(1)[0]!);
/** The server's message at a tick: a full snapshot opens every connection. */
function message(tick: number, full: boolean): StreamMessage {
  const m = structuredClone(specimen);
  m.tick = specimen.tick + tick;
  m.events = [];
  m.ants = { ...m.ants, x: m.ants.x.map((x) => x + tick) };
  if (full) { m.full!.match = 452; m.full!.result = null; }
  else m.full = null;
  return m;
}

class Source implements EventSourceLike {
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  readyState = 1;
  opened = false;
  emit(m: StreamMessage) { if (this.readyState !== 2) this.onmessage?.({ data: deflateRawSync(encodeMessage(m)).toString("base64") } as MessageEvent<string>); }
  close() { this.readyState = 2; }
}

/** The worker port: the production processor answers at once, but the page handles its replies only when the main thread is free. */
class Port implements IntakeWorker {
  onmessage: IntakeWorker["onmessage"] = null;
  onerror: IntakeWorker["onerror"] = null;
  private readonly processor = new IntakeProcessor();
  private readonly queued: IntakeReply[] = [];
  private working = 0;
  postMessage(request: IntakeRequest) {
    this.working++;
    void this.processor.handle(request).then((reply) => { this.working--; if (reply) this.queued.push(reply); });
  }
  terminate() {}
  /** Let the worker finish what it was sent. */
  async idle() {
    do for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
    while (this.working > 0);
  }
  /** The main thread runs the reply tasks queued so far; replies to requests it posts meanwhile wait for the next gap. */
  deliver(): number {
    const replies = this.queued.splice(0);
    for (const data of replies) this.onmessage?.({ data } as MessageEvent<IntakeReply>);
    return replies.length;
  }
}

afterEach(() => { vi.restoreAllMocks(); });

/**
 * Run the page for durationMs: a frame every frameMs; between frames the browser dispatches the SSE
 * messages the server sent meanwhile and the worker replies queued during the frame (all of them
 * when fast, so a fast page keeps up; a slow page gets through one decode per frame).
 */
async function watch(frameMs: number, durationMs: number, fast: boolean) {
  const listeners = new Map<string, () => void>();
  const doc = { title: "", getElementById: () => null, defaultView: {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  } } as unknown as Document;
  const port = new Port(), sources: Source[] = [], reject = vi.fn();
  let now = 0, sent = -1;
  /** The server: every connection opens with a full snapshot at the live tick, then one message per tick. */
  const serve = () => {
    for (let tick = sent + 1; tick * TICK_MS <= now; tick++) {
      sent = tick;
      const source = sources.at(-1)!;
      source.emit(message(tick, !source.opened));
      source.opened = true;
    }
  };
  const gap = async () => {
    serve();
    await port.idle();
    if (fast) while (port.deliver() > 0) await port.idle();
    else { port.deliver(); await port.idle(); }
  };
  const opening = openSource(new URLSearchParams({ lobby: "slow-page" }), { now: () => now }, doc, reject, {
    intake: new WorkerIntake(() => port),
    source: (path) => { expect(path).toBe("/watch/live/slow-page"); const s = new Source(); sources.push(s); return s; },
  });
  // The explicit lobby link waits for the first full snapshot before the frame loop starts.
  while (sources.length === 0) await port.idle();
  sources[0]!.onopen?.(new Event("open"));
  let input: Awaited<typeof opening> | undefined;
  void opening.then((value) => { input = value; });
  while (input === undefined) await gap();
  const source = input!;
  expect(source.recorded).toBe(false);
  const playback = new Playback({ live: true }), frame = new Frame();
  const panel = { hidden: false }, line = { textContent: "Connecting…" }, waiting = new Waiting(panel, line);
  const firstFullAt = now;
  let firstDraw: { at: number; connections: number; renderMs: number; newestMs: number } | null = null;
  const drawnTicks: number[] = [];
  let hiddenAfterFirstDraw = true;
  try {
    for (now = frameMs; now <= durationMs; now += frameMs) {
      await gap();
      for (const arrival of source.take(now)) {
        if (arrival.kind !== "prepared") throw new Error("live arrival bypassed worker preparation");
        playback.pushPrepared(arrival.prepared, arrival.at);
      }
      const drew = playback.sample(source.now(now), frame);
      waiting.state(source.linkState());
      waiting.frame(drew);
      if (drew && firstDraw === null) {
        firstDraw = { at: now, connections: sources.length, renderMs: frame.renderMs, newestMs: playback.newestTick * TICK_MS };
      }
      if (firstDraw !== null) {
        hiddenAfterFirstDraw &&= panel.hidden;
        drawnTicks.push(frame.tick);
      }
    }
  } finally { listeners.get("pagehide")?.(); source.close(); }
  expect(reject).not.toHaveBeenCalled();
  return { firstFullAt, firstDraw, drawnTicks, hiddenAfterFirstDraw, connections: sources.length, panel };
}

describe("an explicit live lobby link on a page that cannot keep up", () => {
  it("draws the match soon after the first full snapshot, with no reconnect before its first frame, and keeps it drawn", async () => {
    const SLOW_FRAME_MS = 520;
    const run = await watch(SLOW_FRAME_MS, 10_000, false);
    expect(run.firstDraw, `the slow page drew no frame within 10 s, over ${run.connections} connections`).not.toBeNull();
    const first = run.firstDraw!;
    // Leaves Connecting… within the startup wait plus one slow frame of the first full snapshot.
    expect(first.at - run.firstFullAt).toBeLessThanOrEqual(LIVE_BUFFER_MS + SLOW_FRAME_MS);
    expect(first.connections).toBe(1);
    // The page really is behind: it has far less than the normal 1.5 s of ticks when it starts.
    expect(first.newestMs - first.renderMs).toBeLessThan(LIVE_BUFFER_MS);
    // Later catch-up resyncs (the page still cannot keep up) keep the board drawn and moving.
    expect(run.connections).toBeGreaterThan(1);
    expect(run.hiddenAfterFirstDraw).toBe(true);
    expect(run.panel.hidden).toBe(true);
    expect(Math.max(...run.drawnTicks)).toBeGreaterThan(run.drawnTicks[0]!);
  }, 30_000);

  it("a page that keeps up at 10 messages a second still starts at the full 1.5 s tick lead, on one connection", async () => {
    const run = await watch(1000 / 60, 3000, true);
    const first = run.firstDraw!;
    expect(first).not.toBeNull();
    expect(first.at - run.firstFullAt).toBeGreaterThanOrEqual(LIVE_BUFFER_MS);
    expect(first.renderMs).toBe(specimen.tick * TICK_MS);
    expect(first.newestMs - first.renderMs).toBeGreaterThanOrEqual(LIVE_BUFFER_MS);
    expect(run.connections).toBe(1);
    expect(run.hiddenAfterFirstDraw).toBe(true);
  }, 30_000);
});
