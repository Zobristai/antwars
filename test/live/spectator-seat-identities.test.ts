import { afterEach, describe, expect, it } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LobbySeat } from "../../src/mcp/game.ts";
import type { LiveGame } from "../../src/server.ts";
import type { StreamAgent, StreamRatingChange } from "../../src/live/format.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";
import { createWatchController } from "../../src/live/watch-controller.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { delivered, ManualClock, RecordedServer, served, SseClient } from "./helpers.ts";
import { memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const id = "00000000-0000-4000-8000-000000000369";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/**
 * One rated public match watched end to end over the live route. Each sim agent is one
 * seat: `live.agentInfo` gives the seat key a slot server's Game reports for it, and its
 * display name is the identity's own, the same on every seat that identity holds.
 */
async function watchMatch(seats: readonly LobbySeat[], agents: readonly { readonly seatKey: string; readonly colony: 0 | 1 }[]) {
  const { docs, store } = memoryWatchStore();
  docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
  const ratings = createRatings(store);
  // Distinct starting ratings, so a seat showing another identity's metadata is visible.
  expect((await ratings.applyResult({ matchId: "earlier", teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied");
  let ended = false;
  const accounts = { ratings, lobbies: {
    readLobby: async () => ({ ok: true, value: { id, kind: "public", rated: true, state: ended ? "ended" : "holding", slot: "public-0", outcome: ended ? "colony_0_won" : null } }),
    resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
  } } as unknown as AccountStores;
  const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
  const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
  const server = new RecordedServer(hub, clock);
  await server.listen();
  cleanup.push(() => controller.close(), () => hub.close(), () => server.close());

  await controller.prepare(id, seats);
  const names = new Map(seats.map(seat => [seat.identityId, seat.displayName]));
  const live = { agentInfo: (agentId: string) => {
    const agent = agents[Number(agentId.slice("sim-".length))]!;
    return { displayName: names.get(agent.seatKey.split("#")[0]!)!, modelLabel: null, seatKey: agent.seatKey };
  } } as LiveGame;
  let state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 3 })),
    agents.map((agent, index) => ({ type: "join" as const, agentId: `sim-${index}`, placement: agent.colony }))).state;
  controller.started(1, state, live, hub);
  const client = await SseClient.connect(server.url(`/watch/live/${id}`));
  cleanup.push(() => client.close());
  const response = await served(server, 1);
  while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
  clock.advance(301000);
  // The result's rating changes come from the match's actual rated result.
  expect((await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" })).status).toBe("applied");
  ended = true;
  let changes: readonly StreamRatingChange[] | undefined;
  for (let i = 0; changes === undefined; i++) {
    if (i > 50) throw new Error("rated result never reached the stream");
    clock.advance(1000);
    await new Promise(resolve => setImmediate(resolve));
    await delivered(client, response);
    for (const message of client.messages) {
      for (const event of message.events) if (event.kind === "end") changes = event.result.ratingChanges;
    }
  }
  const opening = client.messages.find(message => message.full !== null)!.full!;
  return { agents: opening.agents as readonly StreamAgent[], changes: changes!, ratingOf: async (identityId: string) => (await ratings.readRating(identityId)).rating };
}

describe("spectator data for a team-mode match", () => {
  it("identifies each seat of an identity separately, with its own name, starting rating and rating outcome", async () => {
    // Seats as the slot server hands them over: each carries its number among its identity's seats.
    const seats: LobbySeat[] = [
      { identityId: "a", displayName: "alice", colony: 0, seat: 1 }, { identityId: "a", displayName: "alice", colony: 0, seat: 2 },
      { identityId: "b", displayName: "bob", colony: 1, seat: 1 }, { identityId: "b", displayName: "bob", colony: 1, seat: 2 },
    ];
    // Join order differs from seat order: each agent is matched by its seat key, not its position or name.
    const watched = await watchMatch(seats, [
      { seatKey: "a#2", colony: 0 }, { seatKey: "b", colony: 1 }, { seatKey: "a", colony: 0 }, { seatKey: "b#2", colony: 1 },
    ]);
    // Each seat's starting rating with the RD read with it.
    expect(watched.agents.map(agent => agent.identity)).toEqual([
      { displayName: "alice #2", elo: FIRST_WIN.rating, rd: FIRST_WIN.rd }, { displayName: "bob #1", elo: FIRST_LOSS.rating, rd: FIRST_LOSS.rd },
      { displayName: "alice #1", elo: FIRST_WIN.rating, rd: FIRST_WIN.rd }, { displayName: "bob #2", elo: FIRST_LOSS.rating, rd: FIRST_LOSS.rd },
    ]);
    const [alice, bob] = [await watched.ratingOf("a"), await watched.ratingOf("b")];
    expect(alice).toBeGreaterThan(FIRST_WIN.rating); expect(bob).toBeLessThan(FIRST_LOSS.rating);
    expect(watched.changes).toEqual([
      { agent: 0, before: FIRST_WIN.rating, after: alice }, { agent: 1, before: FIRST_LOSS.rating, after: bob },
      { agent: 2, before: FIRST_WIN.rating, after: alice }, { agent: 3, before: FIRST_LOSS.rating, after: bob },
    ]);
  });

  it("keeps a single-seat identity's plain display name, keyed by its identity with or without a seat number", async () => {
    const watched = await watchMatch(
      [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1, seat: 1 }],
      [{ seatKey: "a", colony: 0 }, { seatKey: "b", colony: 1 }],
    );
    expect(watched.agents.map(agent => agent.identity)).toEqual([
      { displayName: "alice", elo: FIRST_WIN.rating, rd: FIRST_WIN.rd }, { displayName: "bob", elo: FIRST_LOSS.rating, rd: FIRST_LOSS.rd },
    ]);
    expect(watched.changes.map(change => change.agent)).toEqual([0, 1]);
  });
});
