/// <reference types="node" />
// The quadrants queue mode at the lobby layer: four distinct owners make one public lobby of four one-seat colonies,
// the mode is refused while its map rotation holds no quadrant map, the lobby stores its four fixed colony names, and its
// release stores the result and rates it only when enabled. Run on an in-memory store and on the Firestore emulator.
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type MatchOutcome, type MatchResult } from "../../src/lobby/lobbies.ts";
import { newWaitToken } from "../../src/lobby/waits.ts";
import { applyFfaResult } from "../../src/rating/ffa.ts";
import { createRatings, RANKED_MODES, ratingCollection } from "../../src/rating/ratings.ts";
import { COLONY_NAMES, rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { fourColonyEnd } from "../../src/sim/elimination.ts";
import { newMatchMaps, quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { validateQuadrantMap } from "../../src/sim/quadrantMap.ts";
import { createFirestore, type Fields, type Store, type Write } from "../../src/store/firestore.ts";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
    centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
  },
};
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const INSTANCE = { mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" };

/** Sequential transactions; a create of an existing document fails, as Firestore's does. */
function memoryStore(): Store {
  const docs = new Map<string, Fields>();
  return {
    namespace: "quadrants-queue-test",
    async get(path) { return docs.get(path) ?? null; },
    async transaction(step) {
      const next = await step(async paths => new Map(paths.map(path => [path, docs.get(path) ?? null])));
      for (const write of next.writes) {
        if (write.op === "delete") docs.delete(write.path);
        else {
          if ((write.op === "create") === docs.has(write.path)) throw new Error(`unexpected ${write.op}: ${write.path}`);
          docs.set(write.path, { ...docs.get(write.path), ...write.fields });
        }
      }
      return next.result;
    },
    async query() { throw new Error("the memory store does not query collections"); },
  };
}

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

type Backend = "memory" | "Firestore emulator";
let counter = 0;

/** quadrantMaps: the rotation the lobbies serve, or "shipped" for the default (quadrantMatchMaps()). */
function world(backend: Backend, quadrantMaps: readonly MapDefinition[] | "shipped" = [FIXTURE], ffaLiveEnabled = false) {
  const clock = { t: Date.UTC(2026, 10, 14, 9, 0, 0) };
  const store = backend === "memory" ? memoryStore()
    : createFirestore({ projectId, namespace: `quad${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, {
    publicSlots: 1, privateSlots: 1, ffaLiveEnabled, now: () => clock.t, random: () => 0, ...(quadrantMaps === "shipped" ? {} : { quadrantMaps }),
  });
  const ratings = createRatings(store);
  const claim = async (name: string) => {
    const issued = value(await identities.claimUsername(name));
    return { id: issued.identity.id, key: issued.key };
  };
  const handle = async (owner: { key: string }, name: string) => {
    const issued = value(await identities.createHandle(owner.key, name));
    return { id: issued.identity.id, key: issued.key };
  };
  const raw = (path: string) => store.get(path);
  return { clock, store, lobbies, ratings, claim, handle, raw };
}
type World = ReturnType<typeof world>;

/** Four distinct owners queued in quadrants, the fourth joining last; returns the lobby id. */
async function quadrantsLobby(w: World, prefix: string): Promise<{ lobbyId: string; ids: string[] }> {
  const players = [];
  for (const n of [0, 1, 2, 3]) players.push(await w.claim(`${prefix}${n}`));
  for (const player of players.slice(0, 3)) expect(value(await w.lobbies.joinQueue(player.key, "quadrants")).state).toBe("waiting");
  const matched = value(await w.lobbies.joinQueue(players[3]!.key, "quadrants"));
  if (matched.state !== "matched") throw new Error(`expected matched, got ${matched.state}`);
  return { lobbyId: matched.lobbyId, ids: players.map(player => player.id) };
}

/** Begins the lobby's match as run on public-0 and releases it with the outcome (and result). */
async function playAndRelease(w: World, lobbyId: string, run: string, outcome: MatchOutcome, result?: MatchResult) {
  await w.lobbies.registerInstance("public-0", { runId: run, ...INSTANCE });
  value(await w.lobbies.beginMatch(lobbyId, "public-0", run));
  value(await w.lobbies.endMatch(lobbyId, run, outcome, undefined, undefined, undefined, undefined, result));
}

for (const backend of ["memory", "Firestore emulator"] as const) {
  describe.skipIf(backend === "Firestore emulator" && !host)(`the quadrants queue (${backend})`, { timeout: 120_000 }, () => {
    it("groups four distinct owners into one public, unrated lobby of four one-seat colonies only on the fourth join", async () => {
      const w = world(backend);
      const players = [];
      for (const name of ["ann", "bob", "cat", "dan"]) players.push({ ...(await w.claim(name)), token: newWaitToken() });
      for (const player of players.slice(0, 3)) {
        const waiting = value(await w.lobbies.joinQueue(player.key, "quadrants", player.token));
        expect(waiting).toMatchObject({ state: "waiting", mode: "quadrants" });
        expect(await w.lobbies.waitStatus(player.token)).toMatchObject({ state: "waiting", mode: "quadrants" });
      }
      const joiner = players[3]!;
      const matched = value(await w.lobbies.joinQueue(joiner.key, "quadrants", joiner.token));
      if (matched.state !== "matched") throw new Error(`expected matched, got ${matched.state}`);
      const lobby = value(await w.lobbies.readLobby(matched.lobbyId));
      expect(lobby).toMatchObject({ kind: "public", size: 1, rated: false, mode: "quadrants" });
      expect(lobby.colonies.map(colony => colony.length)).toEqual([1, 1, 1, 1]);
      // Partners take colonies 0-2 and the joiner colony 3.
      expect(lobby.colonies[3]!.map(seat => seat.id)).toEqual([joiner.id]);
      expect(lobby.colonies.slice(0, 3).flat().map(seat => seat.id).sort()).toEqual(players.slice(0, 3).map(player => player.id).sort());
      for (const player of players) {
        expect(value(await w.lobbies.queueStatus(player.key))).toMatchObject({ state: "matched", mode: "quadrants", lobbyId: matched.lobbyId });
        expect(await w.lobbies.waitStatus(player.token)).toMatchObject({ state: "paired", lobbyId: matched.lobbyId });
      }
      expect((await w.raw("queueWaiting/quadrants"))?.entries ?? "").toBe("");
    });

    it("waits until three others of distinct owners wait: two waiting handles of one owner count once, as does the joiner's own owner", async () => {
      const w = world(backend);
      const owner = await w.claim("owner");
      const sibling = await w.handle(owner, "sibling");
      const bob = await w.claim("bob");
      for (const player of [owner, sibling, bob]) expect(value(await w.lobbies.joinQueue(player.key, "quadrants")).state).toBe("waiting");
      // Three waiting, but only two distinct owners: the fourth distinct owner still waits.
      const cat = await w.claim("cat");
      expect(value(await w.lobbies.joinQueue(cat.key, "quadrants")).state).toBe("waiting");
      // A joiner sharing an owner with a waiting entry adds no distinct owner either.
      const catHandle = await w.handle(cat, "kitten");
      expect(value(await w.lobbies.joinQueue(catHandle.key, "quadrants")).state).toBe("waiting");
      // A fifth distinct owner completes the lobby, holding just one of the owner's two entries.
      const dan = await w.claim("dan");
      const matched = value(await w.lobbies.joinQueue(dan.key, "quadrants"));
      if (matched.state !== "matched") throw new Error(`expected matched, got ${matched.state}`);
      const seated = value(await w.lobbies.readLobby(matched.lobbyId)).colonies.flat().map(seat => seat.id);
      expect(seated).toHaveLength(4);
      expect(seated.filter(id => id === owner.id || id === sibling.id)).toHaveLength(1);
      expect(seated.filter(id => id === cat.id || id === catHandle.id)).toHaveLength(1);
      expect(seated).toContain(bob.id);
      expect(seated[3]).toBe(dan.id);
      const left = [owner, sibling, cat, catHandle].filter(player => !seated.includes(player.id));
      for (const player of left) expect(value(await w.lobbies.queueStatus(player.key)).state).toBe("waiting");
    });

    it("refuses a second join already_queued, in quadrants or any other mode, and a builder with a live challenge live_challenge", async () => {
      const w = world(backend);
      const ann = await w.claim("ann");
      value(await w.lobbies.joinQueue(ann.key, "quadrants"));
      expect(await w.lobbies.joinQueue(ann.key, "quadrants")).toEqual({ ok: false, reason: "already_queued" });
      expect(await w.lobbies.joinQueue(ann.key, "1v1")).toEqual({ ok: false, reason: "already_queued" });
      const bob = await w.claim("bob");
      value(await w.lobbies.joinQueue(bob.key, "1v1"));
      expect(await w.lobbies.joinQueue(bob.key, "quadrants")).toEqual({ ok: false, reason: "already_queued" });

      // A live challenge: the builder's latest request names a lobby still open.
      const builder = await w.claim("builder"), host1 = await w.claim("host1");
      const { lobby } = value(await w.lobbies.createLobby(host1.key, "public", 1));
      await w.store.transaction(async () => ({ result: null, writes: <Write[]>[
        { op: "create", path: `challengeChallengers/${builder.id}`, fields: { requestId: "request-1" } },
        { op: "create", path: "challengeRequests/request-1", fields: { lobbyId: lobby.id } },
      ] }));
      const token = newWaitToken();
      expect(await w.lobbies.joinQueue(builder.key, "quadrants", token)).toEqual({ ok: false, reason: "live_challenge" });
      expect([await w.raw(`queueEntries/${builder.id}`), await w.raw(`waits/${token}`)]).toEqual([null, null]);
    });

    it("refuses quadrants no_quadrant_map, writing nothing, while its rotation is empty or holds a two-colony map; other modes still join", async () => {
      expect(quadrantMatchMaps().every(map => map.quadrant !== undefined)).toBe(true);
      validateQuadrantMap(FIXTURE);
      for (const rotation of [[], [...newMatchMaps(), FIXTURE]] as const) {
        const w = world(backend, rotation);
        const ann = await w.claim("ann");
        const token = newWaitToken();
        expect(await w.lobbies.joinQueue(ann.key, "quadrants", token)).toEqual({ ok: false, reason: "no_quadrant_map" });
        expect([await w.raw(`queueEntries/${ann.id}`), await w.raw(`waits/${token}`), await w.raw("queueWaiting/quadrants")]).toEqual([null, null, null]);
        expect(await w.lobbies.joinQueue(ann.key, "nonsense")).toEqual({ ok: false, reason: "invalid_mode" });
        expect(value(await w.lobbies.joinQueue(ann.key, "1v1")).state).toBe("waiting");
      }
      // A quadrant-only rotation admits the join.
      const w = world(backend, [FIXTURE]);
      expect(value(await w.lobbies.joinQueue((await w.claim("ann")).key, "quadrants")).state).toBe("waiting");
    });

    it("admits a quadrants join on the shipped pool, Four Coves, Crossroads and Strait", async () => {
      expect(quadrantMatchMaps().map(map => map.id)).toEqual(["four-coves", "crossroads", "strait"]);
      const w = world(backend, "shipped");
      expect(value(await w.lobbies.joinQueue((await w.claim("ann")).key, "quadrants")).state).toBe("waiting");
    });

    it("names the four colonies by colony number on the lobby document, and a begin or adoption naming other names leaves them", async () => {
      const w = world(backend);
      const { lobbyId } = await quadrantsLobby(w, "n");
      expect(JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.colonyNames!)).toEqual(NAMES);
      expect(value(await w.lobbies.readLobby(lobbyId)).colonyNames).toEqual(NAMES);
      await w.lobbies.registerInstance("public-0", { runId: "run-1", ...INSTANCE });
      value(await w.lobbies.beginMatch(lobbyId, "public-0", "run-1", COLONY_NAMES));
      await w.lobbies.registerInstance("public-0", { runId: "run-2", ...INSTANCE });
      value(await w.lobbies.adoptMatch(lobbyId, "public-0", "run-2", "run-1", ["Sweetwater Colony", "Lake Skinner Colony"]));
      expect(JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.colonyNames!)).toEqual(NAMES);
      expect(value(await w.lobbies.readLobby(lobbyId)).colonyNames).toEqual(NAMES);
    });

    it("reads a quadrants lobby's names from its document, not from the current name table", async () => {
      const w = world(backend);
      const { lobbyId } = await quadrantsLobby(w, "s");
      // Names a document recorded under an earlier table, in another order, read back as stored.
      const recorded = ["Sweetwater Colony", "Earlier Colony", "Very Large Colony", "Lake Hodges Colony"];
      await w.store.transaction(async () => ({ result: null, writes: <Write[]>[
        { op: "update", path: `lobbies/${lobbyId}`, fields: { colonyNames: JSON.stringify(recorded) } },
      ] }));
      expect(value(await w.lobbies.readLobby(lobbyId)).colonyNames).toEqual(recorded);
      // A stored value that is not four names reads as the table's four.
      await w.store.transaction(async () => ({ result: null, writes: <Write[]>[
        { op: "update", path: `lobbies/${lobbyId}`, fields: { colonyNames: JSON.stringify(["One Colony", "Two Colony"]) } },
      ] }));
      expect(value(await w.lobbies.readLobby(lobbyId)).colonyNames).toEqual(NAMES);
    });

    it("leaves a public Free-for-all unrated with rating disabled, while a ranked 1v1 still rates", async () => {
      const w = world(backend);
      const { lobbyId, ids } = await quadrantsLobby(w, "q");
      expect(value(await w.lobbies.readLobby(lobbyId)).rated).toBe(false);
      await playAndRelease(w, lobbyId, "run-1", "colony_0_won", { reason: "time_up", eliminations: [],
        ffa: { version: 1, order: [0, 2, 1, 3], territoryWinnerFirst: false, rateable: true } });
      expect(await w.raw(`ffaMatches/${lobbyId}`)).toBeNull();
      for (const id of ids) expect(await w.raw(`ratings-ffa/${id}`)).toBeNull();
      const doc = (await w.raw(`lobbies/${lobbyId}`))!;
      expect(doc).toMatchObject({ state: "ended", outcome: "colony_0_won", rated: "false" });
      expect(await w.raw(`ratedMatches/${lobbyId}`)).toBeNull();
      for (const id of ids) {
        for (const mode of RANKED_MODES) {
          expect(await w.raw(`${ratingCollection(mode)}/${id}`)).toBeNull();
          expect((await w.ratings.readRating(id, mode)).ratedMatches).toBe(0);
        }
      }
      if (backend === "Firestore emulator") {
        for (const mode of RANKED_MODES) {
          const board = await w.ratings.leaderboard({ mode });
          // A house mode's board may be unavailable here; one that answers lists none of the four.
          if (!board.ok && board.reason === "house_unavailable" && mode.startsWith("house-")) continue;
          expect(value(board).entries.map(entry => entry.identityId).filter(id => ids.includes(id))).toEqual([]);
        }
      }

      // The rated control: a 1v1 pairing released colony_0_won rates both seats.
      const [red, blue] = [await w.claim("red"), await w.claim("blue")];
      value(await w.lobbies.joinQueue(red.key, "1v1"));
      const paired = value(await w.lobbies.joinQueue(blue.key, "1v1"));
      if (paired.state !== "matched") throw new Error(`expected matched, got ${paired.state}`);
      await playAndRelease(w, paired.lobbyId, "run-2", "colony_0_won");
      expect(await w.raw(`ratedMatches/${paired.lobbyId}`)).not.toBeNull();
      for (const player of [red, blue]) expect((await w.ratings.readRating(player.id, "1v1")).ratedMatches).toBe(1);
    });

    it.each(["winner", "time_up", "queens_killed"] as const)("releases a public queue Free-for-all %s with the rating gate on, saving finish metadata and isolated ratings once", async ending => {
      const w = world(backend, [FIXTURE], true);
      const { lobbyId, ids } = await quadrantsLobby(w, "enabled");
      expect(value(await w.lobbies.readLobby(lobbyId)).rated).toBe(true);
      const before = (await w.raw(`lobbies/${lobbyId}`))!;
      const seats = JSON.parse(before.seats!) as { id: string; colony: number }[];
      let result: MatchResult = { reason: "time_up", eliminations: [{ colony: 1, tick: 50 }],
        ffa: { version: 1, order: [2, 0, 3, 1], territoryWinnerFirst: false, rateable: true } };
      const outcome: MatchOutcome = ending === "winner" ? "colony_2_won" : "draw";
      if (ending !== "winner") {
        const base = newMatchConfig(rulesConfig("redesign"));
        const state = createMatch(404, { ...base, ffaTerritoryWinnerFirst: false,
          terrain: { ...base.terrain!, maps: [FIXTURE] } });
        if (ending === "queens_killed") for (const c of state.colonies) for (const q of c.queens!) q.lostTick = 10;
        const natural = fourColonyEnd(state, 10, ending === "time_up")!;
        expect(natural).toMatchObject({ winner: null, decidedBy: "draw", reason: ending,
          ffa: { order: [0, 1, 2, 3], rateable: true } });
        result = { ...natural, eliminations: state.colonies.flatMap(c => c.eliminated === undefined
          ? [] : [{ colony: c.id, tick: c.eliminated.tick }]) };
      }
      const finish = result.ffa!;
      await w.lobbies.registerInstance("public-0", { runId: "rated-run", ...INSTANCE });
      value(await w.lobbies.beginMatch(lobbyId, "public-0", "rated-run"));
      expect((await w.raw("slots/public-0"))?.lobbyId).toBe(lobbyId);
      expect(value(await w.lobbies.endMatch(lobbyId, "rated-run", outcome, undefined, undefined, undefined, undefined, result))).toEqual({ next: null });
      const ended = (await w.raw(`lobbies/${lobbyId}`))!;
      expect(ended).toMatchObject({ state: "ended", slot: "", outcome, rated: "true" });
      expect(JSON.parse(ended.result!)).toEqual(result);
      expect(await w.raw("slots/public-0")).toBeNull();
      const history = (await w.raw(`ffaMatches/${lobbyId}`))!;
      expect(JSON.parse(history.input!).finish).toEqual(finish);
      const changes = JSON.parse(history.changes!) as { identityId: string; place: number; after: { mu: number; sigma: number } }[];
      expect(changes).toHaveLength(4);
      const stored = new Map<string, Fields>();
      for (const seat of seats) {
        const fields = (await w.raw(`ratings-ffa/${seat.id}`))!;
        expect(fields.ratedMatches).toBe("1");
        expect(changes.find(change => change.identityId === seat.id)).toEqual({
          identityId: seat.id, place: finish.order.findIndex(colony => colony === seat.colony) + 1,
          before: { mu: 25, sigma: 25 / 3 }, after: { mu: Number(fields.mu), sigma: Number(fields.sigma) },
        });
        stored.set(seat.id, fields);
      }
      for (const id of ids) for (const mode of RANKED_MODES) expect(await w.raw(`${ratingCollection(mode)}/${id}`)).toBeNull();
      expect(await w.raw(`ratedMatches/${lobbyId}`)).toBeNull();
      expect(await w.lobbies.endMatch(lobbyId, "rated-run", outcome, undefined, undefined, undefined, undefined, result)).toEqual({ ok: false, reason: "not_holding" });
      expect(await w.raw(`ffaMatches/${lobbyId}`)).toEqual(history);
      expect(await w.raw(`lobbies/${lobbyId}`)).toEqual(ended);
      for (const [id, fields] of stored) expect(await w.raw(`ratings-ffa/${id}`)).toEqual(fields);
    });

    it("stores the four colonies, their names, a colony 2 or 3 winner or a draw, the reason and each elimination tick on release", async () => {
      const w = world(backend);
      const releases: [MatchOutcome, MatchResult][] = [
        ["colony_2_won", { reason: "elimination", eliminations: [{ colony: 0, tick: 120 }, { colony: 3, tick: 300 }, { colony: 1, tick: 410 }] }],
        ["colony_3_won", { reason: "elimination", eliminations: [{ colony: 1, tick: 90 }, { colony: 0, tick: 200 }, { colony: 2, tick: 205 }] }],
        ["draw", { reason: "time_limit", eliminations: [{ colony: 2, tick: 50 }] }],
      ];
      for (const [index, [outcome, result]] of releases.entries()) {
        const { lobbyId, ids } = await quadrantsLobby(w, `r${index}-`);
        await playAndRelease(w, lobbyId, `run-${index}`, outcome, result);
        const doc = (await w.raw(`lobbies/${lobbyId}`))!;
        const seats = JSON.parse(doc.seats!) as { id: string; colony: number }[];
        expect(seats.map(seat => seat.colony).sort()).toEqual([0, 1, 2, 3]);
        expect(seats.map(seat => seat.id).sort()).toEqual([...ids].sort());
        expect(JSON.parse(doc.colonyNames!)).toEqual(NAMES);
        expect(doc.outcome).toBe(outcome);
        expect(JSON.parse(doc.result!)).toEqual(result);
        expect(value(await w.lobbies.readLobby(lobbyId))).toMatchObject({ state: "ended", outcome });
      }
      // A rated lobby stores no result, even when given one.
      const [red, blue] = [await w.claim("red"), await w.claim("blue")];
      value(await w.lobbies.joinQueue(red.key, "1v1"));
      const paired = value(await w.lobbies.joinQueue(blue.key, "1v1"));
      if (paired.state !== "matched") throw new Error(`expected matched, got ${paired.state}`);
      await playAndRelease(w, paired.lobbyId, "run-rated", "colony_1_won", releases[0]![1]);
      expect((await w.raw(`lobbies/${paired.lobbyId}`))!.result).toBeUndefined();
    });

    it("lists quadrants entries and unstarted quadrants lobbies in the Waiting view's lists beside the ranked ones", async () => {
      const w = world(backend);
      const { lobbyId, ids } = await quadrantsLobby(w, "u");
      const lobby = value(await w.lobbies.readLobby(lobbyId));
      expect(lobby.state).toBe("holding");
      expect(lobby.colonies.map(colony => colony.length)).toEqual([1, 1, 1, 1]);
      expect(lobby.colonies.flat().map(seat => seat.id).sort()).toEqual([...ids].sort());
      w.clock.t += 1_000;
      const ann = await w.claim("ann");
      value(await w.lobbies.joinQueue(ann.key, "quadrants"));
      w.clock.t += 1_000;
      const solo = await w.claim("solo");
      value(await w.lobbies.joinQueue(solo.key, "1v1"));
      expect((await w.lobbies.listWaiting()).map(agent => [agent.identityId, agent.mode])).toEqual([[ann.id, "quadrants"], [solo.id, "1v1"]]);
      expect(await w.lobbies.listUnstarted()).toEqual([{
        mode: "quadrants", size: 1, createdAt: lobby.createdAt, seated: 4,
        // Each colony's one seat as the lobby holds it, in its colony.
        colonies: lobby.colonies.map(colony => colony.map(seat => ({ id: seat.id, displayName: seat.displayName, seats: 1 }))),
        colonyNames: NAMES,
      }]);
    });
  });
}

for (const enabled of [false, true]) for (const rated of [false, true]) for (const outcome of ["colony_2_won", "draw", "abandoned"] as const) {
  it(`keeps Free-for-all rating behind both gates and natural outcomes (enabled=${enabled}, rated=${rated}, outcome=${outcome})`, async () => {
    const shouldRate = enabled && rated && outcome !== "abandoned";
    const w = world("memory");
    const { lobbyId, ids } = await quadrantsLobby(w, "gate");
    const gated = createLobbies(w.store, createIdentities(w.store), { ffaLiveEnabled: enabled, now: () => w.clock.t });
    if (rated) await w.store.transaction(async () => ({ result: null, writes: [{ op: "update", path: `lobbies/${lobbyId}`, fields: { rated: "true" } }] }));
    const finish = { version: 1 as const, order: [2, 0, 3, 1] as const, territoryWinnerFirst: false, rateable: true };
    const result = { reason: "time_up", eliminations: [], ffa: finish };
    await gated.registerInstance("public-0", { runId: "run", ...INSTANCE });
    value(await gated.beginMatch(lobbyId, "public-0", "run"));
    value(await gated.endMatch(lobbyId, "run", outcome, undefined, undefined, undefined, undefined, result));
    expect(JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.result!)).toEqual(result);
    for (const id of ids) {
      expect((await w.raw(`ratings-ffa/${id}`))?.ratedMatches).toBe(shouldRate ? "1" : undefined);
      for (const mode of RANKED_MODES) expect(await w.raw(`${ratingCollection(mode)}/${id}`)).toBeNull();
    }
    expect(await w.raw(`ratedMatches/${lobbyId}`)).toBeNull();
    expect((await w.raw(`ffaMatches/${lobbyId}`)) !== null).toBe(shouldRate);
  });
}

it("an enabled gate still preserves historical results with no order and never routes them to Glicko", async () => {
  const w = world("memory");
  const { lobbyId, ids } = await quadrantsLobby(w, "legacy");
  const gated = createLobbies(w.store, createIdentities(w.store), { ffaLiveEnabled: true, now: () => w.clock.t });
  await w.store.transaction(async () => ({ result: null, writes: [{ op: "update", path: `lobbies/${lobbyId}`, fields: { rated: "true" } }] }));
  await gated.registerInstance("public-0", { runId: "run", ...INSTANCE });
  value(await gated.beginMatch(lobbyId, "public-0", "run"));
  const historical = { reason: "time_up", eliminations: [] };
  value(await gated.endMatch(lobbyId, "run", "colony_0_won", undefined, undefined, undefined, undefined, historical));
  expect(JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.result!)).toEqual(historical);
  for (const id of ids) expect(await w.raw(`ratings-ffa/${id}`)).toBeNull();
  expect(await w.raw(`ratedMatches/${lobbyId}`)).toBeNull();
});

describe("a refused Free-for-all rating write", () => {
  const FINISH = { version: 1 as const, order: [2, 0, 3, 1] as const, territoryWinnerFirst: false, rateable: true };
  const RESULT: MatchResult = { reason: "time_up", eliminations: [], ffa: FINISH };

  /** A rated quadrants lobby begun on public-0 under the enabled gate, with its colony-ordered participants. */
  async function ratedBegun(w: World, prefix: string, store: Store = w.store) {
    const { lobbyId, ids } = await quadrantsLobby(w, prefix);
    await w.store.transaction(async () => ({ result: null, writes: [{ op: "update", path: `lobbies/${lobbyId}`, fields: { rated: "true" } }] }));
    const gated = createLobbies(store, createIdentities(store), { publicSlots: 1, privateSlots: 1, ffaLiveEnabled: true, now: () => w.clock.t });
    await gated.registerInstance("public-0", { runId: "run", ...INSTANCE });
    value(await gated.beginMatch(lobbyId, "public-0", "run"));
    const seats = JSON.parse((await w.raw(`lobbies/${lobbyId}`))!.seats!) as { id: string; colony: number }[];
    const participants = [0, 1, 2, 3].map(colony => seats.find(seat => seat.colony === colony)!.id);
    return { lobbyId, ids, gated, participants };
  }

  /** Every Free-for-all and ranked rating document of ids, and the history of the given matches. */
  async function ratingDocs(w: World, ids: readonly string[], matches: readonly string[]) {
    const paths = [...ids.flatMap(id => [`ratings-ffa/${id}`, ...RANKED_MODES.map(mode => `${ratingCollection(mode)}/${id}`)]),
      ...matches.flatMap(id => [`ffaMatches/${id}`, `ratedMatches/${id}`])];
    return new Map(await Promise.all(paths.map(async path => [path, await w.raw(path)] as const)));
  }

  it("releases the slot and leaves the match unrated with the failure recorded when a stored rating is invalid", async () => {
    const w = world("memory");
    // An earlier, already-rated Free-for-all match whose history and ratings must not move.
    const earlier = await ratedBegun(w, "early");
    value(await earlier.gated.endMatch(earlier.lobbyId, "run", "draw", undefined, undefined, undefined, undefined, RESULT));
    const { lobbyId, ids, gated } = await ratedBegun(w, "bad");
    await w.store.transaction(async () => ({ result: null, writes: [{ op: "create", path: `ratings-ffa/${ids[0]}`,
      fields: { mu: "25", sigma: "8", ratedMatches: "3", estimator: "another-estimator" } }] }));
    const before = await ratingDocs(w, [...earlier.ids, ...ids], [earlier.lobbyId, lobbyId]);
    expect(value(await gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT))).toEqual({ next: null });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect(await w.raw(`lobbies/${lobbyId}`)).toMatchObject({ state: "ended", slot: "", outcome: "colony_2_won", rated: "false",
      ratingFailure: "invalid stored Free-for-all rating" });
    expect(await w.raw(`ffaMatches/${lobbyId}`)).toBeNull();
    expect(await ratingDocs(w, [...earlier.ids, ...ids], [earlier.lobbyId, lobbyId])).toEqual(before);
    // Released once: a repeat is refused as no longer holding, and the freed slot takes the next match.
    expect(await gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT)).toEqual({ ok: false, reason: "not_holding" });
    const next = await quadrantsLobby(w, "next");
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(next.lobbyId);
  });

  it("refuses a match already rated with another result the same way, keeping that rating's history", async () => {
    const w = world("memory");
    const { lobbyId, ids, gated, participants } = await ratedBegun(w, "conflict");
    await applyFfaResult(w.store, { matchId: lobbyId, participants, reason: "time_up", finish: { ...FINISH, order: [0, 1, 2, 3] as const } });
    const before = await ratingDocs(w, ids, [lobbyId]);
    value(await gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT));
    expect(await w.raw("slots/public-0")).toBeNull();
    expect(await w.raw(`lobbies/${lobbyId}`)).toMatchObject({ state: "ended", rated: "false",
      ratingFailure: "Free-for-all match was already rated with another result" });
    expect(await ratingDocs(w, ids, [lobbyId])).toEqual(before);
  });

  it("releases a match already rated with the same result as rated, recording no failure and rating nothing twice", async () => {
    const w = world("memory");
    const { lobbyId, ids, gated, participants } = await ratedBegun(w, "same");
    await applyFfaResult(w.store, { matchId: lobbyId, participants, reason: "time_up", finish: FINISH });
    const before = await ratingDocs(w, ids, [lobbyId]);
    value(await gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT));
    expect(await w.raw("slots/public-0")).toBeNull();
    const ended = (await w.raw(`lobbies/${lobbyId}`))!;
    expect(ended).toMatchObject({ state: "ended", rated: "true" });
    expect(ended.ratingFailure).toBeUndefined();
    expect(await ratingDocs(w, ids, [lobbyId])).toEqual(before);
  });

  it("keeps the slot held and retries when the rating step's store read fails, then rates the match once", async () => {
    const w = world("memory");
    let failNext = false;
    // The shared store, except that the next transactional read of a Free-for-all rating fails as a store error.
    const flaky: Store = { ...w.store, transaction: step => w.store.transaction(read => step(async paths => {
      if (failNext && paths.some(path => path.startsWith("ratings-ffa/"))) {
        failNext = false;
        throw new Error("store unavailable");
      }
      return read(paths);
    })) };
    const { lobbyId, ids, gated } = await ratedBegun(w, "flaky", flaky);
    failNext = true;
    await expect(gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT)).rejects.toThrow("store unavailable");
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(lobbyId);
    expect(await w.raw(`lobbies/${lobbyId}`)).toMatchObject({ state: "holding", rated: "true" });
    expect(await w.raw(`ffaMatches/${lobbyId}`)).toBeNull();
    value(await gated.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, RESULT));
    expect(await w.raw("slots/public-0")).toBeNull();
    const ended = (await w.raw(`lobbies/${lobbyId}`))!;
    expect(ended).toMatchObject({ state: "ended", rated: "true" });
    expect(ended.ratingFailure).toBeUndefined();
    for (const id of ids) expect((await w.raw(`ratings-ffa/${id}`))?.ratedMatches).toBe("1");
  });
});

describe("a malformed Free-for-all finish", () => {
  const VALID_FINISH = { version: 1 as const, order: [2, 0, 3, 1] as const, territoryWinnerFirst: false, rateable: true };
  const VALID_RESULT: MatchResult = { reason: "time_up", eliminations: [], ffa: VALID_FINISH };
  const MALFORMED_RESULT: MatchResult = {
    reason: "time_up",
    eliminations: [],
    ffa: { version: 1, order: [0, 1, 2, 2], territoryWinnerFirst: false, rateable: true } as unknown as NonNullable<MatchResult["ffa"]>,
  };

  /** A quadrants lobby begun on public-0 (unrated by default, or rated under ffaLiveEnabled). */
  async function begun(w: World, prefix: string, options: { readonly rated?: boolean; readonly store?: Store } = {}) {
    const { lobbyId, ids } = await quadrantsLobby(w, prefix);
    if (options.rated) {
      await w.store.transaction(async () => ({ result: null, writes: [{ op: "update", path: `lobbies/${lobbyId}`, fields: { rated: "true" } }] }));
    }
    const lobbies = createLobbies(options.store ?? w.store, createIdentities(options.store ?? w.store),
      { publicSlots: 1, privateSlots: 1, ffaLiveEnabled: options.rated === true, now: () => w.clock.t });
    await lobbies.registerInstance("public-0", { runId: "run", ...INSTANCE });
    value(await lobbies.beginMatch(lobbyId, "public-0", "run"));
    return { lobbyId, ids, lobbies };
  }

  /** Every Free-for-all and ranked rating document of ids, and the history of the given matches. */
  async function ratingDocs(w: World, ids: readonly string[], matches: readonly string[]) {
    const paths = [...ids.flatMap(id => [`ratings-ffa/${id}`, ...RANKED_MODES.map(mode => `${ratingCollection(mode)}/${id}`)]),
      ...matches.flatMap(id => [`ffaMatches/${id}`, `ratedMatches/${id}`])];
    return new Map(await Promise.all(paths.map(async path => [path, await w.raw(path)] as const)));
  }

  it("releases the slot, hands it to a waiting lobby, omits result and records resultFailure on an unrated match", async () => {
    const w = world("memory");
    const { lobbyId, lobbies } = await begun(w, "unrated-bad");
    const waiting = await quadrantsLobby(w, "waiting");
    expect((await w.raw(`lobbies/${waiting.lobbyId}`))?.state).toBe("waiting");
    expect(value(await lobbies.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, MALFORMED_RESULT)))
      .toEqual({ next: waiting.lobbyId });
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(waiting.lobbyId);
    const ended = (await w.raw(`lobbies/${lobbyId}`))!;
    expect(ended).toMatchObject({ state: "ended", slot: "", outcome: "colony_2_won", rated: "false", resultFailure: "invalid Free-for-all finish" });
    expect(ended.result).toBeUndefined();
    expect(ended.ratingFailure).toBeUndefined();
    // Released once: a repeat is refused as not_holding without disturbing the successor.
    expect(await lobbies.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, MALFORMED_RESULT))
      .toEqual({ ok: false, reason: "not_holding" });
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(waiting.lobbyId);
  });

  it("releases the slot unrated with resultFailure and writes no ratings on a rated match, keeping earlier ratings intact", async () => {
    const w = world("memory");
    const earlier = await begun(w, "early", { rated: true });
    value(await earlier.lobbies.endMatch(earlier.lobbyId, "run", "draw", undefined, undefined, undefined, undefined, VALID_RESULT));
    const { lobbyId, ids, lobbies } = await begun(w, "rated-bad", { rated: true });
    const before = await ratingDocs(w, [...earlier.ids, ...ids], [earlier.lobbyId, lobbyId]);
    expect(value(await lobbies.endMatch(lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, MALFORMED_RESULT)))
      .toEqual({ next: null });
    expect(await w.raw("slots/public-0")).toBeNull();
    const ended = (await w.raw(`lobbies/${lobbyId}`))!;
    expect(ended).toMatchObject({ state: "ended", slot: "", outcome: "colony_2_won", rated: "false", resultFailure: "invalid Free-for-all finish" });
    expect(ended.result).toBeUndefined();
    expect(ended.ratingFailure).toBeUndefined();
    expect(await w.raw(`ffaMatches/${lobbyId}`)).toBeNull();
    expect(await ratingDocs(w, [...earlier.ids, ...ids], [earlier.lobbyId, lobbyId])).toEqual(before);
    const next = await quadrantsLobby(w, "next");
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(next.lobbyId);
  });

  it("keeps the slot held and retries when a store read fails during release, for both malformed and well-formed finishes", async () => {
    const w = world("memory");
    let failNext = false;
    const flaky: Store = { ...w.store, transaction: step => w.store.transaction(read => step(async paths => {
      if (failNext && paths.includes("queues/public")) {
        failNext = false;
        throw new Error("store unavailable");
      }
      return read(paths);
    })) };

    const bad = await begun(w, "flaky-bad", { store: flaky });
    failNext = true;
    await expect(bad.lobbies.endMatch(bad.lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, MALFORMED_RESULT))
      .rejects.toThrow("store unavailable");
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(bad.lobbyId);
    expect((await w.raw(`lobbies/${bad.lobbyId}`))?.state).toBe("holding");
    expect((await w.raw(`lobbies/${bad.lobbyId}`))?.resultFailure).toBeUndefined();
    value(await bad.lobbies.endMatch(bad.lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, MALFORMED_RESULT));
    expect(await w.raw("slots/public-0")).toBeNull();
    const badEnded = (await w.raw(`lobbies/${bad.lobbyId}`))!;
    expect(badEnded).toMatchObject({ state: "ended", rated: "false", resultFailure: "invalid Free-for-all finish" });
    expect(badEnded.result).toBeUndefined();

    const good = await begun(w, "flaky-good", { rated: true, store: flaky });
    failNext = true;
    await expect(good.lobbies.endMatch(good.lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, VALID_RESULT))
      .rejects.toThrow("store unavailable");
    expect((await w.raw("slots/public-0"))?.lobbyId).toBe(good.lobbyId);
    expect((await w.raw(`lobbies/${good.lobbyId}`))?.state).toBe("holding");
    expect(await w.raw(`ffaMatches/${good.lobbyId}`)).toBeNull();
    value(await good.lobbies.endMatch(good.lobbyId, "run", "colony_2_won", undefined, undefined, undefined, undefined, VALID_RESULT));
    expect(await w.raw("slots/public-0")).toBeNull();
    const goodEnded = (await w.raw(`lobbies/${good.lobbyId}`))!;
    expect(goodEnded).toMatchObject({ state: "ended", rated: "true" });
    expect(goodEnded.resultFailure).toBeUndefined();
    expect(goodEnded.ratingFailure).toBeUndefined();
    expect(JSON.parse(goodEnded.result!)).toEqual(VALID_RESULT);
    for (const id of good.ids) expect((await w.raw(`ratings-ffa/${id}`))?.ratedMatches).toBe("1");
  });
});
