/// <reference types="node" />
/**
 * After its match is released, a match server does not count as idle, and
 * does not stop, while that match's delayed playback is outstanding. A slot server may
 * stop only once its slot's Activity (src/slots/activity.ts) is idle, so "stop" here is
 * that Activity's whenIdle(). The viewer still receives the delayed frames through the
 * final frame and its result, on the unchanged rated (300 s) and unrated (60 s) delays,
 * and a private match still admits only a viewer with a current invite.
 */
import { createServer, type AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { StreamMessage, StreamResult } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { spectatorDelaySeconds } from "../../src/live/match-access.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { LiveGame } from "../../src/server.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { slotActivity } from "../../src/slots/activity.ts";
import { KEEP_ALIVE_PATH } from "../../src/slots/keepAlive.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { tempDir } from "../server/helpers.ts";
import { decodeData, ManualClock, RecordedServer } from "./helpers.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** A viewer over real HTTP, decoding every data message as it arrives. */
async function view(url: string, token?: string): Promise<{ status: number; messages: StreamMessage[] }> {
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const res = await fetch(url, { signal: abort.signal, headers: token ? { "x-antwar-invite": token } : {} });
  const viewer = { status: res.status, messages: [] as StreamMessage[] };
  if (res.status !== 200) { await res.body?.cancel(); return viewer; }
  const reader = res.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (block.startsWith("data: ")) viewer.messages.push(decodeData(block.slice(6)));
      }
    }
  })().catch(() => {});
  return viewer;
}

const resultOf = (messages: readonly StreamMessage[]): StreamResult | null =>
  messages.flatMap(m => m.events.flatMap(e => (e.kind === "end" ? [e.result] : [])))[0] ?? null;

/** Lets socket writes reach the viewer and store promises settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/** Tracks whether the slot's stop wait has resolved. */
function stopWait(slot: string) {
  const watch = { stopped: false };
  void slotActivity(slot).whenIdle().then(() => { watch.stopped = true; });
  return watch;
}

