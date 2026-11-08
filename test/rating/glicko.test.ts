import { describe, expect, it } from "vitest";
import { DAY_MS, INITIAL_RD, MAX_RD, RD_GROWTH_PER_DAY, glickoExpected, glickoUpdate, inflatedRd, teamAsOpponent } from "../../src/rating/glicko.ts";
import { createRatings, encodeRating, rateMatch, storedState, UNRATED } from "../../src/rating/ratings.ts";
import { FIRST_LOSS, FIRST_WIN } from "./glicko-values.ts";
import { retentionWorld, value } from "../identity/retentionStore.ts";

/** Glicko-1 written out independently of src (Glickman, "The Glicko system", 1995), for one rating period. */
function independent(r: number, rd: number, opponents: readonly (readonly [number, number, number])[]) {
  const q = Math.log(10) / 400;
  const g = (x: number) => 1 / Math.sqrt(1 + (3 * q * q * x * x) / (Math.PI * Math.PI));
  const e = (rj: number, rdj: number) => 1 / (1 + Math.pow(10, (-g(rdj) * (r - rj)) / 400));
  const d2 = 1 / (q * q * opponents.reduce((sum, [rj, rdj]) => sum + g(rdj) ** 2 * e(rj, rdj) * (1 - e(rj, rdj)), 0));
  const precision = 1 / (rd * rd) + 1 / d2;
  return { rating: r + (q / precision) * opponents.reduce((sum, [rj, rdj, s]) => sum + g(rdj) * (s - e(rj, rdj)), 0), rd: Math.sqrt(1 / precision) };
}

