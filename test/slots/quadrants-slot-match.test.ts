// A Quadrants match played end to end on one server serving the account tools and a lobby slot, under the production
// redesign rules: four join_queue calls make the lobby, the slot plays it on a test-only quadrant map with four
// colonies, each seat picks inside its own box, every successful slot join names its colony, idle colonies leave one
// by one and the last one standing wins, and the lobby records the result unrated. With the shipped (empty) rotation a
// spectated server refuses the mode, ends a prepared quadrants lobby not played, and keeps streaming its 1v1 matches.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type Lobby, type Seat } from "../../src/lobby/lobbies.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { QUADRANT_ROTATION_REQUIRED, type Game } from "../../src/mcp/game.ts";
import { isIndexMode } from "../../src/rating/harnessPhase.ts";
import { createRatings, RANKED_MODES, ratingCollection } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { rulesConfig, SUB, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { ManualClock } from "../live/helpers.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";
import { connect, tempDir, waitFor, type Agent } from "../server/helpers.ts";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
/** The production rules: only the quadrants rotation differs between servers here. */
const LIVE = newMatchConfig(rulesConfig("redesign"));
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
/**
 * Each colony's pick box, by hand: the fixture's start area (x 2-13, y 4-18 of a 64x64 quadrant) at grid scale 2 on the
 * 128x128 board, mirrored into each quadrant: colony 0 top left, 1 top right, 2 bottom left, 3 bottom right.
 */
const BOXES = [{ x: 4, y: 8 }, { x: 100, y: 8 }, { x: 4, y: 90 }, { x: 100, y: 90 }].map(corner => ({ ...corner, width: 24, height: 30 }));
const IDLE_SECONDS = 2;
const MCP = { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: IDLE_SECONDS };
const NO_MAP = "No Quadrants map is available yet, so the quadrants mode cannot be joined.";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  vi.restoreAllMocks();
});

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** One in-memory store with its account stores; quadrantMaps "shipped" keeps the default (empty) rotation. */
function world(quadrantMaps: readonly MapDefinition[] | "shipped") {
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 50, publicSlots: 1, ...(quadrantMaps === "shipped" ? {} : { quadrantMaps }) });
  const accounts: AccountStores = { identities, lobbies, ratings: createRatings(store, identities) };
  const slot = { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 };
  return { store, docs, identities, lobbies, accounts, slot };
}
type World = ReturnType<typeof world>;

/** The lobby whose pick window is open on server, if any. */
const openStartOf = (server: GameServer) => (server.game as unknown as Game).openStart?.lobbyId;

async function agent(server: GameServer): Promise<Agent> {
  const a = await connect(server.port);
  closers.push(() => a.close());
  return a;
}

async function claim(w: World, name: string) {
  return value(await w.identities.claimUsername(name));
}

async function ended(w: World, lobbyId: string): Promise<Lobby> {
  let lobby = value(await w.lobbies.readLobby(lobbyId));
  const deadline = Date.now() + 20_000;
  while (lobby.state !== "ended") {
    if (Date.now() > deadline) throw new Error(`lobby ${lobbyId} never ended`);
    await new Promise(resolve => setTimeout(resolve, 10));
    lobby = value(await w.lobbies.readLobby(lobbyId));
  }
  return lobby;
}

/** Store paths of every rating, rated-match and leaderboard row. */
const ratingPaths = (w: World) => [...w.docs.keys()].filter(path =>
  path.startsWith("ratedMatches/") || RANKED_MODES.some(mode => path.startsWith(`${ratingCollection(mode)}/`)));

/** A rated 1v1 lobby of two new identities, made as the queue makes one. */
async function ratedPair(w: World, prefix: string) {
  const keys = [await claim(w, `${prefix}-red`), await claim(w, `${prefix}-blue`)];
  const lobby = await w.store.transaction<Lobby>(async read => {
    const made = await w.lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: keys.map(key => [{ id: key.identity.id, displayName: key.identity.displayName }]) }, Date.now());
    return { result: made.lobby, writes: made.writes };
  });
  return { lobbyId: lobby.id, keys };
}

