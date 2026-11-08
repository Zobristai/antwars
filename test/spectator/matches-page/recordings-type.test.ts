// The Matches page's Recordings card draws each recording's match type as the seat badge under the winner, in
// the table and the stacked rows, and no badge where the type is unknown. Test DOM only: never visual evidence.
import { describe, expect, it } from "vitest";
import { recordingsCard } from "../../../web/src/pages/matches.ts";
import type { MatchesView, Recording } from "../../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const recording = (minute: number, matchType: Recording["matchType"]): Recording => ({
  id: `2026-11-04T08-${String(minute).padStart(2, "0")}-00-000Z-1`, startedAt: `2026-11-04T08:${String(minute).padStart(2, "0")}:00.000Z`,
  endedAt: null, simulationEndedAt: null, winner: 1, reason: "queens_killed", decidedBy: "queens_killed", seats: [], status: "complete",
  unavailable: [], matchType,
});

describe("Recordings rows show each recording's match type", () => {
  it("puts one badge under the winner in both forms, and none for an untyped row", () => {
    const { doc } = dom();
    const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, next: null,
      recordings: { status: "ready", rows: [recording(29, { kind: "index", size: 1 }), recording(13, { kind: "unranked", size: 2 }), recording(1, null)] } };
    const card = recordingsCard(doc, view, { search: "" }) as unknown as ElementPort;
    const badges = (scope: ElementPort) => scope.byClass("d1p-type").map(node => node.textContent);
    const [table] = card.byClass("d1p-rec"), [list] = card.byClass("d1p-match-rows");
    expect(badges(table!)).toEqual(["Index · 1v1", "Lobby · 2v2"]);
    expect(badges(list!)).toEqual(["Index · 1v1", "Lobby · 2v2"]);
    // In the table, inside the Winner cell beside the winner; in the stacked row, on the winner's line.
    expect(card.byClass("d1p-type").every(node => node.classes().includes("d1p-tag"))).toBe(true);
    const cells = table!.byClass("c-result").filter(node => node.tag === "td");
    expect(cells.map(cell => cell.byClass("d1p-type").length)).toEqual([1, 1, 0]);
    expect(list!.byClass("is-lead").map(line => line.byClass("d1p-type").length)).toEqual([1, 1, 0]);
    expect(card.textContent).not.toMatch(/house-|unranked ·|index ·/);
  });
});
