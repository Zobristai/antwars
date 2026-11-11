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
  it("puts one badge in the Game type column and the stacked row, and none for an untyped row", () => {
    const { doc } = dom();
    const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, next: null,
      recordings: { status: "ready", rows: [recording(29, { kind: "index", size: 1 }), recording(13, { kind: "unranked", size: 2 }), recording(1, null)] } };
    const card = recordingsCard(doc, view, { search: "" }) as unknown as ElementPort;
    const badges = (scope: ElementPort) => scope.byClass("d1p-type").map(node => node.textContent);
    const [table] = card.byClass("d1p-rec"), [list] = card.byClass("d1p-match-rows");
    expect(badges(table!)).toEqual(["Index · 1v1", "Unranked · 2v2"]);
    expect(badges(list!)).toEqual(["Index · 1v1", "Unranked · 2v2"]);
    // In the table, in the Game type column (never the start cell); in the stacked row, on the line after the time.
    expect(card.byClass("d1p-type").every(node => node.classes().includes("d1p-tag"))).toBe(true);
    const cells = table!.byClass("c-type").filter(node => node.tag === "td");
    expect(cells.map(cell => cell.byClass("d1p-type").length)).toEqual([1, 1, 0]);
    expect(table!.byClass("c-start").flatMap(cell => cell.byClass("d1p-type"))).toEqual([]);
    expect(list!.byClass("is-lead").map(line => line.byClass("d1p-type").length)).toEqual([1, 1, 0]);
    expect(card.textContent).not.toMatch(/house-|unranked ·|index ·|Lobby/);
  });
});
