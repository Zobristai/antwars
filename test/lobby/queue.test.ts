import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby, type LobbyOutcome, type LobbySettings } from "../../src/lobby/lobbies.ts";
import { QUEUE_TTL_MS } from "../../src/lobby/queue.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const RACE_TIMEOUT = 120_000; // the emulator reports a lock conflict after about 2 s

let counter = 0;
const freshNamespace = () => `q${process.pid}-${Date.now().toString(36)}-${counter++}`;
const storeFor = (namespace: string, request?: typeof fetch) => createFirestore({ projectId, namespace, emulatorHost: host, request });

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/**
 * One namespace standing in for the shared store. `lobbies(request)` is another
 * server instance on it, with its own client; all instances share the test clock.
 */
function world(settings: Omit<LobbySettings, "now"> = {}) {
  const namespace = freshNamespace();
  const clock = { t: Date.UTC(2026, 9, 23, 8, 0, 0) };
  const ids = createIdentities(storeFor(namespace));
  const lobbies = (request?: typeof fetch) => createLobbies(storeFor(namespace, request), createIdentities(storeFor(namespace, request)), { ...settings, now: () => clock.t });
  const keyFor = async (name: string) => value(await ids.claimUsername(name));
  const handleOf = async (owner: { key: string }, name: string) => value(await ids.createHandle(owner.key, name));
  const raw = (path: string) => storeFor(namespace).get(path);
  /** Every lobby in the namespace, oldest first. */
  const allLobbies = async (): Promise<Lobby[]> => {
    const rows = (await storeFor(namespace).query("lobbies", { orderBy: "createdAt", direction: "ASCENDING", limit: 100 })).rows;
    return Promise.all(rows.map(async (row) => value(await main.readLobby(row.path.split("/").at(-1)!))));
  };
  const main = lobbies();
  return { namespace, clock, ids, lobbies, keyFor, handleOf, raw, allLobbies, main, ratings: createRatings(storeFor(namespace)) };
}

/**
 * Forces n operations to overlap: each contender's first commit is held until all
 * n have reached one, so all have read before any writes. Retries pass unheld.
 */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => { release = resolve; });
  return (): typeof fetch => {
    let held = false;
    return async (input, init) => {
      if (!held && init?.method === "POST" && String(input).endsWith(":commit")) {
        held = true;
        if (++arrived === n) release();
        await Promise.race([all, sleep(20_000, undefined, { ref: false }).then(() => {
          throw new Error(`barrier: ${n} contenders did not reach a commit within 20 s`);
        })]);
      }
      return fetch(input, init);
    };
  };
}

const seatIds = (lobby: Lobby) => lobby.colonies.map((colony) => colony.map((seat) => seat.id));
const waitingList = async (w: ReturnType<typeof world>, mode = "1v1") => ((await w.raw(`queueWaiting/${mode}`))?.entries ?? "").split(" ").filter(Boolean);

