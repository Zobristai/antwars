// A Quadrants match played to its end through the game slot of a production-shaped spectated server, read from its
// live stream directly: every message is decoded and followed as a spectator follows it. The stream carries all four
// colonies' names, ants, queens and tile ownership, each elimination with its tick, and the result; it then
// finishes, and the match played after it is the one the current-match stream and the match status serve. The
// quadrant map is a test-only fixture; the shipped rotation stays empty.
import { get } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import type { StreamEvent, StreamMessage } from "../../src/live/format.ts";
import { RATED_DELAY_SECONDS, UNRATED_DELAY_SECONDS } from "../../src/live/match-access.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import type { Game } from "../../src/mcp/game.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { GameServer } from "../../src/server.ts";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import type { SimState } from "../../src/sim/types.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { decodeData, ManualClock } from "../live/helpers.ts";
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
/** The production rules: only the quadrants rotation is a test fixture. */
const LIVE = newMatchConfig(rulesConfig("redesign"));
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const MCP = { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100, houseIdleSeconds: 2 };

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** One in-memory store with its account stores and a slot whose quadrants rotation is the fixture. */
function world() {
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 50, publicSlots: 1, quadrantMaps: [FIXTURE] });
  const accounts: AccountStores = { identities, lobbies, ratings: createRatings(store, identities) };
  const slot = { slot: "public-0", publicUrl: "http://127.0.0.1:1", lobbies, identities, pollMs: 10 };
  return { store, docs, identities, lobbies, accounts, slot };
}
type World = ReturnType<typeof world>;

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

