import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { Ants } from "../../web/src/ants.ts";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { Waiting } from "../../web/src/waiting.ts";
import { INBOX_CAP } from "../../web/src/inbox.ts";
import type { IntakeReply, IntakeRequest, IntakeWorker } from "../../web/src/intake.ts";
import { openSource } from "../../web/src/source.ts";
import type { EventSourceLike } from "../../web/src/stream.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";

const packets = unpackMessages(packMessages(scale2Packets(20)));
const messages = packets.map(decodeMessage);
const active = new Set<BrowserWorker>();

/** Run the production browser worker entry in a second realm; adapt only the external Worker port. */
class BrowserWorker implements IntakeWorker {
  onmessage: IntakeWorker["onmessage"] = null;
  onerror: IntakeWorker["onerror"] = null;
  private readonly worker: NodeWorker;
  constructor(entry: URL) {
    const resolver = new URL("../../src/ts-resolve.mjs", import.meta.url).href;
    const bootstrap = `import { parentPort } from 'node:worker_threads';
      await import(${JSON.stringify(resolver)});
      globalThis.postMessage = (reply, transfers) => parentPort.postMessage(reply, transfers);
      await import(${JSON.stringify(entry.href)});
      parentPort.on('message', data => globalThis.onmessage({data}));`;
    this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv: [] });
    this.worker.on("message", (data: IntakeReply) => this.onmessage?.({ data } as MessageEvent<IntakeReply>));
    this.worker.on("error", (error) => this.onerror?.({ message: error.message } as ErrorEvent));
    active.add(this);
  }
  postMessage(message: IntakeRequest) { this.worker.postMessage(message); }
  terminate() { active.delete(this); void this.worker.terminate(); }
}
class Source implements EventSourceLike {
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  readyState = 1;
  emit(packet: Uint8Array) { this.onmessage?.({ data: deflateRawSync(packet).toString("base64") } as MessageEvent<string>); }
  close() { this.readyState = 2; }
}
function documentPort() {
  const listeners = new Map<string, () => void>();
  const doc = { title: "", getElementById: () => null, defaultView: {
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  } } as unknown as Document;
  return { doc, listeners };
}
afterEach(() => {
  for (const worker of active) worker.terminate();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("routes the real shared live source through the worker, buffers playback, and closes both ports on pagehide", async () => {
  vi.stubGlobal("Worker", BrowserWorker);
  const { doc, listeners } = documentPort();
  const es = new Source(), reject = vi.fn();
  let now = 0;
  const opening = openSource(new URLSearchParams({ lobby: "12" }), { now: () => now }, doc, reject, {
    source: (path) => { expect(path).toBe("/watch/live/12"); queueMicrotask(() => es.emit(packets[0]!)); return es; },
  });
  const source = (await opening)!;
  const playback = new Playback({ live: !source.recorded }), frame = new Frame();
  expect(source.recorded).toBe(false);
  expect(source.recording).toBeNull();
  expect(active.size).toBe(1);
  es.onopen?.(new Event("open"));
  expect(source.linkState()).toBe("open");
  const ticks: number[] = [];
  try {
    for (let i = 0; i < packets.length; i++) {
      now = i * 100;
      if (i > 0) es.emit(packets[i]!);
      await vi.waitFor(() => expect(source.feed!.inbox.size).toBe(1));
      const arrivals = source.take(now);
      expect(arrivals).toHaveLength(1);
      const arrival = arrivals[0]!;
      expect(arrival.kind).toBe("prepared");
      if (arrival.kind !== "prepared") throw new Error("Live source bypassed worker preparation");
      expect(arrival.prepared.m).toBe(arrival.m);
      expect(arrival.workerMs).toBeGreaterThanOrEqual(0);
      expect(arrival.deliveryMs).toBeGreaterThanOrEqual(0);
      expect(arrival.at).toBe(now);
      ticks.push(arrival.m.tick);
      playback.pushPrepared(arrival.prepared, arrival.at);
      expect(playback.sample(source.now(now), frame)).toBe(i >= 15);
    }
    expect(ticks).toEqual(messages.map((m) => m.tick));
    expect(playback.newestTick).toBe(messages.at(-1)!.tick);
    expect(reject).not.toHaveBeenCalled();
    listeners.get("pagehide")!();
    expect(es.readyState).toBe(2);
    expect(active.size).toBe(0);
  } finally { source.close(); }
}, 10_000);

it.each(["construction", "error event", "silent"])("%s startup failure falls back once and delivers live ticks to the board's actual ant drawing layer", async (failure) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let created = 0, terminated = 0;
  const lateError: { callback: IntakeWorker["onerror"] } = { callback: null };
  vi.stubGlobal("Worker", class implements IntakeWorker {
    onmessage: IntakeWorker["onmessage"] = null;
    onerror: IntakeWorker["onerror"] = null;
    constructor() { created++; if (failure === "construction") throw new Error("module worker refused"); }
    postMessage(request: IntakeRequest) {
      if (request.kind === "decode" && failure === "error event") {
        lateError.callback = this.onerror;
        queueMicrotask(() => this.onerror?.({ message: "module load refused" } as ErrorEvent));
      }
    }
    terminate() { terminated++; }
  });
  const { doc, listeners } = documentPort(), sources: Source[] = [], reject = vi.fn();
  let now = 0;
  if (failure === "silent") vi.useFakeTimers();
  const opening = openSource(new URLSearchParams({ lobby: "test" }), { now: () => now }, doc, reject, {
    source: () => { const es = new Source(); sources.push(es); queueMicrotask(() => es.emit(packets[0]!)); return es; },
  });
  if (failure === "silent") {
    await vi.advanceTimersByTimeAsync(2999);
    expect(created).toBe(1);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
  }
  const source = (await opening)!;
  const playback = new Playback({ live: !source.recorded }), frame = new Frame();
  const panel = { hidden: false }, waiting = new Waiting(panel);
  // Only the external GPU texture bake is substituted, as in compose.test.ts. Real Ants.update
  // builds the board's actual Pixi particle draw list from the decoded and sampled live ticks.
  const ants = new Ants({ generateTexture: () => Texture.WHITE } as unknown as Renderer, 16, 12.5);
  try {
    expect(created).toBe(1);
    expect(terminated).toBe(failure === "construction" ? 0 : 1);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.readyState).toBe(2);
    expect(source.recorded).toBe(false);
    const ticks: number[] = [];
    let firstDrawX: number[] = [];
    for (let i = 0; i < packets.length; i++) {
      now = i * 100;
      if (i > 0) sources[1]!.emit(packets[i]!);
      await vi.waitFor(() => expect(source.feed!.inbox.size).toBe(1));
      for (const arrival of source.take(now)) {
        expect(arrival.kind).toBe("inline");
        ticks.push(arrival.m.tick);
        if (arrival.kind === "prepared") playback.pushPrepared(arrival.prepared, arrival.at);
        else playback.push(arrival.m, arrival.at);
      }
      const drew = playback.sample(source.now(now), frame);
      waiting.frame(drew);
      ants.update(frame);
      expect(drew).toBe(i >= 15);
      expect(panel.hidden).toBe(i >= 15);
      if (i < 15) {
        expect(frame.board).toBeNull();
        expect(ants.antLayer.particleChildren).toHaveLength(0);
      } else {
        expect(frame.board).not.toBeNull();
        expect(frame.count).toBeGreaterThan(0);
        const drawn = ants.antLayer.particleChildren.slice(0, frame.count) as Particle[];
        expect(drawn).toHaveLength(frame.count);
        expect(drawn.some((p) => p.alpha > 0)).toBe(true);
        // Non-biting ants use the sampled position directly; check real draw-list coordinates.
        const ordinary = [...frame.id.subarray(0, frame.count)].findIndex((id) => !frame.engagements.some((e) => e.a === id));
        expect(ordinary).toBeGreaterThanOrEqual(0);
        expect(drawn[ordinary]!.x).toBeCloseTo(frame.x[ordinary]!, 5);
        expect(drawn[ordinary]!.y).toBeCloseTo(frame.y[ordinary]!, 5);
        if (i === 15) firstDrawX = drawn.map((p) => p.x);
        if (i === 19) expect(drawn.some((p, j) => Math.abs(p.x - firstDrawX[j]!) > 0.001)).toBe(true);
      }
    }
    expect(ticks).toEqual(messages.map((m) => m.tick));
    expect(playback.newestTick).toBe(messages.at(-1)!.tick);
    lateError.callback?.({ message: "late old worker error" } as ErrorEvent);
    sources[0]!.emit(packets[0]!); // Abandoned connection cannot reintroduce its full snapshot.
    expect(source.take(now)).toEqual([]);
    // The inline decoder still uses the production bounded admission and full-snapshot resync.
    for (let i = 0; i <= INBOX_CAP; i++) sources[1]!.emit(packets[1]!);
    expect(sources[1]!.readyState).toBe(2);
    expect(source.take(now)).toEqual([]);
    expect(sources).toHaveLength(3);
    await vi.waitFor(() => expect(source.feed!.inbox.size).toBe(1));
    expect(source.take(now).map((a) => a.kind)).toEqual(["inline"]);
    expect(created).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    listeners.get("pagehide")!();
    expect(sources[2]!.readyState).toBe(2);
    lateError.callback?.({ message: "late error after close" } as ErrorEvent);
    expect(sources).toHaveLength(3);
  } finally { source.close(); }
}, 10_000);

