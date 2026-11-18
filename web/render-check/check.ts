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
import { RULE_LIMITS, judgePage, type Box, type Finding, type PageJudgement } from "./rules.ts";
import { ORIGIN, SNAPSHOT_DIR, readFixtures, readSnapshot, serveSite, writeSnapshot } from "./serve.ts";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../..");
const CHROMIUM_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"];

export const WIDTHS = [1280, 390] as const;

/** How far into its recording a HUD is judged, on the page's stepped clock. */
export const HUD_PLAY_MS = 10_000;

/**
 * A surface: a page of the site, or a page that may show a match HUD over a board (hud). On a HUD surface the client's
 * animation clock (performance.now, web/src/clock.ts) is the check's: it stands still except when the check steps
 * it, so the HUD shows one fixed moment while it is judged and its renders are saved, and the 3D board never measures
 * itself too slow in a software renderer and reloads as 2D. The replay also loads with capture=1 (as web/capture
 * does), so its board draws only when the check steps it.
 */
export interface Surface { id: string; url: string; hud: boolean; what: string }

/**
 * The public Free-for-all recording the replay surface plays, so the four-colony HUD (the Score Band) is rendered:
 * 17 Nov 2026 08:55 UTC, four colonies on Strait, served at https://antwars.ai/?replay=<id>.
 */
export const FREE_FOR_ALL_REPLAY = "2026-11-17T08-55-08-583Z-151632020035470";

export const SURFACES: readonly Surface[] = [
  { id: "landing", url: "/", hud: false, what: "the front page" },
  // Not capture=1: on Watch that also changes what the page shows with no live match.
  { id: "watch", url: "/?watch=1", hud: true, what: "Watch with no live match (fixture: no live match)" },
  { id: "matches", url: "/?page=matches", hud: false, what: "the Matches page (all recordings)" },
  { id: "leaderboard", url: "/?page=leaderboard", hud: false, what: "the Leaderboard" },
  { id: "rules", url: "/rules", hud: false, what: "the Rules page, as the server renders it before a map is drawn" },
  { id: "replay-free-for-all", url: `/?replay=${FREE_FOR_ALL_REPLAY}&capture=1`, hud: true, what: "a Free-for-all replay: the match HUD (Score Band) over the board" },
];

const viewport = (width: number) => width < 600
  ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
  : { viewport: { width, height: 800 }, deviceScaleFactor: 1 };

/** Every scroll position back at the top: the state the page is judged in. */
const scrollHome = (page: Page) => page.evaluate(() => {
  scrollTo(0, 0);
  for (const e of document.querySelectorAll("*")) if (e.scrollTop || e.scrollLeft) { e.scrollTop = 0; e.scrollLeft = 0; }
});

/**
 * Let the page fetch and lay out its data (a HUD: play its recording to HUD_PLAY_MS). The page is then scrolled
 * through once, and so is every box that scrolls inside it, so lazy parts render before it is judged; then
 * everything is scrolled back to the top.
 */
async function settle(page: Page, surface: Surface): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  if (surface.hud) {
    await page.waitForFunction(() => window.__antwar?.ready !== undefined, undefined, { timeout: 30_000 });
    // A page that draws no board may never settle ready; 30 s without a board is a page with none.
    const board = await page.evaluate(() => Promise.race([window.__antwar.ready.then(() => true, () => false),
      new Promise<boolean>(res => setTimeout(() => res(false), 30_000))]));
    // Play the recording to HUD_PLAY_MS in 100 ms steps of the page's clock, yielding only while its download catches
    // up, then draw that one frame. Nothing moves after it. (A page with no board, such as Watch showing a list,
    // has nothing to play.)
    if (board) {
      await page.evaluate(async playMs => {
        const clock = window as unknown as { __replayTime: number };
        for (let t = 0; t < playMs; t += 100) {
          const r = window.__antwar.recording();
          if (r?.error) throw new Error(r.error);
          for (let wait = 0; r && !r.complete && r.stats.bufferedMessages < 3 && wait < 200; wait++) await new Promise(res => setTimeout(res, 0));
          clock.__replayTime += 100;
          window.__antwar.frame(false);
        }
        window.__antwar.frame();
      }, HUD_PLAY_MS);
    }
  }
  await page.waitForTimeout(1_500);
  await page.evaluate(async () => {
    const pause = () => new Promise(r => setTimeout(r, 120));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) { scrollTo(0, y); await pause(); }
    for (const e of document.querySelectorAll("*")) {
      if (!/auto|scroll/.test(getComputedStyle(e).overflowY) || e.scrollHeight <= e.clientHeight) continue;
      for (let y = 0; y < e.scrollHeight; y += Math.max(e.clientHeight, 100)) { e.scrollTop = y; await pause(); }
    }
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  await scrollHome(page);
}

interface Mark { box: Box; anchor: NonNullable<Finding["anchor"]>; label: string; held: boolean }

/**
 * The marked renders of the layout exactly as judged. The viewport never changes size: the first render is the
 * surface as it opens; each further one scrolls the first finding not yet shown into view (scrolling moves the
 * judged layout, it does not lay it out again) and outlines every finding then in view. Returns the renders saved
 * and, for each mark, the render that shows it.
 */
