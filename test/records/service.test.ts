import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { createGcsInputStore, markerName, runningBuildName } from "../../src/records/input-store.ts";
import { encodeInput, type RecordInput } from "../../src/records/inputs.ts";
import { createRecordService, MAX_FAILURES, publicReplyLines, RECORD_TIMEOUT_MS, type RecordServiceDeps } from "../../src/records/service.ts";
import { STORED_ENTRY_BYTES, storedCall } from "../../src/mcp/replies.ts";
import { CLOSING_STUB_RESERVE_BYTES, replyLine, SEAT_RECORD_BUDGET_BYTES, stubLine, textLine } from "../../src/replays/recording.ts";
import { parseSummary } from "../../src/replays/history-summary-worker.ts";
import type { ReplayGet } from "../../src/replays/access.ts";
import { historyBytes, REPLIES_NOT_RETAINED, unavailableRecord, type CallLine, type HistoryInput, type MatchRecord } from "../../src/replays/history.ts";
import { createGcsRecordReplayStore } from "../../src/records/replay-store.ts";
import { createGcsRecordStore } from "../../src/records/record-store.ts";
import { openPrivateMedia, privateMediaName, sealPrivateMedia } from "../../src/replays/private-media.ts";
import { createGcsReplayStore } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { headerLine, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";
import { playable } from "../playable.ts";

const ID = "2026-10-21T10-00-00-000Z-243";
const LATER = "2026-10-21T10-05-00-000Z-244";
const CODE = "a".repeat(40);
const ENDED = Date.parse("2026-10-21T10:01:00.250Z");
const KEY = new Uint8Array(32).fill(7);
const INPUTS = "example-record-inputs";
const REPLAYS = "example-replays";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length > 0) await cleanup.pop()!(); });

/** A small real match: seat agent ids are private and must not reach the record. */
function match(id = ID) {
  const config = playable({ ...rulesConfig("redesign"), matchTicks: 4, commandFloorTicks: 100, startAnts: 16 });
  let state = createMatch(6006, config);
  const recorder = new SpectatorRecorder(state);
  const messages = [encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const logLines = [headerLine(state.seed, config)];
  while (state.result === null) {
    const inputs: SimInput[] = state.tick === 0 ? [0, 1].map(index => ({ type: "join", agentId: `seat-private-${index}`, modelLabel: `model-V${index + 1}` }))
      : state.tick < 3 ? [{ type: "order", agentId: "seat-private-0", order: { kind: "hold" }, intent: "defend" }] : [];
    if (inputs.length) logLines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    messages.push(encodePublicMessage({ ...recorder.record(out), full: null }));
    state = out.state;
  }
  return { id, codeVersion: CODE, endedAt: ENDED, lobbyId: null, logLines, binary: gzipSync(packMessages(messages)) } satisfies RecordInput;
}
const fakeInput = (id = ID, extra: Partial<RecordInput> = {}): RecordInput =>
  ({ id, codeVersion: CODE, endedAt: ENDED, lobbyId: null, logLines: ["{}"], binary: new Uint8Array([1, 2, 3]), ...extra });

/** Generation-conditioned in-memory GCS behind the real request shapes, with injectable faults. */
async function fakeGcs() {
  const objects = new Map<string, Uint8Array>();
  const faults: ((method: string, bucket: string, name: string) => number | undefined)[] = [];
  let creates = 0, nextGeneration = 0;
  const generations = new Map<string, { body: Uint8Array; value: string }>();
  const generation = (key: string) => {
    const body = objects.get(key);
    if (body === undefined) return undefined;
    if (generations.get(key)?.body !== body) generations.set(key, { body, value: String(++nextGeneration) });
    return generations.get(key)!.value;
  };
  const server: Server = createServer((req, res) => {
    const [, bucket, name] = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(new URL(req.url!, "http://x").pathname)!;
    const body = objects.get(`${decodeURIComponent(bucket!)}/${decodeURIComponent(name!)}`);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-length", String(body.byteLength)); res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const get: ReplayGet = (url, options, response) => httpGet(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, response);
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "fake-token" });
    const method = init!.method ?? "GET";
    const [, upload, bucketPart, namePart] = /^\/(upload\/)?storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname)!;
    const bucket = decodeURIComponent(bucketPart!);
    const name = upload ? url.searchParams.get("name")! : decodeURIComponent(namePart ?? "");
    const status = faults.map(f => f(method, bucket, name)).find(s => s !== undefined);
    if (status !== undefined) return new Response(null, { status });
    if (upload) {
      const expected = url.searchParams.get("ifGenerationMatch");
      const bytes = new Uint8Array(await new Response(init!.body).arrayBuffer());
      const current = generation(`${bucket}/${name}`);
      if (expected !== (current ?? "0")) return new Response(null, { status: 412 });
      objects.set(`${bucket}/${name}`, bytes);
      creates += 1;
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") return new Response(null, { status: objects.delete(`${bucket}/${name}`) ? 204 : 404 });
    if (namePart !== undefined) {
      const key = `${bucket}/${name}`;
      const current = generation(key);
      if (current === undefined) return new Response(null, { status: 404 });
      if (url.searchParams.get("alt") === "media") {
        if (url.searchParams.get("generation") !== current) return new Response(null, { status: 404 });
        return new Response(Buffer.from(objects.get(key)!));
      }
      return Response.json({ generation: current });
    }
    const items = [...objects.keys()].filter(k => k.startsWith(`${bucket}/`)).map(k => ({ name: k.slice(bucket.length + 1) }));
    return Response.json({ items });
  };
  const names = (bucket: string) => [...objects.keys()].filter(k => k.startsWith(`${bucket}/`)).map(k => k.slice(bucket.length + 1)).sort();
  const read = (bucket: string, name: string) => objects.get(`${bucket}/${name}`);
  const record = (name: string) => JSON.parse(new TextDecoder().decode(read(REPLAYS, name))) as MatchRecord;
  const put = (input: RecordInput) => objects.set(`${INPUTS}/${input.id}.input`, encodeInput(input));
  return { objects, faults, request, get, names, read, record, put, creates: () => creates };
}

type Gcs = Awaited<ReturnType<typeof fakeGcs>>;
function service(gcs: Gcs, extra: Partial<RecordServiceDeps> = {}) {
  const logs: string[] = [];
  const deps: RecordServiceDeps = {
    inputs: createGcsInputStore(INPUTS, gcs.request, gcs.get), records: createGcsRecordStore(REPLAYS, KEY, gcs.request),
    codeVersion: CODE, log: line => logs.push(line), ...extra,
  };
  return { svc: createRecordService(deps), logs };
}
const okBuild = (status = "complete") => vi.fn(async (input: HistoryInput) =>
  new TextEncoder().encode(JSON.stringify({ ...unavailableRecord(input.id, "log ticks do not match binary"), status, source: status === "complete" ? "match-log" : "unavailable", unavailable: status === "complete" ? [] : ["log ticks do not match binary"] }) + "\n"));

