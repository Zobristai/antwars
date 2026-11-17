import { expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createPublicVisibility } from "../../src/identity/publicVisibility.ts";
import { createRatings, encodeRating } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

it("keeps filtered leaderboard cursors and rating values, but removes hidden-match links", async () => {
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
  // This in-memory store orders ascending; both pages still retain the store's exact cursor boundary.
  const first = await ratings.leaderboard({ limit: 1 });
  if (!first.ok) throw new Error(first.reason);
  expect(first.value.entries).toEqual([]);
  expect(first.value.next).toBeTruthy();
  const second = await ratings.leaderboard({ limit: 1, cursor: first.value.next });
  if (!second.ok) throw new Error(second.reason);
  expect(second.value.entries.map(row => row.displayName)).toEqual(["Player123"]);
  expect(second.value.entries[0]?.form).toEqual([{ result: "W", replayId: null }]);
  expect((await ratings.readRating(shown)).rating).toBe(1600);
  const unfiltered = createRatings(store, identities);
  await unfiltered.houseBackfill;
  const baseline = await unfiltered.leaderboard();
  if (!baseline.ok) throw new Error(baseline.reason);
  expect(baseline.value.entries).toHaveLength(2);
  expect(baseline.value.entries[0]?.form[0]?.replayId).toBe(replay);
});