describe("Glicko-1", () => {
  it("reproduces Glickman's worked example: 1500 ± 200 against 1400 ± 30 (won), 1550 ± 100 and 1700 ± 300 (lost)", () => {
    const after = glickoUpdate({ rating: 1500, rd: 200 }, [
      { rating: 1400, rd: 30, score: 1 }, { rating: 1550, rd: 100, score: 0 }, { rating: 1700, rd: 300, score: 0 },
    ]);
    // The paper rounds to 1464 and 151.4.
    expect(after.rating).toBeCloseTo(1464, 0);
    expect(after.rd).toBeCloseTo(151.4, 1);
    const check = independent(1500, 200, [[1400, 30, 1], [1550, 100, 0], [1700, 300, 0]]);
    expect(after.rating).toBeCloseTo(check.rating, 9);
    expect(after.rd).toBeCloseTo(check.rd, 9);
    expect(glickoExpected(1500, 1400, 30)).toBeCloseTo(0.639, 3);
  });

  it("starts every player at 1500 ± 350, and the first result between two of them gives FIRST_WIN and FIRST_LOSS", () => {
    expect([UNRATED.rating, UNRATED.rd, INITIAL_RD]).toEqual([1500, 350, 350]);
    expect(storedState("a", null)).toEqual({ rating: 1500, rd: 350, ratedAt: null, ratedMatches: 0 });
    const win = independent(1500, 350, [[1500, 350, 1]]), loss = independent(1500, 350, [[1500, 350, 0]]);
    expect(FIRST_WIN.rating).toBeCloseTo(win.rating, 9); expect(FIRST_WIN.rd).toBeCloseTo(win.rd, 9);
    expect(FIRST_LOSS.rating).toBeCloseTo(loss.rating, 9); expect(FIRST_LOSS.rd).toBeCloseTo(loss.rd, 9);
    const { changes } = rateMatch([["a"], ["b"]], "a", 0, () => UNRATED);
    expect(changes).toEqual([
      { identityId: "a", before: 1500, after: FIRST_WIN.rating, rdBefore: 350, rdAfter: FIRST_WIN.rd },
      { identityId: "b", before: 1500, after: FIRST_LOSS.rating, rdBefore: 350, rdAfter: FIRST_LOSS.rd },
    ]);
    // A draw between equals moves no rating, and still narrows both RDs.
    const draw = rateMatch([["a"], ["b"]], "draw", 0, () => UNRATED).changes;
    expect(draw.map((change) => change.after)).toEqual([1500, 1500]);
    expect(draw[0]!.rdAfter).toBe(FIRST_WIN.rd);
  });

  it("grows RD by the time since the player's previous rated match, back to 350 after a year from 50, never above 350", () => {
    expect(inflatedRd(50, null)).toBe(50);
    expect(inflatedRd(50, 0)).toBe(50);
    expect(inflatedRd(50, -DAY_MS)).toBe(50);
    expect(inflatedRd(50, DAY_MS)).toBeCloseTo(Math.sqrt(50 ** 2 + RD_GROWTH_PER_DAY ** 2), 12);
    expect(inflatedRd(50, 365 * DAY_MS)).toBeCloseTo(MAX_RD, 9);
    expect(inflatedRd(50, 1000 * DAY_MS)).toBe(MAX_RD);
    // The growth is applied before the match, from the stored RD and match times.
    const state = { rating: 1600, rd: 80, ratedAt: 1_000, ratedMatches: 12 };
    const later = 1_000 + 30 * DAY_MS;
    const { changes, next } = rateMatch([["a"], ["b"]], "b", later, (id) => id === "a" ? state : UNRATED);
    const grown = inflatedRd(80, 30 * DAY_MS);
    const expected = independent(1600, grown, [[1500, 350, 0]]);
    expect(changes[0]).toMatchObject({ before: 1600, rdBefore: 80 });
    expect(changes[0]!.after).toBeCloseTo(expected.rating, 9);
    expect(changes[0]!.rdAfter).toBeCloseTo(expected.rd, 9);
    expect(next.get("a")).toEqual({ rating: changes[0]!.after, rd: changes[0]!.rdAfter, ratedAt: later, ratedMatches: 13 });
  });

  it("rates each player of a team against the other team's mean rating and root-mean-square RD, by its own RD", () => {
    const states = new Map([["a1", { rating: 1600, rd: 60, ratedAt: null, ratedMatches: 30 }], ["a2", { rating: 1400, rd: 300, ratedAt: null, ratedMatches: 1 }],
      ["b1", { rating: 1550, rd: 100, ratedAt: null, ratedMatches: 8 }], ["b2", { rating: 1450, rd: 200, ratedAt: null, ratedMatches: 4 }]]);
    const { changes } = rateMatch([["a1", "a2"], ["b1", "b2"]], "a", null, (id) => states.get(id)!);
    const b = teamAsOpponent([{ rating: 1550, rd: 100 }, { rating: 1450, rd: 200 }]);
    expect(b).toEqual({ rating: 1500, rd: Math.sqrt((100 ** 2 + 200 ** 2) / 2) });
    const a1 = independent(1600, 60, [[b.rating, b.rd, 1]]), a2 = independent(1400, 300, [[b.rating, b.rd, 1]]);
    expect(changes[0]!.after).toBeCloseTo(a1.rating, 9);
    expect(changes[1]!.after).toBeCloseTo(a2.rating, 9);
    // The uncertain player moves much further on the same result.
    expect(changes[1]!.after - 1400).toBeGreaterThan(3 * (changes[0]!.after - 1600));
  });

  it("rejects a stored row without rd as malformed, like a bad rated-match count", () => {
    const row = { rating: encodeRating(1550), ratedMatches: "6", displayName: "ann" };
    expect(() => storedState("ann", row)).toThrow("invalid stored rd for ann");
    expect(() => storedState("ann", { ...row, rd: "" })).toThrow("invalid stored rd for ann");
    expect(storedState("ann", { ...row, rd: encodeRating(120) })).toEqual({ rating: 1550, rd: 120, ratedAt: null, ratedMatches: 6 });
  });

  it("rates a live result by Glicko: rating, RD and match time on the row, RDs on the change record", async () => {
    const w = retentionWorld(1_000);
    const a = value(await w.ids.claimUsername("ann")).identity, b = value(await w.ids.claimUsername("bob")).identity;
    // a was last rated without a match time: rd 350, no ratedAt.
    w.docs.set(`ratings/${a.id}`, { rating: encodeRating(1550), rd: encodeRating(INITIAL_RD), ratedMatches: "6", displayName: "ann" });
    const ratings = createRatings(w.store, w.ids);
    await ratings.houseBackfill;
    expect(await ratings.readRating(a.id)).toEqual({ rating: 1550, rd: 350, ratedMatches: 6 });
    const outcome = await ratings.applyResult({ matchId: "m1", teams: [[a.id], [b.id]], winner: "b", at: 40_000 });
    const expectedA = independent(1550, 350, [[1500, 350, 0]]);
    if (outcome.status !== "applied") throw new Error("not applied");
    expect(outcome.changes[0]).toMatchObject({ identityId: a.id, before: 1550, rdBefore: 350 });
    expect(outcome.changes[0]!.after).toBeCloseTo(expectedA.rating, 9);
    const row = w.docs.get(`ratings/${a.id}`)!;
    expect(row).toMatchObject({ rating: encodeRating(outcome.changes[0]!.after), rd: encodeRating(outcome.changes[0]!.rdAfter!), ratedAt: "40000", ratedMatches: "7" });
    expect(await ratings.readMatchChanges("m1")).toEqual(outcome.changes);
    expect(await ratings.readRating(b.id)).toEqual({ rating: outcome.changes[1]!.after, rd: outcome.changes[1]!.rdAfter, ratedMatches: 1 });
  });
});
