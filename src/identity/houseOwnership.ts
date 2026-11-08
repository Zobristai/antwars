import type { TransactionRead } from "../store/firestore.js";

/**
 * House ownership: an
 * identity is house-owned when its owner is the antwars username, read from the
 * stored owner relation, never from its display name. A username is its own owner,
 * so the antwars username itself is house-owned; a handle's owner is its ownerId.
 */

export const HOUSE_USERNAME = "antwars";

/** Of identityIds, those owned by the antwars username, from one transactional read. */
export async function houseOwnedAmong(read: TransactionRead, identityIds: readonly string[]): Promise<ReadonlySet<string>> {
  const claim = `usernames/${HOUSE_USERNAME}`;
  const docs = await read([claim, ...new Set(identityIds.map((id) => `identities/${id}`))]);
  const houseId = docs.get(claim)?.identityId;
  if (!houseId) return new Set();
  return new Set(identityIds.filter((id) => {
    const identity = docs.get(`identities/${id}`);
    return identity != null && (identity.ownerId ?? id) === houseId;
  }));
}

export async function isHouseOwned(read: TransactionRead, identityId: string): Promise<boolean> {
  return (await houseOwnedAmong(read, [identityId])).has(identityId);
}
