/// <reference types="node" />
import { deepStrictEqual } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SimConfig } from "../../src/sim/config.js";
import { playable } from "../playable.ts";
import { HISTORICAL_DEFAULT_CONFIG } from "../sim/fixtures.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../src/mcp/config.js";
import { Game, type SlotAccess } from "../../src/mcp/game.js";
import { createMcpHandler, type McpHandler } from "../../src/mcp/http.js";
import type { SimInput, SimState } from "../../src/sim/types.js";

/**
 * The values these tests rely on, set explicitly so a retune of the sim's
 * defaults does not move them. The timer and floor keep the intended
 * 90 s and 10 s at 10 ticks per second.
 */
export const TEST_CONFIG: SimConfig = {
  ...HISTORICAL_DEFAULT_CONFIG,
  ticksPerSecond: 10,
  matchTicks: 6000,
  hatchIntervalTicks: 18,
  mapWidth: 64,
  mapHeight: 48,
  sightTiles: 4,
  smellTiles: 8,
  squadSize: 6,
  squadSupplyPermille: 500,
  squadTimerTicks: 900,
  commandFloorTicks: 100,
  intentMaxChars: 80,
  markMaxWords: 3,
  marksPerAgent: 3,
  markLifetimeTicks: 1800,
  combatGraceTicks: 600,
  overrunGraceTicks: 600,
};

/** No rate limit unless a test asks for one; the clock is frozen unless a test moves it. */
// Tests jump the match clock freely; the one idle rule is exercised by tests that set their own limit.
export const TEST_MCP_CONFIG: McpConfig = { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1_000_000, houseIdleSeconds: 86_400 };

export interface CallResult {
  readonly isError: boolean;
  readonly text: string;
  // Tool results are JSON; tests read them structurally.
  readonly data: any;
}

export interface TestAgent {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  /** DELETE the MCP session, then close the client. */
  end(): Promise<void>;
}

export interface Harness {
  readonly game: Game;
  readonly handler: McpHandler;
  readonly url: URL;
  /** Every match log line, in order. */
  readonly log: string[];
  /** Every call reply line the game handed to its match recording (Game onReply), in order. */
  readonly replies: { readonly seq: number; readonly line: string }[];
  readonly clock: { now: number };
  connect(): Promise<TestAgent>;
  /** Step n ticks with no calls. */
  advance(n: number): void;
  /** The logged inputs of one agent, in order. */
  inputsOf(agentId: string): SimInput[];
  close(): Promise<void>;
}

export async function startHarness(
  options: { simConfig?: SimConfig; mcpConfig?: McpConfig; seed?: number; state?: SimState; start?: boolean; slot?: SlotAccess; perSourceInitializeLimit?: boolean; extraTools?: (server: McpServer) => void } = {},
): Promise<Harness> {
  const log: string[] = [];
  const replies: { seq: number; line: string }[] = [];
  const clock = { now: 0 };
  let scheduled = false;
  const game: Game = new Game({
    simConfig: playable(options.simConfig ?? TEST_CONFIG),
    slot: options.slot,
    mcpConfig: options.mcpConfig ?? TEST_MCP_CONFIG,
    now: () => clock.now,
    onLogLine: (line) => log.push(line),
    onReply: (seq, line) => replies.push({ seq, line }),
    // Tick as soon as calls are waiting, so time moves only with calls and advance().
    onInputQueued: () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        game.tick();
      });
    },
  });
  if (options.start !== false) {
    game.startMatch(options.seed ?? 1, options.state === undefined ? {} : { state: options.state });
  }
  const handler = createMcpHandler(game, {
    now: () => clock.now,
    perSourceInitializeLimit: options.perSourceInitializeLimit,
    ...(options.extraTools === undefined ? {} : { extraTools: options.extraTools }),
  });
  const server: Server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/mcp") void handler.handle(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const agents: TestAgent[] = [];

  return {
    game,
    handler,
    url,
    log,
    replies,
    clock,
    async connect() {
      const client = new Client({ name: "antwar-test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      const agent: TestAgent = {
        client,
        transport,
        async call(name, args = {}) {
          const r = await client.callTool({ name, arguments: args });
          const content = r.content as { type: string; text?: string }[];
          const text = content[0]?.text ?? "";
          deepStrictEqual(JSON.parse(text), r.structuredContent, `${name}: text and structuredContent must be identical whole-document JSON`);
          return { isError: r.isError === true, text, data: r.structuredContent };
        },
        async end() {
          if (transport.sessionId !== undefined) await transport.terminateSession().catch(() => {});
          await client.close();
        },
      };
      agents.push(agent);
      return agent;
    },
    advance(n) {
      for (let i = 0; i < n; i += 1) game.tick();
    },
    inputsOf(agentId) {
      return log
        .map((line) => JSON.parse(line) as { type?: string; inputs?: SimInput[] })
        .flatMap((entry) => (entry.type === "header" ? [] : (entry.inputs ?? [])))
        .filter((input) => input.agentId === agentId);
    },
    async close() {
      for (const a of agents) await a.end();
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