describe("a released match's delayed playback keeps its server from idling", () => {
  it.each([
    { kind: "public", rated: true }, { kind: "public", rated: false },
    { kind: "private", rated: true }, { kind: "private", rated: false },
  ] as const)("$kind match, rated $rated: not idle until the viewer has the final frame and result", async ({ kind, rated }) => {
    const slot = `${kind}-0`, activity = slotActivity(slot), lobbyId = "00000000-0000-4000-8000-000000000347", invite = "current-invite";
    expect(activity.idle).toBe(true);
    const { docs, store } = memoryWatchStore();
    docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
    const ratings = createRatings(store), registry = createWatchRegistry(store);
    let released = false;
    const accounts = { ratings, lobbies: {
      readLobby: async () => ({ ok: true, value: { id: lobbyId, kind, rated, state: released ? "ended" : "holding",
        slot: released ? null : slot, outcome: released ? "colony_0_won" : null } }),
      resolveSlot: async () => ({ runId: "run" }),
      isInviteCurrent: async (id: string, token: string) => id === lobbyId && token === invite,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry, slot, origin: "http://127.0.0.1:9001" });
    const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
    const server = new RecordedServer(hub, clock);
    await server.listen();
    cleanup.push(() => { hub.close(); controller.close(); }, () => server.close());

    await controller.prepare(lobbyId, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1 }]);
    let state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 20 })),
      [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    const firstTick = state.tick;
    const live = { agentInfo: (agentId: string) => (agentId === "sim-a" ? { displayName: "alice", modelLabel: null, seatKey: "a" } : { displayName: "bob", modelLabel: null, seatKey: "b" }) } as LiveGame;
    controller.started(1, state, live, hub);
    expect(activity.idle).toBe(false);

    const path = server.url(`/watch/live/${lobbyId}`);
    if (kind === "private") {
      expect((await view(path)).status).toBe(404);
      expect((await view(path, "stale-invite")).status).toBe(404);
    }
    const viewer = await view(path, kind === "private" ? invite : undefined);
    expect(viewer.status).toBe(200);
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    // The match is released: its ratings commit with the lobby's end, and the slot is free.
    if (rated) expect((await ratings.applyResult({ matchId: lobbyId, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied");
    released = true;
    const stop = stopWait(slot);

    const delayMs = (rated ? 300 : 60) * 1000;
    clock.advance(delayMs - 1 - clock.now());
    await settle();
    expect(viewer.messages).toEqual([]);
    expect(activity.idle).toBe(false);
    expect(stop.stopped).toBe(false);

    // Playback under way: frames reach the viewer, the final frame and result do not yet.
    clock.advance(1001);
    await settle();
    expect(viewer.messages.length).toBeGreaterThan(0);
    expect(resultOf(viewer.messages)).toBeNull();
    expect(hub.watchStatus(lobbyId)?.playbackFinished).toBe(false);
    expect(activity.idle).toBe(false);
    expect(stop.stopped).toBe(false);

    clock.advance(2000);
    await vi.waitFor(() => expect(resultOf(viewer.messages)).not.toBeNull());
    const ticks = viewer.messages.map(m => m.tick);
    expect(viewer.messages[0]!.full).not.toBeNull();
    expect(ticks).toEqual(Array.from({ length: state.tick - firstTick + 1 }, (_, i) => firstTick + i));
    const result = resultOf(viewer.messages)!;
    expect(viewer.messages.at(-1)!.events.some(e => e.kind === "end")).toBe(true);
    expect(result).toMatchObject({ tick: state.result!.tick, winner: state.result!.winner, reason: state.result!.reason });
    expect(result.ratingChanges === undefined).toBe(!rated);
    expect(hub.watchStatus(lobbyId)).toEqual({ lobbyId, started: true, playbackFinished: true, delaySeconds: rated ? 300 : 60 });
    await vi.waitFor(() => expect(stop.stopped).toBe(true));
    expect(activity.idle).toBe(true);
  });
});

// Runs inside `firebase emulators:exec --only firestore`, which sets FIRESTORE_EMULATOR_HOST.
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulatorHost)("a real slot server after its match is released", () => {
  it.each(["public", "private"] as const)("%s: stays non-idle through delayed playback to the final frame and result", async kind => {
    const slot = `${kind}-0`, activity = slotActivity(slot);
    expect(activity.idle).toBe(true);
    const namespace = `playback-activity-${process.pid}-${Date.now().toString(36)}-${kind}`;
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
    const identities = createIdentities(store);
    const accounts = { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(), clock = new ManualClock();
    const server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: playable({ ...rulesConfig("redesign"), matchTicks: 2 }),
      accounts, watchRegistry: accounts.watch, spectatorClock: clock, startPickWindowMs: 100,
      slot: { slot, publicUrl: origin, lobbies: accounts.lobbies, identities, pollMs: 25 } });
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }), () => server.close());

    const alice = await identities.claimUsername("alice"), bob = await identities.claimUsername("bob");
    if (!alice.ok || !bob.ok) throw new Error("identity fixture failed");
    const created = await accounts.lobbies.createLobby(alice.value.key, kind, 1);
    if (!created.ok) throw new Error(created.reason);
    const lobbyId = created.value.lobby.id, invite = created.value.inviteToken;
    for (const seat of [alice.value, bob.value]) {
      const joined = await accounts.lobbies.join(lobbyId, seat.key, invite);
      if (!joined.ok) throw new Error(joined.reason);
    }
    await vi.waitFor(() => expect(server.hub.hasLobby(lobbyId)).toBe(true), { timeout: 20_000 });
    expect(activity.idle).toBe(false);

    const path = `${origin}/watch/live/${lobbyId}`;
    if (kind === "private") {
      expect((await view(path)).status).toBe(404);
      expect((await view(path, "stale-invite")).status).toBe(404);
    }
    const viewer = await view(path, kind === "private" ? invite : undefined);
    expect(viewer.status).toBe(200);

    // Released: the lobby has ended and its slot holds no lobby.
    await vi.waitFor(async () => {
      expect(await accounts.lobbies.readLobby(lobbyId)).toMatchObject({ ok: true, value: { state: "ended" } });
      expect(await accounts.lobbies.slotHolder(slot)).toBeNull();
    }, { timeout: 20_000 });
    const lobby = await accounts.lobbies.readLobby(lobbyId);
    if (!lobby.ok || lobby.value.rated === null) throw new Error("lobby fixture failed");
    const rated = lobby.value.rated;
    const stop = stopWait(slot);
    await settle();
    expect(activity.idle).toBe(false);
    expect(stop.stopped).toBe(false);
    expect(server.hub.watchStatus(lobbyId)?.playbackFinished).toBe(false);

    const delayMs = spectatorDelaySeconds({ lobbyId, visibility: kind, rated }) * 1000;
    clock.advance(delayMs - 1);
    await settle();
    expect(viewer.messages).toEqual([]);
    expect(activity.idle).toBe(false);
    expect(stop.stopped).toBe(false);

    clock.advance(1001);
    await vi.waitFor(() => { clock.advance(1000); expect(resultOf(viewer.messages)).not.toBeNull(); }, { timeout: 20_000 });
    expect(viewer.messages[0]!.full).not.toBeNull();
    expect(viewer.messages.at(-1)!.events.some(e => e.kind === "end")).toBe(true);
    expect(resultOf(viewer.messages)!.ratingChanges === undefined).toBe(!rated);
    expect(server.hub.watchStatus(lobbyId)).toMatchObject({ playbackFinished: true, delaySeconds: rated ? 300 : 60 });
    await vi.waitFor(() => expect(stop.stopped).toBe(true), { timeout: 10_000 });
    expect(activity.idle).toBe(true);
  }, 90_000);

  // The slot server's own stop path is its keep-alive (src/slots/keepAlive.ts): it holds a
  // request to its own URL open while the Activity is not idle, and holding none lets the
  // platform stop the instance. Signal handling is unchanged.
  it("its own keep-alive request stays open through delayed playback and is answered, with no other opened, only after the final frame and result", async () => {
    const slot = "public-0", activity = slotActivity(slot);
    expect(activity.idle).toBe(true);
    /** Every request this process makes to a keep-alive address; settled once answered or aborted. */
    const keepAlives: { status: number | null; settled: boolean }[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const call = realFetch(input, init);
      if (String(input instanceof Request ? input.url : input).endsWith(KEEP_ALIVE_PATH)) {
        const entry = { status: null as number | null, settled: false };
        keepAlives.push(entry);
        void call.then(res => { entry.status = res.status; }, () => {}).finally(() => { entry.settled = true; });
      }
      return call;
    });
    cleanup.push(() => spy.mockRestore());
    const open = () => keepAlives.filter(entry => !entry.settled);

    const namespace = `playback-keep-alive-${process.pid}-${Date.now().toString(36)}`;
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
    const identities = createIdentities(store);
    const accounts = { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(), clock = new ManualClock();
    const server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: playable({ ...rulesConfig("redesign"), matchTicks: 2 }),
      accounts, watchRegistry: accounts.watch, spectatorClock: clock, startPickWindowMs: 100,
      slot: { slot, publicUrl: origin, lobbies: accounts.lobbies, identities, pollMs: 25 } });
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }), () => server.close());

    const alice = await identities.claimUsername("alice"), bob = await identities.claimUsername("bob");
    if (!alice.ok || !bob.ok) throw new Error("identity fixture failed");
    const created = await accounts.lobbies.createLobby(alice.value.key, "public", 1);
    if (!created.ok) throw new Error(created.reason);
    const lobbyId = created.value.lobby.id;
    for (const seat of [alice.value, bob.value]) {
      const joined = await accounts.lobbies.join(lobbyId, seat.key, created.value.inviteToken);
      if (!joined.ok) throw new Error(joined.reason);
    }
    await vi.waitFor(() => expect(server.hub.hasLobby(lobbyId)).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(open()).toHaveLength(1), { timeout: 10_000 });
    const viewer = await view(`${origin}/watch/live/${lobbyId}`);
    expect(viewer.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await accounts.lobbies.readLobby(lobbyId)).toMatchObject({ ok: true, value: { state: "ended" } });
      expect(await accounts.lobbies.slotHolder(slot)).toBeNull();
    }, { timeout: 20_000 });
    const lobby = await accounts.lobbies.readLobby(lobbyId);
    if (!lobby.ok || lobby.value.rated === null) throw new Error("lobby fixture failed");
    const delayMs = spectatorDelaySeconds({ lobbyId, visibility: "public", rated: lobby.value.rated }) * 1000;

    // Released, with delayed playback outstanding: one keep-alive request, still unanswered.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(open()).toHaveLength(1);
    expect(keepAlives.every(entry => entry.status === null)).toBe(true);
    clock.advance(delayMs - 1);
    await settle();
    expect(viewer.messages).toEqual([]);
    expect(open()).toHaveLength(1);

    clock.advance(1001);
    await vi.waitFor(() => { clock.advance(1000); expect(resultOf(viewer.messages)).not.toBeNull(); }, { timeout: 20_000 });
    expect(viewer.messages.at(-1)!.events.some(e => e.kind === "end")).toBe(true);
    // The viewer has the final frame and result: the request is answered and none reopens.
    await vi.waitFor(() => expect(open()).toHaveLength(0), { timeout: 10_000 });
    expect(keepAlives.at(-1)!.status).toBe(204);
    const count = keepAlives.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(keepAlives).toHaveLength(count);
    expect(activity.idle).toBe(true);
  }, 90_000);
});
