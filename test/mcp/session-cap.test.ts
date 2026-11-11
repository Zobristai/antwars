/// <reference types="node" />
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAccountTools } from "../../src/accounts/mcpTools.js";
import { createIdentities } from "../../src/identity/identities.js";
import type { Fields, Store, Write } from "../../src/store/firestore.js";
import type { AccountStores } from "../../src/accounts/service.js";
import { agentsPerColony, DEFAULT_MCP_CONFIG, type McpConfig } from "../../src/mcp/config.js";
import { Game, type SlotAccess } from "../../src/mcp/game.js";
import { createMcpHandler, type McpHandler } from "../../src/mcp/http.js";
import type { SessionState } from "../../src/mcp/tools.js";
import { FIRESTORE_RPC_TIMEOUT_MS } from "../../src/store/firestore.js";
import { TEST_MCP_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";

/** Every session's state as the handler creates it, so a test can release a seat no tool releases. */
const sessionStates = vi.hoisted(() => [] as SessionState[]);
vi.mock("../../src/mcp/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/tools.js")>();
  return {
    ...actual,
    registerTools: (...args: Parameters<typeof actual.registerTools>) => {
      sessionStates.push(args[2]);
      return actual.registerTools(...args);
    },
  };
});

let h: Harness | null = null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The shielded share must stay below the cap, so a small cap brings it down too. */
const capped = (maxOpenSessions: number) => ({
  mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions, maxProtectedSessions: Math.min(TEST_MCP_CONFIG.maxProtectedSessions, maxOpenSessions - 1) },
});
const MINUTE = 60_000;

interface RawReply {
  readonly status: number;
  readonly sessionId: string | null;
  readonly text: string;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } },
};

/** One raw initialize POST, so a test can read the refusal itself and fire several at once. */
async function rawInitialize(
  url: URL,
  accept = "application/json, text/event-stream",
  { contentType = "application/json", body = INITIALIZE as unknown, forwardedFor }: { contentType?: string; body?: unknown; forwardedFor?: string } = {},
): Promise<RawReply> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType, accept, ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text: await res.text() };
}

function expectServerFull(r: { status: number; text: string }): void {
  expect(r.status).toBe(503);
  const body = JSON.parse(r.text) as { jsonrpc: string; error: { message: string } };
  expect(body.jsonrpc).toBe("2.0");
  expect(body.error.message).toMatch(/server is full/i);
  expect(body.error.message).toMatch(/retry later/i);
}

/** A raw request on an existing session, so a test can see whether the server still knows it. */
async function rawPing(url: URL, sessionId: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  await res.text();
  return res.status;
}

const idOf = (agent: TestAgent): string => agent.transport.sessionId!;

async function joinedAgent(harness: Harness): Promise<TestAgent> {
  const agent = await harness.connect();
  const joined = await agent.call("join");
  expect(joined.isError, joined.text).toBe(false);
  return agent;
}

describe("open-session cap", () => {
  it("the default cap is comfortably above the per-match agent cap", () => {
    expect(DEFAULT_MCP_CONFIG.maxOpenSessions).toBeGreaterThanOrEqual(2 * DEFAULT_MCP_CONFIG.maxAgentsPerMatch);
  });

  it("a handler refuses to start unless the shielded share is below the cap", () => {
    for (const maxProtectedSessions of [3, 4]) {
      const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions } });
      expect(() => createMcpHandler(game)).toThrow(/maxProtectedSessions \(\d+\) must be less than maxOpenSessions \(3\)/);
    }
    const handler = createMcpHandler(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions: 2 } }));
    cleanups.push(() => handler.close());
    expect(handler.sessionCount).toBe(0);
  });

  it("a handler refuses to start unless the idle window exceeds the store's RPC timeout", () => {
    for (const sessionIdleMs of [FIRESTORE_RPC_TIMEOUT_MS - 1, FIRESTORE_RPC_TIMEOUT_MS]) {
      const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, sessionIdleMs } });
      expect(() => createMcpHandler(game)).toThrow(`sessionIdleMs (${sessionIdleMs}) must exceed the store's RPC timeout (${FIRESTORE_RPC_TIMEOUT_MS})`);
    }
    const handler = createMcpHandler(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, sessionIdleMs: FIRESTORE_RPC_TIMEOUT_MS + 1 } }));
    cleanups.push(() => handler.close());
    expect(handler.sessionCount).toBe(0);
  });

  it("the protected share leaves room for every seat and still more evictable places", () => {
    expect(DEFAULT_MCP_CONFIG.maxProtectedSessions).toBeGreaterThan(0);
    expect(DEFAULT_MCP_CONFIG.maxProtectedSessions).toBeLessThanOrEqual(DEFAULT_MCP_CONFIG.maxOpenSessions / 2);
    expect(DEFAULT_MCP_CONFIG.maxProtectedSessions + 2 * DEFAULT_MCP_CONFIG.maxAgentsPerMatch).toBeLessThan(DEFAULT_MCP_CONFIG.maxOpenSessions);
  });

  it("when every open session is joined, the next initialize is refused as server full and the count stays at the cap", async () => {
    h = await startHarness(capped(2));
    await joinedAgent(h);
    await joinedAgent(h);
    expect(h.handler.sessionCount).toBe(2);

    expectServerFull(await rawInitialize(h.url));
    await expect(h.connect()).rejects.toThrow();
    expect(h.handler.sessionCount).toBe(2);
  });

  it("concurrent initializes do not overshoot the cap and never evict a joined session", async () => {
    h = await startHarness(capped(3));
    const a = await joinedAgent(h);
    const b = await joinedAgent(h);
    const results = await Promise.all(Array.from({ length: 8 }, () => rawInitialize(h!.url)));
    const admitted = results.filter((r) => r.status === 200);
    expect(admitted.length).toBeGreaterThanOrEqual(1);
    expect(admitted.every((r) => r.sessionId !== null)).toBe(true);
    for (const r of results.filter((r) => r.status !== 200)) expectServerFull(r);
    expect(h.handler.sessionCount).toBe(3);
    expect(h.handler.hasSession(idOf(a))).toBe(true);
    expect(h.handler.hasSession(idOf(b))).toBe(true);
  });

  it("an initialize that fails before a session is stored does not hold a slot", async () => {
    h = await startHarness(capped(1));
    // The SDK rejects an initialize that does not accept an event stream, before any session exists.
    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(h.url, "application/json")).status).toBe(406);
    expect(h.handler.sessionCount).toBe(0);
    await joinedAgent(h);
    expect(h.handler.sessionCount).toBe(1);
    expectServerFull(await rawInitialize(h.url));
  });

  it("at the cap, an initialize the transport would reject evicts nothing; only a valid one evicts", async () => {
    h = await startHarness(capped(2));
    const oldest = await h.connect();
    const newer = await h.connect();
    expect(h.handler.sessionCount).toBe(2);

    const { jsonrpc: _jsonrpc, ...noJsonrpc } = INITIALIZE;
    const malformed: [string, Promise<RawReply>][] = [
      ["no event-stream accept", rawInitialize(h.url, "application/json")],
      ["no accept", rawInitialize(h.url, "")],
      ["text content type", rawInitialize(h.url, undefined, { contentType: "text/plain" })],
      ["not JSON-RPC", rawInitialize(h.url, undefined, { body: noJsonrpc })],
      ["batch", rawInitialize(h.url, undefined, { body: [INITIALIZE, INITIALIZE] })],
    ];
    for (const [label, reply] of malformed) {
      const r = await reply;
      expect(r.status, label).toBeGreaterThanOrEqual(400);
      expect(r.status, label).toBeLessThan(500);
      expect(r.sessionId, label).toBeNull();
    }
    expect(h.handler.sessionCount).toBe(2);
    expect(h.handler.hasSession(idOf(oldest))).toBe(true);
    expect(h.handler.hasSession(idOf(newer))).toBe(true);

    expect((await rawInitialize(h.url)).status).toBe(200);
    expect(h.handler.hasSession(idOf(oldest))).toBe(false);
    expect(h.handler.hasSession(idOf(newer))).toBe(true);
  });

  it("at the cap, closing a session frees its slot and a new initialize succeeds", async () => {
    h = await startHarness(capped(2));
    const first = await joinedAgent(h);
    await joinedAgent(h);
    expectServerFull(await rawInitialize(h.url));

    await first.transport.terminateSession();
    expect(h.handler.sessionCount).toBe(1);
    await h.connect();
    expect(h.handler.sessionCount).toBe(2);
  });

  it("joined sessions keep the idle expiry: expired by the sweep they free their slots and a new initialize succeeds", async () => {
    h = await startHarness(capped(2));
    await joinedAgent(h);
    await joinedAgent(h);
    expectServerFull(await rawInitialize(h.url));

    h.clock.now += TEST_MCP_CONFIG.sessionIdleMs + 1;
    await h.handler.sweep();
    expect(h.handler.sessionCount).toBe(0);
    await h.connect();
    expect(h.handler.sessionCount).toBe(1);
  });

  it("while the cap is reached, a joined agent keeps playing: observe and an order succeed", async () => {
    h = await startHarness(capped(2));
    const player = await h.connect();
    const joined = await player.call("join");
    expect(joined.isError, joined.text).toBe(false);
    await joinedAgent(h);
    expectServerFull(await rawInitialize(h.url));

    const observed = await player.call("observe");
    expect(observed.isError, observed.text).toBe(false);
    expect(observed.data.view.agentId).toBe(joined.data.agentId);
    const ordered = await player.call("order", { kind: "hold" });
    expect(ordered.isError, ordered.text).toBe(false);
    expect(h.handler.sessionCount).toBe(2);
  });
});

