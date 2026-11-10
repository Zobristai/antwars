/// <reference types="node" />
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { waitStreamRoutes, type WaitStreamOptions } from "../../src/accounts/waitStream.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { withPairedLobby, type WaitState } from "../../src/lobby/waits.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { houseCast, type Keyed } from "../lobby/house-fixtures.ts";
import { playable } from "../playable.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";

/**
 * The waiting token join_queue, join_lobby and request_challenge return, and its public stream GET /wait/<token>:
 * the current state on every connect, then one final event (paired, slot_ready or expired) and the close; the life
 * bound, the open-stream caps and the 404/405/503 answers; and the token granting nothing else.
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

  it("caps open streams per source and overall with the retryable 503, and frees a place when a stream closes", async () => {
    const port = await streamServer(sequence(WAITING_QUEUE), { limits: { max: 2, perSource: 1 }, maxMs: 400 });
    const open = read(port, TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refused = await read(port, TOKEN);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "1"]);
    expect((await open).status).toBe(200);
    expect((await read(port, TOKEN)).status).toBe(200);
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
    return { ann, bob, annToken, bobToken, lobbyId: queue.lobbyId as string, paired };
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
    const stored = { kind: "lobby", lobbyId: queue.lobbyId, paired: "true", identityId: "", joinedAt: "" };
    expect(await w.store.get(`waits/${annToken}`)).toEqual(stored);
    expect((await w.lobbies.waitStatus(annToken))!.state).toBe("slot_ready");
    expect(await w.store.get(`waits/${annToken}`)).toEqual(stored);
    // Polling reads the matched entry exactly as before.
    expect((await w.ok("queue_status", { key: ann.key })).queue).toEqual(queue);
  });

  it("a queue token ends expired: ended after leave_queue or a later join, time_limit after the 12 hours", async () => {
    const w = await world();
    const ann = await w.claim("Ann");
    const left = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    await w.ok("leave_queue", { key: ann.key });
    w.clock.t += 1;
    const replaced = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    w.clock.t += 1;
    await w.ok("leave_queue", { key: ann.key });
    const current = tokenOf(await w.ok("join_queue", { key: ann.key, mode: "1v1" }));
    const ended = [{ event: "expired", data: { state: "expired", reason: "ended" } }];
    expect((await read(w.fast, left)).frames).toEqual(ended);
    expect((await read(w.fast, replaced)).frames).toEqual(ended);
    w.clock.t += 12 * HOUR;
    expect((await read(w.fast, current)).frames).toEqual([{ event: "expired", data: { state: "expired", reason: "time_limit" } }]);
    // Polling reads the same entry exactly as before.
    expect((await w.ok("queue_status", { key: ann.key })).queue.state).toBe("expired");
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
