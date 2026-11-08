// The three pages' top bar: main's HUD deck bar, sticky,
// with "Built with Zobrist" under the wordmark at every width. The DOM half is read from the test port; the stylesheet
// half reads top-bar.css's contracts. Neither is visual evidence: the served build's captures are that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mountFrame, type PageName } from "../../../web/src/pages/chrome.ts";
import { PAGE_COPY } from "../../../web/src/story.ts";
import { dom } from "./dom.ts";

const CSS = readFileSync(new URL("../../../web/src/pages/top-bar.css", import.meta.url), "utf8");
const rule = (selector: string, from: string) => {
  const at = from.indexOf(`${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return from.slice(at + selector.length + 2, from.indexOf("}", at));
};
const phone = () => CSS.slice(CSS.indexOf("@media (max-width: 559px) {"));

describe("the pages' top bar", () => {
  it.each<PageName>(["leaderboard", "matches", "rules"])("on %s is main's deck bar: emblem, wordmark, credit, the pages and one Bring your agent", page => {
    const port = dom({ wide: true });
    const frame = mountFrame(port.doc, port.body as unknown as HTMLElement, page);
    const root = frame.root as unknown as ReturnType<typeof dom>["body"];
    const bar = root.children[0]!;
    expect(bar.tag).toBe("header");
    expect(bar.classes()).toEqual(["d1-top"]);
    const brand = bar.children[0]!;
    expect(brand.children.map(part => part.className)).toEqual(["d1-emblem", "d2-wordmark", "d2-credit d1-top-credit"]);
    expect(brand.children[2]!.textContent).toBe(PAGE_COPY.credit);
    expect(root.byClass("d1-agent-button")).toHaveLength(1);
    expect(root.byClass("d1-dialog")).toHaveLength(1);
    expect(root.all().some(node => node.classes().some(name => name.startsWith("d1p-top") || name === "d1p-brand"))).toBe(false);
    frame.destroy();
  });

  // The dialog (shared with the in-match deck) carries Copy and, under it, Copy prompt.
  it.each<PageName>(["leaderboard", "matches", "rules"])("on %s the dialog has the address's Copy and a cyan-classed Copy prompt with its own note", page => {
    const port = dom({ wide: true });
    const frame = mountFrame(port.doc, port.body as unknown as HTMLElement, page);
    const root = frame.root as unknown as ReturnType<typeof dom>["body"];
    const dialog = root.byClass("d1-dialog")[0]!;
    const copies = dialog.byClass("aw-byoa-copy");
    expect(copies.map(node => node.textContent)).toEqual(["Copy", "Copy prompt"]);
    const prompt = dialog.byClass("aw-byoa-prompt")[0]!;
    expect(prompt.byClass("aw-byoa-prompt-copy")).toEqual([copies[1]]);
    const note = prompt.byClass("aw-byoa-note")[0]!;
    expect(note.getAttribute("role")).toBe("status");
    // The test page has no clipboard: the prompt's own note says so, the address's note stays empty.
    copies[1]!.click();
    expect(note.textContent).toBe("Copy failed");
    expect(dialog.byClass("aw-byoa-address")[0]!.byClass("aw-byoa-note")[0]!.textContent).toBe("");
    frame.destroy();
  });

  it("borrows only the bar's own modules, never the deck model that brings the board renderer with it", () => {
    for (const file of ["brand.ts", "dialog.ts"]) {
      const source = readFileSync(new URL(`../../../web/src/ui/deck/${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map(match => match[1]);
      expect(imports.length, file).toBeGreaterThan(0);
      for (const specifier of imports) expect(specifier, file).not.toMatch(/^\.\/(model|hud|deck|pane)\.ts$|squads|pixi/);
    }
  });

  it("stays at the top of the scrolling page", () => {
    expect(rule(".d1p .d1-top", CSS)).toMatch(/position: sticky; top: 0/);
  });

  it("keeps the credit under the wordmark on a phone, where the board's bar moves it to its footer", () => {
    expect(rule(".d1p .d1-brand > .d1-top-credit", phone())).toMatch(/display: inline/);
    expect(rule(".d1p .d1-brand > .d2-wordmark", phone())).toMatch(/grid-row: 1; align-self: end/);
  });
});
