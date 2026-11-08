/// <reference types="node" />
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Identities, Outcome } from "../../src/identity/identities.ts";
import type { Store, Write } from "../../src/store/firestore.ts";

/**
 * House identities for the house-mode queue tests: the antwars username,
 * its handles, a different owner, and two identities whose display names merely
 * look like antwars/<handle> without the stored owner relation to the antwars
 * username.
 */

export const HOUSE_MODES = ["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const;
export type HouseMode = (typeof HOUSE_MODES)[number];
export const HOUSE_SIZE: Record<HouseMode, number> = { "house-1v1": 1, "house-2v2": 2, "house-3v3": 3, "house-4v4": 4 };
/** A house Benchmark mode entry's lifetime: 15 minutes, while builder modes have 12 hours. */
export const HOUSE_QUEUE_TTL_MS = 15 * 60 * 1000;

export interface Keyed { readonly id: string; readonly key: string; readonly displayName: string }

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/**
 * Stores an identity document and its key directly, as the identity store lays
 * them out, so its key resolves to the given display name without the antwars
 * username's owner relation.
 */
async function seedIdentity(store: Store, fields: Record<string, string>): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = randomBytes(32).toString("base64url");
  const verifier = createHash("sha256").update(key, "utf8").digest("hex");
  const writes: Write[] = [
    { op: "create", path: `identities/${id}`, fields: { ...fields, verifier } },
    { op: "create", path: `keys/${verifier}`, fields: { identityId: id } },
  ];
  await store.transaction(async () => ({ result: null, writes }));
  return { id, key };
}

export async function houseCast(identities: Identities, store: Store, handles = 4) {
  const claimed = value(await identities.claimUsername("antwars"));
  const house: Keyed = { id: claimed.identity.id, key: claimed.key, displayName: claimed.identity.displayName };
  const houseHandles: Keyed[] = [];
  for (let n = 0; n < handles; n++) {
    const created = value(await identities.createHandle(house.key, `agent${n}`));
    houseHandles.push({ id: created.identity.id, key: created.key, displayName: created.identity.displayName });
  }
  const rivalClaim = value(await identities.claimUsername("Rival"));
  const rival: Keyed = { id: rivalClaim.identity.id, key: rivalClaim.key, displayName: rivalClaim.identity.displayName };
  const rivalHandleClaim = value(await identities.createHandle(rival.key, "scout"));
  const rivalHandle: Keyed = { id: rivalHandleClaim.identity.id, key: rivalHandleClaim.key, displayName: rivalHandleClaim.identity.displayName };

  // A second owner displayed as "antwars" whom usernames/antwars does not name, and
  // its handle, displayed as antwars/mimic.
  const impostorOwner = await seedIdentity(store, { kind: "username", displayName: "antwars", canonical: "antwars", claimedAt: String(Date.now()) });
  const mimic = await seedIdentity(store, { kind: "handle", displayName: "antwars/mimic", canonical: "mimic", ownerId: impostorOwner.id });
  // A username whose own display name is antwars/lookalike.
  const lookalike = await seedIdentity(store, { kind: "username", displayName: "antwars/lookalike", canonical: "lookalike", claimedAt: String(Date.now()) });
  const named = async (seeded: { id: string; key: string }): Promise<Keyed> =>
    ({ ...seeded, displayName: value(await identities.resolveKey(seeded.key)).displayName });

  return {
    house,
    houseHandles,
    rival,
    rivalHandle,
    /** Identities whose display name looks like antwars/<handle> but are not owned by the antwars username. */
    lookalikes: [await named(mimic), await named(lookalike)],
  };
}
