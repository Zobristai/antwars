/// <reference types="node" />
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodeGameSave, encodeGameSave } from "../../src/handover/matchSave.ts";
import { createMatchSaves, gcsSaveObjects, type MatchSave, type MatchSaves, type SaveObjects } from "../../src/handover/saveStore.ts";
import { LiveHub, type LiveClock } from "../../src/live/hub.ts";
import { RATED_DELAY_SECONDS, type MatchAccess } from "../../src/live/match-access.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type Lobbies } from "../../src/lobby/lobbies.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import type { ObserveEvent } from "../../src/mcp/game.ts";
import { CALL_ID_META_KEY } from "../../src/mcp/tools.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { GZIP_BLOCK_BYTES } from "../../src/replays/pack.ts";
import { recordingPart, type RecordingSaveMeta } from "../../src/replays/recording.ts";
import type { GameServer, SlotWiring } from "../../src/server.ts";
import { createRng } from "../../src/sim/rng.ts";
import { BROODS, type SimState, type StepOutput } from "../../src/sim/types.ts";
import { SLOT_UNHEARD_MS } from "../../src/slots/slotServer.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { fillToCap, widePlainConfig } from "../handover/helpers.ts";

// Late-match save within 19.9 s:
// one end-to-end handover at Wide Plain size, both colonies at their 1,024-ant cap, with a seated agent
// driving the MCP endpoint, late in the match. Measured and reported:
// - the agent-visible pause, from the agent's last answered call on the old server, through the takeover
//   (the real 20 s unheard wait, kept), the old
//   server's save, the new server's restore and the agent's rejoin, to its first successful call on the
//   new server, against the set worst case of about 40 s;
// - inside it, the old server's save, from its detection of supersession to the save's commit, against 19.9 s.
// Every server starts as production starts a slot server (startSpectatedServer with a replay store and
// record handoff), on production's poll, heartbeat, staleness and unheard intervals, and saves and resumes
// through the real save step. The save's bulky parts go up through the real bucket client
// (gcsSaveObjects) to a local stand-in for the bucket; Cloud Storage's own throughput is the one part
// of the save this cannot measure.
//
// Late-match size : the stream's
// 300 s of held ticks and both replay copies of the match so far at the measured 6.5 KB per tick
// per copy. Playing 35,000 ticks of Wide Plain takes far longer than a test may, so the match reaches that
// size by a handover : a first server
// begins it, and a late server takes it over from a real save of it whose game side is moved to LATE_TICK
// and whose spectator side is rebuilt at that size (lateSave). The late server's own handover to the next
// server is the one timed.
// Late-match size also includes the seats' applied-call record (the measure:
// Wide Plain 2v2 to tick 35,004, seats at the 2 calls/s limit, 6,998 applied calls a seat). The match is a
// 2v2, and before the first handover each of its four seats makes LATE_APPLIED_CALLS_PER_SEAT set_brood
// calls with call ids through the seat's MCP session and the real submit path; the match applies each and
// remembers its reply, so every later save carries the record whole. These servers' test call limit
// (TEST_MCP_CONFIG) lets them be made in seconds; the count is what production's limit allows a seat by LATE_TICK.
// And it includes the seats' event histories (the whole game save a real late match
// produces, about 88.7 MB raw / 6.05 MB gzipped by the measure, 79.2 MB of it the seats' events, every event each
// seat's views delivered, kept by retainEvents for the whole match). A real Wide Plain 2v2 match, played to LATE_TICK in its
// own process before any server starts (lateHistories), builds each seat's history through real play and the real
// retainEvents; each seat's record carries the history its seat holds there when the late server takes the match over.

/** The set worst case of the agent-visible pause. */
const PAUSE_LIMIT_MS = 40_000;
/** The old server's save finishes within this long of detecting supersession. */
const SAVE_LIMIT_MS = 19_900;
/** Late in Wide Plain's 36,000-tick match, with room for the takeover's ticks before it ends. */
const LATE_TICK = 35_000;
/** Measured replay size at Wide Plain, 1,024 ants a side: bytes per tick in each recorded copy. */
const REPLAY_BYTES_PER_TICK = 6_500;
/** The applied calls a seat at production's call limit has made by LATE_TICK: 7,000 (6,998 measured at tick 35,004). */
const LATE_APPLIED_CALLS_PER_SEAT = (LATE_TICK / widePlainConfig().ticksPerSecond) * DEFAULT_MCP_CONFIG.callsPerSecond;
/**
 * The events a seat's record holds by LATE_TICK (records[].events, every event its views delivered, kept for the whole match),
 * by the measure of its real Wide Plain 2v2 match at tick 35,004: about 214,320 a seat (19.80 MB raw), 95% fights. The
 * history match here (lateHistories) is played to LATE_TICK, and each seat carries what it holds there; this is reported beside it.
 */
