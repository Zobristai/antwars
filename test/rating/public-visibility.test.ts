import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { createRatings, encodeRating } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

it("fills a filtered page without exposing its hidden boundary and removes hidden-match links", async () => {
  const { store, docs } = memoryWatchStore();
  const identities = createIdentities(store);
  const a = await identities.claimUsername("Meadow"), b = await identities.claimUsername("Player123");
  if (!a.ok || !b.ok) throw new Error("fixture failed");
  const excluded = a.value.identity.id, shown = b.value.identity.id;
  const match = "00000000-0000-4000-8000-000000000003";
  const replay = "2026-10-20T10-00-00-000Z-1";
  docs.set(`lobbies/${match}`, { seats: JSON.stringify([{ id: excluded }, { id: shown }]) });
  docs.set(`watchMatches/${match}`, { replayId: replay });
  for (const [id, rating] of [[excluded, 1400], [shown, 1600]] as const) {
    docs.set(`ratings/${id}`, { rating: encodeRating(rating), rd: encodeRating(80), ratedMatches: "1", wins: "1", losses: "0", draws: "0", form: `W:${match}` });
  }
  const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "found", lobbyId: match }) }, [excluded]);
  const ratings = createRatings(store, identities, policy);
  await ratings.houseBackfill;
  const first = await ratings.leaderboard({ limit: 1 });
  if (!first.ok) throw new Error(first.reason);
  expect(first.value.entries.map(row => row.displayName)).toEqual(["Player123"]);
  expect(first.value.next).toBeUndefined();
  expect(first.value.entries[0]?.form).toEqual([{ result: "W", replayId: null }]);
  expect((await ratings.readRating(shown)).rating).toBe(1600);
  const unfiltered = createRatings(store, identities);
  await unfiltered.houseBackfill;
  const baseline = await unfiltered.leaderboard();
  if (!baseline.ok) throw new Error(baseline.reason);
  expect(baseline.value.entries).toHaveLength(2);
  expect(baseline.value.entries[0]?.form[0]?.replayId).toBe(replay);
});


describe("public leaderboard continuations", () => {
  it.each([{ hidden: [0] }, { hidden: [1] }, { hidden: [1, 2, 3] }, { hidden: [4, 5] }, { hidden: [0, 1, 2, 3, 4, 5] }])("pages completely without encoding excluded rows $hidden", async ({ hidden }) => {
    const memory = memoryWatchStore(), { docs } = memory;
    const reads: { readTime?: string }[] = [];
    const readTime = "2026-10-20T00:00:00Z";
    const store = { ...memory.store, query: async (collection: string, options: import("../../src/store/firestore.ts").QueryOptions) => {
      reads.push({ readTime: options.readTime });
      const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
      const direction = options.direction === "ASCENDING" ? 1 : -1;
      const rows = [...docs].filter(([path, fields]) => path.startsWith(`${collection}/`) && fields[options.orderBy] !== undefined)
        .map(([path, fields]) => ({ path, fields })).sort((a, b) => direction *
          (compare(a.fields[options.orderBy]!, b.fields[options.orderBy]!) || compare(a.path, b.path)));
      const after = options.startAfter;
      return { readTime, rows: rows.filter(row => !after || direction *
        (compare(row.fields[options.orderBy]!, after.value) || compare(row.path, after.path)) > 0).slice(0, options.limit) };
    } };
    const identities = createIdentities(store), ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const claimed = await identities.claimUsername(`Player${index}`);
      if (!claimed.ok) throw new Error(claimed.reason);
      ids.push(claimed.value.identity.id);
      docs.set(`ratings/${ids[index]}`, { rating: encodeRating(1800 - index * 100), rd: encodeRating(80), ratedMatches: "1" });
    }
    const excluded = hidden.map(index => ids[index]!);
    const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, excluded)!;
    const ratings = createRatings(store, identities, policy); await ratings.houseBackfill;
    const baseline = await ratings.leaderboard({ limit: 100 }); if (!baseline.ok) throw new Error(baseline.reason);
    reads.length = 0;
    const entries: typeof baseline.value.entries[number][] = [];
    let cursor: string | undefined, pages = 0;
    do {
      const page = await ratings.leaderboard({ limit: 1, cursor }); if (!page.ok) throw new Error(page.reason);
      entries.push(...page.value.entries);
      cursor = page.value.next; pages++;
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        const returned = page.value.entries.at(-1)!;
        expect(decoded).toEqual([readTime, encodeRating(returned.rating), returned.identityId]);
        for (const index of hidden) {
          expect(decoded).not.toContain(ids[index]);
          expect(decoded).not.toContain(encodeRating(1800 - index * 100));
        }
      }
      expect(pages).toBeLessThanOrEqual(6);
    } while (cursor);
    expect(entries).toEqual(baseline.value.entries);
    expect(entries.map(entry => entry.identityId)).toEqual(ids.filter((_, index) => !hidden.includes(index)));
    expect(reads[0]?.readTime).toBeUndefined();
    expect(reads.slice(1).every(read => read.readTime === readTime)).toBe(true);
  });
});

