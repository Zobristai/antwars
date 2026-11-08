/**
 * After a handover a public match stays in the public live listing and a private match stays watchable
 * with its invite, at the same lobby path, served by the new server. Each "server" here is one slot server's
 * spectator side (watch controller, hub and /watch routes over HTTP) on the shared store; the gateway is any
 * other server answering /watch. The handover runs each server's spectator side as a slot server composes it
 * (spectatorHandover): the old server's saveSpectator saves the stream, recording and watch metadata, the
 * old server stops, and the new server, registered on the slot, resumes them with matchResumed (LiveHub.resumeMatch,
 * WatchController.resume) and adopts the lobby's begun match (adoptMatch), then tells its
 * spectator side so with matchAdopted, as the slot server's startResumed does once adoption commits.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { LiveGame } from "../../src/server.ts";
import { spectatorHandover } from "../../src/spectator.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import type { StreamMessage } from "../../src/live/format.ts";
import type { SpectatorSave } from "../../src/live/handover.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createWatchController, lobbySeats } from "../../src/live/watch-controller.ts";
import { createWatchRegistry, type WatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState } from "../../src/sim/types.ts";
import { playable } from "../playable.ts";
import { decodeData, ManualClock } from "./helpers.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function value<T>(outcome: LobbyOutcome<T> | { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

function world(store: Store) {
  const identities = createIdentities(store);
  const accounts: AccountStores = { identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store) };
  return { store, accounts, registry: createWatchRegistry(store) };
}
type World = ReturnType<typeof world>;

/** An HTTP listener; every request it receives is recorded, with whether another server's /watch forwarded it. */
async function listen(handle: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const requests: { url: string; forwarded: boolean }[] = [];
  const http = createServer((req, res) => {
    requests.push({ url: req.url ?? "", forwarded: req.headers["x-antwar-watch-proxy"] !== undefined });
    void handle(req, res);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise<void>(resolve => { http.closeAllConnections(); http.close(() => resolve()); });
  cleanup.push(close);
  return { origin: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests, close };
}

/** One slot server's spectator side, registered as the slot's current instance; its watch side writes through registry. */
async function slotServer(w: World, slot: string, runId: string, registry: WatchRegistry = w.registry) {
  let routes: ReturnType<typeof watchRoutes> | undefined;
  const http = await listen((req, res) => routes!(req, res));
  await w.accounts.lobbies.registerInstance(slot, { runId, mcpUrl: `${http.origin}/mcp`, spectatorUrl: `${http.origin}/` });
  const controller = createWatchController({ accounts: w.accounts, registry, slot, origin: http.origin });
  const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
  routes = watchRoutes({ accounts: w.accounts, registry: w.registry, hub, origin: http.origin });
  const stop = async () => { controller.close(); hub.close(); await http.close(); };
  cleanup.push(stop);
  return { ...http, controller, clock, hub, stop };
}

/** Any other server answering /watch: it holds no stream of its own. */
async function gateway(w: World) {
  const hub = new LiveHub(); cleanup.push(() => hub.close());
  return listen(watchRoutes({ accounts: w.accounts, registry: w.registry, hub }));
}

/** A player lobby of alice and bob holding its slot, with its begun match's opening state. */
async function seatedMatch(w: World, kind: "public" | "private", rated: boolean) {
  const [alice, bob] = await Promise.all(["alice", "bob"].map(async name => value(await w.accounts.identities.claimUsername(name))));
  const { lobby, inviteToken } = value(await w.accounts.lobbies.createLobby(alice!.key, kind, 1));
  for (const seat of [alice!, bob!]) value(await w.accounts.lobbies.join(lobby.id, seat.key, inviteToken));
  // Player-created lobbies are unrated; a rated one stands in for a queue-made match.
  if (rated) await w.store.transaction(async () => ({ result: null, writes: [{ op: "update", path: `lobbies/${lobby.id}`, fields: { rated: "true" } }] }));
  const held = value(await w.accounts.lobbies.readLobby(lobby.id));
  expect(held).toMatchObject({ state: "holding", slot: `${kind}-0`, rated });
  const seats = lobbySeats(held.colonies);
  const agents = ["sim-a", "sim-b"];
  // The game names each seat by its seat key, as the slot runner does.
  const live = { agentInfo: (agentId: string) => {
    const seat = seats[agents.indexOf(agentId)]!;
    return { displayName: seat.displayName, modelLabel: null, seatKey: seat.identityId };
  } } as unknown as LiveGame;
  const state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 40 })),
    agents.map((agentId, placement) => ({ type: "join" as const, agentId, placement: placement as 0 | 1 }))).state;
  return { lobbyId: lobby.id, slot: held.slot!, inviteToken, seats, live, state, creatorKey: alice!.key };
}