describe("record service with the real history worker", () => {
  it("saves a complete record with the observed end time, passes the 1800000 ms limit, then deletes the input", async () => {
    const gcs = await fakeGcs();
    gcs.put(match());
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { svc, logs } = service(gcs);
    await svc.sweep();
    expect(timers.mock.calls.some(([, delay]) => delay === RECORD_TIMEOUT_MS)).toBe(true);
    expect(RECORD_TIMEOUT_MS).toBe(1_800_000);
    const record = gcs.record(`${ID}.json`);
    expect(record.status).toBe("complete");
    expect(record.endedAt).toBe("2026-10-21T10:01:00.250Z");
    expect(record.simulationEndedAt).not.toBe(record.endedAt);
    const text = new TextDecoder().decode(gcs.read(REPLAYS, `${ID}.json`));
    expect(text).not.toContain("seat-private");
    // Released after the match, a public record carries the seed and server controls its log was replayed with.
    expect(record.rerun).toEqual({ seed: 6006, stops: [], abandonments: [], idle: [], houseActive: [] });
    expect(record.setup).not.toHaveProperty("seed");
    expect(gcs.names(INPUTS)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("names no private agent id anywhere in a public record's replies, and seals a private record's replies as recorded", async () => {
    // Agent ids as replies carry them: each line's own, a join reply's, an event's, within a text and as a key, and a
    // parent agent's in the arguments; the seat order follows the log's joins (seat-private-0 first).
    const replyLines = [
      '{"type":"reply","agentId":"seat-private-1","tick":null,"tool":"join","receivedAt":1,"answeredAt":2,"arguments":{"parentAgentId":"seat-private-7"},"reply":{"agentId":"seat-private-1","queued":true}}',
      '{"type":"reply","agentId":"seat-private-0","tick":1,"tool":"observe","receivedAt":3,"answeredAt":4,"reply":{"view":{"events":[{"type":"mark_laid","agentId":"seat-private-1"}]},"seat-private-0":"This session already plays agent seat-private-0."}}',
      '{"type":"stub","agentId":"seat-private-0","tick":2,"tool":"order","receivedAt":5,"answeredAt":6,"code":"call_rate","omitted":0}',
    ];
    for (const lobbyId of [null, "lobby-9"]) {
      const gcs = await fakeGcs();
      gcs.put({ ...match(), lobbyId, replyLines });
      const { svc, logs } = service(gcs);
      await svc.sweep();
      expect(logs).toEqual([]);
      if (lobbyId !== null) {
        const identity = { lobbyId, replayId: ID, kind: "match-record" } as const;
        const record = JSON.parse(new TextDecoder().decode(openPrivateMedia(identity, gcs.read(REPLAYS, privateMediaName(identity))!, KEY))) as { replies: unknown[] };
        expect(record.replies).toEqual(replyLines.map(line => JSON.parse(line)));
        // A sealed private record is unchanged; it carries no rerun and no seed.
        expect(record).not.toHaveProperty("rerun");
        expect(JSON.stringify(record)).not.toContain("\"seed\"");
        continue;
      }
      const text = new TextDecoder().decode(gcs.read(REPLAYS, `${ID}.json`));
      expect(text).not.toContain("seat-private");
      const record = JSON.parse(text) as MatchRecord & { replies: unknown[] };
      expect(record.seats).toHaveLength(2);
      expect(record.replies).toEqual([
        { type: "reply", seat: 1, tick: null, tool: "join", receivedAt: 1, answeredAt: 2, arguments: { parentAgentId: "[agent unseated 1]" },
          reply: { agentId: "[agent seat 1]", queued: true } },
        { type: "reply", seat: 0, tick: 1, tool: "observe", receivedAt: 3, answeredAt: 4,
          reply: { view: { events: [{ type: "mark_laid", agentId: "[agent seat 1]" }] }, "[agent seat 0]": "This session already plays agent [agent seat 0]." } },
        { type: "stub", seat: 0, tick: 2, tool: "order", receivedAt: 5, answeredAt: 6, code: "call_rate", omitted: 0 },
      ]);
      expect(gcs.names(INPUTS)).toEqual([]);
    }
  }, 30_000);

  it("logs a log/replay mismatch each time and saves it unavailable with that reason after three builds", async () => {
    const gcs = await fakeGcs();
    const input = match();
    gcs.put({ ...input, logLines: [input.logLines[0]!, input.logLines[1]!.replace("seat-private-1", "seat-private-9")] });
    const { svc, logs } = service(gcs);
    for (let i = 0; i < 3; i++) await svc.sweep();
    const record = gcs.record(`${ID}.json`);
    expect(record.status).toBe("unavailable");
    // A record whose log fails verification carries no rerun: its absence is not "no stops".
    expect(record).not.toHaveProperty("rerun");
    expect(record.unavailable).toHaveLength(1);
    expect(record.endedAt).toBe("2026-10-21T10:01:00.250Z");
    expect(logs.filter(l => l.includes("build failed"))).toHaveLength(3);
    for (const line of logs.filter(l => !l.endsWith("counted"))) expect(line).toContain(record.unavailable[0]!);
    expect(gcs.names(INPUTS)).toEqual([1, 2, 3].map(n => markerName(ID, n, CODE)).concat(`${ID}.input`).sort());
  }, 30_000);
});

describe("routing and version", () => {
  it("seals a private-lobby record and never writes public, and holds it without an archive", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { lobbyId: "lobby-7" }));
    const unrouted = service(gcs, { records: createGcsRecordStore(REPLAYS, undefined, gcs.request), build: okBuild() });
    await unrouted.svc.sweep(); await unrouted.svc.sweep();
    expect(unrouted.logs).toEqual([`antwar record ${ID} input kept, no record written: private archive is not configured`]);
    expect(gcs.names(REPLAYS)).toEqual([]);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);

    await service(gcs, { build: okBuild() }).svc.sweep();
    expect(gcs.names(REPLAYS)).toEqual([privateMediaName({ lobbyId: "lobby-7", replayId: ID, kind: "match-record" })]);
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it("keeps an undecodable input, logs it once, and writes nothing", async () => {
    const gcs = await fakeGcs();
    gcs.objects.set(`${INPUTS}/${ID}.input`, new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]));
    const build = okBuild();
    const { svc, logs } = service(gcs, { build });
    await svc.sweep(); await svc.sweep();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("record input is missing fields");
    expect(build).not.toHaveBeenCalled();
    expect(gcs.names(REPLAYS)).toEqual([]);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
  });

  it("retains inputs from a different code version when verification fails", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { codeVersion: "b".repeat(40) }));
    const build = okBuild("unavailable");
    const { svc } = service(gcs, { build });
    for (let i = 0; i < 4; i++) await svc.sweep();
    expect(build).toHaveBeenCalledTimes(3);
    expect(gcs.record(`${ID}.json`).status).toBe("unavailable");
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
  });
});

