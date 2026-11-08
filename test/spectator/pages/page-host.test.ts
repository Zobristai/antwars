import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The pages' scroll host (.aw-page-host) must take pointer input, or WebKit (every iPhone browser, Safari)
// will not scroll the Leaderboard, Matches or Rules; the in-match HUD host (.aw-hud) keeps passing input to the board.
// A style-contract check on the source rules, not a painted-layout measurement.
const WEB_SRC = new URL("../../../web/src/", import.meta.url).pathname;
const css = readFileSync(join(WEB_SRC, "ui/ui.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The pointer-events value the last top-level rule naming exactly this selector gives it (same specificity, so last wins). */
function pointerEvents(selector: string): string | undefined {
  let value: string | undefined;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors!.split(",").map(part => part.trim()).includes(selector)) continue;
    const declared = /(?:^|;)\s*pointer-events:\s*([^;]+?)\s*(?:;|$)/.exec(body!);
    if (declared) value = declared[1];
  }
  return value;
}
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

describe("the pages' scroll host", () => {
  it("takes pointer input, so WebKit scrolls it", () => {
    expect(pointerEvents(".aw-page-host")).toBeDefined();
    expect(pointerEvents(".aw-page-host")).not.toBe("none");
  });
  it("leaves the in-match HUD host ignoring pointer input, so presses and drags reach the board", () => {
    expect(pointerEvents(".aw-hud")).toBe("none");
  });
  it("is created only by the Leaderboard, Matches and Rules pages, which mount no board", () => {
    const creators = sources(WEB_SRC)
      .filter(file => /className\s*=\s*"aw-page-host"/.test(readFileSync(file, "utf8")))
      .map(file => relative(WEB_SRC, file)).sort();
    expect(creators).toEqual(["leaderboard-page/page.ts", "matches-page/page.ts", "pages/rules-entry.ts"]);
  });
});
