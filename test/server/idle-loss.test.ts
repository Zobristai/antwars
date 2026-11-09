// One idle rule for every match. Outside the Antwars Model Index an idle
// seat's colony loses (both colonies idle on the same tick: a draw), rated in the
// ranked queue; the 180 s command-idle takeover no longer runs in live matches.
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { decodeMessage, encodeMessage } from "../../src/live/format.js";
import { recordLog } from "../../src/live/record.js";
import { packMessages } from "../../src/live/snapshot.js";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.js";
import { DEFAULT_HOUSE_IDLE_SECONDS, DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { Game } from "../../src/mcp/game.js";
import { replaySteps } from "../tools/summary.js";
import { createRatings, type RankedMode } from "../../src/rating/ratings.js";
import { matchRecord } from "../../src/replays/history.js";
import { startServer } from "../../src/server.js";
import { startSpectatedServer } from "../../src/spectator.js";
import { createWatchRegistry } from "../../src/live/watch-registry.js";
import type { MatchInputs } from "../../src/records/handoff.js";
import { ManualClock } from "../live/helpers.js";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { playable } from "../playable.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { startHarness } from "../mcp/harness.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { HISTORICAL_CONFIG as HISTORICAL_TEMPLATE } from "../sim/fixtures.js";
import { connect, tempDir, waitFor, type Agent } from "./helpers.js";

// Every match plays at grid scale 2: main's templates are built through the one constructor.
const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG), HISTORICAL_CONFIG = playable(HISTORICAL_TEMPLATE);

const MODES = ["1v1", "2v2", "3v3", "4v4", null] as const;

