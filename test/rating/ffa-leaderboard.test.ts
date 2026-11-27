import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { FFA_ESTIMATOR } from "../../src/rating/ffa.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

it("pages by conservative score across storage batches, leaving hidden owners, their handles and unrated players out", async () => {
  const { store, docs } = memoryWatchStore();
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seed = (n: number, mu: number, sigma: number, matches: number, owner?: number) => {
    docs.set(`identities/${id(n)}`, { kind: owner === undefined ? "username" : "handle", displayName: `Player${n}`, claimedAt: String(Date.now()), ...(owner === undefined ? {} : { ownerId: id(owner) }) });
    docs.set(`ratings-ffa/${id(n)}`, { estimator: FFA_ESTIMATOR, mu: String(mu), sigma: String(sigma), ratedMatches: String(matches) });
  };
  // Fill the first storage batch with zero-match rows; the best scores are not the largest means.
  for (let n = 10; n < 110; n++) seed(n, 1, 1, 0);
  seed(1, 50, 20, 3); seed(2, 30, 3, 1); seed(3, 24, 1, 2, 1);
  seed(4, 50, 1, 1); seed(5, 55, 1, 3, 4);
  docs.set("usernames/antwars", { identityId: id(1) });
  const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [id(4)]);
  const readTimes: (string | undefined)[] = [];
  const ratings = createRatings({ ...store, query(collection, options) {
    if (collection === "ratings-ffa") readTimes.push(options.readTime);
    return store.query(collection, options);
  } }, undefined, policy);
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
  expect(readTimes).toEqual([undefined, "2026-10-20T00:00:00Z"]);
  const house = await ratings.ffaLeaderboard({ scope: "house" });
  if (!house.ok) throw new Error(house.reason);
  expect(readTimes).toHaveLength(2);
  expect(house.value.entries.map(row => [row.identityId, row.benchmark])).toEqual([[id(3), true], [id(1), true]]);
});

it("shares a rebuild across scopes and detaches a canceled reader without interrupting another", async () => {
  const { store } = memoryWatchStore();
  const gate = Promise.withResolvers<void>();
  let reads = 0;
  const ratings = createRatings({ ...store, async query(collection, options) {
    if (collection === "ratings-ffa") { reads++; await gate.promise; }
    return store.query(collection, options);
  } });
  const stop = new AbortController();
  const first = ratings.ffaLeaderboard({ limit: 1, signal: stop.signal });
  const second = ratings.ffaLeaderboard({ scope: "house", limit: 10 });
  stop.abort(); await expect(first).rejects.toThrow();
  gate.resolve(); await second; await ratings.ffaLeaderboard();
  expect(reads).toBe(1);
});

it("completes one scan when readers leave and rejoin during the build", async () => {
  const { store, docs } = memoryWatchStore();
  docs.set("ratings-ffa/one", { estimator: FFA_ESTIMATOR, mu: "23", sigma: "4", ratedMatches: "2" });
  const gate = Promise.withResolvers<void>();
  let scans = 0;
  const ratings = createRatings({ ...store, async query(collection, options) {
    if (collection === "ratings-ffa") { scans++; await gate.promise; }
    return store.query(collection, options);
  } });
  for (const limit of [1, 2, 3]) {
    const stop = new AbortController();
    const waiting = ratings.ffaLeaderboard({ limit, signal: stop.signal });
    stop.abort(); await expect(waiting).rejects.toThrow();
  }
  gate.resolve();
  // Give the build a turn to finish with no readers; both scopes must reuse that result.
  await delay(0);
  expect(await ratings.ffaLeaderboard()).toMatchObject({ ok: true, value: { entries: [{ rating: 11 }] } });
  expect(await ratings.ffaLeaderboard({ scope: "house" })).toEqual({ ok: true, value: { entries: [] } });
  expect(scans).toBe(1);
});

it("does not rescan on a storage failure until the cache window ends", async () => {
  const { store } = memoryWatchStore();
  let scans = 0;
  const ratings = createRatings({ ...store, async query(collection, options) {
    if (collection === "ratings-ffa" && ++scans === 1) throw new Error("store unavailable");
    return store.query(collection, options);
  } });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await expect(ratings.ffaLeaderboard()).rejects.toThrow("store unavailable");
    vi.setSystemTime(Date.now() + 59_999);
    await expect(ratings.ffaLeaderboard()).rejects.toThrow("store unavailable");
    expect(scans).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    expect((await ratings.ffaLeaderboard()).ok).toBe(true); expect(scans).toBe(2);
  } finally { vi.useRealTimers(); }
});

