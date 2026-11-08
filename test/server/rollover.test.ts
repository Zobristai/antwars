/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type GameServer } from "../../src/server.js";
import { connect, loggedInputs, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

describe("an agent and its token belong to one scheduled match", () => {
  it("after the next scheduled match starts, a late order and an old-token rejoin get the match-ended error and change nothing in it", async () => {
    // A short squad timer, so a timer carried into the second match would show within it.
    const SQUAD_TIMER = 5;
    const dataDir = tempDir();
    server = await startServer({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      breakMs: 200,
      simConfig: playable(shortConfig(20, { squadTimerTicks: SQUAD_TIMER })),
      mcpConfig: TEST_MCP_CONFIG,
    });
    const s = server;
    const agent = await connect(s.port);
    agents.push(agent);
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(false);
    const { agentId, reconnectToken } = joined.data;

    await waitFor(() => (s.game.match?.state.tick ?? 0) >= 1);
    expect(s.game.match!.state.agents.map((a) => a.id)).toEqual([agentId]);
    expect((await agent.call("order", { kind: "hold" })).isError).toBe(false);

    await waitFor(() => s.game.match!.seq === 2);
    const endedError = (r: { isError: boolean; text: string; data: any }): void => {
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("match_over");
      expect(r.text).toMatch(/match has ended/);
      expect(r.text).toMatch(/call join/i);
    };
    endedError(await agent.call("order", { kind: "forage" }));
    const stale = await connect(s.port);
    agents.push(stale);
    endedError(await stale.call("join", { token: reconnectToken }));

    // Past a squad timer's length into the second match, it still carries nothing from the first.
    await waitFor(() => s.game.match!.state.tick >= SQUAD_TIMER + 5);
    expect(s.game.match!.seq).toBe(2);
    expect(s.game.match!.state.agents).toEqual([]);
    expect(loggedInputs(matchLogs(dataDir).get(2)!)).toEqual([]);
    expect(loggedInputs(matchLogs(dataDir).get(1)!).some((input) => input.agentId === agentId)).toBe(true);
  }, 20_000);
});
