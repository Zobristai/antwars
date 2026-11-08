import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIdentities, type Identity, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings, RANKED_MODES, type Rating } from "../../src/rating/ratings.ts";
import { createFirestore, type Write } from "../../src/store/firestore.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

let counter = 0;
const freshNamespace = () => `t${process.pid}-${Date.now().toString(36)}-${counter++}`;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

function world() {
  const store = createFirestore({ projectId, namespace: freshNamespace(), emulatorHost: host });
  const clock = { t: Date.UTC(2026, 9, 23, 8, 0, 0) };
  const ids = createIdentities(store);
  return {
    store, clock,
    lobbies: createLobbies(store, ids, { now: () => clock.t }),
    ratings: createRatings(store),
    keyFor: async (name: string) => value(await ids.claimUsername(name)),
  };
}

/**
 * A queue-made team-mode lobby holding public-0, as the queue pairing stores it
 * (the queued-match interface: queuedMatchWrites
 * and the lobby `mode` field): public, rated "true", its mode set, and each agent's
 * seat repeated once per seat of its own colony.
 */
async function seedTeamMatch(w: ReturnType<typeof world>, mode: string, size: number, agents: readonly [Identity, Identity]) {
  const id = randomUUID();
  const seats = agents.flatMap((agent, colony) => Array.from({ length: size }, () => ({ id: agent.id, displayName: agent.displayName, colony })));
  const lobby: Write = {
    op: "create", path: `lobbies/${id}`, fields: {
      kind: "public", size: String(size), creatorId: agents[0].id, createdAt: String(w.clock.t), state: "holding",
      rated: "true", slot: "public-0", seats: JSON.stringify(seats), inviteVerifier: "",
      startsAt: String(w.clock.t), matchRunId: "", outcome: "", mode,
    },
  };
  const slot: Write = { op: "create", path: "slots/public-0", fields: { lobbyId: id } };
  await w.store.transaction<null>(async () => ({ result: null, writes: [lobby, slot] }));
  return id;
}

describe.skipIf(!host)("team-mode rated result against the Firestore emulator", { timeout: 60_000 }, () => {
  it.each([["2v2", 2], ["3v3", 3], ["4v4", 4]] as const)(
    "rates a %s natural result once per agent, in that mode only, though each agent holds every seat of its colony",
    async (mode, size) => {
      const w = world();
      const keys = await Promise.all(["Ada", "Bea"].map(w.keyFor));
      const agents = [keys[0]!.identity, keys[1]!.identity] as const;
      const others = RANKED_MODES.filter((other) => other !== mode);

      // Earlier results in every other mode, so an unchanged rating there is observable.
      for (const other of others) {
        await w.ratings.applyResult({ matchId: `earlier-${other}`, mode: other, teams: [[agents[0].id], [agents[1].id]], winner: "a" });
      }
      const before = new Map<string, Rating>();
      for (const other of others) for (const agent of agents) before.set(`${other}/${agent.id}`, await w.ratings.readRating(agent.id, other));

      await w.lobbies.registerInstance("public-0", { runId: "p", mcpUrl: "http://p.test/mcp", spectatorUrl: "http://p.test/" });
      const lobbyId = await seedTeamMatch(w, mode, size, agents);
      const lobby = value(await w.lobbies.readLobby(lobbyId));
      expect(lobby).toMatchObject({ size, state: "holding", rated: true, slot: "public-0" });
      expect(lobby.colonies.map((seats) => seats.map((seat) => seat.id))).toEqual([Array(size).fill(agents[0].id), Array(size).fill(agents[1].id)]);

      value(await w.lobbies.beginMatch(lobbyId, "public-0", "p"));
      value(await w.lobbies.endMatch(lobbyId, "p", "colony_0_won"));
      expect(value(await w.lobbies.readLobby(lobbyId))).toMatchObject({ state: "ended", outcome: "colony_0_won" });

      // That mode moves once per agent: team Elo with one identity per side, one rated match each.
      expect(await w.ratings.readRating(agents[0].id, mode)).toEqual({ ...FIRST_WIN, ratedMatches: 1 });
      expect(await w.ratings.readRating(agents[1].id, mode)).toEqual({ ...FIRST_LOSS, ratedMatches: 1 });
      expect(await w.ratings.readMatchChanges(lobbyId)).toEqual([
        { identityId: agents[0].id, before: 1500, after: FIRST_WIN.rating, rdBefore: 350, rdAfter: FIRST_WIN.rd },
        { identityId: agents[1].id, before: 1500, after: FIRST_LOSS.rating, rdBefore: 350, rdAfter: FIRST_LOSS.rd },
      ]);
      // Every other mode is unchanged.
      for (const other of others) {
        for (const agent of agents) expect(await w.ratings.readRating(agent.id, other)).toEqual(before.get(`${other}/${agent.id}`));
      }
    },
  );
});
