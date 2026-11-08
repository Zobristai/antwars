// The spectator HUD's and pages' pure rules (web/src/ui/format.ts). Unit evidence only, never visual evidence.
import { describe, expect, it } from "vitest";
import {
  CLOSED, boardHref, drawers, holdProgress, isShown, keep, leadLine, liveQueens, liveRow, liveState,
  recordingModels, recordingResult, recordingRow, recordingRows, recordingsState, recordingType, resultHeadline, shares, spawnFill, stepped, utcStamp, withUnits, withoutCasteGlyph, type Drawers,
} from "../../../web/src/ui/format.ts";
import { EARLY_WIN_RULES } from "../../../src/sim/config.ts";
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
  it("names recorded models by colony and never invents seats", () => {
    expect(recordingModels([])).toBe("Seats not recorded");
    expect(recordingModels([{ seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: null }, { seat: 0, colony: 0, modelLabel: "m-a", thinkingLevel: null, serviceTier: null, handle: null }])).toBe("Very Large Colony: m-a · Lake Hodges Colony: model unknown");
  });
  it("deduplicates saved history by id and keeps newest-first display and saved metadata", () => {
    const recentSaved = recording({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed", seats: [{ seat: 0, colony: 0, modelLabel: "saved model", thinkingLevel: null, serviceTier: null, handle: null }] });
    const view = { recordings: { status: "ready", rows: [recording({ id: "2026-10-20T22-00-00-000Z-1", startedAt: "2026-10-20T22:00:00.000Z" }), recentSaved, recentSaved] } } as const;
    const rows = recordingRows(view, "?board=2d");
    expect(rows.map(r => r.id)).toEqual(["2026-10-23T03-36-00-000Z-6", "2026-10-20T22-00-00-000Z-1"]);
    expect(rows[0]).toMatchObject({ result: "Lake Hodges Colony won", models: "Very Large Colony: saved model", record: "Record complete" });
    expect(rows[0]!.href).toBe("/?replay=2026-10-23T03-36-00-000Z-6&board=2d");

  });
  it("words each recording's match type as its badge, never a mode slug, and gives no badge without a type", () => {
    expect(recordingType({ kind: "index", size: 2 })).toBe("Index · 2v2");
    expect(recordingType({ kind: "ranked", size: 4 })).toBe("Ranked · 4v4");
    expect(recordingType({ kind: "unranked", size: 3 })).toBe("Lobby · 3v3");
    expect(recordingType({ kind: "challenge", size: 1 })).toBe("Challenge · 1v1");
    expect(recordingType({ kind: "unrated", size: 1 })).toBe("Unrated · 1v1");
    expect(recordingType({ kind: "unrated", size: null })).toBe("Unrated");
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
