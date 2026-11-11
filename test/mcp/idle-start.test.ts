import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { observeInfo } from "../../src/mcp/game.js";
import { startServer, type GameServer } from "../../src/server.js";
import { rulesConfig } from "../../src/sim/config.js";
import { comparison, connect, tempDir, type Agent } from "../server/helpers.js";
import { startHarness, TEST_MCP_CONFIG, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let server: GameServer | undefined;
let dataDir: string | undefined;
let h: Harness | undefined;
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await server?.close(); server = undefined;
  await h?.close(); h = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

const config = playable({ ...rulesConfig("redesign"), commandIdleTicks: 100, commandFloorTicks: 1, antSpeedTilesPerSecond: 0 });

describe("the idle clock starts when the seat enters its match", () => {
  it("gives a queued agent a full countdown on the first tick after a held start, even after waiting longer than the timeout", async () => {
    dataDir = tempDir();
    const short = { ...config, commandIdleTicks: config.ticksPerSecond };
    let capture!: (snapshot: { secondsLeft: number | null; joinedTick: number | undefined; lastCommandTick: number | null; idle: boolean }) => void;
    const firstTick = new Promise<Parameters<typeof capture>[0]>(resolve => { capture = resolve; });
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, ...comparison(2),
      simConfig: short, mcpConfig: TEST_MCP_CONFIG,
      onTickTiming: sample => {
        if (sample.tick !== 1) return;
        // Capture at the tick boundary, not after network/scheduler delay has spent match time.
        const state = server!.game.match!.state;
        const agent = state.agents[0]!;
        capture({ secondsLeft: observeInfo(state, agent.id, state.config).status[0],
          joinedTick: agent.joinedTick, lastCommandTick: agent.lastCommandTick, idle: agent.idle });
      },
    });
    const agent = await connect(server.port); agents.push(agent);
    expect((await agent.call("join")).isError).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(server.game.match).toBeNull();
    expect(server.game.queuedAgents).toBe(1);
    expect((await agent.call("observe")).data.status[0]).toBeNull();
    // The second player's join releases the held match.
    const second = await connect(server.port); agents.push(second);
    expect((await second.call("join")).isError).toBe(false);
    expect(await firstTick).toEqual({ secondsLeft: 1, joinedTick: 0, lastCommandTick: null, idle: false });
  });

  // The one idle clock (houseIdleSeconds) starts at match start for queued seats and at join in a running match.
  it("counts the idle clock from match start for queued seats and from join for running-match seats", async () => {
    h = await startHarness({ start: false, simConfig: config, mcpConfig: { ...TEST_MCP_CONFIG, houseIdleSeconds: 10 } });
    const left = (id: string) => h!.game.observeInfoForAgent(id).status[0];
    const queued = await h.connect();
    const joined = await queued.call("join");
    h.clock.now += 60_000;
    h.advance(1000);
    expect(h.game.match).toBeNull();
    h.game.startMatch(7);
    h.advance(1);
    const queuedSeat = () => h!.game.match!.state.agents.find(agent => agent.id === joined.data.agentId)!;
    expect(queuedSeat()).toMatchObject({ joinedTick: 0, lastCommandTick: null, idle: false });
    expect(left(joined.data.agentId)).toBe(10);
    h.advance(40);
    const live = await h.connect();
    const late = await live.call("join");
    const liveSeat = () => h!.game.match!.state.agents.find(agent => agent.id === late.data.agentId)!;
    expect(liveSeat().joinedTick).toBe(41);
    expect(left(late.data.agentId)).toBe(10);
    expect(left(joined.data.agentId)).toBe(6);
    h.advance(99 - h.game.match!.state.tick);
    expect(left(joined.data.agentId)).toBe(1);
    h.advance(1);
    expect(h.game.match!.state.result).toBeNull();
    h.advance(1);
    expect(h.game.match!.state.result).toMatchObject({ reason: "idle", winner: liveSeat().colony, tick: 100 });
  });
});
