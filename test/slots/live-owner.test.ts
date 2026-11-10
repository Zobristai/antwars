/// <reference types="node" />
import { rmSync } from "node:fs";
import { request, Server, type IncomingMessage } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLobbies, type Lobbies, type MatchOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { SLOT_READY_PATH, startServer, type GameServer, type SlotWiring } from "../../src/server.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { KEEP_ALIVE_PATH } from "../../src/slots/keepAlive.ts";
import { SLOT_HEARTBEAT_MS, SLOT_POLL_MS, SLOT_STALE_MS, SLOT_UNHEARD_MS } from "../../src/slots/slotServer.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";

// A same-revision instance that starts while the slot's owner plays its begun
// match neither takes the slot nor serves a request until the owner releases it or goes
// stale; a deploy (another revision), an unknown revision, or no begun match takes it as before.
// The serialized in-memory store stands in for Firestore; no emulator is needed.

/** A 4 s match (80 ticks at 20 per second) that reaches its natural time-up result. */
const MATCH = playable(shortConfig(80, { ticksPerSecond: 20, queenFounding: PUBLIC_CONFIG.queenFounding }));
const LONG = playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding }));

const servers: GameServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** One shared store; a rated 1v1 queue match already holding public-0 with a 300 ms countdown unless given. */
async function world(countdownMs = 300) {
  const w = retentionWorld(Date.now());
  const a = value(await w.ids.claimUsername("OwnerA")), b = value(await w.ids.claimUsername("OwnerB"));
  const lobbies = createLobbies(w.store, w.ids, { countdownMs });
  const ratings = createRatings(w.store, w.ids);
  const lobby = await w.store.transaction(async (read) => {
    const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, Date.now());
    return { result: paired.lobby, writes: paired.writes };
  });
  expect(lobby.slot).toBe("public-0");
  const outcome = async (): Promise<MatchOutcome | null> => value(await lobbies.readLobby(lobby.id)).outcome;
  const rated = async () => Promise.all([a, b].map(async (key) => (await ratings.readRating(key.identity.id, "1v1")).ratedMatches));
  return { w, lobbies, lobby, outcome, rated, keys: [a.key, b.key] as const };
}

type Wiring = Partial<Pick<SlotWiring, "revision" | "heartbeatMs" | "staleMs" | "unheardMs" | "publicUrl" | "onRetired">>;

/**
 * Starts a slot server for public-0 named `name`; resolves only once it holds the slot.
 * Its public URL is http://<name>.test unless given: an address nothing answers, as a
 * Cloud Run service that routes this instance no request (its self-probe fails).
 */
function slotServer(lobbies: Lobbies, ids: ReturnType<typeof retentionWorld>["ids"], name: string, port: number, wiring: Wiring, simConfig = MATCH) {
  const dataDir = tempDir();
  dirs.push(dataDir);
  return startServer({
    port, host: "127.0.0.1", dataDir, simConfig, mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100,
    slot: { slot: "public-0", publicUrl: `http://${name}.test`, lobbies, identities: ids, pollMs: 20, ...wiring },
  }).then((server) => { servers.push(server); return server; });
}

const status = async (port: number, path: string, init?: RequestInit) => (await fetch(`http://127.0.0.1:${port}${path}`, init)).status;
/** One request over its own new connection, never a pooled kept-alive one: resolves its status. */
function freshStatus(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end(init.body);
  });
}
const mcpPost = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "standby-test", version: "0" } } }) };

/**
 * Each seat joins the server's lobby through its own session, which then closes: a ranked seat that never
 * joins ends the match abandoned, unrated, at its natural end.
 */
async function joinSeats(port: number, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const seat = await connect(port);
    try {
      await until(async () => !(await seat.call("join", { key })).isError);
    } finally {
      await seat.close().catch(() => {});
    }
  }
}

/** The owner's begun match: its run stamped on the lobby. */
async function begun(lobbies: Lobbies): Promise<string> {
  return until(async () => (await lobbies.slotHolder("public-0"))?.matchRunId ?? undefined);
}

