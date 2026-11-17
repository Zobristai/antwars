import { rate, type Rating } from "openskill";
import { plackettLuce } from "openskill/models";
import { parseFfaFinish, type FfaFinish } from "../sim/ffaFinish.js";
import type { Store, TransactionRead, TransactionStep, Write } from "../store/firestore.js";

export const FFA_ESTIMATOR = "openskill-5.0.1/plackett-luce-v1";
export const FFA_INITIAL: Readonly<Rating> = Object.freeze({ mu: 25, sigma: 25 / 3 });
export const FFA_COLLECTION = "ratings-ffa";
const MATCHES = "ffaMatches";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REASONS = new Set(["time_up", "queens_killed", "idle", "sustained_territory"]);

/** Colony-indexed identities, never a two-team result or a list of derived duels. */
export interface FfaResult {
  readonly matchId: string;
  readonly participants: readonly string[];
  readonly reason: string;
  readonly finish: FfaFinish;
}
export interface FfaChange {
  readonly identityId: string;
  readonly place: number;
  readonly before: Rating;
  readonly after: Rating;
}
export type FfaOutcome =
  | { readonly status: "not_rateable" }
  | { readonly status: "already_applied" }
  | { readonly status: "applied"; readonly changes: readonly FfaChange[] };

function validRating(r: Rating): void {
  if (!Number.isFinite(r.mu) || !Number.isFinite(r.sigma) || r.sigma <= 0) throw new Error("invalid Free-for-all rating");
}

/** One simultaneous, four-singleton-team update using the pinned reference parameters. */
export function rateFfa(priors: readonly Rating[], finish: FfaFinish): Rating[] {
  const { order, rateable } = parseFfaFinish(finish);
  if (!rateable || priors.length !== 4) throw new Error("Free-for-all result is not rateable");
  priors.forEach(validRating);
  // Translation leaves the model unchanged and keeps exp(mu/c) away from overflow for large shared means.
  const centre = priors.reduce((total, r) => total + r.mu / 4, 0);
  const teams = priors.map(r => [{ mu: r.mu - centre, sigma: r.sigma }]);
  const updated = rate(teams, { model: plackettLuce, rank: priors.map((_, colony) => order.indexOf(colony) + 1),
    mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, kappa: 0.0001, balance: false, limitSigma: false });
  return updated.map(team => {
    const after = { mu: team[0]!.mu + centre, sigma: team[0]!.sigma };
    validRating(after);
    return after;
  });
}

/** A transaction step usable by offline application and by an explicitly enabled live caller. */
export async function ffaRatingWrites(read: TransactionRead, result: FfaResult): Promise<TransactionStep<FfaOutcome>> {
  const finish = parseFfaFinish(result.finish);
  if (!ID.test(result.matchId) || result.participants.length !== 4 || new Set(result.participants).size !== 4 ||
      result.participants.some(id => typeof id !== "string" || !ID.test(id))) throw new Error("invalid Free-for-all participants or match id");
  if (!finish.rateable || !REASONS.has(result.reason)) return { result: { status: "not_rateable" }, writes: [] };
  // Copy input before awaiting storage; idempotency binds the exact result as well as its match id.
  const participants = [...result.participants];
  const input = JSON.stringify({ estimator: FFA_ESTIMATOR, participants, reason: result.reason, finish });
  const marker = `${MATCHES}/${result.matchId}`;
  const docs = await read([marker, ...participants.flatMap(id => [`${FFA_COLLECTION}/${id}`, `identities/${id}`])]);
  const previous = docs.get(marker);
  if (previous) {
    if (previous.input !== input) throw new Error("Free-for-all match was already rated with another result");
    return { result: { status: "already_applied" }, writes: [] };
  }
  const current = participants.map(id => {
    if (!docs.get(`identities/${id}`)) throw new Error("unknown Free-for-all identity");
    const fields = docs.get(`${FFA_COLLECTION}/${id}`);
    if (!fields) return { rating: { ...FFA_INITIAL }, count: 0, exists: false };
    if (fields.estimator !== FFA_ESTIMATOR || !fields.mu?.trim() || !fields.sigma?.trim() || !fields.ratedMatches?.trim()) {
      throw new Error("invalid stored Free-for-all rating");
    }
    const rating = { mu: Number(fields.mu), sigma: Number(fields.sigma) }, count = Number(fields.ratedMatches);
    validRating(rating);
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) throw new Error("invalid Free-for-all match count");
    return { rating, count, exists: true };
  });
  const after = rateFfa(current.map(p => p.rating), finish);
  const changes = participants.map((identityId, colony): FfaChange => ({ identityId, place: finish.order.indexOf(colony) + 1,
    before: current[colony]!.rating, after: after[colony]! }));
  const writes: Write[] = participants.map((id, colony) => ({ op: current[colony]!.exists ? "update" : "create", path: `${FFA_COLLECTION}/${id}`,
    fields: { mu: String(after[colony]!.mu), sigma: String(after[colony]!.sigma), ratedMatches: String(current[colony]!.count + 1), estimator: FFA_ESTIMATOR } }));
  writes.push({ op: "create", path: marker, fields: { input, changes: JSON.stringify(changes) } });
  return { result: { status: "applied", changes }, writes };
}

/** Explicit offline API: callers supply a recorded result; no historical scan or automatic backfill. */
export function applyFfaResult(store: Store, result: FfaResult): Promise<FfaOutcome> {
  return store.transaction(read => ffaRatingWrites(read, result));
}
