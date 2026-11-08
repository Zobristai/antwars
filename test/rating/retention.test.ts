import { describe, expect, it } from "vitest";
import { createRatings } from "../../src/rating/ratings.js";
import { retentionWorld, value } from "../identity/retentionStore.js";

const DAY = 86_400_000;
describe("ratings through name release", () => {
  it("preserves ratings/history while projecting placeholders and replacement names, including handles", async () => {
    const w = retentionWorld(), start = w.now();
    const owner = value(await w.ids.claimUsername("original")), other = value(await w.ids.claimUsername("opponent"));
    const handle = value(await w.ids.createHandle(owner.key, "scout"));
    for (const id of [owner.identity.id, other.identity.id, handle.identity.id]) await w.ids.recordMatchJoin(id);
    const ratings = createRatings(w.store, w.ids);
    await ratings.applyResult({ matchId: "history", teams: [[owner.identity.id, handle.identity.id], [other.identity.id]], winner: "a" });
    const before = await ratings.readRating(owner.identity.id), handleBefore = await ratings.readRating(handle.identity.id);
    const history = await ratings.readMatchChanges("history");
    w.at(start + 90 * DAY);
    const newOwner = value(await w.ids.claimUsername("original"));
    const page = await ratings.leaderboard();
    if (!page.ok) throw new Error(page.reason);
    expect(page.value.entries.find(entry => entry.identityId === owner.identity.id)?.displayName).toBe(`account:${owner.identity.id}`);
    expect(page.value.entries.find(entry => entry.identityId === handle.identity.id)?.displayName).toBe(`account:${owner.identity.id}/scout`);
    expect(page.value.entries.some(entry => entry.identityId === newOwner.identity.id)).toBe(false);
    expect(await ratings.readRating(newOwner.identity.id)).toEqual({ rating: 1500, rd: 350, ratedMatches: 0 });
    expect(await ratings.readRating(owner.identity.id)).toEqual(before);
    expect(await ratings.readRating(handle.identity.id)).toEqual(handleBefore);
    expect(await ratings.readMatchChanges("history")).toEqual(history);
    value(await w.ids.claimUsername("replacement", undefined, owner.key));
    const renamed = await ratings.leaderboard();
    if (!renamed.ok) throw new Error(renamed.reason);
    expect(renamed.value.entries.find(entry => entry.identityId === owner.identity.id)?.displayName).toBe("replacement");
    expect(renamed.value.entries.find(entry => entry.identityId === handle.identity.id)?.displayName).toBe("replacement/scout");
    expect(await ratings.readMatchChanges("history")).toEqual(history);
  });

  it("keeps rating snapshot pagination while an old cursor shows current, non-misattributed names", async () => {
    const w = retentionWorld(), start = w.now();
    const first = value(await w.ids.claimUsername("first")), second = value(await w.ids.claimUsername("second"));
    await w.ids.recordMatchJoin(first.identity.id); await w.ids.recordMatchJoin(second.identity.id);
    const ratings = createRatings(w.store, w.ids);
    await ratings.applyResult({ matchId: "before", teams: [[first.identity.id], [second.identity.id]], winner: "a" });
    const page = await ratings.leaderboard({ limit: 1 });
    if (!page.ok || !page.value.next) throw new Error("expected next page");
    w.at(start + 90 * DAY);
    value(await w.ids.claimUsername("second"));
    const next = await ratings.leaderboard({ limit: 1, cursor: page.value.next });
    if (!next.ok) throw new Error(next.reason);
    expect(next.value.entries).toEqual([{ identityId: second.identity.id, displayName: `account:${second.identity.id}`,
      ...(await ratings.readRating(second.identity.id)), thinkingLevel: null, serviceTier: null, benchmark: false,
      wins: 0, losses: 1, draws: 0, form: [{ result: "L", replayId: null }] }]);
    expect(next.value.next).toBeUndefined();
  });
});
