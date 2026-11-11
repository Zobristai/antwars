// Live now (/watch/catalog) shows each seat's rating as of the match's start for as long as the match is listed.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LiveGame } from "../../src/server.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "./helpers.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";
import { playable } from "../playable.ts";

const id = "00000000-0000-4000-8000-000000000001";
const next = "00000000-0000-4000-8000-000000000002";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

describe("Live now ratings", () => {
  it("keep each seat's start figures for as long as the match is listed", async () => {
    const { docs, store } = memoryWatchStore();
    docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
    holdMatch(docs, id, "run");
    const ratings = createRatings(store), registry = createWatchRegistry(store);
    let ended = false;
    const lobby = () => ({ id, kind: "public", size: 1, rated: true, mode: "1v1", slot: "public-0", createdAt: 0, startsAt: 0,
      state: ended ? "ended" : "holding", outcome: ended ? "colony_0_won" : null,
      colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]] });
    const accounts = { ratings, lobbies: {
      readLobby: async (key: string) => key === id ? { ok: true, value: lobby() } : { ok: false, reason: "no_such_lobby" },
      listPublic: async () => [], resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry, slot: "public-0", origin: "http://127.0.0.1:9001" });
    const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    const handle = watchRoutes({ accounts, registry, hub });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const catalog = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/watch/catalog`)).json();
    const start = [[{ displayName: "alice", modelLabel: null, rating: 1500, rd: 350, ratedMatches: 0 }],
      [{ displayName: "bob", modelLabel: null, rating: 1500, rd: 350, ratedMatches: 0 }]];

    await controller.prepare(id, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1 }]);
    let state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 3 })), [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    const live = { agentInfo: (agentId: string) => (agentId === "sim-a" ? { displayName: "alice", modelLabel: null, seatKey: "a" } : { displayName: "bob", modelLabel: null, seatKey: "b" }) } as LiveGame;
    controller.started(1, state, live, hub);
    await vi.waitFor(async () => expect((await catalog()).matches).toHaveLength(1));
    expect((await catalog()).matches[0]).toMatchObject({ lobbyId: id, rated: true, delaySeconds: 300, colonies: start });

    // The match ends and is rated, as lobbies.release does.
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    expect((await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied"); ended = true;
    const after = await ratings.readRating("a", "1v1");
    expect(after.rating).toBeGreaterThan(1500);

    // While it is still listed, it shows the figures it began with.
    for (const wait of [1000, 149_000, 149_000]) {
      clock.advance(wait);
      await new Promise(resolve => setImmediate(resolve));
      expect(hub.watchStatus(id)?.playbackFinished).toBe(false);
      expect((await catalog()).matches).toEqual([expect.objectContaining({ lobbyId: id, colonies: start })]);
    }

    // Once its playback ends, the match leaves Live now.
    clock.advance(2000);
    await vi.waitFor(() => expect(hub.watchStatus(id)?.playbackFinished).toBe(true));
    await vi.waitFor(async () => expect((await catalog()).matches).toEqual([]));
  });

  it("show a player seated in two listed matches of one mode with no rating in the later one until the earlier leaves", async () => {
    const { docs, store } = memoryWatchStore();
    for (const [key, name] of [["a", "alice"], ["b", "bob"], ["c", "carol"]]) docs.set(`identities/${key}`, { displayName: name });
    holdMatch(docs, id, "run"); holdMatch(docs, next, "run");
    const ratings = createRatings(store), registry = createWatchRegistry(store);
    const ended = new Set<string>();
    const lobbies = new Map([[id, { slot: "public-0", colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]] }],
      [next, { slot: "public-1", colonies: [[{ id: "a", displayName: "alice" }], [{ id: "c", displayName: "carol" }]] }]]);
    const lobby = (key: string) => ({ id: key, kind: "public", size: 1, rated: true, mode: "1v1", createdAt: 0, startsAt: 0, ...lobbies.get(key)!,
      state: ended.has(key) ? "ended" : "holding", outcome: ended.has(key) ? "colony_0_won" : null });
    const accounts = { ratings, lobbies: {
      readLobby: async (key: string) => lobbies.has(key) ? { ok: true, value: lobby(key) } : { ok: false, reason: "no_such_lobby" },
      listPublic: async () => [], resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const slot = (name: string) => {
      const controller = createWatchController({ accounts, registry, slot: name, origin: "http://127.0.0.1:9001" });
      const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
      cleanup.push(() => { hub.close(); controller.close(); });
      return { controller, clock, hub };
    };
    const first = slot("public-0"), second = slot("public-1");
    const handle = watchRoutes({ accounts, registry, hub: first.hub });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const catalog = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/watch/catalog`)).json();
    const colonies = async (lobbyId: string) => (await catalog()).matches.find((match: { lobbyId: string }) => match.lobbyId === lobbyId)?.colonies;
    const seat = (displayName: string, rating: { rating: number | null; rd: number | null; ratedMatches: number | null }) => ({ displayName, modelLabel: null, ...rating });
    const fresh = { rating: 1500, rd: 350, ratedMatches: 0 }, none = { rating: null, rd: null, ratedMatches: null };
    const play = (s: { controller: typeof first.controller; clock: ManualClock; hub: LiveHub }, lobbyId: string, other: string) => {
      const state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 3 })), [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: `sim-${other}`, placement: 1 }]).state;
      const live = { agentInfo: (agentId: string) => (agentId === "sim-a" ? { displayName: "alice", modelLabel: null, seatKey: "a" } : { displayName: lobbies.get(lobbyId)!.colonies[1][0]!.displayName, modelLabel: null, seatKey: other }) } as LiveGame;
      s.controller.started(1, state, live, s.hub);
      return state;
    };

    // Alice's first match ends and is rated while it is still listed.
    await first.controller.prepare(id, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1 }]);
    let state = play(first, id, "b");
    await vi.waitFor(async () => expect(await colonies(id)).toBeDefined());
    while (!state.result) { const out = step(state, []); first.clock.advance(100); first.hub.pushTick(1, out); state = out.state; }
    expect((await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied"); ended.add(id);
    const after = await ratings.readRating("a", "1v1");
    expect(after.rating).toBeGreaterThan(1500);

    // Her next 1v1 match starts later, on another slot, while the first is listed; its own start figures are newer.
    first.clock.advance(1000); second.clock.advance(first.clock.now());
    await second.controller.prepare(next, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "c", displayName: "carol", colony: 1 }]);
    play(second, next, "c");
    await vi.waitFor(async () => expect(await colonies(next)).toBeDefined());
    expect((await registry.read(next))?.seatRatings?.a).toEqual(after);
    expect((await registry.read(next))!.startedAt).toBeGreaterThan((await registry.read(id))!.startedAt);
    for (const wait of [0, 149_000, 149_000]) {
      first.clock.advance(wait);
      await new Promise(resolve => setImmediate(resolve));
      expect(first.hub.watchStatus(id)?.playbackFinished).toBe(false);
      expect(await colonies(id)).toEqual([[seat("alice", fresh)], [seat("bob", fresh)]]);
      expect(await colonies(next)).toEqual([[seat("alice", none)], [seat("carol", fresh)]]);
    }

    // Once the first match leaves Live now, the next match shows its own start figures.
    first.clock.advance(2000);
    await vi.waitFor(async () => expect(await colonies(id)).toBeUndefined());
    expect(await colonies(next)).toEqual([[seat("alice", after)], [seat("carol", fresh)]]);
  });

  it("show no rating in the next match while the earlier match's slot restarts inside its delay", async () => {
    const { docs, store } = memoryWatchStore();
    for (const [key, name] of [["a", "alice"], ["b", "bob"], ["c", "carol"]]) docs.set(`identities/${key}`, { displayName: name });
    holdMatch(docs, id, "run"); holdMatch(docs, next, "run");
    let now = 1_000_000;
    const ratings = createRatings(store), registry = createWatchRegistry(store, { now: () => now });
    const serving = new Map([["public-0", "run"], ["public-1", "run"]]);
    const lobbies = new Map([[id, { slot: "public-0", colonies: [[{ id: "a", displayName: "alice" }], [{ id: "b", displayName: "bob" }]] }],
      [next, { slot: "public-1", colonies: [[{ id: "a", displayName: "alice" }], [{ id: "c", displayName: "carol" }]] }]]);
    const lobby = (key: string) => ({ id: key, kind: "public", size: 1, rated: true, mode: "1v1", createdAt: 0, startsAt: 0, ...lobbies.get(key)!,
      state: key === id ? "ended" : "holding", outcome: key === id ? "colony_0_won" : null });
    const accounts = { ratings, lobbies: {
      readLobby: async (key: string) => lobbies.has(key) ? { ok: true, value: lobby(key) } : { ok: false, reason: "no_such_lobby" },
      listPublic: async () => [], resolveSlot: async (slot: string) => ({ runId: serving.get(slot) }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const handle = watchRoutes({ accounts, registry, hub: new LiveHub() });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const catalog = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/watch/catalog`)).json();
    const colonies = async (lobbyId: string) => (await catalog()).matches.find((match: { lobbyId: string }) => match.lobbyId === lobbyId)?.colonies;
    const seat = (displayName: string, rating: { rating: number | null; rd: number | null; ratedMatches: number | null }) => ({ displayName, modelLabel: null, ...rating });
    const fresh = { rating: 1500, rd: 350, ratedMatches: 0 }, none = { rating: null, rd: null, ratedMatches: null };
    const register = (lobbyId: string, startedAt: number, seatRatings: Record<string, { rating: number; rd: number; ratedMatches: number }>) =>
      registry.register({ lobbyId, visibility: "public", rated: true, mode: "1v1", startedAt, origin: "http://127.0.0.1:9001", slot: lobbies.get(lobbyId)!.slot, runId: "run", seatRatings });

    // Alice's first match is listed with her start figures, then ends and is rated.
    await register(id, 1000, { a: fresh, b: fresh });
    expect((await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied");
    const after = await ratings.readRating("a", "1v1");
    expect(after.rating).toBeGreaterThan(1500);
    // Her next 1v1 match starts on another slot with her new figures; then the first match's slot restarts inside its delay.
    await register(next, 2000, { a: after, c: fresh });
    serving.set("public-0", "run-restarted"); docs.set("instances/public-0", { runId: "run-restarted" });
    expect(await colonies(id)).toBeUndefined();
    for (const wait of [0, 150_000, 149_999]) {
      now += wait;
      expect(await colonies(next)).toEqual([[seat("alice", none)], [seat("carol", fresh)]]);
    }

    // Once the first match's delay has passed since its slot restarted, the next match shows its own start figures.
    now += 1;
    expect(await colonies(next)).toEqual([[seat("alice", after)], [seat("carol", fresh)]]);
    expect(docs.has(`watchPublic/${id}`)).toBe(false);
  });
});