const MEASURED_EVENTS_PER_SEAT = 214_320;
/** The match's seats: each identity holds both seats of its colony in a 2v2. The first is the timed agent's. */
const SEATS = [{ player: 0, seat: 1 }, { player: 0, seat: 2 }, { player: 1, seat: 1 }, { player: 1, seat: 2 }] as const;
const MB = 1_000_000;

const servers: GameServer[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** A seated agent's MCP session on one server, as the seat client opens it. */
async function session(port: number) {
  const client = new Client({ name: "antwars-seat", version: "1.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  clients.push(client);
  return (name: string, args: Record<string, unknown> = {}, callId?: string) =>
    client.callTool({ name, arguments: args, ...(callId === undefined ? {} : { _meta: { [CALL_ID_META_KEY]: callId } }) }) as Promise<CallToolResult>;
}

const ok = (reply: CallToolResult) => reply.isError !== true && (reply.structuredContent as { error?: unknown } | undefined)?.error === undefined;

/**
 * A seat's count set_brood calls, each with its own call id as the seat client sends one, many in flight at a
 * time: the match applies them at its ticks and remembers each reply under its call id (the real submit path).
 */
async function applyCalls(call: Awaited<ReturnType<typeof session>>, count: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: 25 }, async () => {
    while (next < count) {
      const reply = await call("set_brood", { brood: BROODS[next++ % BROODS.length] }, randomUUID());
      if (!ok(reply)) throw new Error(`set_brood was not applied: ${JSON.stringify(reply.structuredContent ?? reply.content)}`);
    }
  }));
}

/** Each seat's applied calls carried in a save, by seat (the record a repeated call id is answered from). */
const appliedCalls = (save: MatchSave) => save.game.records.map((record) => record.appliedCalls.length);

