// The Matches page's Recordings card says each recording's match type in its Match column, under the start, and on the
// stacked row's first line; nothing where the type is unknown. Test DOM only: never visual evidence.
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
  it("says the type under the start in the table and after it in the stacked row, and nothing for an untyped row", () => {
    const { doc } = dom();
    const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, next: null,
      recordings: { status: "ready", rows: [recording(29, { kind: "index", size: 1 }), recording(13, { kind: "unranked", size: 2 }), recording(1, null)] } };
    const card = recordingsCard(doc, view, { search: "" }) as unknown as ElementPort;
    const [table] = card.byClass("d1p-rec"), [list] = card.byClass("d1p-match-rows");
    const starts = table!.byClass("c-start").filter(node => node.tag === "th" && node.parent?.parent?.tag === "tbody");
    expect(starts.map(cell => cell.byClass("d1p-type").map(node => node.textContent))).toEqual([["Index · 1v1"], ["Lobby · 2v2"], []]);
    expect(list!.querySelectorAll("li").map(item => item.children[0]!.textContent)).toEqual([
      "4 Nov 2026 · 08:29 UTC · Index · 1v1", "4 Nov 2026 · 08:13 UTC · Lobby · 2v2", "4 Nov 2026 · 08:01 UTC",
    ]);
    expect(card.textContent).not.toMatch(/house-|unranked ·|index ·/);
  });
});
