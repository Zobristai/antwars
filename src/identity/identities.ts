/// <reference types="node" />
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Fields, Store, TransactionRead, Write } from "../store/firestore.js";
import { identityDisplay, KEY_ACTIVITY_WINDOW_MS, nameState, timestamp } from "./retention.js";

/**
 * Usernames and owner/agent handles held by once-issued keys.
 * A key is 32 random bytes returned once; the store keeps only its
 * SHA-256 verifier, as the keys/{verifier} document ID and on the identity. No operation
 * returns or recovers an issued key. The one exception to a lost key staying lost:
 * reissueLostKey gives a fresh key, replacing the lost one, to the identity a key holds when
 * that key's issuing reply never reached its caller and the caller's MCP session proves that
 * call (recover_key, accounts/mcpTools.ts); the session keeps only the verifier.
 *
 * Documents, under the store's namespace:
 *   usernames/{canonical}                     { identityId }
 *   identityHandles/{ownerId}-{canonical}     { identityId }
 *   identities/{uuid}  { kind, displayName, canonical, verifier, ownerId (handles),
 *                       claimedAt, lastKeyUseAt, lastMatchAt, hasJoinedMatch, nameState }
 *   keys/{verifier}    { identityId }
 *   identityClaimLimits/usernames-{sha256(caller)}  { windowStart, used }  usernames claimed per caller
 *   identityClaimLimits/handles-{ownerId}           { windowStart, used }  handles created per username
 *   identityClaimLimits/rotations-{identityId}      { windowStart, used }  key replacements per identity
 */

export type IdentityKind = "username" | "handle";

export interface Identity {
  readonly id: string;
  readonly kind: IdentityKind;
  /** The username as claimed, or owner/handle. */
  readonly displayName: string;
}

export const RESERVED_USERNAMES = [
  "claude", "opus", "sonnet", "haiku", "anthropic", "gpt", "openai", "astra", "luna", "sol",
  "gemini", "google", "grok", "xai", "llama", "meta", "deepseek", "qwen", "kimi", "glm",
  "chatgpt", "mistral", "mixtral", "codestral", "minimax", "cohere", "moonshot", "zhipu", "baidu",
  "ernie", "bytedance", "doubao", "microsoft", "phi", "nvidia", "nemotron", "amazon", "nova",
] as const;
export const USERNAME_CLAIM_LIMIT = 10;
/**
 * Handles per username per window: house seats are a fixed set and a team of up to 4
 * agents uses one handle each, so 20 leaves every real builder room while one username can no
 * longer mint keys by the thousand.
 */
export const HANDLE_CREATION_LIMIT = 20;
/**
 * Key replacements per identity per window: rotate_key on the identity's own key and
 * reissue_handle_key on a handle both spend that identity's budget; a refusal leaves the current key working.
 */
export const KEY_ROTATION_LIMIT = 5;
export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type Refusal = "invalid_name" | "taken" | "unknown_key" | "not_owner_key" | "no_such_handle"
  | "reserved_name" | "username_claim_limit" | "handle_creation_limit" | "key_rotation_limit" | "caller_unavailable"
  | "already_named" | "server_busy";
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Refusal };

/**
 * For the calls that issue a one-time key: mayCommit is asked as the last step before the
 * commit; false aborts with server_busy and commits nothing, so no key is issued that the caller
 * could not be sent.
 */
export interface CommitGuard {
  readonly mayCommit?: () => boolean;
  /**
   * The instant (epoch ms, the store's clock) by which the commit must end; the store refuses to
   * launch it later and cuts it off then, and the call aborts with server_busy, no key issued.
   */
  readonly commitBy?: number;
}

export interface IssuedIdentity {
  readonly identity: Identity;
  /** The secret key, returned only here. */
  readonly key: string;
}

export interface Name {
  /** NFKC form, kept for display. */
  readonly display: string;
  /** Lower-case form that decides sameness. */
  readonly canonical: string;
}

/**
 * The name rule: after NFKC normalization, 2-24 ASCII letters, digits, "-" or "_",
 * starting with a letter or digit. Names equal after NFKC and ASCII case-folding are
 * the same name. "/" is refused because handles display as owner/agent.
 */
export function parseName(input: string): Name | undefined {
  const display = input.normalize("NFKC");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,23}$/.test(display)) return undefined;
  return { display, canonical: display.toLowerCase() };
}