describe("unjoined sessions cannot hold the cap", () => {
  it("regression: with the cap filled by unjoined sessions that keep pinging, a new initialize is admitted and joins a seat", async () => {
    h = await startHarness(capped(3));
    const attackers = [await h.connect(), await h.connect(), await h.connect()];
    // Each round refreshes every attacker session inside the idle limit.
    for (let round = 0; round < 4; round += 1) {
      h.clock.now += 4 * MINUTE;
      for (const a of attackers) expect(await rawPing(h.url, idOf(a))).toBe(200);
      await h.handler.sweep();
      expect(h.handler.sessionCount).toBe(3);
    }

    const victim = await h.connect();
    const joined = await victim.call("join");
    expect(joined.isError, joined.text).toBe(false);
    expect(h.handler.sessionCount).toBe(3);
    // The oldest attacker session made room, however recently it pinged; the others remain.
    expect(h.handler.hasSession(idOf(attackers[0]!))).toBe(false);
    expect(await rawPing(h.url, idOf(attackers[0]!))).toBe(404);
    expect(h.handler.hasSession(idOf(attackers[1]!))).toBe(true);
    expect((await victim.call("observe")).isError).toBe(false);
  });

  it("joined sessions are never evicted to make room; only unjoined ones are", async () => {
    h = await startHarness(capped(2));
    const player = await joinedAgent(h);
    const idle = await h.connect();

    const first = await rawInitialize(h.url);
    expect(first.status).toBe(200);
    expect(h.handler.hasSession(idOf(idle))).toBe(false);
    const second = await rawInitialize(h.url);
    expect(second.status).toBe(200);
    expect(h.handler.hasSession(first.sessionId!)).toBe(false);
    expect(h.handler.hasSession(idOf(player))).toBe(true);
    expect((await player.call("observe")).isError).toBe(false);
    expect(h.handler.sessionCount).toBe(2);
  });

  it("under a sustained initialize flood every initialize is admitted, an agent joins between bursts and keeps playing", async () => {
    const cap = 4;
    h = await startHarness(capped(cap));
    let victim: TestAgent | undefined;
    for (let round = 0; round < 6; round += 1) {
      const burst = await Promise.all(Array.from({ length: cap + 2 }, () => rawInitialize(h!.url)));
      expect(burst.map((r) => r.status)).toEqual(Array.from({ length: cap + 2 }, () => 200));
      expect(h.handler.sessionCount).toBe(cap);
      if (round === 2) victim = await joinedAgent(h);
      if (victim !== undefined) {
        expect(h.handler.hasSession(idOf(victim))).toBe(true);
        expect((await victim.call("observe")).isError).toBe(false);
      }
      h.clock.now += 4 * MINUTE;
      await h.handler.sweep();
    }
    expect(victim).toBeDefined();
    expect((await victim!.call("order", { kind: "hold" })).isError).toBe(false);
  });
});

/** A slot whose key lookup waits for the test, so a flood can overlap the real seat join. */
function gatedSlot(): { slot: SlotAccess; lookupStarted: Promise<void>; release: () => void } {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
  const slot: SlotAccess = {
    identityOf: async (key) => {
      started();
      await gate;
      return key === "ann-key" ? "ann" : undefined;
    },
    locate: async () => undefined,
  };
  return { slot, lookupStarted, release };
}

const SEATS = [
  { identityId: "ann", displayName: "Ann", colony: 0 as const, seat: 1 },
  { identityId: "bob", displayName: "Bob", colony: 1 as const, seat: 1 },
];

describe("a seat join in flight is shielded", () => {
  it("an anonymous initialize flood overlapping a seat join cannot evict the joining session, and the join completes", async () => {
    const { slot, lookupStarted, release } = gatedSlot();
    h = await startHarness({ ...capped(3), start: false, slot });
    h.game.seatLobby("cap-lobby", SEATS);
    await h.connect();
    await h.connect();
    const victim = await h.connect();
    const joining = victim.call("join", { key: "ann-key" });
    await lookupStarted;

    // Without the shield the third of these would evict the victim, the newest unjoined session.
    for (let i = 0; i < 6; i += 1) expect((await rawInitialize(h.url)).status).toBe(200);
    expect(h.handler.sessionCount).toBe(3);
    expect(h.handler.hasSession(idOf(victim))).toBe(true);

    release();
    const joined = await joining;
    expect(joined.isError, joined.text).toBe(false);
    expect(typeof joined.data.agentId).toBe("string");
    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(h.url)).status).toBe(200);
    expect(h.handler.hasSession(idOf(victim))).toBe(true);
  });

  it("the join shield is bounded by maxProtectedSessions, so joins in flight never close admission", async () => {
    const { slot, lookupStarted, release } = gatedSlot();
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 0 }, start: false, slot });
    h.game.seatLobby("cap-lobby", SEATS);
    const victim = await h.connect();
    // The evicted session's reply never arrives; closing the client at teardown settles this call.
    void victim.call("join", { key: "ann-key" }).catch(() => undefined);
    await lookupStarted;

    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(h.url)).status).toBe(200);
    expect(h.handler.hasSession(idOf(victim))).toBe(false);
    release();
  });
});

