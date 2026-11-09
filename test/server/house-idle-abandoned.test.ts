import { startHarness } from "../mcp/harness.js";
import { rmSync } from "node:fs";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import { startServer } from "../../src/server.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { connect, tempDir, waitFor, type Agent } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../src/live/format.js";
import { recordLog } from "../../src/live/record.js";
import { packMessages } from "../../src/live/snapshot.js";
import { matchRecord } from "../../src/replays/history.js";
import { replaySteps } from "../tools/summary.js";
import { replay, stateHash, tickLine } from "../../src/sim/log.js";
import { DEFAULT_HOUSE_IDLE_SECONDS, DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import type { RankedMode } from "../../src/rating/ratings.js";
import { LiveHub } from "../../src/live/hub.js";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { MatchInputs } from "../../src/records/handoff.js";
import { ManualClock } from "../live/helpers.js";
import { HISTORICAL_CONFIG } from "../sim/fixtures.js";
import { playable } from "../playable.ts";

const HOUSE = [[1, "house-1v1"], [2, "house-2v2"], [3, "house-3v3"], [4, "house-4v4"]] as const;

async function seated(size: number, mode: RankedMode | null, idleTicks = 1800, houseIdleSeconds?: number, startAnts = 0) {
  const logs: string[] = [];
  const game = new Game({ mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, ...(houseIdleSeconds === undefined ? {} : { houseIdleSeconds }) }, simConfig: playable({ ...HISTORICAL_CONFIG, ticksPerSecond: 10, commandIdleTicks: idleTicks,
    matchTicks: 10_000, startAnts }), onLogLine: line => logs.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  const seats = ([0, 1] as const).flatMap(colony => Array.from({ length: size }, (_, index) => ({
    identityId: `team-${colony}`, displayName: `Team ${colony}`, colony, seat: index + 1,
  })));
  game.seatLobby("idle-house", seats, mode);
  for (const seat of seats) await game.joinSeated(seat.identityId, undefined, seat.seat);
  game.startMatch(429);
  game.tick();
  expect(game.match!.state.agents).toHaveLength(size * 2);
  return { game, logs };
}

describe("rated house idle terminal boundary", () => {
  it.each(HOUSE)("%i seats in %s: any idle seat ends the match at the default 300 s, even beside an active teammate", async (size, mode) => {
    const { game, logs } = await seated(size, mode);
    const state = game.match!.state;
    state.tick = 2999;
    // Only one seat reaches the limit; every other seat, including its teammate, stays active.
    const active = state.agents.slice(1).map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
    expect(game.tick()!.state.result).toBeNull();
    await Promise.all(active);
    const terminal = game.tick()!;
    expect(terminal.state.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick: 3000 });
    expect(terminal.events.filter(event => event.type === "match_end")).toHaveLength(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ tick: 3000, abandoned: true });
    expect(game.tick()).toBeNull(); // No further tick or bot takeover after the terminal tick.
  });

  // Outside the Model Index the same clock ends the match as an idle loss or draw, never abandonment
  // (test/server/idle-loss.test.ts covers the result).
  it.each(["1v1", "2v2", "3v3", "4v4", null] as const)("%s ends idle, not abandoned", async mode => {
    const { game, logs } = await seated(mode === null ? 1 : Number(mode[0]), mode, 1800, 0.1);
    game.match!.state.tick = 1800;
    expect(game.tick()!.state.result).toMatchObject({ reason: "idle" });
    expect(logs.some(line => JSON.parse(line).abandoned)).toBe(false);
  });
});

it("observe refreshes the house clock without bypassing the independent command allowance", async () => {
  const { game } = await seated(1, "house-1v1", 1800, 1);
  const [seat, other] = game.match!.state.agents;
  const command = game.call(seat!.id, { type: "order", agentId: seat!.id, order: { kind: "hold" } });
  game.tick();
  expect((await command).kind).toBe("view");
  game.match!.state.tick = 9;
  const observed = [seat!, other!].map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
  game.tick();
  await Promise.all(observed);
  expect(game.match!.state.result).toBeNull();
  expect(game.observeInfoForAgent(seat!.id)).toMatchObject({ houseIdleSeconds: 1, status: [1, expect.stringContaining("observe")] });
  game.match!.state.tick = 19;
  const refused = game.call(seat!.id, { type: "order", agentId: seat!.id, order: { kind: "hold" } });
  const keepOther = game.call(other!.id, { type: "observe", agentId: other!.id });
  game.tick();
  expect(await refused).toMatchObject({ kind: "error", code: "rate_limited" });
  await keepOther;
  expect(game.match!.state.agents[0]!.lastCommandTick).toBe(1);
  expect(game.match!.state.result).toMatchObject({ reason: "abandoned", tick: 19 });
});

