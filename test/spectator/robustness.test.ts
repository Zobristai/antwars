/**
 * The spectator page is never blank,
 * catch-up after a background tab costs bounded memory and time, and a full
 * snapshot from a different match always starts a fresh story.
 *
 * The stream is a recorded scripted match (src/live/record.ts) that runs into
 * combat, so the story has entries (first contact, lead changes) to carry or
 * drop. Each message's arrival is its tick in client time.
 */
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { playScripted, recordLog, type ScriptOptions } from "../../src/live/record.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { INBOX_CAP, Inbox } from "../../web/src/inbox.ts";
import { decodeData, type EventSourceLike } from "../../web/src/stream.ts";
import { openFeed } from "../../web/src/feed.ts";
import { playable } from "../playable.ts";

vi.setConfig({ testTimeout: 120_000 });

const TICKS = 900;
const SCRIPT: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 10, ticks: TICKS, attack: true };
const messages = recordLog(playScripted(SCRIPT).lines, TICKS).map(decodeMessage);
const byTick = new Map(messages.map((m) => [m.tick, m]));
const at = (tick: number): StreamMessage => byTick.get(tick)!;

/** The full snapshot a (re)connecting spectator receives at a tick, naming the given match. */
function fullAt(tick: number, match: number): StreamMessage {
  const first = messages[0]!;
  const s = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
  for (const m of messages) if (m.tick > first.tick && m.tick <= tick) s.apply(m);
  const m = s.message();
  return { ...m, full: { ...structuredClone(m.full!), match } };
}

describe("never blank: a waiting state until the first frames draw", () => {
  const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

  it("the page carries only the wordmark and Connecting… from load", () => {
    const open = /<div\b[^>]*\bid="aw-waiting"[^>]*>/.exec(html);
    expect(open, "web/index.html has no waiting panel").not.toBeNull();
    expect(open![0]).not.toMatch(/\shidden\b/);
    const body = html.slice(open!.index, html.indexOf("</div>", html.indexOf("</p>", open!.index)));
    // The wordmark links home (the landing at /, no query): when no match or recording can be shown, the panel is the
    // whole page, and this is its way back.
    expect(body).toContain('class="aw-wordmark"><a class="aw-home" href="/" aria-label="Antwars home">Antwars</a></p>');
    expect(body).toContain("Connecting…");
    expect(body).not.toMatch(/MCP|CLI|60 s behind|next match/i);
  });

  it("the panel stays until the first frame draws, then hides", async () => {
    const { Waiting } = await import("../../web/src/waiting.ts");
    const el = { hidden: false };
    const waiting = new Waiting(el);
    waiting.frame(false);
    expect(el.hidden).toBe(false);
    waiting.frame(true);
    expect(el.hidden).toBe(true);
    // A missing element (a page without the panel) is not an error.
    new Waiting(null).frame(true);
  });

  it("the panel's state line names the stream's state in the set words, from Connecting in the page itself", async () => {
    const { Waiting, WAITING_COPY } = await import("../../web/src/waiting.ts");
    expect(WAITING_COPY).toEqual({ connecting: "Connecting…", open: "Connecting…", reconnecting: "Connecting…" });
    expect(html).toMatch(/class="aw-wait-state">Connecting…</);
    const line = { textContent: "Connecting…" };
    const waiting = new Waiting({ hidden: false }, line);
    waiting.state("open");
    expect(line.textContent).toBe("Connecting…");
    waiting.state("reconnecting");
    expect(line.textContent).toBe("Connecting…");
    // A page without the line is not an error.
    new Waiting({ hidden: false }).state("open");
  });
});