describe("failures, retention and recovery", () => {
  it("counts real worker deadline expiry with the unchanged timeout reason and three-failure budget", async () => {
    const gcs = await fakeGcs();
    gcs.put(match());
    const build = vi.fn((input: HistoryInput, timeoutMs: number) => {
      // Advance only the worker's timer, synchronously before it can return a
      // result. Restore real time before the service resumes storage I/O.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = historyBytes(input, timeoutMs);
        vi.advanceTimersByTime(timeoutMs - 1);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(vi.getTimerCount()).toBe(0);
        return pending;
      } finally { vi.useRealTimers(); }
    });
    const { svc, logs } = service(gcs, { build });
    for (let n = 1; n <= 3; n++) {
      await svc.sweep();
      expect(gcs.names(INPUTS)).toEqual([1, 2, 3].slice(0, n)
        .map(i => markerName(ID, i, CODE)).concat(`${ID}.input`).sort());
      expect(logs).toContain(`antwar record ${ID} build failed: match record worker timed out`);
      expect(logs).toContain(`antwar record ${ID} failure ${n} of 3 counted`);
      if (n < 3) expect(gcs.names(REPLAYS)).toEqual([]);
    }
    expect(build.mock.calls.map(([, limit]) => limit)).toEqual([1_800_000, 1_800_000, 1_800_000]);
    expect(gcs.record(`${ID}.json`)).toMatchObject({ status: "unavailable", unavailable: ["match record worker timed out"] });
    await svc.sweep();
    await service(gcs, { build }).svc.sweep();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("counts a timeout or rejection only once it completes, retains the input, and saves the latest reason after three", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    const reasons = ["match record worker timed out", "Worker terminated due to reaching memory limit: JS heap out of memory", "log ticks do not match binary"];
    const build = vi.fn(async (_input: HistoryInput, _timeoutMs: number): Promise<Uint8Array> => { throw new Error(reasons[build.mock.calls.length - 1]); });
    const { svc, logs } = service(gcs, { build });
    for (let i = 0; i < 2; i++) {
      await svc.sweep();
      expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
      expect(gcs.names(REPLAYS)).toEqual([]);
    }
    expect(gcs.names(INPUTS)).toEqual([markerName(ID, 1, CODE), markerName(ID, 2, CODE), `${ID}.input`]);
    await svc.sweep();
    expect(build.mock.calls.map(c => c[1])).toEqual([1_800_000, 1_800_000, 1_800_000]);
    expect(gcs.record(`${ID}.json`).unavailable).toEqual([reasons[2]]);
    expect(logs.slice(0, 6)).toEqual(reasons.flatMap((reason, i) =>
      [`antwar record ${ID} build failed: ${reason}`, `antwar record ${ID} failure ${i + 1} of 3 counted`]));
    expect(gcs.names(INPUTS)).toEqual([1, 2, 3].map(n => markerName(ID, n, CODE)).concat(`${ID}.input`).sort());
    await svc.sweep();
    await service(gcs, { build }).svc.sweep();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("retries an interrupted build with nothing written, and recovers counted failures after a restart", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    for (let i = 0; i < 3; i++) {
      const hung = vi.fn(() => new Promise<Uint8Array>(() => {}));
      void service(gcs, { build: hung }).svc.sweep();
      await vi.waitFor(() => expect(hung).toHaveBeenCalled());
    }
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
    expect(gcs.names(REPLAYS)).toEqual([]);

    const failing = service(gcs, { build: vi.fn(async () => { throw new Error("boom"); }) });
    await failing.svc.sweep(); await failing.svc.sweep();
    const build = okBuild();
    const restarted = service(gcs, { build });
    await restarted.svc.sweep();
    expect(build).toHaveBeenCalledTimes(1);
    expect(gcs.record(`${ID}.json`).status).toBe("complete");
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it("saves the stored reason without rebuilding when three failures were counted before a crash", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    for (const n of [1, 2, 3]) gcs.objects.set(`${INPUTS}/${markerName(ID, n, CODE)}`, new TextEncoder().encode(JSON.stringify({ reason: `reason ${n}` })));
    const build = okBuild();
    await service(gcs, { build }).svc.sweep();
    expect(build).not.toHaveBeenCalled();
    expect(gcs.record(`${ID}.json`).unavailable).toEqual(["reason 3"]);
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
  });

  it("rebuilds retained unavailable records at a new service version with the real verifier, then cleans all marker generations", async () => {
    const gcs = await fakeGcs();
    gcs.put(match());
    const failed = service(gcs, { build: okBuild("unavailable") });
    for (let i = 0; i < 3; i++) await failed.svc.sweep();
    const original = gcs.read(REPLAYS, `${ID}.json`);
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
    await service(gcs, { build: okBuild() }).svc.sweep(); // Same version stays capped across restarts.
    expect(gcs.read(REPLAYS, `${ID}.json`)).toBe(original);
    await service(gcs, { codeVersion: "b".repeat(40) }).svc.sweep();
    expect(gcs.record(`${ID}.json`)).toMatchObject({ status: "complete", source: "match-log" });
    expect(gcs.names(INPUTS)).toEqual([]);
  });


  it("retains a private failed input and replaces its sealed unavailable record at a later version", async () => {
    const gcs = await fakeGcs();
    gcs.put({ ...match(), lobbyId: "lobby-7" });
    const failed = service(gcs, { build: okBuild("unavailable") });
    for (let i = 0; i < 3; i++) await failed.svc.sweep();
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
    const sealedName = privateMediaName({ lobbyId: "lobby-7", replayId: ID, kind: "match-record" });
    const original = gcs.read(REPLAYS, sealedName);
    await service(gcs, { codeVersion: "b".repeat(40) }).svc.sweep();
    expect(gcs.read(REPLAYS, sealedName)).not.toEqual(original);
    expect(gcs.names(REPLAYS)).toEqual([sealedName]);
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it("keeps input on a failed replacement or an unreadable existing record, without rebuilding saved bytes", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    gcs.objects.set(`${REPLAYS}/${ID}.json`, new TextEncoder().encode(JSON.stringify(unavailableRecord(ID, "old"))));
    let replacements = 0;
    // Create first collides; the generation-conditioned replacement then fails.
    gcs.faults.push((method, bucket) => bucket === REPLAYS && method === "POST" && ++replacements === 2 ? 403 : undefined);
    const build = okBuild(), { svc } = service(gcs, { build });
    await svc.sweep();
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
    expect(gcs.record(`${ID}.json`).status).toBe("unavailable");
    await svc.sweep();
    expect(build).toHaveBeenCalledTimes(1);
    expect(gcs.names(INPUTS)).toEqual([]);

    gcs.put(fakeInput());
    gcs.objects.set(`${REPLAYS}/${ID}.json`, new TextEncoder().encode('{"status":"complete"}'));
    await service(gcs, { build: okBuild() }).svc.sweep();
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
  });

  it("logs the real build error even when its failure marker cannot be written, and counts nothing", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    gcs.faults.push((method, bucket, name) => bucket === INPUTS && method !== "GET" && name === markerName(ID, 1, CODE) ? 503 : undefined);
    const { svc, logs } = service(gcs, { build: vi.fn(async () => { throw new Error("log ticks do not match binary"); }) });
    await svc.sweep();
    expect(logs[0]).toBe(`antwar record ${ID} build failed: log ticks do not match binary`);
    expect(logs[1]).toMatch(new RegExp(`^antwar record ${ID} attempt failed: .*503`));
    expect(logs).toHaveLength(2);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
    expect(gcs.names(REPLAYS)).toEqual([]);
  });

  it("retries a failed save and a failed cleanup from memory without rebuilding", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    let saveFaults = 1, deleteFaults = 1;
    gcs.faults.push((method, bucket, name) => bucket === REPLAYS && name.endsWith(".json") && saveFaults-- > 0 ? 503 : undefined);
    gcs.faults.push((method, bucket, name) => method === "DELETE" && name.endsWith(".input") && deleteFaults-- > 0 ? 503 : undefined);
    const build = okBuild();
    const { svc, logs } = service(gcs, { build });
    await svc.sweep();
    expect(gcs.names(REPLAYS)).toEqual([]);
    expect(logs).toEqual([`antwar record ${ID} attempt failed: replay create failed: HTTP 503`]);
    await svc.sweep();
    expect(gcs.names(REPLAYS)).toEqual([`${ID}.json`]);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
    await svc.sweep();
    expect(build).toHaveBeenCalledTimes(1);
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it("treats an existing record as saved without overwriting it, and removes orphan markers", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    const existing = await okBuild()({ id: ID } as HistoryInput);
    gcs.objects.set(`${REPLAYS}/${ID}.json`, existing);
    gcs.objects.set(`${INPUTS}/${LATER}.failed-${CODE}-1`, new TextEncoder().encode("{\"reason\":\"x\"}"));
    gcs.objects.set(`${INPUTS}/${LATER}.bin`, new Uint8Array([1]));
    const { svc, logs } = service(gcs, { build: okBuild() });
    await svc.sweep();
    expect(gcs.read(REPLAYS, `${ID}.json`)).toEqual(existing);
    expect(gcs.names(INPUTS)).toEqual([`${LATER}.bin`]);
    expect(logs).toEqual([]);
  });

  it("tries each input once per sweep, oldest first, so one failing match never blocks another", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(LATER)); gcs.put(fakeInput(ID));
    const build = vi.fn(async (input: HistoryInput) => {
      if (input.id === ID) throw new Error("boom");
      return okBuild()(input);
    });
    await service(gcs, { build }).svc.sweep();
    expect(build.mock.calls.map(c => c[0].id)).toEqual([ID, LATER]);
    expect(gcs.names(REPLAYS)).toEqual([`${LATER}.json`]);
    expect(gcs.names(INPUTS)).toEqual([markerName(ID, 1, CODE), `${ID}.input`]);
  });

  it("converges concurrent services on one create-only unavailable record with the real reason", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    const builds = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); throw new Error("log ticks do not match binary"); });
    const a = service(gcs, { build: builds }), b = service(gcs, { build: builds });
    for (let i = 0; i < 3; i++) await Promise.all([a.svc.sweep(), b.svc.sweep()]);
    expect(gcs.record(`${ID}.json`).unavailable).toEqual(["log ticks do not match binary"]);
    expect(builds.mock.calls.length).toBeLessThanOrEqual(3 + 1);
    // At most three markers are committed even when a fourth build was already in flight.
    expect(gcs.creates()).toBe(3 + 1);
    expect(gcs.names(INPUTS)).toEqual([1, 2, 3].map(n => markerName(ID, n, CODE)).concat(`${ID}.input`).sort());
  });
});

