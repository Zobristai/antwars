/// <reference types="node" />
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { createActivity, slotActivity, type Activity } from "../../src/slots/activity.ts";
import { KEEP_ALIVE_HOLD_MS, KEEP_ALIVE_MAX, KEEP_ALIVE_PATH, keepAliveWaiters, serveKeepAlive, startKeepAlive, type KeepAlive } from "../../src/slots/keepAlive.ts";
import { createAdmissionCap, type AdmissionCap } from "../../src/net/admission.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { shortConfig, tempDir } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// "a match server keeps running while its slot holds a lobby, from assignment
// until the match is released". The keep-alive tests need no store; the slot-server
// tests run inside `firebase emulators:exec --only firestore` and skip only when
// FIRESTORE_EMULATOR_HOST is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const LONG = playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding }));
/** A 1 s match that always reaches its natural time-up result. */
const SHORT = playable(shortConfig(20, { ticksPerSecond: 20, queenFounding: PUBLIC_CONFIG.queenFounding }));

const closers: (() => Promise<void> | void)[] = [];
/** Responses of streams a test holds open: fetch cancels a Response that is garbage-collected, which would close its stream mid-test. */
const held: Response[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  held.length = 0;
  vi.restoreAllMocks();
});

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Arrival { readonly method: string; status: number | null; closed: boolean }

