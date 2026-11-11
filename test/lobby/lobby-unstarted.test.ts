// The Waiting card's lobby read: Lobbies.listUnstarted lists every public lobby with a seated agent whose match
// has not begun — a player-created lobby that is open, waiting for a slot or counting down, and a queue pairing waiting
// for or holding a slot — and never a private lobby. A row leaves once its slot's instance begins the match.
import { describe, expect, it } from "vitest";
import { createIdentities, type Identities } from "../../src/identity/identities.ts";
import { createLobbies, LOBBY_TTL_MS } from "../../src/lobby/lobbies.ts";
import type { Fields, Store } from "../../src/store/firestore.ts";

function memoryStore(): Store {
  const docs = new Map<string, Fields>();
  return {
    namespace: "unstarted-test",
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
    async query() { throw new Error("listUnstarted must not query collections"); },
  };
}

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

const START = Date.parse("2026-10-31T00:00:00Z");

function world() {
  const store = memoryStore();
  const clock = { t: START };
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => clock.t, random: () => 0 });
  const owner = async (name: string) => value(await identities.claimUsername(name));
  return { store, clock, lobbies, owner };
}

const names = (rows: readonly { colonies: readonly (readonly { displayName: string }[])[] }[]) =>
  rows.map(row => row.colonies.map(colony => colony.map(seat => seat.displayName)));