async function seated(size: number, mode: RankedMode | null, idleTicks = 1800, houseIdleSeconds?: number, startAnts = 0) {
  const logs: string[] = [];
  const game = new Game({ mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, ...(houseIdleSeconds === undefined ? {} : { houseIdleSeconds }) },
    simConfig: { ...HISTORICAL_CONFIG, ticksPerSecond: 10, commandIdleTicks: idleTicks, matchTicks: 10_000, startAnts }, onLogLine: line => logs.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  const seats = ([0, 1] as const).flatMap(colony => Array.from({ length: size }, (_, index) => ({
    identityId: `team-${colony}`, displayName: `Team ${colony}`, colony, seat: index + 1,
  })));
  game.seatLobby("idle-lobby", seats, mode);
  for (const seat of seats) await game.joinSeated(seat.identityId, undefined, seat.seat);
  game.startMatch(429);
  game.tick();
  expect(game.match!.state.agents).toHaveLength(size * 2);
  return { game, logs };
}

const sizeOf = (mode: RankedMode | null): number => mode === null ? 1 : Number(mode[0]);

describe("idle end outside the Model Index", () => {
  it.each(MODES)("%s: one idle seat at the default 300 s loses for its colony, even beside an active teammate", async mode => {
    const { game, logs } = await seated(sizeOf(mode), mode);
    const state = game.match!.state;
    state.tick = 2999;
    const silent = state.agents[0]!;
    const active = state.agents.slice(1).map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
    expect(game.tick()!.state.result).toBeNull();
    await Promise.all(active);
    const terminal = game.tick()!;
    expect(terminal.state.result).toEqual({ winner: silent.colony === 0 ? 1 : 0, reason: "idle", decidedBy: "idle", tick: 3000 });
    expect(terminal.events.filter(event => event.type === "match_end")).toHaveLength(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ tick: 3000, idle: [silent.colony], houseActive: true });
    expect(logs.some(line => JSON.parse(line).abandoned)).toBe(false);
    expect(game.tick()).toBeNull();
  });

  it.each(MODES)("%s: seats of both colonies idle on the same tick end it as a draw", async mode => {
    const { game, logs } = await seated(sizeOf(mode), mode, 1800, 0.1);
    game.match!.state.tick = 1;
    expect(game.tick()!.state.result).toEqual({ winner: null, reason: "idle", decidedBy: "draw", tick: 1 });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ tick: 1, idle: [0, 1] });
  });

  it("the 180 s command-idle takeover no longer applies: observing seats keep their seats and squads", async () => {
    const { game, logs } = await seated(1, "1v1", 20, 180, 12);
    for (let tick = 100; tick <= 2400; tick += 100) {
      game.match!.state.tick = tick;
      const observed = game.match!.state.agents.map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
      game.tick();
      for (const result of await Promise.all(observed)) expect(result.kind).toBe("view");
      expect(game.match!.state.result).toBeNull();
      for (const agent of game.match!.state.agents) {
        expect(agent.idle).toBe(false);
        expect(agent.squad.length).toBeGreaterThan(0);
      }
    }
    expect(logs.slice(1).every(line => JSON.parse(line).houseActive === true)).toBe(true);
  });

  it("observe reports the live limit and countdown in every match", async () => {
    const { game } = await seated(1, "2v2", 1800, 1);
    const seat = game.match!.state.agents[0]!;
    expect(game.observeInfoForAgent(seat.id)).toMatchObject({ houseIdleSeconds: 1, status: [1, expect.stringContaining("observe")] });
    expect(game.spectatorHouseIdle(game.match!.seq)).toMatchObject({ idleTicks: 10 });
  });

  it("a refused call does not keep its seat alive; the refusing seat's colony loses", async () => {
    const h = await startHarness({ start: false,
      simConfig: { ...HISTORICAL_CONFIG, commandIdleTicks: 3, matchTicks: 5000, startAnts: 0 },
      mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 2 },
      slot: { identityOf: async key => key === "left" || key === "right" ? key : undefined, locate: async () => undefined } });
    try {
      h.game.seatLobby("lobby-errors", [{ identityId: "left", displayName: "Left", colony: 0 },
        { identityId: "right", displayName: "Right", colony: 1 }], "1v1");
      const left = await h.connect(), right = await h.connect();
      await left.call("join", { key: "left" }); await right.call("join", { key: "right" });
      h.game.startMatch(429); h.advance(1);
      const rules = await left.call("rules");
      expect(rules.data.rules).toContain("for 2 s is idle");
      expect(rules.data.rules).toContain("Other matches: the idle seat's colony loses (rated if ranked); both colonies idle on one tick: draw.");
      // One tick before the left seat's 2 s deadline, counted from its accepted rules call.
      const leftSeat = h.game.match!.state.agents.find(agent => agent.colony === 0)!;
      const last = h.game.spectatorHouseIdle(h.game.match!.seq)!.activityTick(leftSeat.id)!;
      h.game.match!.state.tick = last + 19;
      expect((await right.call("observe")).isError).toBe(false);
      expect(h.game.match!.state.result).toBeNull();
      expect((await left.call("observe", { map: "wrong-type" })).isError).toBe(true);
      expect(h.game.match!.state.result).toMatchObject({ winner: 1, reason: "idle", decidedBy: "idle", tick: last + 20 });
      expect((await left.call("observe")).data).toMatchObject({ matchOver: true, winner: expect.any(String), result: { reason: "idle", winner: 1 } });
    } finally { await h.close(); }
  });
});