function get(origin: string, path: string, invite?: string) {
  const abort = new AbortController(); cleanup.push(() => abort.abort());
  return fetch(origin + path, { signal: abort.signal, headers: invite ? { "x-antwar-invite": invite } : {} });
}

/** The stream's data messages, read until one satisfies until. */
async function readUntil(response: Response, until: (message: StreamMessage) => boolean): Promise<StreamMessage[]> {
  const reader = response.body!.getReader(); cleanup.push(() => reader.cancel().catch(() => {}));
  const messages: StreamMessage[] = [];
  let pending = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream ended early");
    pending += new TextDecoder().decode(chunk.value);
    for (let end; (end = pending.indexOf("\n\n")) >= 0;) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      if (!frame.startsWith("data: ")) continue;
      messages.push(decodeData(frame.slice(6)));
      if (until(messages.at(-1)!)) return messages;
    }
  }
}

/** Push ticks through a hub's match until the state's tick, or to its result. */
function run(hub: LiveHub, clock: ManualClock, seq: number, state: SimState, toTick = Number.POSITIVE_INFINITY): SimState {
  while (state.result === null && state.tick < toTick) { const out = step(state, []); clock.advance(100); hub.pushTick(seq, out); state = out.state; }
  return state;
}

/** What the handover save stores: the meta as text (Firestore), the parts as bytes of their own (object storage). */
function stored(saved: SpectatorSave): SpectatorSave {
  return { meta: saved.meta, parts: new Map([...saved.parts].map(([name, bytes]) => [name, bytes.slice()])) };
}

type Seated = Awaited<ReturnType<typeof seatedMatch>>;

/** The old server starts the match at a startedAt of its own, runs to tick 10 and saves it: the save, the state and the time. */
async function savedByOld(w: World, match: Seated) {
  const old = await slotServer(w, match.slot, "run-old");
  value(await w.accounts.lobbies.beginMatch(match.lobbyId, match.slot, "run-old"));
  await old.controller.prepare(match.lobbyId, match.seats);
  old.clock.advance(1_234_000);
  old.controller.started(1, match.state, match.live, old.hub);
  await vi.waitFor(async () => expect(await w.registry.read(match.lobbyId)).toMatchObject({ runId: "run-old", origin: old.origin, startedAt: 1_234_000 }));
  const state = run(old.hub, old.clock, 1, match.state, 10);
  const save = stored(await spectatorHandover(old.hub, old.controller, new Map([[1, match.lobbyId]])).saveSpectator(1));
  return { old, state, save, now: old.clock.now() };
}

/** The old server saves and stops; the new server takes the slot and resumes it. */
async function handover(w: World, match: Seated) {
  const { old, state, save, now } = await savedByOld(w, match);
  await old.stop();
  const next = await slotServer(w, match.slot, "run-new");
  // Both servers read the same wall clock.
  next.clock.advance(now);
  const hooks = spectatorHandover(next.hub, next.controller, new Map());
  await hooks.matchResumed(1, state, match.live, save);
  // Restored, the new run takes over the lobby's begun match, so its result releases and rates as its own.
  value(await w.accounts.lobbies.adoptMatch(match.lobbyId, match.slot, "run-new", "run-old"));
  hooks.matchAdopted(1, "run-new");
  await vi.waitFor(async () => expect(await w.registry.read(match.lobbyId)).toMatchObject({ runId: "run-new", origin: next.origin, startedAt: 1_234_000, playbackFinished: false }));
  return { next, state };
}

