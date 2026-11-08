import { gunzipSync, inflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from "../../src/live/config.ts";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { scriptedInputs, type ScriptOptions } from "../../src/live/record.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import type { ReplayObject, ReplayStore } from "../../src/replays/store.ts";
import type { MatchInputs, RecordHandoff } from "../../src/records/handoff.ts";
import type { InputStore } from "../../src/records/input-store.ts";
import { encodeInput } from "../../src/records/inputs.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createRecordService } from "../../src/records/service.ts";
import type { MatchAccess } from "../../src/live/match-access.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { tickLine } from "../../src/sim/log.ts";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";

import { playable } from "../playable.ts";
import { createOnlyRecords } from "../records/create-only-records.js";
// Identity is normally random; fix only this external source to compare exact SSE bytes across modes.
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomInt: () => 123456789 }));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

async function fixture(store?: ReplayStore, config: LiveConfig = DEFAULT_LIVE_CONFIG, keepMatches = 3) {
  const clock = new ManualClock();
  const hub = new LiveHub({ clock, config, replayStore: store, keepMatches });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  cleanup.push(() => server.close(), () => hub.close());
  return { hub, clock, server };
}
const script = (ticks: number): ScriptOptions => ({ seed: 6006, config: playable({ ...rulesConfig("redesign"), matchTicks: ticks, players: 4 }), agents: 4, ticks, attack: false });
function play(f: Awaited<ReturnType<typeof fixture>>, seq: number, o: ScriptOptions) {
  let state = createMatch(o.seed, playable(o.config));
  f.hub.startMatch(seq, state);
  return () => {
    while (state.result === null) {
      const out = step(state, scriptedInputs(state, o));
      f.clock.advance(100);
      if (out.state.result !== null) f.hub.setNextStart(seq, new Date(123_456_789));
      f.hub.pushTick(seq, out);
      state = out.state;
    }
    return state;
  };
}
async function watch(f: Awaited<ReturnType<typeof fixture>>, seq: number) {
  const client = await SseClient.connect(f.server.url(`/live/${seq}`));
  cleanup.push(() => client.close());
  const res = await served(f.server, f.server.responses.length);
  return { client, res };
}

it("stores exactly the redacted public SSE, once and not before the default delayed final tick", async () => {
  const objects: ReplayObject[] = [];
  const f = await fixture({ create: async (o) => { if (o.contentType === "application/octet-stream") objects.push(o); } });
  const finish = play(f, 1, script(8));
  const { client, res } = await watch(f, 1);
  const state = finish();
  f.clock.advance(59_999);
  expect(objects).toHaveLength(0);
  expect(res.writes.filter((w) => w.text.startsWith("data: ")).map((w) => decodeMessage(inflateRawSync(Buffer.from(w.text.slice(6, -2), "base64")))).every((m) => !m.events.some((e) => e.kind === "end"))).toBe(true);
  expect(await (await fetch(f.server.url("/live/replays"))).json()).toEqual({ replays: [] });
  f.clock.advance(1);
  await vi.waitFor(() => expect(objects).toHaveLength(1));
  await delivered(client, res);
  const storedBytes = unpackMessages(new Uint8Array(gunzipSync(objects[0]!.body)));
  const stored = storedBytes.map(decodeMessage);
  expect(stored).toEqual(client.messages);
  expect(stored.map((m) => m.tick)).toEqual(Array.from({ length: state.tick + 1 }, (_, i) => i));
  expect(stored.at(-1)!.events).toContainEqual({ kind: "end", result: expect.objectContaining({ nextStartMs: 123_456_789 }) });
  expect(stored[0]!.full!.setup).not.toHaveProperty("seed");
  expect(stored[0]!.full!.setup).not.toHaveProperty("rules");
  expect(stored[0]!.full!.setup).not.toHaveProperty("players");
  expect(client.messages[0]!.full!.setup).not.toHaveProperty("seed");
  expect(stored.flatMap((m) => m.events).filter((e) => e.kind === "join").map((e) => e.modelLabel))
    .toEqual(["claude-opus-4.1#0", "gpt-5#1", "gemini-2.5-pro#2", "grok-4#3"]);
  expect(JSON.stringify(stored)).not.toContain("agent-00");
  expect(stored.some((m) => m.events.some((e) => e.kind === "join"))).toBe(true);
  const sentPayloads = res.writes.filter((w) => w.text.startsWith("data: ")).map((w) => inflateRawSync(Buffer.from(w.text.slice(6, -2), "base64")));
  expect(storedBytes.map((b) => Buffer.from(b))).toEqual(sentPayloads);
  expect(await (await fetch(f.server.url("/live/replays"))).json()).toEqual({ replays: [{ seq: 1, match: 123456789, replayId: "1970-01-01T00-00-00-000Z-1" }] });
  f.clock.advance(120_000);
  await new Promise((r) => setImmediate(r));
  expect(objects).toHaveLength(1);
});

