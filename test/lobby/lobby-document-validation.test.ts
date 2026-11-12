// Lobby documents read back as lobbies. The characterization block pins how readLobby,
// listPublic and join read well-formed lobby documents today, before validation on read was added; it must pass
// unchanged afterwards. Runs on an in-memory store, as test/lobby/lobby-unstarted.test.ts does.
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { COUNTDOWN_MS, createLobbies, LOBBY_TTL_MS } from "../../src/lobby/lobbies.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";
import type { Fields, Store } from "../../src/store/firestore.ts";

function memoryStore(): Store & { readonly docs: Map<string, Fields> } {
  const docs = new Map<string, Fields>();
  return {
    docs,
    namespace: "lobby-document-test",
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
    async query() { throw new Error("these reads must not query collections"); },
  };
}

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

const START = Date.parse("2026-11-03T00:00:00Z");

function world() {
  const store = memoryStore();
  const clock = { t: START };
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock.t, random: () => 0 });
  const player = async (name: string) => value(await identities.claimUsername(name));
  /** Writes a lobby document as an operator or deploy script would, listed publicly when public. */
  const writeLobby = (id: string, fields: Fields) => {
    store.docs.set(`lobbies/${id}`, fields);
    if (fields.kind === "public") {
      const listed = store.docs.get("listings/public")?.lobbies ?? "";
      store.docs.set("listings/public", { lobbies: [listed, id].filter(Boolean).join(" ") });
    }
  };
  return { store, clock, lobbies, player, writeLobby };
}

const OPERATOR_ID = "0b6f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
/** A well-formed open public lobby of size 2 with one seat in each colony, as createLobby and join write it. */
const operatorLobby = (createdAt: number, seat0: { id: string; displayName: string }, seat1: { id: string; displayName: string }): Fields => ({
  kind: "public", size: "2", creatorId: seat0.id, createdAt: String(createdAt), state: "open",
  rated: "", slot: "", seats: JSON.stringify([{ ...seat0, colony: 0 }, { ...seat1, colony: 1 }]), inviteVerifier: "",
  startsAt: "", matchRunId: "", outcome: "", mode: "",
});

describe("well-formed lobby documents (characterization)", () => {
  it("readLobby returns every field of an open public, an open private and a directly written lobby", async () => {
    const w = world();
    const [ann, bob, cat] = await Promise.all(["ann", "bob", "cat"].map(w.player));
    const open = value(await w.lobbies.createLobby(ann!.key, "public", 2)).lobby;
    value(await w.lobbies.join(open.id, ann!.key));
    const { lobby: hidden } = value(await w.lobbies.createLobby(bob!.key, "private", 1));
    w.writeLobby(OPERATOR_ID, operatorLobby(START, bob!.identity, cat!.identity));

    expect(value(await w.lobbies.readLobby(open.id))).toEqual({
      id: open.id, kind: "public", size: 2, state: "open", rated: null, slot: null, creatorId: ann!.identity.id,
      createdAt: START, expiresAt: START + LOBBY_TTL_MS, colonies: [[{ id: ann!.identity.id, displayName: ann!.identity.displayName }], []],
      startsAt: null, outcome: null, mode: null, colonyNames: drawColonyNames(open.id),
    });
    expect(value(await w.lobbies.readLobby(hidden.id))).toEqual({
      id: hidden.id, kind: "private", size: 1, state: "open", rated: null, slot: null, creatorId: bob!.identity.id,
      createdAt: START, expiresAt: START + LOBBY_TTL_MS, colonies: [[], []], startsAt: null, outcome: null, mode: null,
      colonyNames: drawColonyNames(hidden.id),
    });
    expect(value(await w.lobbies.readLobby(OPERATOR_ID))).toEqual({
      id: OPERATOR_ID, kind: "public", size: 2, state: "open", rated: null, slot: null, creatorId: bob!.identity.id,
      createdAt: START, expiresAt: START + LOBBY_TTL_MS,
      colonies: [[{ id: bob!.identity.id, displayName: bob!.identity.displayName }], [{ id: cat!.identity.id, displayName: cat!.identity.displayName }]],
      startsAt: null, outcome: null, mode: null, colonyNames: drawColonyNames(OPERATOR_ID),
    });
    expect(await w.lobbies.readLobby("no-such-lobby")).toEqual({ ok: false, reason: "no_such_lobby" });
  });

  it("a full lobby holds the free slot, the next full one waits, and a further join is refused full", async () => {
    const w = world();
    const [ann, bob, cat, dan, eve] = await Promise.all(["ann", "bob", "cat", "dan", "eve"].map(w.player));
    const first = value(await w.lobbies.createLobby(ann!.key, "public", 1)).lobby;
    value(await w.lobbies.join(first.id, ann!.key));
    const held = value(await w.lobbies.join(first.id, bob!.key));
    const second = value(await w.lobbies.createLobby(cat!.key, "public", 1)).lobby;
    value(await w.lobbies.join(second.id, cat!.key));
    value(await w.lobbies.join(second.id, dan!.key));

    expect(held).toMatchObject({ state: "holding", slot: "public-0", rated: false, startsAt: START + COUNTDOWN_MS });
    expect(value(await w.lobbies.readLobby(first.id))).toEqual({
      id: first.id, kind: "public", size: 1, state: "holding", rated: false, slot: "public-0", creatorId: ann!.identity.id,
      createdAt: START, expiresAt: START + LOBBY_TTL_MS,
      colonies: [[{ id: ann!.identity.id, displayName: ann!.identity.displayName }], [{ id: bob!.identity.id, displayName: bob!.identity.displayName }]],
      startsAt: START + COUNTDOWN_MS, outcome: null, mode: null, colonyNames: drawColonyNames(first.id),
    });
    expect(value(await w.lobbies.readLobby(second.id))).toMatchObject({ state: "waiting", rated: false, slot: null, startsAt: null });
    expect(await w.lobbies.join(first.id, eve!.key)).toEqual({ ok: false, reason: "full" });
    expect(await w.lobbies.join(second.id, eve!.key)).toEqual({ ok: false, reason: "full" });
  });

  it("listPublic lists open, waiting and holding public lobbies oldest first, never private, expired or ended ones", async () => {
    const w = world();
    const [ann, bob, cat, dan, eve, fay] = await Promise.all(["ann", "bob", "cat", "dan", "eve", "fay"].map(w.player));
    const stale = value(await w.lobbies.createLobby(ann!.key, "public", 2)).lobby;
    w.clock.t += LOBBY_TTL_MS;
    const at = w.clock.t;
    value(await w.lobbies.createLobby(ann!.key, "private", 1));
    const ending = value(await w.lobbies.createLobby(ann!.key, "public", 1)).lobby;
    value(await w.lobbies.join(ending.id, ann!.key));
    value(await w.lobbies.join(ending.id, bob!.key));
    const holding = value(await w.lobbies.createLobby(cat!.key, "public", 1)).lobby;
    value(await w.lobbies.join(holding.id, cat!.key));
    value(await w.lobbies.join(holding.id, dan!.key));
    const waiting = value(await w.lobbies.createLobby(eve!.key, "public", 1)).lobby;
    value(await w.lobbies.join(waiting.id, eve!.key));
    value(await w.lobbies.join(waiting.id, fay!.key));
    const open = value(await w.lobbies.createLobby(fay!.key, "public", 2)).lobby;
    w.writeLobby(OPERATOR_ID, operatorLobby(at, ann!.identity, bob!.identity));

    expect(value(await w.lobbies.readLobby(stale.id)).state).toBe("expired");
    value(await w.lobbies.releaseSlot(ending.id));
    expect(value(await w.lobbies.readLobby(ending.id)).state).toBe("ended");

    const listed = await w.lobbies.listPublic();
    expect(listed.map((lobby) => [lobby.id, lobby.state, lobby.slot])).toEqual([
      [holding.id, "holding", "public-0"], [waiting.id, "waiting", null], [open.id, "open", null], [OPERATOR_ID, "open", null],
    ]);
    expect(listed.at(-1)).toEqual(value(await w.lobbies.readLobby(OPERATOR_ID)));
  });
});

