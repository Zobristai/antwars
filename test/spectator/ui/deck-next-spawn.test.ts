// The next spawn, shown as the unit's icon inside a circle in the team colour with no seconds, labelled
// "next spawn": the mount's and stylesheet's contracts for the economy cell. The view itself is read by
// model.ts dials (deck-model.test.ts); visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_WORDS } from "../../../web/src/ui/deck/model.ts";

const CSS = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
const DECK = readFileSync(new URL("../../../web/src/ui/deck/deck.ts", import.meta.url), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at + selector.length + 3, CSS.indexOf("}", at));
}

describe("the next spawn", () => {
  it("labels the economy cell \"Next spawn\" for both colonies", () => {
    expect(PAGE_WORDS.nextSpawn).toBe("Next spawn");
    expect(PAGE_WORDS).not.toHaveProperty("nextAnt");
    expect(DECK).toContain('["next", PAGE_WORDS.nextSpawn]');
    // One measures list builds both colonies' cells.
    expect(DECK).toMatch(/const economies = COLONIES\.map\(c => \{\s*const root = h\(doc, "div", `d1-econ c\$\{c\}`\);\s*const values = measures\.map/);
  });

  it("puts the coming unit's icon inside the ring, never beside it", () => {
    expect(DECK).toContain("ring.append(caste);");
    expect(DECK).toContain("value.append(ring, words, said);");
  });

  it("writes no seconds and no \"Full\": the cell's words are only the empty figure", () => {
    expect(PAGE_WORDS).not.toHaveProperty("full");
    expect(DECK).toContain('setText(n.words, view.kind === "none" ? "—" : "");');
    expect(DECK).not.toMatch(/view\.text\b/);
  });

  it("keeps the screen-reader description of the next hatch", () => {
    expect(DECK).toContain("paintNext(c, ds[c].next, ds[c].nextText);");
    expect(DECK).toContain("setText(n.said, said);");
  });

  it("centres the icon in the ring, both in the colony's colour, without the old dashed ring", () => {
    expect(rule(".d1-next .d1-ring")).toMatch(/display: inline-grid; place-items: center/);
    expect(rule(".d1-next .d1-ring > *")).toMatch(/grid-area: 1 \/ 1/);
    expect(rule(".d1-next .d1-ring > svg")).toMatch(/width: 20px; height: 20px/);
    expect(rule(".d1-caste")).toMatch(/color: currentColor/);
    expect(rule(".d1-caste")).not.toMatch(/dashed|border/);
    expect(rule(".d1-ring-fill")).toMatch(/stroke: currentColor/);
  });

  it("leaves the Territory hold ring as it was: the shared ring rule is unscoped and unchanged", () => {
    expect(rule(".d1-ring")).toBe(" flex: none; display: inline-flex; ");
    expect(CSS).not.toMatch(/\n\.d1-ring > svg|\n\.d1-ring svg \{[^}]*width/);
  });
});
