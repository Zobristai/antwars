/**
 * In a match configured for
 * 2,000 ants streaming at the 10 Hz default, no message exceeds 25 KB and no
 * spectator receives more than 256 KB in any second, both counted as bytes
 * written to the response.
 *
 * The 2,000-ant match carries the per-match cap of 50 agents, model labels and
 * intent lines of random printable ASCII at their maxima (64 and 80; ASCII is
 * sent uncut and compresses worst, so it is the largest text the stream sends;
 * the byte cut for other scripts is tested in stream.test.ts), and marks laid at the rules' rate
 * (commandFloorTicks 100 at 10 ticks/s, marksPerAgent 3: at most 150 live
 * marks). Agents attack, so it runs through the fight peak to a queen overrun.
 * It is pushed one tick per 100 ms of test clock into two hubs served over
 * real HTTP: one with no delay, one with the default 60 s delay that plays out
 * its backlog on its own timer after the end. Every response write is recorded
 * with its test-clock time and its bytes after deflate, base64 and SSE framing,
 * heartbeats included, and checked per message and over every half-open window
 * [t, t+1000) of write time.
 *
 * Negative controls run the same recorder and checker against encoders or
 * pacing that break each budget, so neither check passes vacuously.
 */
import { connect as netConnect, type Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { HISTORICAL_CONFIG as DEFAULT_CONFIG } from "../sim/fixtures.ts";
import { createMatch } from "../../src/sim/map.ts";
import { createRng } from "../../src/sim/rng.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState } from "../../src/sim/types.ts";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { HEARTBEAT, LiveHub, sseFrame, type LiveHubOptions } from "../../src/live/hub.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import {
  checkBudget,
  delivered,
  MESSAGE_BUDGET,
  ManualClock,
  RecordedServer,
  SECOND_BUDGET,
  served,
  SseClient,
  writesOf,
  type BudgetReport,
  type ServedResponse,
} from "./helpers.ts";

import { playable } from "../playable.ts";
// Keep the transport's original positive and negative controls independent of public economy tuning.
// The historical economy at grid scale 2: a 128x96 board, as the budgets were measured at, never doubled again.
const LARGE_CONFIG = {
  ...playable(DEFAULT_CONFIG),
  marksPerAgent: 3, // Recorded transport fixture, not the uncapped live configuration.
  startAnts: 1000,
  colonyCap: 1030,
};
// Physical distances halve on the same 128x96 board, so the battle comes sooner: about 2,060 ants meet at the
// fight peak (tick 601) and the queen falls by overrun at tick 958. The reconnect and the live stall sit in that
// battle, as they sat in the doubled board's battle at ticks 1,000-1,225.
const BATTLE_TICK = 600;

const TICK_MS = 100;
const AGENTS = 50;
const MAX_MARKS = AGENTS * LARGE_CONFIG.marksPerAgent;
const LARGE: ScriptOptions = {
  seed: 6006,
  config: LARGE_CONFIG,
  agents: AGENTS,
  ticks: LARGE_CONFIG.matchTicks,
  attack: true,
  labelChars: 64,
  intentChars: 80,
  randomText: true,
};
const SMALL: ScriptOptions = { seed: 6006, config: playable(DEFAULT_CONFIG), agents: 10, ticks: DEFAULT_CONFIG.matchTicks, attack: true };

const open: { clients: SseClient[]; hubs: LiveHub[]; servers: RecordedServer[] } = { clients: [], hubs: [], servers: [] };

afterAll(async () => {
  for (const c of open.clients) c.close();
  for (const h of open.hubs) h.close();
  for (const s of open.servers) await s.close();
});

class Served {
  readonly clock: ManualClock;
  readonly hub: LiveHub;
  readonly server: RecordedServer;
  constructor(clock: ManualClock, config: LiveConfig, extra: Omit<LiveHubOptions, "config" | "clock"> = {}, keepText = false) {
    this.clock = clock;
    this.hub = new LiveHub({ ...extra, config, clock });
    this.server = new RecordedServer(this.hub, clock, { keepText });
    open.hubs.push(this.hub);
    open.servers.push(this.server);
  }

  async connect(path: string, options: { keep?: boolean; decode?: boolean } = { keep: false }): Promise<{ client: SseClient; res: ServedResponse }> {
    const n = this.server.responses.length + 1;
    const client = await SseClient.connect(this.server.url(path), options);
    open.clients.push(client);
    return { client, res: await served(this.server, n) };
  }
}

async function drop(client: SseClient): Promise<void> {
  client.close();
  // Let the server see the close before time moves on.
  await new Promise((r) => setTimeout(r, 20));
}

function report(name: string, r: BudgetReport): void {
  console.log(`${name}: ${r.writes} writes, largest message ${r.maxMessage} B, largest second ${r.maxSecond} B at ${r.maxSecondAt} ms`);
}

/** Incompressible bytes from a seeded generator. */
function noise(n: number, seed: number): Uint8Array {
  const rng = createRng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng.next() * 256));
}

