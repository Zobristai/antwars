import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { Ants } from "../../web/src/ants.ts";
import { Texture, type Particle, type Renderer } from "pixi.js";
import { Waiting } from "../../web/src/waiting.ts";
import { INBOX_CAP } from "../../web/src/inbox.ts";
import type { IntakeReply, IntakeRequest, IntakeWorker } from "../../web/src/intake.ts";
import { FALLBACK_HANDOVER_KEY, FALLBACK_HANDOVER_MS, REPLAY_POSITION_KEY, finishedLobbyReplay, openSource, type SpectatorSource } from "../../web/src/source.ts";
import type { EventSourceLike } from "../../web/src/stream.ts";
import { scale2Packets } from "../../web/capture/scale2-recording.ts";
import { mountResultModal } from "../../web/src/ui/deck/result-modal.ts";
import { dom, type ElementPort } from "./pages/dom.ts";

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
    source: (path) => { expect(path).toBe("/watch/live/12?kills=1"); queueMicrotask(() => es.emit(packets[0]!)); return es; },
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
    expect(source.take(now)).toEqual([]); // The admitted prefix is still decoding.
    expect(sources).toHaveLength(2);
    await vi.waitFor(() => expect(source.feed!.inbox.size).toBe(INBOX_CAP));
    // Only now may a frame drain the accepted work and reopen for a fresh full.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(source.take(now).map(a => a.kind)).toEqual(Array(INBOX_CAP).fill("inline"));
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
    // The rating-record read starts with the recording; its failure leaves the recording's figures. The stored end is
    // asked once playback has its read-ahead, then the scrubber marks' read follows (recording.ts).
    expect(paths).toEqual(["/watch/ratings/2026-10-21T00-00-00-000Z-1", "/replays/2026-10-21T00-00-00-000Z-1", "/matches/2026-10-21T00-00-00-000Z-1", "/replays/2026-10-21T00-00-00-000Z-1"]);
    expect(reject).not.toHaveBeenCalled();
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


/** Real source/worker, with external storage, catalog and transport ports controlled by the test. */
const FINISHED_REPLAY = "2026-11-17T11-19-28-720Z-151356484549026";
function handoverClient(automatic: boolean, finishedSnapshotDelayMs = 0, defaultScreens = false) {
  vi.stubGlobal("Worker", BrowserWorker);
  const { doc, listeners } = documentPort();
  Object.assign(doc, { querySelector: () => null });
  const saved = new Map<string, string>();
  const location = { pathname: "/", hash: "", origin: "http://localhost", reload: vi.fn(), replace: vi.fn() };
  Object.assign(doc.defaultView!, { location, sessionStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } });
  let ended = false;
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    if (path === "/watch/catalog") return Response.json({ matches: ended ? [] : [{ lobbyId: "selected", startedAt: 1, rated: false, delaySeconds: 0 }], lobbies: [] });
    if (path.startsWith("/watch/status/")) return Response.json({ lobbyId: "selected", delaySeconds: 0, playbackFinished: ended });
    if (path === "/watch/recording/selected") return Response.json({ replayId: ended ? FINISHED_REPLAY : null });
    throw new Error(`Unexpected request ${path}`);
  });
  const leaderboard = vi.fn(), replay = vi.fn(), topMatches = vi.fn(() => vi.fn()), reject = vi.fn();
  const open = (extra: Record<string, string> = {}) => openSource(new URLSearchParams({ ...(automatic ? {} : { lobby: "selected" }), ...extra }), { now: () => 0 }, doc, reject, {
    source: path => {
      paths.push(path);
      const es = new Source(), m = structuredClone(messages[0]!);
      m.tick = ended ? 100 : 0;
      m.full!.match = 42;
      m.full!.result = ended ? { tick: m.tick - 1, winner: 1, reason: "time_up", decidedBy: "kills", nextStartMs: null } : null;
      if (ended && finishedSnapshotDelayMs > 0) setTimeout(() => es.emit(encodeMessage(m)), finishedSnapshotDelayMs);
      else queueMicrotask(() => es.emit(encodeMessage(m)));
      return es;
    },
  }, defaultScreens ? undefined : { leaderboard, replay, topMatches });
  return { open, saved, paths, leaderboard, replay, topMatches, location, reject, finish: () => { ended = true; }, cleanup: () => listeners.get("pagehide")?.() };
}

