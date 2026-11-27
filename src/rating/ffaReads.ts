import type { BatchPublicVisibility } from "../identity/publicVisibility.js";
import { houseOwnedAmong } from "../identity/houseOwnership.js";
import { FirestoreError, readMany, type Fields, type QueryOptions, type Store } from "../store/firestore.js";
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

/** No stored sort key: read a single snapshot in storage order, retaining only the next public page plus one row. */
export async function ffaPage(store: Store, visibility: BatchPublicVisibility | undefined, options: {
  limit: number; house: boolean; cursor?: Position & { readTime: string }; signal?: AbortSignal;
}) {
  const { limit, house, cursor, signal } = options;
  let readTime = cursor?.readTime, startAfter: QueryOptions["startAfter"];
  const candidates: (ReturnType<typeof ffaRating> & { identityId: string })[] = [];
  const batchSize = 100;
  const houseIds = (ids: string[]) => houseOwnedAmong(paths => readMany(store, paths, signal), ids);
  for (;;) {
    signal?.throwIfAborted();
    let page;
    try {
      page = await store.query(FFA_COLLECTION, { orderBy: "mu", direction: "ASCENDING", limit: batchSize, startAfter, readTime, signal });
    } catch (error) {
      if (readTime && error instanceof FirestoreError && (error.status === "INVALID_ARGUMENT" || error.status === "FAILED_PRECONDITION")) {
        return { ok: false, reason: "cursor_expired", cause: error } as const;
      }
      throw error;
    }
    readTime ??= page.readTime;
    const rows = page.rows.map(({ path, fields }) => ({ identityId: path.slice(FFA_COLLECTION.length + 1), ...ffaRating(fields) }))
      .filter(row => row.ratedMatches > 0 && (!cursor || byRank(row, cursor) > 0));
    const ids = rows.map(row => row.identityId);
    const visible = visibility && await visibility.identitiesVisibleEach(ids, signal);
    const owned = house && await houseIds(ids);
    candidates.push(...rows.filter(row => (!visible || visible.get(row.identityId)) && (!owned || owned.has(row.identityId))));
    candidates.sort(byRank);
    candidates.splice(limit + 1);
    if (page.rows.length < batchSize) break;
    const last = page.rows.at(-1)!;
    startAfter = { value: last.fields.mu!, path: last.path };
  }
  const rows = candidates.slice(0, limit);
  const owned = !house && rows.length ? await houseIds(rows.map(row => row.identityId)) : new Set<string>();
  return { ok: true, rows: rows.map(row => ({ ...row, benchmark: house || owned.has(row.identityId) })), readTime, more: candidates.length > limit } as const;
}
