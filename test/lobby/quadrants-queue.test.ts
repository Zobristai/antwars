/// <reference types="node" />
// The quadrants queue mode at the lobby layer: four distinct owners make one unrated lobby of four one-seat colonies,
// the mode is refused while its map rotation holds no quadrant map, the lobby stores its four fixed colony names, and its
// release stores the result and rates nothing. Run on an in-memory store and on the Firestore emulator.
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type MatchOutcome, type MatchResult } from "../../src/lobby/lobbies.ts";
import { newWaitToken } from "../../src/lobby/waits.ts";
import { createRatings, RANKED_MODES, ratingCollection } from "../../src/rating/ratings.ts";
import { COLONY_NAMES, type MapDefinition } from "../../src/sim/config.ts";
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
function world(backend: Backend, quadrantMaps: readonly MapDefinition[] | "shipped" = [FIXTURE]) {
  const clock = { t: Date.UTC(2026, 10, 14, 9, 0, 0) };
  const store = backend === "memory" ? memoryStore()
    : createFirestore({ projectId, namespace: `quad${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, {
    publicSlots: 1, privateSlots: 1, now: () => clock.t, random: () => 0, ...(quadrantMaps === "shipped" ? {} : { quadrantMaps }),
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

    it("rates nothing for a quadrants release with an outcome a rated lobby rates, while a rated 1v1 released the same way is rated", async () => {
      const w = world(backend);
      const { lobbyId, ids } = await quadrantsLobby(w, "q");
      await playAndRelease(w, lobbyId, "run-1", "colony_0_won");
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

    it("leaves quadrants entries and lobbies out of the Waiting view's lists, keeping the ranked ones", async () => {
      const w = world(backend);
      const { lobbyId } = await quadrantsLobby(w, "u");
      expect(value(await w.lobbies.readLobby(lobbyId)).state).toBe("holding");
      const ann = await w.claim("ann");
      value(await w.lobbies.joinQueue(ann.key, "quadrants"));
      const solo = await w.claim("solo");
      value(await w.lobbies.joinQueue(solo.key, "1v1"));
      expect((await w.lobbies.listWaiting()).map(agent => [agent.identityId, agent.mode])).toEqual([[solo.id, "1v1"]]);
      expect(await w.lobbies.listUnstarted()).toEqual([]);
    });
  });
}
