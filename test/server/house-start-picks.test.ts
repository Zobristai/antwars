import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.js";
import { createRatings, RANKED_MODES, type RankedMode } from "../../src/rating/ratings.js";
import { startServer, type GameServer } from "../../src/server.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { START_PICK_WINDOW_MS, startBoxes, startPickWindowMsFor, type StartTile } from "../../src/sim/startPlacement.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { createFirestore } from "../../src/store/firestore.js";
import { connect, matchLogs, tempDir, waitFor, type Agent } from "./helpers.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const HOUSE = [[1, "house-1v1"], [2, "house-2v2"], [3, "house-3v3"], [4, "house-4v4"]] as const;
const PUBLIC = [[1, "1v1"], [2, "2v2"], [3, "3v3"], [4, "4v4"]] as const;
const config = newMatchConfig(PUBLIC_CONFIG);
const seed = 7001;
let server: GameServer | undefined;
const clients: Agent[] = [];
let counter = 0;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server?.close(); server = undefined;
  vi.restoreAllMocks();
});

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** Real queue, store, slot runner, Game and MCP; only the nest-window timer is captured. */
async function setup(mode: RankedMode | null, size: 1 | 2 | 3 | 4) {
  const store = createFirestore({ projectId: "demo-antwar", namespace: `house-picks-${process.pid}-${counter++}-${Date.now()}`, emulatorHost });
  const identities = createIdentities(store);
  const ratings = createRatings(store);
  const lobbies = createLobbies(store, identities, { countdownMs: 10, publicSlots: 1 });
  const house = value(await identities.claimUsername("antwars"));
  const red = value(await identities.createHandle(house.key, "red"));
  const blue = mode?.startsWith("house-")
    ? value(await identities.createHandle(house.key, "blue"))
    : value(await identities.claimUsername("Rival"));
  const keys = [red, blue];
  for (const ratedMode of RANKED_MODES) {
    await ratings.applyResult({ matchId: `seed-${ratedMode}`, mode: ratedMode,
      teams: [[red.identity.id], [blue.identity.id]], winner: "a" });
  }
  const snapshot = () => Promise.all(RANKED_MODES.map(async ratedMode => ({ mode: ratedMode,
    red: await ratings.readRating(red.identity.id, ratedMode), blue: await ratings.readRating(blue.identity.id, ratedMode) })));
  const before = await snapshot();
  let lobby: Lobby;
  if (mode !== null) {
    value(await lobbies.joinQueue(red.key, mode));
    const paired = value(await lobbies.joinQueue(blue.key, mode));
    if (paired.state !== "matched") throw new Error("Pair did not match");
    lobby = value(await lobbies.readLobby(paired.lobbyId));
  } else {
    const made = value(await lobbies.createLobby(red.key, "public", size));
    value(await lobbies.join(made.lobby.id, red.key));
    lobby = value(await lobbies.join(made.lobby.id, blue.key));
    if (size > 1) lobby = value(await lobbies.startEarly(lobby.id, red.key));
  }
  // A separate ready lobby must receive the released slot, not disappear with the abort.
  const nextKeys = [value(await identities.claimUsername("NextRed")), value(await identities.claimUsername("NextBlue"))];
  const nextCreated = value(await lobbies.createLobby(nextKeys[0]!.key, "public", 1));
  for (const key of nextKeys) value(await lobbies.join(nextCreated.lobby.id, key.key));
  expect(value(await lobbies.readLobby(nextCreated.lobby.id)).state).toBe("waiting");

  // This lobby's nest window: 240 s in index matches, 120 s otherwise. The next lobby's 120 s window is captured too.
  const windowMs = startPickWindowMsFor(mode?.startsWith("house-") === true);
  const isWindowDelay = (delay: number) => [windowMs, START_PICK_WINDOW_MS].some(ms => delay > ms - 1_000 && delay <= ms);
  let finishWindow: (() => void) | undefined;
  let clock: number | undefined;
  const realNow = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => clock ?? realNow());
  const realTimeout = globalThis.setTimeout;
  const captured: NodeJS.Timeout[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== undefined && isWindowDelay(delay)) {
      const handle = realTimeout(() => {}, delay);
      captured.push(handle);
      finishWindow = () => { clearTimeout(handle); callback(...args); };
      return handle;
    }
    return realTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const started: { tick: number; nests: unknown }[] = [];
  const ticks: number[] = [];
  const dataDir = tempDir();
  server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: config, seed,
    feed: { matchStarted: (_seq, state) => started.push({ tick: state.tick, nests: state.config.initialQueens }),
      ticked: (_seq, output) => ticks.push(output.state.tick) },
    slot: { slot: "public-0", publicUrl: "http://house-picks.test", lobbies, identities, pollMs: 10 } });
  await waitFor(() => finishWindow !== undefined, 20_000);
  const nextStart = server.game.nextStart;
  if (nextStart?.kind !== "scheduled") throw new Error("No nest-window deadline");
  const deadline = nextStart.at.getTime();
  expect(deadline - realNow()).toBeGreaterThan(windowMs - 1_000);
  expect(deadline - realNow()).toBeLessThanOrEqual(windowMs);
  const finish = finishWindow!;
  const board = createMatch(seed, config);
  const tiles = ([0, 1] as const).map(colony => {
    const box = startBoxes(config)[colony], result: StartTile[] = [];
    for (let y = box.y; y < box.y + box.height && result.length < size; y++) {
      for (let x = box.x; x < box.x + box.width && result.length < size; x++) {
        if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * config.mapWidth + x] === 0) {
          result.push({ tileX: x, tileY: y });
        }
      }
    }
    expect(result).toHaveLength(size);
    return result;
  });
  const seats = lobby.colonies.flatMap((colony, colonyIndex) => colony.map((seat, index) => ({
    key: keys.find(key => key.identity.id === seat.id)!.key,
    number: index + 1, tile: tiles[colonyIndex]![index]!,
  })));
  async function joinSeat(seat: (typeof seats)[number]) {
    const client = await connect(server!.port); clients.push(client);
    const joined = await client.call("join", { key: seat.key, seat: seat.number });
    expect(joined.isError).toBe(false);
    expect(joined.data.nestSelection.required).toBe(mode?.startsWith("house-") === true);
    return client;
  }
  return { lobbies, ratings, snapshot, before, lobby, nextId: nextCreated.lobby.id, seats, tiles, joinSeat, started, ticks, dataDir,
    finish: () => { clock = deadline; finish(); },
    readLobby: async () => value(await lobbies.readLobby(lobby.id)),
    cleanupTimers: () => captured.forEach(handle => clearTimeout(handle)),
  };
}