describe("a same-revision instance starting during the owner's begun match", { timeout: 30_000 }, () => {
  it("neither registers nor serves while the owner's heartbeat is fresh; the match records its natural, rated result, then the waiting instance takes the slot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, lobbies, outcome, rated, keys } = await world();
    // A 100 ms heartbeat against a 1 s staleness window: only a refreshed heartbeat keeps the owner live for the 4 s match.
    const owner = await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1", heartbeatMs: 100 });
    const ownerRun = await begun(lobbies);
    await joinSeats(owner.port, keys);
    expect((await lobbies.resolveSlot("public-0"))?.runId).toBe(ownerRun);
    expect(await status(owner.port, SLOT_READY_PATH)).toBe(200);

    const port = await freePort();
    let standbyReady = false;
    const standby = slotServer(lobbies, w.ids, "standby", port, { revision: "r1", staleMs: 1000 }).then((server) => { standbyReady = true; return server; });
    // Listening, it answers its startup probe 503 and every other route 503, /mcp included.
    await until(async () => (await status(port, SLOT_READY_PATH).catch(() => 0)) === 503);
    expect(await status(port, "/mcp", mcpPost)).toBe(503);
    expect(await status(port, "/wake")).toBe(503);
    expect(await status(port, `/lobbies/x/match`)).toBe(503);

    // Past the staleness window, the owner still holds the slot and plays its match.
    await sleep(1500);
    expect(standbyReady).toBe(false);
    expect((await lobbies.resolveSlot("public-0"))?.runId).toBe(ownerRun);
    expect(await outcome()).toBeNull();
    expect(await status(port, SLOT_READY_PATH)).toBe(503);

    expect(await until(async () => (await outcome()) ?? undefined)).toMatch(/^(colony_[01]_won|draw)$/);
    expect(await rated()).toEqual([1, 1]);
    // Released, the slot goes to the waiting instance as before.
    const successor = await standby;
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://standby.test/mcp");
    expect(await status(successor.port, SLOT_READY_PATH)).toBe(200);
    expect(await rated()).toEqual([1, 1]);
  });

  it("takes the slot once the owner's heartbeat is stale, ending the begun match not played and unrated", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, lobbies, outcome, rated } = await world();
    const owner = await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1" }, LONG);
    await begun(lobbies);
    // The owner's process is gone: close() publishes no outcome and stops its heartbeat.
    await owner.close();
    servers.splice(servers.indexOf(owner), 1);
    const startedAt = Date.now();
    const successor = await slotServer(lobbies, w.ids, "successor", 0, { revision: "r1", staleMs: 500 });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://successor.test/mcp");
    expect(await until(async () => (await outcome()) ?? undefined)).toBe("not_played");
    expect(await rated()).toEqual([0, 0]);
    expect(await status(successor.port, SLOT_READY_PATH)).toBe(200);
  });

  it.each([
    { name: "another revision (a deploy)", wiring: { revision: "r2" } },
    { name: "an unknown revision", wiring: {} },
  ])("lets $name take the slot at once, ending the live owner's begun match not played", async ({ wiring }) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, lobbies, outcome, rated } = await world();
    await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1" }, LONG);
    await begun(lobbies);
    const deployed = await slotServer(lobbies, w.ids, "deployed", 0, wiring);
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://deployed.test/mcp");
    expect(await until(async () => (await outcome()) ?? undefined)).toBe("not_played");
    expect(await rated()).toEqual([0, 0]);
    expect(await status(deployed.port, SLOT_READY_PATH)).toBe(200);
  });

  it("lets a same-revision instance take a slot whose match has not begun, as before", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = retentionWorld(Date.now());
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 300 });
    // No lobby holds the slot: the owner holds no begun match.
    await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1" });
    const next = await slotServer(lobbies, w.ids, "next", 0, { revision: "r1" });
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://next.test/mcp");
    expect(await status(next.port, SLOT_READY_PATH)).toBe(200);
  });
});