/** A lobby where only the seats `joins` accepts reach the match server; the others never join. */
async function partlyJoined(mode: RankedMode | null, joins: (colony: 0 | 1, seat: number) => boolean) {
  const logs: string[] = [];
  const game = new Game({ mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 1 },
    simConfig: { ...HISTORICAL_CONFIG, ticksPerSecond: 10, commandIdleTicks: 1800, matchTicks: 10_000, startAnts: 0 }, onLogLine: line => logs.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  const seats = ([0, 1] as const).flatMap(colony => Array.from({ length: sizeOf(mode) }, (_, index) => ({
    identityId: `team-${colony}`, displayName: `Team ${colony}`, colony, seat: index + 1,
  })));
  game.seatLobby("never-joined", seats, mode);
  for (const seat of seats) if (joins(seat.colony, seat.seat)) await game.joinSeated(seat.identityId, undefined, seat.seat);
  game.startMatch(429);
  return { game, logs, seats };
}

/** One tick in which every seat in the match makes an accepted call, so no joined seat goes idle. */
async function activeTick(game: Game) {
  const calls = game.match!.state.agents.map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
  const out = game.tick();
  await Promise.all(calls);
  return out;
}

describe("a ranked seat that never joins", () => {
  it.each(["1v1", "2v2", "3v3", "4v4"] as const)("%s: abandons the match, unrated, at the idle limit counted from match start", async mode => {
    // One seat of colony 1 never joins; every seat that joined stays active.
    const { game, logs } = await partlyJoined(mode, (colony, seat) => colony === 0 || seat !== sizeOf(mode));
    for (let tick = 0; tick < 10; tick++) expect((await activeTick(game))!.state.result).toBeNull();
    expect(game.match!.state.agents).toHaveLength(sizeOf(mode) * 2 - 1);
    const terminal = (await activeTick(game))!;
    expect(terminal.state.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: 10 });
    expect(terminal.events.filter(event => event.type === "match_end")).toHaveLength(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ tick: 10, abandoned: true });
    expect(logs.some(line => "idle" in JSON.parse(line))).toBe(false);
    expect(stateHash(replay(logs, Infinity))).toBe(stateHash(terminal.state));
    expect(matchRecord({ id: "2026-11-09T21-30-00-000Z-429", binary: packMessages(recordLog(logs)), logLines: logs }))
      .toMatchObject({ status: "complete", result: { reason: "abandoned" }, setup: { rated: false } });
    expect(game.tick()).toBeNull();
  });

  it("a seat whose join is accepted on its deadline tick has joined: the match plays on", async () => {
    const { game } = await partlyJoined("1v1", colony => colony === 0);
    for (let tick = 0; tick < 10; tick++) await activeTick(game);
    const late = game.joinSeated("team-1", undefined, 1);
    expect((await activeTick(game))!.state.result).toBeNull();
    expect((await late)!.outcome.kind).toBe("view");
    expect(game.match!.state.agents).toHaveLength(2);
    for (let tick = 0; tick < 20; tick++) expect((await activeTick(game))!.state.result).toBeNull();
  });

  it("a seat that joined and later idles keeps the existing rule: its colony loses", async () => {
    const { game } = await partlyJoined("1v1", () => true);
    await activeTick(game);
    const keep = game.match!.state.agents.find(agent => agent.colony === 0)!;
    let out = game.tick();
    for (let tick = 0; tick < 20 && out!.state.result === null; tick++) {
      const call = game.call(keep.id, { type: "observe", agentId: keep.id });
      out = game.tick();
      await call;
    }
    expect(out!.state.result).toMatchObject({ winner: 0, reason: "idle", decidedBy: "idle" });
  });

  it("an unranked lobby match plays on past the limit with a seat that never joined", async () => {
    const { game } = await partlyJoined(null, colony => colony === 0);
    for (let tick = 0; tick < 30; tick++) expect((await activeTick(game))!.state.result).toBeNull();
  });
});

describe("idle-end logs replay through every consumer", () => {
  it.each(["loss", "draw"] as const)("an idle %s replays identically through sim, stream, match record and playtest consumers", async kind => {
    const { game, logs } = await seated(2, "2v2", 3, 1);
    // A loss: colony 1 keeps observing while colony 0 goes silent; a draw: both go silent.
    const keep = kind === "draw" ? [] : game.match!.state.agents.filter(agent => agent.colony === 1);
    for (let i = 0; game.match!.state.result === null && i < 100; i++) {
      const calls = keep.map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
      game.tick();
      await Promise.all(calls);
    }
    const terminal = game.match!.state;
    expect(terminal.result).toMatchObject(kind === "draw" ? { reason: "idle", winner: null, decidedBy: "draw" } : { reason: "idle", winner: 1, decidedBy: "idle" });
    expect(stateHash(replay(logs, Infinity))).toBe(stateHash(terminal));
    expect(stateHash(replaySteps(logs, "result", () => {}))).toBe(stateHash(terminal));
    const messages = recordLog(logs);
    const decoded = messages.map(bytes => decodeMessage(bytes));
    const end = decoded.at(-1)!.events.find(event => event.kind === "end")!;
    expect(end).toMatchObject({ result: { reason: "idle", winner: terminal.result!.winner, decidedBy: terminal.result!.decidedBy } });
    expect(messages.at(-1)![2]).toBe(23);
    expect(messages.slice(0, -1).every(message => message[2] !== 23)).toBe(true);
    const record = matchRecord({ id: "2026-10-27T07-00-00-000Z-429", binary: packMessages(messages), logLines: logs });
    expect(record).toMatchObject({ status: "complete", result: { reason: "idle", winner: terminal.result!.winner } });
    const full = { ...decoded[0]!.full!, result: { ...terminal.result!, nextStartMs: null } };
    const reconnect = encodeMessage({ ...decoded[0]!, full });
    expect(reconnect[2]).toBe(23);
    expect(decodeMessage(reconnect).full!.result).toMatchObject({ reason: "idle", decidedBy: terminal.result!.decidedBy });
  });

  it("a pre-change log without houseActive or idle fields replays its command-idle takeover unchanged", () => {
    const config: SimConfig = { ...HISTORICAL_CONFIG, ticksPerSecond: 10, commandIdleTicks: 5, matchTicks: 60, startAnts: 12 };
    let state = createMatch(429, config);
    const lines = [headerLine(429, config)];
    const joins = [0, 1].map(colony => ({ type: "join" as const, agentId: `a${colony}`, colony: colony as 0 | 1 }));
    while (state.result === null) {
      const inputs = state.tick === 0 ? joins : state.tick % 10 === 0 ? joins.map(j => ({ type: "observe" as const, agentId: j.agentId })) : [];
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      state = step(state, inputs).state;
    }
    expect(lines.slice(1).every(line => !("houseActive" in JSON.parse(line)) && !("idle" in JSON.parse(line)))).toBe(true);
    expect(state.agents.every(agent => agent.idle)).toBe(true);
    expect(stateHash(replay(lines, Infinity))).toBe(stateHash(state));
    expect(stateHash(replaySteps(lines, "result", () => {}))).toBe(stateHash(state));
    expect(decodeMessage(recordLog(lines).at(-1)!).events.find(event => event.kind === "end")).toMatchObject({ result: { reason: state.result!.reason } });
  });
});