it.each([false, true])("preserves a finishing selected lobby through fallback, consumes it once, then retains normal idle behavior (automatic=%s)", async automatic => {
  const h = handoverClient(automatic);
  try {
    const first = (await h.open())!;
    expect(first.recorded).toBe(false);
    first.prepareFallback(); first.close(); h.finish();
    expect(h.saved.has(FALLBACK_HANDOVER_KEY)).toBe(true);
    const resumed = (await h.open({ board: "2d" }))!;
    expect(resumed).not.toBeNull();
    expect(resumed.recorded).toBe(false);
    expect(resumed.head.full!.result?.winner).toBe(1);
    expect(h.paths).toEqual(["/watch/live/selected?kills=1", "/watch/live/selected?kills=1"]);
    expect(h.saved.has(FALLBACK_HANDOVER_KEY)).toBe(false);
    expect(h.leaderboard).not.toHaveBeenCalled();
    const playback = new Playback({ live: true }), frame = new Frame();
    for (const arrival of resumed.take(0)) {
      if (arrival.kind === "prepared") playback.pushPrepared(arrival.prepared, arrival.at);
      else playback.push(arrival.m, arrival.at);
    }
    expect(playback.sample(5000, frame)).toBe(true);
    expect(frame.board!.result?.winner).toBe(1);
    resumed.close();
    expect(await h.open({ board: "2d" })).toBeNull();
    // A later plain visit to the finished lobby's link opens that match's replay, not the Leaderboard; a later automatic
    // visit, with no live match, shows the top matches.
    if (!automatic) expect(h.replay).toHaveBeenCalledExactlyOnceWith(expect.anything(), FINISHED_REPLAY);
    else expect(h.topMatches).toHaveBeenCalledExactlyOnceWith(expect.anything(), "idle");
    expect(h.leaderboard).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
  } finally { h.cleanup(); }
});

it("waits for an explicit-lobby handover's final snapshot arriving after the normal connection timeout", async () => {
  const h = handoverClient(false, 3000);
  try {
    const first = (await h.open())!;
    first.prepareFallback(); first.close(); h.finish();
    const resumed = await h.open({ board: "2d" });
    expect(resumed).not.toBeNull();
    expect(h.leaderboard).not.toHaveBeenCalled();
    expect(resumed!.head.full!.result?.winner).toBe(1);
    const playback = new Playback({ live: true }), frame = new Frame();
    for (const arrival of resumed!.take(0)) {
      if (arrival.kind === "prepared") playback.pushPrepared(arrival.prepared, arrival.at);
      else playback.push(arrival.m, arrival.at);
    }
    expect(playback.sample(5000, frame)).toBe(true);
    expect(frame.board!.result?.winner).toBe(1);
    const port = dom(), result = mountResultModal(port.doc);
    const dialog = result.dialog as unknown as ElementPort;
    port.body.append(dialog);
    result.update(frame);
    expect(dialog.open).toBe(false);
    // The first terminal frame starts playback; the result follows its normal ending beat.
    expect(playback.sample(10_000, frame)).toBe(true);
    result.update(frame);
    expect(dialog.open).toBe(true);
    expect(dialog.byClass("d1-result-head")[0]!.textContent).toContain("wins");
    result.destroy();
    expect(h.reject).not.toHaveBeenCalled();
    resumed!.close();
  } finally { h.cleanup(); }
});

it.each(["expired", "future", "wrong route", "wrong board", "malformed"])("refuses a %s renderer handover without changing a normal finished-lobby visit", async invalid => {
  const h = handoverClient(false);
  try {
    const first = (await h.open())!;
    first.prepareFallback(); first.close(); h.finish();
    const saved = JSON.parse(h.saved.get(FALLBACK_HANDOVER_KEY)!);
    if (invalid === "expired") saved.at = Date.now() - FALLBACK_HANDOVER_MS - 1;
    if (invalid === "future") saved.at = Date.now() + 60_000;
    if (invalid === "wrong route") saved.route = "/?lobby=another";
    h.saved.set(FALLBACK_HANDOVER_KEY, invalid === "malformed" ? "{" : JSON.stringify(saved));
    expect(await h.open({ board: invalid === "wrong board" ? "3d" : "2d" })).toBeNull();
    expect(h.replay).toHaveBeenCalledExactlyOnceWith(expect.anything(), FINISHED_REPLAY);
    expect(h.leaderboard).not.toHaveBeenCalled();
    expect(h.saved.has(FALLBACK_HANDOVER_KEY)).toBe(false);
  } finally { h.cleanup(); }
});