/** A registry whose resumed writes are each in flight from their call, and land only once released. */
function heldResumes(registry: WatchRegistry) {
  let release!: () => void;
  const opened = new Promise<void>(resolve => { release = resolve; });
  const landed: Promise<boolean>[] = [];
  const held: WatchRegistry = { ...registry, resumed(match) {
    const write = opened.then(() => registry.resumed(match));
    landed.push(write);
    return write;
  } };
  return { registry: held, release, landed };
}

/**
 * Two handovers through an intermediate server whose watch writes are delayed (a stale
 * watch resume). The old server saves and stops; the intermediate restores the save; the final server takes the
 * slot, restores the match and adopts it. Superseded "loading", the intermediate restored but never adopts (its
 * adoption is refused); superseded "adopted", it adopted first, its listing's write still in flight, and handed the
 * match over again. Every watch write the intermediate started lands only after the final server's listing.
 */
async function delayedIntermediate(w: World, match: Seated, superseded: "loading" | "adopted") {
  const first = await savedByOld(w, match);
  await first.old.stop();
  let { state, save, now } = first, from = "run-old";
  const delayed = heldResumes(w.registry);
  const middle = await slotServer(w, match.slot, "run-mid", delayed.registry);
  middle.clock.advance(now);
  const middleHooks = spectatorHandover(middle.hub, middle.controller, new Map());
  await middleHooks.matchResumed(1, state, match.live, save);
  if (superseded === "adopted") {
    value(await w.accounts.lobbies.adoptMatch(match.lobbyId, match.slot, "run-mid", "run-old"));
    middleHooks.matchAdopted(1, "run-mid");
    state = run(middle.hub, middle.clock, 1, state, 20);
  }
  // The final server takes the slot while the intermediate's writes are still held.
  const final = await slotServer(w, match.slot, "run-final");
  if (superseded === "adopted") {
    // Superseded, the intermediate hands its match over: it saves and closes, its in-flight write still pending.
    save = stored(await middleHooks.saveSpectator(1));
    now = middle.clock.now();
    from = "run-mid";
    await middle.stop();
  }
  final.clock.advance(now);
  const finalHooks = spectatorHandover(final.hub, final.controller, new Map());
  await finalHooks.matchResumed(1, state, match.live, save);
  value(await w.accounts.lobbies.adoptMatch(match.lobbyId, match.slot, "run-final", from));
  finalHooks.matchAdopted(1, "run-final");
  await vi.waitFor(async () => expect(await w.registry.read(match.lobbyId)).toMatchObject({ runId: "run-final", origin: final.origin }));
  if (superseded === "loading") {
    // Its adoption refused, the intermediate's server tells its spectator side nothing and closes.
    expect(await w.accounts.lobbies.adoptMatch(match.lobbyId, match.slot, "run-mid", "run-old")).toEqual({ ok: false, reason: "superseded" });
    await middle.stop();
  }
  delayed.release();
  return { final, state, landed: await Promise.all(delayed.landed) };
}

