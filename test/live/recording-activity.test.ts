/// <reference types="node" />
/**
 * After its match is released, a match server does not count as idle,
 * and so does not stop, while that match's recording save or its playback-finished and
 * saved-recording publication is outstanding. Once it has stopped, another server returns the
 * recording through the existing /watch/recording and /watch/replays routes; a private match's
 * recording only from the private store and only to a viewer with a current invite.
 */
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import type { LiveGame } from "../../src/server.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { tempDir } from "../server/helpers.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry, type WatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createPrivateArchive, type PrivateArchive } from "../../src/replays/private-archive.ts";
import type { ReplayObject, ReplayStore } from "../../src/replays/store.ts";
import { slotActivity } from "../../src/slots/activity.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "./helpers.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

/** A registry write that fails while its switch is on; every attempt is counted. */
function flaky(registry: WatchRegistry) {
  const failing = { playbackFinished: true, replaySaved: true }, attempts = { playbackFinished: 0, replaySaved: 0 };
  const wrapped: WatchRegistry = {
    ...registry,
    async playbackFinished(lobbyId, runId) {
      attempts.playbackFinished++;
      if (failing.playbackFinished) throw new Error("fake registry unavailable");
      return registry.playbackFinished(lobbyId, runId);
    },
    async replaySaved(lobbyId, runId, replayId) {
      attempts.replaySaved++;
      if (failing.replaySaved) throw new Error("fake registry unavailable");
      return registry.replaySaved(lobbyId, runId, replayId);
    },
  };
  return { wrapped, failing, attempts };
}

