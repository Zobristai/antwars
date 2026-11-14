import { setTimeout as sleep } from "node:timers/promises";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import type { Game } from "../../src/mcp/game.ts";
import { COUNTDOWN_MS, createLobbies, type Lobby, type LobbyKind, type MatchOutcome } from "../../src/lobby/lobbies.ts";
import { lobbyPageUrl } from "../../src/lobby/site.ts";
import { createRatings, ratingCollection } from "../../src/rating/ratings.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { connect, shortConfig, tempDir, TEST_MCP_CONFIG, type Agent } from "../server/helpers.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";
import { playable } from "../playable.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const OPERATOR = "slot-operator-token";
const LONG = playable(shortConfig(60_000, { queenFounding: PUBLIC_CONFIG.queenFounding }));
/** A 1 s match that always reaches its natural time-up result. */
const SHORT = playable(shortConfig(20, { ticksPerSecond: 20, queenFounding: PUBLIC_CONFIG.queenFounding }));

let counter = 0;
const servers: GameServer[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

/** `now` is the lobbies' clock only; slot servers keep the real one. */
function world(countdownMs = 300, now: () => number = Date.now) {
  const namespace = `s${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = () => createFirestore({ projectId, namespace, emulatorHost: host });
  const identities = createIdentities(store());
  const lobbies = createLobbies(store(), identities, { countdownMs, now });
  const ratings = createRatings(store());
  async function keyFor(name: string) {
    const claimed = await identities.claimUsername(name);
    if (!claimed.ok) throw new Error(claimed.reason);
    return claimed.value;
  }
  async function lobby(id: string): Promise<Lobby> {
    const read = await lobbies.readLobby(id);
    if (!read.ok) throw new Error(read.reason);
    return read.value;
  }
  /** A lobby of `kind` filled by `names` (two per colony unit); the creator is the first name. */
  async function fill(kind: "public" | "private", size: 1 | 2, names: readonly string[]) {
    const keys = await Promise.all(names.map(keyFor));
    const created = await lobbies.createLobby(keys[0]!.key, kind, size);
    if (!created.ok) throw new Error(created.reason);
    let last = created.value.lobby;
    for (const key of keys) {
      const joined = await lobbies.join(last.id, key.key, created.value.inviteToken);
      if (!joined.ok) throw new Error(joined.reason);
      last = joined.value;
    }
    return { lobby: last, keys };
  }
  /** Marks a lobby rated "true": player-created lobbies are unrated, so this stands in for a queue-made match. */
  const markRated = (id: string) => store().transaction(async () => ({
    result: undefined, writes: [{ op: "update", path: `lobbies/${id}`, fields: { rated: "true" } }],
  }));
  return { namespace, identities, lobbies, ratings, keyFor, lobby, fill, markRated };
}
type World = ReturnType<typeof world>;

async function slotServer(w: World, slot: string, name: string, simConfig: SimConfig = LONG, pollMs = 50) {
  const started: number[] = [];
  const server = await startServer({
    port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig, operatorToken: OPERATOR,
    startPickWindowMs: 100,
    feed: { matchStarted: () => started.push(Date.now()), ticked: () => {} },
    slot: { slot, publicUrl: `http://${name}.test`, lobbies: w.lobbies, identities: w.identities, pollMs },
  });
  servers.push(server);
  return { server, started };
}

async function agentOn(server: GameServer): Promise<Agent> {
  const agent = await connect(server.port);
  agents.push(agent);
  return agent;
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(25);
  }
}

const operator = (server: GameServer, action: "start" | "stop") =>
  fetch(`http://127.0.0.1:${server.port}/operator/${action}`, { method: "POST", headers: { authorization: `Bearer ${OPERATOR}` } });

const running = (server: GameServer) => server.game.match !== null && server.game.match.result === null;

async function ended(w: World, lobbyId: string): Promise<MatchOutcome> {
  return until(async () => (await w.lobby(lobbyId)).outcome ?? undefined);
}

async function ratedMatches(w: World, keys: readonly { identity: { id: string } }[]): Promise<number[]> {
  return Promise.all(keys.map(async (key) => (await w.ratings.readRating(key.identity.id)).ratedMatches));
}

const KINDS: readonly LobbyKind[] = ["public", "private"];

