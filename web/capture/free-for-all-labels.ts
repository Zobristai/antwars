/** Local built-page label captures. Every request is intercepted; no live data or credentials.
 * node --import ./src/ts-resolve.mjs web/capture/free-for-all-labels.ts
 *   --dist web/dist --out out/labels --browser /path/to/chrome --font Roboto
 *   --fontconfig /path/to/fonts.conf --label before --expected Quadrants
 * Run once per requested font. The fontconfig file must resolve system-ui to that face.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { SUPERCOLONY_NAMES } from "../../src/sim/colonyNames.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { renderRules, rulesAssets } from "../rules.ts";

const ORIGIN = "http://localhost:4718";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
/** The wire id stays quadrants; these synthetic responses exercise the real page readers. */
export function labelFixtures() {
  const colonyNames = SUPERCOLONY_NAMES.map(n => n.label);
  const names = ["acorn", "birch", "clover", "dune"];
  const startedAt = "2026-11-14T09:00:00.000Z";
  const seats = names.map((handle, colony) => ({ seat: colony, colony, handle, modelLabel: null, thinkingLevel: null, serviceTier: null }));
  return {
    queue: {
      waiting: [{ displayName: "elm", mode: "quadrants", waitingSeconds: 30, since: Date.parse(startedAt), rating: null }],
      lobbies: [{ mode: "quadrants", size: 1, seated: 4, colonies: names.map(n => [n]), ratings: names.map(() => [null]), seats: names.map(() => [1]), waitingSeconds: 10, since: Date.parse(startedAt), colonyNames }],
    },
    catalog: { matches: [{ lobbyId: "sample-four-colony", startedAt: Date.parse(startedAt), rated: false, delaySeconds: 60,
      matchType: { kind: "quadrants", size: 1 }, colonyNames,
      colonies: names.map(displayName => [{ displayName, rating: null, rd: null, ratedMatches: null }]) }] },
    history: { matches: [{ id: "2026-11-14T09-00-00-000Z-1", startedAt, endedAt: null, simulationEndedAt: null, winner: 2, reason: "queens_killed", decidedBy: null,
      seats, status: "complete", unavailable: [], matchType: { kind: "quadrants", size: 1 }, colonyNames }], nextPageToken: null },
  };
}
export interface LabelFit { text: string; lines: number; clipped: boolean; overlap: boolean }
export function labelProblems(labels: readonly LabelFit[], expected: string): string[] {
  if (labels.length === 0) return ["No visible mode labels"];
  return labels.flatMap(label => label.text !== expected || label.lines !== 1 || label.clipped || label.overlap
    ? [`${label.text}: lines=${label.lines}, clipped=${label.clipped}, overlap=${label.overlap}`] : []);
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(["dist", "out", "browser", "font", "fontconfig", "label", "expected"].map(key => [key, { type: "string" as const }])) });
  for (const key of ["dist", "out", "browser", "font", "fontconfig", "label", "expected"]) assert(values[key], `Missing --${key}`);
  const directory = await realpath(values.dist!), out = resolve(values.out!);
  await mkdir(out, { recursive: true });
  const fixtures = labelFixtures();
  const config = newMatchConfig(rulesConfig("redesign"));
  const four = { ...config, terrain: { ...config.terrain!, maps: quadrantMatchMaps() } };
  const manifest = JSON.parse(await readFile(join(directory, ".vite/manifest.json"), "utf8"));
  const browser = await chromium.launch({ executablePath: values.browser!, headless: true,
    env: { ...process.env, FONTCONFIG_FILE: values.fontconfig! } });
  const results: unknown[] = [];
  try {
    for (const width of [1280, 390]) for (const scene of ["matches", "landing", "rules"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
        if (url.origin !== ORIGIN) { errors.push(`External request refused: ${url.origin}`); return route.abort(); }
        if (url.pathname === "/watch/queue") return json(fixtures.queue);
        if (url.pathname === "/watch/catalog") return json(fixtures.catalog);
        if (url.pathname === "/matches") return json(fixtures.history);
        if (url.pathname === "/api/leaderboard") return json({ entries: [] });
        if (url.pathname === "/rules") return route.fulfill({ contentType: "text/html", body: renderRules(four, { undrawn: true, assets: rulesAssets(manifest) }) });
        if (route.request().method() !== "GET" || (url.pathname !== "/" && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname))) {
          errors.push(`Unexpected request: ${url.pathname}`); return route.abort();
        }
        const file = await realpath(join(directory, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
        assert(file.startsWith(directory + sep) && TYPES[extname(file)], "Static asset outside build");
        let body: Buffer | string = await readFile(file);
        if (url.pathname === "/") body = body.toString("utf8").replace("<head>", '<head><meta name="antwar-public-matches" content="true"><meta name="antwar-lobbies" content="true">');
        return route.fulfill({ contentType: TYPES[extname(file)], body });
      });
      try {
        await page.goto(`${ORIGIN}/${scene === "matches" ? "?page=matches" : scene === "rules" ? "rules" : ""}`);
        if (scene === "rules") await page.waitForSelector('.d1p[data-page="rules"]');
        else await page.waitForFunction(() => [...document.querySelectorAll(".d1p-type")].some(e => e.textContent === "Quadrants" || e.textContent === "Free-for-all"));
        await page.evaluate(() => document.fonts.ready);
        const labels = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".d1p-type")].filter(e => e.checkVisibility()).map(e => {
          const box = e.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(e);
          const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
          const lines = new Set(rects.map(r => Math.round(r.top))).size;
          let clipped = box.left < 0 || box.right > innerWidth || e.scrollWidth > e.clientWidth + 1;
          for (let a = e.parentElement; a; a = a.parentElement) {
            const b = a.getBoundingClientRect();
            if (getComputedStyle(a).overflowX !== "visible" && rects.some(r => r.left < b.left - 1 || r.right > b.right + 1)) clipped = true;
          }
          const cell = e.closest("td");
          const overlap = !!cell && rects.some(r => r.left < cell.getBoundingClientRect().left - 1 || r.right > cell.getBoundingClientRect().right + 1);
          return { text: e.textContent ?? "", lines, clipped, overlap };
        }));
        if (scene !== "rules") errors.push(...labelProblems(labels, values.expected!));
        if (scene !== "rules" && labels.length !== (scene === "matches" ? 4 : 1)) errors.push("Unexpected visible mode-label count");
        const waitingSummary = await page.evaluate(() => {
          const state = document.querySelector<HTMLElement>(".d1p-waiting .d1p-state");
          if (!state) return null;
          const box = state.getBoundingClientRect();
          return { text: state.textContent, clipped: state.scrollWidth > state.clientWidth + 1 || box.left < 0 || box.right > innerWidth };
        });
        if (scene === "matches" && (!waitingSummary || waitingSummary.clipped || !waitingSummary.text?.replaceAll("\u00a0", " ").includes(`waiting for ${values.expected}`))) errors.push("Waiting summary missing, stale or clipped");
        const text = await page.locator("body").innerText();
        if (values.expected === "Free-for-all" && /\bQuadrants\b/.test(text)) errors.push("Retired mode name shown");
        const selector = scene === "rules" ? "#d1-overview-title, #d1-maps-title" : ".d1p-type";
        const cdp = await context.newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
        const fonts = [];
        for (const nodeId of nodeIds) fonts.push(...(await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts);
        if (!fonts.some(f => f.familyName === values.font && f.glyphCount > 0) || fonts.some(f => f.glyphCount > 0 && f.familyName !== values.font)) errors.push(`Requested font not observed exclusively: ${values.font}`);
        const prefix = `${values.label}-${values.font!.toLowerCase().replaceAll(" ", "-")}-${width}-${scene}`;
        if (scene === "rules") {
          // The enhanced page uses one card per section; record overview and the three-map descriptions.
          for (const title of ["Overview", "Maps"]) {
            const section = page.locator("section.d1p-rule").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
            await section.screenshot({ path: join(out, `${prefix}-${title.toLowerCase()}.png`) });
          }
        } else {
          const cards = page.locator(scene === "matches" ? ".d1p-content > section" : ".fg-cards section");
          const selected = await cards.count() ? cards : page.locator("section").filter({ has: page.getByRole("heading", { name: "Recordings", exact: true }) });
          assert.equal(await selected.count(), scene === "matches" ? 3 : 1, "Missing capture surface");
          for (let i = 0; i < await selected.count(); i++) await selected.nth(i).screenshot({ path: join(out, `${prefix}-${i + 1}.png`) });
        }
        results.push({ scene, width, font: values.font, expected: values.expected, labels, waitingSummary, fonts, errors });
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await writeFile(join(out, `${values.label}-${values.font!.toLowerCase().replaceAll(" ", "-")}.json`), JSON.stringify(results, null, 2));
  }
  assert(results.every(r => (r as { errors: string[] }).errors.length === 0), "Capture checks failed; see manifest");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