it("malformed fallback data is rejected without reopening or retrying the unavailable worker", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let created = 0;
  vi.stubGlobal("Worker", class { constructor() { created++; throw new Error("worker refused"); } });
  const sources: Source[] = [];
  const source = (await openSource(new URLSearchParams({ lobby: "test" }), { now: () => 0 }, documentPort().doc, vi.fn(), {
    source: () => { const es = new Source(); sources.push(es); queueMicrotask(() => es.emit(packets[0]!)); return es; },
  }))!;
  try {
    source.take(0);
    sources[1]!.onmessage!({ data: "invalid-base64!" } as MessageEvent<string>);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(source.take(0)).toEqual([]);
    sources[1]!.emit(packets[1]!);
    await vi.waitFor(() => expect(source.feed!.inbox.size).toBe(1));
    expect(source.take(0).map((a) => [a.kind, a.m.tick])).toEqual([["inline", messages[1]!.tick]]);
    expect(created).toBe(1);
    expect(sources).toHaveLength(2);
  } finally { source.close(); }
});

it("retains legacy recording tick timestamps and direct clock without constructing a worker", async () => {
  vi.stubGlobal("Worker", class { constructor() { throw new Error("Recording used live worker"); } });
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => { paths.push(path); return new Response(new Uint8Array(packMessages(packets))); });
  const reject = vi.fn();
  const source = (await openSource(new URLSearchParams({ recording: "bench" }), { now: () => 999 }, documentPort().doc, reject))!;
  try {
    expect(source.recorded).toBe(true);
    expect(source.feed).toBeNull();
    expect(source.take(750).map(({ kind, m, at }) => [kind, m.tick, at])).toEqual(messages.slice(0, 8).map((m, i) => ["recorded", m.tick, i * 100]));
    expect(source.now(750)).toBe(750);
    expect(source.take(750)).toEqual([]);
    expect(source.lastTick).toBe(messages.at(-1)!.tick);
    expect(paths).toEqual(["recordings/bench.bin"]);
    expect(reject).not.toHaveBeenCalled();
  } finally { source.close(); }
});

