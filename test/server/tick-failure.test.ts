/// <reference types="node" />
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { createRatings } from "../../src/rating/ratings.js";
import { startServer, type GameServer, type MatchFeed } from "../../src/server.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { createMatch } from "../../src/sim/map.js";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { playable } from "../playable.ts";
import { connect, logLines, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";

/**
 * The next advance of the armed match state that carries a call throws after changing that state, as a sim
 * failure part-way through a tick would. Every other match, in this process too, advances normally.
 */
const failure = vi.hoisted(() => ({ state: null as unknown, needsInput: true, failedTick: null as number | null }));
vi.mock("../../src/sim/step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sim/step.js")>();
  const advance: typeof actual.advance = (...args) => {
    const [state, inputs] = args as unknown as [SimState, readonly SimInput[]];
    if (failure.state !== null && state === failure.state && (!failure.needsInput || inputs.length > 0)) {
      failure.state = null;
      failure.failedTick = state.tick;
      state.tick += 1; // partly applied
      throw new Error("injected tick failure");
    }
    return actual.advance(...args);
  };
  return { ...actual, advance };
});

let stderr: MockInstance<typeof console.error>;
const uncaught: unknown[] = [];
const onUncaught = (err: unknown): void => void uncaught.push(err);
const servers: GameServer[] = [];
const agents: Agent[] = [];

beforeEach(() => {
  failure.state = null;
  failure.needsInput = true;
  failure.failedTick = null;
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
  process.off("uncaughtException", onUncaught);
});

const errors = (): string[] => stderr.mock.calls.map((args) => args.map(String).join(" "));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a tick that throws", () => {
  it("ends only that match, abandoned and unrated at the failed tick: waiting calls refused, no log line, the timer stopped", async () => {
    const outs: StepOutput[] = [];
    const feed: MatchFeed = { matchStarted() {}, ticked(_seq, out) { outs.push(out); } };
    const dataDir = tempDir();
    const failing = await startServer({ port: 0, host: "127.0.0.1", dataDir, match: "held", simConfig: playable(shortConfig(3000)), mcpConfig: TEST_MCP_CONFIG, feed });
    const other = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", simConfig: playable(shortConfig(3000)), mcpConfig: TEST_MCP_CONFIG });
    servers.push(failing, other);
    failing.startMatch();
    other.startMatch();
    const agent = await connect(failing.port);
    agents.push(agent);
    const joined = await agent.call("join");
    expect(joined.isError).toBe(false);

    failure.state = failing.game.match!.state;
    const waiting = await agent.call("observe");
    expect(waiting.isError).toBe(true);
    expect(waiting.data.error.code).toBe("match_not_played");
    const tick = failure.failedTick!;
    expect(tick).toBeGreaterThan(0);
    expect(failing.game.match!.result).toEqual({ winner: null, reason: "abandoned", decidedBy: "draw", tick });

    // The normal end path: the feed gets match_end and no tick runs after it.
    const end = outs.at(-1)!;
    expect(end.events).toEqual([{ type: "match_end", tick, result: failing.game.match!.result }]);
    const ticked = outs.length, stateTick = failing.game.match!.state.tick;
    const otherTick = other.game.match!.state.tick;
    await sleep(500);
    expect(outs.length).toBe(ticked);
    expect(failing.game.match!.state.tick).toBe(stateTick);
    // The other match in this process keeps ticking.
    expect(other.game.match!.state.tick).toBeGreaterThan(otherTick + 2);
    expect(other.game.match!.result).toBeNull();

    // No log line for the failed tick.
    const logged = logLines(matchLogs(dataDir).get(1)!).map((line) => JSON.parse(line) as { type?: string; tick?: number });
    expect(logged.filter((line) => line.type !== "header").every((line) => line.tick! < tick)).toBe(true);

    // A later call learns the match ended abandoned.
    const after = await agent.call("observe");
    expect(after.data).toMatchObject({ result: { reason: "abandoned", winner: null } });

    expect(uncaught).toEqual([]);
    const line = errors().filter((l) => l.includes("failed in tick"));
    expect(line).toEqual([`antwar match 1 tick ${tick} failed in tick: Error: injected tick failure; match ended abandoned and unrated`]);
  }, 15_000);
});

it("on a slot server the lobby ends abandoned, unrated, with no rating change", async () => {
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
  // The first tick arms the failure; the next advance throws, with or without calls.
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, simConfig: config, seed: 429,
    startPickWindowMs: 1500, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100 },
    slot: { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 },
    onTickTiming: () => {
      ticks++;
      if (ticks === 1) { failure.needsInput = false; failure.state = server.game.match!.state; }
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
    expect(server.game.match!.result!.tick).toBe(failure.failedTick);
    let ended: Lobby | undefined;
    for (let n = 0; n < 100; n++) {
      ended = value(await lobbies.readLobby(lobby.id));
      if (ended.state === "ended") break;
      await sleep(10);
    }
    expect(ended).toMatchObject({ outcome: "abandoned", rated: false, state: "ended" });
    expect(await ratings.readMatchChanges(lobby.id)).toBeNull();
    expect(uncaught).toEqual([]);
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
