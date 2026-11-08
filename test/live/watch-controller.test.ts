import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { LiveGame } from "../../src/server.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings, RANKED_MODES } from "../../src/rating/ratings.ts";
import { createFirestore, type Write } from "../../src/store/firestore.ts";
import { createWatchController, lobbySeats } from "../../src/live/watch-controller.ts";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { seatKeyOf, type LobbySeat } from "../../src/mcp/game.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { createMatch } from "../../src/sim/map.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "./helpers.ts";
import { holdMatch, memoryWatchStore } from "./watch-fixtures.ts";

import { playable } from "../playable.ts";
const id = "00000000-0000-4000-8000-000000000001";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

describe("spectator metadata and final rating lifecycle", () => {
  it("retains the delayed final tick until the actual rating transaction commits", async () => {
    const { docs, store } = memoryWatchStore();
    docs.set("identities/a", { displayName: "alice" }); docs.set("identities/b", { displayName: "bob" });
    holdMatch(docs, id, "run");
    const ratings = createRatings(store), registry = createWatchRegistry(store);
    let ended = false;
    const accounts = { ratings, lobbies: {
      readLobby: async () => ({ ok: true, value: { id, kind: "public", rated: true, state: ended ? "ended" : "holding", slot: "public-0", outcome: ended ? "colony_0_won" : null } }),
      resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry, slot: "public-0", origin: "http://127.0.0.1:9001" });
    const clock = new ManualClock(), hub = new LiveHub({ clock, ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    await controller.prepare(id, [{ identityId: "a", displayName: "alice", colony: 0 }, { identityId: "b", displayName: "bob", colony: 1 }]);
    let state = step(createMatch(34, playable({ ...rulesConfig("redesign"), matchTicks: 3 })), [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    const live = { agentInfo: (agentId: string) => (agentId === "sim-a" ? { displayName: "alice", modelLabel: null, seatKey: "a" } : { displayName: "bob", modelLabel: null, seatKey: "b" }) } as LiveGame;
    controller.started(1, state, live, hub);
    await vi.waitFor(async () => expect(await registry.read(id)).toMatchObject({ origin: "http://127.0.0.1:9001", playbackFinished: false }));
    while (!state.result) { const out = step(state, []); clock.advance(100); hub.pushTick(1, out); state = out.state; }
    clock.advance(301000);
    await new Promise(resolve => setImmediate(resolve));
    expect(hub.watchStatus(id)?.playbackFinished).toBe(false);
    expect((await registry.publicMatches()).map(match => match.lobbyId)).toEqual([id]);
    const applied = await ratings.applyResult({ matchId: id, teams: [["a"], ["b"]], winner: "a" });
    expect(applied.status).toBe("applied"); ended = true;
    clock.advance(1000);
    await vi.waitFor(() => expect(hub.watchStatus(id)?.playbackFinished).toBe(true));
    await vi.waitFor(async () => expect((await registry.read(id))?.playbackFinished).toBe(true));
    expect(await registry.publicMatches()).toEqual([]);
  });

  it("refuses start before successful preparation and does not publish a waiting lobby", async () => {
    const { store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    const controller = createWatchController({ registry, slot: "private-0", origin: "http://127.0.0.1:9001",
      accounts: { lobbies: { readLobby: async () => ({ ok: false }), resolveSlot: async () => null } } as unknown as AccountStores });
    const hub = new LiveHub({ ...controller.hubOptions }); cleanup.push(() => { hub.close(); controller.close(); });
    await expect(controller.prepare(id, [])).rejects.toThrow("not ready");
    expect(() => controller.started(1, createMatch(1, playable(rulesConfig("redesign"))), {} as LiveGame, hub)).toThrow("metadata missing");
    expect(await registry.read(id)).toBeNull();
  });

  // A superseded run's completion and replay-id publications are fenced by the lobby's matchRunId.
  it("leaves a superseded run's playback end and replay id unwritten once another run holds the lobby's match", async () => {
    const { docs, store } = memoryWatchStore(); const registry = createWatchRegistry(store);
    const accounts = { lobbies: {
      readLobby: async () => ({ ok: true, value: { id, kind: "public", rated: false, state: "holding", slot: "public-0" } }),
      resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry, slot: "public-0", origin: "http://127.0.0.1:9001" });
    const hub = new LiveHub({ clock: new ManualClock(), ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    await controller.prepare(id, []);
    const state = step(createMatch(34, playable(rulesConfig("redesign"))), [{ type: "join", agentId: "sim-a", placement: 0 }, { type: "join", agentId: "sim-b", placement: 1 }]).state;
    controller.started(1, state, { agentInfo: () => undefined } as unknown as LiveGame, hub);
    await vi.waitFor(async () => expect(await registry.read(id)).toMatchObject({ runId: "run", playbackFinished: false }));
    // Another run adopted the match: the lobby's matchRunId names it.
    holdMatch(docs, id, "run-next");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanup.push(() => log.mockRestore());
    const access = { lobbyId: id, visibility: "public" as const, rated: false };
    controller.hubOptions.onPlaybackFinished!(access);
    controller.hubOptions.onReplaySaved!(access, "2026-10-20T10-00-00-000Z-1");
    // Each refusal is logged once and not retried.
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `antwar slot public-0: lobby ${id}'s match is not run run's; its playback end is left to its owner`,
      `antwar slot public-0: lobby ${id}'s match is not run run's; its replay id is left to its owner`,
    ]);
    expect(await registry.read(id)).toMatchObject({ runId: "run", playbackFinished: false });
    expect((await registry.read(id))?.replayId).toBeUndefined();
    expect((await registry.publicMatches()).map(match => match.lobbyId)).toEqual([id]);
  });
});

describe("house challenge seat ratings", () => {
  const lobbyId = "00000000-0000-4000-8000-000000000838";
  const house = { identityId: "house-red", displayName: "antwars/red" }, builder = { identityId: "builder", displayName: "kite" };
  /** A held house challenge lobby, as readLobby returns one (src/lobby/lobbies.ts toLobby): unrated, no mode, colony 0 held. */
  async function prepared(seats: readonly LobbySeat[], results: (ratings: ReturnType<typeof createRatings>) => Promise<void>) {
    const { docs, store } = memoryWatchStore();
    for (const [identityId, displayName] of [[house.identityId, house.displayName], ["house-blue", "antwars/blue"], [builder.identityId, builder.displayName]]) {
      docs.set(`identities/${identityId}`, { displayName: displayName! });
    }
    const ratings = createRatings(store);
    await results(ratings);
    const accounts = { ratings, lobbies: {
      readLobby: async () => ({ ok: true, value: { id: lobbyId, kind: "public", rated: false, state: "holding", slot: "public-0", mode: null,
        challenge: { kind: "house", heldFor: "antwars/red", heldColony: 0 } } }),
      resolveSlot: async () => ({ runId: "run" }), isInviteCurrent: async () => false,
    } } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
    const hub = new LiveHub({ clock: new ManualClock(), ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    await controller.prepare(lobbyId, seats);
    const state = step(createMatch(34, playable(rulesConfig("redesign"))), seats.map((seat, index) => ({ type: "join" as const, agentId: `sim-${index}`, placement: seat.colony }))).state;
    const live = { agentInfo: (agentId: string) => ({ displayName: "", modelLabel: null, seatKey: seatKeyOf(seats[Number(agentId.slice(4))]!) }) } as unknown as LiveGame;
    const startMatch = vi.spyOn(hub, "startMatch");
    controller.started(1, state, live, hub);
    const [, , access, identity] = startMatch.mock.calls[0]!;
    // What a spectator decodes from the stream's opening snapshot.
    const recorder = new SpectatorRecorder(state, { rated: access?.rated, identity });
    const shown = decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    return { controller, shown: shown.full!.agents.map(agent => agent.identity) };
  }
  const seats: LobbySeat[] = [{ ...house, colony: 0 }, { ...builder, colony: 1 }];
  // Two house-1v1 wins for the house handle and one public 1v1 loss; one public 1v1 result for the builder.
  const rated = async (ratings: ReturnType<typeof createRatings>) => {
    await ratings.applyResult({ matchId: "index-1", mode: "house-1v1", teams: [[house.identityId], ["house-blue"]], winner: "a" });
    await ratings.applyResult({ matchId: "index-2", mode: "house-1v1", teams: [[house.identityId], ["house-blue"]], winner: "a" });
    await ratings.applyResult({ matchId: "public-1", teams: [[house.identityId], [builder.identityId]], winner: "b" });
  };

  it("shows the house seat its handle's Model Index 1v1 rating and the builder its public 1v1 rating", async () => {
    let index = 0, publicHouse = 0, publicBuilder = 0;
    const { shown } = await prepared(seats, async ratings => {
      await rated(ratings);
      index = (await ratings.readRating(house.identityId, "house-1v1")).rating;
      publicHouse = (await ratings.readRating(house.identityId, "1v1")).rating;
      publicBuilder = (await ratings.readRating(builder.identityId, "1v1")).rating;
    });
    expect(index).not.toBe(1500); expect(index).not.toBe(publicHouse); expect(publicBuilder).not.toBe(1500);
    expect(shown).toEqual([{ displayName: "antwars/red", elo: index }, { displayName: "kite", elo: publicBuilder }]);
  });

  it("shows a house seat the Index has not rated with no rating, never the 1500 default, and keeps that through a handover save", async () => {
    const { controller, shown } = await prepared(seats, ratings => ratings.applyResult({ matchId: "public-1", teams: [[house.identityId], [builder.identityId]], winner: "b" }).then(() => {}));
    expect(shown[0]).toEqual({ displayName: "antwars/red" });
    expect(shown[0]).not.toHaveProperty("elo");
    expect(shown[1]).toMatchObject({ displayName: "kite", elo: expect.any(Number) });
    const save = JSON.parse(JSON.stringify(controller.save(lobbyId)));
    const resumed = await controller.resume(save, { agentInfo: () => ({ seatKey: house.identityId }) } as unknown as LiveGame);
    expect(resumed.identity("sim-0")).toEqual({ identityId: house.identityId, displayName: "antwars/red" });
  });

  it("in a mirror game keys the Index rating on the held colony: the handle's builder seat keeps its public 1v1 rating", async () => {
    const mirror = lobbySeats([[{ id: house.identityId, displayName: house.displayName }], [{ id: house.identityId, displayName: house.displayName }]]);
    let index = 0, publicHouse = 0;
    const { shown } = await prepared(mirror, async ratings => {
      await rated(ratings);
      index = (await ratings.readRating(house.identityId, "house-1v1")).rating;
      publicHouse = (await ratings.readRating(house.identityId, "1v1")).rating;
    });
    expect(shown).toEqual([{ displayName: "antwars/red #1", elo: index }, { displayName: "antwars/red #2", elo: publicHouse }]);
  });
});

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const value = <T>(outcome: Outcome<T> | LobbyOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
};

describe.skipIf(!host)("spectator starting ratings from the real rating and lobby services", { timeout: 60_000 }, () => {
  it.each(["2v2", "3v3", "4v4"] as const)("gives spectators each agent's starting rating in a %s match's mode, not its 1v1 rating", async mode => {
    const store = createFirestore({ projectId, namespace: `t${process.pid}-${randomUUID()}`, emulatorHost: host });
    const identities = createIdentities(store), ratings = createRatings(store), lobbies = createLobbies(store, identities);
    const agents = await Promise.all(["Ada", "Bea"].map(async name => value(await identities.claimUsername(name)).identity));
    // A different number of real rated results in every mode, so each mode's rating differs from the others.
    for (const [index, other] of RANKED_MODES.entries()) {
      for (let n = 0; n <= index; n++) {
        await ratings.applyResult({ matchId: `earlier-${other}-${n}`, mode: other, teams: [[agents[0]!.id], [agents[1]!.id]], winner: other === "1v1" ? "a" : "b" });
      }
    }
    const expected = new Map<string, number>();
    for (const agent of agents) {
      expected.set(agent.id, (await ratings.readRating(agent.id, mode)).rating);
      expect(expected.get(agent.id)).not.toBe((await ratings.readRating(agent.id)).rating);
    }

    // A queue-made team-mode lobby holding public-0 as the queue pairing stores it: one agent on every seat of its colony.
    const size = Number(mode[0]), lobbyId = randomUUID(), at = String(Date.now());
    const stored = agents.flatMap((agent, colony) => Array.from({ length: size }, () => ({ id: agent.id, displayName: agent.displayName, colony })));
    const lobby: Write = { op: "create", path: `lobbies/${lobbyId}`, fields: {
      kind: "public", size: String(size), creatorId: agents[0]!.id, createdAt: at, state: "holding", rated: "true", slot: "public-0",
      seats: JSON.stringify(stored), inviteVerifier: "", startsAt: at, matchRunId: "", outcome: "", mode } };
    const slot: Write = { op: "create", path: "slots/public-0", fields: { lobbyId } };
    await store.transaction<null>(async () => ({ result: null, writes: [lobby, slot] }));
    await lobbies.registerInstance("public-0", { runId: "p", mcpUrl: "http://p.test/mcp", spectatorUrl: "http://p.test/" });
    expect(value(await lobbies.readLobby(lobbyId)).mode).toBe(mode);

    const accounts = { ratings, lobbies } as unknown as AccountStores;
    const controller = createWatchController({ accounts, registry: createWatchRegistry(store), slot: "public-0", origin: "http://127.0.0.1:9001" });
    const hub = new LiveHub({ clock: new ManualClock(), ...controller.hubOptions });
    cleanup.push(() => { hub.close(); controller.close(); });
    const seats = agents.flatMap((agent, colony) => Array.from({ length: size }, (_, index) =>
      ({ identityId: agent.id, displayName: agent.displayName, colony: colony as 0 | 1, seat: index + 1 })));
    await controller.prepare(lobbyId, seats);
    const state = step(createMatch(34, playable(rulesConfig("redesign"))), seats.map(seat =>
      ({ type: "join" as const, agentId: `${seat.colony}-${seat.seat}`, placement: seat.colony }))).state;
    const live = { agentInfo: (agentId: string) => {
      const [colony, seat] = agentId.split("-").map(Number) as [number, number];
      const agent = agents[colony]!;
      return { displayName: agent.displayName, modelLabel: null, seatKey: seat === 1 ? agent.id : `${agent.id}#${seat}` };
    } } as unknown as LiveGame;
    const startMatch = vi.spyOn(hub, "startMatch");
    controller.started(1, state, live, hub);
    const [, , access, identity] = startMatch.mock.calls[0]!;
    const shown = new SpectatorRecorder(state, { rated: access?.rated, identity }).initialFull().agents.map(agent => agent.identity?.elo);
    expect(shown).toHaveLength(2 * size);
    expect(shown).toEqual(state.agents.map(agent => expected.get(agents[Number(agent.id.split("-")[0])]!.id)));
  });
});