export interface Identities {
  /** Omitted caller disables address accounting; null refuses unavailable enabled context. */
  claimUsername(name: string, caller?: string | null, ownerKey?: string, guard?: CommitGuard): Promise<Outcome<IssuedIdentity>>;
  /** No key use: current display/retention projection by stable identity id. */
  findById(id: string): Promise<Identity | undefined>;
  /** Durable successful admission into a started match (not lobby seating). */
  recordMatchJoin(identityId: string, at?: number): Promise<void>;
  /** ownerId is the owning username's identity, which the owner key proved. */
  createHandle(ownerKey: string, handleName: string, guard?: CommitGuard): Promise<Outcome<IssuedIdentity & { readonly ownerId: string }>>;
  resolveKey(key: string): Promise<Outcome<Identity>>;
  /** identityId is the rotated identity, already proved by the old key. */
  rotateKey(key: string, guard?: CommitGuard): Promise<Outcome<{ readonly key: string; readonly identityId: string }>>;
  /** ownerId is the owning username's identity, which the owner key proved. */
  reissueHandleKey(ownerKey: string, handleName: string, guard?: CommitGuard): Promise<Outcome<{ readonly key: string; readonly ownerId: string }>>;
  /**
   * A fresh key for the identity whose current key has this verifier, replacing that key in the same commit.
   * Only for a key whose issuing reply was lost, with the issuing call proved by its session (recover_key):
   * this layer checks only that the verifier is still the identity's current key and the identity has not
   * expired, refusing unknown_key otherwise. Spends no rotation budget: each lost key came from a budgeted call.
   */
  reissueLostKey(verifier: string, guard?: CommitGuard): Promise<Outcome<{ readonly key: string; readonly identityId: string }>>;
  /** Public name lookup; may lazily materialize expiration, but never records key activity. */
  findByDisplayName(displayName: string): Promise<Identity | undefined>;
}

interface Holder {
  readonly id: string;
  readonly verifier: string;
  readonly fields: Fields;
}

const refuse = (reason: Refusal) => ({ ok: false, reason }) as const;
const ok = <T>(value: T) => ({ ok: true, value }) as const;
const verifierOf = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");
const newKey = () => {
  const key = randomBytes(32).toString("base64url");
  return { key, verifier: verifierOf(key) };
};
/** The guard's answer, as the last step before a key-issuing commit: abort with no writes when it says no. */
const busy = (guard: CommitGuard | undefined) => guard?.mayCommit?.() === false;
/** A key-issuing step's commit, carrying the guard's deadline to the store. */
const issuing = <T>(guard: CommitGuard | undefined, result: T, writes: readonly Write[]) => ({
  result,
  writes,
  ...(guard?.commitBy === undefined ? {} : { commitBy: { at: guard.commitBy, late: refuse("server_busy") as T } }),
});
const identityOf = (id: string, fields: Fields): Identity => ({ id, kind: fields.kind as IdentityKind, displayName: fields.displayName! });

/** The identity a key currently holds, read inside the caller's transaction. */
async function readHolder(read: TransactionRead, key: string): Promise<Holder | undefined> {
  const verifier = verifierOf(key);
  const keyDoc = (await read([`keys/${verifier}`])).get(`keys/${verifier}`);
  if (!keyDoc) return undefined;
  const id = keyDoc.identityId!;
  const fields = (await read([`identities/${id}`])).get(`identities/${id}`);
  if (!fields || fields.verifier !== verifier) return undefined;
  return { id, verifier, fields };
}

/** Replaces an identity's key: the old keys document goes in the same commit. */
function replaceKey(id: string, oldVerifier: string): { key: string; writes: Write[] } {
  const { key, verifier } = newKey();
  return {
    key,
    writes: [
      { op: "delete", path: `keys/${oldVerifier}` },
      { op: "create", path: `keys/${verifier}`, fields: { identityId: id } },
      { op: "update", path: `identities/${id}`, fields: { verifier } },
    ],
  };
}

/** Only new usernames are reserved; handles and existing keys are unaffected. */
function reservedUsername(canonical: string): boolean {
  return RESERVED_USERNAMES.some((word) => canonical === word
    || (canonical.startsWith(word) && /^[-_0-9]/.test(canonical.slice(word.length))));
}

/** Included in the creation transaction: a refused creation spends no quota. */
async function claimBudget(read: TransactionRead, path: string, limit: number, now: number): Promise<Write[] | undefined> {
  const current = (await read([path])).get(path);
  const start = current ? Number(current.windowStart) : now;
  const used = current ? Number(current.used) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(used) || used < 0) {
    throw new Error("invalid identity claim budget");
  }
  const reset = now >= start + CLAIM_WINDOW_MS;
  const count = reset ? 0 : used;
  if (count >= limit) return undefined;
  return [{ op: current ? "update" : "create", path,
    fields: { windowStart: String(reset ? now : start), used: String(count + 1) } }];
}