async function listen(handler: ReturnType<typeof watchRoutes>): Promise<{ origin: string; server: Server }> {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
function stop(server: Server): Promise<void> {
  return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
}

describe("a match server after release, while its recording save and publication are outstanding", () => {
  it.each(["public", "private"] as const)("stays non-idle until the %s recording is saved and published, then another server returns it", async kind => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => { vi.restoreAllMocks(); });
    const lobbyId = kind === "public" ? "00000000-0000-4000-8000-000000000011" : "00000000-0000-4000-8000-000000000012";
    const slot = `${kind}-5`;
    const { docs, store } = memoryWatchStore();
    docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
    holdMatch(docs, lobbyId, "run");
    const registry = createWatchRegistry(store), flakyRegistry = flaky(registry);
    let lobby: Lobby = { id: lobbyId, kind, size: 1, state: "holding", rated: false, slot, creatorId: "a", createdAt: 0, expiresAt: 1000,
      colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]], startsAt: 0, outcome: null, mode: null };
    let invite = "current";
    const accounts = { ratings: createRatings(store), lobbies: {
      readLobby: async (key: string) => key === lobbyId ? { ok: true, value: lobby } : { ok: false, reason: "no_such_lobby" },
      listPublic: async () => [],
      resolveSlot: async () => ({ runId: "run", mcpUrl: "", spectatorUrl: "" }),
      isInviteCurrent: async (key: string, token: string) => key === lobbyId && token === invite,
    } } as unknown as AccountStores;

    // Shared object storage: the public replay store and the private archive write the same bucket.
    const blobs = new Map<string, Uint8Array>(), saved = new Map<string, Uint8Array>(), save = gate();
    let saving = 0;
    const gated = (inner: ReplayStore): ReplayStore => ({ async create(object: ReplayObject) {
      saving++; saved.set(object.name, object.body);
      await save.opened;
      await inner.create(object);
    } });
    const bucket: ReplayStore = { create: async object => { blobs.set(object.name, object.body); } };
    const read = async (name: string) => blobs.has(name) ? { body: Readable.from([blobs.get(name)!]) } : null;
    const sealed = createPrivateArchive(bucket, read, new Uint8Array(32).fill(5));
    const archive: PrivateArchive = { forLobby: id => gated(sealed.forLobby(id)), open: (identity, signal) => sealed.open(identity, signal) };
    const replays = { open: async (id: string) => read(`${id}.bin`) };

    // The match server, composed as src/spectator.ts composes a slot server's hub and controller.
    const controller = createWatchController({ accounts, registry: flakyRegistry.wrapped, slot, origin: "http://127.0.0.1:9", archive });
    const clock = new ManualClock();
    const hub = new LiveHub({ clock, replayStore: kind === "public" ? gated(bucket) : undefined, captureMatchLogs: true, ...controller.hubOptions });
    const owner = await listen(watchRoutes({ accounts, registry, hub, archive: sealed, replays, origin: "http://127.0.0.1:9" }));
    let ownerStopped = false;
    const stopOwner = async () => { if (ownerStopped) return; ownerStopped = true; controller.close(); await stop(owner.server); hub.close(); };
    cleanup.push(stopOwner);
    // Another server sharing the store and object storage, with no playback of its own.
    const otherHub = new LiveHub();
    const other = await listen(watchRoutes({ accounts, registry, hub: otherHub, archive: sealed, replays, origin: "http://127.0.0.1:8" }));
    cleanup.push(async () => { await stop(other.server); otherHub.close(); });

    await controller.prepare(lobbyId, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1 }]);
    let state = step(createMatch(35, playable({ ...rulesConfig("redesign"), matchTicks: 3 })),
      [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    const live = { agentInfo: (agentId: string) => ({ displayName: agentId === "sim-a" ? "alice" : "bob", modelLabel: null }) } as LiveGame;
    controller.started(1, state, live, hub);
    await vi.waitFor(async () => expect(await registry.read(lobbyId)).not.toBeNull());
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    // The lobby is released (match ended, slot freed) before delayed playback finishes.
    lobby = { ...lobby, state: "ended", slot: null, outcome: "stopped" } as Lobby;
    clock.advance(61_000);
    expect(hub.watchStatus(lobbyId)?.playbackFinished).toBe(true);

    const activity = slotActivity(slot);
    type Outstanding = "save" | "playback-finished" | "replay-saved" | null;
    let idleAt: Outstanding = null, phase: Outstanding = "playback-finished";
    // Stand-in for the slot server's stop, which acts only once the server is idle.
    const stopped = activity.whenIdle().then(async () => { idleAt = phase; await stopOwner(); });

    // Playback-finished publication fails and retries; the save has started but is not stored.
    await vi.waitFor(() => expect(saving).toBe(1));
    await vi.waitFor(() => expect(flakyRegistry.attempts.playbackFinished).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(activity.idle).toBe(false);
    expect(idleAt).toBeNull();

    // Publication succeeds; the save alone is outstanding.
    phase = "save";
    flakyRegistry.failing.playbackFinished = false;
    await vi.waitFor(async () => expect((await registry.read(lobbyId))?.playbackFinished).toBe(true), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(activity.idle).toBe(false);
    expect(idleAt).toBeNull();
    expect(blobs.size).toBe(0);

    // The save is stored; its saved-recording publication fails and retries.
    phase = "replay-saved";
    save.open();
    await vi.waitFor(() => expect(flakyRegistry.attempts.replaySaved).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(blobs.size).toBe(1);
    expect(activity.idle).toBe(false);
    expect(idleAt).toBeNull();
    expect((await registry.read(lobbyId))?.replayId).toBeUndefined();

    // Publication succeeds: only now is the server idle, and only now does it stop.
    phase = null;
    flakyRegistry.failing.replaySaved = false;
    await stopped;
    expect(idleAt).toBeNull();
    expect(activity.idle).toBe(true);
    expect(ownerStopped).toBe(true);
    await expect(fetch(`${owner.origin}/watch/recording/${lobbyId}`)).rejects.toThrow();

    const replayId = (await registry.read(lobbyId))?.replayId;
    expect(replayId).toMatch(/Z-\d+$/);
    const [name, plain] = [...saved][0]!;
    expect(name).toBe(`${replayId}.bin`);
    const get = (path: string, token?: string) => fetch(other.origin + path, { headers: token ? { "x-antwar-invite": token } : {} });
    const token = kind === "private" ? "current" : undefined;
    expect(await (await get(`/watch/recording/${lobbyId}`, token)).json()).toEqual({ replayId });
    const response = await get(`/watch/replays/${lobbyId}/${replayId}`, token);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(gunzipSync(plain));
    if (kind === "public") {
      expect([...blobs.keys()]).toEqual([`${replayId}.bin`]);
      return;
    }
    // Private: only sealed objects in the private store, never a public object; only with a current invite.
    expect([...blobs.keys()].every(key => key.startsWith("private/v1/") && key.endsWith(".sealed"))).toBe(true);
    expect(blobs.has(`${replayId}.bin`)).toBe(false);
    expect((await get(`/watch/recording/${lobbyId}`)).status).toBe(404);
    expect((await get(`/watch/replays/${lobbyId}/${replayId}`)).status).toBe(404);
    invite = "renewed";
    expect((await get(`/watch/recording/${lobbyId}`, "current")).status).toBe(404);
    expect((await get(`/watch/replays/${lobbyId}/${replayId}`, "current")).status).toBe(404);
    expect((await get(`/watch/replays/${lobbyId}/${replayId}`, "renewed")).status).toBe(200);
  }, 20_000);

  it("releases the holds of publications it drops on close", async () => {
    const { store } = memoryWatchStore(), slot = "public-6";
    const failing = flaky(createWatchRegistry(store));
    const controller = createWatchController({ registry: failing.wrapped, slot, origin: "http://127.0.0.1:9",
      accounts: { lobbies: { isInviteCurrent: async () => false } } as unknown as AccountStores });
    const hub = new LiveHub({ ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => { vi.restoreAllMocks(); });
    const access = { lobbyId: "00000000-0000-4000-8000-000000000013", visibility: "public" as const, rated: false };
    // A match this server serves, under the run that adopted it.
    await controller.resume({ access, startedAt: 0, seats: [] }, {} as LiveGame);
    controller.adopted(access.lobbyId, "run");
    controller.hubOptions.onPlaybackFinished!(access);
    controller.hubOptions.onReplaySaved!(access, "2026-10-20T10-00-00-000Z-1");
    expect(hub.activity).toBe(slotActivity(slot));
    expect(slotActivity(slot).idle).toBe(false);
    await vi.waitFor(() => expect(failing.attempts.playbackFinished).toBe(1));
    controller.close();
    expect(slotActivity(slot).idle).toBe(true);
  });
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulatorHost)("a real slot server after release, on the shared Firestore store", () => {
  it.each(["public", "private"] as const)("does not count as idle or stop until its %s recording is saved and published", async kind => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => { vi.restoreAllMocks(); });
    const namespace = `recording-activity-${kind}-${process.pid}-${Date.now().toString(36)}`;
    const client = () => {
      const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
      const identities = createIdentities(store);
      return { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    };
    const a = client(), b = client();
    const blobs = new Map<string, Uint8Array>(), save = gate();
    let saving = 0;
    const bucket: ReplayStore = { create: async object => { blobs.set(object.name, object.body); } };
    const gated = (inner: ReplayStore): ReplayStore => ({ async create(object) { saving++; await save.opened; await inner.create(object); } });
    const read = async (name: string) => blobs.has(name) ? { body: Readable.from([blobs.get(name)!]) } : null;
    const replaySource = { open: async (id: string) => read(`${id}.bin`) };
    const sealed = createPrivateArchive(bucket, read, new Uint8Array(32).fill(6));
    const ownerArchive: PrivateArchive = { forLobby: id => gated(sealed.forLobby(id)), open: (identity, signal) => sealed.open(identity, signal) };
    const flakyRegistry = flaky(a.watch);
    flakyRegistry.failing.playbackFinished = false;
    const directories: string[] = [];
    cleanup.push(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
    async function listenSlot(slot: string, accounts: ReturnType<typeof client>, options: { replayStore: ReplayStore; privateArchive: PrivateArchive;
      watchRegistry: WatchRegistry; spectatorClock: ManualClock }): Promise<{ server: SpectatedServer; origin: string }> {
      const reservation = createNetServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(); directories.push(dataDir);
      const server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: playable({ ...rulesConfig("redesign"), matchTicks: 2 }),
        accounts, replaySource, startPickWindowMs: 100, ...options,
        slot: { slot, publicUrl: origin, lobbies: accounts.lobbies, identities: accounts.identities, pollMs: 25 } });
      return { server, origin };
    }
    const clock = new ManualClock(), slot = `${kind}-0`;
    // The match server: its recording saves are held at the gate and its saved-recording publication fails until allowed.
    const owner = await listenSlot(slot, a, { replayStore: gated(bucket), privateArchive: ownerArchive, watchRegistry: flakyRegistry.wrapped, spectatorClock: clock });
    let ownerStopped = false;
    const stopOwner = async () => { if (!ownerStopped) { ownerStopped = true; await owner.server.close(); } };
    cleanup.push(stopOwner);
    // Another server on the shared store and object storage, serving the other kind's slot.
    const other = await listenSlot(kind === "public" ? "private-0" : "public-0", b,
      { replayStore: bucket, privateArchive: sealed, watchRegistry: b.watch, spectatorClock: new ManualClock() });
    cleanup.push(() => other.server.close());
    expect(owner.server.hub.activity).toBe(slotActivity(slot));

    const alice = await a.identities.claimUsername("alice"), bob = await a.identities.claimUsername("bob");
    if (!alice.ok || !bob.ok) throw new Error("identity fixture failed");
    const created = await a.lobbies.createLobby(alice.value.key, kind, 1);
    if (!created.ok) throw new Error(created.reason);
    const lobbyId = created.value.lobby.id, invite = created.value.inviteToken ?? "";
    for (const seat of [alice.value, bob.value]) {
      const joined = await a.lobbies.join(lobbyId, seat.key, invite);
      if (!joined.ok) throw new Error(joined.reason);
    }
    await vi.waitFor(() => expect(owner.server.hub.hasLobby(lobbyId)).toBe(true), { timeout: 20_000 });
    // The match ends and its lobby is released while delayed playback is still running.
    await vi.waitFor(async () => expect(await a.lobbies.readLobby(lobbyId)).toMatchObject({ ok: true, value: { state: "ended" } }), { timeout: 20_000 });
    expect(owner.server.hub.watchStatus(lobbyId)?.playbackFinished).toBe(false);
    clock.advance(301_000);
    await vi.waitFor(() => expect(owner.server.hub.watchStatus(lobbyId)?.playbackFinished).toBe(true), { timeout: 20_000 });

    const activity = slotActivity(slot);
    let idleEarly = true;
    // Stand-in for the slot server's stop, which acts only once the server is idle.
    const stopped = activity.whenIdle().then(async () => { if (idleEarly) throw new Error("idle while recording work was outstanding"); await stopOwner(); });
    stopped.catch(() => {});
    await vi.waitFor(() => expect(saving).toBe(1), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await b.watch.read(lobbyId))?.playbackFinished).toBe(true), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(activity.idle).toBe(false);
    expect(blobs.size).toBe(0);
    expect((await fetch(`${owner.origin}/watch/status/${lobbyId}`, { headers: { "x-antwar-invite": invite } })).status).toBe(200);

    save.open();
    await vi.waitFor(() => expect(flakyRegistry.attempts.replaySaved).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(blobs.size).toBe(1);
    expect(activity.idle).toBe(false);
    expect((await fetch(`${owner.origin}/watch/status/${lobbyId}`, { headers: { "x-antwar-invite": invite } })).status).toBe(200);

    idleEarly = false;
    flakyRegistry.failing.replaySaved = false;
    await stopped;
    expect(ownerStopped).toBe(true);
    await expect(fetch(`${owner.origin}/watch/status/${lobbyId}`)).rejects.toThrow();

    const replayId = (await b.watch.read(lobbyId))?.replayId;
    expect(replayId).toBeTruthy();
    const get = (path: string, token?: string) => fetch(other.origin + path, { headers: token ? { "x-antwar-invite": token } : {} });
    const token = kind === "private" ? invite : undefined;
    expect(await (await get(`/watch/recording/${lobbyId}`, token)).json()).toEqual({ replayId });
    const recording = await get(`/watch/replays/${lobbyId}/${replayId}`, token);
    expect(recording.status).toBe(200);
    expect((await recording.arrayBuffer()).byteLength).toBeGreaterThan(0);
    if (kind === "public") {
      expect([...blobs.keys()]).toEqual([`${replayId}.bin`]);
      return;
    }
    expect([...blobs.keys()].every(key => key.startsWith("private/v1/") && key.endsWith(".sealed"))).toBe(true);
    expect((await get(`/replays/${replayId}`)).status).toBe(404);
    expect((await get(`/watch/replays/${lobbyId}/${replayId}`)).status).toBe(404);
    expect((await get(`/watch/recording/${lobbyId}`)).status).toBe(404);
    expect((await a.lobbies.revokeInvite(lobbyId, alice.value.key)).ok).toBe(true);
    expect((await get(`/watch/replays/${lobbyId}/${replayId}`, invite)).status).toBe(404);
    expect((await get(`/watch/recording/${lobbyId}`, invite)).status).toBe(404);
  }, 90_000);
});
