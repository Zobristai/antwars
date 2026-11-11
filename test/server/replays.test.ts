import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { ReplayCreateError, replayStoreFromEnv, type ReplayObject, type ReplayStore } from "../../src/replays/store.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { markerName, type InputStore } from "../../src/records/input-store.ts";
import { createRecordService } from "../../src/records/service.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { replaySourceFromEnv } from "../../src/replays/access.ts";
import { comparisonOptions } from "../../src/server.ts";
import { PUBLIC_CONFIG, RULES_VERSION } from "../../src/sim/config.ts";
import type { MatchRecord } from "../../src/replays/history.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { createOnlyRecords } from "../records/create-only-records.js";
import { ManualClock } from "../live/helpers.js";
import { memorySlot } from "./helpers.ts";

const dirs: string[] = [];
let server: SpectatedServer | null = null;
afterEach(async () => {
  await server?.close(); server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
/**
 * Pins Open Field, which has no match length of its own: a randomly drawn Four Lanes or
 * Wide Plain replaces the short test matchTicks with its own 27,000 or 36,000 ticks (matchConfigForMap).
 */
function onOpenField<C extends { terrain?: object }>(simConfig: C): C {
  return { ...simConfig, terrain: { ...simConfig.terrain!, mapId: "open-field" } };
}
function options() {
  const dataDir = mkdtempSync(join(tmpdir(), "antwar-replays-")); dirs.push(dataDir);
  const publicOptions = comparisonOptions({}, DEFAULT_MCP_CONFIG);
  return { ...publicOptions, port: 0, host: "127.0.0.1", dataDir, simConfig: onOpenField({ ...publicOptions.simConfig!, matchTicks: 2 }) };
}
/**
 * A public slot server, the server that records public matches: it plays each lobby seatLobby fills, in turn,
 * with no agent connections. Its recordings wait out the real playback minimum on the spectator clock, which
 * settled() advances while it waits.
 */
function slotRun() {
  const wiring = memorySlot();
  const clock = new ManualClock();
  const base = options();
  return {
    options: { ...base, simConfig: { ...base.simConfig, queenFounding: PUBLIC_CONFIG.queenFounding }, startPickWindowMs: 5, spectatorClock: clock,
      slot: wiring.slot, accounts: wiring.accounts, watchRegistry: wiring.watchRegistry },
    seatLobbies: async (n: number) => { for (let i = 0; i < n; i += 1) await wiring.seatLobby(); },
    settled: (check: () => void) => vi.waitFor(() => { clock.advance(61_000); check(); }, { timeout: 10_000 }),
  };
}
const live = { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 };
const CODE = "c".repeat(40);

/**
 * The real game-server handoff and the real record service (real history worker), over two separate
 * in-memory create-only buckets: the private inputs the game server writes and the records the service saves.
 * Since commit b599fc5275c3abee62fd028ab02be0ee5513b5a6 match-end inputs carry publishAfter and the service
 * reads the released binary through its replay store, as src/records/main.ts wires it; publish() records each
 * binary the game server releases so that read sees exactly those bytes.
 */
function recordPath() {
  const inputs = new Map<string, Uint8Array>(), saved = new Map<string, ReplayObject>(), logs: string[] = [];
  const released = new Map<string, Uint8Array>();
  const publish = (object: ReplayObject) => { if (object.contentType === "application/octet-stream") released.set(object.name, object.body); };
  const inputBucket: ReplayStore = { create: async object => {
    if (inputs.has(object.name)) throw new ReplayCreateError(412);
    inputs.set(object.name, object.body);
  } };
  const recordBucket: ReplayStore = { create: async object => {
    if (saved.has(object.name)) throw new ReplayCreateError(412);
    saved.set(object.name, object);
  } };
  const serviceInputs: InputStore = {
    list: async () => [...inputs.keys()].sort(),
    get: async name => inputs.get(name) ?? null,
    createMarker: async (match, n, reason, codeVersion) => {
      if (inputs.has(markerName(match, n, codeVersion))) return false;
      inputs.set(markerName(match, n, codeVersion), new TextEncoder().encode(reason));
      return true;
    },
    markerReason: async (match, n, codeVersion) => {
      const body = inputs.get(markerName(match, n, codeVersion));
      return body === undefined ? null : new TextDecoder().decode(body);
    },
    delete: async name => { inputs.delete(name); },
  };
  const handoff = createRecordHandoff({ store: inputBucket, codeVersion: CODE, log: line => logs.push(line), delays: [1] });
  // A released binary always exists here, so the service never takes the checkpoint-recovery create.
  const replays = createRecordReplayStore({ publicStore: { create: async object => { throw new Error(`unexpected recovery create of ${object.name}`); } },
    readPublic: async id => released.get(`${id}.bin`) ?? null });
  const service = createRecordService({ inputs: serviceInputs, replays, records: createOnlyRecords(recordBucket),
    codeVersion: CODE, log: line => logs.push(line) });
  return { inputs, saved, logs, handoff, service, publish };
}

it("wires public slot matches to the fake store and the record service, without any agent connections", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const objects: ReplayObject[] = [], gameJson: ReplayObject[] = [];
  const records = recordPath();
  const run = slotRun();
  server = await startSpectatedServer({ ...run.options, replayStore: { create: async (object) => {
    records.publish(object);
    if (object.contentType === "application/octet-stream") objects.push(object);
    else gameJson.push(object);
  } }, recordHandoff: records.handoff }, live);
  await run.seatLobbies(2);
  await run.settled(() => expect(objects.length).toBeGreaterThanOrEqual(2));
  expect(server.game.match!.state.agents).toHaveLength(0);
  for (const object of objects) {
    expect(object.name).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-\d+\.bin$/);
    const messages = unpackMessages(gunzipSync(object.body)).map(decodeMessage);
    expect(messages.map((m) => m.tick)).toEqual([0, 1, 2]);
    expect(messages[0]!.full!.setup).not.toHaveProperty("seed");
    expect(messages.at(-1)!.events).toContainEqual({ kind: "end", result: expect.objectContaining({ nextStartMs: null }) });
  }
  const metadata = await (await fetch(`http://127.0.0.1:${server.port}/live/replays`)).json() as { replays: { replayId: string }[] };
  for (const object of objects) expect(metadata.replays.some((r) => `${r.replayId}.bin` === object.name)).toBe(true);
  // Each saved binary's inputs reach the record service; the game server never writes a readable record.
  await vi.waitFor(() => expect(records.inputs.size).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
  for (const name of records.inputs.keys()) expect(objects.some(binary => binary.name === name.replace(/\.input$/, ".bin"))).toBe(true);
  await records.service.sweep();
  expect(records.saved.size).toBeGreaterThanOrEqual(2);
  for (const object of records.saved.values()) {
    expect(object.contentType).toBe("application/json");
    const record = JSON.parse(new TextDecoder().decode(object.body));
    expect(record).toMatchObject({ format: "antwar.match", version: 1, source: "match-log", status: "complete", seats: [], rules: { holdBehaviour: "ant115" } });
    expect(record.startedAt).toMatch(/Z$/);
    expect(record.endedAt).toMatch(/Z$/);
    expect(objects.some(binary => binary.name === object.name.replace(/\.json$/, ".bin"))).toBe(true);
  }
  expect(gameJson).toEqual([]);
  expect(records.logs).toEqual([]);
}, 30_000);

it("round-trips the full non-default rules config actually used by a public slot match into JSON", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const gameJson: ReplayObject[] = [];
  const records = recordPath();
  const selected = comparisonOptions({ ANTWAR_RULES: "count-marks", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG);
  // Select a non-default config through the environment parser, but keep the
  // public slot path: held/private comparison runs must remain unrecorded.
  const run = slotRun();
  server = await startSpectatedServer({ ...run.options,
    simConfig: onOpenField({ ...selected.simConfig!, matchTicks: 2, startAnts: 12, commandFloorTicks: 7, queenFounding: PUBLIC_CONFIG.queenFounding }),
    replayStore: { create: async object => { records.publish(object); if (object.contentType === "application/json") gameJson.push(object); } },
    recordHandoff: records.handoff,
  }, live);
  await run.seatLobbies(1);
  await vi.waitFor(() => expect(server!.game.match).not.toBeNull(), { timeout: 5_000 });
  const actualConfig = server.game.match!.state.config;
  expect(actualConfig.rules).toBe("count-marks");
  await run.settled(() => expect(records.inputs.size).toBeGreaterThanOrEqual(1));
  await records.service.sweep();
  expect(gameJson).toEqual([]);
  expect(records.saved.size).toBeGreaterThanOrEqual(1);
  const record = JSON.parse(new TextDecoder().decode([...records.saved.values()][0]!.body)) as MatchRecord;
  expect(record).toMatchObject({ source: "match-log", status: "complete", rules: { version: RULES_VERSION } });
  expect(record.rules!.config).toEqual(JSON.parse(JSON.stringify(actualConfig)));
  expect(record.rules!.config).toMatchObject({ rules: "count-marks", matchTicks: 2, startAnts: 12, commandFloorTicks: 7 });
  expect(record.endedAt).not.toBeNull();
  expect(records.logs).toEqual([]);
}, 30_000);

it("logs a failed store once per match while play and the next lobby's match continue", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const attempts: string[] = [];
  const replayStore: ReplayStore = { create: async (object) => { attempts.push(object.name); throw new Error("fake store down"); } };
  const run = slotRun();
  server = await startSpectatedServer({ ...run.options, replayStore }, live);
  await run.seatLobbies(3);
  await vi.waitFor(() => expect(server!.game.match!.seq).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
  // A new match can start before the previous recording's async gzip completes.
  // Wait for the upload attempts themselves, not only the slot's sequence.
  await run.settled(() => {
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(errors.mock.calls.length).toBe(attempts.length);
  });
  expect(new Set(attempts).size).toBe(attempts.length);
  expect(errors.mock.calls.every(([error]) => String(error).includes("replay upload failed: fake store down"))).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${server.port}/live/replays`)).json()).toEqual({ replays: [] });
});

it("unset bucket lists no recordings or errors and continues ordinary slot play without cloud activity", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi.fn<typeof fetch>(async () => { throw new Error("unexpected cloud activity"); });
  const env = {};
  const run = slotRun();
  server = await startSpectatedServer({ ...run.options, replayStore: replayStoreFromEnv(env, request), replaySource: replaySourceFromEnv(env, request) }, live);
  await run.seatLobbies(2);
  await vi.waitFor(() => expect(server!.game.match!.seq).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
  const response = await fetch(`http://127.0.0.1:${server.port}/live/replays`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ replays: [] });
  expect((await fetch(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`)).status).toBe(404);
  expect(request).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

function raw(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => { httpGet(url, resolve).once("error", reject); });
}
async function bytes(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it("streams unchanged gzip bytes progressively with immutable caching and validates ids before reading", async () => {
  let calls = 0, finish!: () => void;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const first = gzipSync("first"), last = gzipSync("last");
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async (id) => {
    expect(id).toBe("2026-10-18T09-50-00-123Z-1"); calls++;
    return { body: Readable.from((async function* () { yield first; await ready; yield last; })()) };
  } } }, live);
  const id = "2026-10-18T09-50-00-123Z-1", base = `http://127.0.0.1:${server.port}`;
  const response = await raw(`${base}/replays/${id}`);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable, no-transform");
  expect(response.headers.location).toBeUndefined();
  const [start] = await once(response, "data");
  expect(Buffer.from(start as Uint8Array)).toEqual(first);
  response.pause(); finish();
  expect(await bytes(response)).toEqual(last);
  for (const path of ["../other", `${id}/other`, `${id}%2Fother`, `${id}.bin`, "2026-02-30T00-00-00-000Z-1"]) {
    expect((await fetch(`${base}/replays/${path}`)).status).toBe(404);
  }
  expect((await fetch(`${base}/replays/${id}`, { method: "POST" })).status).toBe(405);
  expect(calls).toBe(1);
});

it.each([true, false])("serves gzip=%s from bytes with a split prefix, exact length and no browser decoding error", async (compressed) => {
  const packed = Buffer.from([0x7b, 0x0f, 0x00, 0x00, 42, 21]);
  const stored = compressed ? gzipSync(packed) : packed;
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => ({
    body: Readable.from([Buffer.alloc(0), stored.subarray(0, 1), stored.subarray(1, 2), stored.subarray(2)]),
    contentLength: String(stored.length),
  }) } }, live);
  const url = `http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`;
  const response = await raw(url);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe(compressed ? "gzip" : undefined);
  expect(response.headers["content-length"]).toBe(String(stored.length));
  expect(await bytes(response)).toEqual(stored);
  // Native fetch performs the same HTTP decoding as the browser.
  expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(packed);
});

it.each([Buffer.alloc(0), Buffer.from([0x1f]), Buffer.from([0x1f, 0x00])])("serves a short non-gzip object unchanged as identity: %j", async (stored) => {
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => ({
    body: Readable.from([stored]), contentLength: String(stored.length),
  }) } }, live);
  const response = await raw(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBeUndefined();
  expect(await bytes(response)).toEqual(stored);
});