/** The seated agent rejoins its seat by key on the server at port, retrying as told; resolves at its first successful call there. */
async function rejoin(port: number, key: string, seat: number, deadline: number): Promise<{ call: Awaited<ReturnType<typeof session>>; at: number }> {
  for (;;) {
    if (Date.now() > deadline) throw new Error("the agent did not get back into its seat");
    try {
      const call = await session(port);
      const joined = await call("join", { key, seat });
      if (!ok(joined)) {
        await sleep((joined.structuredContent as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 500);
        continue;
      }
      if (ok(await call("observe"))) return { call, at: Date.now() };
    } catch {
      // Not serving yet: an instance answers 503 until it holds the slot, as Cloud Run's own answers look during a handover.
      await sleep(250);
    }
  }
}

/** Every ant moved and none dying, without running the sim (as test/live/stream-handover.test.ts holds 300 s of Wide Plain ticks). */
function moved(state: SimState, rng: ReturnType<typeof createRng>): StepOutput {
  const w = state.config.mapWidth * 1000, h = state.config.mapHeight * 1000;
  const ants = state.ants.map((ant) => {
    const still = ant.id % 4 === 0;
    const vx = still ? 0 : Math.round((rng.next() - 0.5) * 400), vy = still ? 0 : Math.round((rng.next() - 0.5) * 400);
    return { ...ant, vx, vy, x: Math.min(w - 1, Math.max(0, ant.x + vx)), y: Math.min(h - 1, Math.max(0, ant.y + vy)) };
  });
  return { state: { ...state, tick: state.tick + 1, ants }, events: [], results: [] };
}

/** A wall clock for a hub outside any server, moved by hand. */
function handClock(startAt: number): LiveClock & { advance(ms: number): void } {
  let t = startAt, ids = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) { timers.set(++ids, { at: t + Math.max(0, ms), fn }); return ids; },
    clearTimeout(id) { timers.delete(id as number); },
    advance(ms) {
      t += ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= t).sort(([, x], [, y]) => x.at - y.at)[0];
        if (due === undefined) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

/**
 * A recording copy of at least `bytes`, from a saved copy's parts: its body (whole gzip members) repeated, so it
 * still reads back as gzip, then cut into the GZIP_BLOCK_BYTES pieces a server holds a copy in.
 */
function sizedCopy(parts: ReadonlyMap<string, Uint8Array>, copy: "released" | "checkpoint", count: number, bytes: number): Uint8Array[] {
  const body = Buffer.concat(Array.from({ length: count }, (_, i) => parts.get(recordingPart(copy, i))!));
  const whole = Buffer.concat(Array.from({ length: Math.max(1, Math.ceil(bytes / body.byteLength)) }, () => body));
  return Array.from({ length: Math.ceil(whole.byteLength / GZIP_BLOCK_BYTES) }, (_, i) => whole.subarray(i * GZIP_BLOCK_BYTES, (i + 1) * GZIP_BLOCK_BYTES));
}

/** The spectator side of a save late in the match, built ahead of the handover that carries it (lateSave). */
interface LateSpectator { readonly meta: { readonly [key: string]: unknown }; readonly parts: Map<string, Uint8Array> }

/**
 * The spectator side the match holds at LATE_TICK: a hub like the server's (replay store and record
 * handoff) streams and records the match's last 300 s of ticks up to LATE_TICK under the match's access,
 * and its stream state and recording are saved; the recording's two copies are then grown to
 * REPLAY_BYTES_PER_TICK for every tick each holds (the released copy every tick but the 300 s held).
 */
async function lateSpectator(from: SimState, access: MatchAccess): Promise<LateSpectator> {
  const tps = from.config.ticksPerSecond;
  const heldTicks = RATED_DELAY_SECONDS * tps;
  const pushed = heldTicks + 100;
  const clock = handClock(Date.now() - (pushed * 1000) / tps);
  const hub = new LiveHub({ clock, replayStore: { create: async () => {} }, captureMatchLogs: true, recordHandoff: { submit: () => {} } });
  let state: SimState = { ...from, tick: LATE_TICK - pushed };
  hub.startMatch(1, state, access);
  const rng = createRng(747);
  for (let i = 0; i < pushed; i++) {
    const out = moved(state, rng);
    hub.appendLog(1, JSON.stringify({ tick: state.tick, inputs: [] }));
    hub.pushTick(1, out);
    clock.advance(1000 / tps);
    state = out.state;
    // A server pushes one tick per tick period, so its copies are compressed as they go; let them keep up here too.
    if (i % 100 === 99) await sleep(0);
  }
  const saved = await hub.saveMatch(1);
  hub.close();
  const recording = saved.meta.recording as RecordingSaveMeta;
  const parts = new Map([...saved.parts].filter(([name]) => !name.startsWith("recording-released-") && !name.startsWith("recording-checkpoint-")));
  const released = sizedCopy(saved.parts, "released", recording.released, (LATE_TICK - heldTicks) * REPLAY_BYTES_PER_TICK);
  const checkpoint = sizedCopy(saved.parts, "checkpoint", recording.checkpoint, LATE_TICK * REPLAY_BYTES_PER_TICK);
  released.forEach((block, i) => parts.set(recordingPart("released", i), block));
  checkpoint.forEach((block, i) => parts.set(recordingPart("checkpoint", i), block));
  return { meta: { ...saved.meta, recording: { ...recording, released: released.length, checkpoint: checkpoint.length } }, parts };
}

/** Each colony's late event histories, one per seat of it, in the order its records appear (lateHistories). */
type LateHistories = readonly [readonly (readonly ObserveEvent[])[], readonly (readonly ObserveEvent[])[]];

/**
 * The real match the seats' late histories come from, played in its own process (lateHistories): a standalone Wide Plain
 * 2v2 Game (wideMatch, the match the measure plays), both colonies at their cap, all four seats joined, played on the
 * real sim with every seat at production's call limit: set_brood every 5 ticks and, once per command floor, a FORAGE
 * count mark of 200 at its colony's front ant, so that foragers meet and fight through the match (fights are 95% of a late
 * history). Every seat's views go through the real retainEvents. At the last tick, the match's real game save
 * (encodeGameSave) is written to the file named, and its tick and events per seat to stdout.
 */
const HISTORY_PROCESS = `
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const { WIDE_SEATS, wideMatch } = await import(process.env.HELPERS);
const { encodeGameSave } = await import(process.env.MATCH_SAVE);
const { BROODS } = await import(process.env.SIM_TYPES);
const lastTick = Number(process.env.LAST_TICK);
const { game, clock } = await wideMatch({ seed: 747 });
const fourth = game.joinSeated(WIDE_SEATS[3].identityId, "test-model");
clock.now += 100; game.tick(); await fourth;
const state = () => game.match.state;
const seats = state().agents.map((agent, i) => ({ id: agent.id, colony: agent.colony, slot: i }));
const reply = (outcome) => ({ content: [{ type: "text", text: outcome.kind }] });
for (let n = 0; ; ) {
  const s = state();
  const calls = s.tick % 5 !== 0 ? [] : seats.map((seat) => {
    let input = { type: "set_brood", agentId: seat.id, brood: BROODS[n++ % BROODS.length] };
    if ((s.tick + seat.slot * 25) % s.config.commandFloorTicks === 0) {
      const live = s.ants.filter((ant) => ant.colony === seat.colony && ant.hp > 0);
      const front = live.reduce((best, ant) => (seat.colony === 0 ? ant.x > best.x : ant.x < best.x) ? ant : best);
      input = { type: "count_mark", agentId: seat.id, tileX: Math.floor(front.x / 1000), tileY: Math.floor(front.y / 1000), verb: "FORAGE", count: 200 };
    }
    return game.call(seat.id, input, true, { callId: randomUUID(), reply });
  });
  clock.now += 100;
  game.tick();
  await Promise.all(calls);
  if (state().result !== null) {
    console.error("the history match ended at tick " + state().tick + " before tick " + lastTick);
    process.exit(1);
  }
  if (state().tick >= lastTick) {
    writeFileSync(process.env.OUT, encodeGameSave(game.saveMatch()));
    console.log(JSON.stringify({ tick: state().tick, eventsPerSeat: seats.map((seat) => game.eventHistory(seat.id).length) }));
    process.exit(0);
  }
}
`;

/**
 * Starts the real match the seats' late histories come from (HISTORY_PROCESS) in its own process, so that its memory is
 * not the saving server's; resolves to each seat's history from that match's real
 * game save (decodeGameSave, so that every event is its own object, as a server holds a save it has decoded), by colony
 * in seat order, with the match's tick and its seats' event counts.
 */
function lateHistories(): Promise<{ histories: LateHistories; tick: number; eventsPerSeat: readonly number[] }> {
  const dir = tempDir();
  dirs.push(dir);
  const out = join(dir, "history-save.gz");
  const url = (path: string) => pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href;
  const child = spawn(process.execPath, ["--import", url("../../src/ts-resolve.mjs"), "--input-type=module", "-e", HISTORY_PROCESS], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OUT: out, LAST_TICK: String(LATE_TICK),
      HELPERS: url("../handover/helpers.ts"), MATCH_SAVE: url("../../src/handover/matchSave.ts"), SIM_TYPES: url("../../src/sim/types.ts") },
  });
  closers.push(async () => { child.kill(); });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
  return new Promise((resolve, reject) => child.on("exit", (code) => {
    if (code !== 0) return reject(new Error(`the history match failed (exit ${code}): ${stderr.trim()}`));
    const { tick, eventsPerSeat } = JSON.parse(stdout.trim().split("\n").at(-1)!) as { tick: number; eventsPerSeat: number[] };
    const histories: [(readonly ObserveEvent[])[], (readonly ObserveEvent[])[]] = [[], []];
    for (const record of decodeGameSave(readFileSync(out)).records) histories[record.colony ?? record.seat!.colony]!.push(record.events);
    resolve({ histories, tick, eventsPerSeat });
  }));
}

