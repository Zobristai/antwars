import { describe, expect, it } from "vitest";
import { listedMatches, matchWatchStatus, publicMatchCatalog, type CatalogMatch } from "../../src/live/match-catalog.js";
import { drawColonyNames } from "../../src/sim/colonyNames.ts";

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
      matches: [{ lobbyId: "first", startedAt: 1000, rated: true, delaySeconds: 300, colonies: [[], []], matchType: null }],
      lobbies: [{ id: "public", size: 1, state: "open", colonies: [["owner/agent"], []] }],
    });
  });

  it("keeps a delayed match listed while the same slot starts another match", () => {
    const next: CatalogMatch = { ...publicMatch, lobbyId: "next", rated: false, startedAt: 2000 };
    expect(publicMatchCatalog([next, publicMatch], []).matches.map(match => match.lobbyId)).toEqual(["first", "next"]);
    expect(publicMatchCatalog([next, { ...publicMatch, playbackFinished: true }], []).matches).toEqual([
      { lobbyId: "next", startedAt: 2000, rated: false, delaySeconds: 60, colonies: [[], []], matchType: null },
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

  it("carries each listed match's players with exactly their seven public fields, copied", () => {
    const rated = { displayName: "alice", modelLabel: "openai/gpt-6.1-terra", thinkingLevel: "high", serviceTier: "fast", rating: 1612.4, rd: 80, ratedMatches: 4, identityId: "never-public", key: "secret" };
    const unrated = { displayName: "bob", rating: null, rd: null, ratedMatches: null, identityId: "never-public" };
    const players = new Map([
      ["first", [[rated], [unrated]]],
      ["secret", [[rated], []]],
    ]) as unknown as Parameters<typeof publicMatchCatalog>[2];
    const result = publicMatchCatalog([publicMatch, { ...publicMatch, lobbyId: "secret", visibility: "private" }], [], players);
    expect(result.matches).toEqual([{ lobbyId: "first", startedAt: 1000, rated: true, delaySeconds: 300, colonies: [
      [{ displayName: "alice", modelLabel: "openai/gpt-6.1-terra", thinkingLevel: "high", serviceTier: "fast", rating: 1612.4, rd: 80, ratedMatches: 4 }],
      // A seat with no label, level or tier (absent from its caller) carries null for each.
      [{ displayName: "bob", modelLabel: null, thinkingLevel: null, serviceTier: null, rating: null, rd: null, ratedMatches: null }],
    ], matchType: null }]);
    rated.displayName = "changed";
    expect(result.matches[0]!.colonies[0][0]!.displayName).toBe("alice");
    expect(JSON.stringify(result)).not.toMatch(/never-public|secret/);
  });

  it("labels a live Model Index match with its harness phase by its start, and no other match", () => {
    const pin = Date.parse("2026-11-10T03:03:46.329Z");
    expect(publicMatchCatalog([{ ...publicMatch, lobbyId: "pin", mode: "house-2v2", startedAt: pin }], []).matches[0]!.harnessPhase)
      .toEqual({ phase: "from the pin onward", possibleEffortMismatch: false });
    const roundThirtyOne = Date.parse("2026-11-10T10:32:43.581Z");
    expect(publicMatchCatalog([{ ...publicMatch, lobbyId: "r31", mode: "house-1v1", startedAt: roundThirtyOne }], []).matches[0]!.harnessPhase)
      .toEqual({ phase: "from round 31 onward", possibleEffortMismatch: false });
    const beforePin = Date.parse("2026-11-10T02:00:00Z");
    const result = publicMatchCatalog([
      { ...publicMatch, lobbyId: "index", mode: "house-1v1", startedAt: beforePin },
      { ...publicMatch, lobbyId: "ranked", mode: "1v1", startedAt: beforePin + 1 },
      { ...publicMatch, lobbyId: "lobby", mode: null, rated: false, startedAt: beforePin + 2 },
    ], [], new Map(), new Map(), new Map([["lobby", drawColonyNames("lobby")]]));
    expect(result.matches).toEqual([
      { lobbyId: "index", startedAt: beforePin, rated: true, delaySeconds: 0, colonies: [[], []], matchType: null,
        harnessPhase: { phase: "rounds 26-30", possibleEffortMismatch: false } },
      { lobbyId: "ranked", startedAt: beforePin + 1, rated: true, delaySeconds: 300, colonies: [[], []], matchType: null },
      { lobbyId: "lobby", startedAt: beforePin + 2, rated: false, delaySeconds: 60, colonies: [[], []], matchType: null, colonyNames: drawColonyNames("lobby") },
    ]);
    expect(result.matches.map(match => "harnessPhase" in match)).toEqual([true, false, false]);
  });

  it("names each match only as its lobby records it, copied, and never draws names for a match itself", () => {
    const drawn = drawColonyNames("unrated");
    const result = publicMatchCatalog([
      { ...publicMatch, lobbyId: "ranked", mode: "1v1", rated: true },
      { ...publicMatch, lobbyId: "unrated", mode: null, rated: false, startedAt: publicMatch.startedAt + 1 },
      // An unrated match an older server began under the rated names: its lobby records none, so none are drawn here.
      { ...publicMatch, lobbyId: "older", mode: null, rated: false, startedAt: publicMatch.startedAt + 2 },
    ], [], new Map(), new Map(), new Map([["unrated", drawn]]));
    expect(result.matches.map(match => [match.lobbyId, match.colonyNames])).toEqual([["ranked", undefined], ["unrated", drawn], ["older", undefined]]);
    expect(result.matches.filter(match => "colonyNames" in match).map(match => match.lobbyId)).toEqual(["unrated"]);
    expect(result.matches[1]!.colonyNames).not.toBe(drawn);
  });

  it("carries each listed match's type as given, copied, and none where it is unknown", () => {
    const type = { kind: "challenge", size: 1, extra: "never-public" } as const;
    const result = publicMatchCatalog([publicMatch, { ...publicMatch, lobbyId: "b" }], [], new Map(), new Map([["first", type]]) as never);
    expect(Object.fromEntries(result.matches.map(match => [match.lobbyId, match.matchType]))).toEqual({ first: { kind: "challenge", size: 1 }, b: null });
    expect(JSON.stringify(result)).not.toContain("never-public");
  });

  it("lists only public matches still in playback, oldest first, as the matches whose players are read", () => {
    const later: CatalogMatch = { ...publicMatch, lobbyId: "b", startedAt: 2000 };
    expect(listedMatches([later, { ...publicMatch, lobbyId: "c", playbackFinished: true }, { ...publicMatch, lobbyId: "p", visibility: "private" }, publicMatch])
      .map(match => match.lobbyId)).toEqual(["first", "b"]);
  });
});
