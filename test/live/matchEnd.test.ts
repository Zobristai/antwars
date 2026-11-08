/**
 * The stream runs the configured delay behind the
 * match, writes a heartbeat comment after 15 s of silence, and, when a match
 * ends, plays out the remaining delay and delivers the result only with the
 * final tick's message.
 *
 * The test clock stands in for real time: the step completing tick k is
 * pushed at k × 100 ms, as the server's 10 Hz loop would push it.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { HISTORICAL_CONFIG as DEFAULT_CONFIG } from "../sim/fixtures.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState } from "../../src/sim/types.ts";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { GRID_SCALE_STREAM_VERSION, COMMAND_IDLE_STREAM_VERSION, decodeMessage, EARLY_WIN_STREAM_VERSION, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { HEARTBEAT, LiveHub } from "../../src/live/hub.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { decodeData, delivered, ManualClock, RecordedServer, served, SseClient, type ServedResponse } from "./helpers.ts";

import { playable } from "../playable.ts";
it("round-trips the sustained-territory result under its own wire version", () => {
  const opening = new SpectatorRecorder(createMatch(7001, playable(DEFAULT_CONFIG))).initial();
  const result = { winner: 0 as const, reason: "sustained_territory" as const, decidedBy: "territory" as const, tick: 7800, nextStartMs: null };
  const message: StreamMessage = { ...opening, tick: 7801, full: null, events: [{ kind: "end", result }] };
  const bytes = encodeMessage(message);
  expect(bytes[2]).toBe(EARLY_WIN_STREAM_VERSION);
  expect(decodeMessage(bytes).events).toEqual(message.events);
  expect(encodeMessage({ ...message, events: [] })[2]).not.toBe(EARLY_WIN_STREAM_VERSION);
});

it("composes early-win and idle-clock wire extensions without inventing an idle clock for old configs", () => {
  expect(EARLY_WIN_STREAM_VERSION).toBeGreaterThan(COMMAND_IDLE_STREAM_VERSION);
  // Pin the historical idle/early-win versions, independently of terrain.
  const idleZero = new SpectatorRecorder(createMatch(7001, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: 0 })));
  const zeroOpening: StreamMessage = { ...idleZero.initial(), full: idleZero.initialFull() };
  expect(encodeMessage(zeroOpening)[2]).toBe(GRID_SCALE_STREAM_VERSION);
  expect(decodeMessage(encodeMessage(zeroOpening)).full!.setup.commandIdleTicks).toBe(0);
  for (const commandIdleTicks of [undefined, 0, 600]) {
    const recorder = new SpectatorRecorder(createMatch(7001, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks })));
    const result = { winner: 0 as const, reason: "sustained_territory" as const, decidedBy: "territory" as const, tick: 7800, nextStartMs: null };
    const message: StreamMessage = { ...recorder.initial(), tick: 7801, full: { ...recorder.initialFull(), result }, events: [{ kind: "end", result }] };
    const bytes = encodeMessage(message), decoded = decodeMessage(bytes);
    expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(decoded.full!.result).toEqual(result);
    if (commandIdleTicks === undefined) expect(decoded.full!.setup).not.toHaveProperty("commandIdleTicks");
    else expect(decoded.full!.setup.commandIdleTicks).toBe(commandIdleTicks);
  }
});

const TICK_MS = 100;
const OVERRUN: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 10, ticks: DEFAULT_CONFIG.matchTicks, attack: true };
/** A time-up match of the given length, the agents holding the centre rather than attacking. */
function timeUp(matchTicks: number): ScriptOptions {
  const config: SimConfig = { ...DEFAULT_CONFIG, matchTicks };
  return { seed: 6006, config, agents: 10, ticks: matchTicks, attack: false };
}

interface Fixture {
  clock: ManualClock;
  hub: LiveHub;
  server: RecordedServer;
  clients: SseClient[];
}

let fx: Fixture | null = null;

async function setup(config: LiveConfig): Promise<Fixture> {
  const clock = new ManualClock();
  const hub = new LiveHub({ config, clock });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  fx = { clock, hub, server, clients: [] };
  return fx;
}

afterEach(async () => {
  if (fx === null) return;
  for (const c of fx.clients) c.close();
  fx.hub.close();
  await fx.server.close();
  fx = null;
});

async function connect(f: Fixture, path: string): Promise<{ client: SseClient; res: ServedResponse }> {
  const n = f.server.responses.length + 1;
  const client = await SseClient.connect(f.server.url(path));
  f.clients.push(client);
  const res = await served(f.server, n);
  return { client, res };
}

