import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { createFirestore, type Write } from "../../src/store/firestore.ts";
import type { Game } from "../../src/mcp/game.ts";
import { connect, shortConfig, tempDir, type Agent } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// Runs inside `firebase emulators:exec --only firestore`,
// which sets FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when it is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const SEED = 7001;
const WINDOW_MS = 3000;
const CONFIG: SimConfig = playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding }));

const servers: SpectatedServer[] = [];
const agents: Agent[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

/** Legal starting tiles of a box on the board the lobby's pick window freezes for SEED. */
function legalTiles(box: { x: number; y: number; width: number; height: number }, count: number) {
  const { initialQueens: _none, ...unpicked } = CONFIG;
  const board = createMatch(SEED, unpicked);
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let y = box.y; y < box.y + box.height && tiles.length < count; y += 2) for (let x = box.x; x < box.x + box.width && tiles.length < count; x += 2) {
    if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * board.config.mapWidth + x] === 0) tiles.push({ tileX: x, tileY: y });
  }
  return tiles;
}

describe.skipIf(!host)("per-seat slot seating for a team-mode match against the Firestore emulator", { timeout: 120_000 }, () => {
  it("joins, nest-picks, starts and rejoins each seat of a 2v2 pairing's lobby by key and seat, and lists it as a public rated match", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const namespace = `team-${process.pid}-${Date.now().toString(36)}`;
    const store = createFirestore({ projectId, namespace, emulatorHost: host });
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 2000 });
    const accounts = { identities, lobbies, ratings: createRatings(store) };
    const claim = async (name: string) => {
      const claimed = await identities.claimUsername(name);
      if (!claimed.ok) throw new Error(claimed.reason);
      return claimed.value;
    };
    const ann = await claim("TeamAnn"), bob = await claim("TeamBob");

    // The stored shape the team-mode pairing writes through queuedMatchWrites/settleSlots
    // A full public rated lobby, size colonies[0].length, each
    // identity's seat repeated on its own colony, the mode, holding a public slot.
    const lobbyId = randomUUID();
    const at = Date.now();
    const seat = (identity: typeof ann, colony: 0 | 1) => ({ id: identity.identity.id, displayName: identity.identity.displayName, colony });
    const writes: Write[] = [
      { op: "create", path: `lobbies/${lobbyId}`, fields: {
        kind: "public", size: "2", creatorId: ann.identity.id, createdAt: String(at), state: "holding", rated: "true", slot: "public-0",
        seats: JSON.stringify([seat(ann, 0), seat(ann, 0), seat(bob, 1), seat(bob, 1)]), inviteVerifier: "",
        startsAt: String(at + 2000), matchRunId: "", outcome: "", mode: "2v2" } },
      { op: "create", path: "slots/public-0", fields: { lobbyId } },
    ];
    await store.transaction(async () => ({ result: null, writes }));

    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, dataDir = tempDir(); directories.push(dataDir);
    const server = await startSpectatedServer({ port, host: "127.0.0.1", dataDir, simConfig: CONFIG, seed: SEED,
      accounts, watchRegistry: createWatchRegistry(store), startPickWindowMs: WINDOW_MS,
      slot: { slot: "public-0", publicUrl: origin, lobbies, identities, pollMs: 50 } });
    servers.push(server);
    // The slot server's own Game, read directly only to wait without spending seat calls.
    const game = server.game as Game;
    const session = async () => { const agent = await connect(server.port); agents.push(agent); return agent; };

    await until(() => server.game.nextStart?.kind === "scheduled");
    expect(game.seatsHeld(ann.identity.id)).toBe(2);
    const probe = await session();
    expect((await probe.call("join", { key: ann.key })).data.error.code).toBe("seat_required");
    expect((await probe.call("join", { key: ann.key, seat: 3 })).data.error.code).toBe("no_such_seat");

    // Each seat joins from its own session with its own key and seat, and is its own agent.
    const seats: { colony: 0 | 1; seat: number; agent: Agent; agentId: string }[] = [];
    for (const [colony, key] of [[0, ann.key], [1, bob.key]] as const) {
      for (const number of [1, 2]) {
        const agent = await session();
        const joined = await agent.call("join", { key, seat: number });
        expect(joined.isError, joined.text).toBe(false);
        seats.push({ colony, seat: number, agent, agentId: joined.data.agentId });
      }
    }
    expect(new Set(seats.map(s => s.agentId)).size).toBe(4);

    // During the pick window every seat picks its own nest; picks are per seat.
    // Polled on the server, so the seats spend no calls of their per-seat rate limit waiting.
    const box = await until(() => game.nestSelection(seats[0]!.agentId)?.box);
    const ownTiles = legalTiles(box, 2);
    for (const [n, s] of seats.slice(0, 2).entries()) {
      const picked = await s.agent.call("pick_nest", ownTiles[n]!);
      expect(picked.isError, picked.text).toBe(false);
    }
    const second = (await seats[1]!.agent.call("observe")).data.nestSelection.picks;
    expect(second).toEqual([
      { displayName: `${ann.identity.displayName} #1`, mine: false, ...ownTiles[0]! },
      { displayName: `${ann.identity.displayName} #2`, mine: true, ...ownTiles[1]! },
    ]);
    const bobBox = game.nestSelection(seats[2]!.agentId)!.box;
    const bobTiles = legalTiles(bobBox, 2);
    for (const [n, s] of seats.slice(2).entries()) expect((await s.agent.call("pick_nest", bobTiles[n]!)).isError).toBe(false);

    // The match starts with all four seats, each on its own colony, from its own pick.
    await until(() => server.game.match !== null && server.game.match.result === null && server.game.match.state.agents.length === 4);
    const state = server.game.match!.state;
    for (const s of seats) expect(state.agents.find(agent => agent.id === s.agentId)?.colony).toBe(s.colony);
    expect(state.config.initialQueens![0]).toEqual(expect.arrayContaining(ownTiles));
    expect(state.config.initialQueens![1]).toEqual(expect.arrayContaining(bobTiles));

    // Rejoining with the same key and seat from a new session returns the same seat.
    const again = await session();
    const rejoined = await again.call("join", { key: ann.key, seat: 2 });
    expect(rejoined.isError, rejoined.text).toBe(false);
    expect(rejoined.data.agentId).toBe(seats[1]!.agentId);
    expect(server.game.match!.state.agents).toHaveLength(4);

    // Once started, /watch/catalog lists it as a public rated match.
    const catalog = await until(async () => {
      const body = await (await fetch(`${origin}/watch/catalog`)).json() as { matches: { lobbyId: string; rated: boolean }[] };
      return body.matches.find(match => match.lobbyId === lobbyId);
    });
    expect(catalog).toMatchObject({ lobbyId, rated: true });
  });
});