it("keeps incremental replay precedence, bounded catch-up and the recording clock, without a live worker", async () => {
  vi.stubGlobal("Worker", class { constructor() { throw new Error("Replay used live worker"); } });
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path.startsWith("/matches/")) return Response.json({ format: "antwar.match", version: 1, id: "2026-10-21T00-00-00-000Z-1", result: { tick: messages.at(-1)!.tick - 1 } });
    return new Response(new Uint8Array(packMessages(packets)));
  });
  const reject = vi.fn();
  const source = (await openSource(new URLSearchParams({ replay: "2026-10-21T00-00-00-000Z-1", recording: "ignored" }), { now: () => 999 }, documentPort().doc, reject))!;
  try {
    await vi.waitFor(() => expect(source.recording!.stats.messages).toBe(20));
    expect(source.recorded).toBe(true);
    expect(source.feed).toBeNull();
    expect(source.take(0).map((a) => a.kind)).toEqual(["recorded"]);
    const arrivals = source.take(10_000);
    expect(arrivals.map(({ m }) => m.tick)).toEqual(messages.slice(1, 3).map((m) => m.tick));
    expect(source.now(10_000)).toBe(250);
    expect(source.now(10_000)).toBe(source.recording!.time);
    // A full read-ahead queue has not observed EOF yet; draining admits the final read.
    await vi.waitFor(() => expect(source.recording!.complete).toBe(true));
    expect(source.lastTick).toBe(messages.at(-1)!.tick);
    // The rating-record read starts with the recording; its failure leaves the recording's figures.
    expect(paths).toEqual(["/watch/ratings/2026-10-21T00-00-00-000Z-1", "/replays/2026-10-21T00-00-00-000Z-1", "/matches/2026-10-21T00-00-00-000Z-1"]);
    expect(reject).not.toHaveBeenCalled();
  } finally { source.close(); }
});