/** A root server with the account tools: its locate_match reads the same lobbies. */
async function rootServer(w: World): Promise<GameServer> {
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), simConfig: LONG,
    accounts: { identities: w.identities, lobbies: w.lobbies, ratings: w.ratings } });
  servers.push(server);
  return server;
}

/** When each slot's registration committed and its first beginMatch was called, as the slot servers drive them. */
function slotTimings(w: World) {
  const registeredAt = new Map<string, number>();
  const begunAt = new Map<string, number>();
  const register = w.lobbies.registerInstance.bind(w.lobbies);
  vi.spyOn(w.lobbies, "registerInstance").mockImplementation(async (slot, instance, claim) => {
    const registration = await register(slot, instance, claim);
    if (registration.registered) registeredAt.set(slot, Date.now());
    return registration;
  });
  const begin = w.lobbies.beginMatch.bind(w.lobbies);
  vi.spyOn(w.lobbies, "beginMatch").mockImplementation(async (lobbyId, slot, runId, colonyNames) => {
    if (!begunAt.has(slot)) begunAt.set(slot, Date.now());
    return begin(lobbyId, slot, runId, colonyNames);
  });
  return { registeredAt, begunAt };
}

/**
 * Boots a server on the slot each filled lobby already holds. Before its match begins,
 * lobbies.locate and the root locate_match tool return the new server's addresses and
 * every seated key joins it; the match is then played to a natural result (a seat that
 * never joined would end it abandoned instead).
 */
async function bootAndPlay(w: World, root: GameServer, filled: readonly Awaited<ReturnType<World["fill"]>>[], timings: ReturnType<typeof slotTimings>) {
  const booted = await Promise.all(filled.map(({ lobby }) => slotServer(w, lobby.slot!, `${lobby.slot}-late`, SHORT)));
  const finder = await agentOn(root);
  return Promise.all(filled.map(async ({ lobby, keys }, n) => {
    const { server, started } = booted[n]!;
    const slot = lobby.slot!;
    const address = { slot, mcpUrl: `http://${slot}-late.test/mcp`, spectatorUrl: lobbyPageUrl(lobby.id) };
    expect(await w.lobbies.locate(lobby.id)).toEqual({ ok: true, value: address });
    expect((await finder.call("locate_match", { lobbyId: lobby.id })).data).toEqual(address);
    expect(timings.begunAt.has(slot)).toBe(false);

    const seat = await agentOn(server);
    const joined = await until(async () => {
      const reply = await seat.call("join", { key: keys[0]!.key });
      return reply.isError ? undefined : reply;
    });
    for (const key of keys.slice(1)) {
      const reply = await (await agentOn(server)).call("join", { key: key.key });
      expect(reply.isError, reply.text).toBe(false);
    }
    expect(server.game.match).toBeNull();
    expect(timings.begunAt.has(slot)).toBe(false);

    const outcome = await ended(w, lobby.id);
    expect(outcome).toMatch(/^(colony_[01]_won|draw)$/);
    expect(started).toHaveLength(1);
    return { slot, matchStarts: Date.parse(joined.data.matchStarts), registeredAt: timings.registeredAt.get(slot)!, begunAt: timings.begunAt.get(slot)!, startedAt: started[0]! };
  }));
}

