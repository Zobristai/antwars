/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { replay, stateHash } from "../../src/sim/log.js";
import type { SimState } from "../../src/sim/types.js";
import { startServer, type GameServer } from "../../src/server.js";
import { connect, logLines, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

const scheduledAt = (s: GameServer): number => {
  const next = s.game.nextStart;
  if (next?.kind !== "scheduled") throw new Error(`expected a scheduled start, got ${JSON.stringify(next)}`);
  return next.at.getTime();
};

describe("scheduled matches in real time, and their logs", () => {
  it("starts matches at their scheduled times, ticks at 10 per second, ends each with a result and logs a replayable match", async () => {
    const MATCH_TICKS = 20;
    const BREAK_MS = 400;
    const dataDir = tempDir();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, breakMs: BREAK_MS, simConfig: playable(shortConfig(MATCH_TICKS)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    const first = scheduledAt(s);
    expect(s.game.match).toBeNull();

    // An agent that joins with no match running is queued for the next one.
    const agent = await connect(s.port);
    agents.push(agent);
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.matchStarts).toBe(new Date(first).toISOString());

    const started1 = await waitFor(() => s.game.match !== null);
    expect(Math.abs(started1 - first)).toBeLessThan(150);
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

    // The next match starts at its scheduled time, one break after the end, and also runs to a result.
    const second = scheduledAt(s);
    expect(Math.abs(second - (ended1 + BREAK_MS))).toBeLessThan(150);
    const started2 = await waitFor(() => s.game.match!.seq === 2);
    expect(Math.abs(started2 - second)).toBeLessThan(150);
    const ended2 = await waitFor(() => s.game.match!.result !== null);
    expect(ended2 - started2).toBeGreaterThan(1800);
    expect(ended2 - started2).toBeLessThan(2600);
  }, 20_000);
});