it("expires a continuation without rebuilding; a new first page refreshes once", async () => {
  const { docs, store } = memoryWatchStore();
  const query = vi.spyOn(store, "query");
  for (const id of ["one", "two"]) docs.set(`ratings-ffa/${id}`, { estimator: FFA_ESTIMATOR, mu: "4", sigma: "1", ratedMatches: "1" });
  const ratings = createRatings(store);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const page = await ratings.ffaLeaderboard({ limit: 1 });
    if (!page.ok || !page.value.next) throw new Error("expected a continuation");
    vi.setSystemTime(Date.now() + 60_001);
    expect(await ratings.ffaLeaderboard({ cursor: page.value.next })).toEqual({ ok: false, reason: "cursor_expired" });
    const scans = () => query.mock.calls.filter(([collection]) => collection === "ratings-ffa").length;
    expect(scans()).toBe(1); await ratings.ffaLeaderboard(); expect(scans()).toBe(2);
  } finally { vi.useRealTimers(); }
});

it("serves a cold board with 1,000 rated handles using batched identity reads within the page deadline", async () => {
  const { docs, store } = memoryWatchStore();
  docs.set("identities/owner", { kind: "username", displayName: "FixtureOwner", claimedAt: String(Date.now()) });
  for (let i = 0; i < 1000; i++) {
    docs.set(`identities/p${i}`, { kind: "handle", displayName: `FixtureOwner/sample_${i}`, ownerId: "owner" });
    docs.set(`ratings-ffa/p${i}`, { estimator: FFA_ESTIMATOR, mu: String(i), sigma: "1", ratedMatches: "2" });
  }
  let reads = 0;
  const ratings = createRatings({ ...store, async getMany(paths, signal) {
    reads++;
    await delay(50, undefined, { signal });
    return new Map(paths.map(path => [path, docs.get(path) ?? null]));
  } }, { findById: async () => { throw new Error("unexpected per-player lookup"); } });
  const page = await ratings.ffaLeaderboard({ limit: 1, signal: AbortSignal.timeout(5_000) });
  if (!page.ok) throw new Error(page.reason);
  expect(page.value.entries).toMatchObject([{ displayName: "FixtureOwner/sample_999", rating: 996 }]);
  expect(reads).toBeLessThanOrEqual(20);
});

it("uses the current owner's retained name without exposing a released or purged name", async () => {
  const { docs, store } = memoryWatchStore();
  for (const state of ["claimed", "released", "purged"]) {
    docs.set(`identities/${state}`, { kind: "username", displayName: "Meadow", claimedAt: String(Date.now()), nameState: state });
    docs.set(`identities/seat-${state}`, { kind: "handle", ownerId: state, displayName: "Previous/ant" });
    docs.set(`ratings-ffa/seat-${state}`, { estimator: FFA_ESTIMATOR, mu: "25", sigma: "3", ratedMatches: "1" });
  }
  const page = await createRatings(store).ffaLeaderboard();
  if (!page.ok) throw new Error(page.reason);
  expect(Object.fromEntries(page.value.entries.map(row => [row.identityId, row.displayName]))).toEqual({
    "seat-claimed": "Meadow/ant", "seat-released": "account:released/ant", "seat-purged": "account:seat-purged",
  });
});

it("keeps places without linking hidden, test or missing recordings, including on a cached board", async () => {
  const { docs, store } = memoryWatchStore();
  const id = "00000000-0000-4000-8000-000000000001", hidden = "00000000-0000-4000-8000-000000000002";
  const games = ["visible", "hidden", "test", "missing"];
  const replays = games.map((_, i) => `2026-11-27T10-00-00-000Z-${i + 1}`);
  docs.set(`identities/${id}`, { kind: "username", displayName: "Meadow", claimedAt: String(Date.now()) });
  docs.set(`ratings-ffa/${id}`, { estimator: FFA_ESTIMATOR, mu: "28", sigma: "3", ratedMatches: "4", places: "[1,1,1,1]",
    form: JSON.stringify(games.map((matchId, i) => ({ matchId, place: i + 1 }))) });
  for (const [i, game] of games.entries()) {
    docs.set(`lobbies/${game}`, { seats: JSON.stringify([{ id: game === "hidden" ? hidden : id }]) });
    if (game !== "missing") docs.set(`watchMatches/${game}`, { replayId: replays[i] });
  }
  const visibility = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [hidden]);
  const tests = new Set([replays[2]]);
  const ratings = createRatings(store, undefined, visibility, { marked: async () => tests, mark: async () => {} });
  for (const replay of [replays[0], null]) {
    const page = await ratings.ffaLeaderboard();
    if (!page.ok) throw new Error(page.reason);
    expect(page.value.entries[0].form).toEqual([replay, null, null, null].map((replayId, i) => ({ place: i + 1, replayId })));
    tests.add(replays[0]);
  }
});