/** A plain HTTP server answering KEEP_ALIVE_PATH from `activity`, recording every request. */
async function keepAliveTarget(activity: Activity, holdMs?: number, cap?: AdmissionCap) {
  const arrivals: Arrival[] = [];
  const server: Server = createHttpServer((req, res) => {
    const arrival: Arrival = { method: req.method ?? "", status: null, closed: false };
    arrivals.push(arrival);
    res.once("close", () => {
      arrival.closed = true;
      if (res.writableEnded) arrival.status = res.statusCode;
    });
    void serveKeepAlive(req, res, activity, holdMs, cap);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${KEEP_ALIVE_PATH}`;
  return { arrivals, url };
}

function keepAlive(activity: Activity, url: string, request?: typeof fetch): KeepAlive {
  const started = startKeepAlive({ activity, url, checkMs: 20, ...(request === undefined ? {} : { request }) });
  closers.push(() => started.close());
  return started;
}

describe("slot server keep-alive", () => {
  it("holds no request while idle, keeps one request to its own URL open while not idle, and lets it end once idle", async () => {
    const activity = createActivity();
    const { arrivals, url } = await keepAliveTarget(activity);
    const alive = keepAlive(activity, url);
    await sleep(150);
    expect(arrivals).toHaveLength(0);
    expect(alive.holding).toBe(false);

    const release = activity.hold("a lobby");
    await until(() => arrivals.length === 1 && alive.holding);
    await sleep(300);
    // Still the one request, unanswered, for as long as the hold is open.
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toEqual({ method: "GET", status: null, closed: false });
    expect(alive.holding).toBe(true);

    release();
    await until(() => arrivals[0]!.closed && !alive.holding);
    expect(arrivals[0]!.status).toBe(204);
    await sleep(150);
    expect(arrivals).toHaveLength(1);
  });

  it("reopens the request after the server's hold limit while still not idle, and stops once idle", async () => {
    const activity = createActivity();
    const { arrivals, url } = await keepAliveTarget(activity, 40);
    const alive = keepAlive(activity, url);
    const release = activity.hold("a lobby");
    await until(() => arrivals.length >= 4);
    expect(arrivals.slice(0, 3).map((arrival) => arrival.status)).toEqual([204, 204, 204]);
    release();
    await until(() => !alive.holding);
    const count = arrivals.length;
    await sleep(150);
    expect(arrivals).toHaveLength(count);
  });

  it("answers at once when idle and only to GET", async () => {
    const activity = createActivity();
    const { url } = await keepAliveTarget(activity);
    const startedAt = Date.now();
    expect((await fetch(url)).status).toBe(204);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("aborts its request on close and opens no other", async () => {
    const activity = createActivity();
    const release = activity.hold("a lobby");
    closers.push(release);
    const { arrivals, url } = await keepAliveTarget(activity);
    const alive = keepAlive(activity, url);
    await until(() => arrivals.length === 1);
    alive.close();
    await until(() => arrivals[0]!.closed);
    expect(arrivals[0]!.status).toBeNull();
    expect(alive.holding).toBe(false);
    await sleep(150);
    expect(arrivals).toHaveLength(1);
  });

  it("holds each request for less than the built-in fetch's response-headers timeout, so a request held to the server's limit is answered and reopened with no failure", async () => {
    // Node's built-in fetch gives up on a response whose headers have not arrived after
    // 300 s. Both that limit and the server's hold are scaled down 1/100 here: the global
    // dispatcher the built-in fetch uses is swapped for one with the scaled limit.
    const NODE_FETCH_HEADERS_TIMEOUT_MS = 300_000;
    const SCALE = 100;
    const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    await fetch("data:,").catch(() => {});
    const original = globals[dispatcherKey] as { constructor: new (options: { headersTimeout: number }) => { close(): Promise<void> } };
    expect(original).toBeDefined();
    const scaled = new original.constructor({ headersTimeout: NODE_FETCH_HEADERS_TIMEOUT_MS / SCALE });
    globals[dispatcherKey] = scaled;
    closers.push(async () => {
      globals[dispatcherKey] = original;
      await scaled.close();
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const activity = createActivity();
    const { arrivals, url } = await keepAliveTarget(activity, KEEP_ALIVE_HOLD_MS / SCALE);
    const alive = keepAlive(activity, url);
    const release = activity.hold("a lobby");
    closers.push(release);
    // Two requests held to the server's limit and a third reopened, all while not idle.
    await until(() => arrivals.length >= 3 || errors.mock.calls.length > 0, 15_000);
    expect(errors).not.toHaveBeenCalled();
    expect(arrivals.slice(0, 2).map((arrival) => arrival.status)).toEqual([204, 204]);
    expect(activity.idle).toBe(false);
    expect(alive.holding).toBe(true);
  }, 20_000);

  it("logs a failing streak once and retries while not idle", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const activity = createActivity();
    let attempts = 0;
    const failing = (async () => {
      attempts += 1;
      throw new Error("connection refused");
    }) as typeof fetch;
    const release = activity.hold("a lobby");
    keepAlive(activity, "http://127.0.0.1:1/keep-alive", failing);
    await until(() => attempts >= 4);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("keep-alive request to http://127.0.0.1:1/keep-alive failed");
    release();
    await sleep(60);
    const count = attempts;
    await sleep(150);
    expect(attempts).toBe(count);
  });
});

/** An open keep-alive request, ended by the test. */
function hold(url: string) {
  const abort = new AbortController();
  const answer = fetch(url, { signal: abort.signal }).then((res) => {
    held.push(res);
    return { status: res.status, retryAfter: res.headers.get("retry-after") };
  }, () => null);
  closers.push(() => abort.abort());
  return { answer, close: () => abort.abort() };
}

/** An Activity that counts the whenIdle waiters it is given. */
function countingActivity() {
  const inner = createActivity();
  let whenIdleCalls = 0;
  const activity: Activity = {
    hold: (reason) => inner.hold(reason),
    get idle() {
      return inner.idle;
    },
    whenIdle() {
      whenIdleCalls += 1;
      return inner.whenIdle();
    },
  };
  return { activity, whenIdleCalls: () => whenIdleCalls };
}

describe("keep-alive requests are capped and leave nothing behind", () => {
  it("serves at most the cap at once, refuses the next with a retryable 503, and frees a place when a request closes", async () => {
    expect(KEEP_ALIVE_MAX).toBe(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const activity = createActivity();
    closers.push(activity.hold("a lobby"));
    const cap = createAdmissionCap("keep-alive", { max: KEEP_ALIVE_MAX });
    const { arrivals, url } = await keepAliveTarget(activity, undefined, cap);
    const held = Array.from({ length: KEEP_ALIVE_MAX }, () => hold(url));
    await until(() => cap.open === KEEP_ALIVE_MAX);
    // Past the cap: refused at once, never held.
    const refused = await fetch(url);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(cap.open).toBe(KEEP_ALIVE_MAX);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/keep-alive: refused 1 request past the cap/);

    held[0]!.close();
    await until(() => cap.open === KEEP_ALIVE_MAX - 1);
    const next = hold(url);
    await until(() => cap.open === KEEP_ALIVE_MAX);
    expect(next).toBeDefined();
    // The ones held are still open and unanswered.
    expect(arrivals.filter((arrival) => !arrival.closed)).toHaveLength(KEEP_ALIVE_MAX);
  });

  it("answers every held request once idle and gives back every place", async () => {
    const activity = createActivity();
    const release = activity.hold("a lobby");
    const cap = createAdmissionCap("keep-alive", { max: KEEP_ALIVE_MAX });
    const { url } = await keepAliveTarget(activity, undefined, cap);
    const held = Array.from({ length: 3 }, () => hold(url));
    await until(() => cap.open === 3);
    release();
    expect(await Promise.all(held.map((request) => request.answer))).toEqual([1, 2, 3].map(() => ({ status: 204, retryAfter: null })));
    await until(() => cap.open === 0);
  });

  it("releases a waiter when its request closes or times out: the Activity keeps one waiter however many requests come and go", async () => {
    const { activity, whenIdleCalls } = countingActivity();
    const release = activity.hold("a lobby");
    const { arrivals, url } = await keepAliveTarget(activity, 40);
    // Closed by the caller.
    for (let i = 0; i < 10; i += 1) {
      const request = hold(url);
      await until(() => keepAliveWaiters(activity) === 1);
      request.close();
      await until(() => keepAliveWaiters(activity) === 0);
    }
    // Timed out at the hold limit and answered.
    for (let i = 0; i < 5; i += 1) {
      expect(await hold(url).answer).toEqual({ status: 204, retryAfter: null });
      expect(keepAliveWaiters(activity)).toBe(0);
    }
    expect(arrivals).toHaveLength(15);
    // Fifteen requests waited; the Activity was asked for one waiter, shared by all of them.
    expect(whenIdleCalls()).toBe(1);
    // Once idle, a waiting request is still answered.
    const last = hold(url);
    await until(() => keepAliveWaiters(activity) === 1);
    release();
    expect(await last.answer).toEqual({ status: 204, retryAfter: null });
    expect(keepAliveWaiters(activity)).toBe(0);
  });
});

let counter = 0;

function world(countdownMs: number) {
  const namespace = `k${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = () => createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store());
  const lobbies = createLobbies(store(), identities, { countdownMs });
  async function lobby(id: string): Promise<Lobby> {
    const read = await lobbies.readLobby(id);
    if (!read.ok) throw new Error(read.reason);
    return read.value;
  }
  /** A full one-a-side lobby of `kind`; its last join takes a free slot of that kind. */
  async function fill(kind: "public" | "private", names: readonly [string, string]): Promise<Lobby> {
    const keys = [];
    for (const name of names) {
      const claimed = await identities.claimUsername(name);
      if (!claimed.ok) throw new Error(claimed.reason);
      keys.push(claimed.value);
    }
    const created = await lobbies.createLobby(keys[0]!.key, kind, 1);
    if (!created.ok) throw new Error(created.reason);
    let last = created.value.lobby;
    for (const key of keys) {
      const joined = await lobbies.join(last.id, key.key, created.value.inviteToken);
      if (!joined.ok) throw new Error(joined.reason);
      last = joined.value;
    }
    return last;
  }
  return { identities, lobbies, lobby, fill };
}
type World = ReturnType<typeof world>;

interface KeepAliveCall { readonly url: string; settled: boolean; status: number | null }

/** Records every keep-alive request made through fetch; a call stays unsettled until its answer arrives. */
function watchKeepAliveRequests() {
  const calls: KeepAliveCall[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = original(input, init);
    if (url.endsWith(KEEP_ALIVE_PATH)) {
      const call: KeepAliveCall = { url, settled: false, status: null };
      calls.push(call);
      answer.then((res) => {
        call.status = res.status;
        call.settled = true;
      }, () => {
        call.settled = true;
      });
    }
    return answer;
  });
  return { calls, open: () => calls.filter((call) => !call.settled).length };
}

/** A slot server whose public URL is its own listening address, so its keep-alive reaches itself. */
async function slotServer(w: World, slot: string, simConfig: SimConfig): Promise<{ server: GameServer; url: string }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = await startServer({
    port, host: "127.0.0.1", dataDir: tempDir(), simConfig, startPickWindowMs: 100,
    feed: { matchStarted: () => {}, ticked: () => {} },
    slot: { slot, publicUrl: url, lobbies: w.lobbies, identities: w.identities, pollMs: 50 },
  });
  closers.push(() => closeServer(server));
  return { server, url };
}

