import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createFirestore, type Store } from "../../src/store/firestore.ts";
import { HOUSE_MODES, houseCast, HOUSE_QUEUE_TTL_MS, type Keyed } from "./house-fixtures.ts";

/**
 * House mode in the ranked queue, against the store: only handles of the
 * antwars username may join house-1v1 to house-4v4; two waiting house handles of
 * one size are paired with each other, at random among that size's waiting house
 * entries, never across sizes or with public entries; an unpaired house entry
 * expires after 15 minutes, while a builder-mode entry lasts 12 hours.
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

/** One namespace with a test clock and an injectable pairing pick. */
async function world(pick: () => number = Math.random) {
  const namespace = `hq${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const clock = { t: Date.UTC(2026, 9, 23, 12, 0, 0) };
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 8, privateSlots: 1, now: () => clock.t, random: pick });
  const cast = await houseCast(identities, store, 6);
  return { store, clock, lobbies, ...cast };
}

/** Lobby documents in the namespace, queue-made or not. */
async function lobbyCount(store: Store): Promise<number> {
  return (await store.query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: 100 })).rows.length;
}

const seatIds = (colony: readonly { readonly id: string }[]) => colony.map((seat) => seat.id);

describe.skipIf(!host)("house mode in the ranked queue", { timeout: 120_000 }, () => {
  it("admits only handles of the antwars username to house mode at every size and refuses every other identity", async () => {
    const w = await world();
    const handle = w.houseHandles[0]!;
    const refused: Keyed[] = [w.house, w.rival, w.rivalHandle, ...w.lookalikes];
    expect(w.lookalikes.map((identity) => identity.displayName)).toEqual(["antwars/mimic", "antwars/lookalike"]);

    for (const mode of HOUSE_MODES) {
      const joinedAt = w.clock.t;
      expect(value(await w.lobbies.joinQueue(handle.key, mode))).toEqual({ state: "waiting", mode, joinedAt, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS });
      expect(value(await w.lobbies.queueStatus(handle.key))).toEqual({ state: "waiting", mode, joinedAt, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS });
      expect(value(await w.lobbies.leaveQueue(handle.key))).toEqual({ state: "none" });

      for (const identity of refused) {
        expect(await w.lobbies.joinQueue(identity.key, mode), `${identity.displayName} in ${mode}`).toEqual({ ok: false, reason: "not_house" });
        expect(value(await w.lobbies.queueStatus(identity.key))).toEqual({ state: "none" });
      }
      w.clock.t += 1_000;
    }
  });

  it("pairs two waiting house handles of one size with each other at every size", async () => {
    const w = await world();
    for (const [n, mode] of HOUSE_MODES.entries()) {
      // Only a waiting entry blocks a join, so the fourth size reuses matched handles.
      const [first, second] = [w.houseHandles[2 * (n % 3)]!, w.houseHandles[2 * (n % 3) + 1]!];
      expect(value(await w.lobbies.joinQueue(first.key, mode))).toMatchObject({ state: "waiting", mode });
      const matched = value(await w.lobbies.joinQueue(second.key, mode));
      expect(matched).toMatchObject({ state: "matched", mode, matchedAt: w.clock.t });
      const lobbyId = (matched as { lobbyId: string }).lobbyId;
      for (const handle of [first, second]) {
        expect(value(await w.lobbies.queueStatus(handle.key))).toEqual({ state: "matched", mode, lobbyId, matchedAt: w.clock.t });
      }
      const lobby = value(await w.lobbies.readLobby(lobbyId));
      expect(lobby).toMatchObject({ kind: "public", mode, rated: true });
      expect(new Set(lobby.colonies.flatMap(seatIds))).toEqual(new Set([first.id, second.id]));
      w.clock.t += 1_000;
    }
  });

  it("picks the partner at random among the waiting house entries of that size", async () => {
    // The pick indexes the eligible waiting entries, oldest first: 0 takes the
    // oldest, just under 1 takes the newest, so a fixed first-candidate choice fails.
    for (const [pick, expectedIndex] of [[0, 0], [0.5, 1], [0.999999, 2]] as const) {
      const w = await world(() => pick);
      const [a, b, c, joiner] = w.houseHandles;
      const joinedAt = w.clock.t;
      // House handles share one owner, so they never wait together unless placed
      // there; three are stored waiting, oldest first, as the queue records them.
      await w.store.transaction(async () => ({
        result: null,
        writes: [
          ...[a!, b!, c!].map((handle) => ({
            op: "create" as const, path: `queueEntries/${handle.id}`,
            fields: { mode: "house-2v2", joinedAt: String(joinedAt), state: "waiting", lobbyId: "" },
          })),
          { op: "create" as const, path: "queueWaiting/house-2v2", fields: { entries: [a!, b!, c!].map((handle) => handle.id).join(" ") } },
        ],
      }));
      w.clock.t += 1_000;
      const matched = value(await w.lobbies.joinQueue(joiner!.key, "house-2v2"));
      expect(matched).toMatchObject({ state: "matched", mode: "house-2v2" });
      const lobby = value(await w.lobbies.readLobby((matched as { lobbyId: string }).lobbyId));
      const partners = lobby.colonies.flatMap(seatIds).filter((id) => id !== joiner!.id);
      expect(new Set(partners).size).toBe(1);
      const partner = partners[0]!;
      expect(partner).toBe([a!.id, b!.id, c!.id][expectedIndex]);
      // The other two stay waiting.
      for (const handle of [a!, b!, c!].filter((handle) => handle.id !== partner)) {
        expect(value(await w.lobbies.queueStatus(handle.key))).toEqual({ state: "waiting", mode: "house-2v2", joinedAt, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS });
      }
    }
  });

  it("never pairs house entries across sizes or with public entries", async () => {
    const w = await world();
    const [h0, h1, h2, h3, h4, h5] = w.houseHandles;
    // One waiting house entry at each of three sizes, and public entries waiting in 1v1 and 2v2.
    expect(value(await w.lobbies.joinQueue(h0!.key, "house-1v1"))).toMatchObject({ state: "waiting" });
    expect(value(await w.lobbies.joinQueue(h1!.key, "house-2v2"))).toMatchObject({ state: "waiting" });
    expect(value(await w.lobbies.joinQueue(h2!.key, "house-3v3"))).toMatchObject({ state: "waiting" });
    expect(value(await w.lobbies.joinQueue(w.rival.key, "1v1"))).toMatchObject({ state: "waiting" });
    expect(value(await w.lobbies.joinQueue(w.rivalHandle.key, "2v2"))).toMatchObject({ state: "waiting" });
    // A house handle waiting in house-4v4 meets none of them.
    expect(value(await w.lobbies.joinQueue(h3!.key, "house-4v4"))).toMatchObject({ state: "waiting", mode: "house-4v4" });
    for (const [handle, mode] of [[h0, "house-1v1"], [h1, "house-2v2"], [h2, "house-3v3"], [w.rival, "1v1"], [w.rivalHandle, "2v2"]] as const) {
      expect(value(await w.lobbies.queueStatus(handle!.key))).toMatchObject({ state: "waiting", mode });
    }
    // House-1v1 pairs within house-1v1 only, never with the public 1v1 entry.
    const matched = value(await w.lobbies.joinQueue(h4!.key, "house-1v1"));
    expect(matched).toMatchObject({ state: "matched", mode: "house-1v1" });
    const lobby = value(await w.lobbies.readLobby((matched as { lobbyId: string }).lobbyId));
    expect(new Set(lobby.colonies.flatMap(seatIds))).toEqual(new Set([h0!.id, h4!.id]));
    expect(value(await w.lobbies.queueStatus(w.rival.key))).toMatchObject({ state: "waiting", mode: "1v1" });
    // A public 2v2 join does not take the waiting house-2v2 entry.
    const rival2 = await w.lobbies.queueStatus(w.rivalHandle.key);
    expect(value(rival2)).toMatchObject({ state: "waiting", mode: "2v2" });
    expect(value(await w.lobbies.queueStatus(h1!.key))).toMatchObject({ state: "waiting", mode: "house-2v2" });
    // House-3v3 pairs with its own size, leaving house-2v2 and house-4v4 waiting.
    expect(value(await w.lobbies.joinQueue(h5!.key, "house-3v3"))).toMatchObject({ state: "matched", mode: "house-3v3" });
    expect(value(await w.lobbies.queueStatus(h2!.key))).toMatchObject({ state: "matched", mode: "house-3v3" });
    expect(value(await w.lobbies.queueStatus(h1!.key))).toMatchObject({ state: "waiting", mode: "house-2v2" });
    expect(value(await w.lobbies.queueStatus(h3!.key))).toMatchObject({ state: "waiting", mode: "house-4v4" });
  });

  it("expires an unpaired house entry 15 minutes after it joined, with no lobby, and lets it join again", async () => {
    const w = await world();
    for (const mode of HOUSE_MODES) {
      const [handle, later] = [w.houseHandles[0]!, w.houseHandles[1]!];
      const joinedAt = w.clock.t;
      const lobbiesBefore = await lobbyCount(w.store);
      expect(value(await w.lobbies.joinQueue(handle.key, mode))).toEqual({ state: "waiting", mode, joinedAt, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS });
      w.clock.t = joinedAt + HOUSE_QUEUE_TTL_MS - 1;
      expect(value(await w.lobbies.queueStatus(handle.key))).toMatchObject({ state: "waiting", mode });
      w.clock.t = joinedAt + HOUSE_QUEUE_TTL_MS;
      expect(value(await w.lobbies.queueStatus(handle.key))).toEqual({ state: "expired", mode, expiresAt: joinedAt + HOUSE_QUEUE_TTL_MS });
      // The expired entry is never paired: a later house handle of that size waits,
      // and expiry created no lobby.
      expect(value(await w.lobbies.joinQueue(later.key, mode))).toMatchObject({ state: "waiting", mode });
      expect(await lobbyCount(w.store)).toBe(lobbiesBefore);
      // The expired handle can join again, and is then paired with the waiting one.
      expect(value(await w.lobbies.joinQueue(handle.key, mode))).toMatchObject({ state: "matched", mode });
      expect(await lobbyCount(w.store)).toBe(lobbiesBefore + 1);
      w.clock.t += HOUSE_QUEUE_TTL_MS;
    }
  });

  it("expires a house-mode entry at 15 minutes while a builder entry joined at the same time waits 12 hours", async () => {
    const w = await world();
    const handle = w.houseHandles[0]!;
    const joinedAt = w.clock.t;
    expect(value(await w.lobbies.joinQueue(handle.key, "house-1v1"))).toEqual({ state: "waiting", mode: "house-1v1", joinedAt, expiresAt: joinedAt + 15 * 60 * 1000 });
    expect(value(await w.lobbies.joinQueue(w.rival.key, "1v1"))).toEqual({ state: "waiting", mode: "1v1", joinedAt, expiresAt: joinedAt + 12 * 60 * 60 * 1000 });

    w.clock.t = joinedAt + 15 * 60 * 1000 - 1;
    expect(value(await w.lobbies.queueStatus(handle.key))).toMatchObject({ state: "waiting", mode: "house-1v1" });
    expect((await w.lobbies.listWaiting()).map((row) => row.mode).sort()).toEqual(["1v1", "house-1v1"]);
    w.clock.t = joinedAt + 15 * 60 * 1000;
    expect(value(await w.lobbies.queueStatus(handle.key))).toEqual({ state: "expired", mode: "house-1v1", expiresAt: joinedAt + 15 * 60 * 1000 });
    expect(value(await w.lobbies.queueStatus(w.rival.key))).toMatchObject({ state: "waiting", mode: "1v1" });
    // The Waiting card's liveness follows the same rule.
    expect((await w.lobbies.listWaiting()).map((row) => row.mode)).toEqual(["1v1"]);

    w.clock.t = joinedAt + 12 * 60 * 60 * 1000 - 1;
    expect(value(await w.lobbies.queueStatus(w.rival.key))).toEqual({ state: "waiting", mode: "1v1", joinedAt, expiresAt: joinedAt + 12 * 60 * 60 * 1000 });
    w.clock.t = joinedAt + 12 * 60 * 60 * 1000;
    expect(value(await w.lobbies.queueStatus(w.rival.key))).toEqual({ state: "expired", mode: "1v1", expiresAt: joinedAt + 12 * 60 * 60 * 1000 });
    expect(await w.lobbies.listWaiting()).toEqual([]);
  });
});