describe("the slot's instance record", () => {
  const instance = (runId: string) => ({ runId, mcpUrl: `http://${runId}.test/mcp`, spectatorUrl: `http://${runId}.test/` });

  it("defers only to a fresh same-revision owner of the begun match, and refuses a superseded run's heartbeat", async () => {
    let t = Date.UTC(2026, 9, 26, 5, 0, 0);
    const w = retentionWorld(t);
    const a = value(await w.ids.claimUsername("RecA")), b = value(await w.ids.claimUsername("RecB"));
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 300, now: () => t });
    const claim = { revision: "r1", staleMs: 30_000 };
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
    expect(w.docs.get("instances/public-0")).toMatchObject({ runId: "owner", revision: "r1", heartbeatAt: String(t) });
    // Holding no lobby, the owner is no reason to wait.
    expect(await lobbies.registerInstance("public-0", instance("owner2"), claim)).toEqual({ registered: true });
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });

    const lobby = await w.store.transaction(async (read) => {
      const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, t);
      return { result: paired.lobby, writes: paired.writes };
    });
    // During the countdown no match has begun: a same-revision starter takes the slot.
    expect(await lobbies.registerInstance("public-0", instance("countdown"), claim)).toEqual({ registered: true });
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
    t += 60_000;
    value(await lobbies.beginMatch(lobby.id, "public-0", "owner"));
    // Beginning stamps the heartbeat, though registration was a minute earlier.
    expect(w.docs.get("instances/public-0")?.heartbeatAt).toBe(String(t));

    t += 29_999;
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    expect((await lobbies.resolveSlot("public-0"))?.runId).toBe("owner");
    expect(await lobbies.heartbeat("public-0", "owner")).toBe(true);
    t += 29_999;
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    // Another revision, or none, takes the slot at once; so does anyone once the heartbeat is stale.
    for (const other of [{ revision: "r2", staleMs: 30_000 }, undefined]) {
      expect(await lobbies.registerInstance("public-0", instance("deploy"), other)).toEqual({ registered: true });
      expect(await lobbies.heartbeat("public-0", "owner")).toBe(false);
      // The owner back with a fresh r1 heartbeat (its run still began the match): the standby defers again.
      expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
      expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    }
    // An owner of unknown revision (as registered by older code) is no reason to wait.
    await lobbies.registerInstance("public-0", instance("owner"));
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: true });
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
    t += 30_000;
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: true });
    // The superseded owner can neither refresh its heartbeat nor end the match.
    expect(await lobbies.heartbeat("public-0", "owner")).toBe(false);
    expect(w.docs.get("instances/public-0")).toMatchObject({ runId: "standby", heartbeatAt: String(t) });
    expect(await lobbies.endMatch(lobby.id, "owner", "colony_0_won")).toEqual({ ok: false, reason: "superseded" });
    expect(value(await lobbies.endMatch(lobby.id, "standby", "not_played"))).toEqual({ next: null });
  });
});

