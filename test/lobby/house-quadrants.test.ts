import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { newWaitToken } from "../../src/lobby/waits.ts";
import { Game } from "../../src/mcp/game.ts";
import { RANKED_MODES, ratingCollection } from "../../src/rating/ratings.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { fourColonyEnd } from "../../src/sim/elimination.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";
import { HOUSE_MODES, HOUSE_QUEUE_TTL_MS, HOUSE_SIZE, houseCast } from "./house-fixtures.ts";

const QUEUE = "house-quadrants";
const value = <T>(reply: LobbyOutcome<T>): T => { if (!reply.ok) throw new Error(reply.reason); return reply.value; };
async function world(ffaLiveEnabled: boolean) {
  const { store } = memoryWatchStore();
  const identities = createIdentities(store), now = () => 1_000_000;
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, ffaLiveEnabled, now });
  return { store, lobbies, now, ...await houseCast(identities, store) };
}

describe("house Free-for-all", () => {
  it.each([true, false])("seats four house handles on a quadrant map; Free-for-all rating enabled: %s", async enabled => {
    const { store, lobbies, now, houseHandles, rivalHandle, house, lookalikes } = await world(enabled);
    for (const other of [rivalHandle, house, ...lookalikes]) {
      expect(await lobbies.joinQueue(other.key, QUEUE)).toEqual({ ok: false, reason: "not_house" });
    }
    const players = houseHandles.map(handle => ({ ...handle, token: newWaitToken() }));
    for (const { key, token } of players.slice(0, 3)) {
      expect(value(await lobbies.joinQueue(key, QUEUE, token))).toMatchObject({ state: "waiting", mode: QUEUE, expiresAt: now() + HOUSE_QUEUE_TTL_MS });
    }
    expect(await lobbies.joinQueue(players[0].key, QUEUE)).toEqual({ ok: false, reason: "already_queued" });
    const paired = value(await lobbies.joinQueue(players[3].key, QUEUE, players[3].token));
    if (paired.state !== "matched") throw new Error("four house handles should match");
    const id = paired.lobbyId, lobby = value(await lobbies.readLobby(id));
    expect(lobby).toMatchObject({ mode: "quadrants", size: 1, kind: "public", rated: enabled });
    expect(lobby.colonies.map(seats => seats.length)).toEqual([1, 1, 1, 1]);
    expect(lobby.colonies.flat().map(s => s.id).sort()).toEqual(players.map(p => p.id).sort());
    for (const { key, token } of players) {
      expect(value(await lobbies.queueStatus(key))).toMatchObject({ state: "matched", mode: QUEUE, lobbyId: id });
      expect(await lobbies.waitStatus(token)).toMatchObject({ state: "paired", lobbyId: id });
    }
    let at = now();
    const game = new Game({ simConfig: newMatchConfig(rulesConfig("redesign")), now: () => at,
      slot: { identityOf: async () => undefined, locate: async () => undefined } });
    game.seatLobby(id, lobby.colonies.flatMap((seats, colony) => seats.map(s => ({ identityId: s.id, displayName: s.displayName, colony }))), lobby.mode);
    const closesAt = game.beginLobbyStart(404);
    for (const player of players) expect((await game.joinSeated(player.id))?.outcome.kind).toBe("queued");
    at = closesAt;
    game.finishLobbyStart();
    const state = game.match!.state;
    expect(quadrantMatchMaps().map(m => m.id)).toContain(state.terrain!.mapId);
    const finish = fourColonyEnd(state, state.config.matchTicks - 1, false)!;
    expect(finish).toMatchObject({ reason: "time_up", winner: null, ffa: { rateable: true } });
    const slot = lobby.slot!, run = "first";
    await lobbies.registerInstance(slot, { runId: run, mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" });
    value(await lobbies.beginMatch(id, slot, run));
    value(await lobbies.endMatch(id, run, "draw", undefined, undefined, undefined, undefined, { ...finish, eliminations: [] }));
    expect((await store.get(`ffaMatches/${id}`)) !== null).toBe(enabled);
    for (const player of players) {
      const ffa = await store.get(`ratings-ffa/${player.id}`);
      if (enabled) expect(ffa).toMatchObject({ ratedMatches: "1" });
      else expect(ffa).toBeNull();
      for (const mode of RANKED_MODES) expect(await store.get(`${ratingCollection(mode)}/${player.id}`)).toBeNull();
    }
  });

  it("keeps four same-owner handles waiting in the public queue", async () => {
    const { lobbies, houseHandles } = await world(true);
    for (const player of houseHandles) expect(value(await lobbies.joinQueue(player.key, "quadrants")).state).toBe("waiting");
  });

  it.each(HOUSE_MODES)("keeps the two-colony house seating and rating flag in %s", async mode => {
    const { lobbies, houseHandles: [a, b] } = await world(false);
    expect(value(await lobbies.joinQueue(a.key, mode)).state).toBe("waiting");
    const paired = value(await lobbies.joinQueue(b.key, mode));
    if (paired.state !== "matched") throw new Error("expected a team match");
    const lobby = value(await lobbies.readLobby(paired.lobbyId));
    expect(lobby).toMatchObject({ mode, size: HOUSE_SIZE[mode], rated: true });
    expect(lobby.colonies.map(seats => seats.map(s => s.id))).toEqual([a, b].map(p => Array(HOUSE_SIZE[mode]).fill(p.id)));
  });
});
