/// <reference types="node" />
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodeGameSave, encodeGameSave } from "../../src/handover/matchSave.ts";
import { createMatchSaves, type SaveObjects } from "../../src/handover/saveStore.ts";
import type { SpectatorSave } from "../../src/live/handover.ts";
import { createLobbies, type Lobbies } from "../../src/lobby/lobbies.ts";
import { CALL_ID_META_KEY } from "../../src/mcp/tools.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer, type SlotWiring } from "../../src/server.ts";
import { COLONY_NAMES, PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { holdBehaviour } from "../../src/sim/holdBehaviour.ts";
import { stateHash } from "../../src/sim/log.ts";
import { cloneState } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { ColonyId, SimInput, SimState, StepOutput } from "../../src/sim/types.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { startHarness, TEST_CONFIG, type Harness, type TestAgent } from "../mcp/harness.ts";
import { fillToCap, widePlainConfig } from "../handover/helpers.ts";
import { playable } from "../playable.ts";
import { sortedJson } from "../tuning/equality.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

// Resume and rejoin: a mutating call carries its call id in params._meta
// (the seat client sends one per command, unchanged on every resend). The server
// remembers it with its reply once the call is applied, and answers a repeat with that reply.
// The same-release server that next takes the slot restores the old server's save, adopts the
// match and only then resumes it at the saved tick; its seats rejoin by key.

let h: Harness | null = null;
let resumed: Harness | null = null;
const servers: GameServer[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  await resumed?.close();
  resumed = null;
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** tools/call with a call id in params._meta, read whole: the repeat must be the original reply. */
function callWithId(agent: TestAgent, name: string, args: Record<string, unknown>, callId: string): Promise<CallToolResult> {
  return agent.client.callTool({ name, arguments: args, _meta: { [CALL_ID_META_KEY]: callId } }) as Promise<CallToolResult>;
}

const data = (reply: CallToolResult): any => reply.structuredContent;

describe("call ids on one server", () => {
  it("a repeat of an applied call id gets the original reply with no second effect; refused and unidentified calls are evaluated afresh", async () => {
    h = await startHarness();
    const agent = await h.connect();
    const joined = await agent.call("join", { colony: COLONY_NAMES[0] });
    expect(joined.isError, joined.text).toBe(false);
    const agentId: string = joined.data.agentId;
    const orders = () => h!.inputsOf(agentId).filter((input) => input.type === "order");

    const first = await callWithId(agent, "order", { kind: "hold" }, "call-a");
    expect(first.isError, JSON.stringify(first)).toBeFalsy();
    expect(data(first).accepted).toBe(true);
    h.advance(3);
    // The same command resent: without its id the sim would refuse it inside the command floor.
    const repeat = await callWithId(agent, "order", { kind: "hold" }, "call-a");
    expect(repeat).toEqual(first);
    expect(orders()).toHaveLength(1);

    // A new id inside the floor is refused by the sim: not applied, so not remembered.
    const refused = await callWithId(agent, "order", { kind: "forage" }, "call-b");
    expect(data(refused).error.code).toBe("rate_limited");
    expect(orders()).toHaveLength(2);
    h.advance(TEST_CONFIG.commandFloorTicks);
    // The same id again, past the floor, is a fresh call and applies.
    const applied = await callWithId(agent, "order", { kind: "forage" }, "call-b");
    expect(data(applied).accepted, JSON.stringify(applied)).toBe(true);
    expect(orders()).toHaveLength(3);
    expect(await callWithId(agent, "order", { kind: "forage" }, "call-b")).toEqual(applied);
    expect(orders()).toHaveLength(3);

    // Without an id a resend is a new command, as today.
    h.advance(TEST_CONFIG.commandFloorTicks);
    expect((await agent.call("order", { kind: "hold" })).data.accepted).toBe(true);
    expect((await agent.call("order", { kind: "hold" })).data.error.code).toBe("rate_limited");
    expect(orders()).toHaveLength(5);
  });

  // Its own limit, sized from the work: 4,041 synchronous ticks (the ≥ 400 s span) and 41 calls took
  // 2.70–3.06 s alone and 6.50–6.79 s beside 6 busy loops at --maxWorkers=2 (4 CPUs), where vitest's
  // 5000 ms default timed out 3/3. 30 s is about 4× the loaded worst, for the slower 2-CPU CI runner.
  it("remembers every applied call for the rest of the match, however many follow and however much match time passes, and keys them to the seat, not the session", { timeout: 30_000 }, async () => {
    h = await startHarness({ simConfig: { ...TEST_CONFIG, commandFloorTicks: 1 } });
    const agent = await h.connect();
    const joined = await agent.call("join", { colony: COLONY_NAMES[0] });
    const agentId: string = joined.data.agentId;
    const token: string = joined.data.reconnectToken;
    const orders = () => h!.inputsOf(agentId).filter((input) => input.type === "order").length;
    const first = await callWithId(agent, "order", { kind: "hold" }, "first");
    expect(data(first).accepted, JSON.stringify(first)).toBe(true);
    const firstApplied = h.game.match!.state.tick;
    // Far more calls than a short count of last calls would keep, spread over far more match time than any client retry window.
    const later: CallToolResult[] = [];
    for (let n = 0; n < 40; n += 1) {
      later.push(await callWithId(agent, "order", { kind: n % 2 === 0 ? "forage" : "hold" }, `call-${n}`));
      expect(data(later[n]!).accepted, JSON.stringify(later[n])).toBe(true);
      h.advance(100);
    }
    expect(orders()).toBe(41);
    const late = h.game.match!.state;
    expect(late.result).toBeNull();
    expect((late.tick - firstApplied) / TEST_CONFIG.ticksPerSecond).toBeGreaterThanOrEqual(400);

    // A new session of the same seat gets the remembered reply, with no second effect.
    const again = await h.connect();
    expect((await again.call("join", { reconnectToken: token })).isError).toBe(false);
    expect(await callWithId(again, "order", { kind: "forage" }, "first")).toEqual(first);
    expect(await callWithId(again, "order", { kind: "hold" }, "call-0")).toEqual(later[0]);
    expect(orders()).toBe(41);

    // Handed over that late, the call still travels in the save: made again on the resuming game, it takes no second effect and gets its original reply.
    resumed = await startHarness({ simConfig: { ...TEST_CONFIG, commandFloorTicks: 1 }, start: false });
    resumed.game.resumeMatch(decodeGameSave(encodeGameSave(h.game.saveMatch())));
    const rejoined = await resumed.connect();
    expect((await rejoined.call("join", { reconnectToken: token })).isError).toBe(false);
    expect(await callWithId(rejoined, "order", { kind: "forage" }, "first")).toEqual(first);
    expect(resumed.inputsOf(agentId).filter((input) => input.type === "order")).toEqual([]);

    // Another seat's id is its own.
    const other = await h.connect();
    expect((await other.call("join", { colony: COLONY_NAMES[1] })).isError).toBe(false);
    expect(data(await callWithId(other, "order", { kind: "hold" }, "call-0")).accepted).toBe(true);
  });
});

/** The record-input bucket's objects in memory, create-only as the bucket's are. */
function memoryObjects(): SaveObjects {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(name, body) {
      if (objects.has(name)) throw new Error(`object ${name} exists`);
      objects.set(name, body);
    },
    async get(name) {
      return objects.get(name) ?? null;
    },
  };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** A 12 s match (120 ticks at 10 per second) that reaches its natural time-up result; a seat may command every tick. */
const MATCH = playable(shortConfig(120, { queenFounding: PUBLIC_CONFIG.queenFounding, commandFloorTicks: 1 }));
/**
 * A 25 s match (50 ticks at 2 per second): a call queued just after a tick still waits for the
 * next one when a newcomer takes the slot, so the superseded owner stops before applying it.
 */
const SLOW_MATCH = playable(shortConfig(50, { ticksPerSecond: 2, queenFounding: PUBLIC_CONFIG.queenFounding, commandFloorTicks: 1 }));

/**
 * One in-memory store; a rated 1v1 queue match holding public-0. Adoption waits while
 * `adoption` is closed, so a test can call the new server between its restore and its resume.
 */
async function resumeWorld() {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("ResumeA")), b = value(await w.ids.claimUsername("ResumeB"));
  const real = createLobbies(w.store, w.ids, { countdownMs: 300 });
  const ratings = createRatings(w.store, w.ids);
  const lobby = await w.store.transaction(async (read) => {
    const paired = await real.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  expect(lobby.slot).toBe("public-0");
  let adoption: Promise<void> = Promise.resolve();
  const adoptions: string[] = [];
  const lobbies: Lobbies = {
    ...real,
    async adoptMatch(lobbyId, slot, runId, fromRunId) {
      await adoption;
      const adopted = await real.adoptMatch(lobbyId, slot, runId, fromRunId);
      if (adopted.ok) adoptions.push(runId);
      return adopted;
    },
  };
  // The real save store; its object writes wait while `writes` is closed, so a test can call the new server while the old one saves.
  const bucket = memoryObjects();
  let writes: Promise<void> = Promise.resolve();
  const saves = createMatchSaves(w.store, { put: async (name, body) => { await writes; await bucket.put(name, body); }, get: (name) => bucket.get(name) });
  return {
    w, lobbies, saves, lobby, adoptions, keys: [a.key, b.key] as const,
    holdAdoption() {
      let open!: () => void;
      adoption = new Promise((resolve) => { open = resolve; });
      return open;
    },
    holdSaves() {
      let open!: () => void;
      writes = new Promise((resolve) => { open = resolve; });
      return open;
    },
    outcome: async () => value(await real.readLobby(lobby.id)).outcome,
    rated: async () => Promise.all([a, b].map(async (key) => (await ratings.readRating(key.identity.id, "1v1")).ratedMatches)),
    markers: () => w.commits.flat().filter((write) => write.path === `ratedMatches/${lobby.id}`).length,
  };
}
type ResumeWorld = Awaited<ReturnType<typeof resumeWorld>>;

/** A seat's call line as the recording writes it (src/replays/recording.ts replyLine, stubLine, textLine): not a tick line. */
const CALL_LINE = /^\{"type":"(reply|stub|text)",/;

/** The spectator side a test feed saves and is handed back on resume. */
const SPECTATOR: SpectatorSave = { meta: JSON.stringify({ test: "spectator" }), parts: new Map([["stream", new Uint8Array([1, 2, 3])]]) };

/**
 * A slot server of revision r1 for public-0 with the handover save store. Its feed records its tick
 * lines (inputs per tick), leaving out the seats' call lines (reply, stub and text lines) the
 * same hook carries, and every match start, seating and resume it is told of; `retired`
 * settles once the server, superseded, has saved its begun match and closed (the save step).
 */
async function resumeServer(t: ResumeWorld, name: string, wiring: Partial<SlotWiring> = {},
  options: { readonly failResume?: true; readonly simConfig?: SimConfig; readonly ticked?: (out: StepOutput) => void } = {}) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  const lines: string[] = [];
  const told: { readonly hook: string; readonly seq?: number; readonly tick?: number; readonly save?: SpectatorSave }[] = [];
  let onRetired!: () => void;
  const retired = new Promise<void>((resolve) => { onRetired = resolve; });
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir, simConfig: options.simConfig ?? MATCH, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100,
    feed: {
      matchStarted: (seq, state) => { told.push({ hook: "matchStarted", seq, tick: state.tick }); },
      lobbySeated: async () => { told.push({ hook: "lobbySeated" }); },
      ticked: (_seq, out) => options.ticked?.(out),
      logLine: (_seq, line) => { if (!CALL_LINE.test(line)) lines.push(line); },
      saveSpectator: async () => SPECTATOR,
      matchResumed: async (seq, state, _live, save) => {
        told.push({ hook: "matchResumed", seq, tick: state.tick, save });
        if (options.failResume) throw new Error("spectator side not resumed");
      },
    },
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies: t.lobbies, identities: t.w.ids, pollMs: 20, revision: "r1", saves: t.saves, onRetired, ...wiring },
  });
  servers.push(server);
  const ticks = () => lines.map((line) => JSON.parse(line) as { tick: number; inputs: SimInput[] });
  return { server, told, lines, ticks, retired, orders: (agentId: string) => ticks().flatMap((entry) => entry.inputs).filter((input) => input.type === "order" && input.agentId === agentId) };
}

