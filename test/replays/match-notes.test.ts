// Public match notes (src/replays/matchNotes.ts): the table, and where each public record and page view carries a note.
import { describe, expect, it } from "vitest";
import { MATCH_NOTES, matchNote, noteField } from "../../src/replays/matchNotes.ts";
import { recordingMatchTypes, type RecordingLobby } from "../../src/replays/history-routes.ts";
import type { HistoryPage, HistorySummary } from "../../src/replays/history-source.ts";
import { publicMatchCatalog, type CatalogMatch } from "../../src/live/match-catalog.ts";
import { matchNote as noteSchema, type Recording } from "../../web/src/matches-page/data.ts";
import { recordingRow } from "../../web/src/ui/format.ts";
import { modeCopy } from "../../web/src/replay.ts";

const NOTED = "c0bce8df-1c3f-46c0-b6dd-1ffec3e15f82";
const TEXT = "Self-reported scripted-play breach: one accepted command, at tick 6556";
const OTHER = "11111111-2222-4333-8444-555555555555";

describe("the public match notes table", () => {
  it("holds exactly the one note, word for word, with no ban wording", () => {
    expect([...MATCH_NOTES]).toEqual([[NOTED, TEXT]]);
    for (const note of MATCH_NOTES.values()) expect(note).not.toMatch(/\bban/i);
  });

  it("finds a note by lobby id only", () => {
    expect(matchNote(NOTED)).toBe(TEXT);
    expect(matchNote(OTHER)).toBeUndefined();
    expect(matchNote(null)).toBeUndefined();
    expect(matchNote(undefined)).toBeUndefined();
    expect(noteField(NOTED)).toEqual({ note: TEXT });
    expect(Object.keys(noteField(OTHER))).toEqual([]);
  });
});

describe("Recordings listing", () => {
  const lobby = (id: string): RecordingLobby => ({ id, kind: "public", size: 1, mode: "house-1v1", colonies: [[], []], startsAt: Date.parse("2026-11-10T10:30:00Z") });
  const row = (id: string): HistorySummary => ({ id, startedAt: "2026-11-10T10:30:00.000Z", endedAt: null, simulationEndedAt: null, winner: 0,
    reason: "queens_killed", decidedBy: null, seats: [], status: "complete", unavailable: [], rated: true, modelIndex: true } as unknown as HistorySummary);
  const page = (...matches: HistorySummary[]): HistoryPage => ({ matches, nextPageToken: null });

  it("carries the note on the noted match's row only, leaving every other field and row as it was", async () => {
    const noted = "2026-11-10T10-30-00-000Z-1", other = "2026-11-10T10-31-00-000Z-1", noLobby = "2026-11-10T10-32-00-000Z-1";
    const lobbies: Record<string, RecordingLobby | null> = { [noted]: lobby(NOTED), [other]: lobby(OTHER), [noLobby]: null };
    const listed = await recordingMatchTypes(async id => lobbies[id] ?? null)(page(row(noted), row(other), row(noLobby)));
    expect(listed.matches.map(match => match.note)).toEqual([TEXT, undefined, undefined]);
    expect(listed.matches.map(match => "note" in match)).toEqual([true, false, false]);
    const { note: _, ...rest } = listed.matches[0]!;
    expect(rest).toEqual({ ...listed.matches[1]!, id: noted });
  });
});

describe("Live now catalog", () => {
  it("carries the note only on the match it names", () => {
    const match = (lobbyId: string, startedAt: number): CatalogMatch =>
      ({ lobbyId, visibility: "public", rated: true, mode: "house-1v1", startedAt, playbackFinished: false });
    const matches = publicMatchCatalog([match(NOTED, 1000), match(OTHER, 2000)], []).matches;
    expect(matches.map(entry => entry.note)).toEqual([TEXT, undefined]);
    expect("note" in matches[1]!).toBe(false);
  });
});

describe("the page's reading of a note", () => {
  const base: Recording = { id: "2026-11-10T10-30-00-000Z-1", startedAt: "2026-11-10T10:30:00.000Z", endedAt: null, simulationEndedAt: null,
    winner: 0, reason: "queens_killed", decidedBy: null, seats: [], status: "complete", unavailable: [] };

  it("reads text as the note and anything else as none, never failing the page", () => {
    expect(noteSchema.parse(TEXT)).toBe(TEXT);
    expect(noteSchema.parse(undefined)).toBeUndefined();
    expect(noteSchema.parse("")).toBeNull();
    expect(noteSchema.parse(7)).toBeNull();
  });

  it("puts the note on the Recordings row, and none on any other", () => {
    expect(recordingRow({ ...base, note: TEXT }, "").note).toBe(TEXT);
    expect(recordingRow(base, "").note).toBeNull();
  });

  it("adds the note after the harness tags on the replay's mode line, and leaves the line as it was without one", () => {
    const tags = ["Harness from round 31 onward"];
    const whole = "Harness from round 31 onward";
    expect(modeCopy("replay", 2, false, "/", base.id, true, undefined, tags, TEXT).detail).toBe(`10 Nov 2026 · ${whole} · ${TEXT}`);
    expect(modeCopy("replay", 2, true, "/", base.id, true, undefined, tags, TEXT).detail).toBe(`· recording ended · ${whole} · ${TEXT}`);
    expect(modeCopy("replay", 2, false, "/", base.id, true, undefined, tags, null)).toEqual(modeCopy("replay", 2, false, "/", base.id, true, undefined, tags));
  });
});