/** A data write as the server made it: when, and the message it carried. */
interface Sent {
  t: number;
  message: StreamMessage;
}

function sentOf(res: ServedResponse): Sent[] {
  return res.writes.filter((w) => w.text.startsWith("data: ")).map((w) => ({ t: w.t, message: decodeData(w.text.slice(6, -2)) }));
}

function commentsOf(res: ServedResponse): number[] {
  return res.writes.filter((w) => w.text === HEARTBEAT).map((w) => w.t);
}

function names(m: StreamMessage): boolean {
  return m.events.some((e) => e.kind === "end") || (m.full !== null && m.full.result !== null);
}

/**
 * Play a scripted match into the hub as match seq, the step completing tick k
 * pushed at k × 100 ms after start. onTick runs after each push. Returns the
 * final state and each tick's push time.
 */
async function play(
  f: Fixture,
  seq: number,
  script: ScriptOptions,
  onTick?: (state: SimState) => Promise<void> | void,
): Promise<{ state: SimState; pushedAt: Map<number, number> }> {
  let state = createMatch(script.seed, playable(script.config));
  const pushedAt = new Map<number, number>([[0, f.clock.now()]]);
  f.hub.startMatch(seq, state);
  while (state.result === null) {
    const out = step(state, scriptedInputs(state, script));
    f.clock.advance(TICK_MS);
    f.hub.pushTick(seq, out);
    state = out.state;
    pushedAt.set(state.tick, f.clock.now());
    await onTick?.(state);
  }
  return { state, pushedAt };
}

