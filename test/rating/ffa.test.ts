import { describe, expect, it } from "vitest";
import { applyFfaResult, FFA_COLLECTION, FFA_INITIAL, rateFfa, type FfaResult } from "../../src/rating/ffa.ts";
import type { FfaFinish } from "../../src/sim/ffaFinish.ts";
import { retentionWorld } from "../identity/retentionStore.ts";
import { createFirestore } from "../../src/store/firestore.ts";

const finish: FfaFinish = { version: 1, order: [0, 1, 2, 3], territoryWinnerFirst: false, rateable: true };
// Independently evaluated Weng-Lin equations with beta=25/6, tau=25/300 and gamma=sqrt(variance)/c.
const equal = [[27.795252672501135, 8.263571791259418], [26.55291815138952, 8.17961798837266],
  [24.689416369722096, 8.084127880168786], [20.962412806387245, 8.084127880168786]];
const unequal = [[30.121676236193693, 3.9771054318934143], [17.464545114276063, 5.853345341719242],
  [27.20458947354549, 2.0010923542857855], [18.75243548010752, 7.555369375701901]];

it("matches the four-place equal-prior reference, without mutating priors", () => {
  const priors = Array.from({ length: 4 }, () => Object.freeze({ ...FFA_INITIAL }));
  const result = rateFfa(priors, finish);
  result.forEach((r, i) => { expect(r.mu).toBeCloseTo(equal[i]![0]!, 10); expect(r.sigma).toBeCloseTo(equal[i]![1]!, 10); });
  expect(priors).toEqual(Array(4).fill(FFA_INITIAL));
});

it("matches an unequal-prior reference and returns colony-indexed updates for a shuffled order", () => {
  const priors = [30, 20, 27, 18].map((mu, i) => ({ mu, sigma: [4, 6, 2, 8][i]! }));
  const result = rateFfa(priors, { ...finish, order: [2, 0, 3, 1] });
  result.forEach((r, i) => { expect(r.mu).toBeCloseTo(unequal[i]![0]!, 10); expect(r.sigma).toBeCloseTo(unequal[i]![1]!, 10); });
});

function world() {
  const w = retentionWorld();
  const ids = [0, 1, 2, 3].map(i => w.played(`player${i}`).id);
  const result: FfaResult = { matchId: "ffa-match", participants: ids, reason: "time_up", finish };
  return { ...w, result };
}

it("commits four isolated ratings and immutable history atomically, once under concurrent delivery", async () => {
  const w = world();
  for (const collection of ["ratings", "ratings-2v2", "ratings-3v3", "ratings-4v4", "ratedMatches", "modelIndex"]) {
    w.docs.set(`${collection}/existing`, { value: "unchanged" });
  }
  const original = new Map(w.docs);
  const outcomes = await Promise.all([applyFfaResult(w.store, w.result), applyFfaResult(w.store, w.result)]);
  expect(outcomes.map(o => o.status).sort()).toEqual(["already_applied", "applied"]);
  expect(w.commits).toHaveLength(1);
  expect(w.commits[0]).toHaveLength(5);
  for (const [path, fields] of original) expect(w.docs.get(path)).toEqual(fields);
  w.result.participants.forEach((id, i) => {
    const stored = w.docs.get(`${FFA_COLLECTION}/${id}`)!;
    expect(Number(stored.mu)).toBeCloseTo(equal[i]![0]!, 10);
    expect(stored.ratedMatches).toBe("1");
  });
  const history = w.docs.get("ffaMatches/ffa-match")!;
  expect(JSON.parse(history.changes!)).toHaveLength(4);
  const prior = new Map(w.docs);
  await expect(applyFfaResult(w.store, { ...w.result, finish: { ...finish, order: [3, 2, 1, 0] } })).rejects.toThrow("another result");
  expect(w.docs).toEqual(prior);
  await applyFfaResult(w.store, { ...w.result, matchId: "second" });
  expect(w.docs.get("ffaMatches/ffa-match")).toEqual(history);
  expect(w.docs.get(`${FFA_COLLECTION}/${w.result.participants[0]}`)?.ratedMatches).toBe("2");
});

it("refuses malformed, duplicate, unknown and unrateable input without partial writes", async () => {
  const w = world();
  const original = new Map(w.docs);
  for (const result of [
    { ...w.result, participants: ["x", "x", "y", "z"] },
    { ...w.result, participants: ["unknown", ...w.result.participants.slice(1)] },
    { ...w.result, finish: { ...finish, order: [0, 0, 2, 3] as const } },
    { ...w.result, matchId: "../other" },
  ]) await expect(applyFfaResult(w.store, result)).rejects.toThrow();
  for (const reason of ["abandoned", "stopped", "not_played"]) {
    expect(await applyFfaResult(w.store, { ...w.result, reason })).toEqual({ status: "not_rateable" });
  }
  expect(await applyFfaResult(w.store, { ...w.result, finish: { ...finish, rateable: false } })).toEqual({ status: "not_rateable" });
  expect(w.docs).toEqual(original);
  expect(w.commits).toHaveLength(0);
});

it("refuses corrupt stored state and invalid numerical inputs, rather than resetting them", async () => {
  const w = world();
  w.docs.set(`${FFA_COLLECTION}/${w.result.participants[2]}`, { mu: "NaN", sigma: "8", ratedMatches: "1" });
  const original = new Map(w.docs);
  await expect(applyFfaResult(w.store, w.result)).rejects.toThrow();
  expect(w.docs).toEqual(original);
  for (const bad of [{ mu: NaN, sigma: 1 }, { mu: 25, sigma: 0 }, { mu: Infinity, sigma: 1 }]) {
    expect(() => rateFfa([bad, FFA_INITIAL, FFA_INITIAL, FFA_INITIAL], finish)).toThrow();
  }
});

const host = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!host)("Free-for-all Firestore transactions", () => {
  it("applies a concurrently delivered result once", async () => {
    const store = createFirestore({ projectId: process.env.GCLOUD_PROJECT ?? "demo-antwar", namespace: `ffa-${process.pid}-${Date.now()}`, emulatorHost: host });
    const participants = ["p0", "p1", "p2", "p3"];
    await store.transaction(async () => ({ result: null, writes: participants.map(id => ({ op: "create" as const, path: `identities/${id}`, fields: { displayName: id } })) }));
    const result = { matchId: "match", participants, reason: "time_up", finish };
    const outcomes = await Promise.all([applyFfaResult(store, result), applyFfaResult(store, result)]);
    expect(outcomes.map(o => o.status).sort()).toEqual(["already_applied", "applied"]);
    for (const id of participants) expect((await store.get(`${FFA_COLLECTION}/${id}`))?.ratedMatches).toBe("1");
  }, 30_000);
});
