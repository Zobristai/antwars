import { deepStrictEqual } from "node:assert";
import { Worker as NodeWorker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { Frame, Playback, RENDER_DELAY_MS, TickPreparation, TRAIL_DECAY_PER_TICK, TRAIL_DEPOSIT, TRAIL_RES } from "../../web/src/buffer.ts";
import { IntakeProcessor, WorkerIntake, intakeTransfers, type IntakeReply, type IntakeRequest, type IntakeWorker } from "../../web/src/intake.ts";
import { openPreparedFeed } from "../../web/src/feed.ts";
import { INBOX_CAP } from "../../web/src/inbox.ts";
import type { EventSourceLike, LinkState } from "../../web/src/stream.ts";
import { Waiting } from "../../web/src/waiting.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const bytes = scale2Packets(160);
const messages = bytes.map(decodeMessage);
const raw = (m: StreamMessage) => deflateRawSync(encodeMessage(m)).toString("base64");

/** Actual second JS realm, transfer lists included. Only the browser Worker port is adapted to Node's port. */
function createWorker(): IntakeWorker {
  const resolver = new URL("../../src/ts-resolve.mjs", import.meta.url).href;
  const entry = new URL("../../web/src/intake.worker.ts", import.meta.url).href;
  const bootstrap = `import { parentPort } from 'node:worker_threads';
    await import(${JSON.stringify(resolver)});
    globalThis.postMessage = (reply, transfers) => parentPort.postMessage(reply, transfers);
    await import(${JSON.stringify(entry)});
    parentPort.on('message', data => globalThis.onmessage({data}));`;
  const worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv: [] });
  const port: IntakeWorker = { onmessage: null, onerror: null,
    postMessage: (message) => worker.postMessage(message), terminate: () => { void worker.terminate(); } };
  worker.on("message", (data: IntakeReply) => port.onmessage?.({ data } as MessageEvent<IntakeReply>));
  worker.on("error", (error) => port.onerror?.({ message: error.message } as ErrorEvent));
  return port;
}

class Source implements EventSourceLike {
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  readyState = 1;
  emit(m: StreamMessage) { if (this.readyState !== 2) this.onmessage?.({ data: raw(m) } as MessageEvent<string>); }
  close() { this.readyState = 2; }
}
async function until(pred: () => boolean) {
  const end = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() >= end) throw new Error("intake condition not reached");
    await new Promise((done) => setTimeout(done, 1));
  }
}