interface Account {
  readonly id: string;
  readonly fields: Fields;
  readonly ownerId: string;
  readonly owner: Fields;
}

/** Coalesce updates to an owner touched by multiple parts of one transaction. */
function writesOf(writes: readonly Write[]): Write[] {
  const result = new Map<string, Write>();
  for (const write of writes) {
    const previous = result.get(write.path);
    result.set(write.path, write.op === "update" && previous && previous.op !== "delete"
      ? { ...previous, fields: { ...previous.fields, ...write.fields } } : write);
  }
  return [...result.values()];
}

const handleIndex = (ownerId: string, canonical: string) => `identityHandles/${ownerId}-${canonical}`;
const rotationBudget = (identityId: string) => `identityClaimLimits/rotations-${identityId}`;

export function createIdentities(store: Store, options: { readonly now?: () => number } = {}): Identities {
  const now = options.now ?? Date.now;
  /** Expiration is serialized with claims, rotation and activity on the owner. */
  async function account(read: TransactionRead, id: string, at: number, writes: Write[]): Promise<Account | undefined> {
    const fields = (await read([`identities/${id}`])).get(`identities/${id}`);
    if (!fields) return undefined;
    const ownerId = fields.ownerId ?? id;
    const original = ownerId === id ? fields : (await read([`identities/${ownerId}`])).get(`identities/${ownerId}`);
    if (!original) return undefined;
    const state = nameState(original, at);
    const owner = state === "claimed" ? original : { ...original, nameState: state };
    if (state !== "claimed" && original.nameState !== state) {
      writes.push({ op: "update", path: `identities/${ownerId}`, fields: { nameState: state } });
      const claim = `usernames/${original.canonical}`;
      // Never delete a later owner's claim or inherit its handles.
      if ((await read([claim])).get(claim)?.identityId === ownerId) writes.push({ op: "delete", path: claim });
    }
    // The permanent owner tombstone invalidates every handle/key in O(1), even
    // for accounts exceeding Firestore's transaction write limit. Child records
    // are unreachable, not enumerated or reassigned to the next name holder.
    if (state === "purged") return undefined;
    return { id, fields, ownerId, owner };
  }

  const project = (found: Account): Identity => ({
    id: found.id, kind: found.fields.kind as IdentityKind,
    displayName: identityDisplay(found.id, found.fields, found.ownerId, found.owner),
  });

  async function authenticated(read: TransactionRead, key: string, at: number, writes: Write[]) {
    const holder = await readHolder(read, key);
    return holder ? account(read, holder.id, at, writes) : undefined;
  }

  /** No transaction/commit inside the coarse window. Failures never affect authentication. */
  async function touch(found: Account, at: number): Promise<void> {
    const previous = found.owner.lastKeyUseAt;
    if (previous !== undefined && at - timestamp(previous) < KEY_ACTIVITY_WINDOW_MS) return;
    try {
      await store.transaction(async (read) => {
        const path = `identities/${found.ownerId}`;
        const owner = (await read([path])).get(path);
        if (!owner || owner.nameState === "purged" ||
          (owner.lastKeyUseAt !== undefined && at - timestamp(owner.lastKeyUseAt) < KEY_ACTIVITY_WINDOW_MS)) {
          return { result: undefined, writes: [] };
        }
        return { result: undefined, writes: [{ op: "update", path, fields: { lastKeyUseAt: String(at) } }] };
      });
    } catch {
      console.warn("antwar identity key activity update failed", { ownerId: found.ownerId });
    }
  }

  async function existingHandle(read: TransactionRead, owner: Account, canonical: string): Promise<{ id: string; fields: Fields } | undefined> {
    const path = handleIndex(owner.ownerId, canonical);
    const id = (await read([path])).get(path)?.identityId;
    const fields = id ? (await read([`identities/${id}`])).get(`identities/${id}`) : null;
    return id && fields?.ownerId === owner.ownerId ? { id, fields } : undefined;
  }

  const api: Identities = {
    async claimUsername(input, caller, ownerKey, guard) {
      const name = parseName(input);
      if (!name) return refuse("invalid_name");
      if (reservedUsername(name.canonical)) return refuse("reserved_name");
      if (caller === null) return refuse("caller_unavailable");
      if (ownerKey !== undefined && !(await api.resolveKey(ownerKey)).ok) return refuse("unknown_key");
      const claim = `usernames/${name.canonical}`;
      return store.transaction<Outcome<IssuedIdentity>>(async (read) => {
        const at = now();
        const writes: Write[] = [];
        const claimant = ownerKey === undefined ? undefined : await authenticated(read, ownerKey, at, writes);
        if (ownerKey !== undefined && !claimant) return { result: refuse("unknown_key"), writes: writesOf(writes) };
        if (claimant && claimant.id !== claimant.ownerId) return { result: refuse("not_owner_key"), writes: writesOf(writes) };
        if (claimant && claimant.owner.nameState !== "released") return { result: refuse("already_named"), writes: writesOf(writes) };
        const current = (await read([claim])).get(claim);
        if (current) {
          const holder = await account(read, current.identityId!, at, writes);
          if (holder && holder.owner.nameState !== "released") return { result: refuse("taken"), writes: writesOf(writes) };
        }
        const budget = caller === undefined ? [] : await claimBudget(read,
          `identityClaimLimits/usernames-${verifierOf(caller)}`, USERNAME_CLAIM_LIMIT, at);
        if (!budget) return { result: refuse("username_claim_limit"), writes: writesOf(writes) };
        // Replacing a released name retains the account and its existing key.
        const id = claimant?.id ?? randomUUID();
        const issued = claimant ? { key: ownerKey!, verifier: claimant.fields.verifier! } : newKey();
        const fields: Fields = claimant
          ? { ...claimant.owner, displayName: name.display, canonical: name.canonical, nameState: "claimed", lastKeyUseAt: String(at) }
          : { kind: "username", displayName: name.display, canonical: name.canonical, verifier: issued.verifier,
            claimedAt: String(at), lastKeyUseAt: String(at) };
        // An occupied-but-expired index is replaced, not deleted then recreated.
        const next = writes.filter((write) => write.path !== claim);
        next.push({ op: current ? "update" : "create", path: claim, fields: { identityId: id } },
          { op: claimant ? "update" : "create", path: `identities/${id}`, fields }, ...budget);
        if (!claimant) next.push({ op: "create", path: `keys/${issued.verifier}`, fields: { identityId: id } });
        if (busy(guard)) return { result: refuse("server_busy"), writes: [] };
        return issuing(guard, ok({ identity: identityOf(id, fields), key: issued.key }), writesOf(next));
      });
    },

    async createHandle(ownerKey, input, guard) {
      const name = parseName(input);
      if (!name) return refuse("invalid_name");
      if (!(await api.resolveKey(ownerKey)).ok) return refuse("unknown_key");
      return store.transaction<Outcome<IssuedIdentity & { readonly ownerId: string }>>(async (read) => {
        const at = now(), writes: Write[] = [];
        const owner = await authenticated(read, ownerKey, at, writes);
        if (!owner) return { result: refuse("unknown_key"), writes: writesOf(writes) };
        if (owner.id !== owner.ownerId) return { result: refuse("not_owner_key"), writes: writesOf(writes) };
        if (await existingHandle(read, owner, name.canonical)) return { result: refuse("taken"), writes: writesOf(writes) };
        const budget = await claimBudget(read, `identityClaimLimits/handles-${owner.id}`, HANDLE_CREATION_LIMIT, at);
        if (!budget) return { result: refuse("handle_creation_limit"), writes: writesOf(writes) };
        const id = randomUUID(), { key, verifier } = newKey();
        const fields = { kind: "handle", displayName: `${project(owner).displayName}/${name.display}`,
          canonical: name.canonical, verifier, ownerId: owner.id };
        if (busy(guard)) return { result: refuse("server_busy"), writes: [] };
        return issuing(guard, ok({ identity: identityOf(id, fields), key, ownerId: owner.id }), writesOf([
          ...writes, { op: "create", path: handleIndex(owner.id, name.canonical), fields: { identityId: id } },
          { op: "create", path: `identities/${id}`, fields },
          { op: "create", path: `keys/${verifier}`, fields: { identityId: id } }, ...budget,
        ]));
      });
    },

    async resolveKey(key) {
      const at = now();
      const found = await store.transaction(async (read) => {
        const writes: Write[] = [];
        const result = await authenticated(read, key, at, writes);
        return { result, writes: writesOf(writes) };
      });
      if (!found) return refuse("unknown_key");
      await touch(found, at);
      return ok(project(found));
    },

    async rotateKey(key, guard) {
      if (!(await api.resolveKey(key)).ok) return refuse("unknown_key");
      return store.transaction<Outcome<{ readonly key: string; readonly identityId: string }>>(async (read) => {
        const at = now(), writes: Write[] = [];
        const holder = await authenticated(read, key, at, writes);
        if (!holder) return { result: refuse("unknown_key"), writes: writesOf(writes) };
        const budget = await claimBudget(read, rotationBudget(holder.id), KEY_ROTATION_LIMIT, at);
        if (!budget) return { result: refuse("key_rotation_limit"), writes: writesOf(writes) };
        const next = replaceKey(holder.id, holder.fields.verifier!);
        if (busy(guard)) return { result: refuse("server_busy"), writes: [] };
        return issuing(guard, ok({ key: next.key, identityId: holder.id }), writesOf([...writes, ...next.writes, ...budget]));
      });
    },

    async reissueHandleKey(ownerKey, input, guard) {
      const name = parseName(input);
      if (!name) return refuse("invalid_name");
      if (!(await api.resolveKey(ownerKey)).ok) return refuse("unknown_key");
      return store.transaction<Outcome<{ readonly key: string; readonly ownerId: string }>>(async (read) => {
        const at = now(), writes: Write[] = [];
        const owner = await authenticated(read, ownerKey, at, writes);
        if (!owner) return { result: refuse("unknown_key"), writes: writesOf(writes) };
        if (owner.id !== owner.ownerId) return { result: refuse("not_owner_key"), writes: writesOf(writes) };
        const handle = await existingHandle(read, owner, name.canonical);
        if (!handle) return { result: refuse("no_such_handle"), writes: writesOf(writes) };
        // The handle's own budget: reissuing and the handle's rotate_key draw on the same count.
        const budget = await claimBudget(read, rotationBudget(handle.id), KEY_ROTATION_LIMIT, at);
        if (!budget) return { result: refuse("key_rotation_limit"), writes: writesOf(writes) };
        const next = replaceKey(handle.id, handle.fields.verifier!);
        if (busy(guard)) return { result: refuse("server_busy"), writes: [] };
        return issuing(guard, ok({ key: next.key, ownerId: owner.id }), writesOf([...writes, ...next.writes, ...budget]));
      });
    },

    async reissueLostKey(verifier, guard) {
      return store.transaction<Outcome<{ readonly key: string; readonly identityId: string }>>(async (read) => {
        const at = now(), writes: Write[] = [];
        const keyDoc = (await read([`keys/${verifier}`])).get(`keys/${verifier}`);
        const id = keyDoc?.identityId;
        const fields = id === undefined ? undefined : (await read([`identities/${id}`])).get(`identities/${id}`);
        if (id === undefined || !fields || fields.verifier !== verifier) return { result: refuse("unknown_key"), writes: [] };
        if (!(await account(read, id, at, writes))) return { result: refuse("unknown_key"), writes: writesOf(writes) };
        const next = replaceKey(id, verifier);
        if (busy(guard)) return { result: refuse("server_busy"), writes: [] };
        return issuing(guard, ok({ key: next.key, identityId: id }), writesOf([...writes, ...next.writes]));
      });
    },

    async findById(id) {
      return store.transaction(async (read) => {
        const writes: Write[] = [];
        const found = await account(read, id, now(), writes);
        return { result: found ? project(found) : undefined, writes: writesOf(writes) };
      });
    },

    async findByDisplayName(displayName) {
      const parts = displayName.split("/");
      const names = parts.length <= 2 ? parts.map(parseName) : [];
      if (names.length === 0 || names.some((name) => name === undefined)) return undefined;
      return store.transaction(async (read) => {
        const writes: Write[] = [];
        const id = (await read([`usernames/${names[0]!.canonical}`])).get(`usernames/${names[0]!.canonical}`)?.identityId;
        const owner = id ? await account(read, id, now(), writes) : undefined;
        if (!owner || owner.owner.nameState === "released") return { result: undefined, writes: writesOf(writes) };
        if (names.length === 1) return { result: project(owner), writes: writesOf(writes) };
        const handle = await existingHandle(read, owner, names[1]!.canonical);
        return { result: handle ? project({ ...owner, id: handle.id, fields: handle.fields }) : undefined, writes: writesOf(writes) };
      });
    },

    async recordMatchJoin(identityId, at = now()) {
      await store.transaction(async (read) => {
        const writes: Write[] = [];
        const found = await account(read, identityId, at, writes);
        if (!found) throw new Error("cannot record a match join for an expired identity");
        const previous = found.owner.lastMatchAt === undefined ? 0 : timestamp(found.owner.lastMatchAt);
        writes.push({ op: "update", path: `identities/${found.ownerId}`,
          fields: { hasJoinedMatch: "true", lastMatchAt: String(Math.max(previous, at)) } });
        return { result: undefined, writes: writesOf(writes) };
      });
    },
  };
  return api;
}
