import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";

// A withheld slot (withheld/{slot}, set and cleared by deploy.sh over
// Firestore REST) is never handed a lobby; its running match plays to the end.
// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

let counter = 0;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** One namespace with publicSlots public slots; commits through `lobbies` are counted. */
function world(publicSlots: number) {
  const namespace = `w${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const counted = { commits: 0 };
  const request: typeof fetch = (input, init) => {
    if (init?.method === "POST" && String(input).endsWith(":commit")) counted.commits++;
    return fetch(input, init);
  };
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const clock = { t: Date.UTC(2026, 9, 28, 8, 0, 0) };
  const ids = createIdentities(store);
  const lobbies = createLobbies(createFirestore({ projectId, namespace, emulatorHost: host, request }), ids, { publicSlots, now: () => clock.t });
  const keyFor = async (name: string) => value(await ids.claimUsername(name));
  // What deploy.sh does over REST: a plain document write, outside any lobby transaction.
  const withhold = (slot: string) => store.transaction(async () => ({
    result: undefined, writes: [{ op: "create", path: `withheld/${slot}`, fields: { by: "deploy" } }],
  }));
  const restore = (slot: string) => store.transaction(async () => ({ result: undefined, writes: [{ op: "delete", path: `withheld/${slot}` }] }));
  /** A started 1v1 player lobby of two fresh identities. */
  const started = async (a: string, b: string) => {
    const [x, y] = await Promise.all([a, b].map(keyFor));
    const { lobby } = value(await lobbies.createLobby(x!.key, "public", 1));
    value(await lobbies.join(lobby.id, x!.key));
    return value(await lobbies.join(lobby.id, y!.key));
  };
  return { clock, lobbies, keyFor, withhold, restore, started, counted, raw: (path: string) => store.get(path), ratings: createRatings(store) };
}

const instance = { runId: "run", mcpUrl: "http://w.test/mcp", spectatorUrl: "http://w.test/" };

describe.skipIf(!host)("withheld slots against the Firestore emulator", { timeout: 60_000 }, () => {
  it("a lobby filling or started early never takes a withheld slot: it takes another free slot or waits", async () => {
    const w = world(2);
    await w.withhold("public-0");
    expect(await w.started("Ann", "Bob")).toMatchObject({ state: "holding", slot: "public-1" });

    const [cal, dee] = await Promise.all(["Cal", "Dee"].map(w.keyFor));
    const { lobby } = value(await w.lobbies.createLobby(cal!.key, "public", 2));
    value(await w.lobbies.join(lobby.id, cal!.key, undefined, 0));
    value(await w.lobbies.join(lobby.id, dee!.key, undefined, 1));
    expect(value(await w.lobbies.startEarly(lobby.id, cal!.key))).toMatchObject({ state: "waiting", slot: null });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect(await w.raw("withheld/public-0")).toEqual({ by: "deploy" });
  });

  it("a queue pairing never takes a withheld slot", async () => {
    const w = world(1);
    await w.withhold("public-0");
    const [ann, bob] = await Promise.all(["Ann", "Bob"].map(w.keyFor));
    expect(value(await w.lobbies.joinQueue(ann!.key, "1v1"))).toMatchObject({ state: "waiting" });
    const matched = value(await w.lobbies.joinQueue(bob!.key, "1v1"));
    if (matched.state !== "matched") throw new Error(`expected matched, got ${matched.state}`);
    expect(await w.raw(`lobbies/${matched.lobbyId}`)).toMatchObject({ state: "waiting", slot: "", rated: "true", mode: "1v1" });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect((await w.raw("queues/public"))?.lobbies).toBe(matched.lobbyId);
  });

  it("a match on a slot withheld mid-match plays to the end and is rated; the slot is freed, not handed on, and waiters take other slots", async () => {
    const w = world(2);
    await w.lobbies.registerInstance("public-0", instance);
    const [ann, bob] = await Promise.all(["Ann", "Bob"].map(w.keyFor));
    value(await w.lobbies.joinQueue(ann!.key, "1v1"));
    const matched = value(await w.lobbies.joinQueue(bob!.key, "1v1"));
    if (matched.state !== "matched") throw new Error(`expected matched, got ${matched.state}`);
    const rated = matched.lobbyId;
    expect(value(await w.lobbies.readLobby(rated))).toMatchObject({ state: "holding", slot: "public-0" });
    const other = await w.started("Cal", "Dee");
    expect(other).toMatchObject({ state: "holding", slot: "public-1" });
    const first = await w.started("Eve", "Fay");
    const second = await w.started("Gus", "Hal");
    expect([first.state, second.state]).toEqual(["waiting", "waiting"]);

    // Withheld after the match took its slot: beginning and ending it are unaffected.
    await w.withhold("public-0");
    value(await w.lobbies.beginMatch(rated, "public-0", instance.runId));
    expect(value(await w.lobbies.endMatch(rated, instance.runId, "colony_0_won"))).toEqual({ next: null });
    expect(value(await w.lobbies.readLobby(rated))).toMatchObject({ state: "ended", outcome: "colony_0_won", rated: true });
    expect(await w.ratings.readRating(ann!.identity.id)).toEqual({ ...FIRST_WIN, ratedMatches: 1 });
    expect(await w.ratings.readRating(bob!.identity.id)).toEqual({ ...FIRST_LOSS, ratedMatches: 1 });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect(value(await w.lobbies.readLobby(first.id))).toMatchObject({ state: "waiting", slot: null });

    // Another lobby's match ending hands its own slot on, never the free withheld one.
    expect(value(await w.lobbies.releaseSlot(other.id))).toEqual({ next: first.id });
    expect(value(await w.lobbies.readLobby(first.id))).toMatchObject({ state: "holding", slot: "public-1" });
    expect(value(await w.lobbies.readLobby(second.id))).toMatchObject({ state: "waiting", slot: null });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect((await w.raw("queues/public"))?.lobbies).toBe(second.id);
  });

  it("looking at a waiting lobby while every free slot is withheld writes nothing", async () => {
    const w = world(1);
    await w.withhold("public-0");
    const waiting = await w.started("Ann", "Bob");
    expect(waiting.state).toBe("waiting");
    const before = w.counted.commits;
    expect(value(await w.lobbies.readLobby(waiting.id))).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.locate(waiting.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });
    expect(w.counted.commits).toBe(before);
    expect(await w.raw("slots/public-0")).toBeNull();
  });

  it("removing the mark returns the slot to allocation: a waiting lobby takes it when next looked at", async () => {
    const w = world(1);
    await w.lobbies.registerInstance("public-0", instance);
    await w.withhold("public-0");
    const first = await w.started("Ann", "Bob");
    const second = await w.started("Cal", "Dee");
    expect([first.state, second.state]).toEqual(["waiting", "waiting"]);

    await w.restore("public-0");
    // Looking at the later waiter settles in queue order: the earliest waiter takes the slot.
    expect(value(await w.lobbies.readLobby(second.id))).toMatchObject({ state: "waiting", slot: null });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: first.id });
    expect(value(await w.lobbies.locate(first.id))).toEqual({ slot: "public-0", mcpUrl: instance.mcpUrl, spectatorUrl: `https://antwars.ai/?lobby=${first.id}` });
    expect(value(await w.lobbies.readLobby(first.id))).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + w.lobbies.countdownMs });
    expect((await w.raw("queues/public"))?.lobbies).toBe(second.id);
  });

  it("removing the mark returns the slot to allocation: locate settles a waiting lobby, and so does the next lobby start", async () => {
    const w = world(1);
    await w.withhold("public-0");
    const first = await w.started("Ann", "Bob");
    await w.restore("public-0");
    expect(value(await w.lobbies.locate(first.id))).toMatchObject({ slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: first.id });

    const v = world(1);
    await v.withhold("public-0");
    const waiter = await v.started("Ann", "Bob");
    await v.restore("public-0");
    // The next allocating transaction hands the restored slot to the earlier waiter first.
    expect(await v.started("Cal", "Dee")).toMatchObject({ state: "waiting", slot: null });
    expect(await v.raw("slots/public-0")).toEqual({ lobbyId: waiter.id });
  });
});