/** An encoder whose every SSE message is about `bytes` long on the wire. */
function fixedSizeEncoder(bytes: number): (m: StreamMessage) => Uint8Array {
  let n = Math.floor((bytes - 8) * 0.75);
  while (sseFrame(noise(n, 1)).length > bytes) n -= 16;
  const payload = noise(n, 1);
  return () => payload;
}

describe("bandwidth at 2,000 ants and 50 agents", () => {
  it("measures on the 128x96 grid-scale-2 board, never a doubled one", () => {
    const config = createMatch(LARGE.seed, LARGE.config).config;
    expect([config.mapWidth, config.mapHeight, config.gridScale, Math.max(config.mapWidth, config.mapHeight)]).toEqual([128, 96, 2, 128]);
  });
  it("keeps every message within 25 KB and every spectator within 256 KB in any second, through the battle, reconnects and the post-end backlog", async () => {
    const clock = new ManualClock();
    const live = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const delayed = new Served(clock, DEFAULT_LIVE_CONFIG);
    await live.server.listen();
    await delayed.server.listen();

    let state: SimState = createMatch(LARGE.seed, LARGE.config);
    live.hub.startMatch(1, state);
    delayed.hub.startMatch(1, state);
    const throughout = await live.connect("/live/1");
    const delayedThroughout = await delayed.connect("/live/1");
    let joiner: Awaited<ReturnType<Served["connect"]>> | null = null;
    const reconnector: ServedResponse[] = [];
    let reconnectClient: SseClient | null = null;
    let maxAnts = 0;
    let maxFights = 0;
    let fightPeakTick = 0;

    while (state.result === null) {
      const out = step(state, scriptedInputs(state, LARGE));
      clock.advance(TICK_MS);
      live.hub.pushTick(1, out);
      delayed.hub.pushTick(1, out);
      state = out.state;
      maxAnts = Math.max(maxAnts, state.ants.length);
      const fights = out.events.filter((e) => e.type === "fight").length;
      if (fights > maxFights) {
        maxFights = fights;
        fightPeakTick = state.tick;
      }
      // One spectator connects when the board is at its largest: every agent's three marks live.
      // It keeps every message, so the economy it was sent is checked below.
      if (joiner === null && state.marks.length === MAX_MARKS) joiner = await live.connect("/live/1", { keep: true });
      // One is connected 200 ticks before the battle, drops mid-battle 50 ticks into it and comes back 5 ticks later.
      if (state.tick === BATTLE_TICK - 200) {
        const c = await live.connect("/live/1");
        reconnectClient = c.client;
        reconnector.push(c.res);
      }
      if (state.tick === BATTLE_TICK + 50) await drop(reconnectClient!);
      if (state.tick === BATTLE_TICK + 55) {
        const c = await live.connect("/live/1");
        reconnectClient = c.client;
        reconnector.push(c.res);
      }
      // Spectators read as they go (a second of stream between reads), so none trips the unsent-data cap.
      if (state.tick % 10 === 0) {
        await delivered(throughout.client, throughout.res);
        await delivered(delayedThroughout.client, delayedThroughout.res);
        if (joiner !== null) await delivered(joiner.client, joiner.res);
        const reconnectorUp = reconnectClient !== null && (state.tick < BATTLE_TICK + 50 || state.tick >= BATTLE_TICK + 55);
        if (reconnectorUp) await delivered(reconnectClient!, reconnector.at(-1)!);
      }
    }
    const end = state.tick;
    // The delayed hub plays out its last minute on its own timer, read a second at a time; one spectator
    // reconnects half way through it.
    let late: Awaited<ReturnType<Served["connect"]>> | null = null;
    for (let s = 0; s < 61; s++) {
      if (s === 30) late = await delayed.connect("/live/1");
      clock.advance(1_000);
      await delivered(delayedThroughout.client, delayedThroughout.res);
      if (late !== null) await delivered(late.client, late.res);
    }
    await delivered(throughout.client, throughout.res);
    late = late!;

    // The run covered the battle: the fight peak, about 2,000 ants, and a match end by overrun.
    console.log(`end tick ${end} (${state.result!.reason}), fight peak ${maxFights} at tick ${fightPeakTick}, most ants ${maxAnts}`);
    // Past the reconnect and the live stall scenario's run (the battle tick, 25 stalled ticks and 200 after).
    expect(end).toBeGreaterThanOrEqual(BATTLE_TICK + 225);
    expect(fightPeakTick).toBeGreaterThan(BATTLE_TICK);
    expect(maxAnts).toBeGreaterThanOrEqual(2_000);

    // The joiner's first message is the largest full snapshot: 150 marks, 50 agents with the longest labels and intent lines.
    expect(joiner).not.toBeNull();
    const big = joiner!.client.received.find((r) => r.kind === "message")!;
    expect(big.kind === "message" && big.message.full!.marks.length).toBe(MAX_MARKS);
    const agents = big.kind === "message" ? big.message.full!.agents : [];
    expect(agents.length).toBe(AGENTS);
    expect(agents.every((a) => a.modelLabel.length === 64)).toBe(true);
    expect(agents.filter((a) => a.intent.length === 80).length).toBe(AGENTS);
    // Every connection decoded every message it was sent.
    expect(throughout.client.messageCount).toBe(end + 1);
    expect(delayedThroughout.client.messageCount).toBe(end + 1);
    expect(late.client.received[0]!.kind === "message" && late.client.received[0]!.message.full).not.toBeNull();

    // The economy rides inside these budgets: the joiner's first full snapshot carries food piles and
    // the stores, and its stream carries food and store events and ants carrying food.
    const joined = joiner!.client.messages;
    expect(joined[0]!.full!.food!.some((f) => f > 0)).toBe(true);
    expect(joined[0]!.full!.stores!.some((s) => s.food > 0 || s.nextHatchTick > 0)).toBe(true);
    const kinds = new Set(joined.flatMap((m) => m.events.map((e) => e.kind)));
    expect(kinds).toContain("food");
    expect(kinds).toContain("store");
    expect(joined.some((m) => m.ants.carrying!.some((c) => c === 1))).toBe(true);
    // The largest full snapshot any spectator was sent stays within the per-message budget on its own.
    const clients = [throughout.client, joiner!.client, reconnectClient!, delayedThroughout.client, late.client];
    const fullBytes = clients.flatMap((c) => c.received.flatMap((r) => (r.kind === "message" && r.message.full !== null ? [r.bytes] : [])));
    const largestFull = Math.max(...fullBytes);
    console.log(`largest full snapshot ${largestFull} B of ${MESSAGE_BUDGET} B (${fullBytes.length} full snapshots)`);
    expect(largestFull).toBeLessThanOrEqual(MESSAGE_BUDGET);

    const spectators: [string, ServedResponse[]][] = [
      ["no delay, throughout", [throughout.res]],
      ["no delay, joined at 150 marks", [joiner!.res]],
      ["no delay, dropped and reconnected mid-battle", reconnector],
      ["60 s delay, throughout and post-end backlog", [delayedThroughout.res]],
      ["60 s delay, reconnected during the backlog", [late.res]],
    ];
    for (const [name, responses] of spectators) {
      // Every spectator here reads as it goes: none was dropped by the unsent-data cap.
      for (const res of responses) expect(res.destroyed, name).toBeNull();
      const r = checkBudget(writesOf(...responses));
      report(name, r);
      expect(r.writes).toBeGreaterThan(0);
      expect(r.maxMessage, name).toBeLessThanOrEqual(MESSAGE_BUDGET);
      expect(r.maxSecond, name).toBeLessThanOrEqual(SECOND_BUDGET);
    }
    // The reconnect's full snapshot is among the writes the window check saw.
    expect(reconnector.length).toBe(2);
    expect(reconnector[1]!.writes.length).toBeGreaterThan(0);
  }, 600_000);
});

