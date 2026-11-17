import { describe, expect, it } from "vitest";
import { createPublicVisibility, publicExcludedOwnerIdsFromEnv } from "../../src/identity/publicVisibility.ts";
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
  it("treats failed or pending membership as unavailable, with no negative cache", async () => {
    const { store, docs } = memoryWatchStore();
    const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "pending" }) }, [owner])!;
    await expect(policy.replayVisible("record")).rejects.toThrow("Public visibility temporarily unavailable");
    await expect(policy.lobbyVisible("absent")).rejects.toThrow();
    await expect(policy.identitiesVisible(["missing"])).rejects.toThrow();
    docs.set("identities/missing", { kind: "handle", ownerId: owner });
    expect(await policy.identitiesVisible(["missing"])).toBe(false);
  });
  it("hides a found recording and leaves scheduled historical recordings visible", async () => {
    const { store, docs } = memoryWatchStore();
    docs.set("lobbies/hidden", { seats: JSON.stringify([{ id: owner }]) });
    const policy = createPublicVisibility(store, { replayLobby: async id => id === "hidden"
      ? { state: "found", lobbyId: "hidden" } : { state: "none" } }, [owner])!;
    expect(await policy.replayVisible("hidden")).toBe(false);
    expect(await policy.replayVisible("scheduled")).toBe(true);
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
