import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { HOUSE_SIZE, houseCast } from "./house-fixtures.ts";

/**
 * In a house 2v2, 3v3 or 4v4 match each paired handle holds every seat of
 * its own colony, as in the public team modes.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

let counter = 0;

function value<T>(outcome: LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** Each colony as the list of identity ids in its seats. */
const seating = (lobby: Lobby) => lobby.colonies.map((colony) => colony.map((seat) => seat.id));

describe.skipIf(!host)("house team-size seating", { timeout: 120_000 }, () => {
  it("seats each paired house handle on every seat of its own colony at house 2v2, 3v3 and 4v4, as the public team modes do", async () => {
    const namespace = `hs${process.pid}-${Date.now().toString(36)}-${counter++}`;
    const store = createFirestore({ projectId, namespace, emulatorHost: host });
    const clock = { t: Date.UTC(2026, 9, 23, 12, 0, 0) };
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { publicSlots: 8, privateSlots: 1, now: () => clock.t });
    const cast = await houseCast(identities, store, 2);
    const [first, second] = cast.houseHandles;

    for (const mode of ["house-2v2", "house-3v3", "house-4v4"] as const) {
      const size = HOUSE_SIZE[mode];
      const publicMode = mode.slice("house-".length);
      value(await lobbies.joinQueue(first!.key, mode));
      const matched = value(await lobbies.joinQueue(second!.key, mode)) as { state: string; lobbyId: string };
      expect(matched.state).toBe("matched");
      const lobby = value(await lobbies.readLobby(matched.lobbyId));
      expect(lobby).toMatchObject({ kind: "public", size, mode, rated: true });
      const colonies = seating(lobby);
      // Each colony is full and held by one handle; the two colonies' handles are the pair.
      for (const colony of colonies) {
        expect(colony).toHaveLength(size);
        expect(new Set(colony).size).toBe(1);
      }
      expect(new Set(colonies.map((colony) => colony[0]))).toEqual(new Set([first!.id, second!.id]));
      for (const colony of lobby.colonies) {
        for (const seat of colony) {
          const handle = seat.id === first!.id ? first! : second!;
          expect(seat.displayName).toBe(handle.displayName);
        }
      }
      // The match server sees the same seating.
      const holder = await lobbies.slotHolder(lobby.slot!);
      expect(holder?.colonies.map((colony) => colony.map((seat) => seat.id))).toEqual(colonies);
      expect(holder?.mode).toBe(mode);

      // The public team mode of the same size seats a different-owner pair the same way.
      value(await lobbies.joinQueue(cast.rival.key, publicMode));
      const publicMatched = value(await lobbies.joinQueue(first!.key, publicMode)) as { state: string; lobbyId: string };
      expect(publicMatched.state).toBe("matched");
      const publicLobby = value(await lobbies.readLobby(publicMatched.lobbyId));
      expect(publicLobby).toMatchObject({ kind: "public", size, mode: publicMode, rated: true });
      expect((await lobbies.slotHolder(publicLobby.slot!))?.mode).toBe(publicMode);
      const publicColonies = seating(publicLobby);
      for (const colony of publicColonies) {
        expect(colony).toHaveLength(size);
        expect(new Set(colony).size).toBe(1);
      }
      expect(new Set(publicColonies.map((colony) => colony[0]))).toEqual(new Set([cast.rival.id, first!.id]));
      clock.t += 1_000;
    }
  });
});