describe("the watch registry's resumed match", () => {
  const lobbyId = "00000000-0000-4000-8000-000000000001";
  const match = { lobbyId, visibility: "public" as const, rated: true, startedAt: 1000, origin: "http://127.0.0.1:9001", slot: "public-0", runId: "run-old" };
  const moved = { origin: "http://127.0.0.1:9002", runId: "run-new" };
  /** The lobby's match as adoptMatch leaves it: held by runId. */
  const heldBy = (docs: Map<string, Fields>, runId: string) => docs.set(`lobbies/${lobbyId}`, { state: "holding", matchRunId: runId });

  it("moves only the runId and origin of the same match, in its public listing too", async () => {
    const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    await registry.register(match);
    heldBy(docs, "run-new");
    for (const changed of [{ visibility: "private" as const }, { rated: false }, { mode: "1v1" as const }, { startedAt: 1001 }, { slot: "public-1" }]) {
      await expect(registry.resumed({ ...match, ...moved, ...changed })).rejects.toThrow("identity changed");
    }
    expect(await registry.read(lobbyId)).toMatchObject({ runId: "run-old", origin: match.origin });
    expect(await registry.resumed({ ...match, ...moved })).toBe(true);
    expect(await registry.resumed({ ...match, ...moved })).toBe(true);
    expect(await registry.read(lobbyId)).toEqual({ ...match, ...moved, playbackFinished: false });
    expect(docs.get(`watchPublic/${lobbyId}`)).toMatchObject(moved);
    // The old run cannot register the match back.
    await expect(registry.register(match)).rejects.toThrow("identity changed");
  });

  it("registers a match whose registration never committed", async () => {
    const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    heldBy(docs, "run-new");
    expect(await registry.resumed({ ...match, ...moved, visibility: "private", slot: "private-0" })).toBe(true);
    expect(await registry.read(lobbyId)).toMatchObject({ ...moved, visibility: "private", playbackFinished: false });
    expect(docs.has(`watchPublic/${lobbyId}`)).toBe(false);
  });

  it("writes nothing for a run that does not hold the lobby's match: not yet adopted, adopted by another run, or no lobby", async () => {
    const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    await registry.register(match);
    for (const owner of ["run-old", "run-final"]) {
      heldBy(docs, owner);
      expect(await registry.resumed({ ...match, ...moved })).toBe(false);
    }
    expect(await registry.read(lobbyId)).toEqual({ ...match, playbackFinished: false });
    expect(docs.get(`watchPublic/${lobbyId}`)).toMatchObject({ runId: "run-old", origin: match.origin });
    // Nor does it register the match for that run.
    for (const path of [`watchMatches/${lobbyId}`, `watchPublic/${lobbyId}`]) docs.delete(path);
    expect(await registry.resumed({ ...match, ...moved })).toBe(false);
    docs.delete(`lobbies/${lobbyId}`);
    expect(await registry.resumed({ ...match, ...moved })).toBe(false);
    expect(await registry.read(lobbyId)).toBeNull();
    expect(docs.has(`watchPublic/${lobbyId}`)).toBe(false);
  });

  // The completion and replay-id writes are fenced by the lobby's matchRunId, as resumed is.
  it("refuses a superseded run's playback end and replay id on a match another run holds, and takes the holder's", async () => {
    const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    await registry.register(match);
    heldBy(docs, "run-new");
    expect(await registry.resumed({ ...match, ...moved })).toBe(true);
    // run-old, superseded, still finishes its delayed playback and saves its recording: nothing is written.
    expect(await registry.playbackFinished(lobbyId, "run-old")).toBe(false);
    expect(await registry.replaySaved(lobbyId, "run-old", "2026-10-20T10-00-00-000Z-1")).toBe(false);
    expect(await registry.read(lobbyId)).toEqual({ ...match, ...moved, playbackFinished: false });
    expect(docs.get(`watchPublic/${lobbyId}`)).toMatchObject(moved);
    // No lobby: no run holds the match.
    const lobbyDoc = docs.get(`lobbies/${lobbyId}`)!; docs.delete(`lobbies/${lobbyId}`);
    expect(await registry.playbackFinished(lobbyId, "run-new")).toBe(false);
    docs.set(`lobbies/${lobbyId}`, lobbyDoc);
    // The holder's writes land, after its match has ended too (endMatch keeps matchRunId).
    docs.set(`lobbies/${lobbyId}`, { ...lobbyDoc, state: "ended" });
    expect(await registry.playbackFinished(lobbyId, "run-new")).toBe(true);
    expect(await registry.replaySaved(lobbyId, "run-new", "2026-10-20T10-00-00-000Z-2")).toBe(true);
    expect(await registry.read(lobbyId)).toMatchObject({ ...moved, playbackFinished: true, replayId: "2026-10-20T10-00-00-000Z-2" });
    expect(docs.has(`watchPublic/${lobbyId}`)).toBe(false);
  });
});

