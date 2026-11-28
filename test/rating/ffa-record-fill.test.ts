import { expect, it } from "vitest";
import { FFA_ESTIMATOR } from "../../src/rating/ffa.ts";
import { fillFfaRecords } from "../../src/rating/ffaRecordFill.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { retentionWorld } from "../identity/retentionStore.ts";

// Public recording ids and result.ffa.order mapped through seats to the seven models (in board rank order).
const matches = [
  ["2026-11-27T21-20-48-605Z-273481524881895", [3, 0, 1, 5]],
  ["2026-11-27T19-43-54-595Z-280030393999736", [1, 3, 4, 6]],
  ["2026-11-27T19-05-14-487Z-217310151096884", [0, 2, 4, 5]],
  ["2026-11-27T18-26-14-081Z-39331366701158", [4, 1, 0, 6]],
  ["2026-11-27T17-58-27-696Z-134861558339162", [2, 5, 4, 3]],
  ["2026-11-27T17-33-01-509Z-232717492257893", [0, 2, 6, 5]],
  ["2026-11-27T16-52-02-749Z-204345728559713", [1, 6, 3, 2]],
  ["2026-11-27T16-12-57-681Z-266638481888137", [0, 1, 5, 3]],
  ["2026-11-27T15-34-03-424Z-250394804966273", [2, 1, 5, 6]],
  ["2026-11-27T14-59-02-389Z-33042282761709", [5, 3, 1, 6]],
  ["2026-11-27T12-27-34-202Z-181372719627756", [0, 2, 3, 4]],
] as const;
const tallies = [[4, 1, 1, 0], [2, 3, 2, 0], [2, 3, 0, 1], [1, 2, 2, 2], [1, 0, 3, 1], [1, 1, 2, 3], [0, 1, 1, 4]];
const lastFive = [[2, 1, 3, 1, 1], [3, 1, 2, 1, 2], [2, 1, 2, 4, 1], [1, 2, 4, 3, 4], [3, 3, 1, 3, 4], [4, 4, 2, 4, 3], [4, 4, 3, 2, 4]];
function legacyStore() {
  const { store, docs, commits } = retentionWorld();
  const times = new Map<string, string>();
  matches.forEach(([replayId, order], i) => {
    // Stand-in lobby keys (not replay ids) and distinct commit times in the recorded order.
    const id = `game-${i}`, path = `ffaMatches/${id}`;
    times.set(path, `2026-11-27T22:00:00.${String(100 - i).padStart(6, "0")}Z`);
    docs.set(path, { changes: JSON.stringify(order.map((model, index) => ({ identityId: `p${model}`, place: index + 1 }))) });
    docs.set(`watchMatches/${id}`, { replayId });
  });
  tallies.forEach((row, i) => docs.set(`ratings-ffa/p${i}`, { estimator: FFA_ESTIMATOR, mu: String(35-i), sigma: "3", ratedMatches: String(row.reduce((a,b) => a+b)) }));
  return { docs, commits, times, store: { ...store, createTimes: async () => times } };
}

it("dry-runs the 44 finishes from the eleven public recordings, applies only records, then does nothing on repeat", async () => {
  const { store, commits, docs } = legacyStore();
  const before = new Map(docs);
  const preview = await fillFfaRecords(store);
  expect(preview).toMatchObject({ matches: 11, finishes: 44, rowsToFill: 7 });
  tallies.forEach((counts, i) => {
    expect(preview.records[`p${i}`].places).toEqual(counts);
    expect(preview.records[`p${i}`].form.map(f => f.place)).toEqual(lastFive[i]);
  });
  expect(commits).toHaveLength(0);
  expect(await fillFfaRecords(store, true)).toEqual(preview);
  for (const [path, fields] of before) expect(docs.get(path)).toMatchObject(fields);
  expect(commits[0]?.every(w => w.op === "update" && Object.keys(w.fields).sort().join() === "form,places")).toBe(true);
  expect((await fillFfaRecords(store, true)).rowsToFill).toBe(0);
  expect(commits).toHaveLength(1);
  const page = await createRatings(store).ffaLeaderboard();
  if (!page.ok) throw new Error(page.reason);
  page.value.entries.forEach((row, i) => {
    expect(row.places).toEqual(tallies[i]);
    expect(row.form.map(e => e.replayId)).toEqual(matches.filter(([,order]) => order.some(n => n === i)).slice(0,5).map(([id]) => id));
  });
});

it.each(["missing time", "tied time", "invalid place", "count mismatch", "missing row"])("refuses the entire fill on %s", async kind => {
  const { store, times, docs, commits } = legacyStore();
  if (kind === "missing time") times.delete("ffaMatches/game-0");
  if (kind === "tied time") times.set("ffaMatches/game-0", times.get("ffaMatches/game-1")!);
  if (kind === "invalid place") docs.set("ffaMatches/game-1", { changes: "[]" });
  if (kind === "count mismatch") docs.set("ratings-ffa/p1", { ...docs.get("ratings-ffa/p1"), ratedMatches: "8" });
  if (kind === "missing row") docs.delete("ratings-ffa/p1");
  await expect(fillFfaRecords(store, true)).rejects.toThrow();
  expect(commits).toHaveLength(0);
});