it("abandoned logs replay identically through sim, stream, match record and playtest consumers", async () => {
  const { game, logs } = await seated(2, "house-2v2", 3, 0.3);
  while (game.match!.state.result === null) game.tick();
  const terminal = game.match!.state;
  expect(terminal.result).toMatchObject({ reason: "abandoned" });
  expect(stateHash(replay(logs, Infinity))).toBe(stateHash(terminal));
  expect(stateHash(replaySteps(logs, "result", () => {}))).toBe(stateHash(terminal));
  const messages = recordLog(logs);
  const decoded = messages.map(bytes => decodeMessage(bytes));
  const end = decoded.at(-1)!.events.find(event => event.kind === "end")!;
  expect(end).toMatchObject({ result: { reason: "abandoned", winner: null } });
  expect(messages.at(-1)![2]).toBe(19);
  expect(messages.slice(0, -1).every(message => message[2] !== 19)).toBe(true);
  const record = matchRecord({ id: "2026-10-25T09-42-00-000Z-429", binary: packMessages(messages), logLines: logs });
  expect(record).toMatchObject({ status: "complete", result: { reason: "abandoned" }, setup: { rated: false } });
  // Full reconnect messages carrying abandonment also select 19; ordinary fulls keep their old version.
  const full = { ...decoded[0]!.full!, result: { ...terminal.result!, nextStartMs: null } };
  const reconnect = encodeMessage({ ...decoded[0]!, full });
  expect(reconnect[2]).toBe(19);
  expect(decodeMessage(reconnect).full!.result!.reason).toBe("abandoned");
});

it("the live hub releases abandonment without waiting for ratings and checkpoints rated:false", async () => {
  const clock = new ManualClock();
  const initial = createMatch(429, playable({ ...HISTORICAL_CONFIG, matchTicks: 100, startAnts: 0 }));
  let ratingReads = 0;
  const encoded: ReturnType<typeof decodeMessage>[] = [];
  let handoff!: (value: MatchInputs) => void;
  const checkpoint = new Promise<MatchInputs>(resolve => { handoff = resolve; });
  const hub = new LiveHub({ clock, config: { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 },
    resultRatings: async () => { ratingReads++; return null; },
    encode: message => { const bytes = encodeMessage(message); encoded.push(decodeMessage(bytes)); return bytes; },
    replayStore: { create: async () => {} }, captureMatchLogs: true,
    recordHandoff: { submit: handoff } });
  try {
    hub.startMatch(429, initial, { lobbyId: "idle-house", visibility: "public", mode: "house-1v1", rated: true });
    hub.appendLog(429, tickLine(0, [], "abandoned"));
    const terminal = step(initial, [], undefined, undefined, undefined, "abandoned");
    hub.pushTick(429, terminal);
    clock.advance(100);
    const saved = await checkpoint;
    expect(saved.rated).toBe(false);
    expect(ratingReads).toBe(0);
    expect(encoded.some(message => message.events.some(event => event.kind === "end" && event.result.reason === "abandoned"))).toBe(true);
    expect(matchRecord(saved)).toMatchObject({ status: "complete", setup: { rated: false }, result: { reason: "abandoned" } });
    const recorder = new SpectatorRecorder(initial, { rated: true });
    const display = new SpectatorState(recorder.initialFull(), 0, recorder.initial().ants);
    display.apply(recorder.record(terminal));
    expect(display.full.setup.rated).toBe(false);
    expect(display.full.result!.reason).toBe("abandoned");
    expect(encodeMessage(display.message())[2]).toBe(19);
  } finally { hub.close(); }
});