it.each([false, true])("returns sanitized 503 when reading the magic bytes fails (after one byte=%s)", async (partial) => {
  const body = Readable.from((async function* () {
    if (partial) yield Buffer.from([0x1f]);
    throw new Error("fake-token-and-provider-secret");
  })());
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => ({ body }) } }, live);
  const response = await fetch(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`);
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Replay temporarily unavailable. Please try again." });
  expect(body.destroyed).toBe(true);
});

it("cancels a source still waiting for its second magic byte when the client disconnects", async () => {
  let opened!: () => void, signal!: AbortSignal;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const body = new Readable({ read() {} });
  body.push(Buffer.from([0x1f]));
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async (_id, abort) => {
    signal = abort; opened(); return { body };
  } } }, live);
  const request = httpGet(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`);
  request.on("error", () => {});
  await ready;
  request.destroy();
  await vi.waitFor(() => expect(body.destroyed).toBe(true));
  expect(signal.aborted).toBe(true);
});

it("returns missing-object 404 and sanitized bucket-error 503 without affecting later requests", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => {
    calls++;
    if (calls === 1) return null;
    if (calls === 2) throw new Error("fake-token-and-provider-secret");
    return { body: Readable.from([gzipSync("still serving")]) };
  } } }, live);
  const url = `http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`;
  expect((await fetch(url)).status).toBe(404);
  const failure = await fetch(url);
  expect(failure.status).toBe(503);
  expect(failure.headers.get("cache-control")).toBe("no-store");
  expect(await failure.json()).toEqual({ error: "Replay temporarily unavailable. Please try again." });
  expect(errors).not.toHaveBeenCalled();
  const recovered = await raw(url);
  expect(recovered.statusCode).toBe(200);
  expect(await bytes(recovered)).toEqual(gzipSync("still serving"));
});

