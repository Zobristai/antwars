/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type GameServer, type LiveGame } from "../../src/server.js";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
});

/** What a spectator-like route reads through the mount point, as JSON. */
function snapshot(live: LiveGame) {
  const m = live.match;
  return {
    seq: m?.seq ?? null,
    tick: m?.state.tick ?? null,
    status: m === null ? "none" : m.result === null ? "running" : "ended",
    result: m?.result ?? null,
    nextStart: live.nextStart,
  };
}

describe("the mount point", () => {
  it("serves a mounted route on the server's own port alongside /mcp, reading the live match, its status and the next start", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), breakMs: 500, simConfig: playable(shortConfig(20)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    s.mount("/live", (_req, res, live) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot(live)));
    });
    const get = async (path: string) => fetch(`http://127.0.0.1:${s.port}${path}`);
    const read = async () => (await (await get("/live")).json()) as ReturnType<typeof snapshot> & { nextStart: { kind: string; at?: string } | null };

    // Before the first match: no match, and the scheduled start time.
    const before = await read();
    expect(before.status).toBe("none");
    expect(before.nextStart).toEqual({ kind: "scheduled", at: (s.game.nextStart as { at: Date }).at.toISOString() });

    // /mcp on the same port still serves agents.
    const agent = await connect(s.port);
    agents.push(agent);
    expect((await agent.call("join", {})).isError).toBe(false);
    expect((await get("/elsewhere")).status).toBe(404);
    expect((await get("/live/sub")).status).toBe(200);

    // While it runs, the route sees the match tick.
    await waitFor(() => (s.game.match?.state.tick ?? 0) >= 2);
    const running = await read();
    expect(running.status).toBe("running");
    expect(running.result).toBeNull();
    await waitFor(() => s.game.match!.state.tick >= running.tick! + 3);
    const later = await read();
    expect(later.status).toBe("running");
    expect(later.tick).toBeGreaterThan(running.tick!);

    // After the end: ended, with the result and its winner, and the next scheduled start.
    await waitFor(() => s.game.match!.result !== null);
    const ended = await read();
    expect(ended.status).toBe("ended");
    expect(ended.result).toEqual(s.game.match!.result);
    expect(ended.result).toHaveProperty("winner");
    expect(ended.nextStart?.kind).toBe("scheduled");
    expect(Date.parse(ended.nextStart!.at!)).toBeGreaterThan(Date.now());
  }, 20_000);
});
