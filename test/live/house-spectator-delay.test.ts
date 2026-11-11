import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LiveGame } from "../../src/server.ts";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { watchRoutes } from "../../src/live/watch-routes.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { decodeData, ManualClock, RecordedServer } from "./helpers.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const lobbyId = "00000000-0000-4000-8000-000000000417";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Exercises the controller, captured policy, real rating service, registry round-trip,
// discovery and HTTP streams together; it never starts a match server or accesses production.
describe("house spectator zero-delay wiring", () => {
  it.each(["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const)("%s stays live through its committed final result under default settings", async mode => {
    const size = Number(mode[6]);
    const { docs, store } = memoryWatchStore();
    docs.set("identities/a", { displayName: "antwars/alice" });
    docs.set("identities/b", { displayName: "antwars/bob" });
    holdMatch(docs, lobbyId, "run");
    const ratings = createRatings(store), registry = createWatchRegistry(store);
    let ended = false;
    const accounts = { ratings, lobbies: {
      readLobby: async () => ({ ok: true, value: {
        id: lobbyId, kind: "public", rated: true, mode, size, slot: "public-0", state: ended ? "ended" : "holding",
        outcome: ended ? "draw" : null,
        colonies: [Array.from({ length: size }, () => ({ id: "a", displayName: "antwars/alice" })), Array.from({ length: size }, () => ({ id: "b", displayName: "antwars/bob" }))],
      } }),
      resolveSlot: async () => ({ runId: "run" }), listPublic: async () => [], isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry, slot: "public-0", origin: "http://127.0.0.1:9001" });
    const clock = new ManualClock(), hub = new LiveHub({ clock, config: DEFAULT_LIVE_CONFIG, ...controller.hubOptions });
    const streams = new RecordedServer(hub, clock);
    cleanup.push(() => { hub.close(); controller.close(); });
    await streams.listen(); cleanup.push(() => streams.close());
    // A separately constructed registry reads only the persisted metadata for discovery.
    const routes = watchRoutes({ accounts, registry: createWatchRegistry(store), hub });
    const gateway = createServer((req, res) => { void routes(req, res); });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => { gateway.closeAllConnections(); gateway.close(() => resolve()); }));
    const origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    const abort = new AbortController(); cleanup.push(() => abort.abort());

    const seats = (["a", "b"] as const).flatMap((identityId, colony) => Array.from({ length: size }, (_, index) => ({
      identityId, displayName: identityId === "a" ? "antwars/alice" : "antwars/bob", colony: colony as 0 | 1, seat: index + 1,
    })));
    await controller.prepare(lobbyId, seats);
    let state = step(createMatch(417, playable({ ...rulesConfig("redesign"), matchTicks: 3 })), seats.map(seat => ({
      type: "join" as const, agentId: `${seat.identityId}-${seat.seat}`, placement: seat.colony,
    }))).state;
    const live = { agentInfo: (agentId: string) => {
      const [identityId, seat] = agentId.split("-");
      return { seatKey: seat === "1" ? identityId : `${identityId}#${seat}` };
    } } as unknown as LiveGame;
    controller.started(1, state, live, hub);
    await vi.waitFor(async () => expect(await registry.read(lobbyId)).toMatchObject({ mode, rated: true }));
    const catalog = await (await fetch(`${origin}/watch/catalog`, { signal: abort.signal })).json();
    // Each seat by its stream name, with no model label (its agent reported none), and its unrated-yet figures in the house mode.
    const colony = (name: string) => Array.from({ length: size }, (_, index) => ({ displayName: size > 1 ? `${name} #${index + 1}` : name, modelLabel: null, thinkingLevel: null, serviceTier: null, rating: 1500, rd: 350, ratedMatches: 0 }));
    // A Model Index match also carries its harness phase by its start (here time 0, before every boundary).
    expect(catalog.matches).toEqual([{ lobbyId, startedAt: 0, rated: true, delaySeconds: 0, colonies: [colony("antwars/alice"), colony("antwars/bob")],
      matchType: { kind: "index", size }, harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true } }]);
    expect(await (await fetch(`${origin}/watch/status/${lobbyId}`, { signal: abort.signal })).json()).toMatchObject({
      lobbyId, started: true, playbackFinished: false, delaySeconds: 0,
    });
    for (const path of ["/live/1", `/watch/live/${lobbyId}`]) {
      const response = await fetch(streams.url(path), { signal: abort.signal });
      expect(response.status).toBe(200);
      const data = streams.responses.find(row => row.path === path)!.writes.filter(write => write.text.startsWith("data:"));
      expect(data).toHaveLength(1); expect(data[0]!.t).toBe(0);
    }
    while (!state.result) {
      const out = step(state, []); clock.advance(100);
      if (out.state.result) {
        await ratings.applyResult({ matchId: lobbyId, mode, teams: [["a"], ["b"]], winner: "draw" });
        ended = true;
      }
      hub.pushTick(1, out); state = out.state;
    }
    const matchEnd = clock.now();
    await vi.waitFor(() => expect(hub.watchStatus(lobbyId)?.playbackFinished).toBe(true));
    // No clock advance for delayed playback: asynchronous rating reads alone may settle.
    expect(clock.now()).toBe(matchEnd);
    for (const path of ["/live/1", `/watch/live/${lobbyId}`]) {
      const data = streams.responses.find(row => row.path === path)!.writes.filter(write => write.text.startsWith("data:"));
      const final = decodeData(data.at(-1)!.text.slice(6).trim()).events.find(event => event.kind === "end");
      expect(final?.kind).toBe("end");
      if (final?.kind !== "end") throw new Error("Missing final result");
      expect(final.result.ratingChanges).toHaveLength(2 * size);
      expect(data.at(-1)!.t).toBe(matchEnd);
    }
    await vi.waitFor(async () => expect((await registry.read(lobbyId))?.playbackFinished).toBe(true));
    expect((await (await fetch(`${origin}/watch/catalog`, { signal: abort.signal })).json()).matches).toEqual([]);
  });
});
