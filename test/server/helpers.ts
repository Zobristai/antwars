/// <reference types="node" />
import { mkdtempSync, readdirSync } from "node:fs";
import { loadReplayFile } from "../../src/live/replayOptions.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SimConfig } from "../../src/sim/config.js";
import type { SimInput } from "../../src/sim/types.js";
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