describe("call replies in the built record", () => {
  const replyLines = [
    '{"type":"text","digest":"' + "d".repeat(64) + '","kind":"rules","text":"Rules \\\\ \\"quoted\\""}',
    '{"type":"reply","agentId":"seat-a","tick":null,"tool":"join","receivedAt":1,"answeredAt":2,"arguments":{"key":"[redacted key]"},"reply":{"queued":true}}',
    '{"type":"stub","agentId":"seat-a","tick":0,"tool":"order","receivedAt":3,"answeredAt":4,"code":"call_rate","omitted":2}',
  ];

  // The public form of replyLines: an agent with no seat in the record is named by a marker.
  const publicLines = [
    replyLines[0]!,
    '{"type":"reply","seat":null,"agent":"[agent unseated 1]","tick":null,"tool":"join","receivedAt":1,"answeredAt":2,"arguments":{"key":"[redacted key]"},"reply":{"queued":true}}',
    '{"type":"stub","seat":null,"agent":"[agent unseated 1]","tick":0,"tool":"order","receivedAt":3,"answeredAt":4,"code":"call_rate","omitted":2}',
  ];

  it.each([null, "lobby-7"])("carries every call's reply line in a built record, public or sealed private, then deletes the input (lobby: %s)", async lobbyId => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    const { svc, logs } = service(gcs, { build: okBuild() });
    await svc.sweep();
    expect(logs).toEqual([]);
    const name = lobbyId === null ? `${ID}.json` : privateMediaName({ lobbyId, replayId: ID, kind: "match-record" });
    expect(gcs.names(REPLAYS)).toEqual([name]);
    const stored = gcs.read(REPLAYS, name)!;
    const body = lobbyId === null ? stored : openPrivateMedia({ lobbyId, replayId: ID, kind: "match-record" }, stored, KEY);
    if (lobbyId !== null) expect(Buffer.from(stored).includes(Buffer.from('"replies"'))).toBe(false);
    const text = new TextDecoder().decode(body);
    // Each line written in order as the record's last field, the record before it as built: a sealed private record's
    // lines verbatim, a public record's with no private agent id.
    const lines = lobbyId === null ? publicLines : replyLines;
    expect(text.endsWith(`,"replies":[${lines.join(",")}]}\n`)).toBe(true);
    expect(text.includes("seat-a")).toBe(lobbyId !== null);
    const record = JSON.parse(text) as MatchRecord & { replies: unknown[] };
    expect(record).toMatchObject({ status: "complete", source: "match-log" });
    expect(record.replies).toEqual(lines.map(line => JSON.parse(line)));
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it.each([null, "lobby-7"])("deletes a reply-bearing input when the complete record already stored carries its replies (lobby: %s)", async lobbyId => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    await service(gcs, { build: okBuild() }).svc.sweep();
    const name = lobbyId === null ? `${ID}.json` : privateMediaName({ lobbyId, replayId: ID, kind: "match-record" });
    const stored = gcs.read(REPLAYS, name)!;
    // The same input again, as after a cleanup lost to a crash: another process finds that record already present.
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    const timing: string[] = [];
    const { svc, logs } = service(gcs, { build: okBuild(), timing: line => timing.push(line) });
    await svc.sweep();
    expect(timing.some(line => line.includes("complete record already present"))).toBe(true);
    expect(logs).toEqual([]);
    expect(gcs.read(REPLAYS, name)).toBe(stored);
    expect(gcs.names(INPUTS)).toEqual([]);
  });

  it.each([null, "lobby-7"])("keeps and reports a reply-bearing input when the complete record already stored carries other replies (lobby: %s)", async lobbyId => {
    const gcs = await fakeGcs();
    // The stored record carries only the first two of this input's three reply lines.
    gcs.put(fakeInput(ID, { lobbyId, replyLines: replyLines.slice(0, 2) }));
    await service(gcs, { build: okBuild() }).svc.sweep();
    const name = lobbyId === null ? `${ID}.json` : privateMediaName({ lobbyId, replayId: ID, kind: "match-record" });
    const stored = gcs.read(REPLAYS, name)!;
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    const { svc, logs } = service(gcs, { build: okBuild() });
    await svc.sweep(); await svc.sweep();
    expect(logs).toEqual([`antwar record ${ID} input kept, no record written: a complete record is already stored without this input's call replies`]);
    // The stored record is never logged: no reply text reaches the log.
    expect(logs.join("\n").includes("queued")).toBe(false);
    expect(gcs.read(REPLAYS, name)).toBe(stored);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
  });

  it.each([null, "lobby-7"])("keeps and reports a reply-bearing input when the complete record already stored was saved before agent seats were recorded (lobby: %s)", async lobbyId => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    await service(gcs, { build: okBuild() }).svc.sweep();
    const identity = { lobbyId: lobbyId ?? "", replayId: ID, kind: "match-record" as const };
    const name = lobbyId === null ? `${ID}.json` : privateMediaName(identity);
    const current = JSON.parse(new TextDecoder().decode(lobbyId === null ? gcs.read(REPLAYS, name)! : openPrivateMedia(identity, gcs.read(REPLAYS, name)!, KEY))) as MatchRecord;
    // The same replies as an older save wrote them: no codeVersion or agentSeats, the old reason kept (its earlier
    // text, first among the record's reasons). Its input is still pending, as after a crash between that save and its
    // cleanup.
    const { codeVersion: _code, agentSeats: _seats, ...rest } = current;
    const oldReason = "Calls refused before simulation (adapter validation, rate limits, post-match calls) are not recorded.";
    const plaintext = new TextEncoder().encode(JSON.stringify({ ...rest, unavailable: [oldReason, ...rest.unavailable] }) + "\n");
    const old = lobbyId === null ? plaintext : sealPrivateMedia(identity, plaintext, KEY);
    gcs.objects.set(`${REPLAYS}/${name}`, old);
    gcs.put(fakeInput(ID, { lobbyId, replyLines }));
    const { svc, logs } = service(gcs, { build: okBuild() });
    await svc.sweep(); await svc.sweep();
    expect(logs).toEqual([`antwar record ${ID} input kept, no record written: a complete record is already stored without this input's call replies`]);
    expect(gcs.read(REPLAYS, name)).toBe(old);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
  });

  it("keeps and reports a reply-bearing input when a complete record already stored carries no replies", async () => {
    const gcs = await fakeGcs();
    // A complete record stored before, without replies (as a save that wrote it before replies were recorded would).
    const existing = new TextEncoder().encode(JSON.stringify({ ...unavailableRecord(ID, "x"), status: "complete", source: "match-log", unavailable: [] }) + "\n");
    gcs.objects.set(`${REPLAYS}/${ID}.json`, existing);
    gcs.put(fakeInput(ID, { replyLines }));
    const { svc, logs } = service(gcs, { build: okBuild() });
    await svc.sweep(); await svc.sweep();
    expect(logs).toEqual([`antwar record ${ID} input kept, no record written: a complete record is already stored without this input's call replies`]);
    expect(gcs.read(REPLAYS, `${ID}.json`)).toBe(existing);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
    // An input carrying no replies loses nothing to the record already stored, and is deleted as before.
    const other = await fakeGcs();
    other.objects.set(`${REPLAYS}/${ID}.json`, existing);
    other.put(fakeInput(ID));
    await service(other, { build: okBuild() }).svc.sweep();
    expect(other.names(INPUTS)).toEqual([]);
  });

  it("marks a record's replies as not retained when its input carries none", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID));
    await service(gcs, { build: okBuild() }).svc.sweep();
    const record = gcs.record(`${ID}.json`);
    expect(record.replies).toBeNull();
    expect(record.unavailable).toEqual([REPLIES_NOT_RETAINED]);
  });
});

