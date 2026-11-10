import { describe, expect, it } from "vitest";
import { listedMatches, matchWatchStatus, publicMatchCatalog, type CatalogMatch } from "../../src/live/match-catalog.js";

const publicMatch: CatalogMatch = { lobbyId: "first", visibility: "public", rated: true, startedAt: 1000, playbackFinished: false };

describe("public spectator catalog projection", () => {
  it("projects authoritative feed status without clock-derived start or hidden layout", () => {
    const extra = { ...publicMatch, startsAt: 0, picks: [{ x: 4, y: 5 }] };
    expect(matchWatchStatus(extra, "waiting")).toEqual({ lobbyId: "first", started: false, playbackFinished: false, delaySeconds: 300 });
    expect(matchWatchStatus(extra, "started")).toEqual({ lobbyId: "first", started: true, playbackFinished: false, delaySeconds: 300 });
    expect(matchWatchStatus(extra, "finished")).toEqual({ lobbyId: "first", started: true, playbackFinished: true, delaySeconds: 300 });
  });
  it("excludes private data and only projects safe discovery fields", () => {
    const result = publicMatchCatalog([
      { ...publicMatch, inviteVerifier: "never-public", startingQueens: [{ x: 1, y: 2 }] } as CatalogMatch,
      { ...publicMatch, lobbyId: "secret", visibility: "private" },
    ], [
      { id: "public", kind: "public", state: "open", size: 1, colonies: [[{ displayName: "owner/agent" }], []] },
      { id: "private", kind: "private", state: "open", size: 1, colonies: [[], []] },
    ]);
    expect(result).toEqual({
      matches: [{ lobbyId: "first", startedAt: 1000, rated: true, delaySeconds: 300, colonies: [[], []] }],
      lobbies: [{ id: "public", size: 1, state: "open", colonies: [["owner/agent"], []] }],
    });
  });

  it("keeps a delayed match listed while the same slot starts another match", () => {
    const next: CatalogMatch = { ...publicMatch, lobbyId: "next", rated: false, startedAt: 2000 };
    expect(publicMatchCatalog([next, publicMatch], []).matches.map(match => match.lobbyId)).toEqual(["first", "next"]);
    expect(publicMatchCatalog([next, { ...publicMatch, playbackFinished: true }], []).matches).toEqual([
      { lobbyId: "next", startedAt: 2000, rated: false, delaySeconds: 60, colonies: [[], []] },
    ]);
  });

  it("does not turn completed/expired lobbies into open lobbies", () => {
    const base = { id: "lobby", kind: "public" as const, size: 1, colonies: [[], []] };
    const entries = publicMatchCatalog([], ["open", "waiting", "holding", "ended", "expired"].map(state => ({ ...base, id: state, state }))).lobbies;
    expect(entries.map(lobby => lobby.id)).toEqual(["open", "waiting"]);
  });

  it("copies player name arrays instead of exposing mutable store rows", () => {
    const colonies = [[{ displayName: "original" }], []];
    const result = publicMatchCatalog([], [{ id: "lobby", kind: "public", size: 1, state: "open", colonies }]);
    colonies[0]![0]!.displayName = "changed";
    expect(result.lobbies[0]!.colonies).toEqual([["original"], []]);
  });

  it("carries each listed match's players with exactly their four public fields, copied", () => {
    const rated = { displayName: "alice", rating: 1612.4, rd: 80, ratedMatches: 4, identityId: "never-public", key: "secret" };
    const unrated = { displayName: "bob", rating: null, rd: null, ratedMatches: null, identityId: "never-public" };
    const players = new Map([
      ["first", [[rated], [unrated]]],
      ["secret", [[rated], []]],
    ]) as unknown as Parameters<typeof publicMatchCatalog>[2];
    const result = publicMatchCatalog([publicMatch, { ...publicMatch, lobbyId: "secret", visibility: "private" }], [], players);
    expect(result.matches).toEqual([{ lobbyId: "first", startedAt: 1000, rated: true, delaySeconds: 300, colonies: [
      [{ displayName: "alice", rating: 1612.4, rd: 80, ratedMatches: 4 }], [{ displayName: "bob", rating: null, rd: null, ratedMatches: null }],
    ] }]);
    rated.displayName = "changed";
    expect(result.matches[0]!.colonies[0][0]!.displayName).toBe("alice");
    expect(JSON.stringify(result)).not.toMatch(/never-public|secret/);
  });

  it("labels a live Model Index match with its harness phase by its start, and no other match", () => {
    const afterRound30 = Date.parse("2026-11-10T02:00:00Z");
    const result = publicMatchCatalog([
      { ...publicMatch, lobbyId: "index", mode: "house-1v1", startedAt: afterRound30 },
      { ...publicMatch, lobbyId: "ranked", mode: "1v1", startedAt: afterRound30 + 1 },
      { ...publicMatch, lobbyId: "lobby", mode: null, rated: false, startedAt: afterRound30 + 2 },
    ], []);
    expect(result.matches).toEqual([
      { lobbyId: "index", startedAt: afterRound30, rated: true, delaySeconds: 0, colonies: [[], []],
        harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false, pinBoundaryOpen: true } },
      { lobbyId: "ranked", startedAt: afterRound30 + 1, rated: true, delaySeconds: 300, colonies: [[], []] },
      { lobbyId: "lobby", startedAt: afterRound30 + 2, rated: false, delaySeconds: 60, colonies: [[], []] },
    ]);
    expect(result.matches.map(match => "harnessPhase" in match)).toEqual([true, false, false]);
  });

  it("lists only public matches still in playback, oldest first, as the matches whose players are read", () => {
    const later: CatalogMatch = { ...publicMatch, lobbyId: "b", startedAt: 2000 };
    expect(listedMatches([later, { ...publicMatch, lobbyId: "c", playbackFinished: true }, { ...publicMatch, lobbyId: "p", visibility: "private" }, publicMatch])
      .map(match => match.lobbyId)).toEqual(["first", "b"]);
  });
});
