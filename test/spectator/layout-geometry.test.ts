// The dock's and the landing page's resolved geometry, checked as relations between measured
// boxes. First on substituted measurements (the served build's own boxes, then each broken one way), then in headless
// Chromium against a fresh build of the client. dock.test.ts keeps its CSS source pins as cheap guards beside these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROMIUM_FLAGS, servePage } from "../../web/capture/browser.ts";
import { DOCK, LANDING, dockLayoutProblems, landingLayoutProblems, measureLayout, type Box, type LayoutSnapshot } from "./layout-geometry.ts";

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const snapshot = (width: number, height: number, boxes: Record<string, Box>): LayoutSnapshot => ({ viewport: { width, height }, boxes, scrollWidth: width });
/** The served build's boxes at main 3cad75d2 (Chromium, 2D board, stored replay), rounded to whole pixels. */
const dock = {
  portrait: () => snapshot(393, 659, { score: box(8, 6, 377, 258), stage: box(0, 270, 393, 189), foot: box(8, 459, 377, 130), pane: box(0, 593, 393, 66) }),
  landscape: () => snapshot(844, 390, { score: box(12, 8, 560, 154), stage: box(12, 168, 560, 180), foot: box(12, 354, 560, 28), pane: box(584, 8, 248, 374) }),
  desktop: () => snapshot(1280, 800, { score: box(12, 8, 996, 154), stage: box(12, 168, 996, 586), foot: box(12, 760, 996, 32), pane: box(1020, 8, 248, 784) }),
};
const landing = {
  portrait: () => snapshot(393, 659, { mast: box(16, 0, 361, 97), hero: box(0, 97, 393, 600), records: box(16, 753, 361, 140), agent: box(16, 949, 361, 156) }),
  landscape: () => snapshot(844, 390, { mast: box(32, 0, 780, 64), hero: box(0, 64, 844, 540), records: box(32, 700, 780, 109), agent: box(32, 905, 780, 168) }),
  desktop: () => snapshot(1280, 800, { mast: box(40, 0, 1200, 64), hero: box(0, 64, 1280, 576), records: box(40, 736, 1200, 109), agent: box(40, 941, 1200, 168) }),
};

describe("dock geometry on substituted measurements", () => {
  it("accepts the served build's dock at phone portrait, phone landscape and desktop", () => {
    for (const view of Object.values(dock)) expect(dockLayoutProblems(view())).toEqual([]);
  });
  it("rejects a pane that overlaps the board column on a wide screen", () => {
    const s = dock.desktop(); s.boxes.pane!.x = 900;
    expect(dockLayoutProblems(s)).toContain("pane: overlaps the board column");
  });
  it("rejects a pane that rides over the footer on a phone", () => {
    const s = dock.portrait(); s.boxes.pane!.y = 500;
    expect(dockLayoutProblems(s)).toContain("pane: not below the footer");
  });
  it("rejects score, board and footer out of order or overlapping", () => {
    const s = dock.landscape(); s.boxes.stage!.y = 100;
    expect(dockLayoutProblems(s)).toContain("score overlaps or follows stage");
  });
  it("rejects a footer pushed off the screen and a board that collapses", () => {
    const s = dock.portrait(); s.boxes.foot!.y = 600;
    expect(dockLayoutProblems(s)).toContain("foot: outside viewport height");
    const t = dock.desktop(); t.boxes.stage!.height = 100; t.boxes.foot!.y = 274;
    expect(dockLayoutProblems(t)).toContain("stage: under a fifth of the viewport");
    t.boxes.stage!.width = 600;
    expect(dockLayoutProblems(t)).toContain("stage: narrower than half the viewport");
  });
  it("rejects sideways overflow, a missing part and an empty box", () => {
    const s = dock.landscape(); s.scrollWidth = 900; s.boxes.pane!.width = 300;
    expect(dockLayoutProblems(s)).toEqual(expect.arrayContaining(["page: horizontal overflow", "pane: outside viewport width"]));
    const t = dock.desktop(); t.boxes.pane = null;
    expect(dockLayoutProblems(t)).toEqual(["pane: missing"]);
    const u = dock.desktop(); u.boxes.stage!.height = 0;
    expect(dockLayoutProblems(u)).toEqual(["stage: empty or invalid box"]);
  });
  it("allows sub-pixel edges", () => {
    const s = dock.landscape(); s.boxes.pane!.x = 571.6; s.boxes.foot!.y = 347.6;
    expect(dockLayoutProblems(s)).toEqual([]);
  });
});