it("the real server publishes abandoned to the lobby and MCP, not a natural draw", async () => {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 5, publicSlots: 1 });
  const ratings = createRatings(store);
  function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.value;
  }
  const owner = value(await identities.claimUsername("antwars"));
  const keys = [value(await identities.createHandle(owner.key, "red")), value(await identities.createHandle(owner.key, "blue"))];
  const lobby = await store.transaction<Lobby>(async read => {
    const made = await lobbies.queuedMatchWrites(read, { mode: "house-1v1", colonies: [
      [{ id: keys[0]!.identity.id, displayName: keys[0]!.identity.displayName }],
      [{ id: keys[1]!.identity.id, displayName: keys[1]!.identity.displayName }],
    ] }, Date.now());
    return { result: made.lobby, writes: made.writes };
  });
  const config = playable({ ...PUBLIC_CONFIG, startAnts: 0, commandIdleTicks: 1800 });
  const dir = tempDir(), clients: Agent[] = [];
  let ticks = 0;
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: config, seed: 429,
    startPickWindowMs: 1500, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100 },
    slot: { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 },
    onTickTiming: () => {
      ticks++;
      if (ticks === 1) server.game.match!.state.tick = DEFAULT_HOUSE_IDLE_SECONDS * config.ticksPerSecond - 1;
    } });
  try {
    await waitFor(() => server.game.nextStart?.kind === "scheduled");
    const board = createMatch(429, config);
    for (const key of keys) {
      const client = await connect(server.port); clients.push(client);
      const joined = await client.call("join", { key: key.key });
      expect(joined.isError).toBe(false);
      const box = joined.data.nestSelection.box;
      let chosen: { tileX: number; tileY: number } | undefined;
      for (let y = box.y; y < box.y + box.height && !chosen; y++) for (let x = box.x; x < box.x + box.width && !chosen; x++) {
        if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * config.mapWidth + x] === 0) chosen = { tileX: x, tileY: y };
      }
      expect(chosen).toBeDefined();
      expect((await client.call("pick_nest", chosen!)).isError).toBe(false);
    }
    await waitFor(() => server.game.match?.result?.reason === "abandoned");
    let ended: Lobby | undefined;
    for (let n = 0; n < 100; n++) {
      ended = value(await lobbies.readLobby(lobby.id));
      if (ended.state === "ended") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(ended).toMatchObject({ outcome: "abandoned", rated: false, state: "ended" });
    expect(await ratings.readMatchChanges(lobby.id)).toBeNull();
    expect(ticks).toBe(3);
    const observed = await clients[0]!.call("observe");
    expect(observed.data).toMatchObject({ matchOver: true, winner: "abandoned", result: { reason: "abandoned", winner: null } });
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

it("house seats that only observe keep their seats and squads beyond the house limit", async () => {
  const { game } = await seated(1, "house-1v1", 2, 180, 12);
  for (let tick = 100; tick <= 2400; tick += 100) {
    game.match!.state.tick = tick;
    const observed = game.match!.state.agents.map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
    game.tick();
    for (const result of await Promise.all(observed)) expect(result.kind).toBe("view");
    expect(game.match!.state.result).toBeNull();
    for (const agent of game.match!.state.agents) {
      expect(agent.idle).toBe(false);
      expect(agent.squad.length).toBeGreaterThan(0);
      expect(agent.lastCommandTick).toBeNull();
    }
  }
});

it("a non-default server limit abandons a silent house seat independently of the rules timer", async () => {
  const { game } = await seated(1, "house-1v1", 5000, 2);
  game.match!.state.tick = 19;
  expect(game.tick()!.state.result).toBeNull();
  expect(game.tick()!.state.result).toMatchObject({ reason: "abandoned", tick: 20 });
  expect(game.match!.state.config.commandIdleTicks).toBe(5000);
});

it.each([
  ["observe", { map: "wrong-type" }],
  ["observe", { cellsCursor: "not-a-retained-cursor" }],
  ["observe", { since: 1_000_000 }],
  ["join", { key: "not-authenticated" }],
] as const)("a refused %s call does not keep its house seat alive", async (tool, args) => {
  const h = await startHarness({ start: false,
    simConfig: playable({ ...HISTORICAL_CONFIG, commandIdleTicks: 3, matchTicks: 5000, startAnts: 0 }),
    mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 2 },
    slot: { identityOf: async key => key === "left" || key === "right" ? key : undefined, locate: async () => undefined } });
  try {
    h.game.seatLobby("house-errors", [{ identityId: "left", displayName: "Left", colony: 0 },
      { identityId: "right", displayName: "Right", colony: 1 }], "house-1v1");
    const left = await h.connect(), right = await h.connect();
    await left.call("join", { key: "left" }); await right.call("join", { key: "right" });
    h.game.startMatch(429); h.advance(1);
    h.game.match!.state.tick = 19;
    expect((await right.call("observe")).isError).toBe(false);
    expect((await left.call(tool, args)).isError).toBe(true);
    expect(h.game.match!.state.result).toMatchObject({ reason: "abandoned", tick: 20 });
  } finally { await h.close(); }
});

