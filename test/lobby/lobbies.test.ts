import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { COUNTDOWN_MS, createLobbies, LOBBY_TTL_MS, type LobbyOutcome, type LobbySettings } from "../../src/lobby/lobbies.ts";
import { createRatings, RANKED_MODES } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { FIRST_LOSS, FIRST_WIN } from "../rating/glicko-values.ts";
import { glickoUpdate } from "../../src/rating/glicko.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const RACE_TIMEOUT = 120_000; // the emulator reports a lock conflict after about 2 s

let counter = 0;
const freshNamespace = () => `l${process.pid}-${Date.now().toString(36)}-${counter++}`;
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
  const clock = { t: Date.UTC(2026, 9, 19, 8, 0, 0) };
  const ids = createIdentities(storeFor(namespace));
  const lobbies = (request?: typeof fetch) => createLobbies(storeFor(namespace, request), createIdentities(storeFor(namespace, request)), { ...settings, now: () => clock.t });
  const keyFor = async (name: string) => value(await ids.claimUsername(name));
  const raw = (path: string) => storeFor(namespace).get(path);
  /**
   * Marks a started lobby rated "true", standing in for a queue-made match or a lobby
   * rated before player-created lobbies became unrated (which keeps its flag).
   */
  const markRated = (lobbyId: string) => storeFor(namespace).transaction(async () => ({
    result: undefined, writes: [{ op: "update", path: `lobbies/${lobbyId}`, fields: { rated: "true" } }],
  }));
  return { clock, ids, lobbies, keyFor, raw, markRated, main: lobbies(), ratings: createRatings(storeFor(namespace)) };
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

const seatCounts = (lobby: { colonies: readonly [readonly unknown[], readonly unknown[]] }) => lobby.colonies.map((colony) => colony.length);

