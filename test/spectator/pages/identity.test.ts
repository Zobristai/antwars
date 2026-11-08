// The one name/badge/rating style every page shares: its parts and both rating looks. Not rendering evidence.
import { describe, expect, it } from "vitest";
import { RATING_LOOK, nameNodes, ratingNodes } from "../../../web/src/pages/identity.ts";
import { dom, type ElementPort } from "./dom.ts";

const parts = (nodes: Node[]) => (nodes as unknown as ElementPort[]).map(node => [node.className, node.textContent]);

describe("the shared row identity", () => {
  it("sets a name, then its badges as one unit, then any quiet thinking level", () => {
    const { doc } = dom();
    expect(parts(nameNodes(doc, { name: "GPT-6 Luna", badges: ["max", "Fast"] }))).toEqual([["", "GPT-6 Luna"], ["d1p-tags", "maxFast"]]);
    const tags = (nameNodes(doc, { name: "GPT-6 Luna", badges: ["max", "Fast"] })[1] as unknown as ElementPort).children;
    expect(tags.map(tag => tag.className)).toEqual(["d1p-tag", "d1p-tag"]);
    expect(parts(nameNodes(doc, { name: "kite", badges: [], quiet: "(high)" }))).toEqual([["", "kite"], ["d1p-think", "(high)"]]);
    expect(parts(nameNodes(doc, { name: "kite", badges: [], quiet: null }))).toEqual([["", "kite"]]);
  });

  it("shows the number, ± RD, then the provisional word in the number look", () => {
    const { doc } = dom();
    expect(parts(ratingNodes(doc, { rating: 1549.6, rd: 61.4, ratedMatches: 30 }, "number"))).toEqual([["d1p-elo", "1550"], ["d1p-rd", " ± 61"]]);
    expect(parts(ratingNodes(doc, { rating: 1500, rd: 90, ratedMatches: 3 }, "number")))
      .toEqual([["d1p-elo", "1500"], ["d1p-rd", " ± 90"], ["d1p-sr", ", "], ["d1p-prov", "provisional"]]);
    expect(parts(ratingNodes(doc, { rating: 1500, rd: null, ratedMatches: 12 }, "number"))).toEqual([["d1p-elo", "1500"]]);
  });

  it("shows the number alone in the in-match cyan badge in the badge look, ± RD in its tip, the provisional word after", () => {
    const { doc } = dom();
    const nodes = ratingNodes(doc, { rating: 1500, rd: 90, ratedMatches: 3 }, "badge");
    // The badge's text, its accessible name, still reads "1500 ± 90"; on screen only the figure shows until the tip opens.
    expect(parts(nodes)).toEqual([["d1-tag d1-elo d1p-elo-badge", "1500 ± 90"], ["d1p-sr", ", "], ["d1p-prov", "provisional"]]);
    const badge = nodes[0] as unknown as ElementPort;
    expect([badge.tag, badge.type]).toEqual(["button", "button"]);
    expect(badge.children.map(child => [child.tag, child.className, child.textContent])).toEqual([["#text", "", "1500"], ["span", "d1p-elo-rd", " ± 90"]]);
    // No RD: the bare figure in a plain badge, with no tip.
    const bare = ratingNodes(doc, { rating: 1500, ratedMatches: 12 }, "badge");
    expect(parts(bare)).toEqual([["d1-tag d1-elo d1p-elo-badge", "1500"]]);
    expect((bare[0] as unknown as ElementPort).tag).toBe("span");
    expect((bare[0] as unknown as ElementPort).byClass("d1p-elo-rd")).toEqual([]);
  });

  it("opens the tip on a tap, focusing the badge, and closes it on a second tap or when the badge loses focus", () => {
    const { doc } = dom();
    const badge = ratingNodes(doc, { rating: 1522, rd: 87, ratedMatches: 30 }, "badge")[0] as unknown as ElementPort;
    badge.click();
    expect([badge.hasAttribute("data-open"), badge.focused]).toEqual([true, true]);
    badge.click();
    expect(badge.hasAttribute("data-open")).toBe(false);
    badge.click(); badge.fire("blur");
    expect(badge.hasAttribute("data-open")).toBe(false);
  });

  it("marks the badge hovered for a mouse or pen over it, never for a touch", () => {
    const { doc } = dom();
    const badge = ratingNodes(doc, { rating: 1522, rd: 87, ratedMatches: 30 }, "badge")[0] as unknown as ElementPort;
    badge.fire("pointerenter", { pointerType: "touch" });
    expect(badge.hasAttribute("data-hover")).toBe(false);
    for (const pointerType of ["mouse", "pen"]) {
      badge.fire("pointerenter", { pointerType });
      expect(badge.hasAttribute("data-hover")).toBe(true);
      badge.fire("pointerleave", { pointerType });
      expect(badge.hasAttribute("data-hover")).toBe(false);
    }
  });

  it("uses the one switch when no look is named", () => {
    const { doc } = dom();
    const row = { rating: 1500, rd: 90, ratedMatches: 30 };
    expect(parts(ratingNodes(doc, row))).toEqual(parts(ratingNodes(doc, row, RATING_LOOK)));
  });
});