// A replay's opening snapshot: its setup's rated flag and Model Index marker. Its agents join after it, as in a recording.
type Opening = { rated: boolean; modelIndex: boolean; handles: readonly string[] };
const marked: Opening = { rated: true, modelIndex: true, handles: ["antwars/a", "antwars/b"] };
it.each([
  ["the server's phase when its stored record answers", true, { rated: true, modelIndex: false, handles: [] }, ["Harness: rounds 26-30"]],
  ["the recording's own Model Index marker and start when the server cannot answer", false, marked, ["Harness: rounds 1-7", "Possible effort mismatch"]],
  ["a rated recording without the marker whose every seat is an antwars one, as the listing types it", false,
    { rated: true, modelIndex: false, handles: ["antwars/a #1", "antwars/b"] }, ["Harness: rounds 1-7", "Possible effort mismatch"]],
  ["no phase for a rated recording without the marker with any other seat handle", false,
    { rated: true, modelIndex: false, handles: ["antwars/a", "alice/bot"] }, []],
  ["no phase for an unrated recording without the marker", false, { rated: false, modelIndex: false, handles: ["antwars/a", "antwars/b"] }, []],
] as const)("a replay's harness phase: %s", async (_, answered, opening: Opening, expected) => {
  // A replay's start is its id's: a link whose id is not a readable time opens no replay at all.
  const id = "2026-10-26T01-38-33-692Z-1";
  const [first, second, ...rest] = packets.map(decodeMessage);
  const setup = { ...first!.full!.setup, rated: opening.rated, houseIdleTicks: 600, ...(opening.modelIndex ? { modelIndex: true as const } : {}) };
  const joins = opening.handles.map((displayName, agent) =>
    ({ kind: "join" as const, agent, colony: (agent % 2) as 0 | 1, modelLabel: "", identity: { displayName, elo: 1500 } }));
  const replayPackets = [{ ...first!, full: { ...first!.full!, setup, agents: [] } }, { ...second!, events: [...joins, ...second!.events] }, ...rest]
    .map(m => encodePublicMessage(m));
  vi.stubGlobal("fetch", async (path: string) => {
    if (path.startsWith("/watch/ratings/")) return answered
      ? Response.json({ ratings: [], harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } })
      : new Response(null, { status: 404 });
    if (path.startsWith("/matches/")) return Response.json({ format: "antwar.match", version: 1, id, result: { tick: messages.at(-1)!.tick - 1 } });
    return new Response(new Uint8Array(packMessages(replayPackets)));
  });
  const source = (await openSource(new URLSearchParams({ replay: id }), { now: () => 0 }, documentPort().doc, vi.fn()))!;
  try {
    let at = 0;
    await vi.waitFor(() => {
      source.take(at += 1000);
      expect(source.harnessPhase).toEqual(expected);
      // Every seat has joined: the answer is final, not a reading taken before the joins arrived.
      expect(source.recording!.complete).toBe(true);
    });
    expect(source.harnessPhase).toEqual(expected);
  } finally { source.close(); }
});