describe("the one rule in briefing and rules text", () => {
  it.each([false, true])("house=%s: every briefing states the one rule and no command-idle takeover", house => {
    const config = { ...HISTORICAL_CONFIG, commandIdleTicks: 1800 };
    for (const text of [briefing(config, DEFAULT_MCP_CONFIG, { house }), joinBriefing(config, DEFAULT_MCP_CONFIG, false, { house })]) {
      expect(text).toContain(`for ${DEFAULT_HOUSE_IDLE_SECONDS} s is idle`);
      expect(text).toContain("Index match (house-*): match abandoned, unrated.");
      expect(text).toContain("both colonies idle on one tick: draw");
      expect(text).not.toMatch(/idle timeout|without accepted commands|without an accepted command/);
      expect(text).not.toMatch(/Accepted commands alone reset/);
    }
  });
});

it("the real ranked server records a same-tick idle draw as a rated draw", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 5, publicSlots: 1 });
  const ratings = createRatings(store);
  function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.value;
  }
  const owners = [value(await identities.claimUsername("red-player")), value(await identities.claimUsername("blue-player"))];
  const keys = [value(await identities.createHandle(owners[0]!.key, "red")), value(await identities.createHandle(owners[1]!.key, "blue"))];
  const lobby = await store.transaction<Lobby>(async read => {
    const made = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [
      [{ id: keys[0]!.identity.id, displayName: keys[0]!.identity.displayName }],
      [{ id: keys[1]!.identity.id, displayName: keys[1]!.identity.displayName }],
    ] }, Date.now());
    return { result: made.lobby, writes: made.writes };
  });
  const config = { ...PUBLIC_CONFIG, startAnts: 0, commandIdleTicks: 1800 };
  const dir = tempDir(), clients: Agent[] = [];
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: config, seed: 429,
    startPickWindowMs: 200, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100 },
    slot: { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 } });
  try {
    await waitFor(() => server.game.nextStart?.kind === "scheduled");
    for (const key of keys) {
      const client = await connect(server.port); clients.push(client);
      expect((await client.call("join", { key: key.key })).isError).toBe(false);
    }
    // Both seats' idle clocks must start on one tick: a paired observe is house activity
    // for each seat, so repeat it until the server records both on the same tick.
    await waitFor(() => server.game.match?.state.agents.length === 2);
    const seq = server.game.match!.seq, seats = server.game.match!.state.agents.map(agent => agent.id);
    const seen: (number | undefined)[][] = [];
    let shared: number | undefined;
    for (let attempt = 0; attempt < 10 && shared === undefined; attempt++) {
      await Promise.all(clients.map(client => client.call("observe")));
      const at = seats.map(id => server.game.spectatorHouseIdle?.(seq)?.activityTick(id));
      seen.push(at);
      if (at[0] !== undefined && at.every(tick => tick === at[0])) shared = at[0];
    }
    if (shared === undefined) throw new Error(`the two seats never shared an activity tick: ${JSON.stringify(seen)}`);
    server.game.match!.state.tick = shared + DEFAULT_HOUSE_IDLE_SECONDS * config.ticksPerSecond - 1;
    await waitFor(() => server.game.match?.result?.reason === "idle");
    expect(server.game.match!.result).toMatchObject({ winner: null, reason: "idle", decidedBy: "draw" });
    let ended: Lobby | undefined;
    for (let n = 0; n < 100; n++) {
      ended = value(await lobbies.readLobby(lobby.id));
      if (ended.state === "ended") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ended).toMatchObject({ outcome: "draw", rated: true, state: "ended" });
    expect(await ratings.readMatchChanges(lobby.id)).not.toBeNull();
    const observed = await clients[0]!.call("observe");
    expect(observed.data).toMatchObject({ matchOver: true, winner: "draw", result: { reason: "idle", winner: null } });
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

it("the real ranked server records a never-joined seat as abandoned: lobby, ratings and recording unrated", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 5, publicSlots: 1 });
  const ratings = createRatings(store, identities);
  function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.value;
  }
  const owners = [value(await identities.claimUsername("red-player")), value(await identities.claimUsername("blue-player"))];
  const keys = [value(await identities.createHandle(owners[0]!.key, "red")), value(await identities.createHandle(owners[1]!.key, "blue"))];
  const lobby = await store.transaction<Lobby>(async read => {
    const made = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [
      [{ id: keys[0]!.identity.id, displayName: keys[0]!.identity.displayName }],
      [{ id: keys[1]!.identity.id, displayName: keys[1]!.identity.displayName }],
    ] }, Date.now());
    return { result: made.lobby, writes: made.writes };
  });
  const config = { ...PUBLIC_CONFIG, startAnts: 0, commandIdleTicks: 1800 };
  const idleTicks = config.ticksPerSecond; // a 1 s server idle limit, so the match plays every tick to its end
  const dir = tempDir(), clock = new ManualClock(), submitted: MatchInputs[] = [];
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: config, seed: 429,
    startPickWindowMs: 200, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 1 }, spectatorClock: clock,
    accounts: { identities, lobbies, ratings }, watchRegistry: createWatchRegistry(store),
    recordHandoff: { submit: inputs => { submitted.push(inputs); } }, replayStore: { create: async () => {} },
    slot: { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 } });
  let client: Agent | undefined;
  try {
    await waitFor(() => server.game.nextStart?.kind === "scheduled");
    // Only the red seat joins; the blue seat never reaches the match server.
    client = await connect(server.port);
    expect((await client.call("join", { key: keys[0]!.key })).isError).toBe(false);
    await waitFor(() => server.game.match?.state.agents.length === 1);
    // The joined seat keeps calling, so only the never-joined rule can end the match.
    for (let n = 0; n < 200 && server.game.match!.result === null; n++) await client.call("observe");
    expect(server.game.match!.result).toMatchObject({ winner: null, reason: "abandoned", decidedBy: "draw", tick: idleTicks });
    let ended: Lobby | undefined;
    for (let n = 0; n < 100; n++) {
      ended = value(await lobbies.readLobby(lobby.id));
      if (ended.state === "ended") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ended).toMatchObject({ outcome: "abandoned", rated: false, state: "ended" });
    expect(await ratings.readMatchChanges(lobby.id)).toBeNull();
    clock.advance(10 * 60_000);
    await waitFor(() => submitted.length === 1);
    const record = matchRecord(submitted[0]!);
    expect(submitted[0]!.rated).toBe(false);
    expect(record).toMatchObject({ status: "complete", setup: { rated: false }, result: { reason: "abandoned", winner: null } });
    expect(record.result).not.toHaveProperty("ratingChanges");
    expect((await client.call("observe")).data).toMatchObject({ matchOver: true, result: { reason: "abandoned", winner: null } });
  } finally {
    await client?.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
