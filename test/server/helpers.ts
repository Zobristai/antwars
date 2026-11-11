/// <reference types="node" />
import { mkdtempSync, readdirSync } from "node:fs";
import { loadReplayFile } from "../../src/live/replayOptions.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AccountStores } from "../../src/accounts/service.js";
import { createIdentities } from "../../src/identity/identities.js";
import { createWatchRegistry, type WatchRegistry } from "../../src/live/watch-registry.js";
import { createLobbies } from "../../src/lobby/lobbies.js";
import { createRatings } from "../../src/rating/ratings.js";
import type { LiveGame, SlotWiring } from "../../src/server.js";
import type { SimConfig } from "../../src/sim/config.js";
import type { SimInput } from "../../src/sim/types.js";
import { memoryWatchStore } from "../live/watch-fixtures.js";
import { TEST_CONFIG, TEST_MCP_CONFIG, type CallResult } from "../mcp/harness.js";

export { TEST_CONFIG, TEST_MCP_CONFIG };

/**
 * Short matches with every number these tests rely on set here, so a retune of
 * the sim's defaults moves none of them.
 */
export function shortConfig(matchTicks: number, overrides: Partial<SimConfig> = {}): SimConfig {
  return { ...TEST_CONFIG, ticksPerSecond: 10, matchTicks, startAnts: 30, colonyCap: 150, ...overrides };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "antwar-server-"));
}

export interface Agent {
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

/** An MCP SDK client on the server's /mcp, reading tool results as test/mcp/harness.ts does. */
export async function connect(port: number): Promise<Agent> {
  const client = new Client({ name: "antwar-server-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return {
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const content = r.content as { type: string; text?: string }[];
      return { isError: r.isError === true, text: content[0]?.text ?? "", data: r.structuredContent };
    },
    async close() {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
  };
}

/** Server options for the comparison run: one held match that starts once `players` accepted joins are queued. */
export function comparison(players: number) {
  return { match: "held", expectedPlayers: players } as const;
}

/**
 * Starts a comparison server's held match: `players` agents join over MCP, as a comparison run's
 * players do. With none to wait for, the barrier opens after the first reply on /mcp, so one plain
 * request there starts a match with no agents. Returns the agents still connected; the caller closes them.
 */
export async function startComparisonMatch(server: { readonly port: number; readonly game: LiveGame }, players: number): Promise<Agent[]> {
  const agents: Agent[] = [];
  for (let i = 0; i < players; i += 1) {
    const agent = await connect(server.port);
    agents.push(agent);
    const joined = await agent.call("join");
    if (joined.isError) throw new Error(`comparison join refused: ${joined.text}`);
  }
  if (players === 0) await (await fetch(`http://127.0.0.1:${server.port}/mcp`)).body?.cancel();
  await settle(() => server.game.match !== null);
  return agents;
}

/**
 * Poll until check() holds without a timer, so it also works under fake timers: the barrier
 * releases the held match on an immediate after the completing join's reply has gone out.
 */
export async function settle(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out settling");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A slot server's store-side wiring on one in-memory store: its lobbies and identities, the
 * account stores and watch registry a spectated slot server also needs, and seatLobby, which
 * fills one more public 1v1 lobby so this slot plays it in turn after the matches before it.
 */
export function memorySlot(options: { readonly countdownMs?: number } = {}): {
  readonly slot: SlotWiring;
  readonly accounts: AccountStores;
  readonly watchRegistry: WatchRegistry;
  seatLobby(): Promise<{ readonly lobbyId: string; readonly keys: readonly string[] }>;
} {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: options.countdownMs ?? 50 });
  let seats = 0;
  return {
    slot: { slot: "public-0", publicUrl: "http://slot.test", identities, lobbies, pollMs: 10 },
    accounts: { identities, lobbies, ratings: createRatings(store, identities) },
    watchRegistry: createWatchRegistry(store),
    async seatLobby() {
      const keys: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const claimed = await identities.claimUsername(`Seat${seats++}`);
        if (!claimed.ok) throw new Error(claimed.reason);
        keys.push(claimed.value.key);
      }
      const created = await lobbies.createLobby(keys[0]!, "public", 1);
      if (!created.ok) throw new Error(created.reason);
      for (const key of keys) {
        const seated = await lobbies.join(created.value.lobby.id, key);
        if (!seated.ok) throw new Error(seated.reason);
      }
      return { lobbyId: created.value.lobby.id, keys };
    },
  };
}

/** Poll until check() holds, every 2 ms; returns the time it was first seen to hold. */
export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return Date.now();
}

/** Match log files in dataDir, keyed by match seq (the number before .jsonl). */
export function matchLogs(dataDir: string): Map<number, string> {
  const logs = new Map<number, string>();
  for (const name of readdirSync(dataDir)) {
    const m = /^match-.*-(\d+)\.jsonl$/.exec(name);
    if (m !== null) logs.set(Number(m[1]), join(dataDir, name));
  }
  return logs;
}

export function logLines(path: string, holds?: string): string[] {
  return loadReplayFile(path, { holds }).lines.filter((line) => line !== "");
}

/** Every agent input logged in one match log. */
export function loggedInputs(path: string): SimInput[] {
  return logLines(path)
    .map((line) => JSON.parse(line) as { type?: string; inputs?: SimInput[] })
    .flatMap((entry) => (entry.type === "header" ? [] : (entry.inputs ?? [])));
}
