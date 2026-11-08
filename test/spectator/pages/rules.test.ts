// The Rules page's Archive enhancement: the server page stays whole and readable without JavaScript; with a
// build it also names the entry, its CSS and the exact sections; the entry draws Archive's Rules from them.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG as TEMPLATE_PUBLIC_CONFIG } from "../../../src/sim/config.ts";
import { playable } from "../../playable.ts";
import { readRulesAssets } from "../../../src/spectator.ts";
import { RULES_DATA_ID, RULES_ENTRY, renderRules, ruleSections, rulesAssets } from "../../../web/rules.ts";

import { mountRulesPage } from "../../../web/src/pages/rules-entry.ts";
import { dom, type ElementPort } from "./dom.ts";

const manifest = {
  [RULES_ENTRY]: { file: "assets/rules-1.js", imports: ["_nav.js", "_model.js"] },
  "_nav.js": { file: "assets/nav.js", css: ["assets/nav.css"] },
  "_model.js": { file: "assets/model.js", imports: ["_nav.js"], css: ["assets/model.css"] },
};
const assets = rulesAssets(manifest);

const PUBLIC_CONFIG = playable(TEMPLATE_PUBLIC_CONFIG);

describe("the Rules page's build assets", () => {
  it("reads the entry and every stylesheet it pulls in, once each, from the manifest", () => {
    expect(assets).toEqual({ script: "/assets/rules-1.js", css: ["/assets/nav.css", "/assets/model.css"] });
    expect(() => rulesAssets({})).toThrow(/missing/);
    expect(() => rulesAssets({ [RULES_ENTRY]: { file: "x.js", imports: ["_gone.js"] } })).toThrow(/missing/);
  });
  it("serves the script-free page when there is no build, and the build's assets when there is", () => {
    const dist = mkdtempSync(join(tmpdir(), "antwar-rules-dist-"));
    try {
      expect(readRulesAssets(dist)).toBeUndefined();
      mkdirSync(join(dist, ".vite"));
      writeFileSync(join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
      expect(readRulesAssets(dist)).toEqual(assets);
    } finally { rmSync(dist, { recursive: true, force: true }); }
  });
  it("keeps the server page whole and adds the stylesheets, the exact sections and the module script after it", () => {
    const plain = renderRules(PUBLIC_CONFIG), enhanced = renderRules(PUBLIC_CONFIG, { assets });
    // No build enhancement without a build; the favicon link is part of the plain page.
    expect(plain).not.toMatch(/<script|<link rel="stylesheet"/);
    const end = plain.indexOf("</main>") + "</main>".length;
    expect(enhanced.slice(0, end)).toBe(plain.slice(0, end));
    expect(enhanced.slice(end)).toMatch(/^<link rel="stylesheet" href="\/assets\/nav.css"><link rel="stylesheet" href="\/assets\/model.css"><script id="aw-rules-data" type="application\/json">.*<\/script><script type="module" src="\/assets\/rules-1.js"><\/script><\/body><\/html>$/s);
    const data = /<script id="aw-rules-data" type="application\/json">(.*?)<\/script>/s.exec(enhanced)![1]!;
    expect(data).not.toContain("<");
    expect(JSON.parse(data)).toEqual({ sections: ruleSections(PUBLIC_CONFIG) });
  });
});

describe("the Rules browser entry", () => {
  function served(withData: boolean) {
    const port = dom();
    const page = port.doc.createElement("main") as unknown as ElementPort; port.body.append(page);
    if (withData) {
      const data = port.doc.createElement("script") as unknown as ElementPort;
      data.id = RULES_DATA_ID; data.textContent = JSON.stringify({ sections: ruleSections(PUBLIC_CONFIG) });
      port.body.append(data);
    }
    mountRulesPage(port.doc);
    return { port, page, host: port.body.byClass("aw-page-host")[0] };
  }
  it("sets the server page aside and draws Archive's Rules from the same sections, with Bring your agent", () => {
    const { page, host } = served(true);
    expect(page.style.getPropertyValue("display")).toBe("none");
    expect(page.style.getPropertyPriority("display")).toBe("important");
    const titles = host!.byClass("d1p-rule-title").map(node => node.textContent);
    expect(titles).toEqual(expect.arrayContaining(ruleSections(PUBLIC_CONFIG).map(section => section.title)));
    expect(titles).toHaveLength(ruleSections(PUBLIC_CONFIG).length);
    expect(host!.byClass("d1-agent-button")).toHaveLength(1);
    expect(host!.byClass("d1p-lead")[0]!.textContent).toBe("The same rules apply to people and agents.");
    // The title band on top; the index a side column inside the container, beside the reading cards.
    const band = host!.byClass("d1p-band")[0]!;
    expect(band.byClass("d1p-title")[0]!.textContent).toBe("Rules");
    expect(band.byClass("d1p-index")).toHaveLength(0);
    const split = host!.byClass("d1p-split")[0]!;
    expect(split.children.map(node => node.classes()[0])).toEqual(["d1p-index", "d1p-reading"]);
    expect(split.byClass("d1p-reading")[0]!.byClass("d1p-rules-card")).toHaveLength(2);
  });
  it("leaves the server page alone without its data", () => {
    const { page, host } = served(false);
    expect(page.style.getPropertyValue("display")).toBe("");
    expect(host).toBeUndefined();
  });
});