// Cloud Run may route the owner nothing while a same-revision instance waits
// (the waiter holds a max-instances-1 service's one place). An owner that has heard no
// request for the unheard window is taken to be gone; one still reached keeps its match.
describe("an owner players can no longer reach while a same-revision instance waits", { timeout: 30_000 }, () => {
  it("is replaced once it has heard no request for the unheard window: the begun match is not played and unrated, and the newcomer serves the slot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { w, lobbies, outcome, rated } = await world();
    // Its public URL answers nothing, so its self-probe never arrives. A 100 ms heartbeat
    // keeps it fresh against the default 30 s staleness window throughout.
    const owner = await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1", heartbeatMs: 100 }, LONG);
    const ownerRun = await begun(lobbies);
    // A player's last request, reported by the next beats.
    const lastHeard = Date.now();
    expect(await status(owner.port, "/wake")).toBe(204);
    await sleep(300);
    // A keep-alive arriving later is not a player's request: it never counts as being reached.
    const held = new AbortController();
    void fetch(`http://127.0.0.1:${owner.port}${KEEP_ALIVE_PATH}`, { signal: held.signal }).catch(() => {});

    let successorReady = false;
    const pending = slotServer(lobbies, w.ids, "successor", 0, { revision: "r1", unheardMs: 1000 }).then((server) => { successorReady = true; return server; });
    await sleep(300);
    expect(successorReady).toBe(false);
    expect((await lobbies.resolveSlot("public-0"))?.runId).toBe(ownerRun);
    const successor = await pending;
    const tookAfter = Date.now() - lastHeard;
    held.abort();
    // By the unheard rule (1 s), long before the heartbeat could go stale (30 s).
    expect(tookAfter).toBeGreaterThanOrEqual(1000);
    expect(tookAfter).toBeLessThan(5000);
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://successor.test/mcp");
    expect(await until(async () => (await outcome()) ?? undefined)).toBe("not_played");
    expect(await rated()).toEqual([0, 0]);
    expect(await status(successor.port, SLOT_READY_PATH)).toBe(200);
    // The owner's failing self-probe is logged once for its streak, not once per beat.
    const probeErrors = errors.mock.calls.filter((args) => String(args[0]).includes("antwar slot public-0: self-probe http://owner.test/wake failed"));
    expect(probeErrors).toHaveLength(1);
  });

  it("keeps the slot while its own self-probe reaches it, however quiet its players: the match records its natural, rated result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { w, lobbies, outcome, rated, keys } = await world();
    // Its public URL is its own address: each beat's GET /wake arrives, as through a front end that still routes to it.
    const ownerPort = await freePort();
    const owner = await slotServer(lobbies, w.ids, "owner", ownerPort, { revision: "r1", heartbeatMs: 100, publicUrl: `http://127.0.0.1:${ownerPort}` });
    const ownerRun = await begun(lobbies);
    expect(owner.port).toBe(ownerPort);
    // The seats join once, as the match begins; from then on its players are quiet.
    await joinSeats(owner.port, keys);

    const port = await freePort();
    let standbyReady = false;
    const standby = slotServer(lobbies, w.ids, "standby", port, { revision: "r1", unheardMs: 1000 }).then((server) => { standbyReady = true; return server; });
    await until(async () => (await status(port, SLOT_READY_PATH).catch(() => 0)) === 503);
    // Past the unheard window, with no player request at all, the owner still holds the slot.
    await sleep(1500);
    expect(standbyReady).toBe(false);
    expect((await lobbies.resolveSlot("public-0"))?.runId).toBe(ownerRun);
    expect(await outcome()).toBeNull();

    expect(await until(async () => (await outcome()) ?? undefined)).toMatch(/^(colony_[01]_won|draw)$/);
    expect(await rated()).toEqual([1, 1]);
    const successor = await standby;
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://standby.test/mcp");
    expect(await status(successor.port, SLOT_READY_PATH)).toBe(200);
  });

  it("at the default windows, takes an unheard owner's begun match within 30 s of the wait and defers to a heard one", async () => {
    // The successor ends the match on its first poll after registering.
    expect(SLOT_UNHEARD_MS + 2 * SLOT_POLL_MS).toBeLessThan(SLOT_STALE_MS);
    let t = Date.UTC(2026, 9, 27, 1, 0, 0);
    const w = retentionWorld(t);
    const a = value(await w.ids.claimUsername("HeardA")), b = value(await w.ids.claimUsername("HeardB"));
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 300, now: () => t });
    const claim = { revision: "r1", staleMs: SLOT_STALE_MS, unheardMs: SLOT_UNHEARD_MS };
    const instance = (runId: string) => ({ runId, mcpUrl: `http://${runId}.test/mcp`, spectatorUrl: `http://${runId}.test/` });
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
    const lobby = await w.store.transaction(async (read) => {
      const paired = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: [[a.identity], [b.identity]] }, t);
      return { result: paired.lobby, writes: paired.writes };
    });
    t += 60_000;
    value(await lobbies.beginMatch(lobby.id, "public-0", "owner"));
    // Beginning stamps both: the owner is alive and reached now.
    expect(w.docs.get("instances/public-0")).toMatchObject({ heartbeatAt: String(t), heardAt: String(t) });

    // A heard owner: every beat reports a request since the last; the waiter defers well past the window.
    const begunAt = t;
    for (let beat = 1; beat <= 12; beat++) {
      t = begunAt + beat * SLOT_HEARTBEAT_MS;
      expect(await lobbies.heartbeat("public-0", "owner", t - 1000)).toBe(true);
      expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    }

    // Unheard from now: its beats stay fresh but report the same last request.
    const lastHeard = t - 1000;
    t = lastHeard + SLOT_UNHEARD_MS - 1;
    expect(await lobbies.heartbeat("public-0", "owner", lastHeard)).toBe(true);
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    t = lastHeard + SLOT_UNHEARD_MS;
    // The heartbeat is 1 ms old: only the unheard rule lets the waiter take the slot.
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: true });
    expect(await lobbies.heartbeat("public-0", "owner", t)).toBe(false);

    // A record without heardAt (written by older code) is measured from its heartbeat.
    expect(await lobbies.registerInstance("public-0", instance("owner"), claim)).toEqual({ registered: true });
    const { heardAt: _, ...withoutHeard } = w.docs.get("instances/public-0")!;
    w.docs.set("instances/public-0", withoutHeard);
    const beatAt = t;
    t = beatAt + SLOT_UNHEARD_MS - 1;
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: false, ownerRunId: "owner" });
    t = beatAt + SLOT_UNHEARD_MS;
    expect(await lobbies.registerInstance("public-0", instance("standby"), claim)).toEqual({ registered: true });
    expect(value(await lobbies.endMatch(lobby.id, "standby", "not_played"))).toEqual({ next: null });
    expect(value(await lobbies.readLobby(lobby.id))).toMatchObject({ outcome: "not_played" });
  });
});

