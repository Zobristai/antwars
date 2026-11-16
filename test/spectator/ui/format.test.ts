// The spectator HUD's and pages' pure rules (web/src/ui/format.ts). Unit evidence only, never visual evidence.
import { describe, expect, it } from "vitest";
import {
  CLOSED, boardHref, drawers, holdProgress, isShown, keep, leadLine, liveQueens, liveRow, liveState,
  listedNames, neverJoined, recordedColonies, recordingModels, recordingResult, recordingRow, recordingRows, recordingsState, recordingType, resultHeadline, shares, spawnFill, stepped, territoryShares, utcStamp, withUnits, withoutCasteGlyph, type Drawers,
} from "../../../web/src/ui/format.ts";
import { COLONY_NAMES, EARLY_WIN_RULES } from "../../../src/sim/config.ts";
import type { MatchesView, Recording } from "../../../web/src/matches-page/data.ts";

const run = (...events: Parameters<typeof drawers>[1][]): Drawers => events.reduce(drawers, CLOSED);
const recording = (over: Partial<Recording> = {}): Recording => ({
  id: "2026-10-23T03-36-00-000Z-6", startedAt: "2026-10-23T03:36:00.000Z", endedAt: null, simulationEndedAt: null,
  winner: null, reason: null, decidedBy: null, seats: [], status: "complete", unavailable: [], ...over,
});

describe("colony drawers", () => {
  it("starts closed, opens each colony on its own and both together, and Escape lets both go", () => {
    expect([isShown(CLOSED, 0), isShown(CLOSED, 1)]).toEqual([false, false]);
    expect(isShown(run({ kind: "toggle", colony: 0 }), 0)).toBe(true);
    expect(isShown(run({ kind: "toggle", colony: 0 }), 1)).toBe(false);
    const both = run({ kind: "toggle", colony: 0 }, { kind: "toggle", colony: 1 });
    expect([isShown(both, 0), isShown(both, 1)]).toEqual([true, true]);
    expect(drawers(both, { kind: "close" })).toEqual(CLOSED);
  });
  it("keeps pinned drawers through pointer and focus previews; a previewed drawer's own control pins it", () => {
    const pinned = run({ kind: "toggle", colony: 1 }, { kind: "point", colony: 0 });
    expect([isShown(pinned, 0), isShown(pinned, 1)]).toEqual([true, true]);
    expect(isShown(drawers(pinned, { kind: "leave" }), 0)).toBe(false);
    expect(isShown(drawers(pinned, { kind: "leave" }), 1)).toBe(true);
    const focused = run({ kind: "focus", colony: 0 });
    expect(isShown(focused, 0)).toBe(true);
    expect(isShown(drawers(focused, { kind: "blur", colony: 0 }), 0)).toBe(false);
    const held = drawers(focused, { kind: "toggle", colony: 0 });
    expect([held.pinned[0], isShown(drawers(held, { kind: "blur", colony: 0 }), 0)]).toEqual([true, true]);
    expect(isShown(drawers(held, { kind: "toggle", colony: 0 }), 0)).toBe(false);
  });
});

