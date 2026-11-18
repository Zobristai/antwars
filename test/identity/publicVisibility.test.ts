import { describe, expect, it } from "vitest";
import { createPublicVisibility, publicExcludedOwnerIdsFromEnv } from "../../src/identity/publicVisibility.ts";
import { createWatchRegistry } from "../../src/live/watch-registry.ts";
import { createIdentities } from "../../src/identity/identities.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const registry = { replayLobby: async () => ({ state: "none" as const }) };

describe("private public-visibility configuration", () => {
  it.each([undefined, "", "   "])("is disabled for %j", value => {
    const ids = publicExcludedOwnerIdsFromEnv({ ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: value, ANTWARS_TEST_CLAIM_OWNER_IDS: owner });
    expect(ids).toEqual([]);
    expect(createPublicVisibility(memoryWatchStore().store, registry, ids)).toBeUndefined();
  });
  it("normalizes a comma list without exposing invalid contents", () => {
    expect(publicExcludedOwnerIdsFromEnv({ ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: ` ${owner.toUpperCase()}, ${other},${owner}` })).toEqual([owner, other]);
    for (const value of ["private-value", `${owner},`, `${owner};OTHER=value`]) {
      expect(() => publicExcludedOwnerIdsFromEnv({ ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: value }))
        .toThrow("invalid ANTWARS_PUBLIC_EXCLUDED_OWNER_IDS: use comma-separated username identity UUIDs");
    }
  });
  it("uses retained ownership, not current names, claim sponsors or digits", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set("identities/child", { kind: "handle", ownerId: owner, nameState: "purged", displayName: "Released/leaf" });
    docs.set(`identities/${other}`, { kind: "username", displayName: "Player123", sponsor: owner });
    const policy = createPublicVisibility(store, registry, [owner])!;
    expect(await policy.identitiesVisible([owner])).toBe(false);
    expect(await policy.identitiesVisible(["child"])).toBe(false);
    expect(await policy.identitiesVisible([other])).toBe(true);
    docs.set("lobbies/mixed", { seats: JSON.stringify([{ id: other }, { id: "child" }]) });
    expect(await policy.lobbyVisible("mixed")).toBe(false);
    expect(docs.get("identities/child")?.nameState).toBe("purged");
  });
  it("answers many checks with one identities read, leaving excluded ids unread", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set("identities/child", { kind: "handle", ownerId: owner });
    docs.set(`identities/${other}`, { kind: "username" });
    let reads = 0;
    const counted = { ...store, transaction: ((step: never) => { reads++; return store.transaction(step); }) as typeof store.transaction };
    const policy = createPublicVisibility(counted, registry, [owner])!;
    expect(await policy.identitiesVisibleEach([owner, "child", other, other])).toEqual(new Map([[owner, false], ["child", false], [other, true]]));
    expect(reads).toBe(1);
    const lobbies = new Map([
      ["mixed", { seats: JSON.stringify([{ id: other }, { id: "child" }]) }],
      ["direct", { seats: JSON.stringify([{ id: owner }, { id: "unread" }]) }],
      ["clear", { seats: JSON.stringify([{ id: other }]) }],
      ["empty", { seats: "[]" }],
    ]);
    expect(await policy.lobbiesVisibleEach(lobbies)).toEqual(new Map([["mixed", false], ["direct", false], ["clear", true], ["empty", true]]));
    expect(reads).toBe(2);
    expect(await policy.identitiesVisibleEach([owner])).toEqual(new Map([[owner, false]]));
    expect(reads).toBe(2);
  });
  it("fails a batch on any unreadable or malformed record", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set(`identities/${other}`, { kind: "username" });
    docs.set("identities/odd", { kind: "handle" });
    const policy = createPublicVisibility(store, registry, [owner])!;
    const failed = "Public visibility temporarily unavailable";
    await expect(policy.identitiesVisibleEach([other, "missing"])).rejects.toThrow(failed);
    await expect(policy.identitiesVisibleEach([other, "odd"])).rejects.toThrow(failed);
    const seats = (ids: string[]) => ({ seats: JSON.stringify(ids.map(id => ({ id }))) });
    await expect(policy.lobbiesVisibleEach(new Map([["a", seats([other])], ["b", null]]))).rejects.toThrow(failed);
    await expect(policy.lobbiesVisibleEach(new Map([["a", seats([other])], ["b", { seats: "{" }]]))).rejects.toThrow(failed);
    await expect(policy.lobbiesVisibleEach(new Map([["a", { seats: JSON.stringify([{ name: "x" }]) }]]))).rejects.toThrow(failed);
  });
  it("fails on a lobby without recorded seats", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set(`identities/${other}`, { kind: "username" });
    docs.set("lobbies/unseated", { startsAt: "1760000000000" });
    const policy = createPublicVisibility(store, registry, [owner])!;
    const failed = "Public visibility temporarily unavailable";
    await expect(policy.lobbyVisible("unseated")).rejects.toThrow(failed);
    await expect(policy.lobbiesVisibleEach(new Map<string, Record<string, string>>([["a", { seats: JSON.stringify([{ id: other }]) }], ["b", { startsAt: "1" }]])))
      .rejects.toThrow(failed);
  });
  it.each(["not-an-id", "0000000A-0000-4000-8000-00000000000B", ` ${owner}`])("fails on a handle whose owner id is malformed: %j", async ownerId => {
    const { store, docs } = memoryWatchStore();
    docs.set("identities/leaf", { kind: "handle", ownerId });
    docs.set("lobbies/played", { seats: JSON.stringify([{ id: "leaf" }]) });
    const policy = createPublicVisibility(store, registry, [owner])!;
    const failed = "Public visibility temporarily unavailable";
    await expect(policy.identitiesVisible(["leaf"])).rejects.toThrow(failed);
    await expect(policy.identitiesVisibleEach(["leaf"])).rejects.toThrow(failed);
    await expect(policy.lobbyVisible("played")).rejects.toThrow(failed);
  });
  it("hides a recording whose lobby link is pending or absent, with no negative cache", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set(`identities/${other}`, { kind: "username" });
    docs.set("lobbies/clear", { seats: JSON.stringify([{ id: other }]) });
    let found: { state: "pending" } | { state: "none" } | { state: "found"; lobbyId: string } = { state: "pending" };
    const policy = createPublicVisibility(store, { replayLobby: async () => found }, [owner])!;
    expect(await policy.replayVisible("record")).toBe(false);
    found = { state: "none" };
    expect(await policy.replayVisible("record")).toBe(false);
    found = { state: "found", lobbyId: "clear" };
    expect(await policy.replayVisible("record")).toBe(true);
    await expect(policy.lobbyVisible("absent")).rejects.toThrow();
    await expect(policy.identitiesVisible(["missing"])).rejects.toThrow();
    docs.set("identities/missing", { kind: "handle", ownerId: owner });
    expect(await policy.identitiesVisible(["missing"])).toBe(false);
  });
  it("hides a recording whose lobby cannot say who played, and still fails a failed read", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set(`identities/${other}`, { kind: "username" });
    docs.set("identities/odd", { kind: "handle", ownerId: "not-an-id" });
    docs.set("lobbies/clear", { seats: JSON.stringify([{ id: other }]) });
    docs.set("lobbies/unseated", { startsAt: "1760000000000" });
    docs.set("lobbies/garbled", { seats: "{" });
    docs.set("lobbies/nameless", { seats: JSON.stringify([{ name: "x" }]) });
    docs.set("lobbies/unknown", { seats: JSON.stringify([{ id: other }, { id: "missing" }]) });
    docs.set("lobbies/malformed", { seats: JSON.stringify([{ id: "odd" }]) });
    docs.set("lobbies/empty", { seats: "[]" });
    const policy = createPublicVisibility(store, { replayLobby: async id => ({ state: "found", lobbyId: id }) }, [owner])!;
    expect(await policy.replayVisible("clear")).toBe(true);
    for (const id of ["absent", "unseated", "garbled", "nameless", "unknown", "malformed", "empty"]) expect(await policy.replayVisible(id)).toBe(false);
    // Other public checks keep their behavior on the same records.
    await expect(policy.lobbyVisible("unknown")).rejects.toThrow("Public visibility temporarily unavailable");
    expect(await policy.lobbyVisible("empty")).toBe(true);
    const failed = "Public visibility temporarily unavailable";
    const broken = { ...store, transaction: (async () => { throw new Error("transport"); }) as typeof store.transaction };
    await expect(createPublicVisibility(broken, { replayLobby: async () => ({ state: "found", lobbyId: "clear" }) }, [owner])!
      .replayVisible("record")).rejects.toThrow(failed);
    const unreadable = { ...store, get: (async () => { throw new Error("transport"); }) as typeof store.get };
    await expect(createPublicVisibility(unreadable, registry, [owner])!.replayVisible("2026-10-20T10-00-00-000Z-1")).rejects.toThrow(failed);
    await expect(createPublicVisibility(store, { replayLobby: async () => { throw new Error("transport"); } }, [owner])!
      .replayVisible("record")).rejects.toThrow(failed);
  });
  it("hides a found recording with an excluded player and a recording with no lobby", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set("lobbies/hidden", { seats: JSON.stringify([{ id: owner }]) });
    const policy = createPublicVisibility(store, { replayLobby: async id => id === "hidden"
      ? { state: "found", lobbyId: "hidden" } : { state: "none" } }, [owner])!;
    expect(await policy.replayVisible("hidden")).toBe(false);
    expect(await policy.replayVisible("scheduled")).toBe(false);
  });
  it("does not enroll excluded owners in claim permission", async () => {
    const { store } = memoryWatchStore();
    const identities = createIdentities(store);
    const claimed = await identities.claimUsername("Meadow");
    if (!claimed.ok) throw new Error(claimed.reason);
    createPublicVisibility(store, registry, [claimed.value.identity.id]);
    const result = await identities.claimUsername("Willow", "source", undefined, undefined, claimed.value.key);
    expect(result.ok).toBe(false);
  });
});


it("filters persisted ownership without watch registration and re-evaluates changes without caching", async () => {
  const { store, docs } = memoryWatchStore(), registry = createWatchRegistry(store);
  const replay = "2026-10-20T10-00-00-000Z-1";
  docs.set(`lobbies/${other}`, { seats: JSON.stringify([{ id: owner }]) });
  docs.set(`identities/${owner}`, { kind: "username" });
  const hidden = createPublicVisibility(store, registry, [owner])!;
  expect(await hidden.replayVisible(replay)).toBe(false); // No ownership and no lobby link: its players are not established.
  await registry.recordOwners(other, replay);
  expect(await registry.replayLobby(replay)).toEqual({ state: "none" });
  expect(await hidden.replayVisible(replay)).toBe(false);
  expect(await createPublicVisibility(store, registry, [other])!.replayVisible(replay)).toBe(true);
  docs.delete(`identities/${owner}`); // The immutable owner record survives identity projection changes.
  expect(await hidden.replayVisible(replay)).toBe(false);
  docs.set(`replayOwnership/${replay}`, { version: "1", lobbyId: other, ownerIds: "private malformed contents" });
  await expect(hidden.replayVisible(replay)).rejects.toThrow("Public visibility temporarily unavailable");
});