/** An MCP session on a server; call sends a call id in params._meta when given one. */
async function seatSession(server: GameServer) {
  const client = new Client({ name: "antwar-resume-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
  await client.connect(transport);
  clients.push(client);
  return {
    sessionId: transport.sessionId!,
    call: (name: string, args: Record<string, unknown>, callId?: string) =>
      client.callTool({ name, arguments: args, ...(callId === undefined ? {} : { _meta: { [CALL_ID_META_KEY]: callId } }) }) as Promise<CallToolResult>,
  };
}

/** Calls waiting in the server's match for its next tick (test-only view of Game's private queue). */
const waiting = (server: GameServer) => (server.game as unknown as { current: { pending: readonly { input: SimInput }[] } | null }).current?.pending ?? [];

/**
 * A same-release newcomer takes the slot from the owner, whose heartbeat is older than its 300 ms
 * staleness window. The owner, superseded while playing its begun match, stops it at a tick and
 * saves it through the real save step.
 */
const takeOver = (t: ResumeWorld, options?: Parameters<typeof resumeServer>[3]) => resumeServer(t, "successor", { staleMs: 300 }, options);

describe("resume and rejoin on the next same-release server", { timeout: 60_000 }, () => {
  it("resumes at the saved tick once adopted; old sessions get 404; key joins answer lobby_loading until then and rejoin the same seat; not-applied calls apply once, applied ones never twice; one rated result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await resumeWorld();
    // The owner never beats again after its begin, so once it stops the successor's 300 ms staleness window lets it take the slot.
    const owner = await resumeServer(t, "owner", { heartbeatMs: 60_000 }, { simConfig: SLOW_MATCH });
    const ownerRun = await until(async () => (await t.lobbies.slotHolder("public-0"))?.matchRunId ?? undefined);
    const seats = [await seatSession(owner.server), await seatSession(owner.server)];
    const joined = await Promise.all(seats.map(async (seat, i) => (await seat.call("join", { key: t.keys[i] })).structuredContent as any));
    const agentId: string = joined[0].agentId;
    await until(() => (owner.server.game.match?.state.agents.length ?? 0) === 2 && owner.server.game.match!.state.tick >= 3);

    // Applied on the old server before its save; its reply is treated as lost.
    const applied = await seats[0]!.call("order", { kind: "hold" }, "applied-1");
    expect((applied.structuredContent as any).accepted, JSON.stringify(applied)).toBe(true);
    // Twenty more applied calls of the same seat follow it before the save, more than a count of last calls would keep.
    for (let n = 0; n < 20; n += 1) {
      const more = await seats[0]!.call("order", { kind: n % 2 === 0 ? "forage" : "hold" }, `more-${n}`);
      expect((more.structuredContent as any).accepted, JSON.stringify(more)).toBe(true);
    }
    expect(owner.orders(agentId)).toHaveLength(21);
    // Accepted but not applied when the old server stops: waiting for its next tick when the newcomer takes the slot.
    const notApplied = seats[0]!.call("order", { kind: "forage" }, "pending-1");
    await until(() => waiting(owner.server).some((call) => call.input.type === "order"), 5000);
    const openSaves = t.holdSaves();
    const openAdoption = t.holdAdoption();
    const successor = await takeOver(t, { simConfig: SLOW_MATCH });
    const successorRun = (await t.lobbies.resolveSlot("public-0"))!.runId;
    expect(successorRun).not.toBe(ownerRun);
    expect((await notApplied).structuredContent, JSON.stringify(await notApplied)).toMatchObject({ error: { code: "not_applied" } });
    const stoppedAt = owner.server.game.match!.state.tick;
    const savedHash = stateHash(owner.server.game.match!.state);
    expect(owner.orders(agentId)).toHaveLength(21);
    expect(owner.ticks().at(-1)!.tick).toBe(stoppedAt - 1);

    // An MCP session from the old server is unknown here.
    const stale = await fetch(`http://127.0.0.1:${successor.server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": seats[0]!.sessionId, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "observe", arguments: {} } }),
    });
    expect(stale.status).toBe(404);

    const rejoin = await seatSession(successor.server);
    const loading = async () => (await rejoin.call("join", { key: t.keys[0] })).structuredContent as any;
    // Waiting for the old server's save, still being written.
    expect(await loading()).toMatchObject({ error: { code: "lobby_loading" }, retryAfterMs: expect.any(Number) });
    openSaves();
    await owner.retired;
    const save = (await t.saves.read(t.lobby.id))!;
    expect(save).toMatchObject({ revision: "r1", savedByRunId: ownerRun, tick: stoppedAt, spectator: SPECTATOR });
    // Restored, not yet adopted: the match waits at the saved tick and the seat's join still answers lobby_loading.
    await until(() => successor.server.game.match?.state.tick === save.tick);
    expect(stateHash(successor.server.game.match!.state)).toBe(savedHash);
    expect(await loading()).toMatchObject({ error: { code: "lobby_loading" }, retryAfterMs: expect.any(Number) });
    await sleep(200);
    expect(successor.ticks()).toEqual([]);
    expect(successor.server.game.match!.state.tick).toBe(save.tick);

    openAdoption();
    await until(() => t.adoptions.includes(successorRun));
    expect((await t.lobbies.slotHolder("public-0"))?.matchRunId).toBe(successorRun);
    // Resumed at exactly the saved tick: its first tick applies tick save.tick.
    await until(() => successor.ticks().length > 0);
    expect(successor.ticks()[0]!.tick).toBe(save.tick);
    // Its feed was told of the resume, not a start, with the saved spectator side and no lobby seating.
    expect(successor.told).toEqual([{ hook: "matchResumed", seq: successor.server.game.match!.seq, tick: save.tick, save: SPECTATOR }]);

    const back = (await rejoin.call("join", { key: t.keys[0] })).structuredContent as any;
    expect(back.agentId, JSON.stringify(back)).toBe(agentId);
    expect(successor.server.game.match!.state.agents.find((agent) => agent.id === agentId)?.colony)
      .toBe(owner.server.game.match!.state.agents.find((agent) => agent.id === agentId)?.colony);

    // The applied call made again, after twenty later ones and the handover, takes no second effect and gets its original reply.
    expect(await rejoin.call("order", { kind: "hold" }, "applied-1")).toEqual(applied);
    expect(successor.orders(agentId)).toEqual([]);
    // The call never applied is not in the resumed match; made again, it applies once.
    const pending = await rejoin.call("order", { kind: "forage" }, "pending-1");
    expect((pending.structuredContent as any).accepted, JSON.stringify(pending)).toBe(true);
    expect(successor.orders(agentId)).toHaveLength(1);
    expect(await rejoin.call("order", { kind: "forage" }, "pending-1")).toEqual(pending);
    expect(successor.orders(agentId)).toHaveLength(1);
    // Later calls apply to the resumed match.
    expect(((await rejoin.call("order", { kind: "hold" }, "later-1")).structuredContent as any).accepted).toBe(true);
    expect(successor.orders(agentId)).toHaveLength(2);

    // It plays to its natural result, rated once, as the adopting run's own.
    expect(await until(async () => (await t.outcome()) ?? undefined, 30_000)).toMatch(/^(colony_[01]_won|draw)$/);
    expect(await t.rated()).toEqual([1, 1]);
    expect(t.markers()).toBe(1);
    // Its log lines continue the old server's as one uninterrupted match's would: tick lines from the saved tick on, no header or marker.
    const resumedTicks = successor.ticks().map((entry) => entry.tick);
    expect(resumedTicks).toEqual(resumedTicks.map((_tick, i) => save.tick + i));
    expect(successor.lines.every((line) => (JSON.parse(line) as { type?: string }).type === undefined)).toBe(true);
  });

  it("a restored match whose spectator side cannot be resumed is dropped: it ends not played and unrated, and nothing runs on the new server", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await resumeWorld();
    const owner = await resumeServer(t, "owner", { heartbeatMs: 60_000 });
    const ownerRun = await until(async () => (await t.lobbies.slotHolder("public-0"))?.matchRunId ?? undefined);
    await until(() => (owner.server.game.match?.state.tick ?? 0) >= 3);

    const successor = await takeOver(t, { failResume: true });
    expect(await until(async () => (await t.outcome()) ?? undefined)).toBe("not_played");
    await owner.retired;
    // The owner's save was read and restored here, then dropped.
    const save = (await t.saves.read(t.lobby.id))!;
    expect(save).toMatchObject({ savedByRunId: ownerRun, tick: owner.server.game.match!.state.tick });
    expect(successor.told.map((told) => told.hook)).toEqual(["matchResumed"]);
    expect(t.adoptions).toEqual([]);
    expect(await t.rated()).toEqual([0, 0]);
    expect(t.markers()).toBe(0);
    // The restored match ended where it was restored, unplayed, so the slot's next match can start here.
    expect(successor.server.game.match!.result).not.toBeNull();
    expect(successor.server.game.match!.state.tick).toBe(save.tick);
    expect(successor.ticks()).toEqual([]);
    const seat = await seatSession(successor.server);
    expect(((await seat.call("join", { key: t.keys[0] })).structuredContent as any).error.code).toBe("match_not_played");
  });
});

/** One tick as a server produced it: the tick applied, its state hash, and its events and results as sorted JSON. */
interface TickRecord { readonly tick: number; readonly hash: string; readonly events: string; readonly results: string }
const tickRecord = (out: StepOutput): TickRecord =>
  ({ tick: out.state.tick - 1, hash: stateHash(out.state), events: sortedJson(out.events), results: sortedJson(out.results) });

/** A logged tick line's server terminal and house flag, as the log replayer passes them to step (src/sim/log.ts). */
interface TickLine { readonly tick: number; readonly inputs: SimInput[]; readonly stop?: true; readonly abandoned?: true; readonly idle?: ColonyId[]; readonly houseActive?: true }
const terminalOf = (line: TickLine) => line.idle !== undefined ? { idle: line.idle } : line.abandoned === true ? "abandoned" as const : line.stop === true;

/** Wide Plain at production settings, its match cut to `ticks` so it reaches its natural result here. */
function shortWidePlain(ticks: number): SimConfig {
  const wide = widePlainConfig();
  const terrain = wide.terrain!;
  return { ...wide, terrain: { ...terrain, maps: terrain.maps.map((map) => map.id === "wide-plain" ? { ...map, matchTicks: ticks } : map) } };
}

describe("Continuation through the real superseded and resumed servers", { timeout: 300_000 }, () => {
  it("a Wide Plain match at 1,024 ants a side handed over between slot servers continues as the same match run uninterrupted on the same inputs: every tick's state hash, events and results, the result, and its hold behaviour", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const MATCH_TICKS = 160;
    const simConfig = shortWidePlain(MATCH_TICKS);
    const t = await resumeWorld();
    const ownerTicks: TickRecord[] = [], successorTicks: TickRecord[] = [];
    const owner = await resumeServer(t, "owner", { heartbeatMs: 600_000 }, { simConfig, ticked: (out) => ownerTicks.push(tickRecord(out)) });
    const ownerRun = await until(async () => (await t.lobbies.slotHolder("public-0"))?.matchRunId ?? undefined);
    const seat = await seatSession(owner.server);
    const joined = (await seat.call("join", { key: t.keys[0] })).structuredContent as any;
    // The other seat joins too: a ranked seat that never joins ends the match abandoned, unrated, at its natural end.
    const other = await seatSession(owner.server);
    expect(((await other.call("join", { key: t.keys[1] })).structuredContent as any).agentId).toEqual(expect.any(String));
    await until(() => (owner.server.game.match?.state.tick ?? 0) >= 2);
    // Both colonies at their 1,024-ant cap, filled between two ticks; the uninterrupted match starts from this state.
    const live = owner.server.game.match!.state;
    expect(live.terrain?.mapId).toBe("wide-plain");
    expect(holdBehaviour(live.config)).toBe("ant115");
    fillToCap(live);
    expect([0, 1].map((colony) => live.ants.filter((ant) => ant.colony === colony).length)).toEqual([1024, 1024]);
    const from: SimState = cloneState(live);

    // The seated agent commands its colony on both servers, so the match has inputs on each side of the handover.
    const commands = ["hold", "forage", "hold"];
    let commanding = true;
    const command = async (call: typeof seat.call) => {
      for (let n = 0; commanding; n++) {
        await call("order", { kind: commands[n % commands.length] }).catch(() => null);
        await sleep(150);
      }
    };
    const onOwner = command(seat.call);
    await until(() => owner.server.game.match!.state.tick >= from.tick + 40, 120_000);
    // Superseded, the owner stops at a tick and saves; the agent's calls from then on are not applied there.
    const successor = await takeOver(t, { simConfig, ticked: (out) => successorTicks.push(tickRecord(out)) });
    await owner.retired;
    commanding = false;
    await onOwner;
    const save = (await t.saves.read(t.lobby.id))!;
    expect(save).toMatchObject({ savedByRunId: ownerRun, tick: owner.server.game.match!.state.tick });
    const rejoin = await seatSession(successor.server);
    expect(((await until(async () => {
      const reply = (await rejoin.call("join", { key: t.keys[0] })).structuredContent as any;
      return reply.error?.code === "lobby_loading" ? undefined : reply;
    }, 60_000)) as any).agentId).toBe(joined.agentId);
    expect(holdBehaviour(successor.server.game.match!.state.config)).toBe("ant115");
    commanding = true;
    const onSuccessor = command(rejoin.call);
    expect(await until(async () => (await t.outcome()) ?? undefined, 180_000)).toMatch(/^(colony_[01]_won|draw)$/);
    commanding = false;
    await onSuccessor;

    // The same match run uninterrupted: the log replayer's step over both servers' logged inputs, from the same state.
    const lines = new Map<number, TickLine>();
    for (const line of [...owner.lines, ...successor.lines].map((text) => JSON.parse(text) as TickLine)) lines.set(line.tick, line);
    const served = new Map([...ownerTicks, ...successorTicks].map((record) => [record.tick, record]));
    expect(successorTicks[0]!.tick).toBe(save.tick);
    expect(ownerTicks.at(-1)!.tick).toBe(save.tick - 1);
    let state = from, compared = 0, ordersCompared = 0;
    while (state.result === null) {
      const line = lines.get(state.tick);
      expect(line, `tick ${state.tick} logged`).toBeDefined();
      ordersCompared += line!.inputs.filter((input) => input.type === "order").length;
      const out = step(state, line!.inputs, undefined, undefined, undefined, terminalOf(line!), line!.houseActive === true);
      expect(served.get(state.tick), `tick ${state.tick}`).toEqual(tickRecord(out));
      state = out.state;
      compared += 1;
    }
    expect(state.result).toMatchObject({ reason: "time_up", tick: MATCH_TICKS - 1 });
    expect(successor.server.game.match!.result).toEqual(state.result);
    expect(compared).toBe(MATCH_TICKS - from.tick);
    expect(ordersCompared).toBeGreaterThan(0);
    expect(await t.rated()).toEqual([1, 1]);
    expect(t.markers()).toBe(1);
  });
});
