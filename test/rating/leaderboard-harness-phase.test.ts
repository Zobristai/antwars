import { describe, expect, it } from "vitest";
import { createRatings, type LeaderboardOutcome, type RankedMode } from "../../src/rating/ratings.ts";
import { memoryWatchStore } from "../live/watch-fixtures.ts";

const at = (iso: string) => String(Date.parse(iso));
const REPLAY = "2026-11-07T07-47-08-869Z-1";

/** Two identities with one rated result per listed match in the mode, oldest first, and the matches' lobbies as stored. */
async function world(mode: RankedMode, matches: readonly string[]) {
  const { docs, store } = memoryWatchStore();
  for (const id of ["alpha", "beta"]) docs.set(`identities/${id}`, { displayName: id });
  docs.set("lobbies/r26", { state: "ended", startsAt: at("2026-11-07T07:47:00Z"), createdAt: at("2026-11-07T07:40:00Z") });
  docs.set("lobbies/r8", { state: "ended", createdAt: at("2026-10-27T07:12:00Z") });
  docs.set("lobbies/early", { state: "ended", startsAt: at("2026-10-26T01:38:30Z"), createdAt: at("2026-10-26T01:37:00Z") });
  docs.set("lobbies/late", { state: "ended", startsAt: at("2026-11-10T02:00:00Z"), createdAt: at("2026-11-10T01:59:00Z") });
  docs.set("lobbies/unreadable", { state: "ended", startsAt: "soon" });
  docs.set("watchMatches/r26", { replayId: REPLAY });
  const ratings = createRatings(store, { findById: async (id: string) => ({ displayName: id }) } as never);
  await ratings.houseBackfill;
  for (const matchId of matches) await ratings.applyResult({ matchId, teams: [["alpha"], ["beta"]], winner: "a", mode });
  return { docs, ratings };
}

const entries = (outcome: LeaderboardOutcome) => {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value.entries;
};

describe("leaderboard form entries in a Model Index mode carry each match's harness phase", () => {
  it("labels each form entry by its lobby's match time, unknown where the lobby or its time cannot be read, writing nothing", async () => {
    const { docs, ratings } = await world("house-1v1", ["early", "r8", "r26", "late", "unreadable"]);
    const before = JSON.stringify([...docs]);
    const alpha = entries(await ratings.leaderboard({ mode: "house-1v1" })).find(entry => entry.identityId === "alpha");
    expect(alpha!.form).toEqual([
      { result: "W", replayId: null, harnessPhase: { phase: "unknown", possibleEffortMismatch: null } },
      { result: "W", replayId: null, harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } },
      { result: "W", replayId: REPLAY, harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } },
      { result: "W", replayId: null, harnessPhase: { phase: "rounds 8-10", possibleEffortMismatch: false } },
      { result: "W", replayId: null, harnessPhase: { phase: "rounds 1-7", possibleEffortMismatch: true } },
    ]);
    // A match with no stored lobby has no readable time.
    const missing = await world("house-2v2", ["gone"]);
    expect(entries(await missing.ratings.leaderboard({ mode: "house-2v2" })).find(entry => entry.identityId === "alpha")!.form)
      .toEqual([{ result: "W", replayId: null, harnessPhase: { phase: "unknown", possibleEffortMismatch: null } }]);
    // Reading changes no stored rating, RD, record or change record.
    expect(JSON.stringify([...docs])).toBe(before);
  });

  it("leaves form entries in every other mode exactly { result, replayId }", async () => {
    for (const mode of ["1v1", "4v4"] as const) {
      const { ratings } = await world(mode, ["r26"]);
      for (const entry of entries(await ratings.leaderboard({ mode }))) {
        expect(entry.form).toEqual([{ result: entry.identityId === "alpha" ? "W" : "L", replayId: REPLAY }]);
        expect(Object.keys(entry.form[0]!)).toEqual(["result", "replayId"]);
      }
    }
  });

  it("keeps every other entry field as it was", async () => {
    const { ratings } = await world("house-3v3", ["r26"]);
    const plain = await world("3v3", ["r26"]);
    const strip = (outcome: LeaderboardOutcome) => entries(outcome).map(({ form, ...rest }) => ({ ...rest, form: form.map(({ result, replayId }) => ({ result, replayId })) }));
    expect(strip(await ratings.leaderboard({ mode: "house-3v3" }))).toEqual(strip(await plain.ratings.leaderboard({ mode: "3v3" })));
  });
});

describe("leaderboard form entries carry a match's public note", () => {
  const NOTED = "c0bce8df-1c3f-46c0-b6dd-1ffec3e15f82";
  it("adds the note to the noted match's form entry only, in any mode, writing nothing", async () => {
    for (const mode of ["house-1v1", "1v1"] as const) {
      const { docs, ratings } = await world(mode, ["r26", NOTED]);
      const before = JSON.stringify([...docs]);
      const alpha = entries(await ratings.leaderboard({ mode })).find(entry => entry.identityId === "alpha")!;
      expect(alpha.form.map(entry => entry.note)).toEqual(["Self-reported scripted-play breach: one accepted command, at tick 6556", undefined]);
      expect("note" in alpha.form[1]!).toBe(false);
      expect(JSON.stringify([...docs])).toBe(before);
    }
  });
});
