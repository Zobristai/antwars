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
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

describe("Live now ratings", () => {
  it("keep each seat's start rating while a rated result recorded at the live end waits behind the 300 s delay, until playback ends", async () => {
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

    // The match ends live and its rated result commits with the lobby's release, as lobbies.release does.
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    expect((await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied"); ended = true;
    const after = await ratings.readRating("a", "1v1");
    expect(after.rating).toBeGreaterThan(1500);

    // Inside the delay window the catalog still lists the match with the figures it began with.
    for (const wait of [1000, 149_000, 149_000]) {
      clock.advance(wait);
      await new Promise(resolve => setImmediate(resolve));
      expect(hub.watchStatus(id)?.playbackFinished).toBe(false);
      expect((await catalog()).matches).toEqual([expect.objectContaining({ lobbyId: id, colonies: start })]);
    }

    // Once delayed playback reaches the result, the match leaves Live now.
    clock.advance(2000);
    await vi.waitFor(() => expect(hub.watchStatus(id)?.playbackFinished).toBe(true));
    await vi.waitFor(async () => expect((await catalog()).matches).toEqual([]));
  });
});
