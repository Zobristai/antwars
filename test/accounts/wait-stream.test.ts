/// <reference types="node" />
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { WAIT_STREAM_LIMITS, waitStreamRoutes, type WaitStreamOptions } from "../../src/accounts/waitStream.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { expiryField, WAIT_GRACE_MS, withPairedLobby, type WaitState } from "../../src/lobby/waits.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { houseCast, type Keyed } from "../lobby/house-fixtures.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/**
 * The waiting token join_queue, join_lobby and request_challenge return, and its public stream GET /wait/<token>:
 * the current state on every connect, then one final event (paired, slot_ready or expired) and the close; the life
 * bound, the open-stream caps and the 404/405/503 answers; the token granting nothing else; and each token's record
 * expiring a grace after its wait's limit, or after its wait was read final, and being removed then.
 */

// The store tests run inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; they are skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const HOUR = 60 * 60 * 1000;
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

type Body = any;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** waitStreamRoutes alone on a fresh port, over a waitStatus the test supplies. */
async function streamServer(waitStatus: Lobbies["waitStatus"], options: WaitStreamOptions = {}): Promise<number> {
  const handler = waitStreamRoutes({ waitStatus }, { pollMs: 20, ...options });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

interface Frame { readonly event: string | null; readonly data: Body }
interface Stream { readonly status: number; readonly frames: readonly Frame[]; readonly text: string; readonly ended: boolean }

/** Reads GET /wait/<token> until the server ends it or `forMs` passes, then parses its messages. */
async function read(port: number, token: string, forMs = 5_000, method = "GET"): Promise<Stream & { headers: Headers }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), forMs);
  const res = await fetch(`http://127.0.0.1:${port}/wait/${token}`, { method, signal: abort.signal });
  let text = "";
  let ended = false;
  try {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
    ended = true;
  } catch {
    // Aborted by the test's own timer: the server had not ended the stream.
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, headers: res.headers, frames: parse(text), text, ended };
}

function parse(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line !== "" && !line.startsWith(":") && !line.startsWith("retry:"));
    if (lines.length === 0) continue;
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null;
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    frames.push({ event, data: data === undefined ? undefined : JSON.parse(data) });
  }
  return frames;
}