describe("score plate: progress toward each way to win", () => {
  it("splits a bar by share from each end, and leaves an empty one empty", () => {
    expect(shares(3, 1)).toEqual([75, 25]);
    expect(shares(0, 4)).toEqual([0, 100]);
    expect(shares(0, 0)).toBeNull();
  });
  it("gives four colonies whole-percent shares of the held ground that add to exactly 100, and none when nothing is held", () => {
    expect(territoryShares([30, 30, 30, 10])).toEqual([30, 30, 30, 10]);
    // Thirds: the one point left goes to the lowest colony id among equal remainders.
    expect(territoryShares([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
    expect(territoryShares([0, 1, 1, 1])).toEqual([0, 34, 33, 33]);
    // Largest remainders first: 2/7, 2/7, 2/7, 1/7 are 28.57, 28.57, 28.57, 14.29.
    expect(territoryShares([2, 2, 2, 1])).toEqual([29, 29, 28, 14]);
    // An eliminated colony's tiles are neutral: it holds nothing and shows 0, never a point of the rounding.
    expect(territoryShares([999, 1, 0, 0])).toEqual([100, 0, 0, 0]);
    expect(territoryShares([1, 0, 0, 0])).toEqual([100, 0, 0, 0]);
    expect(territoryShares([0, 0, 0, 0])).toBeNull();
    for (const held of [[1, 2, 3, 4], [7, 7, 7, 7], [1, 1, 1, 1], [3, 3, 3, 0], [123, 456, 789, 1011], [1, 1, 98, 0], [5, 0, 5, 1]]) {
      const pct = territoryShares(held)!;
      expect(pct.reduce((a, b) => a + b, 0), held.join(",")).toBe(100);
      expect(pct.every(Number.isInteger), held.join(",")).toBe(true);
      pct.forEach((p, i) => expect(Math.abs(p - (100 * held[i]!) / held.reduce((a, b) => a + b, 0)), held.join(",")).toBeLessThan(1));
    }
  });
  it("puts the six-to-one line where the sim's early win needs the leader's share", () => {
    const line = leadLine(EARLY_WIN_RULES.territoryRatioPermille);
    expect(line).toBeCloseTo((100 * 6) / 7, 6);
    // A lead exactly at the ratio reaches the line: 600 tiles to 100 is 6/7 of the bar.
    expect(shares(600, 100)![0]).toBeCloseTo(line, 6);
  });
  it("runs a qualifying lead's hold from its start to the step its win is due", () => {
    const win = { startTick: 1000, winTick: 1000 + EARLY_WIN_RULES.holdTicks - 1 };
    expect(holdProgress(undefined, 1200)).toBeNull();
    expect(holdProgress(win, 1000)).toBe(0);
    expect(holdProgress(win, 1000 + EARLY_WIN_RULES.holdTicks / 2)).toBeCloseTo(0.5, 6);
    expect(holdProgress(win, win.winTick + 1)).toBe(1);
    expect(holdProgress(win, win.winTick + 50)).toBe(1);
  });
  it("fills the spawn ring over the hatch interval, leaves it empty while food is short, and starts a longer wait empty", () => {
    const waiting = { kind: "waiting" };
    expect(spawnFill(waiting, 100, 20, 90)).toBeCloseTo(0.5, 6);
    expect(spawnFill(waiting, 100, 10, 70)).toBe(0);
    expect(spawnFill({ kind: "food" }, 100, 20, 99)).toBe(0);
    expect(spawnFill({ kind: "ready" }, 100, 20, 120)).toBe(1);
    expect(spawnFill({ kind: "full" }, 100, 20, 80)).toBe(1);
    expect(spawnFill({ kind: "unknown" }, 100, 20, 90)).toBe(0);
  });
  it("words the spawn chip as the page words the next hatch, its caste glyph drawn as the chip's icon instead", () => {
    expect(["⛏ 2 s", "⚔ Needs food", "⚔ Eligible", "2 s", "Needs food"].map(withoutCasteGlyph)).toEqual(["2 s", "Needs food", "Eligible", "2 s", "Needs food"]);
  });
  it("steps the fill in whole quarters for reduced motion", () => {
    expect([0, 0.24, 0.25, 0.74, 0.99, 1].map(p => stepped(p))).toEqual([0, 0, 0.25, 0.5, 0.75, 1]);
  });
  it("puts each standing queen on the plate outermost first in founding order, and drops a lost one", () => {
    const q = (id: number, foundedTick: number, lostTick: number | null, colony = 0) => ({ id, colony, foundedTick, lostTick });
    const queens = [q(2, 300, null), q(0, 0, 500), q(1, 100, null), q(4, 100, null), q(3, 0, null, 1)];
    const out = (x: { lostTick: number | null }) => x.lostTick !== null;
    expect(liveQueens(queens, 0, out).map(x => x.id)).toEqual([1, 4, 2]);
    expect(liveQueens(queens, 1, out).map(x => x.id)).toEqual([3]);
  });
});

describe("links", () => {
  it("carries the chosen board between pages without overriding a link's own, and nothing else", () => {
    expect(keep("/?page=matches", "?invite=x&board=2d&state=lead")).toBe("/?page=matches&board=2d");
    expect(keep("/?replay=a&board=3d", "?board=2d")).toBe("/?replay=a&board=3d");
    expect(keep("/", "")).toBe("/");
  });
  it("switches the board both ways and keeps every other parameter", () => {
    const three = new URL(boardHref("3d", "http://h/?board=2d&lobby=L1&replay=x"));
    expect([three.searchParams.get("board"), three.searchParams.get("lobby"), three.searchParams.get("replay"), three.searchParams.get("aw-3d-manual")]).toEqual(["3d", "L1", "x", "1"]);
    const two = new URL(boardHref("2d", "http://h/?lobby=L1&aw-3d-manual=1&aw-3d-retry=1"));
    expect([two.searchParams.get("board"), two.searchParams.get("lobby"), two.searchParams.has("aw-3d-manual"), two.searchParams.has("aw-3d-retry")]).toEqual(["2d", "L1", false, false]);
  });
});

describe("visible result headline", () => {
  it("names an abandoned house result rather than a natural draw", () => {
    expect(resultHeadline({ winner: null, reason: "abandoned" })).toBe("Abandoned");
  });
  it("preserves natural draws and both colony victories", () => {
    expect(resultHeadline({ winner: null, reason: "time_up" })).toBe("Draw");
    expect(resultHeadline({ winner: 0, reason: "queens_killed" })).toBe("Very Large Colony wins");
    expect(resultHeadline({ winner: 1, reason: "queens_killed" })).toBe("Lake Hodges Colony wins");
  });
});

describe("matches rows", () => {
  it("names a recorded abandonment rather than a natural draw", () => {
    expect(recordingResult({ winner: null, reason: "abandoned", decidedBy: "draw" })).toEqual({ result: "Abandoned", how: "Seat inactive · unrated" });
    expect(recordingResult({ winner: null, reason: "abandoned", decidedBy: null })).toEqual({ result: "Abandoned", how: null });
  });
  it("states results only as the record does", () => {
    expect(recordingResult({ winner: 0, reason: "queens_killed", decidedBy: "queens_killed" })).toEqual({ result: "Very Large Colony won", how: "Queens killed" });
    expect(recordingResult({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed" })).toEqual({ result: "Lake Hodges Colony won", how: "Queens killed" });
    expect(recordingResult({ winner: null, reason: "time_up", decidedBy: "draw" }).result).toBe("Draw");
    expect(recordingResult({ winner: null, reason: null, decidedBy: null })).toEqual({ result: "Result unknown", how: null });
  });
  it("names an unrated recording's colonies by the names it drew", () => {
    const colonyNames: [string, string] = ["Sweetwater Colony", "Lake Skinner Colony"];
    expect(recordingResult({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed", colonyNames })).toEqual({ result: "Lake Skinner Colony won", how: "Queens killed" });
    expect(resultHeadline({ winner: 0, reason: "queens_killed" }, colonyNames)).toBe("Sweetwater Colony wins");
    expect(recordingModels([{ seat: 0, colony: 0, modelLabel: "m-a", thinkingLevel: null, serviceTier: null, handle: null }], colonyNames)).toBe("Sweetwater Colony: m-a");
  });
  it("words a four-colony recording's end without two sides, and a two-colony one as before", () => {
    const quadrants = { matchType: { kind: "quadrants" as const, size: null } };
    expect(recordingResult({ winner: 2, reason: "queens_killed", decidedBy: "queens_killed", ...quadrants }).how).toBe("Last colony standing · queens killed");
    expect(recordingResult({ winner: 3, reason: "queens_killed", decidedBy: "kills", ...quadrants }).how).toBe("Queens killed · decided on kills");
    expect(recordingResult({ winner: 1, reason: "idle", decidedBy: "idle", ...quadrants }).how).toBe("Last colony standing · seats inactive");
    expect(recordingResult({ winner: null, reason: "idle", decidedBy: "draw", ...quadrants }).how).toBe("Seats inactive · decided on draw");
    expect(recordingResult({ winner: 1, reason: "queens_killed", decidedBy: "kills" }).how).toBe("Queens killed on both sides · decided on kills");
    expect(recordingResult({ winner: null, reason: "idle", decidedBy: "draw" }).how).toBe("Seats inactive on both sides");
  });
  it("names recorded models by colony and never invents seats", () => {
    expect(recordingModels([])).toBe("Seats not recorded");
    expect(recordingModels([{ seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: null }, { seat: 0, colony: 0, modelLabel: "m-a", thinkingLevel: null, serviceTier: null, handle: null }])).toBe("Very Large Colony: m-a · Lake Hodges Colony: model unknown");
  });
  it("deduplicates saved history by id and keeps newest-first display and saved metadata", () => {
    const recentSaved = recording({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed", seats: [{ seat: 0, colony: 0, modelLabel: "saved model", thinkingLevel: null, serviceTier: null, handle: null },
      { seat: 1, colony: 1, modelLabel: "other model", thinkingLevel: null, serviceTier: null, handle: null }] });
    const view = { recordings: { status: "ready", rows: [recording({ id: "2026-10-20T22-00-00-000Z-1", startedAt: "2026-10-20T22:00:00.000Z", status: "unavailable" }), recentSaved, recentSaved] } } as const;
    const rows = recordingRows(view, "?board=2d");
    expect(rows.map(r => r.id)).toEqual(["2026-10-23T03-36-00-000Z-6", "2026-10-20T22-00-00-000Z-1"]);
    expect(rows[0]).toMatchObject({ result: "Lake Hodges Colony won", models: "Very Large Colony: saved model · Lake Hodges Colony: other model", record: "Record complete" });
    expect(rows[0]!.href).toBe("/?replay=2026-10-23T03-36-00-000Z-6&board=2d");

  });
  it("lists no match known never joined, a played match nobody joined included, and keeps a record whose seats are partial or unknown", () => {
    const seat = (n: number, colony: 0 | 1) => ({ seat: n, colony, modelLabel: "m", thinkingLevel: null, serviceTier: null, handle: null });
    const played = recording({ id: "2026-10-23T03-36-00-000Z-6", seats: [seat(0, 0), seat(1, 1)] });
    const onlyFirst = recording({ id: "2026-10-23T03-35-00-000Z-5", startedAt: "2026-10-23T03:35:00.000Z", seats: [seat(0, 0), seat(1, 0)] });
    const onlySecond = recording({ id: "2026-10-23T03-34-00-000Z-4", startedAt: "2026-10-23T03:34:00.000Z", seats: [seat(0, 1)] });
    // A record unavailable carries no seat data: its seats are unknown, so it stays listed.
    const unrecorded = recording({ id: "2026-10-23T03-33-00-000Z-3", startedAt: "2026-10-23T03:33:00.000Z", seats: [], status: "unavailable" });
    // A complete record (seats verified against the match log) that holds no seat was played with nobody joined: it is not listed.
    const nobody = recording({ id: "2026-10-23T03-32-00-000Z-2", startedAt: "2026-10-23T03:32:00.000Z", seats: [], status: "complete" });
    // A partial record may lack a colony that joined after the replay stopped: missing seats do not show it never joined.
    const nobodyPartial = recording({ id: "2026-10-23T03-31-00-000Z-1", startedAt: "2026-10-23T03:31:00.000Z", seats: [], status: "partial" });
    const onlyFirstPartial = recording({ id: "2026-10-23T03-30-00-000Z-0", startedAt: "2026-10-23T03:30:00.000Z", seats: [seat(0, 0)], status: "partial" });
    const all = [played, onlyFirst, onlySecond, unrecorded, nobody, nobodyPartial, onlyFirstPartial];
    expect(all.map(neverJoined)).toEqual([false, true, true, false, true, false, false]);
    const view = { recordings: { status: "ready", rows: [onlySecond, unrecorded, nobody, played, nobodyPartial, onlyFirst, onlyFirstPartial] } } as const;
    expect(recordingRows(view, "").map(r => r.id)).toEqual([played.id, unrecorded.id, nobodyPartial.id, onlyFirstPartial.id]);
  });
  describe("a four-colony (Quadrants) recording", () => {
    const QUADRANTS = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
    const seat = (n: number, colony: 0 | 1 | 2 | 3) => ({ seat: n, colony, modelLabel: `m-${n}`, thinkingLevel: null, serviceTier: null, handle: null });
    const four = [seat(0, 0), seat(1, 1), seat(2, 2), seat(3, 3)];
    it("is known by its type, its four names, its winner or a seat of colony 2 or 3, and a two-colony record by none", () => {
      expect([
        recordedColonies({ matchType: { kind: "quadrants", size: 1 } }), recordedColonies({ colonyNames: QUADRANTS as [string, string, string, string] }),
        recordedColonies({ winner: 3 }), recordedColonies({ seats: [seat(0, 2)] }),
      ]).toEqual([4, 4, 4, 4]);
      expect([recordedColonies(recording()), recordedColonies(recording({ winner: 1, seats: [seat(0, 0), seat(1, 1)], matchType: { kind: "unranked", size: 1 },
        colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] }))]).toEqual([2, 2]);
    });
    it("names its winner and each colony's models by its four names, or by the table's four where it carries none", () => {
      const named = recording({ winner: 2, reason: "queens_killed", decidedBy: "queens_killed", seats: four, matchType: { kind: "quadrants", size: 1 },
        colonyNames: ["Lake Skinner Colony", "Sweetwater Colony", "Lake Hodges Colony", "Very Large Colony"] });
      expect(recordingRow(named, "")).toMatchObject({ result: "Lake Hodges Colony won", type: "Quadrants",
        models: "Lake Skinner Colony: m-0 · Sweetwater Colony: m-1 · Lake Hodges Colony: m-2 · Very Large Colony: m-3" });
      const unnamed = recording({ winner: 3, reason: "queens_killed", decidedBy: "queens_killed", seats: four, matchType: { kind: "quadrants", size: 1 } });
      expect(recordingRow(unnamed, "")).toMatchObject({ result: "Lake Skinner Colony won", models: QUADRANTS.map((name, n) => `${name}: m-${n}`).join(" · ") });
      expect(listedNames({}, 4)).toEqual(QUADRANTS);
      expect(listedNames({}, 2)).toBe(COLONY_NAMES);
    });
    it("is not listed where a complete record lacks one of its four colonies, and is listed with all four", () => {
      const played = recording({ seats: four, matchType: { kind: "quadrants", size: 1 } });
      const short = recording({ seats: four.slice(0, 3), matchType: { kind: "quadrants", size: 1 } });
      const shortPartial = { ...short, status: "partial" as const };
      expect([played, short, shortPartial].map(neverJoined)).toEqual([false, true, false]);
    });
  });
  it("words each recording's match type as its badge, never a mode slug, and gives no badge without a type", () => {
    expect(recordingType({ kind: "index", size: 2 })).toBe("Index · 2v2");
    expect(recordingType({ kind: "ranked", size: 4 })).toBe("Ranked · 4v4");
    expect(recordingType({ kind: "unranked", size: 3 })).toBe("Unranked · 3v3");
    expect(recordingType({ kind: "challenge", size: 1 })).toBe("Challenge · 1v1");
    expect(recordingType({ kind: "unrated", size: 1 })).toBe("Unranked · 1v1");
    expect(recordingType({ kind: "unrated", size: null })).toBe("Unranked");
    expect(recordingType(null)).toBeNull();
    expect(recordingType(undefined)).toBeNull();
    expect(recordingRow(recording({ matchType: { kind: "index", size: 1 } }), "").type).toBe("Index · 1v1");
    expect(recordingRow(recording(), "").type).toBeNull();
  });
  it("keeps every list state distinct and never calls an empty catalog nothing live", () => {
    expect(liveState({ live: { status: "ready", rows: [] } }).text).toBe("No public match in the catalog right now");
    const states = [
      recordingsState({ recordings: { status: "loading", rows: [] }, next: null }, 0),
      recordingsState({ recordings: { status: "ready", rows: [] }, next: "t" }, 0),
      recordingsState({ recordings: { status: "ready", rows: [] }, next: null }, 0),
      recordingsState({ recordings: { status: "ready", rows: [recording()] }, next: null }, 1),
      recordingsState({ recordings: { status: "error", rows: [recording()] }, next: "t" }, 1),
    ];
    expect(states.map(s => s.tone)).toEqual(["loading", "partial", "empty", "complete", "error"]);
    expect(new Set(states.map(s => s.text)).size).toBe(states.length);
  });
  it("keeps each figure with its unit", () => {
    expect(withUnits("· Next ant 4 s")).toBe("· Next ant 4 s");
    expect(withUnits("Rated match · 300 s behind · 2 HP · 12 seconds")).toBe("Rated match · 300 s behind · 2 HP · 12 seconds");
  });
  it("links a live row to the existing watch address and dates only real instants", () => {
    expect(liveRow({ lobbyId: "L1", startedAt: Date.UTC(2026, 9, 23, 3, 36), rated: true, delaySeconds: 300, colonies: [[], []] }, "?board=2d&invite=x").href).toBe("/?lobby=L1&watch=1&board=2d");
    expect(utcStamp("2026-10-23T03:36:00.000Z")).toBe("23 Oct 2026 · 03:36 UTC");
    expect(utcStamp("soon")).toBeNull();
  });
});

 describe("explicit three-colony recording counts", () => {
  const names: [string, string, string] = ["Lake Skinner Colony", "Very Large Colony", "Sweetwater Colony"];
  it("uses three named colonies, not a guessed missing fourth, and keeps incomplete four-colony records four", () => {
    expect(recordedColonies({ colonyNames: names, winner: 2 })).toBe(3);
    expect(recordedColonies({ colonyNames: names, matchType: { kind: "quadrants", size: 1 } })).toBe(4);
    expect(recordedColonies({ colonyNames: names, winner: 3 })).toBe(4);
    expect(recordedColonies({ winner: 2 })).toBe(4);
    expect(recordingType({ kind: "unrated", size: 1 }, 3)).toBe("Unranked · 1v1v1");
  });
});