describe.skipIf(!host)("slot servers against the Firestore emulator", { timeout: 90_000 }, () => {
  it("starts a lobby's match only after its countdown, seats only its identities by key, resolves it over MCP and HTTP, and refuses operator start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world(2000);
    const { server, started } = await slotServer(w, "public-0", "a");
    const operatorIdle = await operator(server, "start");
    expect(operatorIdle.status).toBe(409);
    expect((await operatorIdle.json()).message).toBe("Matches on this slot server start only from lobbies");
    expect(server.game.match).toBeNull();

    const { lobby, keys } = await w.fill("public", 1, ["Ann", "Bob"]);
    expect(lobby).toMatchObject({ state: "holding", slot: "public-0", rated: false });
    await w.markRated(lobby.id);
    expect(await w.lobby(lobby.id)).toMatchObject({ rated: true });
    expect(lobby.startsAt).toBeGreaterThan(Date.now());
    const cat = await w.keyFor("Cat");

    const ann = await agentOn(server);
    const located = await ann.call("locate_match", { lobbyId: lobby.id });
    expect(located.data).toEqual({ slot: "public-0", mcpUrl: "http://a.test/mcp", spectatorUrl: `https://antwars.ai/?lobby=${lobby.id}` });
    const http = await fetch(`http://127.0.0.1:${server.port}/lobbies/${lobby.id}/match`);
    expect(await http.json()).toEqual(located.data);
    expect((await fetch(`http://127.0.0.1:${server.port}/lobbies/not-a-lobby/match`)).status).toBe(404);

    expect((await ann.call("join")).data.error.code).toBe("key_required");
    expect((await ann.call("join", { key: cat.key })).data.error.code).toBe("not_seated");
    const queued = await ann.call("join", { key: keys[0]!.key });
    expect(queued.isError, queued.text).toBe(false);
    expect(queued.data).not.toHaveProperty("reconnectToken");
    expect(server.game.match).toBeNull();

    await until(() => running(server));
    expect(started).toHaveLength(1);
    expect(started[0]).toBeGreaterThanOrEqual(lobby.startsAt!);
    const bob = await agentOn(server);
    const live = await bob.call("join", { key: keys[1]!.key });
    // markRated stands in for a queue-made lobby's rating only: it sets no ranked mode, so this player-created lobby's
    // match plays under the names it draws from its id, as every player-created lobby's does.
    expect(live.data.colony).toBe(drawColonyNames(lobby.id)[1]);
    expect(server.game.match!.state.agents.map((agent) => agent.colony).sort()).toEqual([0, 1]);
    const operatorRunning = await operator(server, "start");
    expect(operatorRunning.status).toBe(409);
    expect((await operatorRunning.json()).message).toBe("Matches on this slot server start only from lobbies");

    // The operator stop stays; a stopped full rated lobby is unrated.
    expect((await operator(server, "stop")).status).toBe(200);
    expect(await ended(w, lobby.id)).toBe("stopped");
    expect(await ratedMatches(w, keys)).toEqual([0, 0]);
    expect(await w.lobbies.slotHolder("public-0")).toBeNull();
  });

  it("rates every identity seated at the start, idle ones included, on a natural result, then starts the next waiting lobby", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world();
    // Proof of the flake's cause, removed before merge: delay the poll that first finds the lobby holding the slot, so the
    // first join reaches the server before it is seated.
    let delayed = false;
    const slowWorld = { ...w, lobbies: { ...w.lobbies, slotHolder: async (slot: string) => {
      const holder = await w.lobbies.slotHolder(slot);
      if (holder !== null && !delayed) { delayed = true; await sleep(2_000); }
      return holder;
    } } };
    const { server, started } = await slotServer(slowWorld, "public-0", "a", SHORT);
    // The rated match lasts 20 ticks (1 s), so on a loaded runner it could end before the active seat's order arrived,
    // which then failed match_over. Until that order is submitted, its ticks run only to answer waiting calls
    // (the seats' joins), and the order is sent later than the whole match lasts, so it reaches a running match only
    // because of that hold.
    const game = server.game as unknown as Game;
    let orderSubmitted = false;
    const call = game.call.bind(game);
    vi.spyOn(game, "call").mockImplementation((agentId, input, ...rest) => {
      const outcome = call(agentId, input, ...rest);
      if (input.type === "order") orderSubmitted = true;
      return outcome;
    });
    const tick = game.tick.bind(game);
    vi.spyOn(game, "tick").mockImplementation((stopNow) => orderSubmitted || game.pendingInputs > 0 ? tick(stopNow) : null);
    const { lobby, keys } = await w.fill("public", 2, ["P1", "P2", "P3", "P4"]);
    await w.markRated(lobby.id);
    const next = await w.fill("public", 1, ["N1", "N2"]);
    expect(next.lobby.state).toBe("waiting");
    const active = await agentOn(server);
    // The slot server seats the lobby only at its next poll; a join that arrives first is answered lobby_loading,
    // so the first join waits that out (as bootAndPlay's does). Any other refusal still fails here.
    const first = await until(async () => {
      const reply = await active.call("join", { key: keys[0]!.key });
      return reply.isError && reply.data?.error?.code === "lobby_loading" ? undefined : reply;
    });
    expect(first.isError, first.text).toBe(false);
    // Every other seat joins and then stays idle: a seat that never joined would end the match abandoned, unrated.
    for (const key of keys.slice(1)) {
      const reply = await (await agentOn(server)).call("join", { key: key.key });
      expect(reply.isError, reply.text).toBe(false);
    }
    await until(() => running(server));
    await sleep(1_500);
    expect((await active.call("order", { kind: "forage" })).isError).toBe(false);

    const result = await until(() => server.game.match?.result ?? undefined);
    const outcome = await ended(w, lobby.id);
    expect(["colony_0_won", "colony_1_won", "draw"]).toContain(outcome);
    expect(outcome).toBe(result.winner === null ? "draw" : `colony_${result.winner}_won`);
    // Catch-up: each seat is rated against the other team (all 1500 ± 350, so as one 1500 ± 350 opponent):
    // a win or loss gives the independently derived FIRST_WIN / FIRST_LOSS; a draw moves no rating and narrows the RD alike.
    const expected = (colony: number) => outcome === "draw" ? { rating: 1500, rd: FIRST_WIN.rd } : outcome === `colony_${colony}_won` ? FIRST_WIN : FIRST_LOSS;
    for (const [colony, seats] of lobby.colonies.entries()) {
      for (const seat of seats) expect(await w.ratings.readRating(seat.id)).toEqual({ ...expected(colony), ratedMatches: 1 });
    }
    expect(await ratedMatches(w, keys)).toEqual([1, 1, 1, 1]);

    // The slot passes to the waiting lobby, whose match starts on this instance after its own countdown.
    expect((await w.lobby(next.lobby.id))).toMatchObject({ state: "holding", slot: "public-0" });
    await until(() => started.length === 2);
    expect(started[1]).toBeGreaterThanOrEqual((await w.lobby(next.lobby.id)).startsAt!);
    // Neither of its seats ever joins, so it ends abandoned.
    expect(await ended(w, next.lobby.id)).toBe("abandoned");
  });

  it("ends a match not played and unrated when a successor instance takes the slot, even after a later natural result, and the old instance never begins again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The countdown outlasts the old instance's 3 s poll, so one poll seats the lobby during its
    // countdown and a later one starts it; seating and starting in the same poll would leave the
    // seated state visible only while the begin is written.
    const w = world(5000);
    // Hold only the old instance's next ownership read while its real tick loop
    // finishes. A fixed polling phase is not reliable after a 120-second window.
    let holdOwnershipRead = false;
    let releaseOwnership!: () => void;
    const ownershipRead = new Promise<void>(resolve => { releaseOwnership = resolve; });
    const oldWorld = { ...w, lobbies: { ...w.lobbies, resolveSlot: async (slot: string) => {
      if (holdOwnershipRead) await ownershipRead;
      return w.lobbies.resolveSlot(slot);
    } } };
    const old = await slotServer(oldWorld, "public-0", "old", SHORT, 3000);
    const { lobby, keys } = await w.fill("public", 1, ["R1", "R2"]);
    const ann = await agentOn(old.server);
    // The instance seats the lobby at its next poll.
    await until(() => old.server.game.nextStart?.kind === "scheduled", 30_000);
    expect((await ann.call("join", { key: keys[0]!.key })).isError).toBe(false);
    await until(() => running(old.server), 30_000);

    holdOwnershipRead = true;
    let successor: Awaited<ReturnType<typeof slotServer>>;
    try {
      successor = await slotServer(w, "public-0", "new", LONG);
      expect(await w.lobbies.resolveSlot("public-0")).toMatchObject({ mcpUrl: "http://new.test/mcp" });
      expect(await ended(w, lobby.id)).toBe("not_played");
      expect(await ratedMatches(w, keys)).toEqual([0, 0]);
      await until(() => old.server.game.match!.result !== null);
    } finally {
      releaseOwnership();
    }
    // Once superseded the old process answers nothing and shuts down: its seat's
    // session is gone, and the successor tells the reconnecting seats the match was not played.
    await until(async () => (await fetch(`http://127.0.0.1:${old.server.port}/wake`).then(() => false, () => true)));
    await expect(ann.call("observe")).rejects.toThrow();
    expect(await ratedMatches(w, keys)).toEqual([0, 0]);
    const rejoin = await agentOn(successor!.server);
    const answer = await until(async () => {
      const reply = await rejoin.call("join", { key: keys[1]!.key });
      return reply.data.error?.code === "match_not_played" ? reply : undefined;
    });
    expect(answer.data).not.toHaveProperty("winner");
    expect(answer.data).not.toHaveProperty("result");

    // The next lobby plays on the successor; the superseded instance never begins another match.
    const next = await w.fill("public", 1, ["R3", "R4"]);
    expect(next.lobby.slot).toBe("public-0");
    expect(await w.lobbies.locate(next.lobby.id)).toEqual({ ok: true, value: { slot: "public-0", mcpUrl: "http://new.test/mcp", spectatorUrl: `https://antwars.ai/?lobby=${next.lobby.id}` } });
    await until(() => running(successor.server));
    await sleep(3500);
    expect(old.started).toHaveLength(1);
    expect(old.server.game.match!.seq).toBe(1);
  });

  it("frees the slot of a match that cannot start, unrated, and the waiting lobby takes the slot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    const impossible = { ...PUBLIC_CONFIG, foodLayout: { ...PUBLIC_CONFIG.foodLayout!, placementAttempts: 1, layoutAttempts: 1, minStartingFood: 1, maxStartingFood: 1 } };
    const { server, started } = await slotServer(w, "public-0", "a", impossible);
    const { lobby, keys } = await w.fill("public", 1, ["S1", "S2"]);
    const next = await w.fill("public", 1, ["S3", "S4"]);
    expect(await ended(w, lobby.id)).toBe("not_played");
    expect(await ratedMatches(w, keys)).toEqual([0, 0]);
    expect(started).toHaveLength(0);
    expect(server.game.match).toBeNull();
    // The waiting lobby took the slot (its countdown ran), and its own failed start frees it too.
    expect(await ended(w, next.lobby.id)).toBe("not_played");
    expect((await w.lobby(next.lobby.id)).startsAt).not.toBeNull();
    expect(await w.lobbies.slotHolder("public-0")).toBeNull();
    expect((await (await agentOn(server)).call("join", { key: next.keys[0]!.key })).data.error.code).toBe("match_not_played");
  });

  it("starts its match exactly once when the begin committed but its reply was lost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    const begin = w.lobbies.beginMatch.bind(w.lobbies);
    let lost = 0;
    vi.spyOn(w.lobbies, "beginMatch").mockImplementation(async (...args) => {
      const committed = await begin(...args);
      if (lost++ === 0) throw new Error("commit response lost");
      return committed;
    });
    const { server, started } = await slotServer(w, "public-0", "a");
    const { lobby } = await w.fill("public", 1, ["L1", "L2"]);
    await until(() => running(server));
    expect(lost).toBe(1);
    expect((await w.lobbies.slotHolder("public-0"))?.matchRunId).not.toBeNull();
    await sleep(300);
    expect(started).toHaveLength(1);
    expect((await w.lobby(lobby.id)).state).toBe("holding");
  });

  it("releases a match not played when its instance restarts mid-match, and the restarted instance plays the next lobby", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world();
    const first = await slotServer(w, "private-0", "a");
    const { lobby, keys } = await w.fill("private", 1, ["T1", "T2"]);
    await until(() => running(first.server));
    // close() publishes no result: the lobby still holds the slot until a restart records it.
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    expect((await w.lobby(lobby.id)).state).toBe("holding");
    const restarted = await slotServer(w, "private-0", "a");
    expect(await ended(w, lobby.id)).toBe("not_played");
    expect(await ratedMatches(w, keys)).toEqual([0, 0]);
    await w.fill("private", 1, ["T3", "T4"]);
    await until(() => running(restarted.server));
    // Its seated identities learn the outcome from the restarted instance too.
    const seat = await agentOn(restarted.server);
    const reply = await seat.call("join", { key: keys[0]!.key });
    expect(reply.data.error.code).toBe("match_not_played");
    expect(reply.data).not.toHaveProperty("winner");
  });

  it("plays a public and a private lobby assigned while no server ran, booted during the countdown, at the countdown's end and locatable before then", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const countdownMs = 4000;
    const w = world(countdownMs);
    const timings = slotTimings(w);
    const root = await rootServer(w);
    const filled = [await w.fill("public", 1, ["Early1", "Early2"]), await w.fill("private", 1, ["Early3", "Early4"])];
    for (const [n, { lobby }] of filled.entries()) {
      expect(lobby).toMatchObject({ state: "holding", slot: `${KINDS[n]}-0` });
      // No server has run on the slot: it is held, with no mcpUrl yet but already its antwars.ai page.
      expect(await w.lobbies.locate(lobby.id)).toEqual({ ok: true, value: { slot: lobby.slot, mcpUrl: null, spectatorUrl: `https://antwars.ai/?lobby=${lobby.id}` } });
    }
    // Boot with 2 s of the countdown left, so a fresh window from registration would end well after it.
    await sleep(Math.max(0, Math.min(...filled.map(({ lobby }) => lobby.startsAt!)) - 2000 - Date.now()));
    const played = await bootAndPlay(w, root, filled, timings);
    for (const [n, { lobby }] of filled.entries()) {
      const { matchStarts, registeredAt, begunAt, startedAt } = played[n]!;
      expect(registeredAt).toBeLessThan(lobby.startsAt!);
      expect(matchStarts).toBe(lobby.startsAt);
      expect(begunAt).toBeGreaterThanOrEqual(lobby.startsAt!);
      expect(begunAt).toBeLessThan(registeredAt + countdownMs);
      expect(startedAt).toBeGreaterThanOrEqual(lobby.startsAt!);
    }
  });

  it("gives a public and a private lobby whose countdown ended before its server booted a fresh 10-second join window from registration, then plays it, locatable before it begins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The lobbies' clock runs behind while they fill, so each countdown has ended when its server boots.
    let skew = -(COUNTDOWN_MS + 1000);
    const w = world(COUNTDOWN_MS, () => Date.now() + skew);
    const timings = slotTimings(w);
    const root = await rootServer(w);
    const filled = [await w.fill("public", 1, ["Late1", "Late2"]), await w.fill("private", 1, ["Late3", "Late4"])];
    skew = 0;
    for (const [n, { lobby }] of filled.entries()) {
      expect(lobby).toMatchObject({ state: "holding", slot: `${KINDS[n]}-0` });
      expect(lobby.startsAt).toBeLessThan(Date.now());
    }
    const played = await bootAndPlay(w, root, filled, timings);
    for (const { matchStarts, registeredAt, begunAt, startedAt } of played) {
      expect(matchStarts - registeredAt).toBeGreaterThanOrEqual(COUNTDOWN_MS);
      expect(matchStarts - registeredAt).toBeLessThan(COUNTDOWN_MS + 1000);
      expect(begunAt).toBeGreaterThanOrEqual(registeredAt + COUNTDOWN_MS);
      expect(startedAt).toBeGreaterThanOrEqual(registeredAt + COUNTDOWN_MS);
    }
  });
});

