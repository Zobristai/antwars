/// <reference types="node" />
import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_MAX_BODY_BYTES, createAccountApi, DEFAULT_ACCOUNT_API_OPTIONS, type AccountApi, type AccountApiOptions } from "../../src/accounts/httpApi.ts";
import { ACCOUNT_OPERATIONS, type AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

// Anonymous /api bodies get MCP's read deadline, a 16 KiB cap on bytes actually read, and their own
// count of bodies read at once, overall and per source. Documentation-range addresses only;
// no request reaches a store.

const open: ClientRequest[] = [];
const servers: Server[] = [];
const gameServers: GameServer[] = [];
afterEach(async () => {
  for (const req of open.splice(0)) req.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const server of gameServers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
}

interface Reply { status: number; retryAfter: string | null; connection: string | null; body: any }

/** /api alone on a plain server; requests here never get past argument validation. */
async function serveApi(options: Partial<AccountApiOptions> = {}): Promise<{ base: string; api: AccountApi }> {
  const api = createAccountApi({} as AccountStores, { ...DEFAULT_ACCOUNT_API_OPTIONS, ...options });
  const server = createServer((req, res) => void api(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, api };
}

/**
 * A POST whose body starts with `first` and is then held open: it is being read until the server
 * answers or the test ends it. contentLength omitted sends it chunked, with no Content-Length.
 */
function heldBody(url: string, { address, first = "{\"name\":", contentLength }: { address?: string; first?: string; contentLength?: number } = {}): Promise<Reply | null> {
  const req = httpRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
      ...(address === undefined ? {} : { "x-forwarded-for": address }) },
  });
  open.push(req);
  const reply = new Promise<Reply | null>((resolve) => {
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] ?? null, connection: res.headers.connection ?? null, body: JSON.parse(text) }));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
  });
  req.write(first);
  return reply;
}

/** A whole POST from a source. */
async function post(url: string, body: string, address?: string): Promise<Reply> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(address === undefined ? {} : { "x-forwarded-for": address }) }, body });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), connection: res.headers.get("connection"), body: await res.json() };
}

/** A claim_username body of exactly `bytes` bytes, whose name is too long to be valid. */
const bodyOf = (bytes: number): string => `{"name":"${"a".repeat(bytes - 11)}"}`;

function expectBusy(reply: Reply | null): void {
  expect([reply?.status, reply?.retryAfter, reply?.connection, reply?.body.error]).toEqual([503, "1", "close", "server_busy"]);
}

const TOO_LARGE = { error: "body_too_large", message: "Request body too large." };

/** Every operation's largest schema-valid body: each string at its .max, every code unit escaped as \u00XX. */
function worstBody(op: (typeof ACCOUNT_OPERATIONS)[number]): Record<string, unknown> {
  const unwrap = (schema: any): any => {
    let s = schema;
    while (["optional", "nullable", "default", "nonoptional"].includes(s._zod.def.type)) s = s._zod.def.innerType;
    return s;
  };
  const body: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(op.input.shape as Record<string, unknown>)) {
    const s = unwrap(schema);
    const def = s._zod.def as { type: string; entries?: Record<string, string> };
    if (def.type === "string") {
      // An unbounded string has no largest body: the cap could refuse a valid call.
      expect(s.maxLength, `${op.name}.${field} has no maximum length`).toBeTypeOf("number");
      body[field] = "\u0001".repeat(s.maxLength as number);
    } else if (def.type === "number") body[field] = s.maxValue;
    else if (def.type === "boolean") body[field] = false;
    else if (def.type === "enum") body[field] = Object.values(def.entries!).sort((a, b) => b.length - a.length)[0];
    else throw new Error(`${op.name}.${field}: no largest value for a ${def.type} field; extend this test`);
  }
  return body;
}

