/**
 * What the stream tells a spectator
 * before playback starts, and which match a full snapshot belongs to.
 *
 * - Before the first delayed release a spectator receives no message at all, so
 *   the page must explain the wait by itself (test/spectator/robustness.test.ts).
 * - Every full snapshot names its match, which EventSource clients cannot
 *   read from the x-antwar-match header (by an identity unique
 *   across server restarts rather than the match number).
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState } from "../../src/sim/types.ts";
import { decodeMessage, encodeMessage, STREAM_VERSION, type StreamMessage } from "../../src/live/format.ts";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { playScripted, recordLog, scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS } from "../../web/src/buffer.ts";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";

import { playable } from "../playable.ts";
const SCRIPT: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 4, ticks: DEFAULT_CONFIG.matchTicks, attack: true };

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function serve(config: LiveConfig) {
  const clock = new ManualClock();
  const hub = new LiveHub({ config, clock });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  cleanup.push(async () => {
    hub.close();
    await server.close();
  });
  return { clock, hub, server };
}

function play(hub: LiveHub, clock: ManualClock, seq: number, state: SimState, ticks: number): SimState {
  for (let i = 0; i < ticks; i++) {
    const out = step(state, scriptedInputs(state, SCRIPT));
    hub.pushTick(seq, out);
    clock.advance(100);
    state = out.state;
  }
  return state;
}

describe("before the first delayed release", () => {
  it("a spectator attached at match start receives no message until delaySeconds of match time have passed", async () => {
    const { clock, hub, server } = await serve(DEFAULT_LIVE_CONFIG);
    const state = createMatch(SCRIPT.seed, playable(SCRIPT.config));
    hub.startMatch(1, state);
    const client = await SseClient.connect(server.url("/live/1"));
    cleanup.push(async () => client.close());
    const response = await served(server, 1);
    const delayTicks = DEFAULT_LIVE_CONFIG.delaySeconds * DEFAULT_CONFIG.ticksPerSecond;
    play(hub, clock, 1, state, delayTicks - 1);
    await delivered(client, response);
    expect(client.messageCount).toBe(0);
  });
});

describe("match number on the wire", () => {
  it("every full snapshot names its match, for spectators who join at the start and later", async () => {
    const { clock, hub, server } = await serve({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    let state = createMatch(SCRIPT.seed, playable(SCRIPT.config));
    hub.startMatch(7, state);
    const early = await SseClient.connect(server.url("/live/7"));
    cleanup.push(async () => early.close());
    const earlyServed = await served(server, 1);
    state = play(hub, clock, 7, state, 50);
    const late = await SseClient.connect(server.url("/live/current"));
    cleanup.push(async () => late.close());
    const lateServed = await served(server, 2);
    play(hub, clock, 7, state, 10);
    await delivered(early, earlyServed);
    await delivered(late, lateServed);
    const fulls = [...early.messages, ...late.messages].filter((m) => m.full !== null);
    expect(fulls.length).toBe(2);
    const named = fulls[0]!.full!.match;
    expect(named).toBeDefined();
    for (const m of fulls) expect(m.full!.match).toBe(named);
  });

  it("format version 4 round-trips the match number, and leaves it out when the sender has none", () => {
    expect(STREAM_VERSION).toBe(4);
    const recorder = new SpectatorRecorder(createMatch(SCRIPT.seed, playable(SCRIPT.config)));
    const base = { ...recorder.initial(), full: recorder.initialFull() };
    expect(decodeMessage(encodeMessage({ ...base, full: { ...base.full, match: 12345 } })).full!.match).toBe(12345);
    expect(decodeMessage(encodeMessage({ ...base, full: { ...base.full, match: 0 } })).full!.match).toBe(0);
    expect(decodeMessage(encodeMessage(base)).full!.match).toBeUndefined();
  });
});

/**
 * Each game-server process numbers its
 * matches from 1, so a spectator still connected across a restart would see
 * the new process's match 1 as the old one and keep its story. Two hubs stand
 * for the old and new processes, each on its own first match; the match each
 * full names comes from the hub itself, and the story is the page's Playback.
 */
describe("match identity across a server restart", () => {
  const TICKS = 900;
  const BEFORE = 800;
  const RECONNECT = 850;
  const STORY: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 10, ticks: TICKS, attack: true };
  const messages = recordLog(playScripted(STORY).lines, TICKS).map(decodeMessage);
  const at = (tick: number): StreamMessage => messages.find((m) => m.tick === tick)!;

  /** The full snapshot a reconnecting spectator receives at a tick, naming the given match. */
  function fullAt(tick: number, match: number | undefined): StreamMessage {
    const first = messages[0]!;
    const s = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
    for (const m of messages) if (m.tick > first.tick && m.tick <= tick) s.apply(m);
    const m = s.message();
    return { ...m, full: { ...structuredClone(m.full!), match } };
  }

  /** The match a hub's first match (seq 1) names on the full a newly connected spectator receives. */
  async function firstMatchNamed(): Promise<{ hub: LiveHub; named: () => Promise<number | undefined> }> {
    const { clock, hub, server } = await serve({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const state = createMatch(SCRIPT.seed, playable(SCRIPT.config));
    hub.startMatch(1, state);
    play(hub, clock, 1, state, 5);
    let connections = 0;
    const named = async (): Promise<number | undefined> => {
      const client = await SseClient.connect(server.url("/live/current"));
      cleanup.push(async () => client.close());
      const response = await served(server, ++connections);
      await delivered(client, response);
      return client.messages.find((m) => m.full !== null)!.full!.match;
    };
    return { hub, named };
  }

  /** Watch the old process's match to BEFORE, then reconnect at RECONNECT to a full naming `next`. */
  function watch(previous: number | undefined, next: number | undefined) {
    const pb = new Playback();
    const frame = new Frame();
    pb.push(fullAt(0, previous), 0);
    for (let t = 1; t <= BEFORE; t++) pb.push(at(t), t * TICK_MS);
    pb.sample(BEFORE * TICK_MS + RENDER_DELAY_MS, frame);
    const before = frame.story.slice();
    pb.push(fullAt(RECONNECT, next), RECONNECT * TICK_MS);
    for (let t = RECONNECT + 1; t <= RECONNECT + 20; t++) pb.push(at(t), t * TICK_MS);
    pb.sample((RECONNECT + 20) * TICK_MS + RENDER_DELAY_MS, frame);
    return { before, after: frame.story.slice() };
  }

  // Execution timeouts only: both tests spend most of their time in watch()'s 822 pure-computation
  // Playback pushes, with no waits. Alone 2.48-2.77 s on a slow shared machine; beside rolling-selection.test.ts at
  // --maxWorkers=2, 5.91-6.37 s (worst loaded 7.4 s), past the 5 s default. 30 s is about 4x that.
  it("a new process's first match starts a fresh story for a spectator who stayed connected", async () => {
    const oldProcess = await firstMatchNamed();
    const newProcess = await firstMatchNamed();
    const { before, after } = watch(await oldProcess.named(), await newProcess.named());
    expect(before.some((e) => e.kind === "contact")).toBe(true);
    expect(after.filter((e) => e.tick < RECONNECT)).toEqual([]);
  }, 30_000);

  it("a reconnect within one match still continues its story", async () => {
    const process = await firstMatchNamed();
    const first = await process.named();
    const again = await process.named();
    expect(first).toBeDefined();
    expect(again).toBe(first);
    const { before, after } = watch(first, again);
    expect(before.length).toBeGreaterThan(0);
    expect(after.slice(0, before.length)).toEqual(before);
  }, 30_000);
});
