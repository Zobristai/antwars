// The server logs every house handle a surface will show as "Unlisted model", with the handle, where it serves the name
// ("Each such render is logged server-side with the handle, so it gets
// fixed in HOUSE_LABELS"). No report route: the leaderboard, /watch/catalog, /watch/queue, /matches and match stream start.
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry, type WatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { logUnlistedHouse, unlistedHouseHandle } from "../../src/rating/unlistedHouse.ts";
import { historyRoutes } from "../../src/replays/history-routes.ts";
import type { HistorySource } from "../../src/replays/history-source.ts";
import type { LiveGame } from "../../src/server.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { ManualClock } from "../live/helpers.ts";
import { holdMatch, memoryWatchStore } from "../live/watch-fixtures.ts";
import { playable } from "../playable.ts";

const UNLISTED = "antwars/not-a-row";
const close: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

/** Every "antwar unlisted house handle" warning, as [surface, handle]. */
function warnings() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mock.calls.filter(([message]) => message === "antwar unlisted house handle")
    .map(([, detail]) => [(detail as { surface: string }).surface, (detail as { handle: string }).handle]);
}

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  close.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("logUnlistedHouse", () => {
  it("names each unlisted antwars handle once per response, with its surface, and nothing listed or another owner's", () => {
    const log = vi.fn();
    logUnlistedHouse("test", [UNLISTED, `${UNLISTED} #2`, "ANTWARS/NOT-A-ROW", "antwars/glm-5-3", "kite/not-a-row", "antwars/toString", null, undefined], log);
    expect(log.mock.calls).toEqual([
      ["antwar unlisted house handle", { surface: "test", handle: UNLISTED }],
      ["antwar unlisted house handle", { surface: "test", handle: "antwars/tostring" }],
    ]);
    expect([UNLISTED, "antwars/mistral-large-4", "antwars/abliterated-large-v2 #1", "alice"].map(unlistedHouseHandle)).toEqual([true, false, false, false]);
  });
});

describe("the serve points log an unlisted house handle", () => {
  it("the leaderboard, for a Benchmark row whose handle has no row", async () => {
    const w = retentionWorld(Date.now());
    const house = value(await w.ids.claimUsername("antwars"));
    const listed = value(await w.ids.createHandle(house.key, "glm-5-3")).identity;
    const unlisted = value(await w.ids.createHandle(house.key, "not-a-row")).identity;
    const ratings = createRatings(w.store, w.ids);
    await ratings.houseBackfill;
    await ratings.applyResult({ matchId: "m", teams: [[listed.id], [unlisted.id]], winner: "a" });
    const seen = warnings();
    value(await ratings.leaderboard({ limit: 10 }));
    expect(seen()).toEqual([["leaderboard", UNLISTED]]);
  });

  it("/watch/queue and /watch/catalog, for waiting agents and public lobby seats", async () => {
    const lobby = { id: "l1", kind: "public", size: 1, state: "waiting", colonies: [[{ displayName: UNLISTED }], [{ displayName: "antwars/glm-5-3" }]] };
    const accounts = { lobbies: {
      listWaiting: async () => [{ displayName: `${UNLISTED} #1`, mode: "house-1v1", joinedAt: Date.now() }],
      listUnstarted: async () => [], listPublic: async () => [lobby],
    } } as unknown as AccountStores;
    const hub = new LiveHub(); close.push(() => hub.close());
    const registry = { publicMatches: async () => [] } as unknown as WatchRegistry;
    const routes = watchRoutes({ accounts, registry, hub });
    const origin = await listen((req, res) => { void routes(req, res); });
    const seen = warnings();
    expect((await fetch(`${origin}/watch/queue`)).status).toBe(200);
    expect((await fetch(`${origin}/watch/catalog`)).status).toBe(200);
    expect(seen()).toEqual([["watch queue", UNLISTED], ["watch catalog", UNLISTED]]);
  });

  it("/matches, for a recorded seat handle", async () => {
    const seat = (handle: string | null, colony: 0 | 1) => ({ seat: 0, colony, modelLabel: "zai/glm-5.3", thinkingLevel: null, serviceTier: null, handle });
    const source: HistorySource = {
      async list() {
        return { matches: [{ id: "2026-11-07T08-00-00-000Z-1", startedAt: "2026-11-07T08:00:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0,
          reason: "time_up", decidedBy: "territory", seats: [seat(UNLISTED, 0), seat("antwars/glm-5-3", 1)], status: "complete", unavailable: [] }], nextPageToken: null };
      },
      async open() { return null; },
    };
    const handler = historyRoutes(source);
    const origin = await listen((req, res) => { void handler(req, res, undefined as never); });
    const seen = warnings();
    expect((await fetch(`${origin}/matches`)).status).toBe(200);
    expect(seen()).toEqual([["recordings", UNLISTED]]);
  });

  it("a match stream's start, for the HUD, result, share text and replay", async () => {
    const id = "00000000-0000-4000-8000-000000000912";
    const { docs, store } = memoryWatchStore();
    holdMatch(docs, id, "run");
    const accounts = { ratings: createRatings(store), lobbies: {
      readLobby: async () => ({ ok: true, value: { id, kind: "public", rated: true, state: "holding", slot: "public-0", outcome: null } }),
      resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
    const hub = new LiveHub({ clock: new ManualClock(), ...controller.hubOptions });
    close.push(() => { hub.close(); controller.close(); });
    await controller.prepare(id, [{ identityId: "a", displayName: UNLISTED, colony: 0 }, { identityId: "b", displayName: "antwars/glm-5-3", colony: 1 }]);
    const state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 3 })), [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    const live = { agentInfo: (agentId: string) => (agentId === "sim-a" ? { displayName: UNLISTED, modelLabel: null, seatKey: "a" } : { displayName: "antwars/glm-5-3", modelLabel: null, seatKey: "b" }) } as LiveGame;
    const seen = warnings();
    controller.started(1, state, live, hub);
    expect(seen()).toEqual([["match stream", UNLISTED]]);
  });
});