it("applies backpressure and cancels the source when the client disconnects", async () => {
  let produced = 0, signal!: AbortSignal;
  const chunk = Buffer.alloc(64 * 1024, 5);
  const body = new Readable({ highWaterMark: chunk.length, read() {
    if (produced++ === 1024) this.push(null); else this.push(chunk);
  } });
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async (_id, abort) => {
    signal = abort; return { body };
  } } }, live);
  const response = await raw(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`);
  response.pause();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(produced).toBeLessThan(1024);
  response.destroy();
  await vi.waitFor(() => expect(body.destroyed).toBe(true));
  expect(signal.aborted).toBe(true);
});

it("handles a mid-stream failure by truncating the response, without crashing the server", async () => {
  let fail!: () => void;
  const body = new Readable({ read() {} });
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => {
    body.push(gzipSync("first")); fail = () => body.destroy(new Error("fake late bucket failure"));
    return { body };
  } } }, live);
  const base = `http://127.0.0.1:${server.port}`;
  const response = await raw(`${base}/replays/2026-10-18T09-50-00-123Z-1`);
  response.on("error", () => {});
  await once(response, "data");
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  fail(); await closed;
  expect(response.complete).toBe(false);
  expect((await fetch(`${base}/rules`)).status).toBe(200);
});

