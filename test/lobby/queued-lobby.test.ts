import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { COUNTDOWN_MS, createLobbies, LOBBY_TTL_MS, type Lobby, type LobbyOutcome, type Seat } from "../../src/lobby/lobbies.ts";
import { createRatings, type RankedMode } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

let counter = 0;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** One namespace, one public slot, a test clock; queue-made lobbies are made as the queue makes them. */
function world() {
  const store = createFirestore({ projectId, namespace: `q${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const clock = { t: Date.UTC(2026, 9, 23, 8, 0, 0) };
  const ids = createIdentities(store);
  const lobbies = createLobbies(store, ids, { now: () => clock.t });
  const keyFor = async (name: string) => value(await ids.claimUsername(name));
  const seat = (key: { identity: { id: string; displayName: string } }): Seat => ({ id: key.identity.id, displayName: key.identity.displayName });
  // A pairing's transaction, on the store createLobbies was given.
  const queued = (colonies: readonly [readonly Seat[], readonly Seat[]], mode: RankedMode = "1v1") => store.transaction<Lobby>(async (read) => {
    const made = await lobbies.queuedMatchWrites(read, { mode, colonies }, clock.t);
    return { result: made.lobby, writes: made.writes };
  });
  return { clock, lobbies, keyFor, seat, queued, raw: (path: string) => store.get(path), ratings: createRatings(store) };
}

const instance = { runId: "run", mcpUrl: "http://q.test/mcp", spectatorUrl: "http://q.test/" };

describe.skipIf(!host)("queue-made ranked lobbies against the Firestore emulator", { timeout: 60_000 }, () => {
  it("waits for a free public slot without expiring, then starts when the slot frees", async () => {
    const w = world();
    const [ann, bob, cal, dee, eve, fay] = await Promise.all(["Ann", "Bob", "Cal", "Dee", "Eve", "Fay"].map(w.keyFor));
    // A player-created match holds the only public slot; a player-created lobby queues behind it.
    const { lobby: running } = value(await w.lobbies.createLobby(ann!.key, "public", 1));
    value(await w.lobbies.join(running.id, ann!.key));
    expect(value(await w.lobbies.join(running.id, bob!.key))).toMatchObject({ state: "holding", slot: "public-0" });
    const { lobby: player } = value(await w.lobbies.createLobby(cal!.key, "public", 1));
    value(await w.lobbies.join(player.id, cal!.key));
    expect(value(await w.lobbies.join(player.id, dee!.key))).toMatchObject({ state: "waiting", slot: null });

    const colonies = [[w.seat(eve!)], [w.seat(fay!)]] as const;
    const made = await w.queued(colonies);
    expect(made).toMatchObject({ kind: "public", size: 1, state: "waiting", rated: true, mode: "1v1", slot: null, startsAt: null,
      creatorId: eve!.identity.id, colonies });
    expect((await w.raw("queues/public"))?.lobbies).toBe(`${player.id} ${made.id}`);
    // Not a listed lobby: it is never joinable from list_lobbies.
    expect((await w.raw("listings/public"))?.lobbies).not.toContain(made.id);
    expect((await w.lobbies.listPublic()).map((lobby) => lobby.id)).not.toContain(made.id);

    // Long past the 12-hour expiry, the player lobby has expired; the queue-made one still waits.
    w.clock.t += LOBBY_TTL_MS + 45 * 60_000;
    expect(value(await w.lobbies.readLobby(player.id)).state).toBe("expired");
    expect(value(await w.lobbies.readLobby(made.id))).toMatchObject({ state: "waiting", slot: null });
    expect(await w.lobbies.join(made.id, ann!.key)).toEqual({ ok: false, reason: "full" });

    // The slot frees: the expired lobby is skipped and the queue-made lobby takes the slot and counts down.
    expect(value(await w.lobbies.releaseSlot(running.id))).toEqual({ next: made.id });
    expect(value(await w.lobbies.readLobby(made.id))).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS,
      rated: true, mode: "1v1", colonies });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: made.id });
    expect((await w.raw("queues/public"))?.lobbies).toBe("");
    expect(await w.lobbies.slotHolder("public-0")).toMatchObject({ lobbyId: made.id, startsAt: w.clock.t + COUNTDOWN_MS, matchRunId: null, colonies });
  });

  it("is rated, and its natural result changes both identities' 1v1 ratings", async () => {
    const w = world();
    await w.lobbies.registerInstance("public-0", instance);
    const [ann, bob] = await Promise.all(["Ann", "Bob"].map(w.keyFor));
    const made = await w.queued([[w.seat(ann!)], [w.seat(bob!)]]);
    expect(made).toMatchObject({ state: "holding", slot: "public-0", rated: true, mode: "1v1", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(await w.raw(`lobbies/${made.id}`)).toMatchObject({ kind: "public", size: "1", state: "holding", rated: "true", mode: "1v1" });

    value(await w.lobbies.beginMatch(made.id, "public-0", instance.runId));
    value(await w.lobbies.endMatch(made.id, instance.runId, "colony_1_won"));
    expect(value(await w.lobbies.readLobby(made.id))).toMatchObject({ state: "ended", outcome: "colony_1_won", rated: true });
    expect(await w.ratings.readRating(ann!.identity.id)).toEqual({ ...FIRST_LOSS, ratedMatches: 1 });
    expect(await w.ratings.readRating(bob!.identity.id)).toEqual({ ...FIRST_WIN, ratedMatches: 1 });
    expect(await w.ratings.readMatchChanges(made.id)).toEqual([
      { identityId: ann!.identity.id, before: 1500, after: FIRST_LOSS.rating, rdBefore: 350, rdAfter: FIRST_LOSS.rd },
      { identityId: bob!.identity.id, before: 1500, after: FIRST_WIN.rating, rdBefore: 350, rdAfter: FIRST_WIN.rd },
    ]);
  });

  it("stores the seats it is given for any colony length", async () => {
    const w = world();
    const [ann, bob] = await Promise.all(["Ann", "Bob"].map(w.keyFor));
    // A team pairing repeats each identity on every seat of its colony.
    const colonies = [[w.seat(ann!), w.seat(ann!)], [w.seat(bob!), w.seat(bob!)]] as const;
    const made = await w.queued(colonies, "2v2");
    expect(made).toMatchObject({ size: 2, state: "holding", rated: true, mode: "2v2", colonies });
    expect(JSON.parse((await w.raw(`lobbies/${made.id}`))!.seats!)).toEqual([
      { ...w.seat(ann!), colony: 0 }, { ...w.seat(ann!), colony: 0 }, { ...w.seat(bob!), colony: 1 }, { ...w.seat(bob!), colony: 1 },
    ]);
    await expect(w.queued([[w.seat(ann!)], []])).rejects.toThrow("two colonies of 1-4 seats");
  });
});