/** Plays a rated 1v1 on server: red joins and keeps calling, blue joins and stays silent, so red wins by blue's idle loss. */
async function playRatedPair(w: World, server: GameServer, prefix: string) {
  const { lobbyId, keys } = await ratedPair(w, prefix);
  await waitFor(() => openStartOf(server) === lobbyId, 20_000);
  const [red, blue] = await Promise.all(keys.map(async key => {
    const a = await agent(server);
    const joined = await a.call("join", { key: key.key });
    expect(joined.isError, joined.text).toBe(false);
    // Outside Quadrants the reply before the start is unchanged: it carries no colony.
    expect(joined.data as object).not.toHaveProperty("colony");
    return a;
  }));
  void blue;
  let done = false;
  const loop = (async () => { while (!done) { await red!.call("observe"); await new Promise(resolve => setTimeout(resolve, 50)); } })();
  try {
    return { lobbyId, lobby: await ended(w, lobbyId) };
  } finally {
    done = true;
    await loop;
  }
}

describe("a Quadrants match on a slot server", { timeout: 60_000 }, () => {
  it("queues four, plays on the quadrant map, names every seat's colony, removes idle colonies and records the result unrated", async () => {
    const w = world([FIXTURE]);
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LIVE, quadrantMaps: [FIXTURE],
      startPickWindowMs: 1500, mcpConfig: MCP, accounts: w.accounts, slot: w.slot });
    closers.push(() => server.close());
    const players = [];
    for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(w, name));
    const queue = await agent(server);
    for (const player of players.slice(0, 3)) {
      const joined = await queue.call("join_queue", { key: player.key, mode: "quadrants" });
      expect([joined.isError, (joined.data as any).queue.state]).toEqual([false, "waiting"]);
    }
    const last = await queue.call("join_queue", { key: players[3]!.key, mode: "quadrants" });
    expect((last.data as any).queue.state).toBe("matched");
    const lobbyId = (last.data as any).queue.lobbyId as string;
    const seats = JSON.parse(w.docs.get(`lobbies/${lobbyId}`)!.seats!) as { id: string; colony: number }[];
    // One seat on each of the four colonies; from here the players are taken in colony order.
    expect(seats.map(seat => seat.colony).sort()).toEqual([0, 1, 2, 3]);
    expect(seats.map(seat => seat.id).sort()).toEqual(players.map(player => player.identity.id).sort());
    players.sort((a, b) => seats.find(seat => seat.id === a.identity.id)!.colony - seats.find(seat => seat.id === b.identity.id)!.colony);

    // Every seat joins the slot during its pick window and is told its colony before the start.
    await waitFor(() => openStartOf(server) === lobbyId);
    const seatAgents: Agent[] = [];
    for (const [colony, player] of players.entries()) {
      const a = await agent(server);
      seatAgents.push(a);
      const joined = await a.call("join", { key: player.key });
      expect(joined.isError, joined.text).toBe(false);
      expect((joined.data as any).colony).toBe(NAMES[colony]);
      expect((joined.data as any).nestSelection.box).toEqual(BOXES[colony]);
    }
    const [box0, box1, box2] = BOXES as [typeof BOXES[0], typeof BOXES[0], typeof BOXES[0]];
    const pick = async (colony: number, tileX: number, tileY: number) => (await seatAgents[colony]!.call("pick_nest", { tileX, tileY })).data as any;
    // Inside the box, then a tile just outside it (refused, keeping the earlier pick), then the box's far corner.
    expect(await pick(0, box0.x + 6, box0.y + 12)).toMatchObject({ accepted: true });
    expect((await pick(0, box0.x + box0.width, box0.y + box0.height - 1)).error.code).toBe("nest_outside_box");
    expect(await pick(0, box0.x + box0.width - 1, box0.y + box0.height - 1)).toMatchObject({ accepted: true });
    expect(await pick(1, box1.x, box1.y + 10)).toMatchObject({ accepted: true });
    expect((await pick(2, box2.x - 1, box2.y + 10)).error.code).toBe("nest_outside_box");
    expect(await pick(2, box2.x + 10, box2.y)).toMatchObject({ accepted: true });
    // Colony 3 makes no pick: its default nest is inside its box.

    await waitFor(() => server.game.match !== null);
    const state = server.game.match!.state;
    expect(state.terrain!.mapId).toBe(FIXTURE.id);
    expect(state.colonies.map(colony => colony.id)).toEqual([0, 1, 2, 3]);
    const queen = (colony: number) => {
      const q = state.colonies[colony]!.queens![0]!;
      return { tileX: Math.floor(q.queenX / SUB), tileY: Math.floor(q.queenY / SUB) };
    };
    expect([0, 1, 2].map(queen)).toEqual([
      { tileX: box0.x + box0.width - 1, tileY: box0.y + box0.height - 1 }, { tileX: box1.x, tileY: box1.y + 10 }, { tileX: box2.x + 10, tileY: box2.y }]);
    const box3 = BOXES[3]!, q3 = queen(3);
    expect(q3.tileX >= box3.x && q3.tileX < box3.x + box3.width && q3.tileY >= box3.y && q3.tileY < box3.y + box3.height).toBe(true);

    // A join once play has begun names the colony too.
    for (const [colony, player] of players.entries()) {
      const rejoined = await seatAgents[colony]!.call("join", { key: player.key });
      expect(rejoined.isError, rejoined.text).toBe(false);
      expect((rejoined.data as any).colony).toBe(NAMES[colony]);
    }

    // Colony 3 never calls again and leaves first, while play goes on; colonies 0 and 1 then stop and leave;
    // colony 2 keeps calling and is the last colony standing.
    const calling = new Set([0, 1, 2]);
    const eliminated = (colony: number) => server.game.match!.state.colonies[colony]!.eliminated !== undefined;
    let stopped = false;
    const loop = (async () => {
      while (!stopped && server.game.match!.state.result === null) {
        await Promise.all([...calling].map(colony => seatAgents[colony]!.call("observe")));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    try {
      await waitFor(() => eliminated(3), 20_000);
      expect(server.game.match!.state.result).toBeNull();
      expect([0, 1, 2].map(eliminated)).toEqual([false, false, false]);
      calling.delete(0); calling.delete(1);
      await waitFor(() => server.game.match!.state.result !== null, 20_000);
    } finally {
      stopped = true;
      await loop;
    }
    const final = server.game.match!.state;
    expect(final.result).toMatchObject({ winner: 2, reason: "idle" });
    expect(final.colonies.map(colony => colony.eliminated?.reason)).toEqual(["idle", "idle", undefined, "idle"]);

    const lobby = await ended(w, lobbyId);
    expect(lobby).toMatchObject({ outcome: "colony_2_won", rated: false, mode: "quadrants", colonyNames: NAMES });
    const doc = w.docs.get(`lobbies/${lobbyId}`)!;
    expect(JSON.parse(doc.colonyNames!)).toEqual(NAMES);
    // The engine's own result: its reason and every colony it eliminated, at the tick it did.
    expect(JSON.parse(doc.result!)).toEqual({ reason: "idle",
      eliminations: final.colonies.flatMap(colony => colony.eliminated === undefined ? [] : [{ colony: colony.id, tick: colony.eliminated.tick }]) });
    expect(isIndexMode("quadrants")).toBe(false);
    expect(ratingPaths(w)).toEqual([]);

    // A rated 1v1 on the same server, after it: its silent seat loses for idling, and the match is rated as before.
    const control = await playRatedPair(w, server, "control");
    expect(control.lobby).toMatchObject({ outcome: "colony_0_won", rated: true });
    expect(ratingPaths(w)).toEqual(expect.arrayContaining([`ratedMatches/${control.lobbyId}`]));
  });
  it("records the engine's own result when every colony goes idle on one tick, the winner's elimination included", async () => {
    const w = world([FIXTURE]);
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LIVE, quadrantMaps: [FIXTURE], seed: 4242,
      startPickWindowMs: 300, mcpConfig: MCP, accounts: w.accounts, slot: w.slot });
    closers.push(() => server.close());
    const players = [];
    for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(w, name));
    for (const player of players) value(await w.lobbies.joinQueue(player.key, "quadrants"));
    const lobbyId = value(await w.lobbies.queueStatus(players[0]!.key)) as { state: string; lobbyId?: string };
    expect(lobbyId.state).toBe("matched");
    // Every seat joins and then makes no call, so all four go idle on the same tick.
    await waitFor(() => openStartOf(server) === lobbyId.lobbyId, 20_000);
    for (const player of players) expect((await (await agent(server)).call("join", { key: player.key })).isError).toBe(false);
    await waitFor(() => server.game.match?.state.result != null, 20_000);
    const state = server.game.match!.state;
    const ticks = state.colonies.map(colony => colony.eliminated?.tick);
    expect(new Set(ticks).size).toBe(1);
    expect(ticks[0]).toBe(state.result!.tick);
    const winner = state.result!.winner;
    expect(state.result).toMatchObject({ reason: "idle" });
    expect(winner).not.toBeNull();
    expect(winner).not.toBe(0);

    const lobby = await ended(w, lobbyId.lobbyId!);
    expect(lobby).toMatchObject({ outcome: `colony_${winner}_won`, rated: false });
    // Unfiltered: every engine elimination, the winning colony's own on that same tick included.
    expect(JSON.parse(w.docs.get(`lobbies/${lobbyId.lobbyId}`)!.result!)).toEqual({ reason: "idle",
      eliminations: state.colonies.map(colony => ({ colony: colony.id, tick: colony.eliminated!.tick })) });
    expect(ratingPaths(w)).toEqual([]);
  });

  it("with the shipped empty rotation, a spectated server refuses Quadrants, ends a prepared Quadrants lobby not played and streams its 1v1", async () => {
    const w = world("shipped");
    const errors = vi.spyOn(console, "error");
    const submitted: unknown[] = [];
    const server: SpectatedServer = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LIVE,
      startPickWindowMs: 200, mcpConfig: MCP, spectatorClock: new ManualClock(), accounts: w.accounts, watchRegistry: createWatchRegistry(w.store),
      recordHandoff: { submit: inputs => { submitted.push(inputs); } }, replayStore: { create: async () => {} }, slot: w.slot });
    closers.push(() => server.close());
    const pushed = vi.spyOn(server.hub, "pushTick");
    const lobbyPaths = () => [...w.docs.keys()].filter(path => path.startsWith("lobbies/"));

    // Four public joins are each refused with the mode's reason: no queue entry, lobby, match or stream.
    const queue = await agent(server);
    const players = [];
    for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(w, name));
    for (const player of players) {
      const refused = await queue.call("join_queue", { key: player.key, mode: "quadrants" });
      expect([refused.isError, (refused.data as any).error, (refused.data as any).message]).toEqual([true, "no_quadrant_map", NO_MAP]);
      expect((await queue.call("queue_status", { key: player.key })).data).toEqual({ queue: { state: "none" } });
    }
    expect(lobbyPaths()).toEqual([]);
    expect([server.game.match, server.hub.currentSeq(), server.hub.catalogMatches()]).toEqual([null, null, []]);

    // A four-seat Quadrants lobby prepared beside the queue reaches the slot: its start is refused, and it ends not played.
    const colonies: Seat[][] = players.map(player => [{ id: player.identity.id, displayName: player.identity.displayName }]);
    const prepared = await w.store.transaction<Lobby>(async read => {
      const made = await w.lobbies.queuedMatchWrites(read, { mode: "quadrants", colonies }, Date.now());
      return { result: made.lobby, writes: made.writes };
    });
    const notPlayed = await ended(w, prepared.id);
    expect(notPlayed).toMatchObject({ outcome: "not_played", mode: "quadrants" });
    expect(w.docs.get(`lobbies/${prepared.id}`)!.result).toBeUndefined();
    expect([server.game.match, server.hub.currentSeq(), server.hub.catalogMatches(), server.hub.hasLobby(prepared.id)]).toEqual([null, null, [], false]);
    expect(pushed).not.toHaveBeenCalled();
    expect(errors.mock.calls.some(call => String(call[0]).includes(QUADRANT_ROTATION_REQUIRED))).toBe(true);

    // The same server then plays and streams a rated 1v1 as before.
    const played = playRatedPair(w, server, "stream");
    await waitFor(() => server.game.match !== null && server.hub.catalogMatches().length === 1, 20_000);
    const streamed = server.hub.catalogMatches()[0]!;
    expect(streamed).toMatchObject({ rated: true, mode: "1v1" });
    expect(server.hub.hasLobby(streamed.lobbyId)).toBe(true);
    const control = await played;
    expect(control.lobbyId).toBe(streamed.lobbyId);
    expect(control.lobby).toMatchObject({ outcome: "colony_0_won", rated: true });
    expect(pushed.mock.calls.length).toBeGreaterThan(0);
    expect(server.game.match!.state.colonies).toHaveLength(2);
  });
});