describe("the budget checks fail against streams that break them", () => {
  /** Play the small attacking match into a no-delay hub for n ticks, with one spectator from the start. */
  async function smallRun(encode: (m: StreamMessage) => Uint8Array, ticks: number, reconnectAt: number | null): Promise<ServedResponse[]> {
    const clock = new ManualClock();
    // Unpaced (paceBytesPerSecond Infinity): these controls test the checker, not the hub's pacing.
    const s = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0, paceBytesPerSecond: Number.POSITIVE_INFINITY }, { encode });
    await s.server.listen();
    let state = createMatch(SMALL.seed, SMALL.config);
    s.hub.startMatch(1, state);
    const responses: ServedResponse[] = [];
    let c = await s.connect("/live/1", { decode: false });
    responses.push(c.res);
    while (state.tick < ticks) {
      const out = step(state, scriptedInputs(state, SMALL));
      clock.advance(TICK_MS);
      s.hub.pushTick(1, out);
      state = out.state;
      if (state.tick === reconnectAt) {
        await drop(c.client);
        c = await s.connect("/live/1", { decode: false });
        responses.push(c.res);
      }
    }
    return responses;
  }

  it("the per-message check fails when a message is padded past 25 KB", async () => {
    const padded = (m: StreamMessage): Uint8Array => {
      const body = encodeMessage(m);
      const out = new Uint8Array(body.length + 30_000);
      out.set(body);
      out.set(noise(30_000, 2), body.length);
      return out;
    };
    const r = checkBudget(writesOf(...(await smallRun(padded, 5, null))));
    report("padded past 25 KB", r);
    expect(r.maxMessage).toBeGreaterThan(MESSAGE_BUDGET);
    expect(r.overMessage).toBeGreaterThan(0);
  });

  it("the per-second check fails for 24 KB messages at 10 Hz plus a reconnect snapshot", async () => {
    const r = checkBudget(writesOf(...(await smallRun(fixedSizeEncoder(24_000), 30, 15))));
    report("24 KB at 10 Hz with a reconnect", r);
    expect(r.maxMessage).toBeLessThanOrEqual(MESSAGE_BUDGET);
    expect(r.maxMessage).toBeGreaterThan(23_500);
    expect(r.maxSecond).toBeGreaterThan(SECOND_BUDGET);
    expect(r.overSecond).toBeGreaterThan(0);
  });

  it("and passes its twin: the same 24 KB messages at 10 Hz with no reconnect", async () => {
    const r = checkBudget(writesOf(...(await smallRun(fixedSizeEncoder(24_000), 30, null))));
    report("24 KB at 10 Hz, no reconnect", r);
    expect(r.maxMessage).toBeGreaterThan(23_500);
    expect(r.maxSecond).toBeLessThanOrEqual(SECOND_BUDGET);
    expect(r.maxSecond).toBeGreaterThan(10 * 23_500);
  });

  it("the per-second check fails when the post-end backlog is written in one burst", async () => {
    const clock = new ManualClock();
    // Injected pacing: every remaining record goes out at the moment the match ends. Messages are a
    // fixed 2 KB, so at 10 Hz the stream sits far inside the budget and only the burst can break it.
    // The client is never read, so the unsent-data cap is lifted: this control tests the checker.
    // Unpaced too, or the hub's own pacing would spread the burst.
    const unpaced = { ...DEFAULT_LIVE_CONFIG, maxUnsentBytes: Number.POSITIVE_INFINITY, paceBytesPerSecond: Number.POSITIVE_INFINITY };
    const s = new Served(clock, unpaced, { playoutMs: 0, encode: fixedSizeEncoder(2_000) });
    await s.server.listen();
    let state = createMatch(SMALL.seed, SMALL.config);
    s.hub.startMatch(1, state);
    const c = await s.connect("/live/1", { keep: false, decode: false });
    while (state.result === null) {
      const out = step(state, scriptedInputs(state, SMALL));
      clock.advance(TICK_MS);
      s.hub.pushTick(1, out);
      state = out.state;
    }
    // With playoutMs 0 and no pacing, the backlog is written with the final tick, at the end's own time.
    const endedAt = clock.now();
    const before = checkBudget(c.res.writes.filter((w) => w.t < endedAt));
    expect(before.maxSecond).toBeLessThanOrEqual(SECOND_BUDGET);
    clock.advance(1);
    const r = checkBudget(c.res.writes);
    report("post-end backlog in one burst", r);
    expect(r.maxSecond).toBeGreaterThan(SECOND_BUDGET);
    expect(r.overSecond).toBeGreaterThan(0);
  });
});

