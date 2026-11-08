import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { glickoUpdate } from "../../src/rating/glicko.ts";
import { createRatings, type Rating, type RankedMode } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";
import { createFirestore } from "../../src/store/firestore.ts";

/**
 * House match rating: a house-mode match is a queue-made
 * public lobby on the public slot, and its natural result moves only that house
 * size's ratings. Runs inside `firebase emulators:exec --only firestore`, which
 * sets FIRESTORE_EMULATOR_HOST; skipped only when the variable is unset.
 */
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

const PUBLIC_MODES = ["1v1", "2v2", "3v3", "4v4"] as const satisfies readonly RankedMode[];
const HOUSE_MODES = [["house-1v1", 1], ["house-2v2", 2], ["house-3v3", 3], ["house-4v4", 4]] as const satisfies readonly (readonly [RankedMode, number])[];
const EVERY_MODE: readonly RankedMode[] = [...PUBLIC_MODES, ...HOUSE_MODES.map(([mode]) => mode)];

let counter = 0;
const freshNamespace = () => `house-match-${process.pid}-${Date.now().toString(36)}-${counter++}`;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

describe.skipIf(!host)("house-mode match rating and slot", () => {
  it.each(HOUSE_MODES)("%s: a public lobby on the public slot whose natural result moves only that house size's ratings, once", async (mode, size) => {
    const store = createFirestore({ projectId, namespace: freshNamespace(), emulatorHost: host });
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 0 });
    const ratings = createRatings(store);

    // Two handles of the antwars username: the house agents.
    const house = value(await identities.claimUsername("antwars"));
    const red = value(await identities.createHandle(house.key, "red")).identity;
    const blue = value(await identities.createHandle(house.key, "blue")).identity;

    // A rating in every mode, house and public, so "unchanged" is measured against
    // a recorded rating rather than the 1500 default.
    for (const seeded of EVERY_MODE) {
      expect((await ratings.applyResult({ matchId: `seed-${seeded}`, teams: [[red.id], [blue.id]], winner: "a", mode: seeded })).status).toBe("applied");
    }
    const snapshot = async () => new Map(await Promise.all(EVERY_MODE.map(async (each) =>
      [each, { red: await ratings.readRating(red.id, each), blue: await ratings.readRating(blue.id, each) }] as const)));
    const before = await snapshot();

    // The queue's pairing for this size: each handle holds every seat of its colony.
    const colonies = [Array.from({ length: size }, () => ({ id: red.id, displayName: red.displayName })),
      Array.from({ length: size }, () => ({ id: blue.id, displayName: blue.displayName }))] as const;
    const lobby = await store.transaction<Lobby>(async (read) => {
      const made = await lobbies.queuedMatchWrites(read, { mode, colonies }, Date.now());
      return { result: made.lobby, writes: made.writes };
    });
    const stored = value(await lobbies.readLobby(lobby.id));
    for (const view of [lobby, stored]) {
      expect(view).toMatchObject({ kind: "public", mode, rated: true, state: "holding", slot: "public-0", size });
      expect(view.colonies.map((colony) => colony.map((seat) => seat.id))).toEqual([colonies[0].map(() => red.id), colonies[1].map(() => blue.id)]);
    }

    const runId = "house-run";
    await lobbies.registerInstance("public-0", { runId, mcpUrl: "http://127.0.0.1:9001/mcp", spectatorUrl: "http://127.0.0.1:9001/" });
    value(await lobbies.beginMatch(lobby.id, "public-0", runId));
    value(await lobbies.endMatch(lobby.id, runId, "colony_0_won"));
    // A repeated ending is refused and rates nothing again.
    expect(await lobbies.endMatch(lobby.id, runId, "colony_0_won")).toEqual({ ok: false, reason: "not_holding" });

    const after = await snapshot();
    // Glicko-1 for one identity per side: colony 0 (red) won. Seeded moments ago, so RD growth is far below the tolerance.
    const moved = (own: Rating, opponent: Rating, score: number): Rating =>
      ({ ...glickoUpdate(own, [{ rating: opponent.rating, rd: opponent.rd, score }]), ratedMatches: own.ratedMatches + 1 });
    for (const each of EVERY_MODE) {
      const prior = before.get(each)!;
      if (each === mode) {
        const now = after.get(each)!;
        for (const [actual, expected] of [[now.red, moved(prior.red, prior.blue, 1)], [now.blue, moved(prior.blue, prior.red, 0)]] as const) {
          expect(actual.rating).toBeCloseTo(expected.rating, 6);
          expect(actual.rd).toBeCloseTo(expected.rd, 6);
          expect(actual.ratedMatches).toBe(expected.ratedMatches);
        }
        expect(now.red.rating).toBeGreaterThan(prior.red.rating);
      } else {
        expect(after.get(each), `${each} after a ${mode} result`).toEqual(prior);
      }
    }
    // One change per handle, whatever the number of seats it held.
    const changes = await ratings.readMatchChanges(lobby.id);
    expect(changes?.map((change) => change.identityId).sort()).toEqual([red.id, blue.id].sort());
  }, 120_000);
});

describe("abandoned house outcomes without a rating transaction", () => {
  it.each(HOUSE_MODES)("%s records abandoned/unrated and leaves every rating unchanged", async (mode, size) => {
    const { store, docs } = memoryWatchStore();
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { countdownMs: 0 });
    const ratings = createRatings(store);
    const owner = value(await identities.claimUsername("antwars"));
    const red = value(await identities.createHandle(owner.key, "red")).identity;
    const blue = value(await identities.createHandle(owner.key, "blue")).identity;
    for (const seeded of EVERY_MODE) await ratings.applyResult({ matchId: "seed-" + seeded, teams: [[red.id], [blue.id]], winner: "a", mode: seeded });
    const snapshot = () => [...docs].filter(([path]) => path.startsWith("ratings") || path.startsWith("ratingResults"));
    const before = structuredClone(snapshot());
    const colonies = [Array.from({ length: size }, () => ({ id: red.id, displayName: red.displayName })),
      Array.from({ length: size }, () => ({ id: blue.id, displayName: blue.displayName }))] as const;
    const lobby = await store.transaction<Lobby>(async read => {
      const made = await lobbies.queuedMatchWrites(read, { mode, colonies }, Date.now());
      return { result: made.lobby, writes: made.writes };
    });
    await lobbies.registerInstance("public-0", { runId: "idle-run", mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test" });
    value(await lobbies.beginMatch(lobby.id, "public-0", "idle-run"));
    value(await lobbies.endMatch(lobby.id, "idle-run", "abandoned"));
    expect(value(await lobbies.readLobby(lobby.id))).toMatchObject({ state: "ended", outcome: "abandoned", rated: false });
    expect(snapshot()).toEqual(before);
    expect(await ratings.readMatchChanges(lobby.id)).toBeNull();
  });
});