describe("landing geometry on substituted measurements", () => {
  it("accepts the served build's landing page at phone portrait, phone landscape and desktop", () => {
    for (const view of Object.values(landing)) expect(landingLayoutProblems(view())).toEqual([]);
  });
  it("rejects sections out of order, a mast off the top and a hero below the first screen", () => {
    const s = landing.desktop(); s.boxes.records!.y = 500;
    expect(landingLayoutProblems(s)).toContain("hero overlaps or follows records");
    const t = landing.portrait(); t.boxes.mast!.y = 20;
    expect(landingLayoutProblems(t)).toContain("mast: not at the top");
    const u = landing.landscape(); u.boxes.mast!.height = 400; u.boxes.hero!.y = 400;
    expect(landingLayoutProblems(u)).toContain("hero: below the first screen");
  });
  it("rejects sideways overflow and a section wider than the screen", () => {
    const s = landing.portrait(); s.scrollWidth = 420; s.boxes.records!.width = 400;
    expect(landingLayoutProblems(s)).toEqual(expect.arrayContaining(["page: horizontal overflow", "records: outside viewport width"]));
  });
});

// One fresh build of today's client into a temporary directory (never web/dist, which other runs serve), shared by every
// viewport; Chromium on SwiftShader as the capture harness runs it. Fails, never skips, without Chromium.
const VIEWPORTS = [{ name: "phone portrait", width: 393, height: 659 }, { name: "phone landscape", width: 844, height: 390 }, { name: "desktop", width: 1280, height: 800 }] as const;
let browser: Browser, webDir: string;
beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "antwar-layout-"));
  await build({ configFile: "web/vite.config.ts", logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: [...CHROMIUM_FLAGS, "--no-sandbox", "--disable-dev-shm-usage"] });
}, 120_000);
afterAll(async () => { await browser?.close(); if (webDir) rmSync(webDir, { recursive: true, force: true }); });

async function open(kind: "landing" | "dock", width: number, height: number): Promise<{ page: Page; errors: string[] }> {
  const { page, url, errors } = await servePage(browser, { recording: "unused", replay: kind === "dock", width, height, tilt: false, board: "2d", phone: width < 900, webDir });
  // The two reads servePage leaves unanswered, answered empty as a server with no lobbies and no stored ratings does.
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
  await page.route("**/watch/catalog", route => route.fulfill(json({ matches: [], lobbies: [] })));
  await page.route("**/watch/ratings/*", route => route.fulfill(json({ ratings: [] })));
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const target = new URL(url);
  if (kind === "landing") target.search = "";
  await page.goto(target.href);
  await page.evaluate(() => document.fonts.ready);
  if (kind === "landing") await page.waitForSelector(LANDING.hero);
  else {
    await page.waitForFunction(() => !!window.__antwar);
    await page.evaluate(() => window.__antwar.ready);
    await page.clock.runFor(5000);
    await page.evaluate(() => window.__antwar.frame());
  }
  return { page, errors };
}

describe("headless-browser smoke of the landing and dock pages", () => {
  for (const { name, width, height } of VIEWPORTS) {
    it(`lays out the landing page at ${name} ${width}x${height}`, async () => {
      const { page, errors } = await open("landing", width, height);
      try {
        expect(landingLayoutProblems(await measureLayout(page, LANDING))).toEqual([]);
        expect(errors).toEqual([]);
      } finally { await page.context().close(); }
    }, 60_000);
    it(`lays out the dock at ${name} ${width}x${height}`, async () => {
      const { page, errors } = await open("dock", width, height);
      try {
        expect(dockLayoutProblems(await measureLayout(page, DOCK))).toEqual([]);
        expect(errors).toEqual([]);
      } finally { await page.context().close(); }
    }, 60_000);
  }
});

// The line under the board: a recording's state (RECORDING) and Back to live keep their own room beside Bring your agent,
// each drawn in full inside every box that clips it and on the screen, never squeezed to nothing by Copy.
describe("the dock's state line under the board", () => {
  for (const { width, height } of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    it(`shows the recording's state and Back to live at ${width}px`, async () => {
      const { page } = await open("dock", width, height);
      try {
        const shown = await page.evaluate(() => [".d2-mode-label", ".d2-back"].map(selector => {
          const node = document.querySelector<HTMLElement>(`.d2-foot ${selector}`);
          if (!node) return `${selector}: missing`;
          const box = node.getBoundingClientRect();
          if (box.width < 1 || box.height < 1 || getComputedStyle(node).visibility !== "visible") return `${selector}: not drawn`;
          if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) return `${selector}: off screen`;
          for (let up = node.parentElement; up; up = up.parentElement) {
            const style = getComputedStyle(up);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const clip = up.getBoundingClientRect();
            if (box.left < clip.left - 0.5 || box.top < clip.top - 0.5 || box.right > clip.right + 0.5 || box.bottom > clip.bottom + 0.5) return `${selector}: cut by .${[...up.classList].join(".")}`;
          }
          return `${selector}: ${node.textContent?.trim()}`;
        }));
        expect(shown[0]).toMatch(/^\.d2-mode-label: RECORDING/);
        expect(shown[1]).toBe(".d2-back: Back to live");
      } finally { await page.context().close(); }
    }, 60_000);
  }
});
