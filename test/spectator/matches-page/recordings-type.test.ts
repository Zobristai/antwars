// The Matches page's Recordings card draws each recording's match type as the seat badge, in the table's Game type
// column and on the stacked rows' line after the time, and no badge where the type is unknown; a public or invite-only
// lobby's recording reads "Unranked". Test DOM only: never visual evidence.
import { describe, expect, it } from "vitest";
import { recordingsCard } from "../../../web/src/pages/matches.ts";
import type { MatchesView, Recording } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const recording = (minute: number, matchType: Recording["matchType"]): Recording => ({
  id: `2026-11-04T08-${String(minute).padStart(2, "0")}-00-000Z-1`, startedAt: `2026-11-04T08:${String(minute).padStart(2, "0")}:00.000Z`,
  endedAt: null, simulationEndedAt: null, winner: 1, reason: "queens_killed", decidedBy: "queens_killed", seats: [{ seat: 0, colony: 0, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "alice" }, { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "bob" }], status: "complete",
  unavailable: [], matchType,
});

describe("Recordings rows show each recording's match type", () => {
  it("shows the type once per responsive row, and no type words for an untyped row", () => {
    const { doc } = dom();
    const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, next: null,
      recordings: { status: "ready", rows: [recording(29, { kind: "index", size: 1 }), recording(13, { kind: "unranked", size: 2 }), recording(1, null)] } };
    const card = recordingsCard(doc, view, { search: "" }) as unknown as ElementPort;
    const [list] = card.byClass("d1p-rec-rows");
    expect(list!.children).toHaveLength(3);
    expect(list!.byClass("d1p-rec-type").map(node => node.textContent)).toEqual(["Index 1v1", "Unranked 2v2", ""]);
    expect(list!.byClass("d1p-rec-when").flatMap(cell => cell.byClass("d1p-rec-type"))).toEqual([]);
    expect(card.byClass("d1p-rec-head")).toHaveLength(1);
    expect(card.byClass("d1p-rec-colony").map(node => node.textContent)).toEqual(["Very Large", "Lake Hodges", "Sweetwater", "Lake Skinner"]);
    expect(list!.byClass("d1p-rec-colony")).toEqual([]);
    expect(card.textContent).not.toMatch(/house-|unranked ·|index ·|Lobby/);
  });
});