it("a local match's page plays /watch/live/local without the catalog, saying the match is starting until its first frame", async () => {
  vi.stubGlobal("Worker", BrowserWorker);
  const { doc, listeners } = documentPort();
  const line = { textContent: "Connecting…" };
  Object.assign(doc, { querySelector: (selector: string) => selector === 'meta[name="antwar-local-match"]' ? { getAttribute: () => "true" }
    : selector === ".aw-wait-state" ? line : null });
  const location = { pathname: "/", hash: "", origin: "http://127.0.0.1:8080", reload: vi.fn() };
  Object.assign(doc.defaultView!, { location });
  const request = vi.fn(async (path: string) => { throw new Error(`Unexpected request ${path}`); });
  vi.stubGlobal("fetch", request);
  const es = new Source(), paths: string[] = [], reject = vi.fn();
  // No agent has joined yet: the stream sends nothing past the connection wait.
  setTimeout(() => es.emit(packets[0]!), 2500);
  const opening = openSource(new URLSearchParams(), { now: () => 0 }, doc, reject, { source: path => { paths.push(path); return es; } });
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(line.textContent).toBe("Live match starting");
  const source = (await opening)!;
  try {
    expect(paths).toEqual(["/watch/live/local?kills=1"]);
    expect(source.recorded).toBe(false);
    expect(source.head.full).not.toBeNull();
    expect(source.head.full!.result).toBeNull();
    expect(source.share).toBeNull();
    // The one local match stays on screen: no move to another match.
    source.nextMatch();
    expect(location.reload).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  } finally { source.close(); listeners.get("pagehide")?.(); }
});

it("a finished lobby's link replaces the page with that match's public replay link", async () => {
  const h = handoverClient(false, 0, true);
  try {
    h.finish();
    expect(await h.open()).toBeNull();
    expect(h.location.replace).toHaveBeenCalledExactlyOnceWith(`/?replay=${encodeURIComponent(FINISHED_REPLAY)}`);
    expect(h.location.reload).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
  } finally { h.cleanup(); }
});

it("a finished lobby's link opened on the 2D board keeps the 2D board in its replay link", async () => {
  const h = handoverClient(false, 0, true);
  try {
    // board=2d, chosen by the viewer or set by the 3D board's fallback reload.
    Object.assign(h.location, { search: "?lobby=selected&board=2d" });
    h.finish();
    expect(await h.open({ board: "2d" })).toBeNull();
    expect(h.location.replace).toHaveBeenCalledExactlyOnceWith(`/?replay=${encodeURIComponent(FINISHED_REPLAY)}&board=2d`);
    expect(h.reject).not.toHaveBeenCalled();
  } finally { h.cleanup(); }
});

it("reads a finished lobby's replay id only when the server names a valid one", async () => {
  const answer = (response: Response | Error) => vi.fn(async () => { if (response instanceof Error) throw response; return response; }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  const request = answer(Response.json({ replayId: FINISHED_REPLAY }));
  expect(await finishedLobbyReplay("a b", signal, request)).toBe(FINISHED_REPLAY);
  expect(vi.mocked(request).mock.calls[0]![0]).toBe("/watch/recording/a%20b");
  expect(await finishedLobbyReplay("x", signal, answer(Response.json({ replayId: null })))).toBeNull();
  expect(await finishedLobbyReplay("x", signal, answer(Response.json({ replayId: "../x" })))).toBeNull();
  expect(await finishedLobbyReplay("x", signal, answer(Response.json([])))).toBeNull();
  expect(await finishedLobbyReplay("x", signal, answer(new Response(null, { status: 404 })))).toBeNull();
  expect(await finishedLobbyReplay("x", signal, answer(new Error("offline")))).toBeNull();
});

/** A replay page with its own document over one tab's session storage, the external port a board change keeps. */
function replayTab() {
  const id = "2026-10-18T12-34-56-789Z-1";
  vi.stubGlobal("fetch", async (input: string) => input === `/matches/${id}`
    ? Response.json({ format: "antwar.match", version: 1, id, result: { tick: messages.at(-1)!.tick - 1 } })
    : new Response(new Uint8Array(packMessages(packets))));
  const saved = new Map<string, string>();
  const page = async (params: Record<string, string>) => {
    const { doc, listeners } = documentPort();
    Object.assign(doc.defaultView!, {
      location: { pathname: "/", hash: "", origin: "http://localhost" },
      sessionStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
      },
    });
    const source = (await openSource(new URLSearchParams(params), { now: () => 0 }, doc, vi.fn()))!;
    return { source, leave: () => listeners.get("pagehide")?.() };
  };
  /** Play at a steady clock until the length is known and any seek has landed. The seek replays from the start, so
   * only where it lands is checked, never how long it takes. */
  const settle = async (source: SpectatorSource) => {
    let p = new Playback(), f = new Frame();
    let generation = source.recording!.generation;
    for (let i = 0; i < 2000; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const r = source.recording!;
      if (r.generation !== generation) { generation = r.generation; p = new Playback(); f = new Frame(); }
      for (const a of source.take(0)) p.push(a.m, a.at);
      p.sample(source.now(0), f);
      if (r.duration !== null && !r.seeking && i > 5) break;
    }
    return f;
  };
  return { id, saved, page, settle };
}

