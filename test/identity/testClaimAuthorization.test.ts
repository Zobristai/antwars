import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIdentities, keyVerifier } from "../../src/identity/identities.ts";
import { testClaimOwnerIdsFromEnv } from "../../src/identity/testClaimAuthorization.ts";
import { HOUSE_USERNAME } from "../../src/identity/houseOwnership.ts";
import { UNUSED_USERNAME_MS } from "../../src/identity/retention.ts";
import { retentionWorld, value } from "./retentionStore.ts";

const name = () => `test${randomUUID().slice(0, 8)}`;

describe("test claim owner configuration", () => {
  it("grants no allowance when unset, empty or whitespace", () => {
    for (const setting of [undefined, "", " \t "]) {
      expect(testClaimOwnerIdsFromEnv({ ANTWARS_TEST_CLAIM_OWNER_IDS: setting })).toEqual([]);
    }
  });

  it("accepts only identity UUIDs, normalises case and removes duplicates", () => {
    const one = randomUUID(), two = randomUUID();
    expect(testClaimOwnerIdsFromEnv({ ANTWARS_TEST_CLAIM_OWNER_IDS: ` ${one.toUpperCase()}, ${two},${one} ` })).toEqual([one, two]);
    for (const setting of ["true", "*", "a-test-name", `${one},`, `,${one}`, `${one},private-input`]) {
      let message = "";
      try { testClaimOwnerIdsFromEnv({ ANTWARS_TEST_CLAIM_OWNER_IDS: setting }); }
      catch (error) { message = (error as Error).message; }
      expect(message).toBe("invalid ANTWARS_TEST_CLAIM_OWNER_IDS: use comma-separated username identity UUIDs");
    }
  });

  it("wires parsed configuration to the identity owner at startup", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("testClaimOwnerIds = testClaimOwnerIdsFromEnv(process.env)");
    expect(main).toContain("createIdentities(store, { testClaimOwnerIds })");
  });
});

describe("transactional test claim proof", () => {
  it("uses a snapshot of server designation and disables proof when not configured", async () => {
    const w = retentionWorld();
    const sponsor = value(await w.ids.claimUsername(name()));
    const configured = [sponsor.identity.id];
    const ids = createIdentities(w.store, { now: w.now, testClaimOwnerIds: configured });
    configured.length = 0;
    expect((await ids.claimUsername(name(), "caller", undefined, undefined, sponsor.key)).ok).toBe(true);
    expect(await w.ids.claimUsername(name(), "caller", undefined, undefined, sponsor.key)).toEqual({ ok: false, reason: "unknown_key" });
    const stranger = value(await w.ids.claimUsername(name()));
    configured.push(stranger.identity.id);
    expect(await ids.claimUsername(name(), "caller", undefined, undefined, stranger.key)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects handles and the house owner even if their IDs were configured", async () => {
    const w = retentionWorld();
    const sponsor = value(await w.ids.claimUsername(name()));
    const handle = value(await w.ids.createHandle(sponsor.key, name()));
    const house = value(await w.ids.claimUsername(HOUSE_USERNAME));
    const houseHandle = value(await w.ids.createHandle(house.key, name()));
    const ids = createIdentities(w.store, { now: w.now, testClaimOwnerIds: [sponsor.identity.id, handle.identity.id, house.identity.id, houseHandle.identity.id] });
    for (const proof of [handle.key, house.key, houseHandle.key]) {
      expect(await ids.claimUsername(name(), "caller", undefined, undefined, proof)).toEqual({ ok: false, reason: "unknown_key" });
    }
  });

  it("checks the current key in each transaction and accepts rotation only through the new key", async () => {
    const w = retentionWorld();
    const sponsor = value(await w.ids.claimUsername(name()));
    const ids = createIdentities(w.store, { now: w.now, testClaimOwnerIds: [sponsor.identity.id] });
    const rotated = value(await ids.rotateKey(sponsor.key));
    expect(await ids.claimUsername(name(), "caller", undefined, undefined, sponsor.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect((await ids.claimUsername(name(), "caller", undefined, undefined, rotated.key)).ok).toBe(true);
    // A stale key-index document must not restore permission after rotation.
    w.docs.set(`keys/${keyVerifier(sponsor.key)}`, { identityId: sponsor.identity.id });
    expect(await ids.claimUsername(name(), "caller", undefined, undefined, sponsor.key)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects purged owners and never transfers designation to a replacement with the same name", async () => {
    const w = retentionWorld(), label = name();
    const sponsor = value(await w.ids.claimUsername(label));
    const ids = createIdentities(w.store, { now: w.now, testClaimOwnerIds: [sponsor.identity.id] });
    w.advance(UNUSED_USERNAME_MS);
    expect(await ids.claimUsername(name(), "caller", undefined, undefined, sponsor.key)).toEqual({ ok: false, reason: "unknown_key" });
    const replacement = value(await w.ids.claimUsername(label));
    expect(await ids.claimUsername(name(), "caller", undefined, undefined, replacement.key)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("preserves missing-caller and commit guards, creating nothing when refused", async () => {
    const w = retentionWorld();
    const sponsor = value(await w.ids.claimUsername(name()));
    const ids = createIdentities(w.store, { now: w.now, testClaimOwnerIds: [sponsor.identity.id] });
    const before = w.docs.size;
    expect(await ids.claimUsername(name(), null, undefined, undefined, sponsor.key)).toEqual({ ok: false, reason: "caller_unavailable" });
    expect(await ids.claimUsername(name(), "caller", undefined, { mayCommit: () => false }, sponsor.key)).toEqual({ ok: false, reason: "server_busy" });
    expect(w.docs.size).toBe(before);
  });
});