describe("public leaderboard read cost", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seed = () => {
    const memory = memoryWatchStore(), { docs } = memory;
    const owner = uuid(1), handle = uuid(2), ids: string[] = [owner, handle];
    docs.set(`identities/${owner}`, { kind: "username", displayName: "Owner" });
    docs.set(`identities/${handle}`, { kind: "handle", ownerId: owner, displayName: "Owner/leaf" });
    for (let n = 3; n < 63; n++) { ids.push(uuid(n)); docs.set(`identities/${uuid(n)}`, { kind: "username", displayName: `Player${n}` }); }
    const matches: string[] = [];
    // Five form matches per row, about 150 distinct; the first is shared with the hidden handle.
    for (const [index, id] of ids.entries()) {
      const form = Array.from({ length: 5 }, (_, k) => uuid(1000 + index * 3 + k));
      matches.push(...form);
      docs.set(`ratings-house-1v1/${id}`, { rating: encodeRating(2000 - index), rd: encodeRating(80), ratedMatches: "5",
        wins: "5", losses: "0", draws: "0", form: form.map(match => `W:${match}`).join(" ") });
    }
    for (const [index, match] of [...new Set(matches)].entries()) {
      // Only one match seats a hidden identity: the visible players are seated everywhere else.
      const players = ids.slice(2), opponent = match === uuid(1000 + 2 * 3) ? handle : players[(index + 7) % players.length]!;
      docs.set(`lobbies/${match}`, { seats: JSON.stringify([{ id: players[index % players.length]! }, { id: opponent }]), startsAt: "1760000000000" });
      docs.set(`watchMatches/${match}`, { replayId: `2026-10-20T10-00-00-000Z-${index + 1}` });
    }
    // The shared memory store orders ascending only; the leaderboard reads descending.
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const store = { ...memory.store, query: async (collection: string, options: import("../../src/store/firestore.ts").QueryOptions) => {
      const direction = options.direction === "ASCENDING" ? 1 : -1, after = options.startAfter;
      const rows = [...docs].filter(([path, fields]) => path.startsWith(`${collection}/`) && fields[options.orderBy] !== undefined)
        .map(([path, fields]) => ({ path, fields })).sort((a, b) => direction *
          (compare(a.fields[options.orderBy]!, b.fields[options.orderBy]!) || compare(a.path, b.path)))
        .filter(row => !after || direction * (compare(row.fields[options.orderBy]!, after.value) || compare(row.path, after.path)) > 0);
      return { readTime: "2026-10-20T00:00:00Z", rows: rows.slice(0, options.limit) };
    } };
    return { memory: { docs, store }, owner, handle };
  };
  const findById = { findById: async (id: string) => ({ id, kind: "username" as const, displayName: id }) };

  it("reads a 50-row page with the hide list on in a fixed number of store reads", async () => {
    const { memory, owner, handle } = seed();
    const counts = { get: 0, transaction: 0, query: 0 };
    const store = { ...memory.store,
      get: (path: string) => { counts.get++; return memory.store.get(path); },
      transaction: ((step: never) => { counts.transaction++; return memory.store.transaction(step); }) as typeof memory.store.transaction,
      query: (collection: string, options: import("../../src/store/firestore.ts").QueryOptions) => { counts.query++; return memory.store.query(collection, options); } };
    const policy = createPublicVisibility(store, { replayLobby: async () => ({ state: "none" }) }, [owner])!;
    const ratings = createRatings(store, findById, policy); await ratings.houseBackfill;
    counts.get = counts.transaction = counts.query = 0;
    const page = await ratings.leaderboard({ mode: "house-1v1", limit: 50 });
    if (!page.ok) throw new Error(page.reason);
    // One identities read per query page, then one batched match read and one seat read for every form match.
    expect(counts.query).toBe(2);
    expect(counts.transaction).toBe(counts.query + 2);
    expect(counts.get).toBe(0);

    const unfiltered = createRatings(memory.store, findById); await unfiltered.houseBackfill;
    const all = await unfiltered.leaderboard({ mode: "house-1v1", limit: 100 });
    if (!all.ok) throw new Error(all.reason);
    const hiddenMatch = uuid(1000 + 2 * 3);
    const expected = all.value.entries.filter(entry => entry.identityId !== owner && entry.identityId !== handle).slice(0, 50)
      .map(entry => ({ ...entry, form: entry.form.map((item, k) => entry.identityId === uuid(3) && k === 0
        // A hidden match keeps its result and shows neither its link nor its time.
        ? { ...item, replayId: null, harnessPhase: { phase: "unknown", possibleEffortMismatch: null } } : item) }));
    expect(page.value.entries).toEqual(expected);
    expect(page.value.entries.flatMap(entry => entry.form).filter(item => item.replayId === null)).toHaveLength(1);
    expect(page.value.entries.flatMap(entry => entry.form).map(item => item.replayId))
      .not.toContain(memory.docs.get(`watchMatches/${hiddenMatch}`)!.replayId);
  });

  it.each([["unreadable", null], ["malformed", { seats: "not json" }]] as const)("fails the read on a %s match record", async (_, lobby) => {
    const { memory, owner } = seed();
    const match = uuid(1000 + 30 * 3 + 1);
    if (lobby === null) memory.docs.delete(`lobbies/${match}`); else memory.docs.set(`lobbies/${match}`, lobby);
    const policy = createPublicVisibility(memory.store, { replayLobby: async () => ({ state: "none" }) }, [owner])!;
    const ratings = createRatings(memory.store, findById, policy); await ratings.houseBackfill;
    await expect(ratings.leaderboard({ mode: "house-1v1", limit: 50 })).rejects.toThrow("Public visibility temporarily unavailable");
  });
});