describe.skipIf(!emulatorHost)("house picks through the queue and match server", () => {
  it.each(HOUSE)("%i seats: %s starts with every seat's own pick, after the existing window", async (size, mode) => {
    const w = await setup(mode, size);
    try {
      for (const seat of w.seats) {
        const client = await w.joinSeat(seat);
        expect((await client.call("pick_nest", { ...seat.tile })).data.accepted).toBe(true);
      }
      expect(w.started).toEqual([]); expect(w.ticks).toEqual([]); expect(server!.game.match).toBeNull();
      w.finish();
      expect(w.started).toEqual([{ tick: 0, nests: w.tiles }]);
      expect((await w.readLobby()).outcome).toBeNull();
    } finally { w.cleanupTimers(); }
  }, 60_000);

  it.each(HOUSE.flatMap(([size, mode]) => [false, true].map(connectMissing => ({ size, mode, connectMissing }))))(
    "$mode: missing pick, connected=$connectMissing, records not_played and hands off the slot without any rating change", async ({ size, mode, connectMissing }) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const w = await setup(mode, size);
      try {
        const joined: Agent[] = [];
        for (const [index, seat] of w.seats.entries()) {
          const missing = index === w.seats.length - 1;
          if (missing && !connectMissing) continue;
          const client = await w.joinSeat(seat); joined.push(client);
          if (!missing) expect((await client.call("pick_nest", { ...seat.tile })).data.accepted).toBe(true);
        }
        expect(w.started).toEqual([]); expect(w.ticks).toEqual([]);
        w.finish();
        expect(server!.game.match).toBeNull(); expect(w.started).toEqual([]); expect(w.ticks).toEqual([]);
        expect(matchLogs(w.dataDir).size).toBe(0);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("Every seat must pick a starting nest"));
        // Allow the real serial runner to commit the pending ending and transfer its slot.
        let ended: Lobby;
        const timeout = performance.now() + 20_000;
        do {
          ended = await w.readLobby();
          if (ended.state === "ended") break;
          if (performance.now() > timeout) throw new Error("Lobby did not end");
          await sleep(10);
        } while (true);
        expect(ended.outcome).toBe("not_played"); expect(ended.slot).toBeNull();
        expect(value(await w.lobbies.readLobby(w.nextId))).toMatchObject({ state: "holding", slot: "public-0" });
        expect(await w.snapshot()).toEqual(w.before);
        expect(await w.ratings.readMatchChanges(w.lobby.id)).toBeNull();
        for (const client of joined) {
          expect((await client.call("observe")).data.error.code).toBe("match_not_played");
        }
        const missing = w.seats.at(-1)!;
        const late = await connect(server!.port); clients.push(late);
        expect((await late.call("join", { key: missing.key, seat: missing.number })).data.error.code).toBe("match_not_played");
      } finally { w.cleanupTimers(); }
    }, 60_000);

  it.each(PUBLIC)("%i seats: public ranked %s still starts with defaults", async (size, mode) => {
    const w = await setup(mode, size);
    try {
      await w.joinSeat(w.seats[0]!);
      w.finish();
      expect(w.started).toHaveLength(1);
      expect(server!.game.match!.state.config.initialQueens!.map(team => team.length)).toEqual([size, size]);
    } finally { w.cleanupTimers(); }
  }, 60_000);

  it.each([1, 2, 3, 4] as const)("unrated size %i still starts with defaults for its seated roster", async size => {
    const w = await setup(null, size);
    try {
      await w.joinSeat(w.seats[0]!);
      w.finish();
      expect(w.started).toHaveLength(1);
      expect(server!.game.match!.state.config.initialQueens!.map(team => team.length)).toEqual([1, 1]);
    } finally { w.cleanupTimers(); }
  }, 60_000);
});
