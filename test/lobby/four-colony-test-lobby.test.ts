/// <reference types="node" />
// A four-colony test lobby at the lobby layer: create_lobby with test and mode quadrants makes a lobby of four one-seat
// colonies, typed test and left out of the public lobby lists, seated by join, started by the fourth join, unrated, and its
// release keeps the Free-for-all result and rates nothing. Without test the mode is refused; queue-made quadrants lobbies
// and ordinary two-colony lobbies are unchanged.
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, LOBBY_TTL_MS, type MatchResult } from "../../src/lobby/lobbies.ts";
import { lobbyMatchType } from "../../src/replays/recorded-match-type.ts";
import { quadrantColonyNames } from "../../src/sim/colonyNames.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const INSTANCE = { mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" };

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

async function world(options: { readonly quadrantMaps?: readonly never[] } = {}) {
  const clock = { t: Date.UTC(2026, 10, 19, 9, 0, 0) };
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock.t, random: () => 0, ...options });
  const claim = async (name: string) => {
    const issued = value(await identities.claimUsername(name));
    return { id: issued.identity.id, key: issued.key };
  };
  const players = [];
  for (const name of ["Ann", "Bob", "Cat", "Dan"]) players.push(await claim(name));
  return { clock, docs, lobbies, claim, players };
}

describe("a four-colony test lobby", () => {
  it("is four one-seat colonies typed test, filled by four joins in colony order, started by the fourth and unrated", async () => {
    const w = await world();
    const created = value(await w.lobbies.createLobby(w.players[0]!.key, "public", 1, { test: true, mode: "quadrants" })).lobby;
    expect(created).toMatchObject({ test: true, mode: "quadrants", size: 1, state: "open", rated: null, colonies: [[], [], [], []],
      colonyNames: quadrantColonyNames() });
    expect(lobbyMatchType(created)).toEqual({ kind: "test", size: 1 });
    for (const [colony, player] of w.players.slice(0, 3).entries()) {
      const joined = value(await w.lobbies.join(created.id, player.key));
      expect(joined.colonies[colony]!.map(seat => seat.id)).toEqual([player.id]);
      expect(joined.state).toBe("open");
      // Never on a public lobby list while it waits for its seats.
      expect((await w.lobbies.listPublic()).map(lobby => lobby.id)).not.toContain(created.id);
      expect(await w.lobbies.listUnstarted()).toEqual([]);
    }
    // start_lobby needs all four colonies seated.
    expect(await w.lobbies.startEarly(created.id, w.players[0]!.key)).toEqual({ ok: false, reason: "colony_empty" });
    const started = value(await w.lobbies.join(created.id, w.players[3]!.key));
    expect(started).toMatchObject({ state: "holding", slot: "public-0", rated: false, test: true, mode: "quadrants" });
    expect(started.colonies.map(colony => colony.map(seat => seat.id))).toEqual(w.players.map(player => [player.id]));
    expect(await w.lobbies.slotHolder("public-0")).toMatchObject({ lobbyId: created.id, mode: "quadrants",
      colonies: w.players.map(player => [expect.objectContaining({ id: player.id })]) });
    expect(await w.lobbies.join(created.id, (await w.claim("Eve")).key)).toEqual({ ok: false, reason: "full" });
    expect(await w.lobbies.listUnstarted()).toEqual([]);

    // Released with a Free-for-all result: the result is kept as a quadrants match's is, and nothing is rated.
    const result: MatchResult = { reason: "elimination", ffa: { version: 1, order: [2, 0, 3, 1], territoryWinnerFirst: true, rateable: true },
      eliminations: [{ colony: 1, tick: 90 }, { colony: 3, tick: 200 }, { colony: 0, tick: 205 }] };
    await w.lobbies.registerInstance("public-0", { runId: "run", ...INSTANCE });
    value(await w.lobbies.beginMatch(created.id, "public-0", "run"));
    value(await w.lobbies.endMatch(created.id, "run", "colony_2_won", undefined, undefined, undefined, undefined, result));
    expect(value(await w.lobbies.readLobby(created.id))).toMatchObject({ state: "ended", outcome: "colony_2_won", rated: false, test: true });
    expect(JSON.parse(w.docs.get(`lobbies/${created.id}`)!.result!)).toEqual(result);
    expect([...w.docs.keys()].filter(path => path.startsWith("ratings") || path.startsWith("ratedMatches/"))).toEqual([]);
  });

  it("expires unfilled like any player-created lobby", async () => {
    const w = await world();
    const created = value(await w.lobbies.createLobby(w.players[0]!.key, "public", 1, { test: true, mode: "quadrants" })).lobby;
    value(await w.lobbies.join(created.id, w.players[0]!.key));
    w.clock.t += LOBBY_TTL_MS;
    expect(value(await w.lobbies.readLobby(created.id)).state).toBe("expired");
    expect(await w.lobbies.join(created.id, w.players[1]!.key)).toEqual({ ok: false, reason: "expired" });
  });

  it("is refused without test, at another size, for another mode, and while the quadrants rotation is empty", async () => {
    const w = await world();
    const key = w.players[0]!.key;
    expect(await w.lobbies.createLobby(key, "public", 1, { mode: "quadrants" })).toEqual({ ok: false, reason: "test_only" });
    expect(await w.lobbies.createLobby(key, "public", 2, { test: true, mode: "quadrants" })).toEqual({ ok: false, reason: "test_only" });
    expect(await w.lobbies.createLobby(key, "public", 1, { test: true, mode: "1v1" as "quadrants" })).toEqual({ ok: false, reason: "invalid_mode" });
    const empty = await world({ quadrantMaps: [] });
    expect(await empty.lobbies.createLobby(empty.players[0]!.key, "public", 1, { test: true, mode: "quadrants" })).toEqual({ ok: false, reason: "no_quadrant_map" });
    expect([...w.docs.keys()].filter(path => path.startsWith("lobbies/"))).toEqual([]);
  });
});

describe("beside it, unchanged", () => {
  it("an ordinary lobby seats two colonies, lists publicly and is not a test; a queue-made quadrants lobby never expires and is typed quadrants", async () => {
    const w = await world();
    const ordinary = value(await w.lobbies.createLobby(w.players[0]!.key, "public", 1)).lobby;
    expect(ordinary).not.toHaveProperty("test");
    expect(ordinary.colonies).toHaveLength(2);
    expect((await w.lobbies.listPublic()).map(lobby => lobby.id)).toEqual([ordinary.id]);
    value(await w.lobbies.join(ordinary.id, w.players[0]!.key));
    expect((await w.lobbies.listUnstarted()).map(lobby => lobby.colonies.flat().map(seat => seat.id))).toEqual([[w.players[0]!.id]]);
    expect(value(await w.lobbies.join(ordinary.id, w.players[1]!.key))).toMatchObject({ state: "holding", rated: false });

    const queued = [];
    for (const name of ["Fay", "Gus", "Hal", "Ivy"]) queued.push(await w.claim(name));
    for (const player of queued) value(await w.lobbies.joinQueue(player.key, "quadrants"));
    const status = value(await w.lobbies.queueStatus(queued[0]!.key)) as { state: string; lobbyId?: string };
    expect(status.state).toBe("matched");
    w.clock.t += 2 * LOBBY_TTL_MS;
    const lobby = value(await w.lobbies.readLobby(status.lobbyId!));
    expect(lobby).toMatchObject({ mode: "quadrants", rated: false });
    expect(lobby.state).not.toBe("expired");
    expect(lobby).not.toHaveProperty("test");
    expect(lobbyMatchType(lobby)).toEqual({ kind: "quadrants", size: 1 });
  });
});