/**
 * Event-loop stalls: a stall leaves a backlog, of
 * pushed ticks or of overdue playout timers, that must drain within the
 * per-second budget, in order, and get back on schedule. Each test runs one
 * match into hubs on one clock: paced at the default budget; unpaced
 * (paceBytesPerSecond Infinity), which must break the per-second budget; and a
 * broken pacer starved below the stream's own rate, which must fail the
 * recovery check, so each check can fail.
 */
describe("a stall's backlog drains within the budgets", () => {
  async function twins(delaySeconds: number): Promise<{ clock: ManualClock; paced: Served; unpaced: Served; starved: Served }> {
    const clock = new ManualClock();
    const paced = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds });
    const unpaced = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds, paceBytesPerSecond: Number.POSITIVE_INFINITY });
    const starved = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds, paceBytesPerSecond: 20_000 });
    for (const s of [paced, unpaced, starved]) await s.server.listen();
    return { clock, paced, unpaced, starved };
  }

  const heartbeatBytes = Buffer.byteLength(HEARTBEAT);
  /** Each data message's tick paired with the time it was written. */
  function writeTimes(c: { client: SseClient; res: ServedResponse }): Map<number, number> {
    const data = c.res.writes.filter((w) => w.bytes !== heartbeatBytes);
    expect(data.length).toBe(c.client.log.length);
    return new Map(c.client.log.map((m, i) => [m.tick, data[i]!.t]));
  }
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  /** On the manual clock an on-time write happens at its scheduled release exactly, as the unsent-data check requires. */
  const ON_TIME_MS = 0;
  /**
   * Each tick's lag, its actual write time minus its scheduled release (a tick
   * never written lags forever), and the write time from which every later
   * tick's lag stays within ON_TIME_MS to the end of the run: null if it never
   * comes back.
   */
  function recovery(ticks: number[], written: Map<number, number>, due: (tick: number) => number): { minLag: number; maxLag: number; recoveredAt: number | null } {
    let minLag = Number.POSITIVE_INFINITY;
    let maxLag = Number.NEGATIVE_INFINITY;
    let lastLate = -1;
    ticks.forEach((tick, i) => {
      const t = written.get(tick);
      const lag = t === undefined ? Number.POSITIVE_INFINITY : t - due(tick);
      minLag = Math.min(minLag, lag);
      maxLag = Math.max(maxLag, lag);
      if (lag > ON_TIME_MS) lastLate = i;
    });
    const recoveredAt = lastLate === ticks.length - 1 ? null : written.get(ticks[lastLate + 1]!)!;
    return { minLag, maxLag, recoveredAt };
  }

  it("live: 2.5 s at the fight peak, then the held-back ticks pushed at once", async () => {
    const STALL_TICK = BATTLE_TICK;
    const STALL_MS = 2_500;
    const AFTER_TICKS = 200;
    const { clock, paced, unpaced, starved } = await twins(0);
    let state: SimState = createMatch(LARGE.seed, LARGE.config);
    for (const s of [paced, unpaced, starved]) s.hub.startMatch(1, state);
    const a = await paced.connect("/live/1");
    const b = await unpaced.connect("/live/1");
    const c = await starved.connect("/live/1");
    const pushedAt = new Map<number, number>([[0, 0]]);
    const push = (): void => {
      const out = step(state, scriptedInputs(state, LARGE));
      for (const s of [paced, unpaced, starved]) s.hub.pushTick(1, out);
      state = out.state;
      pushedAt.set(state.tick, clock.now());
    };
    let resumedAt = -1;
    // The run goes on 20 s of pushes past the stall's end.
    while (state.result === null && state.tick < STALL_TICK + STALL_MS / TICK_MS + AFTER_TICKS) {
      if (state.tick === STALL_TICK) {
        clock.stall(STALL_MS);
        resumedAt = clock.now();
        for (let i = 0; i < STALL_MS / TICK_MS; i++) push();
      } else {
        clock.advance(TICK_MS);
        push();
      }
      if (state.tick % 10 === 0) {
        for (const x of [a, b, c]) await delivered(x.client, x.res);
      }
    }
    for (const x of [a, b, c]) await delivered(x.client, x.res);
    expect(state.tick).toBe(STALL_TICK + STALL_MS / TICK_MS + AFTER_TICKS);

    const pacedReport = checkBudget(a.res.writes);
    const unpacedReport = checkBudget(b.res.writes);
    report("live stall, paced", pacedReport);
    report("live stall, unpaced twin", unpacedReport);
    expect(unpacedReport.overSecond).toBeGreaterThan(0);
    expect(pacedReport.maxMessage).toBeLessThanOrEqual(MESSAGE_BUDGET);
    expect(pacedReport.maxSecond).toBeLessThanOrEqual(SECOND_BUDGET);

    // Every tick, once, in order.
    expect(a.client.log.map((m) => m.tick)).toEqual(range(0, state.tick));
    // Write lag against each tick's scheduled release (with no delay, its push): on time before the stall;
    // from the stall's end to the end of the run, behind at first, then back on time within 10 s and
    // staying there, over at least the run's last 10 s.
    const due = (tick: number): number => pushedAt.get(tick)!;
    const before = recovery(range(0, STALL_TICK), writeTimes(a), due);
    const after = range(STALL_TICK + 1, state.tick);
    const r = recovery(after, writeTimes(a), due);
    const broken = recovery(after, writeTimes(c), due);
    console.log(`live stall: paced lag up to ${r.maxLag} ms, on time again from ${r.recoveredAt! - resumedAt} ms after the stall to the end at ${due(state.tick) - resumedAt} ms; starved pacer lag up to ${broken.maxLag} ms, recovered ${broken.recoveredAt === null ? "never" : `${broken.recoveredAt - resumedAt} ms after`}`);
    expect([before.minLag, before.maxLag]).toEqual([0, 0]);
    expect(r.minLag).toBeGreaterThanOrEqual(0);
    expect(r.maxLag).toBeGreaterThan(ON_TIME_MS);
    expect(r.recoveredAt).not.toBeNull();
    expect(r.recoveredAt! - resumedAt).toBeLessThanOrEqual(10_000);
    expect(due(state.tick) - r.recoveredAt!).toBeGreaterThanOrEqual(10_000);
    // A pacer that cannot keep up with the stream fails the same check.
    expect(broken.recoveredAt === null || broken.recoveredAt - resumedAt > 10_000).toBe(true);
  }, 600_000);

  it("post-end: a stall at the start of playback, and a spectator joining during the backlog", async () => {
    const STALL_MS = 5_000;
    const { clock, paced, unpaced, starved } = await twins(DEFAULT_LIVE_CONFIG.delaySeconds);
    let state: SimState = createMatch(LARGE.seed, LARGE.config);
    for (const s of [paced, unpaced, starved]) s.hub.startMatch(1, state);
    const a = await paced.connect("/live/1");
    const b = await unpaced.connect("/live/1");
    const c = await starved.connect("/live/1");
    while (state.result === null) {
      const out = step(state, scriptedInputs(state, LARGE));
      clock.advance(TICK_MS);
      for (const s of [paced, unpaced, starved]) s.hub.pushTick(1, out);
      state = out.state;
      if (state.tick % 10 === 0) {
        for (const x of [a, b, c]) await delivered(x.client, x.res);
      }
    }
    const final = state.tick;
    const endedAt = clock.now();
    const delayTicks = DEFAULT_LIVE_CONFIG.delaySeconds * 10;
    // Where playback puts each record still held at the end.
    const scheduled = (tick: number): number => endedAt + (tick + delayTicks - final) * TICK_MS;

    clock.stall(STALL_MS);
    const resumedAt = clock.now();
    await delivered(a.client, a.res);
    // Joins at the bottom of the backlog, before the overdue timers run: its full snapshot and the
    // catch-up both land in its first second. The final record is unwritten.
    expect(a.client.log.some((m) => m.result)).toBe(false);
    const behindBy = resumedAt - scheduled(a.client.log.at(-1)!.tick);
    const joiner = await paced.connect("/live/1");
    clock.advance(0);
    for (let s = 0; s < DEFAULT_LIVE_CONFIG.delaySeconds + 5; s++) {
      clock.advance(1_000);
      for (const x of [a, b, c, joiner]) await delivered(x.client, x.res);
    }
    console.log(`post-end stall: final tick ${final}; the joiner came in ${behindBy} ms behind schedule, at tick ${joiner.client.log[0]?.tick}`);

    const pacedReport = checkBudget(a.res.writes);
    const unpacedReport = checkBudget(b.res.writes);
    const joinerReport = checkBudget(joiner.res.writes);
    report("post-end stall, paced", pacedReport);
    report("post-end stall, unpaced twin", unpacedReport);
    report("post-end stall, joined during the backlog", joinerReport);
    expect(unpacedReport.overSecond).toBeGreaterThan(0);
    for (const r of [pacedReport, joinerReport]) {
      expect(r.maxMessage).toBeLessThanOrEqual(MESSAGE_BUDGET);
      expect(r.maxSecond).toBeLessThanOrEqual(SECOND_BUDGET);
    }

    // Every tick, once, in order; the result only with the final tick.
    expect(a.client.log.map((m) => m.tick)).toEqual(range(0, final));
    expect(a.client.log.filter((m) => m.result).map((m) => m.tick)).toEqual([final]);
    // Write lag against each played-out tick's scheduled release, from the stall's end to the end of
    // playback: behind at first, then back on time within 10 s and staying there, over at least 10 s.
    const playout = range(final - delayTicks + 1, final);
    const r = recovery(playout, writeTimes(a), scheduled);
    const broken = recovery(playout, writeTimes(c), scheduled);
    console.log(`post-end stall: paced lag up to ${r.maxLag} ms, on time again from ${r.recoveredAt! - resumedAt} ms after the stall to the end at ${scheduled(final) - resumedAt} ms; starved pacer lag up to ${broken.maxLag} ms, recovered ${broken.recoveredAt === null ? "never" : `${broken.recoveredAt - resumedAt} ms after`}`);
    expect(r.minLag).toBeGreaterThanOrEqual(0);
    expect(r.maxLag).toBeGreaterThan(ON_TIME_MS);
    expect(r.recoveredAt).not.toBeNull();
    expect(r.recoveredAt! - resumedAt).toBeLessThanOrEqual(10_000);
    expect(scheduled(final) - r.recoveredAt!).toBeGreaterThanOrEqual(10_000);
    // A pacer that cannot keep up with the stream fails the same check.
    expect(broken.recoveredAt === null || broken.recoveredAt - resumedAt > 10_000).toBe(true);

    // The joiner: a full snapshot first, from behind schedule; then every tick after it, with no gap
    // and no rewind; no result before the final tick.
    expect(behindBy).toBeGreaterThan(0);
    const first = joiner.client.log[0]!;
    expect(first.full).toBe(true);
    expect(first.result).toBe(false);
    expect(first.tick).toBeLessThan(final);
    expect(joiner.client.log.map((m) => m.tick)).toEqual(range(first.tick, final));
    expect(joiner.client.log.slice(1).every((m) => !m.full)).toBe(true);
    expect(joiner.client.log.filter((m) => m.result).map((m) => m.tick)).toEqual([final]);
  }, 600_000);
});

