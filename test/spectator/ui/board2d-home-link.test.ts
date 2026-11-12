// The 2D board's match screen links its wordmark to the home page, as the deck's emblem and wordmark do
// (deck/brand.ts): the landing at / with no query, never the match screen. The credit stays plain text beside it.
// Mounts the 2D HUD on the test port; not visual evidence: browser captures are that.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_COPY } from "../../../web/src/story.ts";
import { mountHud } from "../../../web/src/ui/hud.ts";
import type { HudActions, HudHost } from "../../../web/src/ui/types.ts";
import { dom, type ElementPort } from "../pages/dom.ts";

const UI_CSS = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8");
const actions = { select() {}, selectAgent() {}, openSheet() {}, pointOrder() {} } as unknown as HudActions;

describe("the 2D board's wordmark", () => {
  it("is a link to the home page named for it, with the credit outside the link", () => {
    const port = dom({ search: "?board=2d&replay" });
    Object.assign(port.win.location, { href: "https://antwars.example/?board=2d&replay", pathname: "/" });
    const host = port.doc.createElement("div") as unknown as ElementPort;
    port.body.append(host);
    mountHud({ doc: port.doc, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions } as unknown as HudHost);
    const brand = host.byClass("d2-brand")[0]!;
    expect(brand.children.map(part => part.className)).toEqual(["d2-home", "d2-credit"]);
    const home = brand.children[0]!;
    expect([home.tag, home.href, home.getAttribute("aria-label")]).toEqual(["a", "/", PAGE_COPY.home]);
    expect(home.children.map(part => [part.className, part.textContent])).toEqual([["d2-wordmark", PAGE_COPY.name]]);
    expect(brand.children[1]!.textContent).toBe(PAGE_COPY.credit);
  });

  it("draws no underline and keeps the wordmark's own baseline", () => {
    const at = UI_CSS.indexOf(".d2-home {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = UI_CSS.slice(at, UI_CSS.indexOf("}", at));
    expect(rule).toMatch(/display: inline-flex/);
    expect(rule).toMatch(/text-decoration: none/);
  });
});
