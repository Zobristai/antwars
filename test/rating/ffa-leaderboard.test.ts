import { expect, it } from "vitest";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { FFA_ESTIMATOR } from "../../src/rating/ffa.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

it("pages by conservative score across storage batches, leaving hidden owners, their handles and unrated players out", async () => {
  const { store, docs } = memoryWatchStore();
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seed = (n: number, mu: number, sigma: number, matches: number, owner?: number) => {
    docs.set(`identities/${id(n)}`, { kind: owner === undefined ? "username" : "handle", ...(owner === undefined ? {} : { ownerId: id(owner) }) });
    docs.set(`ratings-ffa/${id(n)}`, { estimator: FFA_ESTIMATOR, mu: String(mu), sigma: String(sigma), ratedMatches: String(matches) });
  };
  // Fill the first storage batch with zero-match rows; the best scores are not the largest means.
  for (let n = 10; n < 110; n++) seed(n, 1, 1, 0);
  seed(1, 50, 20, 3); seed(2, 30, 3, 1); seed(3, 24, 1, 2, 1);
  seed(4, 50, 1, 1); seed(5, 55, 1, 3, 4);
  docs.set("usernames/antwars", { identityId: id(1) });
  const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [id(4)]);
  const identities = { findById: async (id: string) => ({ id, kind: "username" as const, displayName: id }) };
  const readTimes: (string | undefined)[] = [];
  const ratings = createRatings({ ...store, query(collection, options) {
    if (collection === "ratings-ffa") readTimes.push(options.readTime);
    return store.query(collection, options);
  } }, identities, policy);
  const out: [string, number][] = [];
  let cursor: string | undefined;
  do {
    const page = await ratings.ffaLeaderboard({ limit: 1, cursor });
    if (!page.ok) throw new Error(page.reason);
    out.push(...page.value.entries.map(row => [row.identityId, row.rating] as [string, number]));
    cursor = page.value.next;
    if (cursor) {
      expect(await ratings.ffaLeaderboard({ cursor, scope: "house" })).toEqual({ ok: false, reason: "invalid_cursor" });
      expect(await ratings.leaderboard({ cursor })).toEqual({ ok: false, reason: "invalid_cursor" });
    }
    expect(out.length).toBeLessThanOrEqual(3);
  } while (cursor);
  expect(out).toEqual([[id(3), 21], [id(2), 21], [id(1), -10]]);
  expect(readTimes[0]).toBeUndefined();
  expect(readTimes.slice(1)).toEqual(Array(5).fill("2026-10-20T00:00:00Z"));
  const house = await ratings.ffaLeaderboard({ scope: "house" });
  if (!house.ok) throw new Error(house.reason);
  expect(house.value.entries.map(row => [row.identityId, row.benchmark])).toEqual([[id(3), true], [id(1), true]]);
});