/**
 * A real save of the match moved late into it: its game side at LATE_TICK with each seat's late event history
 * (lateHistories, one per seat of its colony in record order) after the events it holds, its spectator side `late`
 * with the save's own watch side.
 */
function lateSave(save: MatchSave, late: LateSpectator, histories: LateHistories): MatchSave {
  const game = save.game;
  if (game.phase !== "match") throw new Error("the first server's save is not of a begun match");
  const seen = [0, 0];
  const records = game.records.map((record) => {
    const colony = record.colony ?? record.seat?.colony;
    if (colony === undefined) throw new Error(`record ${record.agentId} has no colony`);
    return { ...record, events: [...record.events, ...histories[colony][seen[colony]++]!] };
  });
  const { watch } = JSON.parse(save.spectator!.meta) as { watch: unknown };
  return { ...save, tick: LATE_TICK, game: { ...game, tick: LATE_TICK, state: { ...game.state, tick: LATE_TICK }, records },
    spectator: { meta: JSON.stringify({ stream: late.meta, watch }), parts: late.parts } };
}

/** A local stand-in for Cloud Storage's media upload and object read, in its own process (localBucket). */
const BUCKET_PROCESS = `
const objects = new Map();
let uploaded = 0;
const server = require("node:http").createServer((req, res) => {
  const url = new URL(req.url, "http://bucket");
  const name = url.searchParams.get("name");
  if (req.method === "POST" && url.pathname.startsWith("/upload/storage/v1/b/") && name !== null) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (objects.has(name)) return res.writeHead(412).end();
      const body = Buffer.concat(chunks);
      objects.set(name, body);
      uploaded += body.length;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  } else if (req.method === "GET" && url.pathname === "/object" && name !== null) {
    const body = objects.get(name);
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-length": body.length }).end(body);
  } else if (req.method === "GET" && url.pathname === "/uploaded") {
    res.end(String(uploaded));
  } else {
    res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

/**
 * The private record-input bucket as the save sees it: every part goes up through the real bucket client
 * (gcsSaveObjects: the metadata token, then one media upload per object, streamed) to a local stand-in for
 * Cloud Storage. The stand-in runs in its own process, so what it receives is not counted as the saving
 * server's memory. Reads come back from it over HTTP.
 */
async function localBucket(): Promise<SaveObjects & { readonly uploaded: () => Promise<number> }> {
  const child = spawn(process.execPath, ["-e", BUCKET_PROCESS], { stdio: ["ignore", "pipe", "inherit"] });
  closers.push(async () => { child.kill(); });
  const [line] = await once(child.stdout!, "data") as [Buffer];
  const origin = `http://127.0.0.1:${Number(line.toString().trim())}`;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "local-test-token" });
    if (url.hostname !== "storage.googleapis.com") throw new Error(`unexpected request to ${url.hostname}`);
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  };
  const bucket = gcsSaveObjects("example-record-inputs-test", request);
  return {
    put: bucket.put,
    async get(name) {
      const response = await fetch(`${origin}/object?name=${encodeURIComponent(name)}`);
      return response.status === 404 ? null : new Uint8Array(await response.arrayBuffer());
    },
    uploaded: async () => Number(await (await fetch(`${origin}/uploaded`)).text()),
  };
}