// Each test makes dozens of sequential emulator round trips.
describe.skipIf(!host)("ranked queue against the Firestore emulator", { timeout: 60_000 }, () => {
  it("queues an identity in 1v1 with its expiry, removes it on leave, and refuses a second join while it waits", async () => {
    const w = world();
    const ann = await w.keyFor("Ann");
    const joinedAt = w.clock.t;
    const waiting = { state: "waiting", mode: "1v1", joinedAt, expiresAt: joinedAt + 12 * 60 * 60 * 1000 };
    expect(value(await w.main.queueStatus(ann.key))).toEqual({ state: "none" });
    expect(value(await w.main.joinQueue(ann.key, "1v1"))).toEqual(waiting);
    w.clock.t += 60_000;
    expect(value(await w.main.queueStatus(ann.key))).toEqual(waiting);
    expect(await waitingList(w)).toEqual([ann.identity.id]);

    expect(await w.main.joinQueue(ann.key, "1v1")).toEqual({ ok: false, reason: "already_queued" });
    expect(value(await w.main.queueStatus(ann.key))).toEqual(waiting);

    expect(value(await w.main.leaveQueue(ann.key))).toEqual({ state: "none" });
    expect(value(await w.main.queueStatus(ann.key))).toEqual({ state: "none" });
    expect(await w.raw(`queueEntries/${ann.identity.id}`)).toBeNull();
    expect(await waitingList(w)).toEqual([]);
    // Leaving with nothing waiting changes nothing.
    expect(value(await w.main.leaveQueue(ann.key))).toEqual({ state: "none" });
    // After leaving, the identity can join again.
    expect(value(await w.main.joinQueue(ann.key, "1v1"))).toMatchObject({ state: "waiting", joinedAt: w.clock.t });
    expect(await w.allLobbies()).toEqual([]);
  });

  it("refuses an unknown mode and an unknown key without queuing anything", async () => {
    const w = world();
    const ann = await w.keyFor("Ann");
    for (const mode of ["", "5v5", "house-5v5", "__proto__", "toString", "1V1"]) {
      expect(await w.main.joinQueue(ann.key, mode)).toEqual({ ok: false, reason: "invalid_mode" });
    }
    expect(await w.main.joinQueue("not-a-key", "1v1")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.main.queueStatus("not-a-key")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.main.leaveQueue("not-a-key")).toEqual({ ok: false, reason: "unknown_key" });
    expect(value(await w.main.queueStatus(ann.key))).toEqual({ state: "none" });
    expect(await w.raw("queueWaiting/1v1")).toBeNull();
  });

  it("pairs a join with a waiting different-owner entry into a started full public 1v1 lobby that both statuses name", async () => {
    const w = world();
    const [ann, bob] = [await w.keyFor("Ann"), await w.keyFor("Bob")];
    value(await w.main.joinQueue(ann.key, "1v1"));
    w.clock.t += 5_000;
    const matched = value(await w.main.joinQueue(bob.key, "1v1"));
    expect(matched).toEqual({ state: "matched", mode: "1v1", lobbyId: expect.any(String), matchedAt: w.clock.t });
    if (matched.state !== "matched") throw new Error("not matched");

    // Both entries have left the queue, and both statuses name the lobby.
    expect(await waitingList(w)).toEqual([]);
    for (const key of [ann.key, bob.key]) expect(value(await w.main.queueStatus(key))).toEqual(matched);

    const lobby = value(await w.main.readLobby(matched.lobbyId));
    expect(lobby).toMatchObject({ kind: "public", size: 1, state: "holding", slot: "public-0", rated: true, startsAt: expect.any(Number) });
    expect(seatIds(lobby)).toEqual([[ann.identity.id], [bob.identity.id]]);
    expect(lobby.colonies.flat().map((seat) => seat.displayName)).toEqual(["Ann", "Bob"]);
    expect((await w.allLobbies()).map((found) => found.id)).toEqual([lobby.id]);
    // Agents continue as for any lobby: it holds a slot that locate resolves.
    expect(value(await w.main.locate(lobby.id))).toMatchObject({ slot: "public-0" });

    // A matched entry does not block a new join, and leaving does not unmatch it.
    expect(value(await w.main.leaveQueue(ann.key))).toEqual(matched);
    expect(value(await w.main.joinQueue(ann.key, "1v1"))).toMatchObject({ state: "waiting" });
  });

  it("keeps a paired lobby waiting past 12 hours for the occupied public slot and hands it the slot when it frees", async () => {
    const w = world();
    const [ann, bob, cat, dan] = [await w.keyFor("Ann"), await w.keyFor("Bob"), await w.keyFor("Cat"), await w.keyFor("Dan")];
    value(await w.main.joinQueue(ann.key, "1v1"));
    const first = value(await w.main.joinQueue(bob.key, "1v1"));
    if (first.state !== "matched") throw new Error("first pair not matched");
    expect(value(await w.main.readLobby(first.lobbyId))).toMatchObject({ state: "holding", slot: "public-0" });

    // The only public slot is held, so the second pair's lobby waits for it.
    value(await w.main.joinQueue(cat.key, "1v1"));
    const second = value(await w.main.joinQueue(dan.key, "1v1"));
    if (second.state !== "matched") throw new Error("second pair not matched");
    expect(value(await w.main.readLobby(second.lobbyId))).toMatchObject({ state: "waiting", slot: null });

    // Well past a player-created lobby's 12-hour expiry, it is still waiting.
    w.clock.t += 12 * 60 * 60 * 1000 + 20 * 60 * 1000;
    expect(value(await w.main.readLobby(second.lobbyId))).toMatchObject({ state: "waiting", slot: null });

    // The release hands it the slot; both statuses still name it.
    expect(value(await w.main.releaseSlot(first.lobbyId))).toEqual({ next: second.lobbyId });
    const started = value(await w.main.readLobby(second.lobbyId));
    expect(started).toMatchObject({ state: "holding", slot: "public-0", rated: true, startsAt: expect.any(Number) });
    expect(seatIds(started)).toEqual([[cat.identity.id], [dan.identity.id]]);
    for (const key of [cat.key, dan.key]) expect(value(await w.main.queueStatus(key))).toEqual(second);
    expect(value(await w.main.locate(second.lobbyId))).toMatchObject({ slot: "public-0" });
  });

  it("picks the opponent at random among the eligible waiting entries", async () => {
    // random() is uniform in [0, 1); the pick is floor(random() * eligible count).
    for (const pick of [0, 1, 2]) {
      let calls = 0;
      const w = world({ random: () => { calls += 1; return (pick + 0.5) / 3; } });
      const owner = await w.keyFor("Own");
      const handles = [];
      for (const name of ["h0", "h1", "h2"]) {
        const handle = await w.handleOf(owner, name);
        value(await w.main.joinQueue(handle.key, "1v1"));
        handles.push(handle);
      }
      // Same-owner handles wait side by side.
      expect(await waitingList(w)).toEqual(handles.map((handle) => handle.identity.id));
      const joiner = await w.keyFor("Joe");
      const matched = value(await w.main.joinQueue(joiner.key, "1v1"));
      if (matched.state !== "matched") throw new Error(`expected a match, got ${matched.state}`);
      expect(calls).toBe(1);
      expect(seatIds(value(await w.main.readLobby(matched.lobbyId)))).toEqual([[handles[pick]!.identity.id], [joiner.identity.id]]);
      expect(await waitingList(w)).toEqual(handles.filter((_, i) => i !== pick).map((handle) => handle.identity.id));
    }

    // Only different-owner entries are candidates: the joiner's own handle is never offered.
    // A draw just below 1 picks the last eligible entry, oldest first.
    let calls = 0;
    const w = world({ random: () => { calls += 1; return 0.999; } });
    const [kay, other] = [await w.keyFor("Kite"), await w.keyFor("Lee")];
    const scout = await w.handleOf(kay, "scout");
    value(await w.main.joinQueue(scout.key, "1v1"));
    value(await w.main.joinQueue(other.key, "1v1"));
    // Lee and the scout handle have different owners, so Lee's join paired them.
    expect(calls).toBe(1);
    expect(await waitingList(w)).toEqual([]);
    const relay = await w.handleOf(kay, "relay");
    value(await w.main.joinQueue(relay.key, "1v1"));
    const third = await w.keyFor("Max");
    value(await w.main.joinQueue(kay.key, "1v1")); // same owner as relay: waits
    expect(await waitingList(w)).toEqual([relay.identity.id, kay.identity.id]);
    const matched = value(await w.main.joinQueue(third.key, "1v1"));
    if (matched.state !== "matched") throw new Error("not matched");
    expect(calls).toBe(2); // Both were eligible; the last was drawn.
    expect(seatIds(value(await w.main.readLobby(matched.lobbyId)))).toEqual([[kay.identity.id], [third.identity.id]]);
  });

  it("never pairs two identities of one owner: two handles, or a username and its own handle, antwars included", async () => {
    const w = world({ random: () => 0 });
    const kay = await w.keyFor("Kite");
    const [scout, relay] = [await w.handleOf(kay, "scout"), await w.handleOf(kay, "relay")];
    const antwars = await w.keyFor("antwars");
    const house = await w.handleOf(antwars, "planner");

    const sameOwnerPairs = [[scout, relay], [kay, scout], [antwars, house]] as const;
    for (const [first, second] of sameOwnerPairs) {
      value(await w.main.joinQueue(first.key, "1v1"));
      // Only same-owner entries are waiting, so the joiner's entry waits.
      expect(value(await w.main.joinQueue(second.key, "1v1"))).toMatchObject({ state: "waiting" });
      expect(await waitingList(w)).toEqual([first.identity.id, second.identity.id]);
      for (const identity of [first, second]) value(await w.main.leaveQueue(identity.key));
    }
    // With two of the identities waiting, a third of the still waits.
    for (const identity of [scout, kay]) value(await w.main.joinQueue(identity.key, "1v1"));
    expect(value(await w.main.joinQueue(relay.key, "1v1"))).toMatchObject({ state: "waiting" });
    expect(await w.allLobbies()).toEqual([]);
    // A different owner's join, here the antwars handle's, is paired with one of them.
    expect(value(await w.main.joinQueue(house.key, "1v1"))).toMatchObject({ state: "matched" });
    const [lobby] = await w.allLobbies();
    expect(seatIds(lobby!)).toEqual([[scout.identity.id], [house.identity.id]]);
    expect(await waitingList(w)).toEqual([kay.identity.id, relay.identity.id]);
  });

  it("never pairs an entry whose identity document is missing", async () => {
    const w = world();
    const [ann, bob] = [await w.keyFor("Ann"), await w.keyFor("Bob")];
    value(await w.main.joinQueue(ann.key, "1v1"));
    await storeFor(w.namespace).transaction(async () => ({ result: null, writes: [{ op: "delete", path: `identities/${ann.identity.id}` }] }));
    expect(value(await w.main.joinQueue(bob.key, "1v1"))).toMatchObject({ state: "waiting" });
    expect(await w.allLobbies()).toEqual([]);
  });

  it("keeps an unpaired entry waiting and pairable until just under 12 hours after it joined, with nothing renewing it", async () => {
    const w = world();
    const [ann, bob] = [await w.keyFor("Ann"), await w.keyFor("Bob")];
    const joinedAt = w.clock.t;
    value(await w.main.joinQueue(ann.key, "1v1"));
    // Status reads along the way renew nothing: the expiry stays 12 hours from the join.
    for (const at of [joinedAt + 60 * 60 * 1000, joinedAt + 6 * 60 * 60 * 1000, joinedAt + 12 * 60 * 60 * 1000 - 1]) {
      w.clock.t = at;
      expect(value(await w.main.queueStatus(ann.key))).toEqual({ state: "waiting", mode: "1v1", joinedAt, expiresAt: joinedAt + 12 * 60 * 60 * 1000 });
    }
    const paired = value(await w.main.joinQueue(bob.key, "1v1"));
    expect(paired).toMatchObject({ state: "matched", mode: "1v1" });
    expect(value(await w.main.queueStatus(ann.key))).toEqual(paired);
  });

  it("expires an unpaired entry 12 hours after it joined, with no lobby or rating change, and lets the identity join again", async () => {
    const w = world();
    const [ann, bob] = [await w.keyFor("Ann"), await w.keyFor("Bob")];
    const joinedAt = w.clock.t;
    value(await w.main.joinQueue(ann.key, "1v1"));
    w.clock.t = joinedAt + QUEUE_TTL_MS - 1;
    expect(value(await w.main.queueStatus(ann.key))).toMatchObject({ state: "waiting", expiresAt: joinedAt + 12 * 60 * 60 * 1000 });
    w.clock.t = joinedAt + 12 * 60 * 60 * 1000;
    // Its status shows no waiting entry: it expired.
    const expired = { state: "expired", mode: "1v1", expiresAt: joinedAt + 12 * 60 * 60 * 1000 };
    expect(value(await w.main.queueStatus(ann.key))).toEqual(expired);
    expect(value(await w.main.leaveQueue(ann.key))).toEqual(expired);

    // A different-owner join is not paired with the expired entry, which is pruned.
    expect(value(await w.main.joinQueue(bob.key, "1v1"))).toMatchObject({ state: "waiting" });
    expect(await waitingList(w)).toEqual([bob.identity.id]);
    expect(await w.allLobbies()).toEqual([]);
    for (const identity of [ann, bob]) expect(await w.ratings.readRating(identity.identity.id)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    expect(await w.raw(`ratings/${ann.identity.id}`)).toBeNull();

    // The identity can join again.
    w.clock.t += 1_000;
    const rejoined = value(await w.main.joinQueue(ann.key, "1v1"));
    expect(rejoined).toMatchObject({ state: "matched" });
    expect(await w.allLobbies()).toHaveLength(1);
  });

  it("never places one waiting entry into two matches when joins race", { timeout: RACE_TIMEOUT }, async () => {
    // One waiting entry, two different-owner joiners on separate instances.
    {
      const w = world();
      const [ann, bob, cat] = [await w.keyFor("Ann"), await w.keyFor("Bob"), await w.keyFor("Cat")];
      value(await w.main.joinQueue(ann.key, "1v1"));
      const wrap = barrier(2);
      const results = (await Promise.all([w.lobbies(wrap()).joinQueue(bob.key, "1v1"), w.lobbies(wrap()).joinQueue(cat.key, "1v1")])).map(value);
      expect(results.map((result) => result.state).sort()).toEqual(["matched", "waiting"]);
      const lobbies = await w.allLobbies();
      expect(lobbies).toHaveLength(1);
      expect(seatIds(lobbies[0]!)[0]).toEqual([ann.identity.id]);
      expect(value(await w.main.queueStatus(ann.key))).toMatchObject({ state: "matched", lobbyId: lobbies[0]!.id });
      const waiter = results[0]!.state === "waiting" ? bob : cat;
      expect(await waitingList(w)).toEqual([waiter.identity.id]);
    }
    // Two same-owner waiting entries and three different-owner joiners racing.
    {
      const w = world();
      const owner = await w.keyFor("Own");
      const waiting = [await w.handleOf(owner, "w0"), await w.handleOf(owner, "w1")];
      for (const entry of waiting) value(await w.main.joinQueue(entry.key, "1v1"));
      const joiners = [await w.keyFor("J0"), await w.keyFor("J1"), await w.keyFor("J2")];
      const wrap = barrier(3);
      const results = (await Promise.all(joiners.map((joiner) => w.lobbies(wrap()).joinQueue(joiner.key, "1v1")))).map(value);
      expect(results.map((result) => result.state).sort()).toEqual(["matched", "matched", "waiting"]);
      const lobbies = await w.allLobbies();
      expect(lobbies).toHaveLength(2);
      for (const entry of waiting) {
        const holding = lobbies.filter((lobby) => seatIds(lobby).flat().includes(entry.identity.id));
        expect(holding).toHaveLength(1);
        expect(value(await w.main.queueStatus(entry.key))).toMatchObject({ state: "matched", lobbyId: holding[0]!.id });
      }
      const waiter = joiners[results.findIndex((result) => result.state === "waiting")]!;
      expect(await waitingList(w)).toEqual([waiter.identity.id]);
    }
  });
});