it("rate refusals do not refresh house activity; accepted rules and observe expose the configured limit", async () => {
  const h = await startHarness({ start: false,
    simConfig: playable({ ...HISTORICAL_CONFIG, commandIdleTicks: 3, matchTicks: 5000, startAnts: 0 }),
    mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1, houseIdleSeconds: 2 },
    slot: { identityOf: async key => key === "left" || key === "right" ? key : undefined, locate: async () => undefined } });
  try {
    h.game.seatLobby("house-rate", [{ identityId: "left", displayName: "Left", colony: 0 },
      { identityId: "right", displayName: "Right", colony: 1 }], "house-1v1");
    const left = await h.connect(), right = await h.connect();
    await left.call("join", { key: "left" }); await right.call("join", { key: "right" });
    h.game.startMatch(429); h.advance(1);
    expect((await left.call("observe")).data).toMatchObject({ houseIdleSeconds: 2, status: [2, expect.stringContaining("observe")] });
    h.clock.now += 1000;
    const rules = await left.call("rules");
    expect(rules.data.rules).toContain("for 2 s is idle");
    expect(rules.data.rules).toContain("Index match (house-*), or ranked seat not joined by the limit from match start: match abandoned, unrated.");
    h.game.match!.state.tick = 22; // Last successful rules call was at tick 2.
    expect((await left.call("observe")).data.error.code).toBe("call_rate");
    await right.call("observe");
    expect(h.game.match!.state.result).toMatchObject({ reason: "abandoned", tick: 22 });
  } finally { await h.close(); }
});

it("accepted observe/rejoin calls on the deadline tick reset the house clock before abandonment", async () => {
  const { game } = await seated(1, "house-1v1", 2, 0.2);
  for (const [tick, type] of [[2, "observe"], [4, "rejoin"]] as const) {
    game.match!.state.tick = tick;
    const calls = game.match!.state.agents.map(agent => game.call(agent.id, { type, agentId: agent.id }));
    game.tick();
    for (const call of calls) expect((await call).kind).toBe("view");
    expect(game.match!.state.result).toBeNull();
  }
  game.match!.state.tick = 6;
  expect(game.tick()!.state.result).toMatchObject({ reason: "abandoned", tick: 6 });
});

it("recorded house-active ticks preserve observing seats' squads through every replay consumer", async () => {
  const { game, logs } = await seated(1, "house-1v1", 2, 1, 12);
  for (let i = 0; i < 30; i++) {
    const calls = i % 3 === 0 ? game.match!.state.agents.map(agent => game.call(agent.id, { type: "observe", agentId: agent.id })) : [];
    game.tick();
    await Promise.all(calls);
    expect(game.match!.state.agents.every(agent => !agent.idle && agent.squad.length > 0)).toBe(true);
  }
  game.tick(true);
  expect(logs.slice(1).every(line => JSON.parse(line).houseActive === true)).toBe(true);
  expect(stateHash(replay(logs, Infinity))).toBe(stateHash(game.match!.state));
  expect(stateHash(replaySteps(logs, "result", () => {}))).toBe(stateHash(game.match!.state));
  const record = matchRecord({ id: "2026-10-25T10-18-00-000Z-429", binary: packMessages(recordLog(logs)), logLines: logs });
  expect(record.status).toBe("complete");
});
