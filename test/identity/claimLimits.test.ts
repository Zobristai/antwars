import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { createFirestore, type Store } from "../../src/store/firestore.ts";

// Real Firestore atomicity coverage. It runs with the emulator suite;
// absent emulator means skipped coverage, never a claimed pass.
const host = process.env.FIRESTORE_EMULATOR_HOST;
let serial = 0;
function setup(request?: typeof fetch, namespace = `quota-${process.pid}-${Date.now().toString(36)}-${serial++}`) {
  const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT || "demo-antwar", namespace, emulatorHost: host, request });
  return { store, ids: createIdentities(store) };
}
function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success: ${outcome.reason}`);
  return outcome.value;
}
async function seed(store: Store, path: string, used: number) {
  await store.transaction(async (read) => {
    const current = (await read([path])).get(path);
    return { result: undefined, writes: [{ op: current ? "update" : "create", path,
      fields: { windowStart: String(Date.now()), used: String(used) } }] };
  });
}
/** Hold each contender's first commit so both read the same near-limit budget. */
function overlap() {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  return (): typeof fetch => {
    let held = false;
    return async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith(":commit") && !held) {
        held = true;
        if (++arrived === 2) release();
        await Promise.race([both, sleep(15_000, undefined, { ref: false }).then(() => { throw new Error("quota overlap barrier timed out"); })]);
      }
      return fetch(input, init);
    };
  };
}

describe.skipIf(!host)("claim limits against the Firestore emulator", { timeout: 60_000 }, () => {
  it("admits concurrent usernames beyond ten across instances without modifying the old address budget", async () => {
    const { store, ids } = setup();
    const caller = "192.0.2.20";
    const path = `identityClaimLimits/usernames-${createHash("sha256").update(caller).digest("hex")}`;
    await seed(store, path, 10);
    const before = await store.get(path);
    const wrap = overlap();
    const contenders = [setup(wrap(), store.namespace).ids, setup(wrap(), store.namespace).ids];
    const names = ["eleventh", "twelfth"];
    const results = await Promise.all(contenders.map((instance, i) => instance.claimUsername(names[i]!, caller)));
    expect(results.every((outcome) => outcome.ok)).toBe(true);
    for (const name of names) expect(await ids.findByDisplayName(name)).toBeDefined();
    value(await ids.claimUsername("thirteenth", caller));
    expect(await store.get(path)).toEqual(before);
    expect(await ids.claimUsername("ELEVENTH", caller)).toEqual({ ok: false, reason: "taken" });
  });

  it("serializes final handle creations and retains the owner budget after rotation", async () => {
    const { store, ids } = setup();
    const owner = value(await ids.claimUsername("owner"));
    const path = `identityClaimLimits/handles-${owner.identity.id}`;
    await seed(store, path, 19);
    const wrap = overlap();
    const contenders = [setup(wrap(), store.namespace).ids, setup(wrap(), store.namespace).ids];
    const names = ["claude", "gpt4"];
    const results = await Promise.all(contenders.map((instance, i) => instance.createHandle(owner.key, names[i]!)));
    expect(results.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(results.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, reason: "handle_creation_limit" }]);
    for (let i = 0; i < names.length; i++) expect(Boolean(await ids.findByDisplayName(`owner/${names[i]}`))).toBe(results[i]!.ok);
    const next = value(await ids.rotateKey(owner.key));
    expect(await ids.createHandle(next.key, "excess")).toEqual({ ok: false, reason: "handle_creation_limit" });
    expect((await store.get(path))?.used).toBe("20");
    expect(value(await ids.resolveKey(next.key)).id).toBe(owner.identity.id);
  });
});
