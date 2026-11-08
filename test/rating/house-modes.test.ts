import { describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import {
  createRatings, encodeRating, INITIAL_RD, RANKED_MODES, ratingCollection, type LeaderboardEntry, type LeaderboardOutcome, type RankedMode, type Ratings,
} from "../../src/rating/ratings.ts";
import { createFirestore, type Store } from "../../src/store/firestore.ts";

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT. Skipped only when the variable is
// unset; when it is set, an unreachable emulator fails every test.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";

const HOUSE_MODES = ["house-1v1", "house-2v2", "house-3v3", "house-4v4"] as const satisfies readonly RankedMode[];

let counter = 0;
const freshNamespace = () => `h${process.pid}-${Date.now().toString(36)}-${counter++}`;

function page(outcome: LeaderboardOutcome) {
  if (!outcome.ok) throw new Error(`expected a page, got ${outcome.reason}`);
  return outcome.value;
}

/** Every page of one mode's leaderboard, following its cursors. */
async function allPages(ratings: Ratings, mode: RankedMode, limit: number): Promise<LeaderboardEntry[]> {
  const entries: LeaderboardEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const current = page(await ratings.leaderboard({ mode, limit, cursor }));
    entries.push(...current.entries);
    if (current.next === undefined) return entries;
    expect(current.entries).toHaveLength(limit);
    cursor = current.next;
  }
}

/** A rating row exactly as a rated result writes it, in the mode's own collection. */
async function seed(store: Store, mode: RankedMode, identityId: string, displayName: string, rating: number, ratedMatches: number) {
  await store.transaction(async () => ({
    result: undefined,
    writes: [{ op: "create", path: `${ratingCollection(mode)}/${identityId}`, fields: { rating: encodeRating(rating), rd: encodeRating(INITIAL_RD), ratedMatches: String(ratedMatches), displayName } }],
  }));
}

describe.skipIf(!host)("house ratings by size against the Firestore emulator", { timeout: 60_000 }, () => {
  it("accepts each house size as a mode, and rating and leaderboard return that size's house ratings only", async () => {
    const store = createFirestore({ projectId, namespace: freshNamespace(), emulatorHost: host });
    const identities = createIdentities(store);
    const ratings = createRatings(store, identities);

    const house = await identities.claimUsername("antwars");
    if (!house.ok) throw new Error(house.reason);
    const handle = async (name: string) => {
      const created = await identities.createHandle(house.value.key, name);
      if (!created.ok) throw new Error(created.reason);
      return created.value.identity;
    };
    const handles = [await handle("ha"), await handle("hb"), await handle("hc"), await handle("hd")];
    const pub = await identities.claimUsername("pub");
    if (!pub.ok) throw new Error(pub.reason);
    const everyone = [house.value.identity, ...handles, pub.value.identity];

    // Every mode holds a different set of identities with different ratings and
    // counts; the public modes also rate two of the house handles. A read that
    // mixed sizes, or house and public modes, would show.
    const rated: Partial<Record<RankedMode, readonly number[]>> = {
      "house-1v1": [0, 1], "house-2v2": [0, 2, 3], "house-3v3": [1], "house-4v4": [3, 2, 1, 0],
      "1v1": [0, 1, 4], "2v2": [0, 1, 4], "3v3": [0, 1, 4], "4v4": [0, 1, 4],
    };
    const expected = new Map<RankedMode, LeaderboardEntry[]>();
    for (const [m, mode] of RANKED_MODES.entries()) {
      const rows = (rated[mode] ?? []).map((index, j): LeaderboardEntry => {
        const identity = [...handles, pub.value.identity][index]!;
        return { identityId: identity.id, displayName: identity.displayName, rating: 1600 - 7 * m - 31 * j + 0.25, rd: 350, ratedMatches: m + 1 + j, thinkingLevel: null, serviceTier: null, benchmark: false, wins: null, losses: null, draws: null, form: [] };
      });
      for (const row of rows) await seed(store, mode, row.identityId, row.displayName, row.rating, row.ratedMatches);
      expected.set(mode, rows);
    }

    const firstPages = new Map<RankedMode, string>();
    for (const mode of HOUSE_MODES) {
      expect(RANKED_MODES).toContain(mode);
      const rows = expected.get(mode)!;
      // rating: that size's house rating, and 1500 with no matches for an identity never rated at that size.
      for (const identity of everyone) {
        const row = rows.find((entry) => entry.identityId === identity.id);
        expect(await ratings.readRating(identity.id, mode), `${mode} ${identity.displayName}`)
          .toEqual(row ? { rating: row.rating, rd: row.rd, ratedMatches: row.ratedMatches } : { rating: 1500, rd: 350, ratedMatches: 0 });
      }
      // leaderboard: exactly the identities rated at that size, with that size's ratings, highest first, on one page or paged.
      expect(page(await ratings.leaderboard({ mode })).entries, mode).toEqual(rows);
      expect(await allPages(ratings, mode, 1), `${mode} paged`).toEqual(rows);
      const first = page(await ratings.leaderboard({ mode, limit: 1 }));
      if (first.next !== undefined) firstPages.set(mode, first.next);
    }

    // A house size's cursor pages only that size.
    for (const [mode, cursor] of firstPages) {
      for (const other of RANKED_MODES.filter((candidate) => candidate !== mode)) {
        expect(await ratings.leaderboard({ mode: other, limit: 1, cursor }), `${mode} cursor on ${other}`).toEqual({ ok: false, reason: "invalid_cursor" });
      }
    }
    expect([...firstPages.keys()].sort()).toEqual(["house-1v1", "house-2v2", "house-4v4"]);
  });
});