/**
 * A spectator that reads its response headers and then stops reading: a raw
 * socket, paused, so the server's writes back up into its buffers.
 */
async function pausedReader(port: number, path: string): Promise<{ socket: Socket; closed: Promise<void> }> {
  const socket = netConnect(port, "127.0.0.1");
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const head = new Promise<void>((resolve) => socket.once("data", () => resolve()));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  await head;
  socket.pause();
  return { socket, closed };
}

describe("a spectator that stops reading", () => {
  it("is disconnected once its unsent data passes the configured cap, while another spectator of the match receives every message on schedule, and reconnects to a full snapshot", async () => {
    expect(DEFAULT_LIVE_CONFIG.maxUnsentBytes).toBeLessThanOrEqual(1024 * 1024);
    const cap = DEFAULT_LIVE_CONFIG.maxUnsentBytes;
    const clock = new ManualClock();
    const live = new Served(clock, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    await live.server.listen();
    let state: SimState = createMatch(LARGE.seed, LARGE.config);
    live.hub.startMatch(1, state);

    // The stalled reader connects first, so in every release it is written before the healthy one.
    const stalled = await pausedReader(live.server.port, "/live/1");
    const stalledRes = await served(live.server, 1);
    const healthy = await live.connect("/live/1");
    const heartbeatBytes = Buffer.byteLength(HEARTBEAT);
    const dataWrites = (): number => healthy.res.writes.filter((w) => w.bytes !== heartbeatBytes).length;
    expect(dataWrites()).toBe(1);

    // Each data write the healthy spectator should get: tick 0's at connect, then one per tick at its release.
    const due: number[] = [0];
    const pushOne = (): void => {
      const out = step(state, scriptedInputs(state, LARGE));
      clock.advance(TICK_MS);
      live.hub.pushTick(1, out);
      state = out.state;
      due.push(clock.now());
      // The healthy spectator's message for this tick was written now, after the stalled one's in the same release.
      expect(healthy.res.writes.at(-1)!.t).toBe(clock.now());
    };
    let tripTick = -1;
    while (state.result === null) {
      pushOne();
      if (stalledRes.destroyed !== null) {
        tripTick = state.tick;
        // Before the socket's close event can run: 15 s on, the dropped response gets no heartbeat.
        clock.advance(DEFAULT_LIVE_CONFIG.heartbeatMs + TICK_MS);
        break;
      }
      await delivered(healthy.client, healthy.res);
    }
    console.log(`stalled reader dropped at tick ${tripTick} with ${stalledRes.destroyed?.unsent} B unsent after ${stalledRes.destroyed?.writes} writes`);
    expect(tripTick).toBeGreaterThan(0);
    const trip = stalledRes.destroyed!;
    // Dropped for the cap: over it at the destroy, and never more than one message past it.
    expect(trip.unsent).toBeGreaterThan(cap);
    expect(trip.unsent).toBeLessThanOrEqual(cap + MESSAGE_BUDGET);
    // Nothing was written to it after the destroy, heartbeat included.
    expect(stalledRes.writes.length).toBe(trip.writes);
    // The healthy spectator's heartbeat still came, and it keeps receiving every tick on schedule.
    expect(healthy.res.writes.at(-1)!.bytes).toBe(heartbeatBytes);
    for (let i = 0; i < 20 && state.result === null; i++) {
      pushOne();
      await delivered(healthy.client, healthy.res);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(stalledRes.writes.length).toBe(trip.writes);

    // Every tick's message reached the healthy spectator, one per tick, each written at its release.
    const ticks = state.tick;
    expect(dataWrites()).toBe(ticks + 1);
    expect(healthy.client.messageCount).toBe(ticks + 1);
    expect(healthy.res.writes.filter((w) => w.bytes !== heartbeatBytes).map((w) => w.t)).toEqual(due);

    // The stalled client sees its stream end once it reads again.
    stalled.socket.resume();
    await stalled.closed;

    // Its reconnect starts from a full snapshot and carries on with the match.
    const again = await live.connect("/live/1", { keep: true });
    for (let i = 0; i < 3 && state.result === null; i++) {
      const out = step(state, scriptedInputs(state, LARGE));
      clock.advance(TICK_MS);
      live.hub.pushTick(1, out);
      state = out.state;
    }
    await delivered(again.client, again.res);
    const msgs = again.client.messages;
    expect(msgs[0]!.full).not.toBeNull();
    expect(msgs[0]!.full!.agents.length).toBe(AGENTS);
    expect(msgs.slice(1).map((m) => m.full)).toEqual([null, null, null]);
    expect(msgs.map((m) => m.tick)).toEqual([ticks, ticks + 1, ticks + 2, ticks + 3]);
  }, 600_000);
});
