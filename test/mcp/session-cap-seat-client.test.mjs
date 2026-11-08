// What a seat's new session can rely on before its join
// reaches the server, exercised with the real seat client (packages/antwars-seat),
// which is plain JavaScript and so is tested from this .mjs file.
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../../packages/antwars-seat/lib/mcp.mjs";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { TEST_MCP_CONFIG, startHarness } from "./harness.ts";

let h = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const SEATS = [
  { identityId: "ann", displayName: "Ann", colony: 0, seat: 1 },
  { identityId: "bob", displayName: "Bob", colony: 1, seat: 1 },
];
const slot = { identityOf: async (key) => (key === "ann-key" ? "ann" : undefined), locate: async () => undefined };
const clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

async function rawPost(url, body, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId !== undefined) Object.assign(headers, { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" });
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  await res.text();
  return res.status;
}
const rawInitialize = (url) => rawPost(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } });
const rawPing = (url, sessionId) => rawPost(url, { jsonrpc: "2.0", id: 2, method: "ping" }, sessionId);

describe("a seat's session before its join arrives", () => {
  it("outlasts every evictable session ahead of it; once evicted, the seat client re-initializes and joins", async () => {
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: 4, maxProtectedSessions: 3 }, start: false, slot });
    h.game.seatLobby("cap-lobby", SEATS);
    const attackers = [await h.connect(), await h.connect(), await h.connect()];
    // The seat client as the match client builds it: on a 404 it initializes again and re-joins its seat.
    const seat = new McpClient({
      url: h.url, clock,
      onReinit: async (fresh) => { await fresh.callTool("join", { key: "ann-key", seat: 1 }, { recover: false }); },
    });
    await seat.initialize();
    const first = seat.session.sessionId;

    // Every older anonymous session goes first, however recently it pinged.
    for (const attacker of attackers) expect(await rawPing(h.url, attacker.transport.sessionId)).toBe(200);
    for (let i = 0; i < attackers.length; i += 1) {
      expect(await rawInitialize(h.url)).toBe(200);
      expect(h.handler.hasSession(first)).toBe(true);
    }
    for (const attacker of attackers) expect(h.handler.hasSession(attacker.transport.sessionId)).toBe(false);
    // With no older evictable session left, the next initialize takes the seat's.
    expect(await rawInitialize(h.url)).toBe(200);
    expect(h.handler.hasSession(first)).toBe(false);

    const joined = await seat.callTool("join", { key: "ann-key", seat: 1 });
    expect(joined.ok, JSON.stringify(joined.data)).toBe(true);
    expect(typeof joined.data.agentId).toBe("string");
    expect(seat.session.sessionId).not.toBe(first);
    expect(h.handler.hasSession(seat.session.sessionId)).toBe(true);
    expect(h.handler.sessionCount).toBe(4);
  });
});

/** A slot whose key lookups all wait for the test; started counts the lookups waiting. */
function gatedSlot() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slot = {
    identityOf: async (key) => {
      gated.started += 1;
      await gate;
      return key === "ann-key" ? "ann" : undefined;
    },
    locate: async () => undefined,
  };
  const gated = { slot, started: 0, release: () => release() };
  return gated;
}

async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

describe("a joining seat survives a sustained anonymous initialize flood on a match slot", () => {
  it("with every shielded place taken by anonymous joins in flight, one source's flood evicts at most its allowance and never the seat", async () => {
    // Documentation addresses only (RFC 5737). The last X-Forwarded-For hop is the one Google's frontend appends.
    const SEAT_ADDRESS = "192.0.2.20";
    const FLOOD_ADDRESS = "203.0.113.7";
    const { initializeBurstPerSource: burst, initializeRefillMsPerSource: refillMs } = DEFAULT_MCP_CONFIG;
    const older = 10;
    const gated = gatedSlot();
    h = await startHarness({
      mcpConfig: { ...TEST_MCP_CONFIG, maxOpenSessions: older + 4, maxProtectedSessions: 2 },
      start: false,
      slot: gated.slot,
      perSourceInitializeLimit: true,
    });
    h.game.seatLobby("cap-lobby", SEATS);

    // Older anonymous sessions: more than one source's allowance, fewer than a timed rotating pool would need.
    const olderIds = [];
    for (let i = 0; i < older; i += 1) olderIds.push((await h.connect()).transport.sessionId);
    // Anonymous joins held at the key lookup take every shielded place.
    for (let i = 0; i < 2; i += 1) void (await h.connect()).call("join", { key: `bogus-${i}` }).catch(() => undefined);
    await until(() => gated.started === 2);

    // The seat client exactly as published (1.1.1); only the network adds its address.
    const fetchImpl = (url, init) => fetch(url, { ...init, headers: { ...init.headers, "x-forwarded-for": SEAT_ADDRESS } });
    let reinitialized = false;
    const seat = new McpClient({ url: h.url, clock, fetchImpl, onReinit: async () => { reinitialized = true; } });
    await seat.initialize();
    const first = seat.session.sessionId;
    // Its join waits at the lookup too, unshielded: the shielded share is full.
    const joining = seat.callTool("join", { key: "ann-key", seat: 1 });
    await until(() => gated.started === 3);
    expect(h.handler.sessionCount).toBe(older + 3);

    // A sustained flood from one source, forging earlier hops: 3 s of the server's clock, far longer than a seat's join takes.
    const statuses = [];
    for (let i = 0; i < 300; i += 1) {
      const forged = `10.${i % 256}.0.1, 198.51.100.${i % 256}, ${FLOOD_ADDRESS}`;
      const res = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": forged },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } }),
      });
      await res.text();
      statuses.push(res.status);
      expect(h.handler.hasSession(first), `flood initialize ${i + 1}`).toBe(true);
      h.clock.now += 10;
    }
    const refilled = Math.floor((300 * 10) / refillMs);
    // The first filled the last free place; after that only the allowance evicted.
    expect(statuses.filter((s) => s === 200).length).toBe(1 + burst + refilled);
    expect(statuses.filter((s) => s !== 200).every((s) => s === 429)).toBe(true);
    expect(olderIds.filter((id) => h.handler.hasSession(id)).length).toBe(older - burst - refilled);
    expect(h.handler.sessionCount).toBe(older + 4);

    gated.release();
    const joined = await joining;
    expect(joined.ok, JSON.stringify(joined.data)).toBe(true);
    expect(typeof joined.data.agentId).toBe("string");
    expect(seat.session.sessionId).toBe(first);
    expect(reinitialized).toBe(false);
  });
});