describe("bounded catch-up after a background tab", () => {
  const VISIBLE = 100;

  /** Play VISIBLE ticks with frames running, then queue a burst of B ticks with none (a hidden tab), then draw once. */
  function burst(B: number) {
    const inbox = new Inbox();
    const pb = new Playback();
    let pushes = 0;
    const drain = () => {
      for (const { m, at: t } of inbox.drain()) {
        pb.push(m, t);
        pushes++;
      }
    };
    inbox.push(fullAt(0, 1), 0);
    for (let t = 1; t <= VISIBLE; t++) {
      inbox.push(at(t), t * TICK_MS);
      drain();
    }
    pushes = 0;
    let maxQueued = 0;
    for (let t = VISIBLE + 1; t <= VISIBLE + B; t++) {
      inbox.push(at(t), t * TICK_MS);
      maxQueued = Math.max(maxQueued, inbox.size);
    }
    drain();
    return { inbox, pb, pushes, maxQueued };
  }

  it("queues and plays the same bounded amount however long the tab was hidden", () => {
    const short = burst(100);
    const long = burst(700);
    // Memory while hidden: the queue stops growing.
    expect(long.maxQueued).toBe(short.maxQueued);
    // Work on return: messages handed to playback, each of which allocates a trail grid.
    expect(long.pushes).toBe(short.pushes);
    expect(long.pushes).toBeLessThanOrEqual(long.maxQueued);
    // The backlog was dropped, so the client asks for a fresh full snapshot once.
    expect(long.inbox.takeResync()).toBe(true);
    expect(long.inbox.takeResync()).toBe(false);
  });

  it("resumes at the delayed live position from a full snapshot", () => {
    const { inbox, pb } = burst(700);
    const live = VISIBLE + 700 + 5;
    // Deltas still in flight from the old connection are dropped; the new connection's full is taken.
    inbox.push(at(live - 1), (live - 1) * TICK_MS);
    inbox.push(fullAt(live, 1), live * TICK_MS);
    const arrived = inbox.drain();
    expect(arrived.map((a) => a.m.tick)).toEqual([live]);
    for (const { m, at: t } of arrived) pb.push(m, t);
    const frame = new Frame();
    pb.sample(live * TICK_MS + RENDER_DELAY_MS, frame);
    expect(frame.tick).toBe(live);
    expect(pb.underrun(live * TICK_MS + RENDER_DELAY_MS)).toBe(false);
  });
});