it("leaves every live payload byte unchanged with recording on or off; unset lists no replays or logs", async () => {
  const runs: Buffer[][] = [];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const configured of [false, true]) {
    const f = await fixture(configured ? { create: async () => {} } : undefined);
    const finish = play(f, 1, script(3));
    const { client, res } = await watch(f, 1);
    finish(); f.clock.advance(60_000);
    await delivered(client, res);
    const bytes = res.writes.filter((w) => w.text.startsWith("data: ")).map((w) => inflateRawSync(Buffer.from(w.text.slice(6, -2), "base64")));
    for (const payload of bytes) expect(encodePublicMessage(decodeMessage(payload))).toEqual(new Uint8Array(payload));
    runs.push(bytes);
    if (!configured) {
      const response = await fetch(f.server.url("/live/replays"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ replays: [] });
    }
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(errors).not.toHaveBeenCalled();
});

it("without storage serves an empty list before and after finished matches and stream eviction", async () => {
  const f = await fixture(undefined, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 }, 1);
  const url = f.server.url("/live/replays");
  for (let seq = 0; seq <= 3; seq++) {
    if (seq > 0) play(f, seq, script(2))();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ replays: [] });
  }
  expect((await fetch(f.server.url("/live/1"))).status).toBe(404);
  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(JSON.stringify({ replays: [] }))));
  expect(await head.text()).toBe("");
  const post = await fetch(url, { method: "POST" });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
});

it("lists only successful uploads, excluding both pending and failed uploads", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const uploads: { name: string; resolve(): void; reject(error: Error): void }[] = [];
  const f = await fixture({ create: (object) => new Promise<void>((resolve, reject) => {
    if (object.contentType === "application/json") { resolve(); return; }
    uploads.push({ name: object.name, resolve, reject });
  }) }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  const list = async () => (await fetch(f.server.url("/live/replays"))).json();
  play(f, 1, script(2))();
  await vi.waitFor(() => expect(uploads).toHaveLength(1));
  expect(await list()).toEqual({ replays: [] });
  uploads[0]!.reject(new Error("test upload failed"));
  await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
  expect(await list()).toEqual({ replays: [] });
  play(f, 2, script(2))();
  await vi.waitFor(() => expect(uploads).toHaveLength(2));
  expect(await list()).toEqual({ replays: [] });
  uploads[1]!.resolve();
  await vi.waitFor(async () => expect(await list()).toEqual({ replays: [
    { seq: 2, match: 123456789, replayId: uploads[1]!.name.slice(0, -4) },
  ] }));
});

it("waits for actual paced final release, not merely final-tick plus delay", async () => {
  const objects: ReplayObject[] = [];
  const f = await fixture({ create: async (o) => { if (o.contentType === "application/octet-stream") objects.push(o); } }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0, paceBytesPerSecond: 1 });
  const finish = play(f, 1, script(3));
  finish();
  // The first release consumes the window; final tick still waits on pacing.
  f.clock.advance(699);
  expect(objects).toHaveLength(0);
  f.clock.advance(2_001);
  await vi.waitFor(() => expect(objects).toHaveLength(1));
  expect(unpackMessages(gunzipSync(objects[0]!.body)).map(decodeMessage).at(-1)!.tick).toBe(3);
});

it("records overlapping matches without spectators, and retains successful ids after stream eviction", async () => {
  const objects: ReplayObject[] = [];
  const f = await fixture({ create: async (o) => { if (o.contentType === "application/octet-stream") objects.push(o); } }, DEFAULT_LIVE_CONFIG, 1);
  play(f, 1, script(2))();
  f.clock.advance(100);
  play(f, 2, script(2))();
  f.clock.advance(60_000);
  await vi.waitFor(() => expect(objects).toHaveLength(2));
  expect(new Set(objects.map((o) => o.name)).size).toBe(2);
  for (const object of objects) expect(unpackMessages(gunzipSync(object.body)).map(decodeMessage).map((m) => m.tick)).toEqual([0, 1, 2]);
  play(f, 3, script(2));
  expect((await fetch(f.server.url("/live/1"))).status).toBe(404);
  const response = await fetch(f.server.url("/live/replays"));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ replays: [
    { seq: 1, match: 123456789, replayId: "1970-01-01T00-00-00-000Z-1" },
    { seq: 2, match: 123456789, replayId: "1970-01-01T00-00-00-300Z-2" },
  ] });
  expect((await fetch(f.server.url("/live/replays"), { method: "HEAD" })).status).toBe(200);
  expect((await fetch(f.server.url("/live/replays"), { method: "POST" })).status).toBe(405);
});

it("discards a match closed before delayed final release", async () => {
  const objects: ReplayObject[] = [];
  const f = await fixture({ create: async (o) => { if (o.contentType === "application/octet-stream") objects.push(o); } });
  play(f, 1, script(2))();
  f.hub.close(); f.clock.advance(120_000);
  await new Promise((r) => setImmediate(r));
  expect(objects).toHaveLength(0);
});