describe("the downloadable match record carries each seat's call replies", () => {
  // Credential values as an agent sends and receives them; the record holds only their markers.
  const SECRET_KEY = "join-key-fixture-value";
  const RECONNECT = "reconnect_secret_91d7c4";
  const RULES = "Rules served whole: \\ and \"quotes\" kept.";
  const join = storedCall("join", { key: SECRET_KEY, seat: 0 },
    { content: [], structuredContent: { agentId: "seat-private-0", reconnectToken: RECONNECT, briefing: "Join briefing." } });
  const rules = storedCall("rules", undefined, { content: [], structuredContent: { rules: RULES, version: 27 } });
  const order = storedCall("order", { order: { kind: "hold" }, intent: "defend" }, { content: [], structuredContent: { accepted: true } });
  const rulesDigest = rules.texts[0]!.digest;
  // As the recording hands them on: each served text once, before the first entry naming it.
  const replyLines = [
    ...join.texts.map(textLine),
    replyLine("seat-private-0", null, { tool: "join", receivedAt: 10, answeredAt: 11, ...join.call }),
    ...rules.texts.map(textLine),
    replyLine("seat-private-0", 0, { tool: "rules", receivedAt: 12, answeredAt: 13, ...rules.call }),
    replyLine("seat-private-0", 1, { tool: "order", receivedAt: 14, answeredAt: 15, ...order.call }),
    stubLine("seat-private-1", 2, { tool: "order", receivedAt: 16, answeredAt: 17, code: "call_rate" }, 0),
    // A second rules call names the same text and adds no second copy.
    replyLine("seat-private-1", 2, { tool: "rules", receivedAt: 18, answeredAt: 19, ...rules.call }),
  ];
  const calls = (record: MatchRecord) => record.replies!.filter((line): line is Exclude<CallLine, { type: "text" }> => line.type !== "text");

  it("lists every seat's calls in call order in a public record, with times, tool, arguments and reply, the rules text once, and the build commit", async () => {
    const gcs = await fakeGcs();
    gcs.put({ ...match(), replyLines });
    const { svc, logs } = service(gcs);
    await svc.sweep();
    expect(logs).toEqual([]);
    const text = new TextDecoder().decode(gcs.read(REPLAYS, `${ID}.json`));
    const record = JSON.parse(text) as MatchRecord;
    expect(record).toMatchObject({ status: "complete", source: "match-log", codeVersion: CODE });
    expect(record.unavailable).toEqual([]);
    expect(text).not.toContain("refused before simulation");
    expect(record.agentSeats).toBeUndefined();
    expect(calls(record).map(({ type, ...rest }) => ({ type, seat: (rest as { seat: unknown }).seat, tick: rest.tick, tool: rest.tool,
      receivedAt: rest.receivedAt, answeredAt: rest.answeredAt }))).toEqual([
      { type: "reply", seat: 0, tick: null, tool: "join", receivedAt: 10, answeredAt: 11 },
      { type: "reply", seat: 0, tick: 0, tool: "rules", receivedAt: 12, answeredAt: 13 },
      { type: "reply", seat: 0, tick: 1, tool: "order", receivedAt: 14, answeredAt: 15 },
      { type: "stub", seat: 1, tick: 2, tool: "order", receivedAt: 16, answeredAt: 17 },
      { type: "reply", seat: 1, tick: 2, tool: "rules", receivedAt: 18, answeredAt: 19 },
    ]);
    expect(calls(record)[2]).toMatchObject({ arguments: { order: { kind: "hold" }, intent: "defend" }, reply: { accepted: true } });
    expect(calls(record)[3]).toMatchObject({ code: "call_rate", omitted: 0 });
    // The rules text is carried once, whole; each rules entry names it by digest.
    const texts = record.replies!.filter(line => line.type === "text");
    expect(texts.filter(line => line.kind === "rules")).toEqual([{ type: "text", digest: rulesDigest, kind: "rules", text: RULES }]);
    for (const index of [1, 4]) expect(calls(record)[index]).toMatchObject({ textRefs: { rules: rulesDigest }, reply: { version: 27 } });
    expect(text.split(JSON.stringify(RULES))).toHaveLength(2);
    expect(gcs.names(INPUTS)).toEqual([]);
  }, 30_000);

  it("holds no credential value in any public record field, only the redaction markers", async () => {
    const gcs = await fakeGcs();
    gcs.put({ ...match(), replyLines });
    await service(gcs).svc.sweep();
    const text = new TextDecoder().decode(gcs.read(REPLAYS, `${ID}.json`));
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(RECONNECT);
    expect(text).not.toContain("seat-private");
    expect(calls(JSON.parse(text) as MatchRecord)[0]).toMatchObject({ arguments: { key: "[redacted key]" },
      reply: { agentId: "[agent seat 0]", reconnectToken: "[redacted reconnectToken]" } });
  }, 30_000);

  it("seals a private record's replies, with each agent id's seat, and writes nothing public", async () => {
    const gcs = await fakeGcs();
    const lobbyId = "lobby-11";
    gcs.put({ ...match(), lobbyId, replyLines });
    const { svc, logs } = service(gcs);
    await svc.sweep();
    expect(logs).toEqual([]);
    const identity = { lobbyId, replayId: ID, kind: "match-record" } as const;
    expect(gcs.names(REPLAYS)).toEqual([privateMediaName(identity)]);
    const sealed = Buffer.from(gcs.read(REPLAYS, privateMediaName(identity))!);
    for (const plain of ["replies", RULES, "seat-private", "[redacted key]"]) expect(sealed.includes(Buffer.from(plain))).toBe(false);
    const record = JSON.parse(new TextDecoder().decode(openPrivateMedia(identity, sealed, KEY))) as MatchRecord;
    expect(record).toMatchObject({ status: "complete", codeVersion: CODE, unavailable: [] });
    expect(record.replies).toEqual(replyLines.map(line => JSON.parse(line)));
    expect(record.agentSeats).toEqual({ "seat-private-0": 0, "seat-private-1": 1 });
    expect(gcs.names(INPUTS)).toEqual([]);
  }, 30_000);

  it("marks a record built from an input without replies as not retaining them, rather than as empty", async () => {
    const gcs = await fakeGcs();
    gcs.put(match());
    await service(gcs).svc.sweep();
    const record = gcs.record(`${ID}.json`);
    expect(record).toMatchObject({ status: "complete", codeVersion: CODE, replies: null });
    expect(record.unavailable).toEqual([REPLIES_NOT_RETAINED]);
  }, 30_000);

  it("still loads a record stored before replies were carried, and one carrying them, for the history listing", async () => {
    // As records were stored before replies were carried: no replies, no build commit, the old wording.
    const older = { ...unavailableRecord(ID, ""), source: "match-log", status: "complete",
      unavailable: ["Calls refused before simulation (adapter validation, rate limits, post-match calls) are not recorded."] };
    const olderSummary = parseSummary(ID, new TextEncoder().encode(JSON.stringify(older) + "\n"));
    expect(olderSummary).toMatchObject({ id: ID, status: "complete", unavailable: older.unavailable });
    const gcs = await fakeGcs();
    gcs.put({ ...match(), replyLines });
    await service(gcs).svc.sweep();
    expect(parseSummary(ID, gcs.read(REPLAYS, `${ID}.json`)!)).toMatchObject({ id: ID, status: "complete", unavailable: [] });
  }, 30_000);
});