for (const backend of ["memory", "Firestore emulator"] as const) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`a handed-over match using ${backend}`, { timeout: 60_000 }, () => {
    const stores = () => world(backend === "memory" ? memoryWatchStore().store
      : createFirestore({ projectId, namespace: `watch-handover-${randomUUID()}`, emulatorHost: host }));

    it("stays in the public live listing, watchable at its lobby path from the new server through to its rated result", async () => {
      const w = stores(), match = await seatedMatch(w, "public", true), web = await gateway(w);
      const path = `/watch/live/${match.lobbyId}`;
      const { next, state } = await handover(w, match);
      const catalog = await (await get(web.origin, "/watch/catalog")).json();
      expect(catalog.matches).toEqual([expect.objectContaining({ lobbyId: match.lobbyId, startedAt: 1_234_000, rated: true, delaySeconds: 300 })]);
      expect((await (await get(next.origin, "/watch/catalog")).json()).matches.map((row: { lobbyId: string }) => row.lobbyId)).toEqual([match.lobbyId]);

      // The same lobby path, on the web server and on the slot, is served by the new server's stream.
      const viewers = await Promise.all([web.origin, next.origin].map(origin => get(origin, path)));
      expect(viewers.map(viewer => viewer.status)).toEqual([200, 200]);
      expect(next.requests).toContainEqual({ url: path, forwarded: true });

      // The new server holds the lobby's watch metadata, so the rated result reaches the viewers once its ratings commit.
      run(next.hub, next.clock, 1, state);
      next.clock.advance(301_000);
      await new Promise(resolve => setImmediate(resolve));
      expect(next.hub.watchStatus(match.lobbyId)).toMatchObject({ started: true, playbackFinished: false });
      expect((await (await get(web.origin, "/watch/catalog")).json()).matches.map((row: { lobbyId: string }) => row.lobbyId)).toEqual([match.lobbyId]);
      // The adopting run ends the match with its rated result.
      value(await w.accounts.lobbies.endMatch(match.lobbyId, "run-new", "colony_0_won"));
      // The hub retries its rating read each second of its clock until the ratings have committed.
      await vi.waitFor(() => { next.clock.advance(1_000); expect(next.hub.watchStatus(match.lobbyId)?.playbackFinished).toBe(true); }, { timeout: 20_000 });
      const results = await Promise.all(viewers.map(viewer => readUntil(viewer, message => message.events.some(event => event.kind === "end"))));
      for (const messages of results) {
        const end = messages.at(-1)!.events.find(event => event.kind === "end");
        expect(end).toMatchObject({ result: { ratingChanges: [expect.objectContaining({ agent: 0 }), expect.objectContaining({ agent: 1 })] } });
      }
      await vi.waitFor(async () => expect((await w.registry.read(match.lobbyId))?.playbackFinished).toBe(true));
      expect((await (await get(web.origin, "/watch/catalog")).json()).matches).toEqual([]);
    });

    it("stays watchable with its invite, and only with it, at its lobby path from the new server", async () => {
      const w = stores(), match = await seatedMatch(w, "private", false), web = await gateway(w);
      const path = `/watch/live/${match.lobbyId}`;
      const { next, state } = await handover(w, match);
      expect((await (await get(web.origin, "/watch/catalog")).json()).matches).toEqual([]);
      for (const origin of [web.origin, next.origin]) {
        expect((await get(origin, path)).status).toBe(404);
        expect((await get(origin, path, "not-the-invite")).status).toBe(404);
      }
      const viewers = await Promise.all([web.origin, next.origin].map(origin => get(origin, path, match.inviteToken)));
      expect(viewers.map(viewer => viewer.status)).toEqual([200, 200]);
      expect(next.requests).toContainEqual({ url: path, forwarded: true });
      // The new server plays the match out past the unrated delay, and its stream reaches both viewers.
      run(next.hub, next.clock, 1, state);
      next.clock.advance(61_000);
      const firsts = await Promise.all(viewers.map(viewer => readUntil(viewer, () => true)));
      for (const [first] of firsts) expect(first!.full).not.toBeNull();
      // A replaced invite admits a new viewer as before; the old one no longer does.
      const renewed = value(await w.accounts.lobbies.issueInvite(match.lobbyId, match.creatorKey));
      expect((await get(web.origin, path, match.inviteToken)).status).toBe(404);
      expect((await get(web.origin, path, renewed.inviteToken)).status).toBe(200);
    });

    // An intermediate server's watch write landing after the final server adopted the match moves nothing.
    for (const superseded of ["loading", "adopted"] as const) {
      const when = superseded === "loading" ? "superseded while loading" : "superseded after adopting";
      // Loading, it publishes nothing; having adopted, its delayed write is refused by the fence.
      const lands = superseded === "loading" ? [] : [false];

      it(`stays in the public live listing, watchable at its lobby path from the final server, when an intermediate ${when} writes late`, async () => {
        const w = stores(), match = await seatedMatch(w, "public", true), web = await gateway(w);
        const path = `/watch/live/${match.lobbyId}`;
        const { final, state, landed } = await delayedIntermediate(w, match, superseded);
        expect(landed).toEqual(lands);
        expect(await w.registry.read(match.lobbyId)).toMatchObject({ runId: "run-final", origin: final.origin, startedAt: 1_234_000, playbackFinished: false });
        for (const origin of [web.origin, final.origin]) {
          expect((await (await get(origin, "/watch/catalog")).json()).matches)
            .toEqual([expect.objectContaining({ lobbyId: match.lobbyId, startedAt: 1_234_000, rated: true, delaySeconds: 300 })]);
        }
        const viewers = await Promise.all([web.origin, final.origin].map(origin => get(origin, path)));
        expect(viewers.map(viewer => viewer.status)).toEqual([200, 200]);
        expect(final.requests).toContainEqual({ url: path, forwarded: true });
        run(final.hub, final.clock, 1, state);
        final.clock.advance(301_000);
        for (const [first] of await Promise.all(viewers.map(viewer => readUntil(viewer, () => true)))) expect(first!.full).not.toBeNull();
      });

      it(`stays watchable with its invite, and only with it, at its lobby path from the final server, when an intermediate ${when} writes late`, async () => {
        const w = stores(), match = await seatedMatch(w, "private", false), web = await gateway(w);
        const path = `/watch/live/${match.lobbyId}`;
        const { final, state, landed } = await delayedIntermediate(w, match, superseded);
        expect(landed).toEqual(lands);
        expect(await w.registry.read(match.lobbyId)).toMatchObject({ runId: "run-final", origin: final.origin, visibility: "private", playbackFinished: false });
        expect((await (await get(web.origin, "/watch/catalog")).json()).matches).toEqual([]);
        for (const origin of [web.origin, final.origin]) {
          expect((await get(origin, path)).status).toBe(404);
          expect((await get(origin, path, "not-the-invite")).status).toBe(404);
        }
        const viewers = await Promise.all([web.origin, final.origin].map(origin => get(origin, path, match.inviteToken)));
        expect(viewers.map(viewer => viewer.status)).toEqual([200, 200]);
        expect(final.requests).toContainEqual({ url: path, forwarded: true });
        run(final.hub, final.clock, 1, state);
        final.clock.advance(61_000);
        for (const [first] of await Promise.all(viewers.map(viewer => readUntil(viewer, () => true)))) expect(first!.full).not.toBeNull();
      });
    }
  });
}