describe("stream delay", () => {
  // Execution timeout only: a full overrun match played tick by tick, pure computation, no real waits
  // (the clock is fake). Alone 1.53 s on a slow shared machine; beside rolling-selection.test.ts and the CPU-bound
  // sim files (unpinned) at --maxWorkers=2, 6.10-6.47 s, past the 5 s default. 30 s is about 4x that.
  it("with the default config, sends each tick's message no earlier than 60 s of match time after that tick", async () => {
    expect(DEFAULT_LIVE_CONFIG.delaySeconds).toBe(60);
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    f.clock.advance(61_000);
    const sent = sentOf(watcher!.res);
    // Every tick after the connect arrives, in order, the first as a full snapshot.
    expect(sent[0]!.message.full).not.toBeNull();
    expect(sent.map((s) => s.message.tick)).toEqual(Array.from({ length: state.tick + 1 }, (_, i) => i));
    for (const s of sent) expect(s.t - pushedAt.get(s.message.tick)!, `tick ${s.message.tick}`).toBe(60_000);
  }, 30_000);

  it("with the delay configured to 0, sends each tick's message at that tick", async () => {
    const f = await setup({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    const sent = sentOf(watcher!.res);
    expect(sent.map((s) => s.message.tick)).toEqual(Array.from({ length: state.tick }, (_, i) => i + 1));
    for (const s of sent) expect(s.t).toBe(pushedAt.get(s.message.tick));
  });

  it("keeps the normal 15 s heartbeat cadence up to the bounded final-result flush, and ends the stream after it", async () => {
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    f.clock.advance(60_000 + 40_000);
    const res = watcher!.res;
    const finalAt = pushedAt.get(state.tick)! + 60_000;
    // Connected at 100 ms; every stream opens with a comment at once;
    // the first data goes out when tick 600 is pushed, 60 s after tick 0.
    // The stream ends after the final flush: no heartbeat follows it.
    expect(commentsOf(res)).toEqual([100, 15_100, 30_100, 45_100, finalAt, finalAt + 100]);
    // Between any two consecutive writes there is never more than 15 s.
    const times = res.writes.map((w) => w.t);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(15_000);
    await delivered(watcher!.client, res);
    expect(watcher!.client.received.filter((r) => r.kind === "comment").map((r) => r.kind === "comment" && r.text)).toEqual(Array(6).fill(": keep-alive"));
  });
});

describe("bounded final-result flush", () => {
  it.each(["/live/current", "/live/1"])("writes an immediate and one delayed heartbeat after attached and late results on %s, then nothing more", async path => {
    const f = await setup({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    let watcher: Awaited<ReturnType<typeof connect>> | undefined;
    await play(f, 1, timeUp(2), async state => {
      if (state.tick === 1) watcher = await connect(f, path);
    });
    const writes = watcher!.res.writes;
    const resultIndex = writes.findIndex(write => write.text.startsWith("data: ") && names(decodeData(write.text.slice(6, -2))));
    expect(resultIndex).toBeGreaterThan(0);
    expect(writes.slice(resultIndex + 1).map(write => write.text)).toEqual([HEARTBEAT]);
    expect(writes[resultIndex + 1]!.t).toBe(writes[resultIndex]!.t);
    // Every stream opens with one comment; none other precedes the result.
    expect(writes[0]!.text).toBe(HEARTBEAT);
    expect(writes.slice(1, resultIndex).some(write => write.text === HEARTBEAT)).toBe(false);
    const late = await connect(f, path);
    expect(late.res.writes.map(write => write.text === HEARTBEAT)).toEqual([true, false, true]);
    expect(sentOf(late.res)[0]!.message.full!.result).not.toBeNull();
    f.clock.advance(99);
    expect(commentsOf(late.res)).toEqual([200, 200]);
    expect(commentsOf(watcher!.res)).toEqual([100, 200]);
    f.clock.advance(1);
    expect(commentsOf(late.res)).toEqual([200, 200, 300]);
    expect(commentsOf(watcher!.res)).toEqual([100, 200, 300]);
    f.clock.advance(DEFAULT_LIVE_CONFIG.heartbeatMs - 101);
    expect(commentsOf(late.res)).toHaveLength(3);
    f.clock.advance(1);
    // Both responses ended after the delayed flush: the heartbeat schedule does not resume.
    expect(commentsOf(late.res)).toEqual([200, 200, 300]);
    expect(commentsOf(watcher!.res)).toEqual([100, 200, 300]);
  });

  /** Controlled response makes cancellation/backpressure independent of OS socket buffering. */
  async function finalConnection() {
    const clock = new ManualClock();
    const hub = new LiveHub({ clock, keepMatches: 1, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 } });
    const writes: { text: string; at: number }[] = [];
    let blocked = false, destroyed = false;
    const req = Object.assign(new EventEmitter(), { url: "/live/1", method: "GET", headers: {} });
    const res = {
      writeHead() { return this; }, flushHeaders() {},
      write(text: string) { writes.push({ text, at: clock.now() }); return !blocked; },
      get writableLength() { return blocked ? DEFAULT_LIVE_CONFIG.maxUnsentBytes + 1 : 0; },
      destroy() { destroyed = true; }, end() {},
    };
    let state = createMatch(6006, playable({ ...DEFAULT_CONFIG, matchTicks: 2 }));
    hub.startMatch(1, state);
    await hub.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    while (!state.result) {
      const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state;
    }
    return { hub, clock, writes, req, block: () => { blocked = true; }, destroyed: () => destroyed };
  }

  it.each(["disconnect", "hub close", "match eviction"])("cancels the delayed heartbeat on %s", async reason => {
    const f = await finalConnection();
    try {
      const count = f.writes.length;
      if (reason === "disconnect") f.req.emit("close");
      else if (reason === "hub close") f.hub.close();
      else f.hub.startMatch(2, createMatch(6007, playable(DEFAULT_CONFIG)));
      f.clock.advance(30_000);
      expect(f.writes).toHaveLength(count);
    } finally { f.hub.close(); }
  });

  it("applies the unsent-byte limit to the delayed heartbeat and cancels remaining timers", async () => {
    const f = await finalConnection();
    try {
      const count = f.writes.length;
      f.block(); f.clock.advance(100);
      expect(f.writes.slice(count)).toEqual([{ text: HEARTBEAT, at: 300 }]);
      expect(f.destroyed()).toBe(true);
      f.clock.advance(30_000);
      expect(f.writes).toHaveLength(count + 1);
    } finally { f.hub.close(); }
  });
});

describe("match end with the default 60 s delay", () => {
  /** The result arrives with the final tick's message, at the final tick plus 60 s, and nothing earlier names the winner. */
  function expectResultOnlyAtFinalTick(sent: Sent[], state: SimState, pushedAt: Map<number, number>): void {
    const last = sent.at(-1)!;
    expect(last.message.tick).toBe(state.tick);
    expect(last.t).toBe(pushedAt.get(state.tick)! + 60_000);
    const end = last.message.events.find((e) => e.kind === "end");
    expect(end).toBeDefined();
    expect(end!.kind === "end" && end!.result.winner).toBe(state.result!.winner);
    for (const s of sent.slice(0, -1)) {
      expect(names(s.message), `tick ${s.message.tick} names the winner`).toBe(false);
      // Nor does an overrun that has reached its required ticks: that is the end itself.
      for (const e of s.message.events) if (e.kind === "overrun") expect(e.progress).toBeLessThan(e.required);
    }
  }

  it("holds the result of a match ended early by queen overrun until playback reaches the final tick", async () => {
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    expect(state.result!.reason).toBe("overrun");
    expect(state.tick).toBeLessThan(DEFAULT_CONFIG.matchTicks);
    // The match is over, but nothing has named the winner yet.
    expect(sentOf(watcher!.res).some((s) => names(s.message))).toBe(false);
    f.clock.advance(59_900);
    expect(sentOf(watcher!.res).some((s) => names(s.message))).toBe(false);
    f.clock.advance(100);
    expectResultOnlyAtFinalTick(sentOf(watcher!.res), state, pushedAt);
    await delivered(watcher!.client, watcher!.res);
    expect(names(watcher!.client.messages.at(-1)!)).toBe(true);
  });

  // 700 ticks is longer than the delay; 300 ticks is shorter, so nothing is released before the end.
  it.each([700, 300])("holds the result of a %i-tick match ended at time-up until playback reaches the final tick", async (matchTicks) => {
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, timeUp(matchTicks), async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    expect(state.result!.reason).toBe("time_up");
    expect(state.tick).toBe(matchTicks);
    f.clock.advance(59_900);
    expect(sentOf(watcher!.res).some((s) => names(s.message))).toBe(false);
    f.clock.advance(100);
    const sent = sentOf(watcher!.res);
    expectResultOnlyAtFinalTick(sent, state, pushedAt);
    // Every tick, the first included, went out exactly 60 s after it was pushed.
    expect(sent.map((s) => s.message.tick)).toEqual(Array.from({ length: matchTicks + 1 }, (_, i) => i));
    for (const s of sent) expect(s.t - pushedAt.get(s.message.tick)!, `tick ${s.message.tick}`).toBe(60_000);
  });

  it("gives a client reconnecting in the final minute a full snapshot without the result, then the result at the final tick", async () => {
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let first: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) first = await connect(f, "/live/1");
    });
    f.clock.advance(30_000);
    // The stream drops and the client comes back half way through the final minute.
    first!.client.close();
    await new Promise((r) => setTimeout(r, 20));
    f.clock.advance(5_000);
    const again = await connect(f, "/live/1");
    await delivered(again.client, again.res);
    const snapshot = again.client.messages[0]!;
    expect(snapshot.full).not.toBeNull();
    expect(snapshot.full!.result).toBeNull();
    expect(snapshot.tick).toBe(state.tick - 250);
    expect(names(snapshot)).toBe(false);
    f.clock.advance(25_000);
    const sent = sentOf(again.res);
    expect(sent[0]!.message.full).not.toBeNull();
    expectResultOnlyAtFinalTick(sent, state, pushedAt);
    // The dropped connection never saw the result either.
    expect(sentOf(first!.res).some((s) => names(s.message))).toBe(false);
  });

  // Execution timeout only: two full matches played tick by tick on a fake clock, pure computation, no
  // real waits. Alone 1.75 s on a slow shared machine. Beside rolling-selection.test.ts and the CPU-bound sim files at
  // --maxWorkers=2 it took 3.9, 5.2 and 6.8 s on one shared machine (2/3 past the 5 s default) and 4.19-4.78 s on
  // another (unpinned). 30 s is about 4x the worst loaded figure.
  it("delivers the result and the next start time on time when the next match starts before playback finishes", async () => {
    const f = await setup(DEFAULT_LIVE_CONFIG);
    let watcher: Awaited<ReturnType<typeof connect>> | null = null;
    const { state, pushedAt } = await play(f, 1, OVERRUN, async (s) => {
      if (s.tick === 1) watcher = await connect(f, "/live/1");
    });
    const nextStart = new Date(Date.UTC(2026, 9, 14, 18, 0, 0));
    f.hub.setNextStart(1, nextStart);
    // The next match starts 10 s later, while match 1's last 50 s are still playing out.
    f.clock.advance(10_000);
    let current: string | undefined;
    await play(f, 2, { ...OVERRUN, seed: 7007 }, async (s) => {
      if (s.tick === 100) {
        const probe = await connect(f, "/live/current");
        current = probe.client.headers["x-antwar-match"] as string;
        probe.client.close();
      }
      if (s.tick === 520) {
        const probe = await connect(f, "/live/current");
        current = `${current},${probe.client.headers["x-antwar-match"] as string}`;
        probe.client.close();
      }
    });
    // While match 1 is still playing out, /live/current serves it; once it has finished, the new match.
    expect(current).toBe("1,2");
    expectResultOnlyAtFinalTick(sentOf(watcher!.res), state, pushedAt);
    const end = sentOf(watcher!.res).at(-1)!.message.events.find((e) => e.kind === "end")!;
    expect(end.kind === "end" && end.result.nextStartMs).toBe(nextStart.getTime());
  }, 30_000);
});