describe("/api body reads", () => {
  it("caps bodies at 16 KiB and uses MCP's deadline and body-read cap values", () => {
    expect(API_MAX_BODY_BYTES).toBe(16_384);
    expect(DEFAULT_ACCOUNT_API_OPTIONS).toEqual({ bodyReadMs: 10_000, maxBodies: 128, maxBodiesPerSource: 4 });
  });

  it("keeps every operation's largest schema-valid body within half the cap", () => {
    for (const op of ACCOUNT_OPERATIONS) {
      const body = worstBody(op);
      expect(op.input.safeParse(body).success, op.name).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(body), "utf8"), op.name).toBeLessThanOrEqual(API_MAX_BODY_BYTES / 2);
    }
  });

  it("reads a body of exactly the cap and refuses one byte more with 413, closing the connection", async () => {
    const { base, api } = await serveApi();
    expect((await post(`${base}/claim_username`, bodyOf(API_MAX_BODY_BYTES))).body.error).toBe("bad_arguments");
    const over = await post(`${base}/claim_username`, bodyOf(API_MAX_BODY_BYTES + 1));
    expect([over.status, over.connection, over.body]).toEqual([413, "close", TOO_LARGE]);
    expect(api.bodyReads).toBe(0);
  });

  it("counts bytes actually read: a chunked body with no Content-Length is refused 413 once past the cap, without waiting for its end", async () => {
    const { base, api } = await serveApi({ bodyReadMs: 30_000 });
    const reply = await heldBody(`${base}/claim_username`, { first: `{"name":"${"a".repeat(API_MAX_BODY_BYTES)}` });
    expect([reply?.status, reply?.connection, reply?.body]).toEqual([413, "close", TOO_LARGE]);
    expect(api.bodyReads).toBe(0);
  });

  it("refuses a body past the cap whatever its Content-Length claims", async () => {
    const { base } = await serveApi({ bodyReadMs: 30_000 });
    const declared = API_MAX_BODY_BYTES * 4;
    const reply = await heldBody(`${base}/claim_username`, { first: `{"name":"${"a".repeat(API_MAX_BODY_BYTES)}`, contentLength: declared });
    expect([reply?.status, reply?.body]).toEqual([413, TOO_LARGE]);
  });

  it("answers a body that does not arrive within the deadline 408, closes its connection and frees its place", async () => {
    const { base, api } = await serveApi({ bodyReadMs: 200 });
    const startedAt = Date.now();
    const pending = heldBody(`${base}/claim_username`, { address: "192.0.2.1" });
    await until(() => api.bodyReads === 1);
    const reply = await pending;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect([reply?.status, reply?.connection, reply?.body.error]).toEqual([408, "close", "body_timeout"]);
    expect(api.bodyReads).toBe(0);
    // A whole body is still read.
    expect((await post(`${base}/claim_username`, "{}", "192.0.2.1")).body.error).toBe("bad_arguments");
  });

  it("refuses a fifth body from one source, by its last forwarded hop, before reading it, while other sources are served", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { base, api } = await serveApi({ bodyReadMs: 30_000 });
    for (let i = 0; i < 4; i += 1) void heldBody(`${base}/claim_username`, { address: `203.0.113.${i}, 192.0.2.1` });
    await until(() => api.bodyReads === 4);
    expectBusy(await post(`${base}/claim_username`, "{}", "192.0.2.1"));
    expectBusy(await post(`${base}/claim_username`, "{}", "203.0.113.200, 192.0.2.1"));
    expect((await post(`${base}/claim_username`, "{}", "198.51.100.7")).body.error).toBe("bad_arguments");
    // A body that ends frees its source's place.
    open[0]!.destroy();
    await until(() => api.bodyReads === 3);
    expect((await post(`${base}/claim_username`, "{}", "192.0.2.1")).body.error).toBe("bad_arguments");
  });

  it("refuses a request past the overall cap with a retryable 503 before reading its body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { base, api } = await serveApi({ bodyReadMs: 30_000, maxBodies: 3 });
    for (const address of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) void heldBody(`${base}/claim_username`, { address });
    await until(() => api.bodyReads === 3);
    expectBusy(await post(`${base}/claim_username`, "{}", "198.51.100.7"));
    expect(api.bodyReads).toBe(3);
  });

  it("counts /api bodies apart from MCP's: with 128 /api bodies being read, /api refuses while a new MCP agent is served", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createFirestore({ projectId: "demo-antwar", namespace: "unreachable", request: async () => { throw new TypeError("network down"); } });
    const identities = createIdentities(store);
    const accounts: AccountStores = { identities, lobbies: createLobbies(store, identities), ratings: createRatings(store) };
    const server = await startServer({
      port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(60_000)),
      mcpConfig: { ...TEST_MCP_CONFIG, bodyReadMs: 30_000 }, accounts,
    });
    gameServers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    // 128 from 32 sources, 4 each: the server's default /api cap.
    for (let i = 0; i < 128; i += 1) void heldBody(`${base}/api/claim_username`, { address: `192.0.2.${1 + Math.floor(i / 4)}` });
    await until(async () => (await post(`${base}/api/claim_username`, "{}", "198.51.100.7")).status === 503);
    const initialize = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "198.51.100.8" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } }),
    });
    expect(initialize.status).toBe(200);
    await initialize.body?.cancel();
  });
});
