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