/** End-to-end seat metadata wiring, independent of emulator availability. */
describe("rated thinking levels and service tiers through a real slot server", () => {
  it.each([
    { name: "canonical seat joins after seat 2", joinFirst: true, level: "max", expected: "max", tier: "fast", expectedTier: "fast" },
    { name: "canonical seat omits its level", joinFirst: true, level: undefined, expected: null, tier: undefined, expectedTier: null },
    // A ranked seat that never joins abandons the match, unrated, so the seat joins late with no metadata instead.
    { name: "canonical seat reports no metadata", joinFirst: false, level: undefined, expected: null, tier: undefined, expectedTier: null },
  ])("$name", async ({ joinFirst, level, expected, tier, expectedTier }) => {
    const w = retentionWorld(Date.now());
    const a = value(await w.ids.claimUsername("LevelA")), b = value(await w.ids.claimUsername("LevelB"));
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 1000 });
    const ratings = createRatings(w.store, w.ids);
    const lobby = await w.store.transaction(async read => {
      const paired = await lobbies.queuedMatchWrites(read, { mode: "2v2", colonies: [
        [a.identity, a.identity], [b.identity, b.identity],
      ] }, Date.now());
      return { result: paired.lobby, writes: paired.writes };
    });
    const dataDir = tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: SHORT,
      mcpConfig: TEST_MCP_CONFIG, startPickWindowMs: 100,
      slot: { slot: lobby.slot!, publicUrl: "http://level-slot.test", lobbies, identities: w.ids, pollMs: 10 } });
    const clients: Agent[] = [];
    try {
      await until(() => server.game.nextStart?.kind === "scheduled");
      const join = async (key: string, seat: number, thinkingLevel?: string, serviceTier?: string, modelLabel?: string) => {
        const client = await connect(server.port); clients.push(client);
        const reply = await client.call("join", { key, seat, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(serviceTier === undefined ? {} : { serviceTier }),
          ...(modelLabel === undefined ? {} : { modelLabel }) });
        expect(reply.isError, reply.text).toBe(false);
      };
      // Invalid tiers are refused like invalid levels, before any seat is taken.
      const refusing = await connect(server.port); clients.push(refusing);
      for (const serviceTier of ["", "   ", "bell\u0007", "x".repeat(33)]) {
        const refused = await refusing.call("join", { key: a.key, seat: 1, serviceTier });
        expect(refused.isError).toBe(true);
        expect(refused.data.error.code).toBe("bad_service_tier");
        expect(refused.data.error.howToFix).toContain("1 to 32 printable characters");
      }
      // Join order must not select the Index level: seat 2 always arrives first.
      // Seat 2's model label is never the identity's: only seat 1's reaches the rating row.
      await join(a.key, 2, "low", "standard", "lab/seat-two");
      await join(b.key, 2, "medium", "fast", "lab/seat-two");
      if (joinFirst) await join(a.key, 1, level, tier, "lab/model-a");
      await join(b.key, 1, "high", "standard", "lab/model-b");
      // Last, well inside the idle limit, and reporting no level, tier or model label.
      if (!joinFirst) await join(a.key, 1);
      if (joinFirst) await join(a.key, 1, "xhigh", "standard", "lab/rewrite"); // reconnect cannot rewrite accepted seat metadata
      await until(async () => value(await lobbies.readLobby(lobby.id)).state === "ended", 10_000);
      const entries = value(await ratings.leaderboard({ mode: "2v2" })).entries;
      expect(entries).toHaveLength(2);
      expect(entries.find(entry => entry.identityId === a.identity.id)?.thinkingLevel).toBe(expected);
      expect(entries.find(entry => entry.identityId === b.identity.id)?.thinkingLevel).toBe("high");
      expect(entries.find(entry => entry.identityId === a.identity.id)?.serviceTier).toBe(expectedTier);
      expect(entries.find(entry => entry.identityId === b.identity.id)?.serviceTier).toBe("standard");
      // Stored on the rating row only, never served on the leaderboard; "" when seat 1 reported none.
      expect(w.docs.get(`${ratingCollection("2v2")}/${a.identity.id}`)?.modelLabel).toBe(joinFirst ? "lab/model-a" : "");
      expect(w.docs.get(`${ratingCollection("2v2")}/${b.identity.id}`)?.modelLabel).toBe("lab/model-b");
      for (const entry of entries) expect(entry).not.toHaveProperty("modelLabel");
      const changes = await ratings.readMatchChanges(lobby.id);
      expect(changes).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.ratedMatches).toBe(1);
        expect(changes!.find(change => change.identityId === entry.identityId)).toEqual({
          // Rated results record the Glicko deviation; the first rated result starts from 350.
          identityId: entry.identityId, before: 1500, after: entry.rating, rdBefore: 350, rdAfter: FIRST_WIN.rd,
        });
      }
      expect(await ratings.readRating(a.identity.id, "1v1")).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    } finally {
      for (const client of clients) await client.close();
      await server.close(); rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});

