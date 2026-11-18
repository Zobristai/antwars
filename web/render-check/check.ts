/**
 * Render check: renders every surface of a built site at 1280 and 390 px, in Roboto and in Liberation Sans, and
 * judges each render by the in-page rules (rules.ts). Data comes only from the committed snapshot and labelled
 * fixtures (serve.ts). A failure fails the run unless the reviewed held list (held.json) already holds it.
 *
 *   npm run build:web && npm run render-check
 *   node --import ./src/ts-resolve.mjs web/render-check/check.ts [--dist web/dist] [--out out/render-check]
 *     [--fixtures file.json ...] [--surface watch ...] [--held web/render-check/held.json]
 *     [--update-held] [--record]
 *
 * --record answers data requests the snapshot lacks from the public site and adds them to the snapshot.
 * --update-held rewrites held.json to hold exactly this run's failures (review the diff).
 * The browser is CHROME_BIN (CI sets it to the Playwright image's Chromium).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { renderRules, rulesAssets } from "../rules.ts";
import { TYPEFACES, drawnFonts, fontProblem, fontconfigFor, typefaceSlug } from "./fonts.ts";
import { heldFrom, judge, publish, readHeld, type Render } from "./report.ts";
import { RULE_LIMITS, judgePage, type Box, type PageJudgement } from "./rules.ts";
import { ORIGIN, SNAPSHOT_DIR, readFixtures, readSnapshot, serveSite, writeSnapshot } from "./serve.ts";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../..");
const CHROMIUM_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"];

export const WIDTHS = [1280, 390] as const;

/** A surface: a page of the site, or a match HUD over its board. */
export interface Surface { id: string; url: string; hud: boolean; what: string }

/**
 * The public Free-for-all recording the replay surface plays, so the four-colony HUD (the Score Band) is rendered:
 * 17 Nov 2026 08:55 UTC, four colonies on Strait, served at https://antwars.ai/?replay=<id>.
 */
export const FREE_FOR_ALL_REPLAY = "2026-11-17T08-55-08-583Z-151632020035470";

export const SURFACES: readonly Surface[] = [
  { id: "landing", url: "/", hud: false, what: "the front page" },
  { id: "watch", url: "/?watch=1", hud: false, what: "Watch with no live match (fixture: no live match)" },
  { id: "matches", url: "/?page=matches", hud: false, what: "the Matches page (all recordings)" },
  { id: "leaderboard", url: "/?page=leaderboard", hud: false, what: "the Leaderboard" },
  { id: "rules", url: "/rules", hud: false, what: "the Rules page, as the server renders it before a map is drawn" },
  { id: "replay-free-for-all", url: `/?replay=${FREE_FOR_ALL_REPLAY}`, hud: true, what: "a Free-for-all replay: the match HUD (Score Band) over the board" },
];

const viewport = (width: number) => width < 600
  ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
  : { viewport: { width, height: 800 }, deviceScaleFactor: 1 };

/** Let the page fetch and lay out its data, then (for a page) scroll it through once so lazy parts render. */
async function settle(page: Page, surface: Surface): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  if (surface.hud) {
    await page.waitForFunction(() => window.__antwar?.ready !== undefined, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__antwar.ready.then(() => undefined, () => undefined));
    await page.waitForTimeout(8_000);
    return;
  }
  await page.waitForTimeout(1_500);
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

/** Outline each finding on the page (outside layout), for the marked render. */
async function mark(page: Page, boxes: { box: Box; label: string; held: boolean }[]): Promise<void> {
  await page.evaluate(marks => {
    const layer = document.createElement("div");
    layer.setAttribute("data-render-check", "skip");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none";
    for (const m of marks) {
      const d = document.createElement("div");
      const colour = m.held ? "#f5a623" : "#ff1744";
      d.style.cssText = `position:absolute;left:${m.box.x}px;top:${m.box.y}px;width:${Math.max(m.box.w, 2)}px;height:${Math.max(m.box.h, 2)}px;outline:2px solid ${colour};background:${colour}22`;
      const tag = document.createElement("span");
      tag.textContent = m.label;
      tag.style.cssText = `position:absolute;left:0;top:-14px;font:10px/12px monospace;color:#fff;background:${colour};padding:0 2px;white-space:nowrap`;
      d.append(tag);
      layer.append(d);
    }
    document.body.append(layer);
  }, boxes);
}

interface Options {
  dist: string; out: string; heldFile: string; fixtureFiles: string[]; surfaces: readonly Surface[];
  record: boolean; updateHeld: boolean; chrome: string;
}

