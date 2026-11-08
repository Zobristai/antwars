/// <reference types="node" />
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { startServer, type GameServer } from "../../src/server.js";
import { connect, matchLogs, shortConfig, tempDir, TEST_MCP_CONFIG, waitFor, type Agent } from "./helpers.js";
import { playable } from "../playable.ts";

let server: GameServer | null = null;
const agents: Agent[] = [];
let stdout: MockInstance<typeof console.log>;
let stderr: MockInstance<typeof console.error>;
let warn: MockInstance<typeof console.warn>;
const uncaught: unknown[] = [];
const onUncaught = (err: unknown): void => void uncaught.push(err);

beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  await server?.close();
  server = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.off("uncaughtException", onUncaught);
});

const lines = (spy: MockInstance<(...args: any[]) => void>): string[] => spy.mock.calls.map((args) => args.map(String).join(" "));
/** Everything the server printed, to stdout or stderr. */
const printed = (): string => [...lines(stdout), ...lines(stderr), ...lines(warn)].join("\n");

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hardening-test", version: "0.0.0" } },
};

function postInitialize(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(INITIALIZE),
  });
}

describe("a failed match-log write or prune does not end the server", () => {
  it("a match-log write that fails mid-match is reported on stderr, and the server and match carry on to the result", async () => {
    const dataDir = tempDir();
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, match: "held", simConfig: playable(shortConfig(30)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    s.startMatch();
    // The log file becomes a directory: the next appended line fails with EISDIR inside the tick timer.
    const logPath = matchLogs(dataDir).get(1)!;
    rmSync(logPath);
    mkdirSync(logPath);

    const agent = await connect(s.port);
    agents.push(agent);
    // The join is a sim input, so the next tick writes a log line for it.
    const joined = agent.call("join");
    joined.catch(() => {}); // on the unfixed server the tick dies and the join never settles

    await waitFor(() => s.game.match!.result !== null || uncaught.length > 0, 8_000);
    expect(uncaught).toEqual([]);
    expect(s.game.match!.result).not.toBeNull();
    expect((await joined).isError).toBe(false);
    expect(lines(stderr).some((l) => l.includes("match 1") && l.includes("log write failed") && l.includes("EISDIR"))).toBe(true);
    // Still serving: a GET without a session is answered 400.
    expect((await fetch(`http://127.0.0.1:${s.port}/mcp`)).status).toBe(400);
  }, 15_000);

  it("a prune that fails at match start is reported on stderr, and the match still starts and runs to its result", async () => {
    const dataDir = tempDir();
    // The oldest "log" is a non-empty directory, which the prune cannot remove.
    const stuck = join(dataDir, "match-2000-01-01T00-00-00-000Z-7.jsonl");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "keep"), "x");
    writeFileSync(join(dataDir, "match-2000-01-01T00-00-01-000Z-8.jsonl"), "{}\n");

    server = await startServer({ port: 0, host: "127.0.0.1", dataDir, match: "immediate", maxMatchLogs: 1, simConfig: playable(shortConfig(5)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    expect(s.game.match?.seq).toBe(1);
    await waitFor(() => s.game.match!.result !== null, 5_000);
    expect(uncaught).toEqual([]);
    expect(lines(stderr).some((l) => l.includes("prune") && l.includes("failed"))).toBe(true);
  });
});

describe("a 500 logs its method, route class and cause, never the URL or query", () => {
  it("through a mounted route", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", mcpConfig: TEST_MCP_CONFIG });
    server.mount("/boom", () => {
      throw new Error("mount exploded");
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/boom/secret-path-q1?key=query-value-q1`);
    expect(res.status).toBe(500);
    const line = lines(stderr).find((l) => l.includes("500"));
    expect(line).toBeDefined();
    expect(line).toContain("GET /boom");
    expect(line).toContain("mount exploded");
    expect(printed()).not.toContain("secret-path-q1");
    expect(printed()).not.toContain("query-value-q1");
  });

  it("through /mcp", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", mcpConfig: TEST_MCP_CONFIG });
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockRejectedValueOnce(new Error("transport exploded"));
    const res = await postInitialize(`http://127.0.0.1:${server.port}/mcp?key=query-value-q2`);
    expect(res.status).toBe(500);
    const line = lines(stderr).find((l) => l.includes("500"));
    expect(line).toBeDefined();
    expect(line).toContain("POST /mcp:");
    expect(line).toContain("transport exploded");
    expect(printed()).not.toContain("query-value-q2");
  });
});

describe("match start, match end and late ticks are logged", () => {
  it("one stdout line marks the match start and one marks its end", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(5)), mcpConfig: TEST_MCP_CONFIG });
    const s = server;
    await waitFor(() => s.game.match!.result !== null, 5_000);
    const out = lines(stdout);
    expect(out.filter((l) => l.includes("match 1 started"))).toHaveLength(1);
    expect(out.filter((l) => l.includes("match 1 ended"))).toHaveLength(1);
    expect(out.find((l) => l.includes("match 1 ended"))).toContain("5 ticks");
  });

  it("a tick that runs late produces one warning; ticks on time produce none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "held", simConfig: playable(shortConfig(100)), mcpConfig: TEST_MCP_CONFIG });
    server.startMatch();
    vi.advanceTimersByTime(500); // five ticks, each exactly on time
    expect(server.game.match!.state.tick).toBe(5);
    expect(lines(warn)).toEqual([]);

    // The clock jumps a second without the timers firing, as when the event loop stalls.
    vi.setSystemTime(Date.now() + 1_000);
    vi.advanceTimersByTime(100);
    const warnings = lines(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("match 1");
    expect(warnings[0]).toContain("late");
    // Caught up: further ticks are on time again and add no warning.
    vi.advanceTimersByTime(500);
    expect(lines(warn)).toHaveLength(1);
  });
});

describe("a publish that throws does not stop the match", () => {
  it("a feed failure is logged in one bounded line without match state, and the match ticks on to its own result", async () => {
    const ticked: number[] = [];
    const feed = {
      matchStarted() {},
      ticked(_seq: number, out: { state: { tick: number } }) {
        ticked.push(out.state.tick);
        if (ticked.length === 3) throw new Error(`feed broke\n${"x".repeat(1000)}`);
      },
    };
    server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(30)), mcpConfig: TEST_MCP_CONFIG, feed });
    const s = server;
    await waitFor(() => s.game.match!.result !== null || uncaught.length > 0, 8_000);
    expect(uncaught).toEqual([]);
    // Its own result at its full length, not abandoned, and every later tick still reached the feed.
    expect(s.game.match!.result).toMatchObject({ reason: "time_up" });
    expect(ticked.length).toBeGreaterThan(3);
    expect(ticked.at(-1)).toBe(s.game.match!.state.tick);
    const failed = lines(stderr).filter((l) => l.includes("failed in feed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^antwar match 1 tick \d+ failed in feed: Error: feed broke x+$/);
    expect(failed[0]!.length).toBeLessThan(260);
  });
});