const partBytes = (save: MatchSave) => [...save.spectator!.parts.values()].reduce((sum, part) => sum + part.byteLength, 0);

describe("handover at Wide Plain size with a seated agent", () => {
  it("late in the match, the agent-visible pause is within the set worst case and the old server's save within 19.9 s of detection; both are reported", async ({ annotate }) => {
    const marks = { detectedAt: [] as number[] };
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.includes("another instance took the slot; handing this run's match over")) marks.detectedAt.push(Date.now());
    });
    // Keep-alive requests to the test's unresolvable public URLs fail; nothing else is expected here.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = retentionWorld(Date.now());
    const a = value(await w.ids.claimUsername("WideA")), b = value(await w.ids.claimUsername("WideB"));
    const players = [a, b];
    const lobbies: Lobbies = createLobbies(w.store, w.ids, { countdownMs: 300 });
    await w.store.transaction(async (read) => {
      const paired = await lobbies.queuedMatchWrites(read, { mode: "2v2", colonies: [[a.identity, a.identity], [b.identity, b.identity]] }, Date.now());
      return { result: paired.lobby, writes: paired.writes };
    });
    // The real match the seats' late histories come from, played in its own process before any server starts, so that the
    // match below is filled to its cap and handed over at once, as before, rather than playing on for as long as that match takes.
    const { histories, tick: historyTick, eventsPerSeat: historyEvents } = await lateHistories();
    const bucket = await localBucket();
    const saves = createMatchSaves(w.store, bucket);
    const accounts = { identities: w.ids, lobbies, ratings: createRatings(w.store, w.ids) };
    const watchRegistry = createWatchRegistry(w.store);
    const start = async (name: string, port: number, wiring: Partial<SlotWiring>) => {
      const dataDir = tempDir();
      dirs.push(dataDir);
      const server = await startSpectatedServer({
        port, host: "127.0.0.1", dataDir, simConfig: widePlainConfig(), mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100, accounts, watchRegistry,
        replayStore: { create: async () => {} }, recordHandoff: { submit: () => {} },
        slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies, identities: w.ids, revision: "r1", saves, ...wiring },
      });
      servers.push(server);
      return server;
    };

    // Setup, not timed. The first server begins the match; the agents take its four seats and make the applied calls a seat has made
    // by LATE_TICK; both colonies are filled to their cap between two ticks.
    const first = await start("first", 0, { pollMs: 50, heartbeatMs: 600_000 });
    const calls = await Promise.all(SEATS.map(async ({ player, seat }) => {
      const call = await session(first.port);
      expect(ok(await call("join", { key: players[player]!.key, seat })), `join seat ${seat} of ${players[player]!.identity.displayName}`).toBe(true);
      return call;
    }));
    await until(() => first.game.match !== null && first.game.match.state.agents.length === SEATS.length && first.game.match.state.tick >= 3);
    await Promise.all(calls.map((call) => applyCalls(call, LATE_APPLIED_CALLS_PER_SEAT)));
    fillToCap(first.game.match!.state);
    const filledAt = first.game.match!.state.tick;
    await until(() => first.game.match!.state.tick >= filledAt + 3);

    // The spectator side the match holds late in it, built while the first server plays on.
    const lobbyId = (await lobbies.slotHolder("public-0"))!.lobbyId;
    const lateSide = await lateSpectator(structuredClone(first.game.match!.state), { lobbyId, visibility: "public", rated: true, mode: "2v2" });

    // The late server takes the slot from the first, which never beat after its begin; the first hands the match over through the
    // save step, and the late server resumes that save moved late into the match (lateSave). From here every server runs on
    // production's intervals (1 s poll, 5 s heartbeat, 30 s staleness, 20 s unheard).
    let written: { save: MatchSave; at: number; writeMs: number } | null = null;
    const lateSaves: MatchSaves = {
      async write(save) {
        const writeAt = Date.now();
        await saves.write(save);
        written = { save, at: Date.now(), writeMs: Date.now() - writeAt };
      },
      read: async (id) => {
        const save = await saves.read(id);
        return save === null ? null : lateSave(save, lateSide, histories);
      },
    };
    const lateServer = await start("late", 0, { staleMs: 300, saves: lateSaves });
    const back = await rejoin(lateServer.port, a.key, SEATS[0].seat, Date.now() + 120_000);
    expect(lateServer.game.match!.state.tick).toBeGreaterThanOrEqual(LATE_TICK);
    expect([0, 1].map((colony) => lateServer.game.match!.state.ants.filter((ant) => ant.colony === colony).length)).toEqual([1024, 1024]);
    written = null;

    // The agent drives the late server, as a seated agent does.
    let lastAnswered = 0;
    while (lateServer.game.match!.state.tick < LATE_TICK + 20) {
      if (ok(await back.call("observe"))) lastAnswered = Date.now();
      await sleep(100);
    }

    // The outage: from here the platform routes the agent's requests to a new instance of the slot, which answers 503 until it
    // holds the slot, so the late server hears no more requests. The new instance takes the slot once the late server has heard
    // nothing for SLOT_UNHEARD_MS; the late server detects that, saves, and retires; the agent gets back into its seat there.
    const outageAt = lastAnswered;
    // How long the spectator side of the save takes (LiveHub.saveMatch: the stream and the recording).
    let spectatorMs = 0;
    const saveMatch = LiveHub.prototype.saveMatch;
    vi.spyOn(LiveHub.prototype, "saveMatch").mockImplementation(async function (this: LiveHub, seq: number) {
      const at = Date.now();
      try { return await saveMatch.call(this, seq); } finally { spectatorMs = Date.now() - at; }
    });
    // The takeover: when the new instance's registration takes the slot, timed as that write returns to it. The late server can
    // only detect the takeover after it, and no observer's poll, delayed behind the saving server's work, decides the time.
    let takenAt: number | null = null;
    const registerInstance: Lobbies["registerInstance"] = async (...args) => {
      const registration = await lobbies.registerInstance(...args);
      if (registration.registered) takenAt ??= Date.now();
      return registration;
    };
    const nextPort = await freePort();
    const nextServer = start("next", nextPort, { lobbies: { ...lobbies, registerInstance } });
    const memory = { before: process.memoryUsage(), peakRss: 0, peakArrayBuffers: 0 };
    const detectionsBefore = marks.detectedAt.length;
    const sampler = setInterval(() => {
      if (marks.detectedAt.length === detectionsBefore || written !== null) return;
      const now = process.memoryUsage();
      memory.peakRss = Math.max(memory.peakRss, now.rss);
      memory.peakArrayBuffers = Math.max(memory.peakArrayBuffers, now.arrayBuffers);
    }, 10);
    const resumed = await rejoin(nextPort, a.key, SEATS[0].seat, outageAt + PAUSE_LIMIT_MS + 60_000);
    clearInterval(sampler);
    const next = await nextServer;
    expect(takenAt, "the new instance took the slot").not.toBeNull();
    expect(written, "the late server's save committed").not.toBeNull();
    const save = written!.save;
    const detectedAt = marks.detectedAt.at(-1)!;
    const applied = appliedCalls(save);
    const appliedRecord = JSON.stringify(save.game.records.map((record) => record.appliedCalls));
    // The game save as the bucket object holds it (encodeGameSave), and its JSON before compression.
    const gameSave = encodeGameSave(save.game);

    const timing = {
      pauseMs: resumed.at - outageAt,
      takeoverWaitMs: takenAt! - outageAt,
      detectionMs: detectedAt - takenAt!,
      saveMs: written!.at - detectedAt,
      saveSpectatorSideMs: spectatorMs,
      saveWriteMs: written!.writeMs,
      restoreAndRejoinMs: resumed.at - written!.at,
      savedTick: save.tick,
      // The real match the seats' histories come from: its last tick and the events each seat held there, beside the measure.
      historyMatchTick: historyTick,
      historyEventsPerSeat: historyEvents,
      measuredEventsPerSeat: MEASURED_EVENTS_PER_SEAT,
      eventsPerSeat: save.game.records.map((record) => record.events.length),
      fightShare: Math.round(save.game.records[0]!.events.filter((event) => event.type === "fight").length / save.game.records[0]!.events.length * 100) / 100,
      appliedCalls: applied.reduce((sum, count) => sum + count, 0),
      appliedCallsMB: Math.round(Buffer.byteLength(appliedRecord) / MB * 10) / 10,
      gameSaveMB: Math.round(gunzipSync(gameSave).byteLength / MB * 10) / 10,
      gameSaveGzipMB: Math.round(gameSave.byteLength / MB * 10) / 10,
      spectatorPartsMB: Math.round(partBytes(save) / MB),
      parts: save.spectator!.parts.size,
      uploadedMB: Math.round(await bucket.uploaded() / MB),
      // Process-wide (every server here shares this process), sampled while the late server saved.
      rssBeforeMB: Math.round(memory.before.rss / MB),
      rssPeakDuringSaveMB: Math.round(memory.peakRss / MB),
      arrayBuffersBeforeMB: Math.round(memory.before.arrayBuffers / MB),
      arrayBuffersPeakDuringSaveMB: Math.round(memory.peakArrayBuffers / MB),
    };
    // Reported as a test annotation (shown by the verbose and JUnit reporters) and on the console.
    const report = `handover timing at Wide Plain 2v2, 1,024 ants a side, late in the match: ${JSON.stringify(timing)}`;
    console.info(report);
    await annotate(report, "timing");
    expect(takenAt!).toBeGreaterThanOrEqual(outageAt + SLOT_UNHEARD_MS);
    expect(detectedAt).toBeGreaterThanOrEqual(takenAt!);
    expect(save.tick).toBeGreaterThan(LATE_TICK);
    // The timed save carried every seat's late-match applied-call record.
    expect(applied).toEqual(SEATS.map(() => LATE_APPLIED_CALLS_PER_SEAT));
    // ... and every seat's late event history, whole.
    expect(historyTick).toBe(LATE_TICK);
    const carried = save.game.records.reduce((sum, record) => sum + record.events.length, 0);
    expect(carried).toBeGreaterThanOrEqual(historyEvents.reduce((sum, count) => sum + count, 0));
    expect(next.game.match!.state.tick).toBeGreaterThanOrEqual(save.tick);
    // Each limit's failure names the measured figure, so a shrinking margin shows in the failure.
    expect(timing.saveMs, `the old server's save took ${timing.saveMs} ms of detection, limit ${SAVE_LIMIT_MS} ms`).toBeLessThanOrEqual(SAVE_LIMIT_MS);
    expect(timing.pauseMs, `the agent-visible pause was ${timing.pauseMs} ms, set worst case ${PAUSE_LIMIT_MS} ms`).toBeLessThanOrEqual(PAUSE_LIMIT_MS);
  }, 900_000);
});
