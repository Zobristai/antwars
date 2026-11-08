import { createHash, randomUUID } from "node:crypto";
import { createIdentities } from "../../src/identity/identities.js";
import type { Fields, Store, TransactionRead, TransactionStep, Write } from "../../src/store/firestore.js";

export function value<T>(outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}

/** Serialized deterministic adapter. Emulator tests separately exercise real lock/retry races. */
export function retentionWorld(start = 1_000_000) {
  let clock = start;
  const docs = new Map<string, Fields>();
  const reads: string[] = [];
  const commits: Write[][] = [];
  let failActivity = false;
  let tail = Promise.resolve();
  let sequence = 0;
  const snapshots = new Map<string, Map<string, Fields>>();
  const store: Store = {
    namespace: "retention-test",
    async get(path) { reads.push(path); return docs.get(path) ?? null; },
    transaction<T>(step: (read: TransactionRead) => Promise<TransactionStep<T>>): Promise<T> {
      const result = tail.then(async () => {
        const outcome = await step(async paths => {
          reads.push(...paths);
          return new Map(paths.map(path => [path, docs.get(path) ?? null]));
        });
        if (failActivity && outcome.writes.some(write => write.op === "update" && Object.keys(write.fields).join() === "lastKeyUseAt")) {
          throw new Error("injected activity commit failure");
        }
        const next = new Map(docs);
        for (const write of outcome.writes) {
          if (write.op === "create" ? next.has(write.path) : !next.has(write.path)) throw new Error(`store precondition: ${write.path}`);
          if (write.op === "delete") next.delete(write.path);
          else next.set(write.path, write.op === "update" ? { ...next.get(write.path), ...write.fields } : write.fields);
        }
        if (outcome.writes.length) {
          commits.push([...outcome.writes]);
          docs.clear(); for (const [path, fields] of next) docs.set(path, fields);
        }
        return outcome.result;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
    async query(collection, options) {
      const readTime = options.readTime ?? new Date(start + sequence++).toISOString();
      if (!options.readTime) snapshots.set(readTime, new Map(docs));
      const snapshot = snapshots.get(readTime);
      if (!snapshot) throw new Error("unknown snapshot");
      const sign = options.direction === "ASCENDING" ? 1 : -1;
      const compare = (a: { path: string; fields: Fields }, b: { path: string; fields: Fields }) =>
        sign * (a.fields[options.orderBy]! < b.fields[options.orderBy]! ? -1 : a.fields[options.orderBy]! > b.fields[options.orderBy]! ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      let rows = [...snapshot].filter(([path, fields]) => path.startsWith(`${collection}/`) && path.split("/").length === 2 && fields[options.orderBy] !== undefined)
        .map(([path, fields]) => ({ path, fields })).sort(compare);
      const cursor = options.startAfter;
      if (cursor) rows = rows.filter(row => compare(row, { path: cursor.path, fields: { [options.orderBy]: cursor.value } }) > 0);
      return { readTime, rows: rows.slice(0, options.limit) };
    },
  };
  const ids = createIdentities(store, { now: () => clock });
  /** A username claimed now (or one of its handles) whose account has joined a match. */
  function played(name = "played", owner?: { id: string; name: string }) {
    const id = randomUUID(), key = randomUUID();
    const verifier = createHash("sha256").update(key).digest("hex");
    const canonical = name.toLowerCase();
    docs.set(`identities/${id}`, owner
      ? { kind: "handle", displayName: `${owner.name}/${name}`, canonical, verifier, ownerId: owner.id }
      : { kind: "username", displayName: name, canonical, verifier, claimedAt: String(clock), hasJoinedMatch: "true" });
    docs.set(`keys/${verifier}`, { identityId: id });
    docs.set(owner ? `identityHandles/${owner.id}-${canonical}` : `usernames/${canonical}`, { identityId: id });
    return { id, key, name };
  }
  return { docs, reads, commits, store, ids, played, now: () => clock,
    at(time: number) { clock = time; }, advance(ms: number) { clock += ms; },
    failActivity(value = true) { failActivity = value; },
    activityWrites: () => commits.flat().filter(write => write.op === "update" && Object.keys(write.fields).join() === "lastKeyUseAt"),
  };
}
