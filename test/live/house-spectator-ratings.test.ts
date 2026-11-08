/**
 * Spectators of a house-mode match, at every house size,
 * see each handle's starting rating in that house size, never its public 1v1 rating.
 * The lobby is a stub carrying the house mode; ratings are read through the real rating store.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LiveGame } from "../../src/server.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { RATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createRatings, encodeRating, INITIAL_RD, ratingCollection, type RankedMode } from "../../src/rating/ratings.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const lobbyId = "00000000-0000-4000-8000-000000000346";
const HOUSE: readonly (readonly [RankedMode, number])[] = [["house-1v1", 1], ["house-2v2", 2], ["house-3v3", 3], ["house-4v4", 4]];
const handles = [{ id: "ant", displayName: "antwars/ant", colony: 0 }, { id: "bee", displayName: "antwars/bee", colony: 1 }] as const;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** Each handle's stored ratings, distinct in public 1v1 and in every house size. */
const RATED: ReadonlyMap<RankedMode, readonly [number, number]> = new Map([
  ["1v1", [1530.25, 1469.75]], ["house-1v1", [1611.5, 1388.5]], ["house-2v2", [1622.5, 1377.5]],
  ["house-3v3", [1633.5, 1366.5]], ["house-4v4", [1644.5, 1355.5]],
]);

function ratedHandles() {
  const { docs, store } = memoryWatchStore();
  docs.set("identities/antwars", { displayName: "antwars" });
  for (const handle of handles) docs.set(`identities/${handle.id}`, { displayName: handle.displayName, ownerId: "antwars" });
  for (const [mode, values] of RATED) handles.forEach((handle, index) => docs.set(`${ratingCollection(mode)}/${handle.id}`,
    { rating: encodeRating(values[index]!), rd: encodeRating(INITIAL_RD), ratedMatches: "3", displayName: handle.displayName }));
  return { store, ratings: createRatings(store) };
}

describe("house-mode spectator starting ratings", () => {
  it.each(HOUSE)("a %s match shows each handle's rating in that house size, not its public 1v1 rating", async (mode, size) => {
    const { store, ratings } = ratedHandles();
    const lobby = { id: lobbyId, kind: "public", size, mode, rated: true, state: "holding", slot: "public-0", outcome: null };
    const accounts = { ratings, lobbies: {
      readLobby: async () => ({ ok: true, value: lobby }), resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
    const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
    const server = new RecordedServer(hub, clock);
    await server.listen();
    cleanup.push(async () => { hub.close(); controller.close(); await server.close(); });

    // One handle holds every seat of its colony.
    const seats = handles.flatMap(handle => Array.from({ length: size }, (_, index) => ({
      identityId: handle.id, displayName: handle.displayName, colony: handle.colony, seat: index + 1,
    })));
    await controller.prepare(lobbyId, seats);
    const agents = seats.map(seat => ({ agentId: `sim-${seat.identityId}-${seat.seat}`, seat }));
    let state = step(createMatch(346, playable({ ...rulesConfig("redesign"), matchTicks: 3 })),
      agents.map(agent => ({ type: "join" as const, agentId: agent.agentId, placement: agent.seat.colony }))).state;
    const byAgent = new Map(agents.map(agent => [agent.agentId, agent.seat]));
    const live = { agentInfo: (agentId: string) => {
      const seat = byAgent.get(agentId)!;
      return { displayName: seat.displayName, modelLabel: null, seatKey: seat.seat === 1 ? seat.identityId : `${seat.identityId}#${seat.seat}` };
    } } as unknown as LiveGame;
    controller.started(1, state, live, hub);
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    clock.advance((RATED_DELAY_SECONDS + 1) * 1000);

    const client = await SseClient.connect(server.url(`/watch/live/${lobbyId}`));
    cleanup.push(() => client.close());
    await served(server, 1);
    for (let i = 0; !client.messages.some(message => message.full); i++) {
      if (i > 20_000) throw new Error("no full spectator snapshot");
      await new Promise(resolve => setImmediate(resolve));
    }
    const full = client.messages.find(message => message.full)!.full!;
    expect(full.setup.rated).toBe(true);
    expect(full.agents).toHaveLength(2 * size);
    expect(full.agents.map(agent => agent.identity?.elo)).toEqual(seats.map(seat => RATED.get(mode)![seat.colony]));
  });
});
