// Where the seat key may go: never across a redirect, and over plain http only
// to this machine unless the builder opts in.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entryClient, matchClient } from "../lib/match.mjs";
import { ALLOW_HTTP_ENV, McpClient, McpHttpError, checkServerUrl } from "../lib/mcp.mjs";
import { fakeClock } from "./fake-server.mjs";

const KEY = "sk-antwars-test-redirect-5e1b";

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()();
});

/** A loopback HTTP server answering with handle(req, body, res); records every request it receives. */
async function listen(handle) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body });
      handle(req, body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, received };
}

/** An MCP endpoint that initializes normally and answers every tools/call with a redirect to target. */
function redirectingTools(status, target) {
  return (req, body, res) => {
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "0" } } }));
    } else if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else {
      res.writeHead(status, { location: target }).end();
    }
  };
}

/** A fetch that records what it was asked to send, standing in for the network. */
function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    throw new Error("no network in this test");
  };
  return { calls, fetchImpl };
}

describe("a request carrying the key is never re-sent across a redirect", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`HTTP ${status}: the call fails and the redirect target receives nothing`, async () => {
      const elsewhere = await listen((req, body, res) => res.writeHead(200).end("{}"));
      const server = await listen(redirectingTools(status, elsewhere.url));
      const client = new McpClient({ url: server.url, clock: fakeClock() });

      const failure = await client.callTool("join", { key: KEY, seat: 1 }).catch((error) => error);

      expect(failure).toBeInstanceOf(McpHttpError);
      expect(failure.status).toBe(status);
      expect(failure.message).toContain(new URL(server.url).host);
      expect(failure.message).toContain(new URL(elsewhere.url).host);
      expect(failure.message).not.toContain(KEY);
      expect(elsewhere.received).toEqual([]);
      // The keyed call reached the configured server exactly once.
      expect(server.received.filter((r) => r.body.includes(KEY))).toHaveLength(1);
    });
  }

  it("the match client, which retries handovers, does not re-send a redirected call either", async () => {
    const elsewhere = await listen((req, body, res) => res.writeHead(200).end("{}"));
    const server = await listen(redirectingTools(307, elsewhere.url));
    const client = new McpClient({ url: server.url, clock: fakeClock(), retryWindowMs: 60_000 });

    const failure = await client.callTool("observe", { key: KEY }).catch((error) => error);

    expect(failure).toBeInstanceOf(McpHttpError);
    expect(elsewhere.received).toEqual([]);
    expect(server.received.filter((r) => r.body.includes(KEY))).toHaveLength(1);
  });

  it("every send asks fetch not to follow redirects", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new McpClient({ url: "https://antwars.example/mcp", clock: fakeClock(), fetchImpl });
    await client.callTool("join", { key: KEY }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });
});

describe("plain http only to this machine unless explicitly allowed", () => {
  it("refuses a plain-http address on another host before anything is sent", async () => {
    const { calls, fetchImpl } = recordingFetch();
    let failure = null;
    try {
      new McpClient({ url: "http://antwars.example/mcp", clock: fakeClock(), fetchImpl });
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain("antwars.example");
    expect(failure?.message).toContain(`${ALLOW_HTTP_ENV}=1`);
    expect(calls).toEqual([]);
  });

  it.each(["http://localhost:8080/mcp", "http://127.0.0.1:9/mcp", "http://127.4.5.6/mcp", "http://[::1]:9/mcp", "https://antwars.example/mcp"])("accepts %s", (url) => {
    expect(() => checkServerUrl(url)).not.toThrow();
  });

  it.each(["http://antwars.example/mcp", "http://10.0.0.5/mcp", "http://127.0.0.1.example/mcp", "http://localhost.example/mcp"])("refuses %s without the opt-in", (url) => {
    expect(() => checkServerUrl(url)).toThrow(`${ALLOW_HTTP_ENV}=1`);
  });

  it("accepts plain http to another host with the opt-in", () => {
    expect(() => checkServerUrl("http://antwars.example/mcp", { allowHttp: true })).not.toThrow();
  });

  it.each(["ftp://antwars.example/mcp", "file:///tmp/mcp", "not a url"])("refuses %s even with the opt-in", (url) => {
    expect(() => checkServerUrl(url, { allowHttp: true })).toThrow(/Refusing/);
  });

  it(`the entry and match clients honour ${ALLOW_HTTP_ENV}=1 and refuse plain http to another host without it`, () => {
    const ctx = (env) => ({ config: { entryUrl: "http://antwars.example/mcp" }, env: { ANTWARS_SEAT_STATE: "/nonexistent-seat-state", ...env }, clock: fakeClock(), key: KEY, limiter: async () => {} });
    expect(() => entryClient(ctx({}))).toThrow("antwars.example");
    expect(() => matchClient(ctx({}), "http://match.antwars.example/mcp")).toThrow("match.antwars.example");
    expect(() => entryClient(ctx({ [ALLOW_HTTP_ENV]: "1" }))).not.toThrow();
    expect(() => matchClient(ctx({ [ALLOW_HTTP_ENV]: "1" }), "http://match.antwars.example/mcp")).not.toThrow();
  });
});