/**
 * Forces the race behind CI's teardown timeout on the server listening on `port`:
 * its drop of every connection lands while a request on a reused (kept-alive) connection is
 * unanswered. Once armed, the drop and such a request are made to coincide, with no timer:
 * the drop, when reached, is deferred (closeAllConnections returns at once, so close() goes
 * on to server.close) until the next request on a reused connection; a reused-connection
 * request that arrives first waits, unanswered, for the drop. Either way the real drop then
 * runs and that request is never answered, as when the drop lands on it in flight.
 */
function forceDropOnReusedRequest(port: number) {
  const realDrop = Server.prototype.closeAllConnections;
  const realEmit = Server.prototype.emit;
  const ownedBy = (server: Server) => (server.address() as AddressInfo | null)?.port === port;
  const served = new WeakMap<Socket, number>();
  let armed = false;
  let pendingDrop: (() => void) | null = null;
  let heldRequest: (() => void) | null = null;
  let firedOn: { method: string; path: string } | null = null;
  const dropSpy = vi.spyOn(Server.prototype, "closeAllConnections").mockImplementation(function (this: Server) {
    if (!ownedBy(this)) return realDrop.call(this);
    pendingDrop = () => realDrop.call(this);
    if (heldRequest !== null) heldRequest();
  });
  const emitSpy = vi.spyOn(Server.prototype, "emit").mockImplementation(function (this: Server, event: string | symbol, ...args: unknown[]) {
    if (event !== "request" || !ownedBy(this)) return Reflect.apply(realEmit, this, [event, ...args]) as boolean;
    const req = args[0] as IncomingMessage;
    const requests = (served.get(req.socket) ?? 0) + 1;
    served.set(req.socket, requests);
    if (!armed || firedOn !== null || heldRequest !== null || requests < 2) return Reflect.apply(realEmit, this, [event, ...args]) as boolean;
    const fire = () => {
      heldRequest = null;
      firedOn = { method: req.method ?? "", path: req.url ?? "" };
      const drop = pendingDrop!;
      pendingDrop = null;
      drop();
    };
    if (pendingDrop !== null) fire();
    else heldRequest = fire;
    return true;
  });
  return {
    /** From now on the drop waits for a reused-connection request, and such a request for the drop. */
    arm: () => { armed = true; },
    /** The request the drop landed on, or null while it has not run. */
    firedOn: () => firedOn,
    /** Cleanup on any path: a drop still deferred runs now, and the spies are restored. */
    restore: () => {
      const drop = pendingDrop;
      pendingDrop = null;
      drop?.();
      dropSpy.mockRestore();
      emitSpy.mockRestore();
    },
  };
}

describe("a superseded instance", { timeout: 30_000 }, () => {
  it("answers no request and shuts down once a newcomer takes its slot during the countdown; the seat reconnects to the newcomer, which plays the match to its natural, rated result", async () => {
    await superseded(false);
  });

  it("does so too when its connection drop lands on a request in flight on a reused connection (forced)", async () => {
    await superseded(true);
  });
});