describe("tick preparation across the real worker transfer boundary", () => {
  it("matches recording playback, keeps unchanged board identities, and never detaches the retained model", async () => {
    const worker = new WorkerIntake(createWorker), inline = new Playback(), live = new Playback();
    const a = new Frame(), b = new Frame();
    try {
      let previousTerritory: Uint8Array | undefined;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        inline.push(structuredClone(m), i * 100);
        const reply = await worker.decode(raw(m));
        expect(reply.workerMs).toBeGreaterThanOrEqual(0);
        expect(reply.prepared).not.toBeNull();
        live.pushPrepared(reply.prepared!, i * 100);
        inline.sample(i * 100 + RENDER_DELAY_MS - 40, a);
        live.sample(i * 100 + RENDER_DELAY_MS - 40, b);
        // Native strict comparison checks every typed-array byte without enumerating large grids as JS properties.
        deepStrictEqual(b, a);
        if (i > 0 && !m.events.some((e) => e.kind === "territory")) expect(live.latestBoard!.territory).toBe(previousTerritory);
        previousTerritory = live.latestBoard!.territory;
      }
    } finally { worker.close(); }
  }, 30_000);

  it("preserves event timing and resets across gaps, same-match reconnects and a new match", async () => {
    const worker = new WorkerIntake(createWorker), inline = new Playback(), live = new Playback();
    const first = messages[0]!;
    const stream: StreamMessage[] = [
      { ...structuredClone(first), full: { ...structuredClone(first.full!), match: 1 } },
      ...messages.slice(1, 8),
      // Duplicate and dropped ticks do not manufacture events or advance a stale tick.
      messages[7]!, messages[10]!,
      { ...structuredClone(first), tick: first.tick + 11, full: { ...structuredClone(first.full!), match: 1 } },
      { ...structuredClone(first), tick: first.tick + 12, full: { ...structuredClone(first.full!), match: 2 } },
    ];
    try {
      for (let i = 0; i < stream.length; i++) {
        const m = stream[i]!;
        inline.push(structuredClone(m), i * 100);
        const tick = await worker.decode(raw(m));
        if (tick.prepared) live.pushPrepared(tick.prepared, i * 100);
        const a = new Frame(), b = new Frame();
        inline.sample(i * 100 + RENDER_DELAY_MS, a); live.sample(i * 100 + RENDER_DELAY_MS, b);
        deepStrictEqual(b, a);
        expect(live.matches).toBe(inline.matches);
        expect(live.resets).toBe(inline.resets);
      }
    } finally { worker.close(); }
  }, 20_000);

  it("preserves main's streamed territory countdown across worker deltas, clears and reconnects", async () => {
    const worker = new WorkerIntake(createWorker), live = new Playback();
    const first = structuredClone(messages[0]!);
    // The in-process recording opens at tick 0: the specimen stands 20 ticks in, so the lead can start before it.
    first.tick += 20;
    const lead = { colony: 0 as const, startTick: first.tick - 20, winTick: first.tick + 100 };
    const changed = { colony: 1 as const, startTick: first.tick + 1, winTick: first.tick + 200 };
    const delta = (offset: number, events: StreamMessage["events"]): StreamMessage => ({
      tick: first.tick + offset, ants: structuredClone(first.ants), full: null, events,
    });
    const full = (offset: number, progress: typeof lead | typeof changed | undefined): StreamMessage => {
      const m = structuredClone(first);
      m.tick += offset;
      if (progress) m.full!.territoryWin = progress;
      else delete m.full!.territoryWin;
      return m;
    };
    const stream = [full(0, lead), delta(1, [{ kind: "territoryWin", progress: changed }]),
      delta(2, []), delta(3, [{ kind: "territoryWin", progress: null }]), full(4, lead), full(5, undefined)];
    const expected = [lead, changed, changed, undefined, lead, undefined];
    const boards: NonNullable<Playback["latestBoard"]>[] = [];
    try {
      for (let i = 0; i < stream.length; i++) {
        const reply = await worker.decode(raw(stream[i]!));
        expect(reply.prepared).not.toBeNull();
        live.pushPrepared(reply.prepared!, i * 100);
        expect(live.latestBoard!.territoryWin).toEqual(expected[i]);
        boards.push(live.latestBoard!);
      }
      // Previously displayed countdowns remain immutable after both clearing routes.
      expect(boards[0]!.territoryWin).toEqual(lead);
      expect(boards[1]!.territoryWin).toEqual(changed);
      expect(boards[2]!.territoryWin).toBe(boards[1]!.territoryWin);
      expect(boards[4]!.territoryWin).toEqual(lead);
    } finally { worker.close(); }
  });

  it("cancellation during inflate cannot mutate the next connection's preparation", async () => {
    let release!: (m: StreamMessage) => void;
    const processor = new IntakeProcessor(async () => new Promise<StreamMessage>((done) => { release = done; }));
    await processor.handle({ kind: "reset", generation: 1 });
    const stale = processor.handle({ kind: "decode", generation: 1, id: 1, data: "stale" });
    await until(() => !!release);
    await processor.handle({ kind: "reset", generation: 2 });
    release(messages[0]!);
    expect(await stale).toBeNull();
    const delta = processor.handle({ kind: "decode", generation: 2, id: 2, data: "new delta without full" });
    await new Promise((done) => setImmediate(done));
    release(messages[1]!);
    const reply = await delta;
    expect(reply?.kind).toBe("tick");
    if (reply?.kind === "tick") expect(reply.prepared).toBeNull();
  });

  it("keeps exact trail decay/deposit semantics against an independent prior-grid calculation", () => {
    const prep = new TickPreparation();
    let previous = new Float32Array(0), previousTick = 0;
    for (const m of messages.slice(0, 8)) {
      const result = prep.prepare(structuredClone(m))!;
      const expected = new Float32Array(result.trails.length);
      if (previous.length) for (let i = 0; i < expected.length; i++) expected[i] = previous[i]! * TRAIL_DECAY_PER_TICK ** (m.tick - previousTick);
      const tw = messages[0]!.full!.setup.mapW * TRAIL_RES;
      for (let i = 0; i < m.ants.count; i++) {
        const x = Math.floor(m.ants.x[i]! * TRAIL_RES / 256), y = Math.floor(m.ants.y[i]! * TRAIL_RES / 256);
        const at = (y * tw + x) * 2 + m.ants.colony[i]!;
        expected[at] = Math.min(1, expected[at]! + TRAIL_DEPOSIT);
      }
      deepStrictEqual(result.trails, expected);
      previous = expected;
      previousTick = m.tick;
    }
  });

  it("reports decode errors instead of fabricating a tick, then accepts a valid snapshot", async () => {
    const worker = new WorkerIntake(createWorker);
    try {
      await expect(worker.decode("invalid-base64!")).rejects.toThrow();
      expect((await worker.decode(raw(messages[0]!))).prepared?.kind).toBe("full");
    } finally { worker.close(); }
  });

  it("propagates worker load errors with their actual cause and requests recovery once", async () => {
    let failures = 0, terminated = false;
    const port: IntakeWorker = { postMessage() {}, terminate() { terminated = true; }, onmessage: null, onerror: null };
    const worker = new WorkerIntake(() => port, () => { failures++; });
    const pending = worker.decode("held");
    const rejected = expect(pending).rejects.toThrow("module load refused");
    port.onerror?.({ message: "module load refused" } as ErrorEvent);
    await rejected;
    expect(failures).toBe(1);
    expect(terminated).toBe(true);
  });

  it.each(["construction", "reset post", "decode post"])("reports %s startup failure and closes a broken port without posting another reset", async (failure) => {
    const recovery = vi.fn(), terminate = vi.fn();
    const port: IntakeWorker = { onmessage: null, onerror: null, terminate,
      postMessage(request) { if (failure === `${request.kind} post`) throw new Error("port refused"); } };
    const intake = new WorkerIntake(() => { if (failure === "construction") throw new Error("construction refused"); return port; }, recovery);
    await expect(intake.decode("first full")).rejects.toThrow("refused");
    expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.any(Error), true);
    expect(terminate).toHaveBeenCalledTimes(failure === "construction" ? 0 : 1);
    expect(port.onmessage).toBeNull();
    expect(port.onerror).toBeNull();
    intake.close();
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("bounds silent startup at 3 seconds, ignores late replies, and cancels timers on close", async () => {
    vi.useFakeTimers();
    const recovery = vi.fn(), terminate = vi.fn();
    const requests: IntakeRequest[] = [];
    const port: IntakeWorker = { onmessage: null, onerror: null, terminate, postMessage: (request) => { requests.push(request); } };
    const intake = new WorkerIntake(() => port, recovery);
    try {
      const pending = intake.decode("held"), late = port.onmessage!;
      const rejected = expect(pending).rejects.toThrow("startup timed out");
      await vi.advanceTimersByTimeAsync(2999);
      expect(recovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.any(Error), true);
      expect(terminate).toHaveBeenCalledTimes(1);
      const request = requests.find((r) => r.kind === "decode")!;
      if (request.kind !== "decode") throw new Error("missing decode request");
      late({ data: { kind: "tick", generation: request.generation, id: request.id, m: messages[0]!, prepared: null, workerMs: 0 } } as MessageEvent<IntakeReply>);
      intake.close();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { intake.close(); vi.useRealTimers(); }
  });

  it("a valid error reply confirms readiness, retaining the established 15 second timeout across reset", async () => {
    vi.useFakeTimers();
    const recovery = vi.fn();
    let request: IntakeRequest | undefined;
    const port: IntakeWorker = { onmessage: null, onerror: null, terminate() {}, postMessage: (r) => { request = r; } };
    const intake = new WorkerIntake(() => port, recovery);
    try {
      const invalid = intake.decode("malformed");
      const rejected = expect(invalid).rejects.toThrow("bad payload");
      if (request?.kind !== "decode") throw new Error("missing decode request");
      port.onmessage!({ data: { kind: "error", generation: request.generation, id: request.id, message: "bad payload" } } as MessageEvent<IntakeReply>);
      await rejected;
      expect(recovery).not.toHaveBeenCalled();
      intake.reset();
      const held = intake.decode("next"), timeout = expect(held).rejects.toThrow("decode timed out");
      await vi.advanceTimersByTimeAsync(3000);
      expect(recovery).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(12_000);
      await timeout;
      expect(recovery).toHaveBeenCalledExactlyOnceWith(expect.any(Error), false);
    } finally { intake.close(); vi.useRealTimers(); }
  });

  it.each(["reset", "close"] as const)("%s cancels silent startup without requesting recovery", async (operation) => {
    vi.useFakeTimers();
    const recovery = vi.fn();
    const port: IntakeWorker = { onmessage: null, onerror: null, terminate() {}, postMessage() {} };
    const intake = new WorkerIntake(() => port, recovery);
    try {
      const pending = intake.decode("held"), rejected = expect(pending).rejects.toThrow("superseded");
      intake[operation]();
      await rejected;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(recovery).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { intake.close(); vi.useRealTimers(); }
  });

  it("the transfer list owns only ants and the output trail, never retained state grids", () => {
    const prep = new TickPreparation(), m = structuredClone(messages[0]!);
    const prepared = prep.prepare(m)!;
    const reply: IntakeReply = { kind: "tick", generation: 1, id: 1, m, prepared, workerMs: 1 };
    const transfers = intakeTransfers(reply);
    expect(transfers).toContain(m.ants.id.buffer);
    expect(transfers).toContain(prepared.trails.buffer);
    expect(transfers).not.toContain(m.full!.territory.buffer);
    const copied = structuredClone(reply, { transfer: transfers });
    expect(m.ants.id.byteLength).toBe(0);
    expect(copied.m.ants.count).toBeGreaterThan(0);
    expect(prep.prepare(structuredClone(messages[1]!))).not.toBeNull();
  });
});

describe("the production worker feed retains bounded catch-up", () => {
  function feed(now: () => number = () => 0) {
    const sources: Source[] = [], states: LinkState[] = [];
    const intake = new WorkerIntake(createWorker);
    const live = openPreparedFeed("/live/current", now, state => states.push(state), { intake, source: () => { const s = new Source(); sources.push(s); return s; } });
    return { live, intake, sources, states };
  }

  it("keeps the prepared live board drawn across overflow reopen and refill without Connecting", async () => {
    let now = 0;
    const { live, sources, states } = feed(() => now);
    const playback = new Playback({ live: true }), frame = new Frame();
    const panel = { hidden: false }, waiting = new Waiting(panel);
    const first = structuredClone(messages[0]!);
    first.full!.match = 42;
    first.full!.result = null;
    const tick = (offset: number, full = false): StreamMessage => ({
      ...structuredClone(first), tick: first.tick + offset, full: full ? structuredClone(first.full) : null, events: [],
    });
    const draw = () => {
      for (const arrival of live.take()) {
        expect(arrival.kind).toBe("prepared");
        if (arrival.kind === "prepared") playback.pushPrepared(arrival.prepared, arrival.at);
      }
      const drew = playback.sample(now, frame);
      waiting.frame(drew);
      return drew;
    };
    const deliver = async (m: StreamMessage) => {
      const size = live.inbox.size;
      sources.at(-1)!.emit(m);
      await until(() => live.inbox.size > size || sources.at(-1)!.readyState === 2);
    };
    try {
      sources[0]!.onopen?.(new Event("open"));
      await deliver(first); await live.first;
      expect(draw()).toBe(false);
      for (let offset = 1; offset <= 20; offset++) { now = offset * 100; await deliver(tick(offset)); draw(); }
      expect(panel.hidden).toBe(true);
      states.length = 0;
      for (let offset = 21; sources[0]!.readyState !== 2; offset++) { now = offset * 100; await deliver(tick(offset)); }
      expect(live.inbox.size).toBe(0);
      expect(live.inbox.dropped).toBe(INBOX_CAP + 1);
      now = 10_000;
      expect(draw()).toBe(true);
      expect(states).toEqual([]);
      const held = structuredClone(frame);
      await deliver(tick(100, true));
      expect(draw()).toBe(true);
      deepStrictEqual(structuredClone(frame), held);
      for (let offset = 1; offset <= 15; offset++) {
        now = 10_000 + offset * 100;
        await deliver(tick(100 + offset));
        expect(draw()).toBe(true);
        expect(panel.hidden).toBe(true);
        if (offset < 15) deepStrictEqual(structuredClone(frame), held);
      }
      expect(frame.tick).toBe(first.tick + 100);
      expect(frame.renderMs).toBe((first.tick + 100) * 100);
      expect(playback.matches).toBe(1);
    } finally { live.link.close(); }
  }, 20_000);

  it("bounds a paced hidden-tab backlog, suspends, and resumes once from a full snapshot", async () => {
    const { live, sources } = feed();
    try {
      sources[0]!.emit(messages[0]!);
      await live.first;
      expect(live.take()).toHaveLength(1);
      for (let i = 1; i <= 100 && sources[0]!.readyState !== 2; i++) {
        sources[0]!.emit(messages[i]!);
        await until(() => live.inbox.size === i || sources[0]!.readyState === 2);
      }
      expect(live.inbox.size).toBe(0);
      expect(sources).toHaveLength(1);
      expect(sources[0]!.readyState).toBe(2);
      expect(live.take()).toEqual([]);
      expect(sources).toHaveLength(2);
      expect(live.take()).toEqual([]);
      sources[1]!.emit({ ...structuredClone(messages[0]!), tick: messages[0]!.tick + 100 });
      await until(() => live.inbox.size === 1);
      const arrival = live.take()[0]!;
      expect(arrival.kind).toBe("prepared");
      if (arrival.kind === "prepared") expect(arrival.prepared.kind).toBe("full");
    } finally { live.link.close(); }
  }, 20_000);

  it("bounds a raw one-burst backlog before decode, rejecting stale in-flight work", async () => {
    const { live, sources } = feed();
    try {
      sources[0]!.emit(messages[0]!); await live.first; live.take();
      for (let i = 1; i <= 100; i++) sources[0]!.emit(messages[i]!);
      await new Promise((done) => setImmediate(done));
      expect(sources[0]!.readyState).toBe(2);
      expect(live.inbox.size).toBeLessThanOrEqual(INBOX_CAP);
      expect(live.take()).toEqual([]);
      expect(sources).toHaveLength(2);
    } finally { live.link.close(); }
  });

  it("reopens immediately on overflow before the first full finishes, without waiting for a frame", async () => {
    const { live, sources } = feed();
    try {
      for (let i = 0; i <= 100; i++) sources[0]!.emit(messages[i]!);
      expect(sources).toHaveLength(2);
      sources[1]!.emit(messages[0]!);
      await live.first;
      const arrival = live.take()[0]!;
      expect(arrival.kind).toBe("prepared");
      if (arrival.kind === "prepared") expect(arrival.prepared.kind).toBe("full");
    } finally { live.link.close(); }
  }, 20_000);
});
