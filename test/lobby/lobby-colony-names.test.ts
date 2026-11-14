// A lobby's colony names as its record holds them (Lobby.colonyNames), which read_lobby, list_lobbies, the Waiting card
// and the Matches catalog all show: before its match begins, an unrated lobby shows the pair its match will draw from its
// id; once begun or adopted, the names the serving game recorded; a match an older server began, which recorded none,
// kept the rated names, so it shows none, as its game and spectator stream do.
import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import type { Fields, Store } from "../../src/store/firestore.ts";

function memoryStore(docs: Map<string, Fields>): Store {
  return {
    namespace: "colony-names-test",
    async get(path) { return docs.get(path) ?? null; },
    async transaction(step) {
      const next = await step(async paths => new Map(paths.map(path => [path, docs.get(path) ?? null])));
      for (const write of next.writes) {
        if (write.op === "delete") docs.delete(write.path);
        else docs.set(write.path, { ...docs.get(write.path), ...write.fields });
      }
      return next.result;
    },
    async query() { throw new Error("not used"); },
  };
}

function value<T>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

const INSTANCE = { mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" };

function world() {
  const docs = new Map<string, Fields>();
  const store = memoryStore(docs);
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => 0, random: () => 0 });
  const claim = async (name: string) => value(await identities.claimUsername(name));
  return { docs, lobbies, claim };
}

/** An unrated public 1v1 lobby holding the one public slot, its match not yet begun. */
async function holdingLobby() {
  const w = world();
  const [ann, bob] = await Promise.all(["ann", "bob"].map(w.claim));
  const { lobby } = value(await w.lobbies.createLobby(ann!.key, "public", 1));
  value(await w.lobbies.join(lobby.id, ann!.key));
  value(await w.lobbies.join(lobby.id, bob!.key));
  await w.lobbies.registerInstance("public-0", { runId: "run-1", ...INSTANCE });
  const read = async () => value(await w.lobbies.readLobby(lobby.id));
  const stored = () => w.docs.get(`lobbies/${lobby.id}`)?.colonyNames;
  return { ...w, id: lobby.id, read, stored };
}

describe("a lobby's colony names", () => {
  it("shows the pair an unrated match will draw, then the pair its game recorded when it began", async () => {
    const w = await holdingLobby();
    const drawn = drawColonyNames(w.id);
    expect((await w.read()).state).toBe("holding");
    expect((await w.read()).colonyNames).toEqual(drawn);
    value(await w.lobbies.beginMatch(w.id, "public-0", "run-1", drawn));
    expect(w.stored()).toBe(JSON.stringify(drawn));
    expect((await w.read()).colonyNames).toEqual(drawn);
    expect((await w.lobbies.listPublic()).find(lobby => lobby.id === w.id)?.colonyNames).toEqual(drawn);
  });

  it("shows none for a match an older server began, and keeps that through an adoption that records the rated names", async () => {
    const w = await holdingLobby();
    // An older server's begin records no names: its match and stream used the rated names.
    value(await w.lobbies.beginMatch(w.id, "public-0", "run-1"));
    expect(w.stored()).toBeUndefined();
    expect("colonyNames" in await w.read()).toBe(false);
    // Handed over mid-match, the successor's game keeps the rated names and records them so.
    await w.lobbies.registerInstance("public-0", { runId: "run-2", ...INSTANCE });
    value(await w.lobbies.adoptMatch(w.id, "public-0", "run-2", "run-1", COLONY_NAMES));
    expect(w.stored()).toBe("");
    expect("colonyNames" in await w.read()).toBe(false);
  });

  it("shows the drawn pair once a successor adopts an older server's match still in its nest-pick window", async () => {
    const w = await holdingLobby();
    const drawn = drawColonyNames(w.id);
    value(await w.lobbies.beginMatch(w.id, "public-0", "run-1"));
    await w.lobbies.registerInstance("public-0", { runId: "run-2", ...INSTANCE });
    // A save from before the first tick has no stream yet, so the successor's game draws the names and records them.
    value(await w.lobbies.adoptMatch(w.id, "public-0", "run-2", "run-1", drawn));
    expect((await w.read()).colonyNames).toEqual(drawn);
  });

  it("never names a rated pairing's colonies", async () => {
    const w = world();
    const [dan, eve] = await Promise.all(["dan", "eve"].map(w.claim));
    value(await w.lobbies.joinQueue(dan!.key, "1v1"));
    const paired = value(await w.lobbies.joinQueue(eve!.key, "1v1"));
    if (paired.state !== "matched") throw new Error("expected a pairing");
    expect("colonyNames" in value(await w.lobbies.readLobby(paired.lobbyId))).toBe(false);
    await w.lobbies.registerInstance("public-0", { runId: "run-1", ...INSTANCE });
    value(await w.lobbies.beginMatch(paired.lobbyId, "public-0", "run-1", COLONY_NAMES));
    expect("colonyNames" in value(await w.lobbies.readLobby(paired.lobbyId))).toBe(false);
  });
});