async function shoot(page: Page, marks: Mark[], base: string, out: string): Promise<{ images: string[]; shownIn: string[] }> {
  const images: string[] = [];
  const shownIn: string[] = Array.from({ length: marks.length }, () => "");
  const MAX_RENDERS = 24;
  for (let target = -1; images.length < MAX_RENDERS; ) {
    if (target >= 0) {
      await page.evaluate(m => (window as unknown as { __renderCheckAnchors: Element[] }).__renderCheckAnchors[m.anchor.index]!
        .scrollIntoView({ block: "center", inline: "nearest" }), marks[target]!);
    }
    const inView: boolean[] = await page.evaluate(ms => {
      document.querySelector("[data-render-check-marks]")?.remove();
      const anchors = (window as unknown as { __renderCheckAnchors: Element[] }).__renderCheckAnchors;
      const layer = document.createElement("div");
      layer.setAttribute("data-render-check", "skip");
      layer.setAttribute("data-render-check-marks", "");
      layer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none";
      const seen = ms.map(m => {
        const r = anchors[m.anchor.index]!.getBoundingClientRect();
        const x = r.left + m.anchor.dx, y = r.top + m.anchor.dy, w = Math.max(m.box.w, 2), h = Math.max(m.box.h, 2);
        const d = document.createElement("div");
        const colour = m.held ? "#f5a623" : "#ff1744";
        d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;outline:2px solid ${colour};background:${colour}22`;
        const tag = document.createElement("span");
        tag.textContent = m.label;
        tag.style.cssText = `position:absolute;left:0;top:-14px;font:10px/12px monospace;color:#fff;background:${colour};padding:0 2px;white-space:nowrap`;
        d.append(tag);
        layer.append(d);
        return x < innerWidth && x + w > 0 && y < innerHeight && y + h > 0;
      });
      document.body.append(layer);
      return seen;
    }, marks);
    const image = `${base}${images.length ? `-${images.length + 1}` : ""}.png`;
    await page.screenshot({ path: join(out, image) });
    images.push(image);
    inView.forEach((v, i) => { if (v && !shownIn[i]) shownIn[i] = image; });
    // A finding that scrolling cannot bring into view (off the screen of a HUD) is shown where it was tried.
    if (target >= 0 && !shownIn[target]) shownIn[target] = image;
    target = shownIn.findIndex(s => !s);
    if (target < 0) break;
  }
  for (let i = 0; i < shownIn.length; i++) if (!shownIn[i]) shownIn[i] = images[0]!;
  await page.evaluate(() => document.querySelector("[data-render-check-marks]")?.remove());
  await scrollHome(page);
  return { images, shownIn };
}

/** The findings that must be identical on the layout saved and the layout judged. */
const fingerprint = (j: PageJudgement) => j.failures.map(f => [f.rule, f.element, f.text, f.extent].join("|")).sort().join("\n");

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
        if (surface.hud) {
          await page.addInitScript(() => {
            const clock = window as unknown as { __replayTime: number };
            clock.__replayTime = 0;
            Object.defineProperty(performance, "now", { value: () => clock.__replayTime });
          });
        }
        const pageErrors: string[] = [];
        page.on("pageerror", e => pageErrors.push(String(e.message ?? e)));
        const base = `renders/${surface.id}-${width}-${typefaceSlug(typeface)}`;
        const invalid: string[] = [];
        let judged: PageJudgement = { failures: [], tight: [], counted: { items: 0, grids: 0, tiles: 0 } };
        let fonts: Record<string, number> = {};
        let images: string[] = [];
        let failureImages: string[] = [];
        try {
          await page.goto(ORIGIN + surface.url, { waitUntil: "load", timeout: 30_000 });
          await settle(page, surface);
          judged = await page.evaluate(judgePage, RULE_LIMITS);
          fonts = await drawnFonts(page);
          const wrongFont = fontProblem(typeface, fonts);
          if (wrongFont) invalid.push(wrongFont);
          if (judged.counted.items === 0) invalid.push("the page laid out no text to judge");
          // Marked as held when the held list has this rule on this element and text; the verdict decides by extent.
          const heldAt = new Set(held.held.filter(h => h.surface === surface.id && h.width === width && h.typeface === typeface)
            .map(h => [h.rule, h.element, h.text].join("|")));
          const marked = judged.failures.flatMap((f, i) => f.box && f.anchor
            ? [{ i, mark: { box: f.box, anchor: f.anchor, label: `${f.rule}: ${f.measure}`, held: heldAt.has([f.rule, f.element, f.text].join("|")) } }] : []);
          const shot = await shoot(page, marked.map(m => m.mark), base, o.out);
          images = shot.images;
          failureImages = judged.failures.map(() => images[0]!);
          marked.forEach((m, k) => { failureImages[m.i] = shot.shownIn[k]!; });
          // The renders show the layout judged: judged again after they are saved, it finds the same.
          if (fingerprint(await page.evaluate(judgePage, RULE_LIMITS)) !== fingerprint(judged)) {
            invalid.push("the layout changed while its renders were saved");
          }
        } catch (error) {
          invalid.push(`did not render: ${(error as Error).message.split("\n")[0]}`);
          images = [`${base}.png`];
          failureImages = judged.failures.map(() => images[0]!);
          await page.screenshot({ path: join(o.out, images[0]!) }).catch(() => undefined);
        }
        if (served.unanswered.length) invalid.push(`requests outside the snapshot and fixtures: ${[...new Set(served.unanswered)].join(", ")}`);
        renders.push({ surface: surface.id, url: surface.url, width, typeface, failures: judged.failures, tight: judged.tight, images, failureImages, fonts, invalid, pageErrors, fixtures: [...served.fixturesUsed] });
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