/** A spectator reading one stream over HTTP: the match number it was served, every decoded message, and whether the server ended the response. */
async function spectate(server: GameServer, path: string) {
  const seen = { status: 0, match: "", messages: [] as StreamMessage[], ended: false };
  let close = () => {};
  await new Promise<void>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${server.port}${path}`, res => {
      seen.status = res.statusCode ?? 0;
      seen.match = String(res.headers["x-antwar-match"] ?? "");
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (block.startsWith("data: ")) seen.messages.push(decodeData(block.slice(6)));
        }
      });
      res.on("end", () => { seen.ended = true; });
      resolve();
    });
    req.on("error", reject);
    close = () => req.destroy();
  });
  closers.push(async () => close());
  return seen;
}

const status = async (server: GameServer) => (await fetch(`http://127.0.0.1:${server.port}/live/status`)).json();
const isEnd = (event: StreamEvent): event is Extract<StreamEvent, { kind: "end" }> => event.kind === "end";
const ownersOf = (territory: Uint8Array) => [...new Set(territory)].sort();

/** Move the spectator clock on in steps, letting the sockets deliver what each step released, until done holds. */
async function playOut(clock: ManualClock, ms: number, done: () => boolean) {
  for (let t = 0; t < ms && !done(); t += 1000) {
    clock.advance(1000);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await waitFor(done, 10_000);
}

describe("a Quadrants match streamed live from a spectated slot server", { timeout: 90_000 }, () => {
  it("streams four colonies to the result, finishes, and the next match becomes the current one", async () => {
    const w = world();
    const clock = new ManualClock();
    const registry = createWatchRegistry(w.store);
    const server: SpectatedServer = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LIVE, quadrantMaps: [FIXTURE],
      startPickWindowMs: 300, mcpConfig: MCP, spectatorClock: clock, accounts: w.accounts, watchRegistry: registry,
      recordHandoff: { submit: () => {} }, replayStore: { create: async () => {} }, slot: w.slot });
    closers.push(() => server.close());
    expect(await status(server)).toEqual({ kind: "idle", match: null });

    const players = [];
    for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(w, name));
    for (const player of players) value(await w.lobbies.joinQueue(player.key, "quadrants"));
    const lobbyId = (value(await w.lobbies.queueStatus(players[0]!.key)) as { lobbyId?: string }).lobbyId!;
    const seats = JSON.parse(w.docs.get(`lobbies/${lobbyId}`)!.seats!) as { id: string; colony: number }[];
    players.sort((a, b) => seats.find(seat => seat.id === a.identity.id)!.colony - seats.find(seat => seat.id === b.identity.id)!.colony);

    // Every seat joins in its pick window and keeps its default nest.
    await waitFor(() => openStartOf(server) === lobbyId, 20_000);
    const seatAgents: Agent[] = [];
    for (const player of players) {
      const a = await agent(server);
      expect((await a.call("join", { key: player.key })).isError).toBe(false);
      seatAgents.push(a);
    }
    await waitFor(() => server.game.match !== null && server.hub.hasLobby(lobbyId), 20_000);
    const seq = server.game.match!.seq;
    expect(server.game.match!.state.colonies).toHaveLength(4);
    // The current-match stream serves the Quadrants match while it plays.
    const watched = await spectate(server, "/live/current");
    expect([watched.status, watched.match]).toEqual([200, String(seq)]);

    // Colony 3 never calls and leaves first; colonies 0 and 1 then stop and leave; colony 2 keeps calling and wins.
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
      expect([0, 1, 2].map(eliminated)).toEqual([false, false, false]);
      calling.delete(0); calling.delete(1);
      await waitFor(() => server.game.match!.state.result !== null, 20_000);
    } finally {
      stopped = true;
      await loop;
    }
    const final: SimState = server.game.match!.state;
    expect(final.result).toMatchObject({ winner: 2, reason: "idle" });
    const engineEliminations = final.colonies.flatMap(colony => colony.eliminated === undefined ? [] : [{ colony: colony.id, tick: colony.eliminated.tick }])
      .sort((a, b) => a.tick - b.tick || a.colony - b.colony);
    expect(engineEliminations.map(e => e.colony).sort()).toEqual([0, 1, 3]);
    expect(engineEliminations[0]!.colony).toBe(3);
    expect(engineEliminations[0]!.tick).toBeLessThan(engineEliminations[1]!.tick);
    // Nothing has reached delayed playback yet.
    expect(watched.messages).toEqual([]);
    expect(await status(server)).toMatchObject({ kind: "playing" });

    // Delayed playback runs the whole match out; the stream then ends.
    await playOut(clock, (UNRATED_DELAY_SECONDS + 30) * 1000, () => watched.messages.some(m => m.events.some(isEnd)));
    clock.advance(1000);
    await waitFor(() => watched.ended, 10_000);
    const [opening, ...rest] = watched.messages;

    // Names: the four Quadrants names by colony number, on a four-colony setup.
    const setup = opening!.full!.setup;
    expect(setup.colonies).toBe(4);
    expect(setup.colonyNames).toEqual(NAMES);
    expect(setup.queens).toHaveLength(4);
    // Ants and queens of all four colonies, none lost, and no elimination yet.
    expect([...new Set(opening!.ants.colony)].sort()).toEqual([0, 1, 2, 3]);
    expect(opening!.full!.queens!.map(q => q.colony)).toEqual([0, 1, 2, 3]);
    expect(opening!.full!.queens!.every(q => q.lostTick === null)).toBe(true);
    expect(opening!.full!.eliminations).toEqual([]);
    const match = opening!.full!.match;
    expect(match).toEqual(expect.any(Number));
    expect(rest.some(m => m.full !== null)).toBe(false);

    // Each elimination with its tick, in the message of the step that made it (message tick = step tick + 1).
    const eliminations = rest.flatMap(m => m.events.flatMap(event => event.kind === "eliminated" ? [{ colony: event.colony, tick: event.tick, message: m.tick }] : []));
    expect(eliminations.map(({ colony, tick }) => ({ colony, tick }))).toEqual(engineEliminations);
    for (const { tick, message } of eliminations) expect(message).toBe(tick + 1);
    // The result, as the engine decided it, once, in the last message, after that step's eliminations.
    const last = rest.at(-1)!;
    expect(rest.filter(m => m.events.some(isEnd))).toEqual([last]);
    expect(last.events.findLastIndex(e => e.kind === "eliminated")).toBeLessThan(last.events.findIndex(isEnd));
    expect(last.events.find(isEnd)!.result).toEqual({ winner: 2, reason: "idle", decidedBy: final.result!.decidedBy, tick: final.result!.tick, nextStartMs: null });

    // Following the stream message by message: every colony holds ground at some point, and an eliminated colony's
    // ants leave with its elimination.
    const spectator = new SpectatorState(opening!.full!, opening!.tick, opening!.ants);
    const held = new Set<number>();
    for (const m of rest) {
      spectator.apply(m);
      for (const owner of spectator.full.territory) held.add(owner);
      for (const { colony } of spectator.full.eliminations!) expect(spectator.ants.colony.includes(colony), `colony ${colony} ants at ${m.tick}`).toBe(false);
    }
    expect([...held].sort()).toEqual([0, 1, 2, 3, 4]);
    // The spectator's final picture is the engine's final board: queens, territory, deaths, hatches, stores, overrun
    // and eliminations of all four colonies.
    const truth = new SpectatorRecorder(final).initialFull();
    const picture = (full: typeof truth) => ({ queens: full.queens, territory: full.territory, deaths: full.deaths, hatched: full.hatched,
      stores: full.stores, overrun: full.overrun, eliminations: full.eliminations });
    expect(picture(spectator.full)).toEqual(picture(truth));
    // Every queen of an eliminated colony is lost at its elimination tick; the winner's are not.
    for (const { colony, tick } of engineEliminations) {
      expect(spectator.full.queens!.filter(q => q.colony === colony).map(q => q.lostTick)).toEqual(final.colonies[colony]!.queens!.map(() => tick));
    }
    expect(spectator.full.queens!.filter(q => q.colony === 2).map(q => q.lostTick)).toEqual(final.colonies[2]!.queens!.map(() => null));
    // Only the winner holds ground or ants at the end.
    expect(ownersOf(spectator.full.territory)).toEqual([0, 3]);
    expect([...new Set(spectator.ants.colony)]).toEqual([2]);
    expect(spectator.full.result).toMatchObject({ winner: 2, reason: "idle" });

    // The stream has finished: its response ended after the result, and neither the hub, the watch registry nor the
    // status counts the match as playing.
    expect(server.hub.watchStatus(lobbyId)).toMatchObject({ started: true, playbackFinished: true });
    await vi.waitFor(async () => expect(await registry.read(lobbyId)).toMatchObject({ playbackFinished: true }), { timeout: 10_000 });
    expect(await status(server)).toEqual({ kind: "idle", match: null });
    expect(await ended(w, lobbyId)).toMatchObject({ outcome: "colony_2_won", mode: "quadrants", rated: false });

    // A rated 1v1 played after it: red keeps calling, blue stays silent and loses for idling.
    const keys = [await claim(w, "red"), await claim(w, "blue")];
    const next = await w.store.transaction<Lobby>(async read => {
      const made = await w.lobbies.queuedMatchWrites(read, { mode: "1v1", colonies: keys.map(key => [{ id: key.identity.id, displayName: key.identity.displayName }]) }, Date.now());
      return { result: made.lobby, writes: made.writes };
    });
    await waitFor(() => openStartOf(server) === next.id, 20_000);
    const [red] = await Promise.all(keys.map(async key => {
      const a = await agent(server);
      expect((await a.call("join", { key: key.key })).isError).toBe(false);
      return a;
    }));
    await waitFor(() => server.game.match!.seq !== seq && server.hub.hasLobby(next.id), 20_000);
    const nextSeq = server.game.match!.seq;
    let redDone = false;
    const redLoop = (async () => { while (!redDone) { await red!.call("observe"); await new Promise(resolve => setTimeout(resolve, 50)); } })();
    try {
      expect(await ended(w, next.id)).toMatchObject({ outcome: "colony_0_won", rated: true });
    } finally {
      redDone = true;
      await redLoop;
    }

    // While its delayed playback runs, the current-match stream and the status serve the later match.
    const current = await spectate(server, "/live/current");
    expect([current.status, current.match]).toEqual([200, String(nextSeq)]);
    const playing = await status(server);
    expect(playing).toEqual({ kind: "playing", match: expect.any(Number) });
    expect(playing.match).not.toBe(match);
    // Its playback names the match the status named, and carries the later match's two colonies.
    await playOut(clock, (RATED_DELAY_SECONDS + 30) * 1000, () => current.messages.some(m => m.events.some(isEnd)));
    expect(current.messages[0]!.full!.match).toBe(playing.match);
    expect(current.messages[0]!.full!.setup.queens).toHaveLength(2);
    expect(current.messages[0]!.full!.setup.colonies).toBeUndefined();
  });
});