it.each([
  ["2D to 3D", "2d", "3d"], ["3D to 2D", "3d", "2d"], ["default 3D to 2D", null, "2d"],
])("a replay reopened on the other board (%s) resumes at the position it had reached", async (_, from, to) => {
  const t = replayTab();
  const first = await t.page({ replay: t.id, ...(from ? { board: from } : {}) });
  await vi.waitFor(() => expect(first.source.recording!.duration).toBe(1900));
  first.source.recording!.seek(1000);
  const before = await t.settle(first.source);
  const reached = first.source.recording!.position;
  expect(reached).toBe(1000);
  first.leave();
  expect(t.saved.has(REPLAY_POSITION_KEY)).toBe(true);
  const second = await t.page({ replay: t.id, board: to });
  try {
    expect(t.saved.has(REPLAY_POSITION_KEY)).toBe(false);
    const after = await t.settle(second.source);
    expect(second.source.recording!.generation).toBe(1);
    expect(second.source.recording!.position).toBe(reached);
    expect(after.tick).toBe(before.tick);
  } finally { second.source.close(); }
});

it.each(["for the same board", "for another replay", "expired", "future", "malformed"])("a position record that is %s leaves a replay at its start", async invalid => {
  const t = replayTab();
  const first = await t.page({ replay: t.id, board: "2d" });
  await vi.waitFor(() => expect(first.source.recording!.duration).toBe(1900));
  first.source.recording!.seek(1000);
  await t.settle(first.source);
  first.leave();
  const record = JSON.parse(t.saved.get(REPLAY_POSITION_KEY)!);
  if (invalid === "for another replay") record.route = "/?replay=another";
  if (invalid === "expired") record.at = Date.now() - FALLBACK_HANDOVER_MS - 1;
  if (invalid === "future") record.at = Date.now() + 60_000;
  t.saved.set(REPLAY_POSITION_KEY, invalid === "malformed" ? "{" : JSON.stringify(record));
  const second = await t.page({ replay: t.id, board: invalid === "for the same board" ? "2d" : "3d" });
  try {
    expect(t.saved.has(REPLAY_POSITION_KEY)).toBe(false);
    await t.settle(second.source);
    expect(second.source.recording!.generation).toBe(0);
    expect(second.source.recording!.position).toBe(0);
  } finally { second.source.close(); }
});

it("leaving while a resumed position is still being reached passes that position on, not the start", async () => {
  const t = replayTab();
  const first = await t.page({ replay: t.id, board: "2d" });
  await vi.waitFor(() => expect(first.source.recording!.duration).toBe(1900));
  first.source.recording!.seek(1000);
  await t.settle(first.source);
  first.leave();
  // The 3D board takes over, starts reaching 1000 ms, and falls back to 2D before it gets there.
  const second = await t.page({ replay: t.id, board: "3d" });
  const r = second.source.recording!;
  for (let i = 0; i < 2000 && r.generation === 0; i++) {
    await new Promise(resolve => setImmediate(resolve));
    second.source.take(0);
  }
  expect(r.generation).toBe(1);
  expect(r.seeking).toBe(true);
  expect(r.position).toBe(0);
  second.leave();
  expect(JSON.parse(t.saved.get(REPLAY_POSITION_KEY)!).positionMs).toBe(1000);
  const third = await t.page({ replay: t.id, board: "2d" });
  try {
    await t.settle(third.source);
    expect(third.source.recording!.position).toBe(1000);
  } finally { third.source.close(); }
});
