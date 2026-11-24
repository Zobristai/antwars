// The next spawn, shown as the unit's icon inside a circle in the team colour with no seconds, labelled
// "next spawn": the mount's and stylesheet's contracts for the economy cell. The view itself is read by
// model.ts dials (deck-model.test.ts); visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { applyTextSize } from "../../../web/render-check/fonts.ts";
import { D1_ICON, RING } from "../../../web/src/ui/deck/icons.ts";
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
    expect(DECK).toContain("const economies = slots.map(c => {");
    expect(DECK).toContain("const values = measures.map");
  });

  it("puts the coming unit's icon inside the ring, never beside it", () => {
    expect(DECK).toContain("ring.append(caste);");
    expect(DECK).toContain("nextValue.append(ring, words, said);");
  });

  it("writes no seconds and no \"Full\": the cell's words are only the empty figure", () => {
    expect(PAGE_WORDS).not.toHaveProperty("full");
    expect(DECK).toContain('setText(n.words, view.kind === "none" ? "—" : "");');
    expect(DECK).not.toMatch(/view\.text\b/);
  });

  it("keeps the screen-reader description of the next hatch", () => {
    expect(DECK).toContain("paintNext(c, d.next, d.nextText);");
    expect(DECK).toContain("setText(n.said, said);");
  });

  it("centres the icon in the ring, both in the colony's colour, without the old dashed ring", async () => {
    const tokens = readFileSync(new URL("../../../web/src/design-system/tokens.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${tokens}${CSS}</style><main class="d1 score-band" style="--sb-ink:#ffb000">
        <span class="d1-next"><span class="d1-ring">${RING}<span class="d1-caste">${D1_ICON.worker}</span></span></span></main>`);
      for (const size of [16, 32] as const) {
        await applyTextSize(page, size);
        const geometry = await page.locator(".d1-ring").evaluate(el => {
          const ring = el.querySelector(":scope > svg")!.getBoundingClientRect();
          const caste = el.querySelector(".d1-caste")!, icon = caste.querySelector("svg")!.getBoundingClientRect();
          return { ring: [ring.width, ring.height], icon: [icon.width, icon.height],
            dx: icon.x + icon.width / 2 - (ring.x + ring.width / 2), dy: icon.y + icon.height / 2 - (ring.y + ring.height / 2),
            border: getComputedStyle(caste).borderStyle, ink: getComputedStyle(caste).color, stroke: getComputedStyle(el.querySelector(".d1-ring-fill")!).stroke };
        });
        expect(geometry).toEqual({ ring: [20 * size / 16, 20 * size / 16], icon: [10 * size / 16, 10 * size / 16], dx: 0, dy: 0,
          border: "none", ink: "rgb(255, 176, 0)", stroke: "rgb(255, 176, 0)" });
      }
    } finally { await browser.close(); }
  });

  it("leaves the Territory hold ring as it was: the shared ring rule is unscoped and unchanged", () => {
    expect(rule(".d1-ring")).toBe(" flex: none; display: inline-flex; ");
    expect(CSS).not.toMatch(/\n\.d1-ring > svg|\n\.d1-ring svg \{[^}]*width/);
  });
});