describe("a public record's reply lines as published", () => {
  const AGENT = "11111111-1111-4111-8111-111111111111";
  const logLines = [JSON.stringify({ tick: 0, inputs: [{ type: "join", agentId: AGENT }] })];
  const body = new TextEncoder().encode(JSON.stringify({ seats: [{ commands: [{ tick: 0, type: "join" }] }] }));
  const reply = (n: number, args: unknown) =>
    JSON.stringify({ type: "reply", agentId: AGENT, tick: 1, tool: "order", receivedAt: n, answeredAt: n, arguments: args, reply: { accepted: true } });

  it("replaces any value under an agent id field, at any depth and of any type, with its agent's marker or one of its own", () => {
    const line = JSON.stringify({ type: "reply", agentId: AGENT, tick: 1, tool: "order", receivedAt: 1, answeredAt: 2,
      arguments: { a: { b: [{ agentId: { id: "secret-x" } }] }, parentAgentId: 42, deep: { agentId: [1, "secret-y"] } },
      reply: { owner: { agentId: AGENT }, other: { nested: { agentId: "secret-z" } } } });
    const [out] = publicReplyLines([line], logLines, body);
    expect(out).not.toMatch(/secret|11111111/);
    expect(JSON.parse(out!)).toEqual({ type: "reply", seat: 0, tick: 1, tool: "order", receivedAt: 1, answeredAt: 2,
      arguments: { a: { b: [{ agentId: "[agent unseated 1]" }] }, parentAgentId: "[agent unseated 2]", deep: { agentId: "[agent unseated 3]" } },
      reply: { owner: { agentId: "[agent seat 0]" }, other: { nested: { agentId: "[agent unseated 4]" } } } });
  });

  it("fits an entry its longer markers grow past the entry cap again, naming what it drops", () => {
    const line = reply(1, { l: Array(500).fill({ agentId: 0 }) });
    expect(Buffer.byteLength(line)).toBeLessThan(STORED_ENTRY_BYTES);
    const out = JSON.parse(publicReplyLines([line], logLines, body)[0]!) as Record<string, unknown>;
    expect(out.trimmed).toEqual(["arguments.l"]);
    expect(Buffer.byteLength(JSON.stringify({ arguments: out.arguments, reply: out.reply }))).toBeLessThanOrEqual(STORED_ENTRY_BYTES);
  });

  it("keeps a seat's published lines within its budget when short ids become longer markers near the limit, counting the rest exactly", () => {
    // Each call's arguments hold 200 short values under agentId: a recorded line of about 2.9 KB, published at about
    // 6.6 KB, still within the entry cap. Recorded, the seat fills its budget as the recording allows, reserve kept.
    const one = reply(0, { l: Array(200).fill({ agentId: 0 }) });
    const calls = Math.floor((SEAT_RECORD_BUDGET_BYTES - CLOSING_STUB_RESERVE_BYTES) / (Buffer.byteLength(one) + 1));
    const lines = Array.from({ length: calls }, (_, n) => reply(n % 10, { l: Array(200).fill({ agentId: 0 }) }));
    expect(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(SEAT_RECORD_BUDGET_BYTES - CLOSING_STUB_RESERVE_BYTES);
    const published = publicReplyLines(lines, logLines, body);
    expect(published.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(SEAT_RECORD_BUDGET_BYTES);
    const final = JSON.parse(published.at(-1)!) as { type: string; seat: number; omitted: number };
    expect(final).toMatchObject({ type: "stub", seat: 0, tool: "order", code: null });
    const entries = published.slice(0, -1);
    expect(entries.every(line => line.includes('"agentId":"[agent unseated 1]"') && !line.includes('"agentId":0'))).toBe(true);
    // Every call accounted for: each published entry, the final stub's own call and its omitted count.
    expect(entries.length + 1 + final.omitted).toBe(calls);
    expect(entries.length).toBeLessThan(calls);
  }, 60_000);
});

describe("reply-bearing input past its failed builds", () => {
  const replyLines = ['{"type":"reply","agentId":"seat-a","tick":0,"tool":"order","receivedAt":1,"answeredAt":2,"reply":{"accepted":true}}'];

  it("the MAX_FAILURES path: saves the unavailable record without replies and keeps the reply-bearing input", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { replyLines }));
    const { svc, logs } = service(gcs, { build: okBuild("unavailable") });
    for (let i = 0; i < 4; i++) await svc.sweep();
    expect(logs.filter(line => line.includes(`saved unavailable after ${MAX_FAILURES} failed builds`))).toHaveLength(1);
    expect(gcs.record(`${ID}.json`).status).toBe("unavailable");
    expect(Object.hasOwn(gcs.record(`${ID}.json`), "replies")).toBe(false);
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
  });

  it("keeps and reports the input when its unavailable save finds a complete record already stored", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID, { replyLines }));
    // Three failures already counted for this build, so the next attempt saves unavailable; meanwhile another builder
    // stored a complete record without these replies.
    for (const n of [1, 2, 3]) gcs.objects.set(`${INPUTS}/${markerName(ID, n, CODE)}`, new TextEncoder().encode(JSON.stringify({ reason: "log ticks do not match binary" })));
    const existing = new TextEncoder().encode(JSON.stringify({ ...unavailableRecord(ID, "x"), status: "complete", source: "match-log", unavailable: [] }) + "\n");
    gcs.objects.set(`${REPLAYS}/${ID}.json`, existing);
    const build = okBuild("unavailable");
    const { svc, logs } = service(gcs, { build });
    await svc.sweep();
    expect(build).not.toHaveBeenCalled();
    expect(gcs.read(REPLAYS, `${ID}.json`)).toBe(existing);
    expect(logs.at(-1)).toBe(`antwar record ${ID} input kept, no record written: a complete record is already stored without this input's call replies`);
    expect(gcs.names(INPUTS)).toContain(`${ID}.input`);
  });
});