async function renderAll(o: Options): Promise<Render[]> {
  const snapshot = await readSnapshot().catch(() => ({ recordedFrom: "https://antwars.ai", recordedAt: new Date().toISOString(), responses: {} }));
  const fixtures = await readFixtures([join(HERE, "fixtures.json"), ...o.fixtureFiles]);
  const manifest = JSON.parse(await readFile(join(o.dist, ".vite/manifest.json"), "utf8"));
  const rulesPage = () => renderRules(newMatchConfig(PUBLIC_CONFIG), { undrawn: true, assets: rulesAssets(manifest) });
  const held = await readHeld(o.heldFile).catch(() => ({ note: "", held: [] }));
  const heldKeys = new Set(held.held.map(h => [h.surface, h.width, h.typeface, h.rule, h.element].join("|")));
  const renders: Render[] = [];
  const fontRoot = join(o.out, ".fontconfig");
  await mkdir(join(o.out, "renders"), { recursive: true });
  for (const typeface of TYPEFACES) {
    const conf = await fontconfigFor(typeface, fontRoot);
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ executablePath: o.chrome, args: CHROMIUM_FLAGS, env: { ...process.env, FONTCONFIG_FILE: conf } });
      for (const width of WIDTHS) for (const surface of o.surfaces) {
        const context = await browser.newContext({ ...viewport(width), timezoneId: "UTC", locale: "en-GB", reducedMotion: "reduce" });
        const served = await serveSite(context, { dist: o.dist, snapshot, fixtures, rulesPage, record: o.record });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", e => pageErrors.push(String(e.message ?? e)));
        const image = `renders/${surface.id}-${width}-${typefaceSlug(typeface)}.png`;
        const invalid: string[] = [];
        let judged: PageJudgement = { failures: [], tight: [], counted: { items: 0, grids: 0, tiles: 0 } };
        let fonts: Record<string, number> = {};
        try {
          await page.goto(ORIGIN + surface.url, { waitUntil: "load", timeout: 30_000 });
          await settle(page, surface);
          judged = await page.evaluate(judgePage, RULE_LIMITS);
          fonts = await drawnFonts(page);
          const wrongFont = fontProblem(typeface, fonts);
          if (wrongFont) invalid.push(wrongFont);
          if (judged.counted.items === 0) invalid.push("the page laid out no text to judge");
          const key = (rule: string, element: string) => [surface.id, width, typeface, rule, element].join("|");
          await mark(page, judged.failures.filter(f => f.box).map(f => ({ box: f.box!, label: `${f.rule}: ${f.measure}`, held: heldKeys.has(key(f.rule, f.element)) })));
          if (!surface.hud) {
            // A page that scrolls inside its own box is shown whole: the render is taken at the height of its content.
            const tall = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll("*")]
              .filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight)
              .map(e => e.scrollHeight + e.getBoundingClientRect().top + scrollY)));
            const size = page.viewportSize()!;
            if (tall > size.height) await page.setViewportSize({ width: size.width, height: Math.ceil(tall) });
          }
          await page.screenshot({ path: join(o.out, image), fullPage: !surface.hud });
        } catch (error) {
          invalid.push(`did not render: ${(error as Error).message.split("\n")[0]}`);
          await page.screenshot({ path: join(o.out, image) }).catch(() => undefined);
        }
        if (served.unanswered.length) invalid.push(`requests outside the snapshot and fixtures: ${[...new Set(served.unanswered)].join(", ")}`);
        renders.push({ surface: surface.id, url: surface.url, width, typeface, failures: judged.failures, tight: judged.tight, image, fonts, invalid, pageErrors, fixtures: [...served.fixturesUsed] });
        console.log(`${surface.id} ${width} ${typeface}: ${judged.failures.length} failures, ${judged.tight.length} tight, ${judged.counted.items} items, ${judged.counted.grids} grids${invalid.length ? `; INVALID: ${invalid.join("; ")}` : ""}`);
        await context.close();
      }
    } finally {
      await browser?.close();
      if (o.record) await writeSnapshot(snapshot);
    }
  }
  await rm(fontRoot, { recursive: true, force: true });
  return renders;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    dist: { type: "string", default: join(REPO, "web/dist") },
    out: { type: "string", default: join(REPO, "out/render-check") },
    held: { type: "string", default: join(HERE, "held.json") },
    fixtures: { type: "string", multiple: true, default: [] },
    surface: { type: "string", multiple: true, default: [] },
    record: { type: "boolean", default: false },
    "update-held": { type: "boolean", default: false },
    label: { type: "string", default: "" },
  } });
  const chosen = values.surface.length ? SURFACES.filter(s => values.surface.includes(s.id)) : SURFACES;
  if (chosen.length !== (values.surface.length || SURFACES.length)) throw new Error(`unknown surface; choose from ${SURFACES.map(s => s.id).join(", ")}`);
  const o: Options = {
    dist: resolve(values.dist), out: resolve(values.out), heldFile: resolve(values.held),
    fixtureFiles: values.fixtures.map(f => resolve(f)), surfaces: chosen, record: values.record,
    updateHeld: values["update-held"], chrome: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
  };
  await rm(join(o.out, "renders"), { recursive: true, force: true });
  const renders = await renderAll(o);
  const held = await readHeld(o.heldFile).catch(() => ({ note: "Failures already on main, reviewed. Only a failure not held here, or above its count, fails the check.", held: [] }));
  if (o.updateHeld) {
    await writeFile(o.heldFile, JSON.stringify(heldFrom(renders, held, "on main when the render check was introduced"), null, 1) + "\n");
    console.log(`held list rewritten: ${o.heldFile}`);
  }
  const snapshot = await readSnapshot();
  const verdict = judge(renders, o.updateHeld ? await readHeld(o.heldFile) : held);
  await publish(o.out, verdict, renders, {
    build: values.label || process.env.GITHUB_SHA || o.dist,
    snapshot: `${snapshot.recordedFrom} recorded ${snapshot.recordedAt} (web/render-check/snapshot) plus labelled fixtures`,
  });
  if (!verdict.passed) process.exitCode = 1;
}

if (import.meta.main) await main();
export { SNAPSHOT_DIR };