it("all three renderer paths adopt prepared live arrivals and choose buffering from the resolved source", () => {
  const page = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
  const relief = readFileSync(new URL("../../web/src/board3d/main3d.ts", import.meta.url), "utf8");
  for (const [source, routes] of [[page, 2], [relief, 1]] as const) {
    expect(source.match(/live: !input.recorded/g)).toHaveLength(routes);
    expect(source.match(/input.take\(realMs\)/g)).toHaveLength(routes);
    expect(source.match(/playback.pushPrepared\(arrival.prepared, arrival.at\)/g)).toHaveLength(routes);
    expect(source.match(/else playback.push\(arrival.m, arrival.at\)/g)).toHaveLength(routes);
    expect(source.match(/input.now\(realMs\)/g)).toHaveLength(routes);
  }
});

it.each([false, true])("explicit replay source preserves route authorization and supports seek/speed (private=%s)", async privateReplay => {
  const id = "2026-10-18T12-34-56-789Z-1";
  const path = privateReplay ? `/watch/replays/lobby-test/${id}` : `/replays/${id}`;
  const calls: { path: string; options: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
    calls.push({ path: input, options });
    if (input === `/matches/${id}`) return Response.json({ format: "antwar.match", version: 1, id, result: { tick: messages.at(-1)!.tick - 1 } });
    expect(input).toBe(path);
    return new Response(new Uint8Array(packMessages(packets)));
  });
  const { doc } = documentPort();
  Object.assign(doc.defaultView!, { location: { hash: "#invite=private-token" } });
  const source = (await openSource(new URLSearchParams({ replay: id, ...(privateReplay ? { lobby: "lobby-test" } : {}) }), { now: () => 0 }, doc, vi.fn()))!;
  try {
    const r = source.recording!;
    await vi.waitFor(() => expect(r.duration).toBe(1900));
    expect(source.recorded).toBe(true);
    expect(source.feed).toBeNull();
    r.setRate(2);
    source.take(0); source.take(100);
    expect(source.now(100)).toBe(200);
    r.seek(1000);
    const p = new Playback(), f = new Frame();
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setImmediate(resolve));
      for (const a of source.take(i * 16)) {
        expect(a.kind).toBe("recorded");
        p.push(a.m, a.at);
      }
      p.sample(source.now(i * 16), f);
      if (!r.seeking) break;
    }
    expect(r.seeking).toBe(false);
    expect(f.tick).toBe(messages[10]!.tick);
    for (const call of calls.filter(c => c.path === path)) {
      if (privateReplay) {
        expect(new Headers(call.options?.headers).get("x-antwar-invite")).toBe("private-token");
        expect(call.options).toMatchObject({ redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer" });
      }
    }
    expect(calls.filter(c => c.path === `/matches/${id}`)).toHaveLength(privateReplay ? 0 : 1);
    // An invite marks the match private: nothing to share.
    expect(source.share).toBeNull();
  } finally { source.close(); }
});

it("a public replay shares its own replay link; a lobby's recording shares none, even without an invite", async () => {
  const id = "2026-10-18T12-34-56-789Z-1";
  vi.stubGlobal("fetch", async (input: string) => input === `/matches/${id}`
    ? Response.json({ format: "antwar.match", version: 1, id, result: { tick: messages.at(-1)!.tick - 1 } })
    : new Response(new Uint8Array(packMessages(packets))));
  for (const [params, share] of [
    [{ replay: id }, `https://antwars.example/?replay=${encodeURIComponent(id)}`],
    [{ replay: id, lobby: "lobby-test" }, null],
  ] as const) {
    const { doc } = documentPort();
    Object.assign(doc.defaultView!, { location: { hash: "", origin: "https://antwars.example" } });
    const source = (await openSource(new URLSearchParams(params), { now: () => 0 }, doc, vi.fn()))!;
    try { expect(source.share).toBe(share); } finally { source.close(); }
  }
});