describe("game-server handoff to the record service", () => {
  /** The real game-server writer over the same request-shape GCS, with no game-server or service state shared. */
  const handoff = (gcs: Gcs, logs: string[] = []) =>
    createRecordHandoff({ store: createGcsReplayStore(INPUTS, gcs.request), codeVersion: CODE, log: line => logs.push(line), delays: [1] });
  const { codeVersion: _code, ...inputs } = match();

  it("gives a stored match exactly one complete record when the game server restarts while the service is down", async () => {
    const gcs = await fakeGcs();
    let failures = 1;
    gcs.faults.push((method, bucket, name) => method === "POST" && bucket === INPUTS && name === `${ID}.input` && failures-- > 0 ? 503 : undefined);
    const gameLogs: string[] = [];
    handoff(gcs, gameLogs).submit(inputs);
    await vi.waitFor(() => expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]));
    expect(gameLogs).toEqual([`antwar record ${ID} input store failed (attempt 1), retrying in 1 ms: replay create failed: HTTP 503`]);
    // The game server restarts (its handoff and memory are gone) and no record service has run yet.
    expect(gcs.names(REPLAYS)).toEqual([]);

    const first = service(gcs);
    await first.svc.sweep();
    const record = gcs.record(`${ID}.json`);
    expect(record).toMatchObject({ status: "complete", source: "match-log", endedAt: "2026-10-21T10:01:00.250Z" });
    expect(record.seats.flatMap(seat => seat.commands).length).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain("seat-private");
    expect(gcs.names(INPUTS)).toEqual([]);
    const created = gcs.creates();

    await service(gcs).svc.sweep();
    await first.svc.sweep();
    expect(gcs.names(REPLAYS)).toEqual([`${ID}.json`]);
    expect(gcs.creates()).toBe(created);
    expect(first.logs).toEqual([]);
  }, 30_000);

  it("keeps a public-lobby record public and seals a private-lobby record in the private archive only", async () => {
    const gcs = await fakeGcs();
    const game = handoff(gcs);
    game.submit({ ...fakeInput(ID), lobbyId: null });
    game.submit({ ...fakeInput(LATER), lobbyId: "lobby-7" });
    await vi.waitFor(() => expect(gcs.names(INPUTS)).toEqual([`${ID}.input`, `${LATER}.input`]));
    await service(gcs, { build: okBuild() }).svc.sweep();
    expect(gcs.names(REPLAYS)).toEqual([`${ID}.json`, privateMediaName({ lobbyId: "lobby-7", replayId: LATER, kind: "match-record" })].sort());
    expect(gcs.names(REPLAYS).some(name => name.startsWith(LATER))).toBe(false);
    expect(gcs.names(INPUTS)).toEqual([]);
  });
});

