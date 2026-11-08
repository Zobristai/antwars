import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions, startServer, type GameServer } from "../../src/server.js";
import { connect, tempDir, waitFor, type Agent } from "./helpers.js";

const ACCOUNT_TOOLS = ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "rating", "leaderboard", "create_handle", "rotate_key"];

function expectLocalText(text: string): void {
  expect(text).not.toContain("Accounts are required");
  expect(text).not.toMatch(/no join at the entry point/i);
  expect(text).not.toMatch(/ANTWARS_KEY|~\/\.antwars\/key|username/);
  for (const tool of ACCOUNT_TOOLS) expect(text, tool).not.toMatch(new RegExp(`\\b${tool}\\b`));
  expect(text).toMatch(/join \{reconnectToken\}; token is an alias/);
}

describe("the local route (no accounts, no slot) briefs without account or lobby text", () => {
  let server: GameServer | null = null;
  const agents: Agent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close();
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  it("join, rules and rejoin are accurate, and no account or lobby tool is served", async () => {
    // The comparison match copies its log to stdout; keep the test output readable.
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), ...comparisonOptions({ ANTWAR_RULES: "redesign", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG) });
    const joins = [];
    for (let i = 0; i < 2; i++) {
      const agent = await connect(server.port);
      agents.push(agent);
      joins.push(await agent.call("join", {}));
    }
    await waitFor(() => (server!.game.match?.state.tick ?? 0) >= 1);
    for (const joined of joins) {
      expect(joined.isError, joined.text).toBe(false);
      expectLocalText(joined.data.briefing as string);
    }
    const rules = await agents[0]!.call("rules", {});
    expect(rules.isError, rules.text).toBe(false);
    expectLocalText(rules.data.rules as string);

    // The second seat rejoins: its one join leaves room under the 2 calls per second limit.
    const again = await connect(server.port);
    agents.push(again);
    const rejoined = await again.call("join", { reconnectToken: joins[1]!.data.reconnectToken });
    expect(rejoined.isError, rejoined.text).toBe(false);
    expectLocalText(rejoined.data.briefing as string);

    const client = new Client({ name: "antwar-local-briefing-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`));
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain("join");
      for (const tool of ACCOUNT_TOOLS) expect(names).not.toContain(tool);
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close();
    }
  }, 30_000);
});