describe("malformed lobby documents fail with an error naming the document", () => {
  const cases: readonly { readonly name: string; readonly fields: Fields; readonly field: string; readonly stored: string }[] = [
    { name: "unparseable seats JSON", fields: { seats: "[{" }, field: "seats", stored: "[{" },
    { name: "seats that are not an array", fields: { seats: "{}" }, field: "seats", stored: "{}" },
    { name: "a seat in no colony", fields: { seats: JSON.stringify([{ id: "a1", displayName: "a", colony: 2 }]) }, field: "seats", stored: JSON.stringify([{ id: "a1", displayName: "a", colony: 2 }]) },
    { name: "an unknown kind", fields: { kind: "secret" }, field: "kind", stored: "secret" },
    { name: "an unknown state", fields: { state: "paused" }, field: "state", stored: "paused" },
    { name: "a non-numeric size", fields: { size: "two" }, field: "size", stored: "two" },
  ];

  for (const { name, fields, field, stored } of cases) {
    it(`${name}: readLobby, join and listPublic each throw it`, async () => {
      const w = world();
      const [ann, bob, cat] = await Promise.all(["ann", "bob", "cat"].map(w.player));
      const good = value(await w.lobbies.createLobby(ann!.key, "public", 2)).lobby;
      w.writeLobby(OPERATOR_ID, { ...operatorLobby(START, ann!.identity, bob!.identity), ...fields });
      // Listed publicly whatever its stored kind, as a hand-edited document stays listed.
      w.store.docs.set("listings/public", { lobbies: `${good.id} ${OPERATOR_ID}` });
      const error = new Error(`malformed lobby document lobbies/${OPERATOR_ID}: ${field} ${JSON.stringify(stored)}`);

      await expect(w.lobbies.readLobby(OPERATOR_ID)).rejects.toThrow(error);
      await expect(w.lobbies.join(OPERATOR_ID, cat!.key)).rejects.toThrow(error);
      await expect(w.lobbies.listPublic()).rejects.toThrow(error);
      expect(w.store.docs.get(`lobbies/${OPERATOR_ID}`)).toEqual({ ...operatorLobby(START, ann!.identity, bob!.identity), ...fields });
      expect(value(await w.lobbies.readLobby(good.id)).state).toBe("open");
    });
  }

  it("a missing size is malformed too, so join can never compare against a NaN capacity", async () => {
    const w = world();
    const [ann, bob, cat] = await Promise.all(["ann", "bob", "cat"].map(w.player));
    const { size: _size, ...sizeless } = operatorLobby(START, ann!.identity, bob!.identity);
    w.writeLobby(OPERATOR_ID, sizeless);
    await expect(w.lobbies.join(OPERATOR_ID, cat!.key)).rejects.toThrow(new Error(`malformed lobby document lobbies/${OPERATOR_ID}: size null`));
    expect(w.store.docs.get(`lobbies/${OPERATOR_ID}`)?.seats).toBe(sizeless.seats);
  });
});