/** A waitStatus that answers each read with the next state in turn, repeating the last. */
function sequence(...states: (WaitState | null | Error)[]): Lobbies["waitStatus"] & { reads: () => number } {
  let reads = 0;
  const status = async () => {
    const next = states[Math.min(reads++, states.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(status, { reads: () => reads });
}

const WAITING_QUEUE: WaitState = { state: "waiting", mode: "1v1", expiresAt: 1_000 };

describe("the wait stream route", () => {
  it("sends the current state, then the one final event when a re-read finds it, then closes", async () => {
    const port = await streamServer(sequence(WAITING_QUEUE, WAITING_QUEUE, { state: "paired", lobbyId: "q-1", lobbyWait: true }));
    const stream = await read(port, TOKEN);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.text.startsWith("retry: 1000\n")).toBe(true);
    expect(stream.ended).toBe(true);
    expect(stream.frames).toEqual([
      { event: null, data: WAITING_QUEUE },
      { event: "paired", data: { state: "paired", lobbyId: "q-1", lobbyWait: true } },
    ]);
  });

  it.each<WaitState>([
    { state: "slot_ready", startsAt: 5 },
    { state: "expired", reason: "time_limit" },
    { state: "expired", reason: "ended" },
  ])("a wait already over when connecting gets its final event at once and the close: %j", async (final) => {
    const status = sequence(final);
    const stream = await read(await streamServer(status), TOKEN);
    expect([stream.status, stream.ended, stream.frames]).toEqual([200, true, [{ event: final.state, data: final }]]);
    expect(status.reads()).toBe(1);
  });

  it("ends a stream at its life bound without a final event; reconnecting is sent the current state again", async () => {
    const port = await streamServer(sequence(WAITING_QUEUE), { maxMs: 150 });
    const first = await read(port, TOKEN);
    expect([first.ended, first.frames]).toEqual([true, [{ event: null, data: WAITING_QUEUE }]]);
    const again = await read(port, TOKEN);
    expect([again.ended, again.frames]).toEqual([true, [{ event: null, data: WAITING_QUEUE }]]);
  });

  it("keeps an idle stream alive with comments", async () => {
    const stream = await read(await streamServer(sequence(WAITING_QUEUE), { heartbeatMs: 30, maxMs: 300 }), TOKEN);
    expect(stream.text).toContain(": keep-alive\n\n");
  });

  it("answers an unknown or malformed token 404, a method other than GET 405, and a failed first read the retryable 503", async () => {
    expect((await read(await streamServer(sequence(null)), TOKEN)).status).toBe(404);
    const unread = sequence(WAITING_QUEUE);
    const port = await streamServer(unread);
    for (const bad of ["short", `${TOKEN}A`, "AAAAAAAAAAAAAAAAAAAAA%2F", `${TOKEN}/more`]) expect((await read(port, bad)).status, bad).toBe(404);
    expect((await read(port, TOKEN, 1_000, "POST")).status).toBe(405);
    expect(unread.reads()).toBe(0);
    const failing = await read(await streamServer(sequence(new Error("store down"))), TOKEN);
    expect([failing.status, failing.headers.get("retry-after")]).toEqual([503, "1"]);
  });

  it("ends the stream without a final event when a re-read fails", async () => {
    const stream = await read(await streamServer(sequence(WAITING_QUEUE, new Error("store down"))), TOKEN);
    expect([stream.ended, stream.frames]).toEqual([true, [{ event: null, data: WAITING_QUEUE }]]);
  });

  it("caps open streams per source with the retryable 503, and frees a place when a stream closes", async () => {
    const port = await streamServer(sequence(WAITING_QUEUE), { limits: { max: 2, perSource: 1 }, maxMs: 400 });
    const open = read(port, TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await read(port, TOKEN);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "1"]);
    expect((await open).status).toBe(200);
    expect((await read(port, TOKEN)).status).toBe(200);
  });

  it("caps open streams overall at the default limits: 256 from distinct sources, then the retryable 503 for a new source", async () => {
    const port = await streamServer(sequence(WAITING_QUEUE));
    const aborts: AbortController[] = [];
    closers.push(async () => { for (const abort of aborts) abort.abort(); });
    // One stream per source, so no source comes near its own limit.
    const open = async (n: number) => {
      const abort = new AbortController();
      aborts.push(abort);
      const res = await fetch(`http://127.0.0.1:${port}/wait/${TOKEN}`, { signal: abort.signal, headers: { "x-forwarded-for": `10.0.${n >> 8}.${n & 255}` } });
      return { status: res.status, retryAfter: res.headers.get("retry-after") };
    };
    expect(WAIT_STREAM_LIMITS).toEqual({ max: 256, perSource: 16 });
    const admitted = await Promise.all(Array.from({ length: 256 }, (_, n) => open(n)));
    expect(admitted.every((stream) => stream.status === 200)).toBe(true);
    expect(await open(256)).toEqual({ status: 503, retryAfter: "1" });
  });

  it("answers a first read slower than its timeout with the retryable 503 and frees its place", async () => {
    let reads = 0;
    const slowFirst: Lobbies["waitStatus"] = () => (reads++ === 0 ? new Promise<WaitState | null>(() => {}) : Promise.resolve({ state: "slot_ready", startsAt: 5 }));
    const port = await streamServer(slowFirst, { limits: { max: 1 }, firstReadMs: 100 });
    const started = Date.now();
    const slow = await read(port, TOKEN);
    expect([slow.status, slow.headers.get("retry-after"), Date.now() - started < 1_000]).toEqual([503, "1", true]);
    // With one place, a 200 now shows the timed-out request released it.
    expect((await read(port, TOKEN)).frames).toEqual([{ event: "slot_ready", data: { state: "slot_ready", startsAt: 5 } }]);
  });

  it("counts the life bound from admission, so a slow first read does not extend it", async () => {
    let reads = 0;
    const delayed: Lobbies["waitStatus"] = async () => {
      if (reads++ === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      return WAITING_QUEUE;
    };
    const port = await streamServer(delayed, { maxMs: 600, firstReadMs: 2_000 });
    const started = Date.now();
    const stream = await read(port, TOKEN);
    const lasted = Date.now() - started;
    expect([stream.status, stream.ended, stream.frames[0]]).toEqual([200, true, { event: null, data: WAITING_QUEUE }]);
    // From admission the bound is 600 ms; counted from after the 400 ms read it would be about 1000 ms.
    expect(lasted).toBeGreaterThanOrEqual(550);
    expect(lasted).toBeLessThan(850);
  });
});

let counter = 0;

/** The account stores on the emulator with a test clock, served by startServer, plus a fast-polling stream of their own. */
async function world() {
  const clock = { t: Date.UTC(2026, 10, 10, 9, 0, 0) };
  const namespace = `wait${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, staleHoldGraceMs: 60_000, now: () => clock.t });
  const stores: AccountStores = { identities, lobbies, ratings: createRatings(store) };
  const server: GameServer = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate", simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores,
  });
  closers.push(() => server.close());
  const fast = await streamServer((token) => lobbies.waitStatus(token));
  const call = async (op: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    return { status: res.status, body: await res.json() as Body };
  };
  const ok = async (op: string, args: Record<string, unknown>) => {
    const reply = await call(op, args);
    expect(reply.status, `${op}: ${JSON.stringify(reply.body)}`).toBe(200);
    return reply.body;
  };
  const claim = async (name: string): Promise<Keyed> => {
    const made = value(await identities.claimUsername(name));
    return { id: made.identity.id, key: made.key, displayName: made.identity.displayName };
  };
  return { clock, store, identities, lobbies, server, port: server.port, fast, call, ok, claim };
}

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** The returned token is the waitUrl's last segment, on the public site. */
function tokenOf(reply: Body): string {
  expect(reply.waitToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(reply.waitUrl).toBe(`https://antwars.ai/wait/${reply.waitToken}`);
  return reply.waitToken;
}

describe.skipIf(!host)("waiting tokens against the Firestore emulator", { timeout: 60_000 }, () => {
  /** Ann waiting in the 1v1 queue with her token, and Bob's join pairing them into a lobby that takes the public slot. */
  async function pairedQueue(w: Awaited<ReturnType<typeof world>>) {
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const annToken = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    const waiting = { state: "waiting", mode: "1v1", expiresAt: w.clock.t + 12 * HOUR };
    expect((await read(w.fast, annToken, 300)).frames).toEqual([{ event: null, data: waiting }]);
    const open = read(w.fast, annToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bobToken = tokenOf(await w.ok("join_queue", { key: bob.key, mode: "1v1" }));
    const { queue } = await w.ok("queue_status", { key: ann.key });
    expect(queue.state).toBe("matched");
    const paired = { event: "paired", data: { state: "paired", lobbyId: queue.lobbyId, lobbyWait: true } };
    const live = await open;
    expect([live.ended, live.frames]).toEqual([true, [{ event: null, data: waiting }, paired]]);
    return { ann, bob, annToken, bobToken, lobbyId: queue.lobbyId as string, paired, live };
  }

  it("join_queue's token is paired with lobbyWait, then reconnecting follows the paired lobby to slot_ready", async () => {
    const w = await world();
    const { annToken, bobToken, lobbyId, paired } = await pairedQueue(w);
    const lobby = value(await w.lobbies.readLobby(lobbyId));
    expect(lobby.state).toBe("holding");
    const ready = [{ event: "slot_ready", data: { state: "slot_ready", startsAt: lobby.startsAt, lobbyId } }];
    // Ann's live connection already got paired; her next connect is a wait on the lobby.
    expect((await read(w.port, annToken)).frames).toEqual(ready);
    // Bob first connects after the pairing: that connection gets paired, the next one the lobby.
    expect((await read(w.port, bobToken)).frames).toEqual([paired]);
    expect((await read(w.port, bobToken)).frames).toEqual(ready);
  });

  it("a reconnect after paired ends expired: ended when the paired lobby ends without its match being played", async () => {
    const w = await world();
    const { annToken, lobbyId } = await pairedQueue(w);
    // The hold never begins a match; past the grace, reading settles it ended, not played.
    w.clock.t += HOUR;
    expect((await read(w.fast, annToken)).frames).toEqual([{ event: "expired", data: { state: "expired", reason: "ended", lobbyId } }]);
    expect(value(await w.lobbies.readLobby(lobbyId))).toMatchObject({ state: "ended", outcome: "not_played" });
  });

  it("after paired, the token keeps following the lobby when its queue entry is left or replaced by a new join", async () => {
    const w = await world();
    const { ann, annToken, lobbyId } = await pairedQueue(w);
    const before = value(await w.lobbies.readLobby(lobbyId));
    const ready = [{ event: "slot_ready", data: { state: "slot_ready", startsAt: before.startsAt, lobbyId } }];
    // leave_queue leaves a matched entry as it is; a new join replaces it.
    await w.ok("leave_queue", { key: ann.key });
    w.clock.t += 1;
    const next = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    expect((await w.ok("queue_status", { key: ann.key })).queue.state).toBe("waiting");
    expect((await read(w.fast, annToken)).frames).toEqual(ready);
    expect((await read(w.fast, next, 300)).frames[0]!.data.state).toBe("waiting");
  });

  it("a paired event lost to a cut after the re-point is recovered: the lobby states carry the paired lobbyId", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const annToken = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    await w.ok("join_queue", { key: bob.key, mode: "1v1" });
    const { queue } = await w.ok("queue_status", { key: ann.key });
    // A read that re-points the token, as a stream does, whose paired never reaches the agent.
    expect(await w.lobbies.waitStatus(annToken)).toEqual({ state: "paired", lobbyId: queue.lobbyId, lobbyWait: true });
    const lobby = value(await w.lobbies.readLobby(queue.lobbyId));
    expect((await read(w.fast, annToken)).frames).toEqual([{ event: "slot_ready", data: { state: "slot_ready", startsAt: lobby.startsAt, lobbyId: queue.lobbyId } }]);
    // Before its slot, the lobby's waiting state carries the id too.
    expect(withPairedLobby({ state: "waiting", lobby: "waiting", expiresAt: 1 }, queue.lobbyId)).toEqual({ state: "waiting", lobby: "waiting", expiresAt: 1, lobbyId: queue.lobbyId });
  });

  it("a read that saw the queue token before another re-pointed it, and the entry after a rejoin, follows the lobby", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const annToken = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    await w.ok("join_queue", { key: bob.key, mode: "1v1" });
    const { queue } = await w.ok("queue_status", { key: ann.key });
    // A second reader on the same store whose read of Ann's entry is held until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entryReads = 0;
    const slow = createLobbies({
      ...w.store,
      get: async (path) => {
        if (path === `queueEntries/${ann.id}` && entryReads++ === 0) await held;
        return w.store.get(path);
      },
    }, w.identities, { publicSlots: 1, privateSlots: 1, staleHoldGraceMs: 60_000, now: () => w.clock.t });
    const overlapping = slow.waitStatus(annToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Meanwhile another stream delivers paired (re-pointing the token) and Ann rejoins, replacing her entry.
    expect(await w.lobbies.waitStatus(annToken)).toEqual({ state: "paired", lobbyId: queue.lobbyId, lobbyWait: true });
    w.clock.t += 1;
    await w.ok("join_queue", { key: ann.key, mode: "1v1" });
    release();
    const lobby = value(await w.lobbies.readLobby(queue.lobbyId));
    expect(await overlapping).toEqual({ state: "slot_ready", startsAt: lobby.startsAt, lobbyId: queue.lobbyId });
  });

  it("re-points a paired queue wait once, with the stored entry's lobbyId, however many reads race to it", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const annToken = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    await w.ok("join_queue", { key: bob.key, mode: "1v1" });
    const { queue } = await w.ok("queue_status", { key: ann.key });
    const raced = await Promise.all([1, 2, 3].map(() => w.lobbies.waitStatus(annToken)));
    const paired = { state: "paired", lobbyId: queue.lobbyId, lobbyWait: true };
    // Each read is paired, or, once another read has re-pointed the token, already the lobby's state.
    for (const state of raced) expect([paired, { state: "slot_ready", startsAt: expect.any(Number), lobbyId: queue.lobbyId }]).toContainEqual(state);
    expect(raced).toContainEqual(paired);
    // The re-pointed record expires a grace after the paired lobby's own limit, or, once a racing read found slot_ready,
    // a grace after that read.
    const lobby = value(await w.lobbies.readLobby(queue.lobbyId));
    const stored = { kind: "lobby", lobbyId: queue.lobbyId, paired: "true", identityId: ann.id, joinedAt: "" };
    expect(await w.store.get(`waits/${annToken}`)).toEqual({ ...stored, expiresAt: expect.any(String) });
    expect([expiryField(lobby.expiresAt + WAIT_GRACE_MS), expiryField(w.clock.t + WAIT_GRACE_MS)]).toContain((await w.store.get(`waits/${annToken}`))!.expiresAt);
    // Read final (slot_ready), it expires a grace after that read; a later read never raises it again.
    expect((await w.lobbies.waitStatus(annToken))!.state).toBe("slot_ready");
    expect(await w.store.get(`waits/${annToken}`)).toEqual({ ...stored, expiresAt: expiryField(w.clock.t + WAIT_GRACE_MS) });
    // Polling reads the matched entry exactly as before.
    expect((await w.ok("queue_status", { key: ann.key })).queue).toEqual(queue);
  });

  it("leave_queue removes the left join's token, ending an open stream expired: ended; a later join removes an expired one", async () => {
    const w = await world();
    const ann = await w.claim("Ann");
    const left = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    const open = read(w.fast, left);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await w.ok("leave_queue", { key: ann.key });
    const live = await open;
    expect([live.ended, live.frames.at(-1)]).toEqual([true, { event: "expired", data: { state: "expired", reason: "ended" } }]);
    expect(await w.store.get(`waits/${left}`)).toBeNull();
    expect((await read(w.fast, left)).status).toBe(404);

    w.clock.t += 1;
    const expired = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    w.clock.t += 12 * HOUR;
    expect((await read(w.fast, expired)).frames).toEqual([{ event: "expired", data: { state: "expired", reason: "time_limit" } }]);
    // Read final, its record now expires a grace after that read.
    expect((await w.store.get(`waits/${expired}`))?.expiresAt).toBe(expiryField(w.clock.t + WAIT_GRACE_MS));
    expect((await w.ok("queue_status", { key: ann.key })).queue.state).toBe("expired");
    const current = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    expect(await w.store.get(`waits/${expired}`)).toBeNull();
    expect((await read(w.fast, current, 300)).frames[0]!.data.state).toBe("waiting");
  });

  it("each record expires a grace after its wait's own limit: queue, lobby and challenge", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const queued = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    expect(await w.store.get(`waits/${queued}`)).toMatchObject({ kind: "queue", expiresAt: expiryField(w.clock.t + 12 * HOUR + WAIT_GRACE_MS) });
    const { lobby } = value(await w.lobbies.createLobby(bob.key, "public", 1));
    const seated = tokenOf(await w.ok("join_lobby", { key: bob.key, lobbyId: lobby.id }));
    expect(await w.store.get(`waits/${seated}`)).toMatchObject({ kind: "lobby", expiresAt: expiryField(lobby.expiresAt + WAIT_GRACE_MS) });

    const cast = await houseCast(w.identities, w.store, 0);
    value(await w.identities.createHandle(cast.house.key, "glm-5-3"));
    const builder = await w.claim("builder");
    const requested = await w.ok("request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
    const challengeLobby = value(await w.lobbies.readLobby(requested.lobbyId));
    expect(challengeLobby.expiresAt - challengeLobby.createdAt).toBe(15 * 60 * 1000);
    expect(await w.store.get(`waits/${tokenOf(requested)}`)).toMatchObject({ kind: "lobby", expiresAt: expiryField(challengeLobby.expiresAt + WAIT_GRACE_MS) });
  });

  it("a wait read final early is removed by the next join's sweep once its grace passes; readable until then", async () => {
    const w = await world();
    const cast = await houseCast(w.identities, w.store, 0);
    value(await w.identities.createHandle(cast.house.key, "glm-5-3"));
    const builder = await w.claim("builder");
    const requested = await w.ok("request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
    const token = tokenOf(requested);
    await w.ok("report_challenge_launch", { key: cast.house.key, requestId: requested.requestId, outcome: "failed", reason: "failed" });
    const ended = [{ event: "expired", data: { state: "expired", reason: "ended" } }];
    expect((await read(w.fast, token)).frames).toEqual(ended);
    w.clock.t += WAIT_GRACE_MS - 1;
    expect((await read(w.fast, token)).frames).toEqual(ended);
    // Within the challenge's 15-minute limit, but past the grace after it was read ended.
    w.clock.t += 2;
    const ann = await w.claim("Ann");
    await w.ok("join_queue", { key: ann.key, mode: "1v1" });
    expect(await w.store.get(`waits/${token}`)).toBeNull();
    expect((await read(w.fast, token)).status).toBe(404);
  });

  it("repeated joins by one identity keep one wait record, and the sweep removes only expired records", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob"), cid = await w.claim("Cid");
    const records = async () => (await w.store.query("waits", { orderBy: "expiresAt", direction: "ASCENDING", limit: 100 })).rows.map((row) => row.path);
    let token = "";
    for (let n = 0; n < 5; n++) {
      token = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
      await w.ok("leave_queue", { key: ann.key });
      w.clock.t += 1;
    }
    expect(await records()).toEqual([]);
    for (let n = 0; n < 5; n++) {
      token = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
      w.clock.t += 12 * HOUR; // the entry expires unread; the next join replaces it
    }
    expect(await records()).toEqual([`waits/${token}`]);

    // Ann's last token, never read, passes its limit plus grace; Bob's lobby wait is live; Cid's join sweeps.
    const { lobby } = value(await w.lobbies.createLobby(bob.key, "public", 1));
    const bobToken = tokenOf(await w.ok("join_lobby", { key: bob.key, lobbyId: lobby.id }));
    w.clock.t += WAIT_GRACE_MS;
    const cidToken = tokenOf(await w.ok("join_queue", { key: cid.key, mode: "1v1" }));
    expect((await records()).sort()).toEqual([`waits/${bobToken}`, `waits/${cidToken}`].sort());
  });

  it("a paired queue token never read before its identity rejoins still follows the paired lobby", async () => {
    const w = await world();
    const ann = await w.claim("Ann"), bob = await w.claim("Bob");
    const annToken = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    await w.ok("join_queue", { key: bob.key, mode: "1v1" });
    const { queue } = await w.ok("queue_status", { key: ann.key });
    w.clock.t += 1;
    await w.ok("join_queue", { key: ann.key, mode: "1v1" });
    const lobby = value(await w.lobbies.readLobby(queue.lobbyId));
    expect(await w.store.get(`waits/${annToken}`)).toMatchObject({ kind: "lobby", lobbyId: queue.lobbyId, paired: "true", identityId: ann.id, expiresAt: expiryField(lobby.expiresAt + WAIT_GRACE_MS) });
    expect((await read(w.fast, annToken)).frames).toEqual([{ event: "slot_ready", data: { state: "slot_ready", startsAt: lobby.startsAt, lobbyId: queue.lobbyId } }]);
  });

  it("join_lobby's token waits for a slot, settles as read_lobby does, then sends slot_ready; an open lobby past 12 hours expires", async () => {
    const w = await world();
    // One public slot, held by a full lobby whose match never begins.
    const [a, b, c, d, e] = await Promise.all(["A1", "B1", "C1", "D1", "E1"].map((name) => w.claim(name)));
    const { lobby: first } = value(await w.lobbies.createLobby(a!.key, "public", 1));
    value(await w.lobbies.join(first.id, a!.key));
    expect(value(await w.lobbies.join(first.id, b!.key)).state).toBe("holding");

    const { lobby: second } = value(await w.lobbies.createLobby(c!.key, "public", 1));
    const cJoin = await w.ok("join_lobby", { key: c!.key, lobbyId: second.id });
    expect(cJoin.lobby.state).toBe("open");
    const cToken = tokenOf(cJoin);
    expect((await read(w.fast, cToken, 300)).frames).toEqual([{ event: null, data: { state: "waiting", lobby: "open", expiresAt: second.expiresAt } }]);
    const dToken = tokenOf(await w.ok("join_lobby", { key: d!.key, lobbyId: second.id }));
    const waiting = { event: null, data: { state: "waiting", lobby: "waiting", expiresAt: second.expiresAt } };
    expect((await read(w.fast, cToken, 300)).frames).toEqual([waiting]);

    // The first hold goes stale; the next re-read settles it as read_lobby would and the second lobby takes the slot.
    const open = read(w.fast, dToken);
    await new Promise((resolve) => setTimeout(resolve, 100));
    w.clock.t += HOUR;
    const live = await open;
    const lobby = value(await w.lobbies.readLobby(second.id));
    expect(lobby.state).toBe("holding");
    expect([live.ended, live.frames]).toEqual([true, [waiting, { event: "slot_ready", data: { state: "slot_ready", startsAt: lobby.startsAt } }]]);
    expect((await read(w.fast, cToken)).frames).toEqual([{ event: "slot_ready", data: { state: "slot_ready", startsAt: lobby.startsAt } }]);

    const { lobby: third } = value(await w.lobbies.createLobby(e!.key, "public", 1));
    const eToken = tokenOf(await w.ok("join_lobby", { key: e!.key, lobbyId: third.id }));
    w.clock.t += 12 * HOUR;
    expect((await read(w.fast, eToken)).frames).toEqual([{ event: "expired", data: { state: "expired", reason: "time_limit" } }]);
  });

  it("request_challenge's token waits on the challenge's lobby and ends expired: ended when the launch fails, never with its reason", async () => {
    const w = await world();
    const cast = await houseCast(w.identities, w.store, 0);
    value(await w.identities.createHandle(cast.house.key, "glm-5-3"));
    const builder = await w.claim("builder");
    const requested = await w.ok("request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
    const token = tokenOf(requested);
    const lobby = value(await w.lobbies.readLobby(requested.lobbyId));
    expect((await read(w.fast, token, 300)).frames).toEqual([{ event: null, data: { state: "waiting", lobby: "open", expiresAt: lobby.expiresAt } }]);

    const open = read(w.fast, token);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await w.ok("report_challenge_launch", { key: cast.house.key, requestId: requested.requestId, outcome: "failed", reason: "a stored launch reason" });
    const live = await open;
    expect(live.frames.at(-1)).toEqual({ event: "expired", data: { state: "expired", reason: "ended" } });
    expect(live.text).not.toContain("launch reason");
    // challenge_status still reports the request as before.
    expect((await w.ok("challenge_status", { key: builder.key, requestId: requested.requestId })).requestId).toBe(requested.requestId);
  });

  it("a lobby wait record stores the identity holding it, a challenger's and a switched queue token's included, and the stream never sends it", async () => {
    const w = await world();
    const bob = await w.claim("Dee"), carl = await w.claim("Carl");
    const { lobby } = value(await w.lobbies.createLobby(bob.key, "public", 1));
    const seated = tokenOf(await w.ok("join_lobby", { key: bob.key, lobbyId: lobby.id }));
    expect(await w.store.get(`waits/${seated}`)).toMatchObject({ kind: "lobby", identityId: bob.id, expiresAt: expiryField(lobby.expiresAt + WAIT_GRACE_MS) });
    const waiting = await read(w.fast, seated, 300);
    await w.ok("join_lobby", { key: carl.key, lobbyId: lobby.id });
    const final = await read(w.fast, seated);
    expect(waiting.frames).toHaveLength(1);
    expect(final.frames.at(-1)?.event).toBe("slot_ready");

    const cast = await houseCast(w.identities, w.store, 0);
    value(await w.identities.createHandle(cast.house.key, "glm-5-3"));
    const builder = await w.claim("builder");
    const requested = await w.ok("request_challenge", { key: builder.key, opponent: "antwars/glm-5-3" });
    const challenger = tokenOf(requested);
    const challengeLobby = value(await w.lobbies.readLobby(requested.lobbyId));
    expect(await w.store.get(`waits/${challenger}`)).toMatchObject({ kind: "lobby", identityId: builder.id, expiresAt: expiryField(challengeLobby.expiresAt + WAIT_GRACE_MS) });
    const challengeWaiting = await read(w.fast, challenger, 300);
    await w.ok("report_challenge_launch", { key: cast.house.key, requestId: requested.requestId, outcome: "failed", reason: "failed" });
    const challengeFinal = await read(w.fast, challenger);
    expect(challengeWaiting.frames).toHaveLength(1);
    expect(challengeFinal.frames.at(-1)?.event).toBe("expired");

    // A queue token switched to its paired lobby keeps the queued identity, with the lobby's expiry.
    const { ann, annToken, lobbyId, live } = await pairedQueue(w);
    const queued = await read(w.fast, annToken, 300);
    const pairedLobby = value(await w.lobbies.readLobby(lobbyId));
    expect(await w.store.get(`waits/${annToken}`)).toMatchObject({ kind: "lobby", lobbyId, paired: "true", identityId: ann.id });
    expect([expiryField(pairedLobby.expiresAt + WAIT_GRACE_MS), expiryField(w.clock.t + WAIT_GRACE_MS)]).toContain((await w.store.get(`waits/${annToken}`))!.expiresAt);
    expect(queued.frames.at(-1)?.data).toMatchObject({ lobbyId });

    for (const [stream, id] of [[live, ann.id], [queued, ann.id], [waiting, bob.id], [final, bob.id], [challengeWaiting, builder.id], [challengeFinal, builder.id]] as const) {
      expect(stream.text).not.toContain(id);
      expect(stream.text).not.toContain("identityId");
    }
  });

  it("a token grants nothing: it is no key, and a lobby wait sends no lobby id, seat, key or invite", async () => {
    const w = await world();
    const ann = await w.claim("Ann");
    const { lobby, inviteToken } = value(await w.lobbies.createLobby(ann.key, "private", 1));
    const token = tokenOf(await w.ok("join_lobby", { key: ann.key, lobbyId: lobby.id, inviteToken }));
    for (const op of ["queue_status", "challenge_status", "read_lobby"]) {
      const reply = await w.call(op, { key: token, lobbyId: lobby.id });
      expect(reply.status, op).not.toBe(200);
    }
    const stream = await read(w.fast, token, 300);
    expect(stream.text).not.toContain(lobby.id);
    expect(stream.text).not.toContain(ann.id);
    expect(stream.text).not.toContain(ann.key);
    if (inviteToken) expect(stream.text).not.toContain(inviteToken);
  });
});
