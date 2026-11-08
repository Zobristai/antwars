import type { Fields } from "../store/firestore.js";

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const UNUSED_USERNAME_MS = 7 * DAY_MS;
export const INACTIVE_USERNAME_MS = 90 * DAY_MS;
/** Shared-store sampling, not an instance-local authentication cache. */
export const KEY_ACTIVITY_WINDOW_MS = 60 * 60 * 1_000;
export const USERNAME_RETENTION_TEXT = "7 days after claim, no started-match join: purge username+handles despite key use. 90 days no username/handle match join or key use: release name. Recover: claim_username {name,key:existing username key}.";

export function timestamp(value: string | undefined): number {
  const time = value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("invalid identity retention timestamp");
  return time;
}

export type NameState = "claimed" | "released" | "purged";

export function nameState(owner: Fields, at: number): NameState {
  if (owner.canonical === "antwars") return "claimed";
  if (owner.nameState === "purged" || owner.nameState === "released") return owner.nameState;
  const claimed = timestamp(owner.claimedAt);
  if (owner.hasJoinedMatch !== "true" && at >= claimed + UNUSED_USERNAME_MS) return "purged";
  const keyUse = owner.lastKeyUseAt === undefined ? claimed : timestamp(owner.lastKeyUseAt);
  const match = owner.lastMatchAt === undefined ? claimed : timestamp(owner.lastMatchAt);
  if (at >= Math.max(claimed, keyUse, match) + INACTIVE_USERNAME_MS) return "released";
  return "claimed";
}

export const placeholder = (ownerId: string): string => `account:${ownerId}`;

/** Handles derive their prefix from the current owner, never an old cached name. */
export function identityDisplay(id: string, fields: Fields, ownerId: string, owner: Fields): string {
  const prefix = owner.nameState === "released" ? placeholder(ownerId) : owner.displayName!;
  return id === ownerId ? prefix : `${prefix}/${fields.displayName!.split("/").at(-1)!}`;
}
