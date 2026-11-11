/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type GameServer } from "../../src/server.js";
import { comparison, connect, loggedInputs, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
const savedEnv = { PORT: process.env.PORT, DATA_DIR: process.env.DATA_DIR };
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the exported start function", () => {
  it("with a held match starts only at its join barrier, on the given port and data directory, ignoring the environment; agents joined meanwhile are queued, then placed by the queued-join rule", async () => {
    process.env.PORT = "1";
    process.env.DATA_DIR = "/nonexistent/antwar";
    const dataDir = tempDir();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, ...comparison(3), simConfig: playable(shortConfig(600)), mcpConfig: TEST_MCP_CONFIG });
    expect(server.port).not.toBe(1);
    expect(server.game.match).toBeNull();
    expect(server.game.nextStart).toEqual({ kind: "held" });

    const ids: string[] = [];
    const join = async () => {
      const agent = await connect(server!.port);
      agents.push(agent);
      const joined = await agent.call("join", {});
      expect(joined.isError, joined.text).toBe(false);
      expect(joined.data.matchStarts).toBe("when its caller starts it");
      ids.push(joined.data.agentId);
    };
    for (let i = 0; i < 2; i += 1) {
      await join();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.game.match).toBeNull();
    expect(matchLogs(dataDir).size).toBe(0);

    // The third join completes the count and releases the held match.
    await join();
    await waitFor(() => server!.game.match !== null);
    expect(server.game.match!.result).toBeNull();
    expect(matchLogs(dataDir).size).toBe(1);
    await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 1);
    // Queued joins are the first tick's inputs, in join order: the same path as any queued join.
    const log = matchLogs(dataDir).get(1)!;
    expect(loggedInputs(log).map((input) => [input.type, input.agentId])).toEqual(ids.map((id) => ["join", id]));
    const placed = server.game.match!.state.agents;
    expect(placed.map((a) => a.id)).toEqual(ids);
    for (const agent of placed) {
      expect([0, 1]).toContain(agent.colony);
      expect(agent.squad.length).toBeGreaterThan(0);
    }
    const view = await agents[0]!.call("observe");
    expect(view.isError, view.text).toBe(false);
    expect(view.data.view.squad.length).toBeGreaterThan(0);
  });
});
