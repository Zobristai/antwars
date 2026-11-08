// The Ants row in the deck's Balance, a total-ants bar beside the individual unit numbers: the mount's contract for where the row sits and how it is painted. Its figures and fill are read by
// model.ts balance (deck-model.test.ts); visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DECK = readFileSync(new URL("../../../web/src/ui/deck/deck.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");

describe("the deck's Ants balance row", () => {
  it("is a gauge like Kills and Territory, labelled with the page's own word", () => {
    expect(DECK).toContain("const kills = gauge(PAGE_WORDS.kills);");
    expect(DECK).toContain("const territory = gauge(SCORE_COPY.territory);");
    expect(DECK).toContain("const ants = gauge(SCORE_COPY.ants);");
  });
  it("sits under Territory and above Win conditions", () => {
    expect(DECK).toMatch(/score\.append\(clockEl, h\(doc, "h3", "d1-kicker", D1_COPY\.balance\), kills\.row, territory\.row, ants\.row, winGroup, mapRow\);/);
  });
  it("is painted from the model's ants gauge with no lead line", () => {
    expect(DECK).toContain("paintGauge(ants, bal.ants, null);");
  });
  it("gives the wide deck 20 px more height for the row, so the score shows its Map row without scrolling", () => {
    expect(CSS).toMatch(/\.d1-hud \{[^}]*grid-template-rows: 48px 4px minmax\(0, 232px\) 12px /);
  });
  it("keeps the per-unit numbers in each team's economy", () => {
    expect(DECK).toContain('const measures: [Key, string][] = [["workers", PAGE_WORDS.workers], ["soldiers", PAGE_WORDS.soldiers], ["food", PAGE_WORDS.food], ["next", PAGE_WORDS.nextSpawn], ["ants", SCORE_COPY.ants]];');
  });
});