describe("per-source initialize limit on a match slot", () => {
  // Documentation addresses (RFC 5737, RFC 3849); the last hop is the one Google's frontend appends.
  const A = "192.0.2.20";
  const B = "203.0.113.7";
  const limited = (maxOpenSessions: number) => ({
    mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions, maxProtectedSessions: 1 },
    perSourceInitializeLimit: true,
  });
  const BURST = DEFAULT_MCP_CONFIG.initializeBurstPerSource;
  const REFILL_MS = DEFAULT_MCP_CONFIG.initializeRefillMsPerSource;
  const from = (forwardedFor: string) => rawInitialize(h!.url, undefined, { forwardedFor });

  function expectSourceLimited(r: RawReply): void {
    expect(r.status).toBe(429);
    expect(r.sessionId).toBeNull();
    const body = JSON.parse(r.text) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.message).toMatch(/too many new sessions/i);
    expect(body.error.message).toMatch(/retry later/i);
  }

  /** Every open session id, by asking the handler about each one a test has seen. */
  const openOf = (ids: readonly string[]) => ids.filter((id) => h!.handler.hasSession(id));

  it("the defaults are the set values: burst 8, one more every 15 s", () => {
    expect(BURST).toBe(8);
    expect(REFILL_MS).toBe(15_000);
  });

  it("below the cap nothing is charged; at the cap one source evicts at most its burst (4 seats, each re-initializing), then 429 evicting nothing", async () => {
    h = await startHarness(limited(10));
    const ids: string[] = [];
    // Twice the burst from one source, all below the cap: none charged.
    for (let i = 0; i < 10; i += 1) {
      const r = await from(A);
      expect(r.status).toBe(200);
      ids.push(r.sessionId!);
    }
    for (let i = 0; i < BURST; i += 1) {
      const r = await from(A);
      expect(r.status, `eviction ${i + 1}`).toBe(200);
      ids.push(r.sessionId!);
    }
    const before = openOf(ids);
    expect(before.length).toBe(10);
    for (let i = 0; i < 5; i += 1) expectSourceLimited(await from(A));
    expect(openOf(ids)).toEqual(before);
    expect(h.handler.sessionCount).toBe(10);

    // Another source has its own allowance.
    const other = await from(B);
    expect(other.status).toBe(200);
    expect(h.handler.hasSession(before[0]!)).toBe(false);
  });

  it("only an initialize that would evict is charged: a full server's 503 and a rejected initialize cost nothing", async () => {
    h = await startHarness(limited(2));
    const a = await joinedAgent(h);
    const b = await joinedAgent(h);
    for (let i = 0; i < BURST + 2; i += 1) expectServerFull(await from(A));
    for (let i = 0; i < BURST + 2; i += 1) expect((await rawInitialize(h.url, "application/json", { forwardedFor: A })).status).toBe(406);
    await b.transport.terminateSession();
    await h.connect();
    // The whole burst is still there.
    for (let i = 0; i < BURST; i += 1) expect((await from(A)).status, `eviction ${i + 1}`).toBe(200);
    expectSourceLimited(await from(A));
    expect(h.handler.hasSession(idOf(a))).toBe(true);
  });

  it("the allowance refills one per 15 s, never past the burst", async () => {
    h = await startHarness(limited(3));
    for (let i = 0; i < 3; i += 1) expect((await from(B)).status).toBe(200);
    for (let i = 0; i < BURST; i += 1) expect((await from(A)).status).toBe(200);
    expectSourceLimited(await from(A));
    h.clock.now += REFILL_MS - 1;
    expectSourceLimited(await from(A));
    h.clock.now += 1;
    expect((await from(A)).status).toBe(200);
    expectSourceLimited(await from(A));
    // Long enough to refill many times over, short of the idle expiry, so the server stays at the cap.
    h.clock.now += 10 * REFILL_MS;
    expect(10 * REFILL_MS).toBeLessThan(TEST_MCP_CONFIG.sessionIdleMs);
    await h.handler.sweep();
    expect(h.handler.sessionCount).toBe(3);
    for (let i = 0; i < BURST; i += 1) expect((await from(A)).status).toBe(200);
    expectSourceLimited(await from(A));
  });

  it("hops a client writes before the last do not change its source; an IPv6 /64 is one source; no client hop shares one key", async () => {
    h = await startHarness(limited(3));
    for (let i = 0; i < 3; i += 1) expect((await from(B)).status).toBe(200);
    for (let i = 0; i < BURST; i += 1) expect((await from(`10.0.0.${i}, 198.51.100.${i}, ${A}`)).status).toBe(200);
    expectSourceLimited(await from(`198.51.100.99, ${A}`));
    expectSourceLimited(await from(A));

    for (let i = 0; i < BURST; i += 1) expect((await from(`2001:db8:1:2::${i + 1}`)).status).toBe(200);
    expectSourceLimited(await from("2001:db8:1:2:ffff::9"));
    expect((await from("2001:db8:1:3::1")).status).toBe(200);

    for (let i = 0; i < BURST; i += 1) {
      const r = i % 2 === 0 ? await rawInitialize(h.url) : await from("not-an-address");
      expect(r.status).toBe(200);
    }
    expectSourceLimited(await rawInitialize(h.url));
    expectSourceLimited(await from(`${A}, bad`));
  });

  it("without the slot setting no source is limited", async () => {
    h = await startHarness(capped(3));
    for (let i = 0; i < 3 * BURST; i += 1) expect((await from(A)).status).toBe(200);
  });

  it("no client address reaches the logs or a reply", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    cleanups.push(async () => { for (const spy of spies) spy.mockRestore(); });
    h = await startHarness(limited(2));
    const replies: RawReply[] = [];
    for (let i = 0; i < BURST + 4; i += 1) replies.push(await from(`198.51.100.${i}, ${A}`));
    for (let i = 0; i < 4; i += 1) replies.push(await from("2001:db8:1:2::1"));
    expect(replies.some((r) => r.status === 429)).toBe(true);
    const printed = [...spies.flatMap((spy) => spy.mock.calls.flat().map(String)), ...replies.map((r) => r.text)].join("\n");
    for (const address of [A, "198.51.100.", "2001:db8"]) expect(printed).not.toContain(address);
  });
});