describe("never stale: a different match starts a fresh story", () => {
  const BEFORE = 800;
  const RECONNECT = 850;

  /** Watch match 1 to BEFORE, then reconnect at RECONNECT to a full naming the given match (same map, later tick). */
  function reconnect(match: number) {
    const pb = new Playback();
    const frame = new Frame();
    pb.push(fullAt(0, 1), 0);
    for (let t = 1; t <= BEFORE; t++) pb.push(at(t), t * TICK_MS);
    pb.sample(BEFORE * TICK_MS + RENDER_DELAY_MS, frame);
    const before = frame.story.slice();
    const full = fullAt(RECONNECT, match);
    pb.push(full, RECONNECT * TICK_MS);
    for (let t = RECONNECT + 1; t <= RECONNECT + 20; t++) pb.push(at(t), t * TICK_MS);
    pb.sample((RECONNECT + 20) * TICK_MS + RENDER_DELAY_MS, frame);
    return { before, after: frame.story.slice(), board: frame.board!, full };
  }

  it("the recorded match has a story to lose (first contact before the reconnect)", () => {
    const { before } = reconnect(1);
    expect(before.some((e) => e.kind === "contact")).toBe(true);
  });

  it("a full snapshot from a different match drops the previous timeline, contacts and roster", () => {
    const { before, after, board, full } = reconnect(2);
    expect(before.length).toBeGreaterThan(0);
    expect(after.filter((e) => e.tick < RECONNECT)).toEqual([]);
    expect(board.agents.length).toBe(full.full!.agents.length);
  });

  it("a reconnect within the same match continues its story", () => {
    const { before, after } = reconnect(1);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("bounded catch-up on the live EventSource path", () => {
  /** An EventSource the test drives: emit() is the browser dispatching one SSE message. */
  class FakeSource implements EventSourceLike {
    onopen: EventSourceLike["onopen"] = null;
    onmessage: EventSourceLike["onmessage"] = null;
    onerror: EventSourceLike["onerror"] = null;
    readyState = 1;
    emit(m: StreamMessage): void {
      if (this.readyState === 2) return;
      this.onmessage?.({ data: deflateRawSync(encodeMessage(m)).toString("base64") } as MessageEvent<string>);
    }
    close(): void {
      this.readyState = 2;
    }
  }

  /** Let every pending decode and delivery run. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  }

  /** Wait (real time, decoding is asynchronous) until pred holds. */
  async function until(pred: () => boolean): Promise<void> {
    const end = Date.now() + 20_000;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting for the stream");
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  /** The page's live path (web/src/feed.ts, as web/src/main.ts uses it), with each decode counted and optionally held. */
  function client(options: { holdDecodes?: boolean } = {}) {
    const sources: FakeSource[] = [];
    const counts = { decodes: 0, active: 0, maxActive: 0 };
    const held: (() => void)[] = [];
    const feed = openFeed("/live/current", () => 0, () => {}, {
      source: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
      decode: async (data) => {
        counts.decodes++;
        counts.maxActive = Math.max(counts.maxActive, ++counts.active);
        try {
          if (options.holdDecodes) await new Promise<void>((r) => held.push(r));
          return await decodeData(data);
        } finally {
          counts.active--;
        }
      },
    });
    return { sources, counts, held, feed, inbox: feed.inbox, link: feed.link };
  }

  /** Connect and draw the first full, then the tab hides: B tick messages arrive and no frame drains them. */
  async function hidden(B: number, paced: boolean) {
    const c = client();
    c.sources[0]!.emit(fullAt(0, 1));
    expect((await c.feed.first).tick).toBe(0);
    expect(c.feed.take().length).toBe(1);
    c.counts.decodes = 0;
    c.counts.maxActive = 0;
    const src = c.sources[0]!;
    for (let t = 1; t <= B; t++) {
      src.emit(at(t));
      // Paced: each message is decoded and delivered (or the link has suspended) before the next arrives.
      if (paced) await until(() => src.readyState === 2 || c.inbox.size === t);
    }
    await settle();
    await until(() => c.counts.active === 0);
    return c;
  }

  for (const paced of [false, true]) {
    it(`a ${paced ? "paced" : "one-burst"} backlog decodes a bounded number of messages however long it is, one at a time`, async () => {
      const short = await hidden(100, paced);
      const long = await hidden(700, paced);
      expect(long.counts.decodes).toBe(short.counts.decodes);
      expect(long.counts.decodes).toBeLessThanOrEqual(INBOX_CAP + 1);
      expect(long.counts.maxActive).toBeLessThanOrEqual(1);
      expect(long.inbox.size).toBe(0);
      // The connection was dropped at the overflow and stays closed while no frame is drawn.
      expect(long.sources[0]!.readyState).toBe(2);
      expect(long.sources.length).toBe(1);
      // The next frame reopens it, once.
      expect(long.feed.take()).toEqual([]);
      expect(long.sources.length).toBe(2);
      expect(long.feed.take()).toEqual([]);
      expect(long.sources.length).toBe(2);
    });
  }

  it("the reopened connection resumes from its full snapshot at the delayed live position", async () => {
    const c = await hidden(700, false);
    c.feed.take();
    expect(c.sources.length).toBe(2);
    const live = 805;
    c.sources[1]!.emit(fullAt(live, 1));
    c.sources[1]!.emit(at(live + 1));
    await until(() => c.inbox.size === 2);
    expect(c.feed.take().map((a) => a.m.tick)).toEqual([live, live + 1]);
  });

  it("an overflow before the first full is delivered reopens at once, and the first full still arrives", async () => {
    // The first full is still decoding when a burst arrives (no frame loop runs before it is delivered).
    const c = client({ holdDecodes: true });
    c.sources[0]!.emit(fullAt(0, 1));
    for (let t = 1; t <= 100; t++) c.sources[0]!.emit(at(t));
    expect(c.sources[0]!.readyState).toBe(2);
    expect(c.sources.length).toBe(2);
    for (const release of c.held.splice(0)) release();
    // The new connection's first message is a full at the delayed live position; the page gets it with no frame drawn.
    const c2 = c.sources[1]!;
    const live = 205;
    c2.emit(fullAt(live, 1));
    c2.emit(at(live + 1));
    await until(() => c.held.length > 0);
    while (c.inbox.size < 2) {
      for (const release of c.held.splice(0)) release();
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((await c.feed.first).tick).toBe(live);
    expect(c.feed.take().map((a) => a.m.tick)).toEqual([live, live + 1]);
    expect(c.sources.length).toBe(2);
  });

  it("messages of an abandoned connection are neither decoded nor delivered", async () => {
    const c = client();
    c.sources[0]!.emit(fullAt(0, 1));
    for (let t = 1; t <= 10; t++) c.sources[0]!.emit(at(t));
    c.link.reopen();
    await settle();
    expect(c.counts.decodes).toBe(0);
    expect(c.inbox.size).toBe(0);
    expect(c.sources[0]!.readyState).toBe(2);
  });
});