const closedServers = new WeakSet<GameServer>();
async function closeServer(server: GameServer): Promise<void> {
  if (closedServers.has(server)) return;
  closedServers.add(server);
  await server.close();
}

const running = (server: GameServer) => server.game.match !== null && server.game.match.result === null;

describe.skipIf(!host)("a slot server stays up while its slot holds a lobby (Firestore emulator)", { timeout: 90_000 }, () => {
  it("keeps a public slot's server running from the assignment, through the countdown and the match, until the release commits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const keepAlives = watchKeepAliveRequests();
    const w = world(1000);
    const activity = slotActivity("public-0");
    const end = w.lobbies.endMatch.bind(w.lobbies);
    let atRelease: { idle: boolean; open: number } | null = null;
    vi.spyOn(w.lobbies, "endMatch").mockImplementation(async (...args) => {
      const released = await end(...args);
      atRelease ??= { idle: activity.idle, open: keepAlives.open() };
      return released;
    });
    const { server, url } = await slotServer(w, "public-0", SHORT);

    // No lobby holds the slot: the server holds nothing and sends no keep-alive.
    await sleep(300);
    expect(activity.idle).toBe(true);
    expect(keepAlives.calls).toHaveLength(0);

    const lobby = await w.fill("public", ["Ann", "Bob"]);
    expect(lobby).toMatchObject({ state: "holding", slot: "public-0" });
    await until(() => !activity.idle && keepAlives.open() === 1);
    expect(keepAlives.calls.map((call) => call.url)).toEqual([`${url}${KEEP_ALIVE_PATH}`]);

    // Until the release commits, every sample is busy with its one keep-alive open,
    // through the countdown and the running match.
    let sawCountdown = false;
    let sawMatch = false;
    for (;;) {
      const idle = activity.idle;
      const open = keepAlives.open();
      const live = running(server);
      const read = await w.lobby(lobby.id);
      if (read.outcome !== null) break;
      expect(idle).toBe(false);
      expect(open).toBe(1);
      if (live) sawMatch = true;
      else if (server.game.match === null) sawCountdown = true;
      await sleep(20);
    }
    expect(sawCountdown).toBe(true);
    expect(sawMatch).toBe(true);
    expect((await w.lobby(lobby.id)).outcome).toMatch(/won|draw/);
    // When the release committed, the server was still held and kept alive.
    expect(atRelease).toEqual({ idle: false, open: 1 });

    // Released and nothing waiting: the server goes idle, its keep-alive is answered and not reopened.
    await until(() => activity.idle && keepAlives.open() === 0);
    expect(keepAlives.calls.map((call) => call.status)).toEqual([204]);
    expect(await w.lobbies.slotHolder("public-0")).toBeNull();
    await sleep(1500);
    expect(keepAlives.calls).toHaveLength(1);
    expect(activity.idle).toBe(true);
  });

  it("holds a private slot assigned before its server started from the first poll, and through the hand-off to the next waiting lobby until that one is released", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const keepAlives = watchKeepAliveRequests();
    const w = world(1500);
    // Both lobbies are assigned or waiting before any server for the slot is running.
    const first = await w.fill("private", ["Cat", "Dan"]);
    const second = await w.fill("private", ["Eve", "Fay"]);
    expect(first).toMatchObject({ state: "holding", slot: "private-0" });
    expect(second.state).toBe("waiting");
    const activity = slotActivity("private-0");
    expect(activity.idle).toBe(true);

    await slotServer(w, "private-0", SHORT);
    await until(() => !activity.idle && keepAlives.open() === 1);
    let idleSince: number | null = null;
    void activity.whenIdle().then(() => {
      idleSince = Date.now();
    });

    let sawHandOff = false;
    for (;;) {
      const idleNow = idleSince !== null;
      const open = keepAlives.open();
      const [a, b] = await Promise.all([w.lobby(first.id), w.lobby(second.id)]);
      if (b.outcome !== null) break;
      // Not yet both released: never idle, the one keep-alive open, across the hand-off.
      expect(idleNow).toBe(false);
      expect(open).toBe(1);
      if (a.outcome !== null && b.state === "holding") sawHandOff = true;
      await sleep(20);
    }
    expect(sawHandOff).toBe(true);
    await until(() => idleSince !== null && keepAlives.open() === 0);
    expect(keepAlives.calls.map((call) => call.status)).toEqual([204]);
    expect(await w.lobbies.slotHolder("private-0")).toBeNull();
  });

  it("holds nothing once closed, and its keep-alive request ends", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const keepAlives = watchKeepAliveRequests();
    const w = world(200);
    const activity = slotActivity("public-0");
    const { server } = await slotServer(w, "public-0", LONG);
    await w.fill("public", ["Gus", "Hal"]);
    await until(() => running(server) && !activity.idle && keepAlives.open() === 1);
    await closeServer(server);
    expect(activity.idle).toBe(true);
    await until(() => keepAlives.open() === 0);
  });
});
