import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { connect, tempDir, type Agent } from "../server/helpers.ts";
import { playable } from "../playable.ts";
import { createMatch } from "../../src/sim/map.ts";
import { startBoxes, type StartTile } from "../../src/sim/startPlacement.ts";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.ts";
import { ManualClock } from "./helpers.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings, type RankedMode } from "../../src/rating/ratings.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { HOUSE_START_PICK_WINDOW_MS } from "../../src/sim/startPlacement.ts";

/**
 * House match listing: once a house-mode match starts on
 * the public slot's real server, /watch/catalog lists it as a public rated match.
 * Runs inside `firebase emulators:exec --only firestore`; skipped only when
 * FIRESTORE_EMULATOR_HOST is unset.
 */
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const HOUSE_MODES = [["house-1v1", 1], ["house-2v2", 2], ["house-3v3", 3], ["house-4v4", 4]] as const satisfies readonly (readonly [RankedMode, number])[];

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  return port;
}

describe.skipIf(!emulatorHost)("house-mode match on the public slot", () => {
  it.each(HOUSE_MODES)("%s: once it starts, /watch/catalog lists it as a public rated match", async (mode, size) => {
    const namespace = `house-watch-${process.pid}-${Date.now().toString(36)}-${size}`;
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost });
    const identities = createIdentities(store);
    const accounts = { store, identities, lobbies: createLobbies(store, identities, { countdownMs: 0 }), ratings: createRatings(store), watch: createWatchRegistry(store) };
    const port = await freePort(), origin = `http://127.0.0.1:${port}`, dataDir = tempDir(), abort = new AbortController();
    let server: SpectatedServer | undefined;
    const clients: Agent[] = [];
    const seed = 7001, config = playable({ ...rulesConfig("redesign"), matchTicks: 2 });
    // Game captures Date.now at construction; advance its clock only after all picks.
    const realNow = Date.now;
    let clockOffset = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    // Hold only the nest-window timer: real MCP/store I/O must finish before it closes.
    const realTimeout = globalThis.setTimeout;
    let finishWindow: (() => void) | undefined;
    let windowTimer: NodeJS.Timeout | undefined;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      // Index matches open a 240 s nest window.
      if (delay !== undefined && delay > HOUSE_START_PICK_WINDOW_MS - 1_000 && delay <= HOUSE_START_PICK_WINDOW_MS) {
        windowTimer = realTimeout(() => {}, HOUSE_START_PICK_WINDOW_MS);
        finishWindow = () => { clearTimeout(windowTimer); callback(...args); };
        return windowTimer;
      }
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, seed, simConfig: config,
        accounts, watchRegistry: accounts.watch, spectatorClock: new ManualClock(),
        slot: { slot: "public-0", publicUrl: origin, lobbies: accounts.lobbies, identities, pollMs: 25 } });

      const house = value(await identities.claimUsername("antwars"));
      const red = value(await identities.createHandle(house.key, "red"));
      const blue = value(await identities.createHandle(house.key, "blue"));
      // The queue's pairing for this size: each handle holds every seat of its colony.
      const colonies = [Array.from({ length: size }, () => ({ id: red.identity.id, displayName: red.identity.displayName })),
        Array.from({ length: size }, () => ({ id: blue.identity.id, displayName: blue.identity.displayName }))] as const;
      const lobby = await store.transaction<Lobby>(async (read) => {
        const made = await accounts.lobbies.queuedMatchWrites(read, { mode, colonies }, Date.now());
        return { result: made.lobby, writes: made.writes };
      });
      expect(lobby).toMatchObject({ kind: "public", mode, rated: true, slot: "public-0" });

      const live = server;
      await vi.waitFor(() => expect(finishWindow).toBeTypeOf("function"), { timeout: 20_000 });
      // MCP clients also use 60-second request timers; do not intercept those.
      timers.mockRestore();
      const nextStart = live.game.nextStart;
      if (nextStart?.kind !== "scheduled") throw new Error("No nest-window deadline");
      const board = createMatch(seed, config);
      const nests = startBoxes(config).map(box => {
        const tiles: StartTile[] = [];
        for (let y = box.y; y < box.y + box.height && tiles.length < size; y++) {
          for (let x = box.x; x < box.x + box.width && tiles.length < size; x++) {
            if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * config.mapWidth + x] === 0) {
              tiles.push({ tileX: x, tileY: y });
            }
          }
        }
        expect(tiles).toHaveLength(size);
        return tiles;
      });
      for (const [colonyIndex, colony] of lobby.colonies.entries()) {
        for (const [index, seat] of colony.entries()) {
          const owner = [red, blue].find(handle => handle.identity.id === seat.id)!;
          const client = await connect(port); clients.push(client);
          const joined = await client.call("join", { key: owner.key, seat: index + 1 });
          expect(joined.isError).toBe(false);
          expect(joined.data.nestSelection.required).toBe(true);
          const picked = await client.call("pick_nest", { ...nests[colonyIndex]![index]! });
          expect(picked.isError).toBe(false);
          expect(picked.data.accepted).toBe(true);
        }
      }
      expect(live.hub.hasLobby(lobby.id)).toBe(false);
      clockOffset = nextStart.at.getTime() - realNow();
      finishWindow!();
      expect(live.game.match?.state.config.initialQueens).toEqual(nests);
      await vi.waitFor(() => expect(live.hub.hasLobby(lobby.id)).toBe(true), { timeout: 20_000 });
      await vi.waitFor(async () => {
        const catalog = await (await fetch(`${origin}/watch/catalog`, { signal: abort.signal })).json() as { matches: { lobbyId: string; rated: boolean }[] };
        expect(catalog.matches).toContainEqual(expect.objectContaining({ lobbyId: lobby.id, rated: true }));
      }, { timeout: 10_000 });
    } finally {
      abort.abort();
      clearTimeout(windowTimer);
      timers.mockRestore();
      for (const client of clients) await client.close();
      await server?.close();
      now.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