/** Only a match slot limits how many sessions one client source evicts at the session cap. */
describe("per-source initialize limit wiring", () => {
  // Documentation address (RFC 5737), as the last X-Forwarded-For hop.
  const initializeFrom = async (port: number) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "192.0.2.20" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } }),
    });
    await res.text();
    return res.status;
  };
  const mcpConfig = { ...TEST_MCP_CONFIG, maxOpenSessions: 3, maxProtectedSessions: 1 };
  const evictions = TEST_MCP_CONFIG.initializeBurstPerSource;

  it("a slot server refuses one source 429 once its allowance is spent", async () => {
    const w = retentionWorld(Date.now());
    const lobbies = createLobbies(w.store, w.ids, { countdownMs: 1000 });
    const dataDir = tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: LONG, mcpConfig,
      slot: { slot: "public-1", publicUrl: "http://limit-slot.test", lobbies, identities: w.ids, pollMs: 10 } });
    try {
      for (let i = 0; i < mcpConfig.maxOpenSessions + evictions; i += 1) expect(await initializeFrom(server.port)).toBe(200);
      expect(await initializeFrom(server.port)).toBe(429);
    } finally {
      await server.close(); rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("the entry service does not limit a source", async () => {
    const dataDir = tempDir();
    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir, simConfig: LONG, mcpConfig });
    try {
      for (let i = 0; i < mcpConfig.maxOpenSessions + 2 * evictions; i += 1) expect(await initializeFrom(server.port)).toBe(200);
    } finally {
      await server.close(); rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
