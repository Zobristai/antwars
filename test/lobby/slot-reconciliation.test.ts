import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import {
  CHALLENGE_LOBBY_TTL_MS, COUNTDOWN_MS, createLobbies, isExpired, LOBBY_TTL_MS, STALE_HOLD_GRACE_MS, type Lobby, type LobbyOutcome, type LobbySettings, type Seat,
} from "../../src/lobby/lobbies.ts";
import { lobbyPageUrl } from "../../src/lobby/site.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { wakingStore } from "../../src/slots/wake.ts";
import { createFirestore } from "../../src/store/firestore.ts";

// Characterization of locate, settleSlots, isExpired and settledIfWaiting, the
// semantics a stale-holding reconciliation builds on.
// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

let counter = 0;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/**
 * One namespace with one public slot and a test clock; commits through `lobbies` are counted, and its
 * slots are assigned through a waking store that records each woken slot.
 */
function world(settings: Omit<LobbySettings, "now"> = {}) {
  const namespace = `r${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const counted = { commits: 0 };
  const request: typeof fetch = (input, init) => {
    if (init?.method === "POST" && String(input).endsWith(":commit")) counted.commits++;
    return fetch(input, init);
  };
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const clock = { t: Date.UTC(2026, 10, 3, 8, 0, 0) };
  const ids = createIdentities(store);
  const woken: string[] = [];
  const lobbyStore = wakingStore(createFirestore({ projectId, namespace, emulatorHost: host, request }), (slot) => { woken.push(slot); });
  const lobbies = createLobbies(lobbyStore, ids, { ...settings, now: () => clock.t });
  const keyFor = async (name: string) => value(await ids.claimUsername(name));
  /** A started public 1v1 player lobby of two fresh identities. */
  const started = async (a: string, b: string) => {
    const [x, y] = await Promise.all([a, b].map(keyFor));
    const { lobby } = value(await lobbies.createLobby(x!.key, "public", 1));
    value(await lobbies.join(lobby.id, x!.key));
    return value(await lobbies.join(lobby.id, y!.key));
  };
  const seat = (key: { identity: { id: string; displayName: string } }): Seat => ({ id: key.identity.id, displayName: key.identity.displayName });
  /** A queue pairing's ranked match, made in a transaction on the store createLobbies was given, as the queue makes it. */
  const queued = (colonies: readonly [readonly Seat[], readonly Seat[]]) => lobbyStore.transaction<Lobby>(async (read) => {
    const made = await lobbies.queuedMatchWrites(read, { mode: "1v1", colonies }, clock.t);
    return { result: made.lobby, writes: made.writes };
  });
  return { clock, lobbies, keyFor, started, seat, queued, counted, woken, ratings: createRatings(store), raw: (path: string) => store.get(path) };
}

const instance = { runId: "run", mcpUrl: "http://r.test/mcp", spectatorUrl: "http://r.test/" };

describe("isExpired", () => {
  const at = 1_000_000;
  const lobby = (fields: Record<string, string>) => ({ createdAt: String(at), mode: "", ...fields });

  it("expires a player-created open or waiting lobby exactly LOBBY_TTL_MS after creation", () => {
    for (const state of ["open", "waiting"]) {
      expect(isExpired(lobby({ state }), at + LOBBY_TTL_MS - 1)).toBe(false);
      expect(isExpired(lobby({ state }), at + LOBBY_TTL_MS)).toBe(true);
    }
  });

  it("gives a player-created lobby 12 hours and a house challenge lobby 15 minutes", () => {
    expect(LOBBY_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(CHALLENGE_LOBBY_TTL_MS).toBe(15 * 60 * 1000);
    for (const state of ["open", "waiting"]) {
      expect(isExpired(lobby({ state }), at + 12 * 60 * 60 * 1000 - 1)).toBe(false);
      expect(isExpired(lobby({ state, challengeId: "request" }), at + 15 * 60 * 1000 - 1)).toBe(false);
      expect(isExpired(lobby({ state, challengeId: "request" }), at + 15 * 60 * 1000)).toBe(true);
    }
  });

  it("never expires a holding or ended lobby, nor a queue-made one in any state", () => {
    const later = at + 10 * LOBBY_TTL_MS;
    expect(isExpired(lobby({ state: "holding" }), later)).toBe(false);
    expect(isExpired(lobby({ state: "ended" }), later)).toBe(false);
    for (const state of ["open", "waiting", "holding"]) expect(isExpired(lobby({ state, mode: "1v1" }), later)).toBe(false);
  });
});

describe.skipIf(!host)("slot settling against the Firestore emulator", { timeout: 60_000 }, () => {
  it("locate: no slot while open or waiting; the slot and lobby page while holding, the MCP address once an instance registers", async () => {
    const w = world();
    expect(await w.lobbies.locate("not-a-lobby-id")).toEqual({ ok: false, reason: "no_such_lobby" });
    const [ann] = await Promise.all(["Ann"].map(w.keyFor));
    const { lobby: open } = value(await w.lobbies.createLobby(ann!.key, "public", 1));
    expect(value(await w.lobbies.locate(open.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });

    const holder = await w.started("Bob", "Cal");
    expect(holder).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(value(await w.lobbies.locate(holder.id))).toEqual({ slot: "public-0", mcpUrl: null, spectatorUrl: lobbyPageUrl(holder.id) });
    const waiter = await w.started("Dee", "Eve");
    expect(waiter).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.locate(waiter.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });

    await w.lobbies.registerInstance("public-0", instance);
    expect(value(await w.lobbies.locate(holder.id))).toEqual({ slot: "public-0", mcpUrl: instance.mcpUrl, spectatorUrl: lobbyPageUrl(holder.id) });
  });

  it("settledIfWaiting: reading or locating a waiter writes nothing while no slot pairs", async () => {
    const w = world();
    await w.started("Ann", "Bob");
    const waiter = await w.started("Cal", "Dee");
    const before = w.counted.commits;
    expect(value(await w.lobbies.readLobby(waiter.id))).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.locate(waiter.id))).toMatchObject({ slot: null });
    expect(w.counted.commits).toBe(before);
  });

  it("settleSlots: a released slot goes to the earliest waiter with a fresh countdown from the release", async () => {
    const w = world();
    const holder = await w.started("Ann", "Bob");
    const first = await w.started("Cal", "Dee");
    const second = await w.started("Eve", "Fay");
    expect((await w.raw("queues/public"))?.lobbies).toBe(`${first.id} ${second.id}`);
    w.clock.t += 60_000;
    expect(value(await w.lobbies.releaseSlot(holder.id))).toEqual({ next: first.id });
    expect(value(await w.lobbies.readLobby(first.id))).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: first.id });
    expect((await w.raw("queues/public"))?.lobbies).toBe(second.id);
  });

  it("an unbegun holder long past its countdown keeps its slot when nothing reconciles stale holds", async () => {
    const w = world();
    const holder = await w.started("Ann", "Bob");
    const waiter = await w.started("Cal", "Dee");
    w.clock.t += LOBBY_TTL_MS - 1;
    expect(value(await w.lobbies.readLobby(waiter.id))).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.locate(holder.id))).toMatchObject({ slot: "public-0" });
    expect(value(await w.lobbies.readLobby(holder.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: holder.id });
  });
});

describe.skipIf(!host)("stale holds released against the Firestore emulator", { timeout: 60_000 }, () => {
  const GRACE = STALE_HOLD_GRACE_MS;

  it("frees a wedged holding slot to the waiting lobby once its countdown and the grace pass, waking the slot's server", async () => {
    const w = world({ staleHoldGraceMs: GRACE });
    const t0 = w.clock.t;
    const holder = await w.started("Ann", "Bob");
    const waiter = await w.started("Cal", "Dee");
    expect(w.woken).toEqual(["public-0"]);
    // The wake was lost: no server registers or begins the holder's match.
    w.clock.t = t0 + COUNTDOWN_MS + GRACE - 1;
    expect(value(await w.lobbies.readLobby(waiter.id))).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.readLobby(holder.id))).toMatchObject({ state: "holding", slot: "public-0" });

    w.clock.t = t0 + COUNTDOWN_MS + GRACE;
    expect(value(await w.lobbies.readLobby(waiter.id))).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(value(await w.lobbies.readLobby(holder.id))).toMatchObject({ state: "ended", slot: null, outcome: "not_played" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: waiter.id });
    expect((await w.raw("queues/public"))?.lobbies).toBe("");
    expect(w.woken).toEqual(["public-0", "public-0"]);
    expect(await w.lobbies.releaseSlot(holder.id)).toEqual({ ok: false, reason: "not_holding" });
  });

  it("releases a lone stale holder when it is itself located, deleting its slot so the next lobby takes it at once", async () => {
    const w = world({ staleHoldGraceMs: GRACE });
    const holder = await w.started("Ann", "Bob");
    w.clock.t += COUNTDOWN_MS + GRACE;
    expect(value(await w.lobbies.locate(holder.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });
    expect(await w.raw(`lobbies/${holder.id}`)).toMatchObject({ state: "ended", slot: "", outcome: "not_played" });
    expect(await w.raw("slots/public-0")).toBeNull();
    expect(await w.started("Cal", "Dee")).toMatchObject({ state: "holding", slot: "public-0" });
  });

  it("keeps the hold once its match began, and for the grace after a late registration of the slot's server", async () => {
    const w = world({ staleHoldGraceMs: GRACE });
    const t0 = w.clock.t;
    const holder = await w.started("Ann", "Bob");
    // A server woken late registers just before the grace would end; its fresh heartbeat keeps the hold.
    w.clock.t = t0 + COUNTDOWN_MS + GRACE - 1;
    await w.lobbies.registerInstance("public-0", instance);
    w.clock.t = t0 + COUNTDOWN_MS + GRACE;
    const late = await w.started("Cal", "Dee");
    expect(late).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.readLobby(holder.id))).toMatchObject({ state: "holding", slot: "public-0" });
    // That server never begins either: a grace after its registration, the hold is stale.
    w.clock.t = t0 + COUNTDOWN_MS + 2 * GRACE - 1;
    expect(value(await w.lobbies.readLobby(late.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(value(await w.lobbies.readLobby(holder.id))).toMatchObject({ state: "ended", outcome: "not_played" });

    // A begun match is never stale, however long it runs.
    value(await w.lobbies.beginMatch(late.id, "public-0", instance.runId));
    w.clock.t += 24 * 60 * 60_000;
    const next = await w.started("Eve", "Fay");
    expect(next).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.readLobby(next.id))).toMatchObject({ state: "waiting", slot: null });
    expect(value(await w.lobbies.locate(late.id))).toMatchObject({ slot: "public-0", mcpUrl: instance.mcpUrl });
  });

  it("hands a stale holder's slot straight to a lobby that fills, or a queue pairing, needing one", async () => {
    const w = world({ staleHoldGraceMs: GRACE });
    const first = await w.started("Ann", "Bob");
    w.clock.t += COUNTDOWN_MS + GRACE;
    const filled = await w.started("Cal", "Dee");
    expect(filled).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(await w.raw(`lobbies/${first.id}`)).toMatchObject({ state: "ended", outcome: "not_played" });
    w.clock.t += COUNTDOWN_MS + GRACE;
    const [eve, fay] = await Promise.all(["Eve", "Fay"].map(w.keyFor));
    expect(await w.queued([[w.seat(eve!)], [w.seat(fay!)]])).toMatchObject({ state: "holding", slot: "public-0" });
    expect(await w.raw(`lobbies/${filled.id}`)).toMatchObject({ state: "ended", outcome: "not_played" });
    expect(w.woken).toEqual(["public-0", "public-0", "public-0"]);
  });

  it("ends a stale queue-made ranked holder not played, with no rating written", async () => {
    const w = world({ staleHoldGraceMs: GRACE });
    const [ann, bob] = await Promise.all(["Ann", "Bob"].map(w.keyFor));
    const made = await w.queued([[w.seat(ann!)], [w.seat(bob!)]]);
    expect(made).toMatchObject({ state: "holding", slot: "public-0", rated: true, mode: "1v1" });
    w.clock.t += COUNTDOWN_MS + GRACE;
    expect(value(await w.lobbies.locate(made.id))).toMatchObject({ slot: null });
    expect(await w.raw(`lobbies/${made.id}`)).toMatchObject({ state: "ended", slot: "", outcome: "not_played", rated: "true" });
    expect(await w.ratings.readMatchChanges(made.id)).toBeNull();
    for (const key of [ann!, bob!]) expect(await w.ratings.readRating(key.identity.id)).toMatchObject({ rating: 1500, rd: 350, ratedMatches: 0 });
  });
});
