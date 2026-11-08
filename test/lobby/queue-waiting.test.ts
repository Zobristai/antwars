// The public Waiting view's read: Lobbies.listWaiting lists every live waiting queue entry across the eight
// modes by display name, and derives expiry at read time as the queue does. An expired entry keeps its stored state
// "waiting" for good, so neither its stored state nor queueWaiting is trusted.
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import type { Identities } from "../../src/identity/identities.ts";
import { createLobbies, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { QUEUE_TTL_MS, waitingEntries } from "../../src/lobby/queue.ts";
import { createFirestore, type Fields, type Store } from "../../src/store/firestore.ts";
import { houseCast } from "./house-fixtures.ts";

// Runs inside `firebase emulators:exec --only firestore`; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
let counter = 0;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

const JOINED = Date.parse("2026-01-01T00:00:00Z");
// Its expiry under the 12-hour queue lifetime.
const EXPIRES = Date.parse("2026-01-01T12:00:00Z");

function world() {
  const store = createFirestore({ projectId, namespace: `qw${process.pid}-${Date.now().toString(36)}-${counter++}`, emulatorHost: host });
  const clock = { t: JOINED };
  const identities = createIdentities(store);
  const lobbies = createLobbies(store, identities, { publicSlots: 8, privateSlots: 1, now: () => clock.t, random: () => 0 });
  const owner = async (name: string) => value(await identities.claimUsername(name));
  const handle = async (ownerKey: string, name: string) => value(await identities.createHandle(ownerKey, name));
  return { store, clock, identities, lobbies, owner, handle };
}

describe.skipIf(!host)("the public Waiting view's queue read against the Firestore emulator", { timeout: 60_000 }, () => {
  it("lists live waiting entries in every mode by display name, oldest first, and leaves out paired and left entries", async () => {
    const w = world();
    const sam = await w.owner("sam"), first = await w.handle(sam.key, "first");
    const bea = await w.owner("bea"), cat = await w.owner("cat"), dan = await w.owner("dan"), eve = await w.owner("eve");
    const cast = await houseCast(w.identities, w.store, 1);

    value(await w.lobbies.joinQueue(first.key, "1v1"));
    w.clock.t += 1_000; value(await w.lobbies.joinQueue(bea.key, "2v2"));
    w.clock.t += 1_000; value(await w.lobbies.joinQueue(cast.houseHandles[0]!.key, "house-1v1"));
    // Paired: both entries become matched and leave the list.
    w.clock.t += 1_000; value(await w.lobbies.joinQueue(cat.key, "3v3"));
    expect(value(await w.lobbies.joinQueue(dan.key, "3v3")).state).toBe("matched");
    // Left: the entry is deleted.
    value(await w.lobbies.joinQueue(eve.key, "4v4"));
    value(await w.lobbies.leaveQueue(eve.key));

    w.clock.t = JOINED + 90_000;
    expect(await w.lobbies.listWaiting()).toEqual([
      { displayName: "sam/first", mode: "1v1", joinedAt: JOINED },
      { displayName: "bea", mode: "2v2", joinedAt: JOINED + 1_000 },
      { displayName: cast.houseHandles[0]!.displayName, mode: "house-1v1", joinedAt: JOINED + 2_000 },
    ]);
  });

  it("leaves out an entry stored \"waiting\" once 12 hours have passed, whether or not queueWaiting still lists it", async () => {
    const w = world();
    const sam = await w.owner("sam"), first = await w.handle(sam.key, "first");
    value(await w.lobbies.joinQueue(first.key, "1v1"));
    expect(EXPIRES - JOINED).toBe(QUEUE_TTL_MS);

    // The last moment it is live, then the expiry instant itself.
    w.clock.t = EXPIRES - 1;
    expect((await w.lobbies.listWaiting()).map(row => row.displayName)).toEqual(["sam/first"]);
    w.clock.t = EXPIRES;
    expect(await w.lobbies.listWaiting()).toEqual([]);

    // Long expired, still listed in queueWaiting/1v1 and still stored "waiting".
    w.clock.t = Date.parse("2026-01-01T13:20:12Z");
    expect((await w.store.get("queueWaiting/1v1"))?.entries).toBe(first.identity.id);
    expect(await w.store.get(`queueEntries/${first.identity.id}`)).toMatchObject({ state: "waiting", mode: "1v1", joinedAt: String(JOINED) });
    expect(await w.lobbies.listWaiting()).toEqual([]);

    // The observed shape: a later 1v1 join has pruned it from queueWaiting, and its document still says "waiting".
    const bea = await w.owner("bea");
    value(await w.lobbies.joinQueue(bea.key, "1v1"));
    expect((await w.store.get("queueWaiting/1v1"))?.entries).toBe(bea.identity.id);
    expect(await w.store.get(`queueEntries/${first.identity.id}`)).toMatchObject({ state: "waiting", joinedAt: String(JOINED) });
    expect(await w.lobbies.listWaiting()).toEqual([{ displayName: "bea", mode: "1v1", joinedAt: w.clock.t }]);
  });
});

// The same read against stored documents laid out by hand, so it runs without the emulator too.
describe("the public Waiting view's queue read over stored documents", () => {
  const FIRST = "0eb7a998-0000-4000-8000-000000000001", BEA = "0eb7a998-0000-4000-8000-000000000002";
  const docs = (index: string) => new Map<string, Fields>([
    ["queueWaiting/1v1", { entries: index }],
    [`queueEntries/${FIRST}`, { mode: "1v1", joinedAt: String(JOINED), state: "waiting", lobbyId: "" }],
    [`queueEntries/${BEA}`, { mode: "1v1", joinedAt: String(JOINED + 60_000), state: "waiting", lobbyId: "" }],
  ]);
  const getter = (map: Map<string, Fields>) => async (path: string) => map.get(path) ?? null;

  it("leaves out an expired entry, stored \"waiting\" and joined more than 12 hours ago, whether or not queueWaiting lists it", async () => {
    const at = Date.parse("2026-01-01T13:20:12Z");
    expect(at - JOINED).toBeGreaterThan(QUEUE_TTL_MS);
    expect(await waitingEntries(getter(docs(`${FIRST}`)), at)).toEqual([]);
    expect(await waitingEntries(getter(docs("")), at)).toEqual([]);
    expect(await waitingEntries(getter(docs(`${FIRST} ${BEA}`)), EXPIRES)).toEqual([{ identityId: BEA, mode: "1v1", joinedAt: JOINED + 60_000 }]);
    expect(await waitingEntries(getter(docs(`${FIRST} ${BEA}`)), EXPIRES - 1)).toEqual([
      { identityId: FIRST, mode: "1v1", joinedAt: JOINED }, { identityId: BEA, mode: "1v1", joinedAt: JOINED + 60_000 },
    ]);
  });

  it("reads all eight modes, skips matched entries and entries listed under another mode, and names each by its identity", async () => {
    const map = new Map<string, Fields>();
    const modes = ["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"];
    modes.forEach((mode, n) => {
      map.set(`queueWaiting/${mode}`, { entries: `id-${mode} matched-${mode}` });
      map.set(`queueEntries/id-${mode}`, { mode, joinedAt: String(JOINED + (8 - n) * 1000), state: "waiting", lobbyId: "" });
      map.set(`queueEntries/matched-${mode}`, { mode, joinedAt: String(JOINED), state: "matched", lobbyId: "lobby" });
    });
    map.set("queueWaiting/1v1", { entries: "id-1v1 id-2v2 gone" });
    const names = new Map(modes.map(mode => [`id-${mode}`, `agent-${mode}`]));
    const store = { get: async (path: string) => map.get(path) ?? null } as unknown as Store;
    const identities = { findById: async (id: string) => names.has(id) ? { id, kind: "handle", displayName: names.get(id)! } : undefined } as unknown as Identities;
    const lobbies = createLobbies(store, identities, { now: () => JOINED + 60_000 });
    const listed = await lobbies.listWaiting();
    expect(listed.map(row => row.mode)).toEqual([...modes].reverse());
    expect(listed.every(row => row.displayName === `agent-${row.mode}`)).toBe(true);
    names.delete("id-4v4");
    expect((await lobbies.listWaiting()).map(row => row.mode)).not.toContain("4v4");
  });
});
