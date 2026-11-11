/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { replay, stateHash } from "../../src/sim/log.js";
import type { SimState } from "../../src/sim/types.js";
import { startServer, type GameServer } from "../../src/server.js";
import { comparison, connect, logLines, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

describe("a match in real time, and its log", () => {
  it("ticks at 10 per second, ends with a result and logs a replayable match", async () => {
    const MATCH_TICKS = 20;
    const dataDir = tempDir();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, ...comparison(1), simConfig: playable(shortConfig(MATCH_TICKS)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    expect(s.game.match).toBeNull();

    // An agent that joins with no match running is queued for it; its join releases the held match.
    const agent = await connect(s.port);
    agents.push(agent);
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(false);

    const started1 = await waitFor(() => s.game.match !== null);
    await waitFor(() => s.game.match!.state.tick >= 1);
    expect(s.game.match!.state.agents.map((a) => a.id)).toEqual([joined.data.agentId]);

    // Give orders so the log carries more than joins.
    const order = await agent.call("order", { kind: "go_to", tileX: 20, tileY: 20, intent: "test" });
    expect(order.isError, order.text).toBe(false);

    let end: SimState | null = null;
    const ended1 = await waitFor(() => {
      const m = s.game.match!;
      if (m.result !== null) end = m.state;
      return end !== null;
    });
    // 20 ticks at 10 per second take 2 s from the start.
    expect(end!.tick).toBe(MATCH_TICKS);
    expect(ended1 - started1).toBeGreaterThan(1800);
    expect(ended1 - started1).toBeLessThan(2600);
    expect(end!.result).not.toBeNull();

    // The finished match's log replays to the same final state and winner.
    const lines = logLines(matchLogs(dataDir).get(1)!);
    expect(lines.length).toBeGreaterThan(2);
    const replayed = replay(lines, Number.MAX_SAFE_INTEGER);
    expect(stateHash(replayed)).toBe(stateHash(end!));
    expect(replayed.result).toEqual(end!.result);
  }, 20_000);
});
