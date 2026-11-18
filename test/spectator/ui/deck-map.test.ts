import { describe, expect, it } from "vitest";
import { mountDeck } from "../../../web/src/ui/deck/deck.ts";
import { dom, type ElementPort } from "../pages/dom.ts";
import { scoreFrame } from "./score-band-frame.ts";

describe("Score Band clock and map", () => {
  it("keeps the map beside the clock outside the comparison and result", () => {
    const deck = mountDeck(dom().doc), f = scoreFrame();
    f.board!.setup.terrain = { mapName: "Wide Plain" } as NonNullable<typeof f.board>["setup"]["terrain"];
    deck.update(f);
    const header = deck.header as unknown as ElementPort;
    expect(header.byClass("d1-map-name")[0]!.textContent).toBe("Wide Plain");
    expect(header.byClass("d1-map")[0]!.hidden).toBe(false);
    expect(header.byClass("d1-clock")[0]!.textContent).toContain("10:00");
    f.board!.result = { winner: 0, reason: "time_up", decidedBy: "territory", tick: 6000, nextStartMs: null };
    deck.update(f);
    expect(header.byClass("d1-map")[0]!.hidden).toBe(false);
    expect(header.byClass("d1-clock")[0]!.textContent).toContain("ended");
  });
  it("hides an unknown map rather than inventing a name", () => {
    const deck = mountDeck(dom().doc); deck.update(scoreFrame());
    expect((deck.header as unknown as ElementPort).byClass("d1-map")[0]!.hidden).toBe(true);
  });
});