describe("record service phase timing sink", () => {
  /** k-th call returns ENDED + k s, so every elapsed value and timestamp is exact. */
  const steppedClock = () => { let k = 0; return () => ENDED + 1000 * ++k; };
  const at = (k: number) => new Date(ENDED + 1000 * k).toISOString();
  const end = "2026-10-21T10:01:00.250Z";
  const line = (text: string, k: number, id = ID) => `antwar record ${id} timing: ${text} at ${at(k)}`;
  const readLine = (input: RecordInput, k: number) =>
    line(`input read ${encodeInput(input).byteLength} B in 1000 ms, ${k}.000 s after actual match end ${end}`, k);
  function timed(gcs: Gcs, extra: Partial<RecordServiceDeps> = {}) {
    const timing: string[] = [];
    return { ...service(gcs, { timing: l => timing.push(l), now: steppedClock(), ...extra }), timing };
  }

  it("reports read, build and created phases after the actual match end, apart from the error log", async () => {
    const gcs = await fakeGcs();
    const input = fakeInput();
    gcs.put(input);
    const { svc, logs, timing } = timed(gcs, { build: okBuild() });
    await svc.sweep();
    expect(timing).toEqual([
      line("input read started", 1),
      readLine(input, 2),
      line(`build started 3.000 s after actual match end ${end}`, 3),
      line("build ended in 1000 ms (complete)", 4),
      line(`record created 5.000 s after actual match end ${end}`, 5),
    ]);
    expect(logs).toEqual([]);
    expect(gcs.names(REPLAYS)).toEqual([`${ID}.json`]);
  });

  it("reports an existing record as already present (412), never as created", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    const existing = await okBuild()({ id: ID } as HistoryInput);
    gcs.objects.set(`${REPLAYS}/${ID}.json`, existing);
    const { svc, logs, timing } = timed(gcs, { build: okBuild() });
    await svc.sweep();
    expect(timing.slice(4)).toEqual([line(`complete record already present 5.000 s after actual match end ${end}`, 5)]);
    expect(timing.some(l => l.includes("record created"))).toBe(false);
    expect(gcs.read(REPLAYS, `${ID}.json`)).toEqual(existing);
    expect(logs).toEqual([]);
  });

  it("verifies an older input version normally, reporting build phases", async () => {
    const gcs = await fakeGcs();
    gcs.put({ ...match(), codeVersion: "b".repeat(40) });
    const { svc, logs, timing } = timed(gcs);
    await svc.sweep();
    expect(gcs.record(`${ID}.json`).status).toBe("complete");
    expect(timing.some(line => line.includes("build ended"))).toBe(true);
    expect(gcs.names(INPUTS)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("reports one save across a failed save and a cleanup-only retry, with one build", async () => {
    const gcs = await fakeGcs();
    const input = fakeInput();
    gcs.put(input);
    let saveFaults = 1, deleteFaults = 1;
    gcs.faults.push((method, bucket, name) => bucket === REPLAYS && name.endsWith(".json") && saveFaults-- > 0 ? 503 : undefined);
    gcs.faults.push((method, bucket, name) => method === "DELETE" && name.endsWith(".input") && deleteFaults-- > 0 ? 503 : undefined);
    const build = okBuild();
    const { svc, logs, timing } = timed(gcs, { build });
    await svc.sweep();
    expect(timing).toEqual([
      line("input read started", 1),
      readLine(input, 2),
      line(`build started 3.000 s after actual match end ${end}`, 3),
      line("build ended in 1000 ms (complete)", 4),
    ]);
    await svc.sweep();
    expect(timing.slice(4)).toEqual([line(`record created 5.000 s after actual match end ${end}`, 5)]);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);
    await svc.sweep();
    expect(timing).toHaveLength(5);
    expect(gcs.names(INPUTS)).toEqual([]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      `antwar record ${ID} attempt failed: replay create failed: HTTP 503`,
      expect.stringContaining(`antwar record ${ID} attempt failed:`),
    ]);
  });

  it("leaves only the read-started line while an input read stalls", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput());
    const real = createGcsInputStore(INPUTS, gcs.request, gcs.get);
    const build = okBuild();
    const { svc, logs, timing } = timed(gcs, { build, inputs: { ...real, get: () => new Promise<Uint8Array | null>(() => {}) } });
    void svc.sweep();
    await vi.waitFor(() => expect(timing).toHaveLength(1));
    await new Promise(r => setTimeout(r, 20));
    expect(timing).toEqual([line("input read started", 1)]);
    expect(build).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

 describe("version-2 GCS recovery wiring", () => {
   it.each([null, "secret-lobby"])("recovers a real checkpoint and record through the actual storage adapters (lobby: %s)", async lobbyId => {
     const gcs = await fakeGcs(), base = match();
     const input = { ...base, lobbyId, publishAfter: ENDED + 60_000, rated: false };
     gcs.put(input);
     const deps = { replays: createGcsRecordReplayStore(REPLAYS, KEY, gcs.request, gcs.get), now: () => ENDED + 180_000 };
     await service(gcs, deps).svc.sweep();
     const names = gcs.names(REPLAYS);
     if (lobbyId === null) {
       expect(names).toEqual([`${ID}.bin`, `${ID}.json`]);
       expect(gcs.read(REPLAYS, `${ID}.bin`)).toEqual(new Uint8Array(base.binary));
       expect(gcs.record(`${ID}.json`).status).toBe("complete");
     } else {
       expect(names).toEqual(["recording", "match-record"].map(kind => privateMediaName({ lobbyId, replayId: ID, kind: kind as "recording" | "match-record" })).sort());
     }
     expect(gcs.names(INPUTS)).toEqual([]);
   });
 });

describe("waiting out the replay delay", () => {
  it("reads a not-yet-due input once, not on every sweep, then reads and publishes it once due", async () => {
    const gcs = await fakeGcs(), base = match();
    const input = { ...base, publishAfter: ENDED + 60_000, rated: false };
    gcs.put(input);
    const real = createGcsInputStore(INPUTS, gcs.request, gcs.get);
    const reads: string[] = [];
    let at = ENDED + 1_000;
    const build = vi.fn(historyBytes);
    const { svc, logs } = service(gcs, {
      inputs: { ...real, get: name => { reads.push(name); return real.get(name); } },
      replays: createGcsRecordReplayStore(REPLAYS, KEY, gcs.request, gcs.get), now: () => at, build,
    });
    for (let pass = 0; pass < 10; pass++) { await svc.sweep(); at += 2_000; }
    at = input.publishAfter - 1;
    await svc.sweep();
    expect(reads).toEqual([`${ID}.input`]);
    expect(build).not.toHaveBeenCalled();
    expect(gcs.names(REPLAYS)).toEqual([]);
    expect(gcs.names(INPUTS)).toEqual([`${ID}.input`]);

    // The game server's normal release is used as soon as the delay has passed, as before.
    gcs.objects.set(`${REPLAYS}/${ID}.bin`, new Uint8Array(base.binary));
    at = input.publishAfter;
    await svc.sweep();
    expect(reads).toEqual([`${ID}.input`, `${ID}.input`]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(gcs.names(REPLAYS)).toEqual([`${ID}.bin`, `${ID}.json`]);
    expect(gcs.record(`${ID}.json`).status).toBe("complete");
    expect(gcs.names(INPUTS)).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("two builds' builders during a deploy overlap", () => {
  const OTHER = "b".repeat(40);
  const declare = (gcs: Gcs, build: string) => gcs.objects.set(`${INPUTS}/${runningBuildName(build)}`, new Uint8Array());
  const undeclare = (gcs: Gcs, build: string) => gcs.objects.delete(`${INPUTS}/${runningBuildName(build)}`);

  it("each builder builds only its own build's input while both are declared running", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID)); gcs.put(fakeInput(LATER, { codeVersion: OTHER }));
    declare(gcs, CODE); declare(gcs, OTHER);
    const buildA = okBuild(), buildB = okBuild();
    const a = service(gcs, { build: buildA }), b = service(gcs, { build: buildB, codeVersion: OTHER });
    await a.svc.sweep();
    expect(buildA.mock.calls.map(c => c[0].id)).toEqual([ID]);
    expect(gcs.names(INPUTS)).toContain(`${LATER}.input`);
    await b.svc.sweep();
    expect(buildB.mock.calls.map(c => c[0].id)).toEqual([LATER]);
    expect(gcs.record(`${ID}.json`).status).toBe("complete");
    expect(gcs.record(`${LATER}.json`).status).toBe("complete");
    expect(gcs.names(INPUTS)).toEqual([runningBuildName(CODE), runningBuildName(OTHER)]);
  });

  it("never builds, counts or saves unavailable the other build's input, reads it once, then builds it when its builder is gone", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID)); gcs.put(fakeInput(LATER, { codeVersion: OTHER }));
    declare(gcs, OTHER);
    const reads: string[] = [];
    const real = createGcsInputStore(INPUTS, gcs.request, gcs.get);
    const inputs = { ...real, get: (name: string) => { reads.push(name); return real.get(name); } };
    const failing = vi.fn(async (input: HistoryInput) => { if (input.id === ID) throw new Error("log ticks do not match binary"); return okBuild()(input); });
    const { svc, logs } = service(gcs, { build: failing, inputs });
    for (let i = 0; i < 5; i++) await svc.sweep();
    // Its own input runs today's three-failure budget; the other build's is untouched.
    expect(failing.mock.calls.map(c => c[0].id)).toEqual([ID, ID, ID]);
    expect(gcs.record(`${ID}.json`).status).toBe("unavailable");
    expect(gcs.read(REPLAYS, `${LATER}.json`)).toBeUndefined();
    expect(gcs.names(INPUTS).filter(n => n.startsWith(LATER))).toEqual([`${LATER}.input`]);
    expect(reads.filter(name => name === `${LATER}.input`)).toHaveLength(1);
    expect(logs.filter(l => l.includes(OTHER))).toEqual([`antwar record inputs of build ${OTHER} deferred: running/${OTHER} declares its own records builder running`]);

    undeclare(gcs, OTHER);
    await svc.sweep();
    expect(failing.mock.calls.map(c => c[0].id)).toEqual([ID, ID, ID, LATER]);
    expect(gcs.record(`${LATER}.json`).status).toBe("complete");
    expect(gcs.names(INPUTS).filter(n => n.startsWith(LATER))).toEqual([]);
    expect(logs.at(-1)).toBe(`antwar record inputs of build ${OTHER} no longer deferred: running/${OTHER} removed`);
  });

  it("builds every input as before with no declaration, and ignores a declaration of its own build", async () => {
    const gcs = await fakeGcs();
    gcs.put(fakeInput(ID)); gcs.put(fakeInput(LATER, { codeVersion: OTHER }));
    declare(gcs, CODE);
    const build = okBuild();
    const { svc, logs } = service(gcs, { build });
    await svc.sweep();
    expect(build.mock.calls.map(c => c[0].id)).toEqual([ID, LATER]);
    expect(gcs.record(`${ID}.json`).status).toBe("complete");
    expect(gcs.record(`${LATER}.json`).status).toBe("complete");
    expect(gcs.names(INPUTS)).toEqual([runningBuildName(CODE)]);
    expect(logs).toEqual([]);
  });
});
