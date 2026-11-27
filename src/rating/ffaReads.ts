import type { BatchPublicVisibility } from "../identity/publicVisibility.js";
import { HOUSE_USERNAME } from "../identity/houseOwnership.js";
import { identityDisplay, nameState, placeholder } from "../identity/retention.js";
import { houseLabel } from "./houseLabels.js";
import { readMany, type Fields, type QueryOptions, type Store } from "../store/firestore.js";
import { FFA_COLLECTION, FFA_ESTIMATOR, FFA_INITIAL } from "./ffa.js";

/** The conservative OpenSkill score (not Glicko rating or RD). */
export function ffaRating(fields: Fields | null) {
  const mu = fields ? Number(fields.mu) : FFA_INITIAL.mu;
  const sigma = fields ? Number(fields.sigma) : FFA_INITIAL.sigma;
  const ratedMatches = fields ? Number(fields.ratedMatches) : 0;
  const rating = mu - 3 * sigma;
  if ((fields && (fields.estimator !== FFA_ESTIMATOR || !fields.mu?.trim() || !fields.sigma?.trim() || !fields.ratedMatches?.trim())) ||
    !Number.isFinite(rating) || !(sigma > 0) || !Number.isSafeInteger(ratedMatches) || ratedMatches < 0) {
    throw new Error("invalid stored Free-for-all rating");
  }
  return { mu, sigma, ratedMatches, rating };
}

type Position = { readonly identityId: string; readonly rating: number };
const byRank = (a: Position, b: Position) => b.rating - a.rating || (a.identityId < b.identityId ? 1 : a.identityId > b.identityId ? -1 : 0);

const TTL_MS = 60_000;

/** Stop waiting without canceling another reader's work. */
function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** No stored sort key. Materialize both scopes from one consistent ratings scan, never from a caller's cursor time. */
export function createFfaPage(store: Store, visibility?: BatchPublicVisibility) {
  async function batch(rows: readonly (Position & ReturnType<typeof ffaRating>)[], signal: AbortSignal) {
    const ids = rows.map(row => row.identityId);
    const visible = visibility && await visibility.identitiesVisibleEach(ids, signal);
    const publicRows = rows.filter(row => !visible || visible.get(row.identityId));
    if (!publicRows.length) return [];
    // Join names and ownership in batches, including owners who have no rating row of their own.
    const pathOf = (id: string) => `identities/${id}`;
    const claim = `usernames/${HOUSE_USERNAME}`;
    const docs = await readMany(store, [claim, ...publicRows.map(row => pathOf(row.identityId))], signal);
    const missingOwners = new Set<string>();
    for (const row of publicRows) {
      const owner = docs.get(pathOf(row.identityId))?.ownerId;
      if (owner && !docs.has(pathOf(owner))) missingOwners.add(pathOf(owner));
    }
    const owners = await readMany(store, [...missingOwners], signal);
    const houseId = docs.get(claim)?.identityId, now = Date.now();
    return publicRows.map(row => {
      const fields = docs.get(pathOf(row.identityId)), ownerId = fields?.ownerId ?? row.identityId;
      const owner = docs.get(pathOf(ownerId)) ?? owners.get(pathOf(ownerId));
      const state = owner ? nameState(owner, now) : "purged";
      const displayName = fields && owner && state !== "purged"
        ? identityDisplay(row.identityId, fields, ownerId, { ...owner, nameState: state }) : placeholder(row.identityId);
      const benchmark = !!fields && ownerId === houseId;
      const label = benchmark ? houseLabel(displayName) : { thinkingLevel: null, serviceTier: null };
      return { ...row, benchmark, displayName, ...label, rd: null, wins: null, losses: null, draws: null, form: [] };
    });
  }
  async function build(signal: AbortSignal) {
    const entries: Awaited<ReturnType<typeof batch>> = [];
    let readTime: string | undefined, startAfter: QueryOptions["startAfter"];
    for (;;) {
      signal.throwIfAborted();
      const page = await store.query(FFA_COLLECTION, { orderBy: "mu", direction: "ASCENDING", limit: 100, startAfter, readTime, signal });
      readTime ??= page.readTime;
      const rows = page.rows.map(({ path, fields }) => ({ identityId: path.slice(FFA_COLLECTION.length + 1), ...ffaRating(fields) }));
      entries.push(...await batch(rows.filter(row => row.ratedMatches > 0), signal));
      if (page.rows.length < 100) break;
      const last = page.rows.at(-1)!;
      startAfter = { value: last.fields.mu!, path: last.path };
    }
    signal.throwIfAborted();
    entries.sort(byRank);
    return { entries, house: entries.filter(row => row.benchmark), readTime, expires: Date.now() + TTL_MS };
  }
  type Snapshot = Awaited<ReturnType<typeof build>>;
  let cache: Snapshot | undefined;
  let flight: { work: Promise<Snapshot>; stop: AbortController; readers: number } | undefined;
  async function acquire(signal?: AbortSignal): Promise<Snapshot> {
    signal?.throwIfAborted();
    if (cache && Date.now() < cache.expires) return cache;
    if (flight?.stop.signal.aborted) {
      // A store may still be draining the canceled build. Do not start another until it settles.
      await waitFor(flight.work.then(() => {}, () => {}), signal);
      return acquire(signal);
    }
    if (!flight) {
      const stop = new AbortController();
      const work = build(stop.signal).then(result => { stop.signal.throwIfAborted(); return cache = result; })
        .finally(() => { flight = undefined; });
      flight = { work, stop, readers: 0 };
    }
    const current = flight;
    current.readers++;
    try { return await waitFor(current.work, signal); }
    finally { if (--current.readers === 0 && current === flight) current.stop.abort(); }
  }
  return async (options: { limit: number; house: boolean; cursor?: Position & { readTime: string }; signal?: AbortSignal }) => {
    const { cursor, signal } = options;
    signal?.throwIfAborted();
    const snapshot = cursor ? cache : await acquire(signal);
    if (!snapshot || (cursor && (snapshot.readTime !== cursor.readTime || Date.now() >= snapshot.expires))) {
      return { ok: false, reason: "cursor_expired" } as const;
    }
    const list = options.house ? snapshot.house : snapshot.entries;
    // First rank after the cursor (score, identity); no storage reads on a cache hit.
    let start = 0, end = list.length;
    while (cursor && start < end) {
      const mid = Math.floor((start + end) / 2);
      if (byRank(list[mid]!, cursor) <= 0) start = mid + 1; else end = mid;
    }
    return { ok: true, rows: list.slice(start, start + options.limit), readTime: snapshot.readTime, more: start + options.limit < list.length } as const;
  };
}