describe("key protection: entry waits only, never at a seat join's expense", () => {
  /**
   * Account tools over stubbed stores. A key starting "good" is live and names its own identity
   * until rotate_key retires it; the replacement key resolves to the same identity.
   */
  const retired = new Set<string>();
  const rotatedTo = new Map<string, string>();
  let rotations = 0;
  /** When set, a lookup of a retired key signals and waits, holding that call open. */
  let retiredLookup: { readonly started: () => void; readonly gate: Promise<void> } | undefined;
  const resolveKey = async (key: string) => {
    if (retired.has(key) && retiredLookup !== undefined) {
      retiredLookup.started();
      await retiredLookup.gate;
    }
    return key.startsWith("good") && !retired.has(key)
      ? { ok: true, value: { id: `identity:${rotatedTo.get(key) ?? key}`, kind: "username", displayName: key } }
      : { ok: false, reason: "unknown_key" };
  };
  /** When set, each key-issuing store call signals and waits, holding its call in flight. */
  let issuing: { readonly started: () => void; readonly gate: Promise<void> } | undefined;
  /** Each commit-point answer reissue_handle_key's guard gave, so a test can see whether a key would be issued. */
  const reissueChecks: (boolean | undefined)[] = [];
  /** When set, the next request's response close resolves it, after the handler's own close listener has run. */
  let onNextResponseClose: (() => void) | undefined;
  async function whileIssuing(): Promise<void> {
    if (issuing === undefined) return;
    issuing.started();
    await issuing.gate;
  }
  const issued = (name: string) => ({ id: `identity:${name}`, kind: "username", displayName: name });
  const stores = {
    identities: {
      resolveKey,
      claimUsername: async (name: string) => {
        await whileIssuing();
        return { ok: true, value: { identity: issued(name), key: "good-issued-claim" } };
      },
      createHandle: async (_ownerKey: string, handle: string, guard?: { mayCommit?: () => boolean }) => {
        // The guard is asked at the commit point, as the real store does; the gate then stands for the commit in flight.
        if (guard?.mayCommit?.() === false) return { ok: false, reason: "server_busy" };
        await whileIssuing();
        return { ok: true, value: { identity: issued(handle), key: "good-issued-handle" } };
      },
      reissueHandleKey: async (_ownerKey: string, _handle: string, guard?: { mayCommit?: () => boolean }) => {
        // The gate stands for the work before the commit; the guard is asked at the commit point, as the real store does.
        await whileIssuing();
        const mayCommit = guard?.mayCommit?.();
        reissueChecks.push(mayCommit);
        if (mayCommit === false) return { ok: false, reason: "server_busy" };
        return { ok: true, value: { key: "good-issued-reissue" } };
      },
      rotateKey: async (key: string) => {
        const found = await resolveKey(key);
        if (!found.ok) return found;
        const next = `good-rotated-${(rotations += 1)}`;
        retired.add(key);
        rotatedTo.set(next, found.value!.id.slice("identity:".length));
        return { ok: true, value: { key: next, identityId: found.value!.id } };
      },
    },
    lobbies: {
      queueStatus: async (key: string) => ((await resolveKey(key)).ok ? { ok: true, value: { state: "waiting" } } : { ok: false, reason: "unknown_key" }),
      ownWaitToken: async () => undefined,
    },
  } as unknown as AccountStores;

  async function startEntry(mcpConfig: McpConfig): Promise<{ handler: McpHandler; url: URL }> {
    return startServing(new Game({ mcpConfig }), false);
  }

  /** The handler as server.ts builds it: account tools beside the match tools; gameplay false is the entry service. */
  async function startServing(game: Game, gameplay: boolean, now?: () => number): Promise<{ handler: McpHandler; url: URL }> {
    const handler = createMcpHandler(game, {
      gameplay,
      ...(now === undefined ? {} : { now }),
      extraTools: (server, session) => registerAccountTools(server, stores, { seatClientAdmission: false, session }),
    });
    const server: Server = createServer((req, res) => {
      const closed = onNextResponseClose;
      onNextResponseClose = undefined;
      if (closed !== undefined) res.once("close", closed);
      void handler.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { handler, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`) };
  }

  async function entryClient(url: URL): Promise<{ client: Client; sessionId: string }> {
    const client = new Client({ name: "entry-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    cleanups.push(() => client.close().catch(() => {}));
    return { client, sessionId: transport.sessionId! };
  }

  const queueStatus = async (client: Client, key: string): Promise<boolean> =>
    (await client.callTool({ name: "queue_status", arguments: { key } })).isError !== true;

  it("a session whose keyed call succeeded survives a flood past the cap; one whose key failed does not", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions: 2 });
    // The waiting player is the oldest session, so without protection it would be the first evicted.
    const waiting = await entryClient(url);
    expect(await queueStatus(waiting.client, "good")).toBe(true);
    const failed = await entryClient(url);
    expect(await queueStatus(failed.client, "bad")).toBe(false);

    for (let i = 0; i < 5; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(3);
    expect(handler.hasSession(waiting.sessionId)).toBe(true);
    expect(handler.hasSession(failed.sessionId)).toBe(false);
    expect(await queueStatus(waiting.client, "good")).toBe(true);
  });

  it("the entry service never shields a join call, so a join held open there is evicted like any unjoined session", async () => {
    // join is not registered on the entry service; a stand-in that never answers keeps the call in flight,
    // which on a server hosting matches would hold a shielded place.
    let stall: () => void = () => {};
    const stalled = new Promise<void>((resolve) => (stall = resolve));
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    const handler = createMcpHandler(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 } }), {
      gameplay: false,
      extraTools: (server) => {
        server.registerTool("join", { description: "stand-in" }, async () => {
          entered();
          await stalled;
          return { content: [] };
        });
      },
    });
    const server: Server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(async () => {
      stall();
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const bogus = await entryClient(url);
    void bogus.client.callTool({ name: "join", arguments: {} }).catch(() => {});
    await inFlight;

    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(2);
    expect(handler.hasSession(bogus.sessionId)).toBe(false);
  });

  it("on a server hosting matches, key holders get no protection, so a seat join in flight keeps its shield", async () => {
    const { slot, lookupStarted, release } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { handler, url } = await startServing(game, true);
    // Without the slot rule this key holder would take the one shielded place first.
    const keyHolder = await entryClient(url);
    expect(await queueStatus(keyHolder.client, "good")).toBe(true);
    const victim = await entryClient(url);
    const joining = victim.client.callTool({ name: "join", arguments: { key: "ann-key" } });
    await lookupStarted;

    for (let i = 0; i < 5; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(3);
    expect(handler.hasSession(keyHolder.sessionId)).toBe(false);
    expect(handler.hasSession(victim.sessionId)).toBe(true);
    release();
    const joined = await joining;
    expect(joined.isError, JSON.stringify(joined.content)).not.toBe(true);
    expect(typeof (joined.structuredContent as { agentId?: unknown }).agentId).toBe("string");
  });

  it("the default per-identity share covers a full team's seats and stays a small part of the protected share", () => {
    expect(DEFAULT_MCP_CONFIG.maxProtectedSessionsPerIdentity).toBeGreaterThanOrEqual(agentsPerColony(DEFAULT_MCP_CONFIG));
    expect(DEFAULT_MCP_CONFIG.maxProtectedSessionsPerIdentity * 10).toBeLessThanOrEqual(DEFAULT_MCP_CONFIG.maxProtectedSessions);
  });

  it("one identity holding many sessions protects at most its per-identity share, leaving shields for others", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 6, maxProtectedSessions: 4, maxProtectedSessionsPerIdentity: 2 });
    const hoarded = [];
    for (let i = 0; i < 4; i += 1) {
      const session = await entryClient(url);
      expect(await queueStatus(session.client, "good-hoarder")).toBe(true);
      hoarded.push(session);
    }
    const other = await entryClient(url);
    expect(await queueStatus(other.client, "good-other")).toBe(true);

    for (let i = 0; i < 6; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(6);
    expect(hoarded.map((s) => handler.hasSession(s.sessionId))).toEqual([true, true, false, false]);
    expect(handler.hasSession(other.sessionId)).toBe(true);
    expect(await queueStatus(other.client, "good-other")).toBe(true);
  });

  it("rotating a key does not reset the share: the identity still protects at most its per-identity count", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 7, maxProtectedSessions: 6, maxProtectedSessionsPerIdentity: 2 });
    const before = [await entryClient(url), await entryClient(url)];
    for (const session of before) expect(await queueStatus(session.client, "good-rotating")).toBe(true);
    const rotated = await before[0]!.client.callTool({ name: "rotate_key", arguments: { key: "good-rotating" } });
    expect(rotated.isError, JSON.stringify(rotated.content)).not.toBe(true);
    const newKey = (rotated.structuredContent as { key: string }).key;
    expect(await queueStatus(before[1]!.client, "good-rotating")).toBe(false);
    const after = [await entryClient(url), await entryClient(url)];
    for (const session of after) expect(await queueStatus(session.client, newKey)).toBe(true);
    const other = await entryClient(url);
    expect(await queueStatus(other.client, "good-bystander")).toBe(true);

    for (let i = 0; i < 7; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(7);
    expect(before.map((s) => handler.hasSession(s.sessionId))).toEqual([true, true]);
    expect(after.map((s) => handler.hasSession(s.sessionId))).toEqual([false, false]);
    expect(handler.hasSession(other.sessionId)).toBe(true);
  });

  it("an unprotected session rotating its key at the cap is protected by the proven identity and still receives the new key", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 });
    // The rotating session is the oldest and unprotected: without protection it is the first evicted.
    const rotating = await entryClient(url);
    expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(2);

    let started: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => {};
    retiredLookup = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
    try {
      const reply = rotating.client.callTool({ name: "rotate_key", arguments: { key: "good-rotator" } });
      reply.catch(() => {});
      // A lookup of the retired key after the rotation is saved would hold the reply open here.
      await Promise.race([lookupStarted, reply]);
      for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
      expect(handler.sessionCount).toBe(2);
      expect(handler.hasSession(rotating.sessionId)).toBe(true);
      release();
      const rotated = await reply;
      expect(rotated.isError, JSON.stringify(rotated.content)).not.toBe(true);
      const newKey = (rotated.structuredContent as { key: string }).key;
      expect(newKey).toMatch(/^good-rotated-/);
      expect(await queueStatus(rotating.client, newKey)).toBe(true);
    } finally {
      release();
      retiredLookup = undefined;
    }
  });

  /**
   * An entry handler whose claim_username stand-in signals when it is entered and then waits on finish:
   * resolve to answer, reject to throw. The clock is the test's.
   */
  async function startKeyIssuing(mcpConfig: McpConfig, clock: { now: number }) {
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    let finish: (outcome: Error | undefined) => void = () => {};
    const finished = new Promise<Error | undefined>((resolve) => (finish = resolve));
    const handler = createMcpHandler(new Game({ mcpConfig }), {
      gameplay: false,
      now: () => clock.now,
      extraTools: (server) => {
        server.registerTool("claim_username", { description: "stand-in" }, async () => {
          entered();
          const thrown = await finished;
          if (thrown !== undefined) throw thrown;
          return { content: [] };
        });
      },
    });
    const server: Server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(async () => {
      finish(undefined);
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    return { handler, url, inFlight, finish };
  }

  it("a key-issuing call holds its session while in flight and releases the hold when the call throws", async () => {
    const clock = { now: 0 };
    const { handler, url, inFlight, finish } = await startKeyIssuing({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 }, clock);
    // The claiming session is the oldest and unprotected: without the hold it is the first evicted.
    const claiming = await entryClient(url);
    const reply = claiming.client.callTool({ name: "claim_username", arguments: {} });
    await inFlight;

    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(2);
    expect(handler.hasSession(claiming.sessionId)).toBe(true);

    finish(new Error("store failure"));
    const result = await reply;
    expect(result.isError).toBe(true);
    // Released: the session is unjoined and unshielded again, so the next initialize evicts it.
    expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.hasSession(claiming.sessionId)).toBe(false);
  });

  it("a key-issuing call that stalls holds its place only until the idle expiry, even while its session stays active", async () => {
    const clock = { now: 0 };
    const { handler, url, inFlight } = await startKeyIssuing({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 }, clock);
    const stalled = await entryClient(url);
    // The evicted session's reply never arrives; closing the client at teardown settles this call.
    void stalled.client.callTool({ name: "claim_username", arguments: {} }).catch(() => {});
    await inFlight;

    clock.now = TEST_MCP_CONFIG.sessionIdleMs - 1;
    // Kept active: its idle expiry never runs, so only the hold's own deadline can end the hold.
    expect(await rawPing(url, stalled.sessionId)).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.hasSession(stalled.sessionId)).toBe(true);

    clock.now = TEST_MCP_CONFIG.sessionIdleMs;
    expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(2);
    expect(handler.hasSession(stalled.sessionId)).toBe(false);
  });

  const KEY_ISSUING_CALLS = [
    { tool: "claim_username", args: { name: "newcomer" }, key: "good-issued-claim" },
    { tool: "create_handle", args: { key: "good-owner", handle: "scout" }, key: "good-issued-handle" },
    { tool: "reissue_handle_key", args: { key: "good-owner", handle: "scout" }, key: "good-issued-reissue" },
  ] as const;
  for (const { tool, args, key } of KEY_ISSUING_CALLS) {
    it(`${tool} holds its unprotected session through a cap flood while in flight and delivers its key`, async () => {
      const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 });
      // The issuing session is the oldest and unprotected: without its hold it is the first evicted.
      const session = await entryClient(url);
      expect((await rawInitialize(url)).status).toBe(200);
      let started: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => (started = resolve));
      let release: () => void = () => {};
      issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
      try {
        const reply = session.client.callTool({ name: tool, arguments: args });
        reply.catch(() => {});
        await inFlight;
        for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
        expect(handler.sessionCount).toBe(2);
        expect(handler.hasSession(session.sessionId)).toBe(true);
        release();
        const result = await reply;
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect((result.structuredContent as { key?: unknown }).key).toBe(key);
      } finally {
        release();
        issuing = undefined;
      }
    });
  }

  for (const { tool, args, key } of KEY_ISSUING_CALLS) {
    it(`on a server hosting matches, ${tool} holds its unprotected session through a cap flood and delivers its key`, async () => {
      const { handler, url } = await startServing(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 } }), true);
      // The issuing session is the oldest and unprotected (no key protection on a match host): without its hold it is the first evicted.
      const session = await entryClient(url);
      expect((await rawInitialize(url)).status).toBe(200);
      let started: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => (started = resolve));
      let release: () => void = () => {};
      issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
      try {
        const reply = session.client.callTool({ name: tool, arguments: args });
        reply.catch(() => {});
        await inFlight;
        for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
        expect(handler.sessionCount).toBe(2);
        expect(handler.hasSession(session.sessionId)).toBe(true);
        release();
        const result = await reply;
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect((result.structuredContent as { key?: unknown }).key).toBe(key);
      } finally {
        release();
        issuing = undefined;
      }
    });
  }

  it("on a server hosting matches, a joined seat's key-issuing call needs no hold: with the shielded share full it still gets its key", async () => {
    const { slot, release: admit } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { url } = await startServing(game, true);
    const seat = await entryClient(url);
    admit();
    const joined = await seat.client.callTool({ name: "join", arguments: { key: "ann-key" } });
    expect(typeof (joined.structuredContent as { agentId?: unknown }).agentId).toBe("string");

    // Another session's key-issuing call in flight takes the one shielded place.
    const busy = await entryClient(url);
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => {};
    issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
    try {
      const pending = busy.client.callTool({ name: "claim_username", arguments: { name: "newcomer" } });
      pending.catch(() => {});
      await inFlight;
      // A joined session is never evicted, so it holds its place without a shield.
      const rotated = await seat.client.callTool({ name: "rotate_key", arguments: { key: "good-seat" } });
      expect(rotated.isError, JSON.stringify(rotated.content)).not.toBe(true);
      expect(typeof (rotated.structuredContent as { key?: unknown }).key).toBe("string");
    } finally {
      release();
      issuing = undefined;
    }
  });

  it("on a server hosting matches, a session that joins while its key-issuing commit is pinned keeps the joined idle expiry: the sweep closes it", async () => {
    const clock = { now: 0 };
    const { slot, release: admit } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { handler, url } = await startServing(game, true, () => clock.now);
    const session = await entryClient(url);
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => {};
    issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
    try {
      // Started unjoined: the call holds a place, passes its commit-point check (pinned) and its commit is in flight.
      const reply = session.client.callTool({ name: "create_handle", arguments: { key: "good-owner", handle: "scout" } });
      reply.catch(() => {});
      await inFlight;
      // The same session joins a seat meanwhile.
      admit();
      const joined = await session.client.callTool({ name: "join", arguments: { key: "ann-key" } });
      expect(typeof (joined.structuredContent as { agentId?: unknown }).agentId).toBe("string");
      // Past the joined session's idle expiry, the pinned hold does not keep it open.
      clock.now = TEST_MCP_CONFIG.sessionIdleMs + 1;
      await handler.sweep();
      expect(handler.hasSession(session.sessionId)).toBe(false);
    } finally {
      release();
      issuing = undefined;
    }
  });

  it("on a server hosting matches, a seat released between a key-issuing call's entry and its commit aborts it server_busy: no key is issued", async () => {
    const { slot, release: admit } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { url } = await startServing(game, true);
    const seat = await entryClient(url);
    admit();
    const joined = await seat.client.callTool({ name: "join", arguments: { key: "ann-key" } });
    const agentId = (joined.structuredContent as { agentId?: unknown }).agentId;
    expect(typeof agentId).toBe("string");
    const state = sessionStates.find((s) => s.agentId === agentId)!;
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => {};
    issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
    try {
      // Entered joined, so the call took no place of its own.
      const reply = seat.client.callTool({ name: "reissue_handle_key", arguments: { key: "good-owner", handle: "scout" } });
      await inFlight;
      // The seat is released before the commit; no tool does this today, so the test does it directly.
      state.agentId = null;
      release();
      const result = await reply;
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: unknown }).error).toBe("server_busy");
      expect((result.structuredContent as { key?: unknown }).key).toBeUndefined();
    } finally {
      release();
      issuing = undefined;
    }
  });

  /** Start reissue_handle_key on a session as a raw request, then disconnect while its commit waits; resolves once the server saw the close. */
  async function disconnectMidCall(url: URL, sessionId: string): Promise<void> {
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    let release: () => void = () => {};
    issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
    const abort = new AbortController();
    const closed = new Promise<void>((resolve) => (onNextResponseClose = resolve));
    try {
      void fetch(url, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "reissue_handle_key", arguments: { key: "good-owner", handle: "scout" } } }),
      }).catch(() => {});
      await inFlight;
      abort.abort();
      await closed;
      // The commit point is reached only after the response has closed.
      release();
      await vi.waitFor(() => expect(reissueChecks.length).toBe(1));
    } finally {
      release();
      issuing = undefined;
      onNextResponseClose = undefined;
    }
  }

  it("on a server hosting matches, a joined seat's key-issuing call whose client disconnects before its commit is aborted: no key is issued and the seat keeps its idle expiry", async () => {
    const clock = { now: 0 };
    const { slot, release: admit } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { handler, url } = await startServing(game, true, () => clock.now);
    const seat = await entryClient(url);
    admit();
    const joined = await seat.client.callTool({ name: "join", arguments: { key: "ann-key" } });
    expect(typeof (joined.structuredContent as { agentId?: unknown }).agentId).toBe("string");
    reissueChecks.length = 0;

    await disconnectMidCall(url, seat.sessionId);
    // Joined throughout, yet the response is gone: the commit point refuses, so no key is issued.
    expect(reissueChecks).toEqual([false]);
    // Nothing was left pinned: past the idle expiry the sweep closes the seat's session.
    clock.now = TEST_MCP_CONFIG.sessionIdleMs + 1;
    await handler.sweep();
    expect(handler.hasSession(seat.sessionId)).toBe(false);
  });

  it("on a server hosting matches, an unjoined session's key-issuing call whose client disconnects before its commit is aborted: no key is issued and its place is not left pinned", async () => {
    const { handler, url } = await startServing(new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 } }), true);
    const caller = await entryClient(url);
    expect((await rawInitialize(url)).status).toBe(200);
    reissueChecks.length = 0;

    await disconnectMidCall(url, caller.sessionId);
    expect(reissueChecks).toEqual([false]);
    // The caller is the oldest unjoined session and holds no place: the next initialize evicts it.
    expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(2);
    expect(handler.hasSession(caller.sessionId)).toBe(false);
  });

  it("on a server hosting matches, a joined seat's key-issuing commit that could outlast the idle window its call reset is aborted: no key is issued", async () => {
    const clock = { now: 0 };
    const { slot, release: admit } = gatedSlot();
    const game = new Game({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 }, slot });
    game.seatLobby("cap-lobby", SEATS);
    const { url } = await startServing(game, true, () => clock.now);
    const seat = await entryClient(url);
    admit();
    const joined = await seat.client.callTool({ name: "join", arguments: { key: "ann-key" } });
    expect(typeof (joined.structuredContent as { agentId?: unknown }).agentId).toBe("string");
    reissueChecks.length = 0;
    /** Call reissue_handle_key at clock start and reach its commit point at clock checkAt. */
    const reissueAt = async (start: number, checkAt: number) => {
      clock.now = start;
      let started: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => (started = resolve));
      let release: () => void = () => {};
      issuing = { started, gate: new Promise<void>((resolve) => (release = resolve)) };
      try {
        const reply = seat.client.callTool({ name: "reissue_handle_key", arguments: { key: "good-owner", handle: "scout" } });
        await inFlight;
        clock.now = checkAt;
        release();
        return (await reply).structuredContent as { error?: unknown; key?: unknown };
      } finally {
        release();
        issuing = undefined;
      }
    };
    // The call resets the idle window to end at sessionIdleMs; a commit started with only the store's RPC timeout left could outlast it.
    const late = await reissueAt(0, TEST_MCP_CONFIG.sessionIdleMs - FIRESTORE_RPC_TIMEOUT_MS);
    expect(late.error).toBe("server_busy");
    expect(late.key).toBeUndefined();
    // With more than that left, the commit proceeds and the key is delivered.
    const inTime = await reissueAt(1_000, 1_000 + TEST_MCP_CONFIG.sessionIdleMs - FIRESTORE_RPC_TIMEOUT_MS - 1);
    expect(inTime.key).toBe("good-issued-reissue");
    expect(reissueChecks).toEqual([false, true]);
  });

  /** An entry handler whose stand-in claim_username takes its guard, waits on its own gate in call order, then reports mayCommit. */
  async function startGuardProbe(mcpConfig: McpConfig, clock: { now: number }) {
    const gates: { entered: () => void; finish: Promise<void> }[] = [];
    const handler = createMcpHandler(new Game({ mcpConfig }), {
      gameplay: false,
      now: () => clock.now,
      extraTools: (server, session) => {
        server.registerTool("claim_username", { description: "stand-in" }, async () => {
          const guard = session.keyIssuingHold();
          const gate = gates.shift()!;
          gate.entered();
          await gate.finish;
          return { content: [{ type: "text", text: JSON.stringify({ held: guard !== undefined, mayCommit: guard?.mayCommit() ?? false }) }] };
        });
      },
    });
    const server: Server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const finishes: (() => void)[] = [];
    cleanups.push(async () => {
      for (const finish of finishes) finish();
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    /** The next call's gate: entered once it has taken its guard; finish lets it check mayCommit and reply. */
    const nextCall = () => {
      let entered!: () => void;
      let finish!: () => void;
      const enteredCall = new Promise<void>((resolve) => (entered = resolve));
      gates.push({ entered, finish: new Promise<void>((resolve) => (finish = resolve)) });
      finishes.push(finish);
      return { entered: enteredCall, finish };
    };
    return { url, nextCall };
  }

  const probed = async (reply: Promise<unknown>) =>
    JSON.parse(((await reply) as { content: { text: string }[] }).content[0]!.text) as { held: boolean; mayCommit: boolean };

  it("a key-issuing call's guard checks its own request's hold: a concurrent request's live hold does not satisfy it", async () => {
    const clock = { now: 0 };
    const { url, nextCall } = await startGuardProbe({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 2 }, clock);
    const session = await entryClient(url);
    const first = nextCall();
    const firstReply = session.client.callTool({ name: "claim_username", arguments: {} });
    await first.entered;
    // A second call on the same session, later, so its hold outlasts the first's by more than the store's RPC timeout.
    clock.now = FIRESTORE_RPC_TIMEOUT_MS + 1_000;
    const second = nextCall();
    const secondReply = session.client.callTool({ name: "claim_username", arguments: {} });
    await second.entered;
    // The first call's hold has lapsed; the second's is still live.
    clock.now = TEST_MCP_CONFIG.sessionIdleMs;
    first.finish();
    expect(await probed(firstReply)).toEqual({ held: true, mayCommit: false });
    second.finish();
    expect(await probed(secondReply)).toEqual({ held: true, mayCommit: true });
  });

  it("when handling a held call throws before its response closes, the hold is released and the session is evictable again", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 });
    const session = await entryClient(url);
    const other = await rawInitialize(url);
    expect(other.status).toBe(200);
    // The transport answers headers for the key-issuing call, then throws: the response stays open, so its
    // close never runs and only the release on the throw can end the hold.
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    const thrown = vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockImplementation(async function (this: StreamableHTTPServerTransport, req, res, body) {
      const call = body as { method?: unknown; params?: { name?: unknown } } | undefined;
      if (call?.method === "tools/call" && call.params?.name === "claim_username") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        throw new Error("transport failure");
      }
      return original.call(this, req, res, body);
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const abort = new AbortController();
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session.sessionId, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "claim_username", arguments: { name: "newcomer" } } }),
      });
      expect(res.status).toBe(200);
      expect(thrown).toHaveBeenCalled();

      expect((await rawInitialize(url)).status).toBe(200);
      expect(handler.sessionCount).toBe(2);
      expect(handler.hasSession(session.sessionId)).toBe(false);
      expect(handler.hasSession(other.sessionId!)).toBe(true);
    } finally {
      abort.abort();
      thrown.mockRestore();
      quiet.mockRestore();
    }
  });

  it("protection stops at maxProtectedSessions, so key holders can never close admission", async () => {
    const { handler, url } = await startEntry({ ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions: 1 });
    const first = await entryClient(url);
    expect(await queueStatus(first.client, "good-1")).toBe(true);
    const second = await entryClient(url);
    expect(await queueStatus(second.client, "good-2")).toBe(true);
    const third = await entryClient(url);
    expect(await queueStatus(third.client, "good-3")).toBe(true);

    for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
    expect(handler.sessionCount).toBe(3);
    expect(handler.hasSession(first.sessionId)).toBe(true);
    expect(handler.hasSession(second.sessionId)).toBe(false);
    expect(handler.hasSession(third.sessionId)).toBe(false);
  });
});

describe("no hold, no key: key-issuing calls against the real identity store", () => {
  /** An in-memory store that counts every transaction and commit and can run a hook as each transaction starts. */
  function countingStore() {
    const docs = new Map<string, Fields>();
    const seen = {
      transactions: 0,
      commits: [] as (readonly Write[])[],
      onTransaction: undefined as (() => void) | undefined,
      /** Run between a transaction's step and its commit, as the commit is in flight. */
      onCommit: undefined as (() => Promise<void>) | undefined,
      /** Store calls (transactions and gets) counted when the latest commit applied. */
      atLastCommit: 0,
      /** The commit deadline the latest committing step carried. */
      commitBy: undefined as { at: number; late: unknown } | undefined,
    };
    const store: Store = {
      namespace: "session-cap-test",
      async get(path) {
        seen.transactions += 1;
        return docs.get(path) ?? null;
      },
      async transaction(step) {
        seen.transactions += 1;
        seen.onTransaction?.();
        const next = await step(async (paths) => new Map(paths.map((path) => [path, docs.get(path) ?? null])));
        if (next.writes.length > 0) seen.commitBy = next.commitBy;
        if (next.writes.length > 0) await seen.onCommit?.();
        for (const write of next.writes) {
          if (write.op === "delete") docs.delete(write.path);
          else docs.set(write.path, { ...docs.get(write.path), ...write.fields });
        }
        if (next.writes.length > 0) {
          seen.commits.push(next.writes);
          seen.atLastCommit = seen.transactions;
        }
        return next.result;
      },
      async query() {
        throw new Error("not used");
      },
    };
    return { store, seen };
  }

  async function startReal(mcpConfig: McpConfig) {
    const clock = { now: 0 };
    const { store, seen } = countingStore();
    const identities = createIdentities(store);
    const stores = {
      identities,
      lobbies: {
        queueStatus: async (key: string) => ((await identities.resolveKey(key)).ok ? { ok: true, value: { state: "none" } } : { ok: false, reason: "unknown_key" }),
        ownWaitToken: async () => undefined,
      },
    } as unknown as AccountStores;
    const handler = createMcpHandler(new Game({ mcpConfig }), {
      gameplay: false,
      now: () => clock.now,
      extraTools: (server, session) => registerAccountTools(server, stores, { seatClientAdmission: false, session }),
    });
    const server: Server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    return { handler, url, clock, seen, identities };
  }

  async function client(url: URL): Promise<Client> {
    const c = new Client({ name: "real-test", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url));
    cleanups.push(() => c.close().catch(() => {}));
    return c;
  }

  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const result = await c.callTool({ name, arguments: args });
    return { isError: result.isError === true, body: (result.structuredContent ?? {}) as Record<string, unknown> };
  };

  /** An owner username with one handle, set up through the tools from a session that gets a hold. */
  async function owner(c: Client): Promise<{ ownerKey: string; handleKey: string }> {
    const claimed = await call(c, "claim_username", { name: "owner" });
    expect(claimed.isError, JSON.stringify(claimed.body)).toBe(false);
    const ownerKey = claimed.body.key as string;
    const created = await call(c, "create_handle", { key: ownerKey, handle: "scout" });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    return { ownerKey, handleKey: created.body.key as string };
  }

  const ISSUING = [
    { tool: "claim_username", args: () => ({ name: "newcomer" }) },
    { tool: "rotate_key", args: (k: { ownerKey: string; handleKey: string }) => ({ key: k.handleKey }) },
    { tool: "create_handle", args: (k: { ownerKey: string; handleKey: string }) => ({ key: k.ownerKey, handle: "second" }) },
    { tool: "reissue_handle_key", args: (k: { ownerKey: string; handleKey: string }) => ({ key: k.ownerKey, handle: "scout" }) },
  ] as const;

  for (const { tool, args } of ISSUING) {
    it(`${tool} with the shielded share full is refused server_busy before any store read, and commits nothing`, async () => {
      const { url, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 1 });
      // The one shielded place goes to a session protected by its key.
      const holder = await client(url);
      const keys = await owner(holder);
      expect((await call(holder, "queue_status", { key: keys.ownerKey })).isError).toBe(false);

      const caller = await client(url);
      const before = { transactions: seen.transactions, commits: seen.commits.length };
      const reply = await call(caller, tool, args(keys));
      expect(reply.isError).toBe(true);
      expect(reply.body.error).toBe("server_busy");
      expect(reply.body.key).toBeUndefined();
      expect(seen.transactions).toBe(before.transactions);
      expect(seen.commits.length).toBe(before.commits);
    });

    it(`${tool} whose hold lapses before its commit is aborted server_busy and commits nothing`, async () => {
      const { url, clock, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 2 });
      const setup = await client(url);
      const keys = await owner(setup);
      const caller = await client(url);
      const before = seen.commits.length;
      // The call's hold is taken at clock 0 and lasts sessionIdleMs; the clock passes it once the call reaches the store.
      seen.onTransaction = () => {
        clock.now = TEST_MCP_CONFIG.sessionIdleMs;
      };
      try {
        const reply = await call(caller, tool, args(keys));
        expect(reply.isError, JSON.stringify(reply.body)).toBe(true);
        expect(reply.body.error).toBe("server_busy");
        expect(reply.body.key).toBeUndefined();
        expect(seen.commits.length).toBe(before);
      } finally {
        seen.onTransaction = undefined;
      }
    });
  }

  for (const { tool, args } of ISSUING) {
    it(`${tool} reaching its commit with no more than the store's RPC timeout left of its idle window commits nothing`, async () => {
      const { url, clock, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 2 });
      const setup = await client(url);
      const keys = await owner(setup);
      const caller = await client(url);
      const before = seen.commits.length;
      // The hold is still live, but a commit started now could end after the idle window the call reset.
      seen.onTransaction = () => {
        clock.now = TEST_MCP_CONFIG.sessionIdleMs - FIRESTORE_RPC_TIMEOUT_MS;
      };
      try {
        const reply = await call(caller, tool, args(keys));
        expect(reply.isError, JSON.stringify(reply.body)).toBe(true);
        expect(reply.body.error).toBe("server_busy");
        expect(reply.body.key).toBeUndefined();
        expect(seen.commits.length).toBe(before);
      } finally {
        seen.onTransaction = undefined;
      }
    });
  }

  for (const { tool, args } of ISSUING) {
    it(`${tool} carries the end of the idle window its call reset to the store as its commit deadline, late meaning server_busy`, async () => {
      const { url, clock, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 2 });
      const setup = await client(url);
      const keys = await owner(setup);
      const caller = await client(url);
      clock.now = 7_000;
      const reply = await call(caller, tool, args(keys));
      expect(reply.isError, JSON.stringify(reply.body)).toBe(false);
      expect(seen.commitBy).toEqual({ at: 7_000 + TEST_MCP_CONFIG.sessionIdleMs, late: { ok: false, reason: "server_busy" } });
    });
  }

  it("a hold that passes the pre-commit check is pinned: lapsing mid-commit, it keeps the session through a flood and the sweep, and the key is delivered", async () => {
    const { handler, url, clock, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 2, maxProtectedSessions: 1 });
    const caller = new Client({ name: "real-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await caller.connect(transport);
    cleanups.push(() => caller.close().catch(() => {}));
    expect((await rawInitialize(url)).status).toBe(200);
    let survived: boolean | undefined;
    // While the commit is in flight the hold's deadline passes; the caller is the oldest session and unprotected.
    seen.onCommit = async () => {
      clock.now = TEST_MCP_CONFIG.sessionIdleMs + 1;
      for (let i = 0; i < 3; i += 1) expect((await rawInitialize(url)).status).toBe(200);
      await handler.sweep();
      survived = handler.hasSession(transport.sessionId!);
    };
    try {
      const reply = call(caller, "claim_username", { name: "pinned" });
      await vi.waitFor(() => expect(survived).toBeDefined());
      expect(survived).toBe(true);
      const result = await reply;
      expect(result.isError, JSON.stringify(result.body)).toBe(false);
      expect(typeof result.body.key).toBe("string");
    } finally {
      seen.onCommit = undefined;
    }
  });

  for (const { tool, args } of ISSUING.filter((c) => c.tool !== "claim_username")) {
    it(`${tool} reads nothing between its commit and its reply`, async () => {
      const { url, seen } = await startReal({ ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 2 });
      const setup = await client(url);
      const keys = await owner(setup);
      // A fresh, unprotected session, so protection could still be granted after the reply's commit.
      const caller = await client(url);
      const before = seen.commits.length;
      const reply = await call(caller, tool, args(keys));
      expect(reply.isError, JSON.stringify(reply.body)).toBe(false);
      expect(typeof reply.body.key).toBe("string");
      // The key-issuing commit is the call's last store access: no read or write of any kind follows it.
      expect(seen.commits.length).toBe(before + 1);
      expect(seen.commits.at(-1)!.some((w) => w.op === "create" && w.path.startsWith("keys/"))).toBe(true);
      expect(seen.transactions).toBe(seen.atLastCommit);
    });
  }
});
