import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIdentities } from "../../src/identity/identities.js";
import { DAY_MS, INACTIVE_USERNAME_MS, KEY_ACTIVITY_WINDOW_MS, UNUSED_USERNAME_MS } from "../../src/identity/retention.js";
import { createFirestore } from "../../src/store/firestore.js";
import { retentionWorld, value } from "./retentionStore.js";

const DAY = 86_400_000;
describe("username retention", () => {
  it("uses the seven-day boundary despite key use; invalidates owner and every handle together", async () => {
    const w = retentionWorld(), start = w.now();
    const owner = value(await w.ids.claimUsername("parked"));
    const handle = value(await w.ids.createHandle(owner.key, "scout"));
    w.at(start + 7 * DAY - 1);
    expect(value(await w.ids.resolveKey(handle.key)).id).toBe(handle.identity.id);
    expect(await w.ids.findByDisplayName("parked/scout")).toEqual(handle.identity);
    w.advance(1);
    expect(await w.ids.resolveKey(handle.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.ids.rotateKey(owner.key)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.ids.reissueHandleKey(owner.key, "scout")).toEqual({ ok: false, reason: "unknown_key" });
    expect(await w.ids.findByDisplayName("parked")).toBeUndefined();
    const replacement = value(await w.ids.claimUsername("parked"));
    expect(replacement.identity.id).not.toBe(owner.identity.id);
    expect(await w.ids.findByDisplayName("parked/scout")).toBeUndefined();
    const nextHandle = value(await w.ids.createHandle(replacement.key, "scout"));
    expect(nextHandle.identity.id).not.toBe(handle.identity.id);
    expect(await w.ids.resolveKey(handle.key)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("a handle's successful match protects its whole account from seven-day purge", async () => {
    const w = retentionWorld(), start = w.now();
    const owner = value(await w.ids.claimUsername("player"));
    const handle = value(await w.ids.createHandle(owner.key, "scout"));
    w.at(start + 7 * DAY - 1);
    await w.ids.recordMatchJoin(handle.identity.id);
    w.advance(1);
    expect(await w.ids.findByDisplayName("player")).toEqual(owner.identity);
    expect(await w.ids.claimUsername("player")).toEqual({ ok: false, reason: "taken" });
    expect(w.docs.get(`identities/${owner.identity.id}`)?.hasJoinedMatch).toBe("true");
  });

  it("samples owner and handle key use once per hour across instances", async () => {
    const w = retentionWorld(), owner = value(await w.ids.claimUsername("active"));
    const handle = value(await w.ids.createHandle(owner.key, "worker"));
    const second = createIdentities(w.store, { now: w.now });
    w.advance(3_600_000 - 1);
    await second.resolveKey(handle.key); await w.ids.resolveKey(owner.key);
    expect(w.activityWrites()).toHaveLength(0);
    w.advance(1);
    await Promise.all([second.resolveKey(handle.key), w.ids.resolveKey(owner.key), second.resolveKey(owner.key)]);
    expect(w.activityWrites()).toHaveLength(1);
    w.advance(3_600_000 - 1);
    await second.resolveKey(owner.key);
    expect(w.activityWrites()).toHaveLength(1);
    w.advance(1); await second.resolveKey(handle.key);
    expect(w.activityWrites()).toHaveLength(2);
    expect(KEY_ACTIVITY_WINDOW_MS).toBe(3_600_000);
  });

  it("an activity commit failure cannot fail a valid authenticated call or leak its key", async () => {
    const w = retentionWorld(), owner = value(await w.ids.claimUsername("active"));
    w.advance(3_600_000); w.failActivity();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await w.ids.resolveKey(owner.key)).toEqual({ ok: true, value: owner.identity });
      const rotated = value(await w.ids.rotateKey(owner.key));
      expect(value(await w.ids.resolveKey(rotated.key)).id).toBe(owner.identity.id);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(owner.key);
      expect(w.activityWrites()).toHaveLength(0);
      w.failActivity(false); await w.ids.resolveKey(rotated.key);
      expect(w.activityWrites()).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it.each(["key", "match"] as const)("a handle's %s activity resets the ninety-day clock", async kind => {
    const w = retentionWorld(), owner = w.played(), handle = w.played("worker", owner), start = w.now();
    w.at(start + 89 * DAY);
    if (kind === "key") value(await w.ids.resolveKey(handle.key));
    else await w.ids.recordMatchJoin(handle.id);
    w.at(start + 90 * DAY);
    expect((await w.ids.findByDisplayName(owner.name))?.id).toBe(owner.id);
    w.at(start + 179 * DAY - 1); expect(await w.ids.findByDisplayName(owner.name)).toBeDefined();
    w.advance(1); expect(await w.ids.findByDisplayName(owner.name)).toBeUndefined();
  });

  it("a played new account releases its name, preserves the same keys/handles and can recover with its owner key", async () => {
    const w = retentionWorld(), start = w.now(), owner = value(await w.ids.claimUsername("original"));
    const handle = value(await w.ids.createHandle(owner.key, "Scout"));
    await w.ids.recordMatchJoin(handle.identity.id);
    w.at(start + 90 * DAY - 1); expect(await w.ids.findByDisplayName("original")).toBeDefined();
    w.advance(1);
    const taker = value(await w.ids.claimUsername("original"));
    expect(taker.identity.id).not.toBe(owner.identity.id);
    expect(await w.ids.findByDisplayName("original/Scout")).toBeUndefined();
    expect(value(await w.ids.resolveKey(handle.key)).displayName).toBe(`account:${owner.identity.id}/Scout`);
    expect(await w.ids.claimUsername("renamed", undefined, handle.key)).toEqual({ ok: false, reason: "not_owner_key" });
    const renamed = value(await w.ids.claimUsername("renamed", undefined, owner.key));
    expect(renamed.key).toBe(owner.key); expect(renamed.identity.id).toBe(owner.identity.id);
    expect(value(await w.ids.resolveKey(handle.key)).displayName).toBe("renamed/Scout");
    expect((await w.ids.findByDisplayName("renamed/Scout"))?.id).toBe(handle.identity.id);
    const reissued = value(await w.ids.reissueHandleKey(owner.key, "Scout"));
    expect(value(await w.ids.resolveKey(reissued.key)).id).toBe(handle.identity.id);
    expect(await w.ids.claimUsername("thirdname", undefined, owner.key)).toEqual({ ok: false, reason: "already_named" });
  });

  it("renames a released account's handles without exposing them to the name's next holder", async () => {
    const w = retentionWorld(), owner = w.played("Before"), handle = w.played("Scout", owner), start = w.now();
    w.at(start + 90 * DAY);
    const renamed = value(await w.ids.claimUsername("after", undefined, owner.key));
    expect(renamed.identity.id).toBe(owner.id);
    expect((await w.ids.findByDisplayName("after/Scout"))?.id).toBe(handle.id);
    const other = value(await w.ids.claimUsername("Before"));
    expect(await w.ids.findByDisplayName("Before/Scout")).toBeUndefined();
    value(await w.ids.createHandle(other.key, "Scout"));
    const replacement = value(await w.ids.reissueHandleKey(owner.key, "Scout"));
    expect(value(await w.ids.resolveKey(replacement.key)).displayName).toBe("after/Scout");
  });

  it("antwars is exempt, including all its handles", async () => {
    const w = retentionWorld();
    const issued = value(await w.ids.claimUsername("Antwars"));
    const handle = value(await w.ids.createHandle(issued.key, "claude"));
    w.advance(400 * DAY);
    expect(value(await w.ids.resolveKey(issued.key)).displayName).toBe("Antwars");
    expect(value(await w.ids.resolveKey(handle.key)).displayName).toBe("Antwars/claude");
    expect(await w.ids.claimUsername("antwars")).toEqual({ ok: false, reason: "taken" });
  });

  it("keeps expiry constants explicit", () => {
    expect(DAY_MS).toBe(DAY); expect(UNUSED_USERNAME_MS).toBe(7 * DAY); expect(INACTIVE_USERNAME_MS).toBe(90 * DAY);
  });
});

const host = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!host)("retention against the Firestore emulator", { timeout: 60_000 }, () => {
  it("serializes competing reclaims of an expired name across instances", async () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace: `retention-${randomUUID()}`, emulatorHost: host });
    let now = 1_000_000;
    const first = createIdentities(store, { now: () => now }), second = createIdentities(store, { now: () => now });
    const old = value(await first.claimUsername("parked"));
    now += 7 * DAY;
    const outcomes = await Promise.all([first.claimUsername("parked"), second.claimUsername("PARKED")]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(outcomes.filter(result => !result.ok)).toEqual([{ ok: false, reason: "taken" }]);
    expect(await first.resolveKey(old.key)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rechecks the shared hour window under concurrent handle key use", async () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace: `retention-${randomUUID()}`, emulatorHost: host });
    let now = 1_000_000;
    const first = createIdentities(store, { now: () => now });
    const owner = value(await first.claimUsername("active")), handle = value(await first.createHandle(owner.key, "worker"));
    const second = createIdentities(store, { now: () => now });
    now += 3_600_000;
    const results = await Promise.all([first.resolveKey(owner.key), second.resolveKey(handle.key)]);
    expect(results.every(result => result.ok)).toBe(true);
    expect((await store.get(`identities/${owner.identity.id}`))?.lastKeyUseAt).toBe(String(now));
  });
});