/** Captures what the hub hands to the record service. */
function handoffSpy() {
  const submitted: MatchInputs[] = [];
  return { submitted, handoff: { submit: (inputs: MatchInputs) => { submitted.push(inputs); } } satisfies RecordHandoff };
}

/** The merged record service over in-memory storage: builds the record from exactly what was handed off. */
async function serviceRecord(inputs: MatchInputs) {
  const CODE = "c".repeat(40), stored = new Map<string, Uint8Array>(), saved: ReplayObject[] = [], logs: string[] = [];
  stored.set(`${inputs.id}.input`, encodeInput({ ...inputs, codeVersion: CODE }));
  const store: InputStore = {
    list: async () => [...stored.keys()].sort(), get: async name => stored.get(name) ?? null,
    createMarker: async () => true, markerReason: async () => null, delete: async name => { stored.delete(name); },
  };
  const replays = createRecordReplayStore({ publicStore: { create: async () => {} }, readPublic: async () => inputs.binary });
  await createRecordService({ inputs: store, replays, now: () => inputs.publishAfter ?? 0, records: createOnlyRecords({ create: async object => { saved.push(object); } }),
    codeVersion: CODE, log: line => logs.push(line) }).sweep();
  expect(logs).toEqual([]);
  expect(saved.map(object => object.name)).toEqual([`${inputs.id}.json`]);
  return JSON.parse(new TextDecoder().decode(saved[0]!.body));
}

function playLogged(hub: LiveHub, clock: ManualClock, seq: number, access?: MatchAccess) {
  let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
  hub.startMatch(seq, state, access);
  while (state.result === null) {
    const inputs = state.tick === 0 ? [{ type: "join" as const, agentId: "private-test-id", modelLabel: "fixture-agent" }]
      : [{ type: "order" as const, agentId: "private-test-id", order: { kind: "hold" as const } }];
    hub.appendLog(seq, tickLine(state.tick, inputs));
    const out = step(state, inputs);
    clock.advance(100); hub.pushTick(seq, out); state = out.state;
  }
}

it("hands a public recording's inputs off privately at match end before delayed release, with verifiable commands", async () => {
  const objects: ReplayObject[] = [], clock = new ManualClock(), { submitted, handoff } = handoffSpy();
  const hub = new LiveHub({ clock, replayStore: { create: async object => { objects.push(object); } }, captureMatchLogs: true, recordHandoff: handoff });
  cleanup.push(() => hub.close());
  playLogged(hub, clock, 1);
  expect(objects).toEqual([]);
  await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 5_000 });
  expect(objects).toEqual([]);
  expect(submitted[0]).toMatchObject({ publishAfter: 60_400, rated: false });
  clock.advance(60_000);
  await vi.waitFor(() => expect(objects).toHaveLength(1));
  // The game server writes only the binary; no readable record is built in this process.
  expect(objects.map(object => object.name)).toEqual(["1970-01-01T00-00-00-000Z-1.bin"]);
  expect(submitted[0]).toMatchObject({ id: "1970-01-01T00-00-00-000Z-1", endedAt: 400, lobbyId: null });
  // Each copy is compressed on its own, so the bodies agree once decompressed, not byte for byte.
  expect(gunzipSync(submitted[0]!.binary)).toEqual(gunzipSync(objects[0]!.body));
  expect(submitted[0]!.logLines).toHaveLength(5);
  const record = await serviceRecord(submitted[0]!);
  expect(record).toMatchObject({ source: "match-log", status: "complete", endedAt: "1970-01-01T00:00:00.400Z" });
  expect(record.seats[0].commands.filter((command: { accepted: boolean }) => !command.accepted).length).toBeGreaterThan(0);
  expect(JSON.stringify(record)).not.toContain("private-test-id");
});

it("hands a public lobby's match off as public and a private lobby's under its lobby, keeping the private binary sealed", async () => {
  const publicObjects: ReplayObject[] = [], sealed: { lobbyId: string; name: string }[] = [], clock = new ManualClock(), { submitted, handoff } = handoffSpy();
  const hub = new LiveHub({ clock, captureMatchLogs: true, recordHandoff: handoff,
    replayStore: { create: async object => { publicObjects.push(object); } },
    privateReplayStore: lobbyId => ({ create: async object => { sealed.push({ lobbyId, name: object.name }); } }) });
  cleanup.push(() => hub.close());
  playLogged(hub, clock, 1, { lobbyId: "open-lobby", visibility: "public", rated: false });
  clock.advance(400_000);
  await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 5_000 });
  playLogged(hub, clock, 2, { lobbyId: "secret", visibility: "private", rated: false });
  clock.advance(400_000);
  await vi.waitFor(() => expect(submitted).toHaveLength(2), { timeout: 5_000 });
  expect(submitted.map(inputs => inputs.lobbyId)).toEqual([null, "secret"]);
  expect(publicObjects.map(object => object.name)).toEqual([`${submitted[0]!.id}.bin`]);
  expect(sealed).toEqual([{ lobbyId: "secret", name: `${submitted[1]!.id}.bin` }]);
});