// Each test makes dozens of sequential emulator round trips.
describe.skipIf(!host)("lobbies against the Firestore emulator", { timeout: 60_000 }, () => {
  it("creates public lobbies that are listed and private ones that are not, with an invite token", async () => {
    const w = world();
    const kay = await w.keyFor("Kite");
    const scout = value(await w.ids.createHandle(kay.key, "scout"));

    const pub = value(await w.main.createLobby(scout.key, "public", 2));
    expect(pub.inviteToken).toBeUndefined();
    expect(pub.lobby).toMatchObject({ kind: "public", size: 2, state: "open", rated: null, slot: null, creatorId: scout.identity.id });
    const priv = value(await w.main.createLobby(kay.key, "private", 4));
    expect(priv.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const listed = await w.main.listPublic();
    expect(listed.map((lobby) => lobby.id)).toEqual([pub.lobby.id]);
    expect(listed[0]).toMatchObject({ size: 2, state: "open", colonies: [[], []] });
    expect((await w.raw("listings/public"))?.lobbies).not.toContain(priv.lobby.id);

    expect(await w.main.createLobby("not-a-key", "public", 1)).toEqual({ ok: false, reason: "unknown_key" });
    for (const size of [0, 5, 1.5]) expect(await w.main.createLobby(kay.key, "public", size as 1)).toEqual({ ok: false, reason: "invalid_size" });
    expect(await w.main.createLobby(kay.key, "secret" as "public", 1)).toEqual({ ok: false, reason: "invalid_kind" });
  });

  it("seats keyed identities in the emptier colony and refuses unknown keys, bad invites, repeats, full and started lobbies", async () => {
    const w = world();
    const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(c!.key, "public", 2)).lobby;

    expect(await w.main.join(lobby.id, "not-a-key")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.main.join("no-such-lobby", a!.key)).toEqual({ ok: false, reason: "no_such_lobby" });
    expect(seatCounts(value(await w.main.join(lobby.id, a!.key)))).toEqual([1, 0]);
    expect(seatCounts(value(await w.main.join(lobby.id, b!.key)))).toEqual([1, 1]);
    expect(await w.main.join(lobby.id, a!.key)).toEqual({ ok: false, reason: "already_seated" });
    // A rotated key still names the same seated identity.
    const rotated = value(await w.ids.rotateKey(b!.key)).key;
    expect(await w.main.join(lobby.id, rotated)).toEqual({ ok: false, reason: "already_seated" });
    expect(seatCounts(value(await w.main.join(lobby.id, d!.key)))).toEqual([2, 1]);
    const full = value(await w.main.join(lobby.id, c!.key));
    expect(seatCounts(full)).toEqual([2, 2]);
    expect(full.state).toBe("holding");
    expect(await w.main.join(lobby.id, e!.key)).toEqual({ ok: false, reason: "full" });

    const early = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    value(await w.main.join(early.id, a!.key));
    value(await w.main.join(early.id, rotated));
    value(await w.main.startEarly(early.id, c!.key));
    expect(await w.main.join(early.id, e!.key)).toEqual({ ok: false, reason: "started" });

    const priv = value(await w.main.createLobby(c!.key, "private", 1));
    expect(await w.main.join(priv.lobby.id, a!.key)).toEqual({ ok: false, reason: "invalid_invite" });
    expect(await w.main.join(priv.lobby.id, a!.key, "wrong-token")).toEqual({ ok: false, reason: "invalid_invite" });
    expect(seatCounts(value(await w.main.join(priv.lobby.id, a!.key, priv.inviteToken)))).toEqual([1, 0]);
  });

  // An optional colony choice on join.
  const seatIds = (lobby: { colonies: readonly [readonly { id: string }[], readonly { id: string }[]] }) =>
    lobby.colonies.map((colony) => colony.map((seat) => seat.id));

  it("seats a join naming colony 0 or 1 in that colony while it has a free seat, and refuses a full chosen colony as colony_full, leaving the joiner unseated", async () => {
    const w = world();
    const kay = await w.keyFor("Kite");
    const [scout, guard] = [value(await w.ids.createHandle(kay.key, "scout")), value(await w.ids.createHandle(kay.key, "guard"))];
    const [bob, dee] = await Promise.all(["Bob", "Dee"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(kay.key, "public", 2)).lobby;

    // Colony 1 although colony 0 is emptier: the choice, not the balancing rule.
    expect(seatIds(value(await w.main.join(lobby.id, scout.key, undefined, 1)))).toEqual([[], [scout.identity.id]]);
    expect(seatIds(value(await w.main.join(lobby.id, bob!.key, undefined, 1)))).toEqual([[], [scout.identity.id, bob!.identity.id]]);
    const before = await w.raw(`lobbies/${lobby.id}`);
    expect(await w.main.join(lobby.id, guard.key, undefined, 1)).toEqual({ ok: false, reason: "colony_full" });
    expect(await w.raw(`lobbies/${lobby.id}`)).toEqual(before);
    expect(seatIds(value(await w.main.readLobby(lobby.id))).flat()).not.toContain(guard.identity.id);

    // Refused, the joiner can still take a free seat in the other colony; a chosen last seat starts the lobby.
    expect(seatIds(value(await w.main.join(lobby.id, guard.key, undefined, 0)))).toEqual([[guard.identity.id], [scout.identity.id, bob!.identity.id]]);
    const full = value(await w.main.join(lobby.id, dee!.key, undefined, 0));
    expect(seatIds(full)).toEqual([[guard.identity.id, dee!.identity.id], [scout.identity.id, bob!.identity.id]]);
    expect(full).toMatchObject({ state: "holding", slot: "public-0" });
  });

  it("refuses a chosen-colony join in the order invite, expired, already_seated, full, started, colony_full", async () => {
    const w = world();
    const [c, a, b, d, e, x] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve", "Xan"].map(w.keyFor));
    const t0 = w.clock.t;

    const priv = value(await w.main.createLobby(c!.key, "private", 1));
    value(await w.main.join(priv.lobby.id, a!.key, priv.inviteToken, 0));
    // Colony 0 is full, yet a wrong invite is refused as such.
    expect(await w.main.join(priv.lobby.id, x!.key, "wrong-token", 0)).toEqual({ ok: false, reason: "invalid_invite" });
    // Already seated before colony_full.
    expect(await w.main.join(priv.lobby.id, a!.key, priv.inviteToken, 0)).toEqual({ ok: false, reason: "already_seated" });
    value(await w.main.join(priv.lobby.id, b!.key, priv.inviteToken, 1));
    // Full before colony_full.
    expect(await w.main.join(priv.lobby.id, x!.key, priv.inviteToken, 0)).toEqual({ ok: false, reason: "full" });

    // Started before colony_full: colony 0 is full and the lobby started early.
    const early = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    value(await w.main.join(early.id, a!.key, undefined, 0));
    value(await w.main.join(early.id, b!.key, undefined, 0));
    value(await w.main.join(early.id, d!.key, undefined, 1));
    value(await w.main.startEarly(early.id, c!.key));
    expect(await w.main.join(early.id, x!.key, undefined, 0)).toEqual({ ok: false, reason: "started" });

    // Expired before colony_full.
    const open = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(open.id, e!.key, undefined, 1));
    w.clock.t = t0 + LOBBY_TTL_MS;
    expect(await w.main.join(open.id, x!.key, undefined, 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("seats a join without a colony as before, in the colony with fewer seats, colony 0 on a tie, beside chosen seats; the last seat starts the lobby", async () => {
    const w = world();
    const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    expect(seatCounts(value(await w.main.join(lobby.id, a!.key, undefined, 1)))).toEqual([0, 1]);
    // Fewer seats: colony 0.
    expect(seatIds(value(await w.main.join(lobby.id, b!.key)))).toEqual([[b!.identity.id], [a!.identity.id]]);
    // A tie: colony 0.
    expect(seatIds(value(await w.main.join(lobby.id, d!.key)))).toEqual([[b!.identity.id, d!.identity.id], [a!.identity.id]]);
    // Fewer seats: colony 1, and the last seat starts the lobby.
    const full = value(await w.main.join(lobby.id, e!.key));
    expect(seatIds(full)).toEqual([[b!.identity.id, d!.identity.id], [a!.identity.id, e!.identity.id]]);
    expect(full).toMatchObject({ state: "holding", slot: "public-0" });
  });

  it("lets only one of two racing joins take a colony's last free seat; the other is refused colony_full and stays unseated", { timeout: RACE_TIMEOUT }, async () => {
    const w = world();
    const [c, a, r1, r2] = await Promise.all(["Cre", "Ann", "R1", "R2"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    value(await w.main.join(lobby.id, a!.key, undefined, 1));
    const wrap = barrier(2);
    const results = await Promise.all([r1, r2].map((racer) => w.lobbies(wrap()).join(lobby.id, racer!.key, undefined, 1)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "colony_full" }]);
    const after = value(await w.main.readLobby(lobby.id));
    expect(seatCounts(after)).toEqual([0, 2]);
    expect(after.state).toBe("open");
  });

  it("lets exactly as many racing joins succeed as there are free seats, never overfilling a colony", { timeout: RACE_TIMEOUT }, async () => {
    const w = world();
    const [c, a, ...racers] = await Promise.all(["Cre", "Ann", "R1", "R2", "R3", "R4"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    value(await w.main.join(lobby.id, a!.key));
    const wrap = barrier(racers.length);
    const results = await Promise.all(racers.map((racer) => w.lobbies(wrap()).join(lobby.id, racer!.key)));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "full" }]);
    const after = value(await w.main.readLobby(lobby.id));
    expect(seatCounts(after)).toEqual([2, 2]);
    expect(new Set(after.colonies.flat().map((seat) => seat.id)).size).toBe(4);
    expect(after).toMatchObject({ state: "holding", rated: false, slot: "public-0" });
  });

  it("lets only the creator revoke an invite; the revoked token is refused and seated identities stay", async () => {
    const w = world();
    const [c, a, b, x] = await Promise.all(["Cre", "Ann", "Bob", "Xan"].map(w.keyFor));
    const { lobby, inviteToken } = value(await w.main.createLobby(c!.key, "private", 2));
    value(await w.main.join(lobby.id, a!.key, inviteToken));

    expect(await w.main.revokeInvite(lobby.id, x!.key)).toEqual({ ok: false, reason: "not_creator" });
    expect(await w.main.revokeInvite(lobby.id, a!.key)).toEqual({ ok: false, reason: "not_creator" });
    expect(await w.main.isInviteCurrent(lobby.id, inviteToken!)).toBe(true);
    // The creator is its identity, not one key: a rotated key still authorizes it.
    const rotated = value(await w.ids.rotateKey(c!.key)).key;
    expect(await w.main.revokeInvite(lobby.id, c!.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.main.revokeInvite(lobby.id, rotated)).toEqual({ ok: true, value: null });

    expect(await w.main.isInviteCurrent(lobby.id, inviteToken!)).toBe(false);
    expect(await w.main.join(lobby.id, b!.key, inviteToken)).toEqual({ ok: false, reason: "invalid_invite" });
    expect(value(await w.main.readLobby(lobby.id)).colonies[0].map((seat) => seat.id)).toEqual([a!.identity.id]);

    const pub = value(await w.main.createLobby(rotated, "public", 1)).lobby;
    expect(await w.main.revokeInvite(pub.id, rotated)).toEqual({ ok: false, reason: "not_private" });
  });

  it("lets only the creator issue a fresh invite, which admits joins while every revoked token stays refused", async () => {
    const w = world();
    const [c, a, b, d, x] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Xan"].map(w.keyFor));
    const { lobby, inviteToken: first } = value(await w.main.createLobby(c!.key, "private", 2));
    expect(await w.main.issueInvite(lobby.id, x!.key)).toEqual({ ok: false, reason: "not_creator" });

    value(await w.main.revokeInvite(lobby.id, c!.key));
    const second = value(await w.main.issueInvite(lobby.id, c!.key)).inviteToken;
    expect(await w.main.isInviteCurrent(lobby.id, second)).toBe(true);
    value(await w.main.join(lobby.id, a!.key, second));

    // Issuing again replaces the current token, which is then refused like a revoked one.
    const third = value(await w.main.issueInvite(lobby.id, c!.key)).inviteToken;
    for (const old of [first!, second]) {
      expect(await w.main.isInviteCurrent(lobby.id, old)).toBe(false);
      expect(await w.main.join(lobby.id, b!.key, old)).toEqual({ ok: false, reason: "invalid_invite" });
    }
    expect(await w.main.isInviteCurrent(lobby.id, third)).toBe(true);
    value(await w.main.join(lobby.id, d!.key, third));
    expect(seatCounts(value(await w.main.readLobby(lobby.id)))).toEqual([1, 1]);
  });

  it("gives a full different-owner 1v1 a free slot of its kind, marked unrated, or makes it wait; one slot of each kind by default", async () => {
    const w = world();
    const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
    const fill = async (kind: "public" | "private", ...keys: string[]) => {
      const created = value(await w.main.createLobby(c!.key, kind, 1));
      let last;
      for (const key of keys) last = value(await w.main.join(created.lobby.id, key, created.inviteToken));
      return last!;
    };
    const first = await fill("public", a!.key, b!.key);
    expect(first).toMatchObject({ state: "holding", rated: false, slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: first.id });
    const priv = await fill("private", a!.key, b!.key);
    expect(priv).toMatchObject({ state: "holding", rated: false, slot: "private-0" });
    const second = await fill("public", d!.key, e!.key);
    expect(second).toMatchObject({ state: "waiting", rated: false, slot: null });
    expect((await w.main.listPublic()).map((lobby) => [lobby.id, lobby.state])).toEqual([[first.id, "holding"], [second.id, "waiting"]]);

    expect(value(await w.main.releaseSlot(first.id))).toEqual({ next: second.id });
    expect(value(await w.main.readLobby(first.id)).state).toBe("ended");
    expect(value(await w.main.readLobby(second.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: second.id });
    expect((await w.main.listPublic()).map((lobby) => lobby.id)).toEqual([second.id]);

    // The slot count per kind is a setting.
    const wide = world({ publicSlots: 2 });
    const [h, ...players] = await Promise.all(["Cre", "P1", "P2", "P3", "P4", "P5", "P6"].map(wide.keyFor));
    const slotsTaken = [];
    for (let i = 0; i < 3; i++) {
      const created = value(await wide.main.createLobby(h!.key, "public", 1)).lobby;
      value(await wide.main.join(created.id, players[2 * i]!.key));
      slotsTaken.push(value(await wide.main.join(created.id, players[2 * i + 1]!.key)).slot);
    }
    expect(slotsTaken).toEqual(["public-0", "public-1", null]);
  });

  it("lets only the creator start early once each colony is seated; unfilled lobbies remain unrated", async () => {
    const w = world();
    const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
    const lobby = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    expect(await w.main.startEarly(lobby.id, c!.key)).toEqual({ ok: false, reason: "colony_empty" });
    value(await w.main.join(lobby.id, a!.key));
    expect(await w.main.startEarly(lobby.id, c!.key)).toEqual({ ok: false, reason: "colony_empty" });
    value(await w.main.join(lobby.id, b!.key));
    expect(await w.main.startEarly(lobby.id, a!.key)).toEqual({ ok: false, reason: "not_creator" });
    expect(await w.main.startEarly(lobby.id, "not-a-key")).toEqual({ ok: false, reason: "unknown_key" });
    expect(value(await w.main.startEarly(lobby.id, c!.key))).toMatchObject({ state: "holding", rated: false, slot: "public-0" });
    expect(await w.main.startEarly(lobby.id, c!.key)).toEqual({ ok: false, reason: "started" });

    // With the slot held, an early start waits for it like a full lobby.
    const next = value(await w.main.createLobby(c!.key, "public", 3)).lobby;
    value(await w.main.join(next.id, d!.key));
    value(await w.main.join(next.id, e!.key));
    expect(value(await w.main.startEarly(next.id, c!.key))).toMatchObject({ state: "waiting", rated: false, slot: null });
    expect(value(await w.main.releaseSlot(lobby.id))).toEqual({ next: next.id });
    expect(value(await w.main.readLobby(next.id))).toMatchObject({ state: "holding", rated: false, slot: "public-0" });
  });

  it("expires open and waiting lobbies exactly 12 hours after creation, unlisting them and refusing joins", async () => {
    const w = world();
    const [c, a, b, d, e, f, g, h] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve", "Fay", "Gus", "Hal"].map(w.keyFor));
    const t0 = w.clock.t;
    const holder = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(holder.id, a!.key));
    value(await w.main.join(holder.id, b!.key));
    const open = value(await w.main.createLobby(c!.key, "public", 2)).lobby;
    value(await w.main.join(open.id, d!.key));
    const waiting = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(waiting.id, d!.key));
    expect(value(await w.main.join(waiting.id, e!.key)).state).toBe("waiting");

    w.clock.t = t0 + LOBBY_TTL_MS - 1;
    expect((await w.main.listPublic()).map((lobby) => [lobby.id, lobby.state])).toEqual([
      [holder.id, "holding"], [open.id, "open"], [waiting.id, "waiting"],
    ]);
    expect(seatCounts(value(await w.main.join(open.id, f!.key)))).toEqual([1, 1]);
    // A second waiter, queued behind the one about to expire.
    const live = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(live.id, g!.key));
    expect(value(await w.main.join(live.id, h!.key)).state).toBe("waiting");
    expect((await w.raw("queues/public"))?.lobbies).toBe(`${waiting.id} ${live.id}`);

    w.clock.t = t0 + LOBBY_TTL_MS;
    expect(value(await w.main.readLobby(open.id)).state).toBe("expired");
    expect(value(await w.main.readLobby(waiting.id)).state).toBe("expired");
    expect(value(await w.main.readLobby(holder.id)).state).toBe("holding");
    expect((await w.main.listPublic()).map((lobby) => lobby.id)).toEqual([holder.id, live.id]);
    expect(await w.main.join(open.id, c!.key)).toEqual({ ok: false, reason: "expired" });
    expect(await w.main.join(waiting.id, c!.key)).toEqual({ ok: false, reason: "expired" });
    expect(await w.main.startEarly(open.id, c!.key)).toEqual({ ok: false, reason: "expired" });

    // The expired lobby heads the queue; release skips it and prunes it.
    expect(value(await w.main.releaseSlot(holder.id))).toEqual({ next: live.id });
    expect(value(await w.main.readLobby(waiting.id))).toMatchObject({ state: "expired", slot: null });
    expect(value(await w.main.readLobby(live.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: live.id });
    expect((await w.raw("queues/public"))?.lobbies).toBe("");

    // A later public create prunes the ended and expired ids from the listing document.
    const later = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    expect(ids((await w.raw("listings/public"))?.lobbies)).toEqual([live.id, later.id]);
  });

  it("hands a released slot to waiting lobbies in queue order, not id order; a repeated release changes nothing", async () => {
    const w = world();
    const keys = await Promise.all(["Cre", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"].map(w.keyFor));
    const c = keys[0]!;
    const fill = async (lobbyId: string, i: number) => {
      value(await w.main.join(lobbyId, keys[1 + 2 * i]!.key));
      return value(await w.main.join(lobbyId, keys[2 + 2 * i]!.key));
    };
    const holder = value(await w.main.createLobby(c.key, "public", 1)).lobby.id;
    await fill(holder, 0);
    const created = [];
    for (let i = 0; i < 3; i++) created.push(value(await w.main.createLobby(c.key, "public", 1)).lobby.id);
    const queued = [...created].sort().reverse(); // deliberately not ascending id order
    for (const [i, id] of queued.entries()) expect((await fill(id, i + 1)).state).toBe("waiting");

    let current = holder;
    for (const expected of queued) {
      expect(value(await w.main.releaseSlot(current))).toEqual({ next: expected });
      expect(await w.main.releaseSlot(current)).toEqual({ ok: false, reason: "not_holding" });
      expect(await w.raw("slots/public-0")).toEqual({ lobbyId: expected });
      expect(value(await w.main.readLobby(expected))).toMatchObject({ state: "holding", slot: "public-0" });
      // The ended lobby no longer reports the slot its successor now holds.
      expect(value(await w.main.readLobby(current))).toMatchObject({ state: "ended", slot: null });
      current = expected;
    }
    expect(value(await w.main.releaseSlot(current))).toEqual({ next: null });
    expect(await w.raw("slots/public-0")).toBeNull();
    // With no successor the slot document is gone and the ended lobby reports no slot.
    expect(value(await w.main.readLobby(current))).toMatchObject({ state: "ended", slot: null });
    expect(await w.main.releaseSlot(current)).toEqual({ ok: false, reason: "not_holding" });
    expect(await w.main.releaseSlot("no-such-lobby")).toEqual({ ok: false, reason: "not_holding" });
  });

  it("lets only one of two instances take a slot when two lobbies fill at once", { timeout: RACE_TIMEOUT }, async () => {
    for (let round = 0; round < 2; round++) {
      const w = world();
      const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
      const one = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
      const two = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
      value(await w.main.join(one.id, a!.key));
      value(await w.main.join(two.id, d!.key));
      const wrap = barrier(2);
      const results = await Promise.all([w.lobbies(wrap()).join(one.id, b!.key), w.lobbies(wrap()).join(two.id, e!.key)]);
      const states = results.map((result) => value(result).state).sort();
      expect(states).toEqual(["holding", "waiting"]);
      const holderId = results.map(value).find((lobby) => lobby.state === "holding")!.id;
      const waiterId = holderId === one.id ? two.id : one.id;
      expect(await w.raw("slots/public-0")).toEqual({ lobbyId: holderId });
      expect((await w.raw("queues/public"))?.lobbies).toBe(waiterId);
    }
  });

  it("keeps one holder when a release races a lobby filling on another instance", { timeout: RACE_TIMEOUT }, async () => {
    const w = world();
    const [c, a, b, d, e] = await Promise.all(["Cre", "Ann", "Bob", "Dee", "Eve"].map(w.keyFor));
    const holder = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(holder.id, a!.key));
    value(await w.main.join(holder.id, b!.key));
    const filling = value(await w.main.createLobby(c!.key, "public", 1)).lobby;
    value(await w.main.join(filling.id, d!.key));
    const wrap = barrier(2);
    const [released, joined] = await Promise.all([w.lobbies(wrap()).releaseSlot(holder.id), w.lobbies(wrap()).join(filling.id, e!.key)]);
    value(released);
    value(joined);
    expect(value(await w.main.readLobby(holder.id)).state).toBe("ended");
    expect(value(await w.main.readLobby(filling.id))).toMatchObject({ state: "holding", slot: "public-0" });
    expect(await w.raw("slots/public-0")).toEqual({ lobbyId: filling.id });
  });

  it("reads a lobby's kind, size, state, rated mark, slot and seats by colony with display names, and no invite secret", async () => {
    const w = world();
    const kay = await w.keyFor("Kite");
    const scout = value(await w.ids.createHandle(kay.key, "Scout"));
    const ann = await w.keyFor("Ann");
    const { lobby, inviteToken } = value(await w.main.createLobby(kay.key, "private", 1));
    value(await w.main.join(lobby.id, scout.key, inviteToken));
    value(await w.main.join(lobby.id, ann.key, inviteToken));
    const read = value(await w.main.readLobby(lobby.id));
    expect(read).toEqual({
      id: lobby.id, kind: "private", size: 1, state: "holding", rated: false, slot: "private-0",
      creatorId: kay.identity.id, createdAt: w.clock.t, expiresAt: w.clock.t + LOBBY_TTL_MS,
      colonies: [[{ id: scout.identity.id, displayName: "Kite/Scout" }], [{ id: ann.identity.id, displayName: "Ann" }]],
      startsAt: w.clock.t + COUNTDOWN_MS, outcome: null, mode: null,
    });
    const stored = await w.raw(`lobbies/${lobby.id}`);
    expect(JSON.stringify(read)).not.toContain(stored!.inviteVerifier!);
    expect(JSON.stringify(read)).not.toContain(inviteToken!);
    for (const key of [kay.key, scout.key, ann.key]) expect(JSON.stringify(stored)).not.toContain(key);
    expect(await w.main.readLobby("no-such-lobby")).toEqual({ ok: false, reason: "no_such_lobby" });
  });

  // Match slots.
  const instance = (runId: string) => ({ runId, mcpUrl: `http://${runId}.test/mcp`, spectatorUrl: `http://${runId}.test/` });

  async function fullLobby(w: ReturnType<typeof world>, kind: "public" | "private", size: 1 | 2 | 3 | 4, names: readonly string[]) {
    const keys = await Promise.all(names.map(w.keyFor));
    const { lobby, inviteToken } = value(await w.main.createLobby(keys[0]!.key, kind, size));
    let last = lobby;
    for (const key of keys.slice(0, 2 * size)) last = value(await w.main.join(lobby.id, key.key, inviteToken));
    return { lobby: last, keys };
  }

  // Player-created lobbies are never rated; only queue-made matches are.
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "leaves different-owner 1v1s unrated, including antwars (house handle: %s, opponent handle: %s)",
    async (houseHandle, opponentHandle) => {
      const w = world();
      const house = await w.keyFor("antwars");
      const opponent = await w.keyFor("Opponent");
      const a = houseHandle ? value(await w.ids.createHandle(house.key, "scout")) : house;
      const b = opponentHandle ? value(await w.ids.createHandle(opponent.key, "scout")) : opponent;
      await w.main.registerInstance("public-0", instance("owners"));
      const { lobby } = value(await w.main.createLobby(house.key, "public", 1));
      expect(lobby.rated).toBeNull();
      expect(value(await w.main.join(lobby.id, a.key)).rated).toBeNull();
      const full = value(await w.main.join(lobby.id, b.key));
      expect(full).toMatchObject({ rated: false, state: "holding" });
      expect((await w.raw(`lobbies/${lobby.id}`))?.rated).toBe("false");
      value(await w.main.beginMatch(lobby.id, "public-0", "owners"));
      value(await w.main.endMatch(lobby.id, "owners", "colony_0_won"));
      expect(await w.raw(`ratedMatches/${lobby.id}`)).toBeNull();
      // No mode moves, including 1v1, which a rated lobby without a mode is rated in.
      for (const mode of [undefined, ...RANKED_MODES]) {
        for (const seat of [a, b]) expect(await w.ratings.readRating(seat.identity.id, mode)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
      }
    },
  );

  // The per-mode 1v1 rating of a rated lobby's natural result, on lobbies marked
  // rated in the store as a queue-made match would be, since player-created ones are unrated.
  it("rates a rated 1v1 lobby's natural result in 1v1 only, and a rematch from unequal ratings", async () => {
    const w = world();
    const a = await w.keyFor("Ann");
    const b = await w.keyFor("Bob");
    await w.main.registerInstance("public-0", instance("owners"));
    const play = async (first: typeof a, second: typeof a) => {
      const { lobby } = value(await w.main.createLobby(first.key, "public", 1));
      value(await w.main.join(lobby.id, first.key));
      expect(value(await w.main.join(lobby.id, second.key))).toMatchObject({ rated: false, state: "holding", mode: null });
      await w.markRated(lobby.id);
      value(await w.main.beginMatch(lobby.id, "public-0", "owners"));
      value(await w.main.endMatch(lobby.id, "owners", "colony_0_won"));
    };
    await play(a, b);
    // The natural result is a 1v1 result: Glicko-1 from 1500 ± 350, in 1v1 only.
    for (const mode of [undefined, "1v1"] as const) {
      expect(await w.ratings.readRating(a.identity.id, mode)).toEqual({ ...FIRST_WIN, ratedMatches: 1 });
      expect(await w.ratings.readRating(b.identity.id, mode)).toEqual({ ...FIRST_LOSS, ratedMatches: 1 });
    }
    // A rematch from unequal ratings: each side by Glicko-1 against the other (moments later, so RD growth is negligible).
    await play(b, a);
    const expected = (own: { rating: number; rd: number }, opponent: { rating: number; rd: number }, score: number) =>
      glickoUpdate(own, [{ ...opponent, score }]);
    for (const [seat, own, opponent, score] of [[b, FIRST_LOSS, FIRST_WIN, 1], [a, FIRST_WIN, FIRST_LOSS, 0]] as const) {
      const now = await w.ratings.readRating(seat.identity.id, "1v1");
      expect(now.rating).toBeCloseTo(expected(own, opponent, score).rating, 6);
      expect(now.rd).toBeCloseTo(expected(own, opponent, score).rd, 6);
      expect(now.ratedMatches).toBe(2);
    }
    for (const mode of ["2v2", "3v3", "4v4"] as const) {
      for (const seat of [a, b]) expect(await w.ratings.readRating(seat.identity.id, mode)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    }
  });

  it.each([
    ["public", 1], ["public", 2], ["public", 3], ["public", 4],
    ["private", 1], ["private", 2], ["private", 3], ["private", 4],
  ] as const)("starts a player-created %s size-%s lobby unrated, full or started early, and its natural result changes no rating", async (kind, size) => {
    const w = world();
    const slot = `${kind}-0`;
    await w.main.registerInstance(slot, instance("players"));
    const play = async (lobbyId: string, outcome: "colony_0_won" | "colony_1_won") => {
      value(await w.main.beginMatch(lobbyId, slot, "players"));
      value(await w.main.endMatch(lobbyId, "players", outcome));
      expect(value(await w.main.readLobby(lobbyId))).toMatchObject({ outcome, rated: false });
      expect(await w.raw(`ratedMatches/${lobbyId}`)).toBeNull();
    };
    // Every seat a different owner: the pairing that is rated.
    const full = await fullLobby(w, kind, size, Array.from({ length: size * 2 }, (_, i) => `Full${i}`));
    expect(full.lobby).toMatchObject({ rated: false, state: "holding", slot });
    expect(seatCounts(full.lobby)).toEqual([size, size]);
    expect((await w.raw(`lobbies/${full.lobby.id}`))?.rated).toBe("false");
    await play(full.lobby.id, "colony_1_won");
    const seated = [...full.keys];
    if (size > 1) {
      // Not full: the creator starts early with one seat in each colony.
      const keys = await Promise.all(["Early0", "Early1"].map(w.keyFor));
      const { lobby, inviteToken } = value(await w.main.createLobby(keys[0]!.key, kind, size));
      for (const key of keys) value(await w.main.join(lobby.id, key.key, inviteToken));
      const early = value(await w.main.startEarly(lobby.id, keys[0]!.key));
      expect(early).toMatchObject({ rated: false, state: "holding", slot });
      expect(seatCounts(early)).toEqual([1, 1]);
      await play(lobby.id, "colony_0_won");
      seated.push(...keys);
    }
    for (const key of seated) {
      for (const mode of [undefined, ...RANKED_MODES]) expect(await w.ratings.readRating(key.identity.id, mode)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    }
  });

  it.each(["Kite", "antwars"])("never rates same-owner pairs under %s, in public or private lobbies", async (ownerName) => {
    const w = world();
    const owner = await w.keyFor(ownerName);
    const a = value(await w.ids.createHandle(owner.key, "scout"));
    const b = value(await w.ids.createHandle(owner.key, "guard"));
    for (const kind of ["public", "private"] as const) {
      const slot = `${kind}-0`;
      await w.main.registerInstance(slot, instance("same-owner"));
      // Owner/handle in both orders, and two sibling handles.
      for (const pair of [[owner, a], [a, owner], [a, b]] as const) {
        const { lobby, inviteToken } = value(await w.main.createLobby(owner.key, kind, 1));
        value(await w.main.join(lobby.id, pair[0].key, inviteToken));
        const full = value(await w.main.join(lobby.id, pair[1].key, inviteToken));
        expect(full).toMatchObject({ rated: false, state: "holding" });
        expect((await w.raw(`lobbies/${lobby.id}`))?.rated).toBe("false");
        value(await w.main.beginMatch(lobby.id, slot, "same-owner"));
        value(await w.main.endMatch(lobby.id, "same-owner", "colony_0_won"));
        expect(value(await w.main.readLobby(lobby.id))).toMatchObject({ outcome: "colony_0_won", rated: false });
        expect(await w.raw(`ratedMatches/${lobby.id}`)).toBeNull();
        for (const seat of pair) {
          expect(await w.ratings.readRating(seat.identity.id)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
          expect(await w.raw(`ratings/${seat.identity.id}`)).toBeNull();
        }
      }
    }
  });

  it("keeps a same-owner 1v1 unrated while waiting and after it takes the slot", async () => {
    const w = world();
    const first = (await fullLobby(w, "public", 1, ["First", "Second"])).lobby;
    const owner = await w.keyFor("antwars");
    const handle = value(await w.ids.createHandle(owner.key, "scout"));
    const { lobby } = value(await w.main.createLobby(owner.key, "public", 1));
    value(await w.main.join(lobby.id, owner.key));
    expect(value(await w.main.join(lobby.id, handle.key))).toMatchObject({ state: "waiting", rated: false, slot: null });
    value(await w.main.releaseSlot(first.id));
    expect(value(await w.main.readLobby(lobby.id))).toMatchObject({ state: "holding", rated: false, slot: "public-0" });
    await w.main.registerInstance("public-0", instance("queued"));
    value(await w.main.beginMatch(lobby.id, "public-0", "queued"));
    value(await w.main.endMatch(lobby.id, "queued", "draw"));
    expect(await w.raw(`ratedMatches/${lobby.id}`)).toBeNull();
    for (const seat of [owner, handle]) expect(await w.ratings.readRating(seat.identity.id)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
  });

  it("starts the countdown on every take of a slot: when a lobby fills, and when a waiting lobby is handed the slot", async () => {
    const w = world();
    await w.main.registerInstance("public-0", instance("a"));
    const first = (await fullLobby(w, "public", 1, ["A1", "A2"])).lobby;
    expect(first).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS, outcome: null });
    expect(value(await w.main.readLobby(first.id)).startsAt).toBe(w.clock.t + COUNTDOWN_MS);
    const second = (await fullLobby(w, "public", 1, ["B1", "B2"])).lobby;
    expect(second).toMatchObject({ state: "waiting", startsAt: null });
    w.clock.t += 60_000;
    value(await w.main.beginMatch(first.id, "public-0", "a"));
    expect(value(await w.main.endMatch(first.id, "a", "colony_0_won"))).toEqual({ next: second.id });
    expect(value(await w.main.readLobby(second.id))).toMatchObject({ state: "holding", slot: "public-0", startsAt: w.clock.t + COUNTDOWN_MS });
    expect(await w.main.slotHolder("public-0")).toMatchObject({ lobbyId: second.id, startsAt: w.clock.t + COUNTDOWN_MS, matchRunId: null });
  });

  it("lets only the slot's last registered instance begin and end its match; a successor ends a replaced match not played and unrated", async () => {
    const w = world();
    await w.main.registerInstance("public-0", instance("old"));
    const { lobby, keys } = await fullLobby(w, "public", 1, ["C1", "C2"]);
    await w.markRated(lobby.id);
    expect(value(await w.main.readLobby(lobby.id)).rated).toBe(true);
    expect(await w.main.beginMatch(lobby.id, "public-0", "stranger")).toEqual({ ok: false, reason: "superseded" });
    value(await w.main.beginMatch(lobby.id, "public-0", "old"));
    expect(await w.main.beginMatch(lobby.id, "public-0", "old")).toEqual({ ok: false, reason: "started" });
    expect(await w.main.slotHolder("public-0")).toMatchObject({ lobbyId: lobby.id, matchRunId: "old" });
    // The successor boots: the old run can no longer end, release or rate the match, even with a natural result.
    await w.main.registerInstance("public-0", instance("new"));
    expect(await w.main.resolveSlot("public-0")).toEqual(instance("new"));
    expect(await w.main.endMatch(lobby.id, "old", "colony_0_won")).toEqual({ ok: false, reason: "superseded" });
    expect(await w.main.endMatch(lobby.id, "old", "not_played")).toEqual({ ok: false, reason: "superseded" });
    // Nor can the successor claim a natural result for a match it did not begin.
    expect(await w.main.endMatch(lobby.id, "new", "colony_0_won")).toEqual({ ok: false, reason: "superseded" });
    expect(value(await w.main.endMatch(lobby.id, "new", "not_played"))).toEqual({ next: null });
    expect(value(await w.main.readLobby(lobby.id))).toMatchObject({ state: "ended", slot: null, outcome: "not_played" });
    expect(await w.raw("slots/public-0")).toBeNull();
    for (const key of keys) expect((await w.ratings.readRating(key.identity.id)).ratedMatches).toBe(0);
    expect(await w.main.endMatch(lobby.id, "new", "not_played")).toEqual({ ok: false, reason: "not_holding" });
  });

  it("rates a rated lobby's natural result with its outcome in one commit, every seat by its colony, and no other ending", async () => {
    const w = world({ publicSlots: 1, privateSlots: 1 });
    await w.main.registerInstance("public-0", instance("p"));
    await w.main.registerInstance("private-0", instance("q"));
    const won = await fullLobby(w, "public", 1, ["D1", "D2"]);
    await w.markRated(won.lobby.id);
    value(await w.main.beginMatch(won.lobby.id, "public-0", "p"));
    value(await w.main.endMatch(won.lobby.id, "p", "colony_1_won"));
    expect(value(await w.main.readLobby(won.lobby.id)).outcome).toBe("colony_1_won");
    const [colony0, colony1] = won.lobby.colonies.map((seats) => seats.map((seat) => seat.id));
    for (const id of colony0!) expect(await w.ratings.readRating(id)).toEqual({ ...FIRST_LOSS, ratedMatches: 1 });
    for (const id of colony1!) expect(await w.ratings.readRating(id)).toEqual({ ...FIRST_WIN, ratedMatches: 1 });
    const changes = [
      ...colony0!.map((identityId) => ({ identityId, before: 1500, after: FIRST_LOSS.rating, rdBefore: 350, rdAfter: FIRST_LOSS.rd })),
      ...colony1!.map((identityId) => ({ identityId, before: 1500, after: FIRST_WIN.rating, rdBefore: 350, rdAfter: FIRST_WIN.rd })),
    ];
    expect(await w.raw(`ratedMatches/${won.lobby.id}`)).toEqual({ changes: JSON.stringify(changes) });
    expect(await w.ratings.readMatchChanges(won.lobby.id)).toEqual(changes);

    // A draw scores 0.5 each; a stopped rated lobby and an early-started one change nothing.
    const drawn = await fullLobby(w, "public", 1, ["E1", "E2"]);
    await w.markRated(drawn.lobby.id);
    value(await w.main.beginMatch(drawn.lobby.id, "public-0", "p"));
    value(await w.main.endMatch(drawn.lobby.id, "p", "draw"));
    // Equal players drawing keep exactly 1500; their RD shrinks as after any first result.
    for (const key of drawn.keys) expect(await w.ratings.readRating(key.identity.id)).toEqual({ rating: 1500, rd: FIRST_WIN.rd, ratedMatches: 1 });
    const stopped = await fullLobby(w, "private", 1, ["F1", "F2"]);
    await w.markRated(stopped.lobby.id);
    value(await w.main.beginMatch(stopped.lobby.id, "private-0", "q"));
    value(await w.main.endMatch(stopped.lobby.id, "q", "stopped"));
    expect(value(await w.main.readLobby(stopped.lobby.id)).outcome).toBe("stopped");
    const early = await Promise.all(["G1", "G2", "G3"].map(w.keyFor));
    const { lobby: open } = value(await w.main.createLobby(early[0]!.key, "public", 2));
    for (const key of early.slice(1)) value(await w.main.join(open.id, key.key));
    expect(value(await w.main.startEarly(open.id, early[0]!.key)).rated).toBe(false);
    value(await w.main.beginMatch(open.id, "public-0", "p"));
    value(await w.main.endMatch(open.id, "p", "colony_0_won"));
    for (const key of [...stopped.keys, ...early]) expect((await w.ratings.readRating(key.identity.id)).ratedMatches).toBe(0);
  });

  it("resolves a lobby to its slot, the slot instance's mcpUrl and the lobby's antwars.ai page, null until it holds a slot", async () => {
    const w = world();
    await w.main.registerInstance("public-0", instance("r"));
    const [a, b, c] = await Promise.all(["H1", "H2", "H3"].map(w.keyFor));
    const { lobby } = value(await w.main.createLobby(a!.key, "public", 1));
    expect(value(await w.main.locate(lobby.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });
    value(await w.main.join(lobby.id, b!.key));
    value(await w.main.join(lobby.id, c!.key));
    expect(value(await w.main.locate(lobby.id))).toEqual({ slot: "public-0", mcpUrl: "http://r.test/mcp", spectatorUrl: `https://antwars.ai/?lobby=${lobby.id}` });
    value(await w.main.endMatch(lobby.id, "r", "not_played"));
    expect(value(await w.main.locate(lobby.id))).toEqual({ slot: null, mcpUrl: null, spectatorUrl: null });
    for (const id of ["no-such-lobby", "../slots/public-0", "00000000-0000-4000-8000-000000000000"]) {
      expect(await w.main.locate(id)).toEqual({ ok: false, reason: "no_such_lobby" });
    }
  });
});

function ids(list: string | undefined): string[] {
  return (list ?? "").split(" ").filter(Boolean);
}
