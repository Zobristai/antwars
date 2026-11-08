/// <reference types="node" />
import { request as httpRequest, type ClientRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../src/mcp/config.ts";
import { TEST_MCP_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.ts";

// MCP request bodies have a read deadline, and bodies being read for requests not from a joined
// seat are capped overall and per source. Documentation-range addresses only.

let h: Harness | null = null;
const open: ClientRequest[] = [];
afterEach(async () => {
  for (const req of open.splice(0)) req.destroy();
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
}

interface Reply { status: number; retryAfter: string | null; connection: string | null; text: string }

/**
 * A POST whose body starts but never finishes: it is being read until the deadline or until the
 * test ends it.
 */
function slowBody(url: URL, address?: string) {
  const req = httpRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": "4096",
      ...(address === undefined ? {} : { "x-forwarded-for": address }) },
  });
  open.push(req);
  const reply = new Promise<Reply | null>((resolve) => {
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] ?? null, connection: res.headers.connection ?? null, text }));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
  });
  req.write('{"jsonrpc":"2.0",');
  return reply;
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } };

/** A whole initialize POST from a source. */
async function initialize(url: URL, address?: string): Promise<Reply> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(address === undefined ? {} : { "x-forwarded-for": address }) },
    body: JSON.stringify(INITIALIZE),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), connection: res.headers.get("connection"), text: await res.text() };
}

function expectBusy(reply: Reply | null): void {
  expect(reply).not.toBeNull();
  expect([reply!.status, reply!.retryAfter, reply!.connection]).toEqual([503, "1", "close"]);
  const body = JSON.parse(reply!.text) as { jsonrpc: string; error: { message: string } };
  expect(body.jsonrpc).toBe("2.0");
  expect(body.error.message).toMatch(/retry/i);
}

async function joinedAgent(harness: Harness): Promise<TestAgent> {
  const agent = await harness.connect();
  const joined = await agent.call("join");
  expect(joined.isError, joined.text).toBe(false);
  return agent;
}

const config = (overrides: Partial<McpConfig>): McpConfig => ({ ...TEST_MCP_CONFIG, ...overrides });

describe("MCP body reads", () => {
  it("defaults to a 10 s read deadline, 128 bodies read at once and 4 per source", () => {
    expect([DEFAULT_MCP_CONFIG.bodyReadMs, DEFAULT_MCP_CONFIG.maxUnadmittedBodies, DEFAULT_MCP_CONFIG.maxUnadmittedBodiesPerSource]).toEqual([10_000, 128, 4]);
  });

  it("answers a body that does not arrive within the deadline 408, closes its connection and frees its place", async () => {
    h = await startHarness({ mcpConfig: config({ bodyReadMs: 200 }) });
    const startedAt = Date.now();
    const pending = slowBody(h.url, "192.0.2.1");
    await until(() => h!.handler.unadmittedBodyReads === 1);
    const reply = await pending;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect([reply?.status, reply?.connection]).toEqual([408, "close"]);
    expect(JSON.parse(reply!.text).error.message).toMatch(/not received in time/);
    expect(h.handler.unadmittedBodyReads).toBe(0);
    // A whole body is still served.
    expect((await initialize(h.url, "192.0.2.1")).status).toBe(200);
  });

  it("refuses a request past the overall cap with a retryable 503 before reading its body, while a joined seat is still served", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h = await startHarness({ mcpConfig: config({ maxUnadmittedBodies: 3, maxUnadmittedBodiesPerSource: 4, bodyReadMs: 30_000 }) });
    const seat = await joinedAgent(h);
    const unjoined = await h.connect();
    for (const address of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) void slowBody(h.url, address);
    await until(() => h!.handler.unadmittedBodyReads === 3);
    expectBusy(await initialize(h.url, "198.51.100.7"));
    expectBusy(await slowBody(h.url, "198.51.100.8"));
    // A session not joined to a seat is counted like any other request.
    await expect(unjoined.client.ping()).rejects.toThrow(/Server busy/);
    // A joined seat's request is never counted.
    await expect(seat.client.ping()).resolves.toBeDefined();
    expect(h.handler.unadmittedBodyReads).toBe(3);
    // A body that ends frees its place.
    open[0]!.destroy();
    await until(() => h!.handler.unadmittedBodyReads === 2);
    expect((await initialize(h.url, "198.51.100.7")).status).toBe(200);
  });

  it("bounds one source, by its last forwarded hop, under the default caps: a fifth body from it is refused while other sources and joined seats are served", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h = await startHarness({ mcpConfig: config({ bodyReadMs: 30_000 }) });
    const seat = await joinedAgent(h);
    for (let i = 0; i < 4; i += 1) void slowBody(h.url, `203.0.113.${i}, 192.0.2.1`);
    await until(() => h!.handler.unadmittedBodyReads === 4);
    expectBusy(await initialize(h.url, "192.0.2.1"));
    expectBusy(await initialize(h.url, "203.0.113.200, 192.0.2.1"));
    expect((await initialize(h.url, "198.51.100.7")).status).toBe(200);
    await expect(seat.client.ping()).resolves.toBeDefined();
  });

  it("keeps serving a joined seat and an existing seat client's join while 128 bodies are being read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h = await startHarness({ mcpConfig: config({ bodyReadMs: 30_000 }) });
    const seat = await joinedAgent(h);
    // Requests with no client hop share one key: they are bounded at 4 like one source.
    for (let i = 0; i < 4; i += 1) void slowBody(h.url);
    // 124 more from 31 sources, 4 each: 128 in all.
    for (let i = 0; i < 124; i += 1) void slowBody(h.url, `192.0.2.${1 + Math.floor(i / 4)}`);
    await until(() => h!.handler.unadmittedBodyReads === 128);
    expectBusy(await initialize(h.url, "198.51.100.7"));
    await expect(seat.client.ping()).resolves.toBeDefined();
    // Once one body is freed, a new agent can connect and join.
    open[0]!.destroy();
    await until(() => h!.handler.unadmittedBodyReads === 127);
    expect((await joinedAgent(h)).transport.sessionId).toBeDefined();
  });
});