async function superseded(force: boolean): Promise<void> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { w, lobbies, lobby, outcome, rated, keys } = await world(3000);
  // Hold the superseded server's listener open until released, so its answers while
  // shutting down are observable; connections it already has are still dropped.
  const listenerClose = Server.prototype.close;
  let releaseListener!: () => void;
  const listenerReleased = new Promise<void>((resolve) => { releaseListener = resolve; });
  /** The ports of the servers that have asked to stop listening. */
  const closing: number[] = [];
  const closeSpy = vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback?: (err?: Error) => void) {
    const address = this.address() as AddressInfo | null;
    if (address !== null) closing.push(address.port);
    void listenerReleased.then(() => listenerClose.call(this, callback));
    return this;
  });
  let forced: ReturnType<typeof forceDropOnReusedRequest> | null = null;
  let retired = 0;
  try {
    const owner = await slotServer(lobbies, w.ids, "owner", 0, { revision: "r1", onRetired: () => { retired += 1; } });
    if (force) forced = forceDropOnReusedRequest(owner.port);
    // The owner seats the lobby for its countdown and the seat joins it there.
    await until(() => owner.game.nextStart?.kind === "scheduled");
    const first = await connect(owner.port);
    expect((await first.call("join", { key: keys[0] })).isError).toBe(false);
    expect(await status(owner.port, SLOT_READY_PATH)).toBe(200);

    // A same-revision newcomer takes the slot at once: no match has begun.
    const next = await slotServer(lobbies, w.ids, "next", 0, { revision: "r1" });
    expect((await lobbies.resolveSlot("public-0"))?.mcpUrl).toBe("http://next.test/mcp");
    expect(await lobbies.slotHolder("public-0")).toMatchObject({ lobbyId: lobby.id, matchRunId: null });
    forced?.arm();

    // Superseded, the owner drops every connection it has and asks to stop listening, in one
    // step (src/server.ts close()). It is probed only after that step, each probe on its own
    // new connection: a probe on a kept-alive connection, or on any connection open before the
    // drop, can be reset by the drop and fail as a fetch error instead of reporting a status.
    await until(() => closing.includes(owner.port));
    // With its listener held open, the superseded owner answers every route 503, its startup probe included.
    expect(await freshStatus(owner.port, SLOT_READY_PATH)).toBe(503);
    expect(await freshStatus(owner.port, "/mcp", mcpPost)).toBe(503);
    expect(await freshStatus(owner.port, `/mcp/${keys[0]}`, mcpPost)).toBe(503);
    expect(await freshStatus(owner.port, "/wake")).toBe(503);
    expect(await freshStatus(owner.port, `/lobbies/${lobby.id}/match`)).toBe(503);
    expect(await freshStatus(owner.port, KEEP_ALIVE_PATH)).toBe(503);
    // Its seat's open session is gone with it.
    await expect(first.call("observe")).rejects.toThrow();
    await first.close().catch(() => {});
    // Forced: the drop landed on the seat's own call, in flight on its kept-alive connection.
    if (forced !== null) expect(forced.firedOn()).toEqual({ method: "POST", path: "/mcp" });
    expect(retired).toBe(0);

    // Shut down: it stops listening and signals retirement once, so its process exits (src/main.ts).
    releaseListener();
    await until(() => retired === 1);
    await expect(freshStatus(owner.port, "/wake")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(owner.game.match).toBeNull();

    // The seat reconnects to the newcomer, which plays the lobby to its natural result, rated.
    const seat = await connect(next.port);
    try {
      await until(async () => !(await seat.call("join", { key: keys[0] })).isError);
      // The other seat joins the newcomer's match too.
      await joinSeats(next.port, [keys[1]]);
      expect(await until(async () => (await outcome()) ?? undefined)).toMatch(/^(colony_[01]_won|draw)$/);
      expect(await rated()).toEqual([1, 1]);
      expect(next.game.match?.result).not.toBeNull();
    } finally {
      await seat.close().catch(() => {});
    }
    expect(retired).toBe(1);
  } finally {
    // On every path, so a failure above reports as itself and teardown closes servers for real.
    forced?.restore();
    releaseListener();
    closeSpy.mockRestore();
  }
}