it("with no bucket returns 404 without identity activity; the deleted bundled recording path is 404 with or without a source", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error("unexpected cloud call"); };
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: replaySourceFromEnv({}, request) }, live);
  expect((await fetch(`http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`)).status).toBe(404);
  // The bundled legacy recording and its route are deleted.
  expect((await fetch(`http://127.0.0.1:${server.port}/replays/agents.bin`)).status).toBe(404);
  await server.close();
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 2, replaySource: { open: async () => { calls++; throw new Error("unexpected read"); } } }, live);
  // Not a replay id: refused before the configured source is read.
  expect((await fetch(`http://127.0.0.1:${server.port}/replays/agents.bin`)).status).toBe(404);
  expect(calls).toBe(0);
});

it("never records a private held run even if a store was passed", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  let attempts = 0;
  server = await startSpectatedServer({ ...options(), match: "held", expectedPlayers: 0, replayStore: { create: async () => { attempts++; } } }, live);
  // With no players to wait for, the first reply on /mcp releases the held match.
  await (await fetch(`http://127.0.0.1:${server.port}/mcp`)).body?.cancel();
  await vi.waitFor(() => expect(server!.game.match!.result).not.toBeNull(), { timeout: 5_000 });
  expect(attempts).toBe(0);
  const response = await fetch(`http://127.0.0.1:${server.port}/live/replays`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ replays: [] });
});
