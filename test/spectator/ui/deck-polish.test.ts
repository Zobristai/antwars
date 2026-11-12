// The Instrument deck polish pass: the stylesheet's contracts behind an uncut Elo, the credit under the
// wordmark, agent rows that never cut a name or a rating, and a top bar that fits a 320 px phone.
// Visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const DECK = readFileSync(new URL("../../../web/src/ui/deck/deck.ts", import.meta.url), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`, at any nesting. */
function rule(selector: string, from = CSS): string {
  const at = from.indexOf(`${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return from.slice(at + selector.length + 2, from.indexOf("}", at));
}
/** The body of the first at-rule block starting with `head`. */
function block(head: string): string {
  const at = CSS.indexOf(`${head} {`);
  expect(at, `block ${head}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = CSS.indexOf("{", at); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(CSS.indexOf("{", at) + 1, i);
  }
  throw new Error(`unclosed ${head}`);
}

describe("deck polish", () => {
  it("drops the provenance legend line", () => {
    expect(CSS).not.toContain(".d1-dotted");
    expect(DECK).not.toContain("d1-dotted");
  });

  it("never cuts an Elo: an agent row's rating badge keeps its own width, unclipped", () => {
    // No far-right rating column: the rating is a badge in the name line.
    expect(rule(".d1-agent")).toMatch(/grid-template-columns: 16px minmax\(0, 1fr\);/);
    expect(rule(".d1-elo")).toMatch(/flex: none/);
    expect(rule(".d1-elo")).toMatch(/white-space: nowrap/);
    expect(rule(".d1-elo")).not.toMatch(/overflow|text-overflow/);
    // In the one player's line only the name and model give way; the badges, rating, count and result never do.
    expect(rule(".d1-team-player > :not(.d1-team-player-name)")).toMatch(/flex: none/);
    expect(rule(".d1-team-player")).not.toMatch(/overflow: hidden/);
  });

  it("stacks the credit under the wordmark beside the emblem, inside the 48 px bar, hidden on a phone", () => {
    expect(CSS).toMatch(/grid-template-rows: 48px /);
    expect(rule(".d1-emblem")).toMatch(/grid-row: 1 \/ 3/);
    expect(rule(".d1-emblem")).toMatch(/height: 28px/);
    expect(rule(".d1-home > .d2-wordmark")).toMatch(/grid-column: 2; grid-row: 1/);
    // The link home holding the emblem and wordmark shares the brand's two columns and rows, so neither moves.
    expect(rule(".d1-home")).toMatch(/grid-column: 1 \/ 3; grid-row: 1 \/ 3; grid-template-columns: subgrid; grid-template-rows: subgrid;/);
    expect(rule(".d1-home")).toMatch(/text-decoration: none/);
    expect(rule(".d1-home:focus-visible > *")).toMatch(/outline: 2px solid/);
    expect(rule(".d1-brand > .d1-top-credit")).toMatch(/grid-column: 2; grid-row: 2/);
    const phone = block("@media (max-width: 559px)");
    expect(rule(".d1-top-credit", phone)).toMatch(/display: none/);
  });

  it("keeps the team container a size container (its parts read its width)", () => {
    expect(rule(".d1-team")).toMatch(/container-type: inline-size/);
  });

  it("keeps a Benchmark name's badges whole beside it, as the Leaderboard's tags", () => {
    expect(rule(".d1-tags")).toMatch(/flex: none/);
    expect(rule(".d1-tag")).toMatch(/white-space: nowrap/);
    expect(rule(".d1-outcome")).toMatch(/flex: none/);
    // No quiet thinking level: a level is always a badge.
    expect(CSS).not.toContain(".d1-quiet");
    // An agent row never cuts a name: it wraps, as the Leaderboard's does, on every width.
    expect(rule(".d1-who")).toMatch(/flex-wrap: wrap/);
    expect(rule(".d1-title")).not.toMatch(/text-overflow|white-space: nowrap/);
    expect(CSS).not.toMatch(/\.d1-who \{[^}]*nowrap/);
  });

  it("tightens the top bar on the narrowest phones so the pages stay on the screen", () => {
    const tiny = block("@media (max-width: 359px)");
    expect(rule(".d1-top .d2-nav-link", tiny)).toMatch(/padding: 0 3px/);
    expect(rule(".d1-top-end:empty", tiny)).toMatch(/display: none/);
  });
});