describe("Lobbies.listUnstarted", () => {
  it("lists seated public lobbies and queue pairings not yet begun, oldest first, and never a private or empty lobby", async () => {
    const w = world();
    const [ann, bob, cat, dan, eve, fay, gus, hal] = await Promise.all(["ann", "bob", "cat", "dan", "eve", "fay", "gus", "hal"].map(w.owner));

    // An empty public lobby is not shown.
    value(await w.lobbies.createLobby(ann!.key, "public", 2));
    w.clock.t += 1_000;
    const open = value(await w.lobbies.createLobby(ann!.key, "public", 2)).lobby;
    for (const player of [ann!, bob!, cat!]) value(await w.lobbies.join(open.id, player.key));
    // A seated private lobby is never shown.
    w.clock.t += 1_000;
    const hidden = value(await w.lobbies.createLobby(hal!.key, "private", 1));
    value(await w.lobbies.join(hidden.lobby.id, hal!.key, hidden.inviteToken));

    // A 1v1 pairing takes the one public slot and counts down; a 2v2 pairing then waits for it.
    w.clock.t += 1_000; value(await w.lobbies.joinQueue(dan!.key, "1v1"));
    const holding = value(await w.lobbies.joinQueue(eve!.key, "1v1"));
    w.clock.t += 1_000; value(await w.lobbies.joinQueue(fay!.key, "2v2"));
    value(await w.lobbies.joinQueue(gus!.key, "2v2"));

    const listed = await w.lobbies.listUnstarted();
    expect(listed.map(row => [row.mode, row.size, row.seated])).toEqual([[null, 2, 3], ["1v1", 1, 2], ["2v2", 2, 4]]);
    // Each identity once per colony, though a queue pairing's identity holds every seat of its colony.
    expect(names(listed)).toEqual([[["ann", "cat"], ["bob"]], [["dan"], ["eve"]], [["fay"], ["gus"]]]);
    // With how many of its colony's seats each holds: one each in a player-made lobby, every seat in a queue pairing.
    expect(listed.map(row => row.colonies.map(colony => colony.map(seat => seat.seats)))).toEqual([[[1, 1], [1]], [[1], [1]], [[2], [2]]]);
    expect(JSON.stringify(listed)).not.toContain("hal");

    // Once the slot's instance begins the 1v1 match, it leaves the list; the waiting 2v2 pairing stays.
    if (holding.state !== "matched") throw new Error("expected a pairing");
    await w.lobbies.registerInstance("public-0", { runId: "run-1", mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" });
    value(await w.lobbies.beginMatch(holding.lobbyId, "public-0", "run-1"));
    expect((await w.lobbies.listUnstarted()).map(row => row.mode)).toEqual([null, "2v2"]);

    // A player-created lobby expires 12 hours after creation; a queue pairing never does.
    w.clock.t = open.createdAt + LOBBY_TTL_MS;
    expect((await w.lobbies.listUnstarted()).map(row => row.mode)).toEqual(["2v2"]);
  });

  it("lists a full player-created lobby counting down in its slot, until its match begins", async () => {
    const w = world();
    const [ann, bob] = await Promise.all(["ann", "bob"].map(w.owner));
    const lobby = value(await w.lobbies.createLobby(ann!.key, "public", 1)).lobby;
    value(await w.lobbies.join(lobby.id, ann!.key));
    expect(value(await w.lobbies.join(lobby.id, bob!.key)).state).toBe("holding");
    expect((await w.lobbies.listUnstarted()).map(row => [row.mode, row.seated])).toEqual([[null, 2]]);
    await w.lobbies.registerInstance("public-0", { runId: "run-1", mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" });
    value(await w.lobbies.beginMatch(lobby.id, "public-0", "run-1"));
    expect(await w.lobbies.listUnstarted()).toEqual([]);
  });
});

// Hand-laid documents: a queue pairing holding public-0 just after a slot handoff, seated under the names
// stored when it was paired.
describe("Lobbies.listUnstarted over stored documents", () => {
  const PAIRED = "0eb7a998-0000-4000-8000-0000000000a1", OLD = "0eb7a998-0000-4000-8000-0000000000a0";
  const FIRST = "0eb7a998-0000-4000-8000-000000000001", BEA = "0eb7a998-0000-4000-8000-000000000002", GONE = "0eb7a998-0000-4000-8000-000000000003";
  const seats = JSON.stringify([
    { id: FIRST, displayName: "sam/first", colony: 0 }, { id: GONE, displayName: "gone", colony: 0 },
    { id: BEA, displayName: "bea", colony: 1 }, { id: BEA, displayName: "bea", colony: 1 },
  ]);
  // After the handoff: the pairing holds public-0 and has left queues/public; the previous holder has ended.
  const after = new Map<string, Fields>([
    ["slots/public-0", { lobbyId: PAIRED }],
    ["queues/public", { lobbies: "" }],
    [`lobbies/${PAIRED}`, { kind: "public", size: "2", creatorId: FIRST, createdAt: String(START), state: "holding", rated: "true", slot: "public-0",
      seats, inviteVerifier: "", startsAt: String(START + 10_000), matchRunId: "", outcome: "", mode: "2v2" }],
    [`lobbies/${OLD}`, { kind: "public", size: "1", creatorId: BEA, createdAt: String(START - 600_000), state: "ended", rated: "true", slot: "",
      seats: "[]", inviteVerifier: "", startsAt: "", matchRunId: "run-0", outcome: "draw", mode: "1v1" }],
  ]);
  // What a separate read of public-0 taken before the handoff saw: the previous holder.
  const before = new Map<string, Fields>([["slots/public-0", { lobbyId: OLD }], ["queues/public", { lobbies: PAIRED }]]);
  const store = {
    namespace: "unstarted-docs",
    // Separate reads interleaved with the handoff: public-0 before it, queues/public after it.
    async get(path: string) { return path === "slots/public-0" ? before.get(path)! : after.get(path) ?? null; },
    async transaction(step: (read: (paths: string[]) => Promise<Map<string, Fields | null>>) => Promise<{ result: unknown; writes: unknown[] }>) {
      const next = await step(async paths => new Map(paths.map(path => [path, after.get(path) ?? null])));
      if (next.writes.length > 0) throw new Error("listUnstarted must write nothing");
      return next.result;
    },
    async query() { throw new Error("listUnstarted must not query collections"); },
  } as unknown as Store;
  // The first handle's owner has since been renamed; GONE no longer resolves.
  const current = new Map([[FIRST, "kite/first"], [BEA, "bea"]]);
  const identities = { findById: async (id: string) => current.has(id) ? { id, kind: "handle", displayName: current.get(id)! } : undefined } as unknown as Identities;

  it("lists a pairing handed a slot between separate index reads, from one consistent snapshot", async () => {
    const lobbies = createLobbies(store, identities, { publicSlots: 1, now: () => START + 1_000 });
    expect((await lobbies.listUnstarted()).map(row => [row.mode, row.seated])).toEqual([["2v2", 4]]);
  });

  it("names each seat by its identity's current display name, once per colony, and leaves an unresolved seat unnamed", async () => {
    const lobbies = createLobbies(store, identities, { publicSlots: 1, now: () => START + 1_000 });
    const listed = await lobbies.listUnstarted();
    expect(names(listed)).toEqual([[["kite/first"], ["bea"]]]);
    // bea holds both seats of its colony; the unresolved seat is left out with its count.
    expect(listed.map(row => row.colonies.map(colony => colony.map(seat => seat.seats)))).toEqual([[[1], [2]]]);
  });
});
