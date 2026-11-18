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
export interface Surface {
  id: string; url: string; hud: boolean; what: string;
  /** Fixtures this surface alone answers with (a file beside this one), over the shared ones; the page's clock is then
   * fixed at the snapshot's time, so the times it derives from them are the same on every run. */
  fixtures?: string;
  /** The surface exists to show a match HUD over a board (a replay): if its board never becomes ready, the HUD was
   * never judged and the render is invalid. Watch with no live match shows a list instead and leaves this unset. */
  board?: boolean;
}

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
  { id: "waiting", url: "/?page=matches", hud: false, what: "the Matches page with agents waiting and matches live (fixture: Waiting and Live now rows)", fixtures: "waiting-fixture.json" },
  { id: "leaderboard", url: "/?page=leaderboard", hud: false, what: "the Leaderboard" },
  { id: "rules", url: "/rules", hud: false, what: "the Rules page, as the server renders it before a map is drawn" },
  { id: "replay-free-for-all", url: `/?replay=${FREE_FOR_ALL_REPLAY}&capture=1`, hud: true, board: true, what: "a Free-for-all replay: the match HUD (Score Band) over the board" },
];

const viewport = (width: number) => width < 600
  ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
  : { viewport: { width, height: 800 }, deviceScaleFactor: 1 };

/** The page and every box that scrolls back at its start: the state the page is judged in. A box that clips without
 * scrolling (overflow hidden or clip) is left exactly as the page set it. */
const scrollHome = (page: Page) => page.evaluate(() => {
  scrollTo(0, 0);
  for (const e of document.querySelectorAll("*")) {
    if (!e.scrollTop && !e.scrollLeft) continue;
    const cs = getComputedStyle(e);
    if (/auto|scroll/.test(cs.overflowY)) e.scrollTop = 0;
    if (/auto|scroll/.test(cs.overflowX)) e.scrollLeft = 0;
  }
});

/** Where every box that clips without scrolling is scrolled to (the page can set it; the reader cannot). */
const clipOffsets = (page: Page) => page.evaluate(() => [...document.querySelectorAll("*")].flatMap((e, i) => {
  if (e === document.documentElement || e === document.body) return []; // the page's own scroll
  const cs = getComputedStyle(e);
  const top = /auto|scroll/.test(cs.overflowY) ? 0 : e.scrollTop, left = /auto|scroll/.test(cs.overflowX) ? 0 : e.scrollLeft;
  return top || left ? [`${i}:${e.tagName.toLowerCase()}.${[...e.classList].join(".")}@${top},${left}`] : [];
}).join(" "));

/** How a HUD page's board settled: ready, its readiness rejected (with the reason), or no answer in time. */
export type BoardReadiness = { state: "ready" } | { state: "rejected"; reason: string } | { state: "timed out"; ms: number };

/** Wait for a HUD page's board (window.__antwar.ready) to settle, for at most timeoutMs. */
export async function boardReadiness(page: Page, timeoutMs = 30_000): Promise<BoardReadiness> {
  return page.evaluate(ms => Promise.race([
    window.__antwar.ready.then((): BoardReadiness => ({ state: "ready" }),
      (e: unknown): BoardReadiness => ({ state: "rejected", reason: String((e as Error)?.message ?? e) })),
    new Promise<BoardReadiness>(res => setTimeout(() => res({ state: "timed out", ms }), ms))]), timeoutMs);
}

/** What playing a replay's recording to HUD_PLAY_MS showed: how far its board got, and whether its HUD is on screen. */
export interface Playback {
  /** The board's tick and playback time after the last step, from the client's own frame. */
  playbackTick: number; playbackMs: number;
  /**
   * The match HUD (.d1-hud or .d2-hud). "shown": in the page with a box of its own inside the viewport, not hidden by
   * display, visibility or opacity, hiding it changes the screen, and nothing clips it (hudOnScreen). "not shown":
   * any of the first four fails. "clipped": shown, but the HUD or an element containing it cuts part of it away.
   * "screen not still": the screen kept changing while it was compared, so it could not be judged.
   */
  hud: HudOnScreen;
  /** The recording's error while playing, if it reported one. */
  error: string | null;
}

/** The HUD root of either match HUD (web/src/ui/deck/hud.ts, web/src/ui/hud.ts). */
export const HUD_ROOT = ".d1-hud, .d2-hud";

/**
 * Why a render is invalid because its replay never showed a ready, playing HUD, or null: only a surface that needs a
 * board. It must become ready, play its recording past tick 0 without error, and show its HUD.
 */
export function boardProblem(surface: Pick<Surface, "board">, readiness: BoardReadiness | null, playback: Playback | null): string | null {
  if (!surface.board) return null;
  const why = !readiness ? "the page never offered a board"
    : readiness.state === "rejected" ? `its board failed to load (${readiness.reason})`
    : readiness.state === "timed out" ? `its board was not ready after ${readiness.ms / 1000} s`
    : !playback ? "its recording was never played"
    : playback.error ? `its recording failed while playing (${playback.error})`
    : playback.playbackTick <= 0 ? `its recording did not play: the board was still at tick 0 after ${HUD_PLAY_MS / 1000} s`
    : playback.hud === "screen not still" ? "the screen kept changing while its HUD was compared with and without it, so whether the HUD showed could not be judged"
    : playback.hud === "not shown" ? "no match HUD was shown over the board"
    : playback.hud === "clipped" ? "its match HUD was cut: the HUD or an element containing it clips part of it (clip-path, mask, clip or overflow)"
    : null;
  return why && `the replay never reached a ready, playing HUD, so its HUD was not judged: ${why}`;
}

/**
 * Let the page fetch and lay out its data (a HUD: play its recording to HUD_PLAY_MS). The page is then scrolled
 * through once, and so is every box that scrolls inside it, so lazy parts render before it is judged; then
 * everything is scrolled back to the top.
 */
async function settle(page: Page, surface: Surface): Promise<{ readiness: BoardReadiness | null; playback: Playback | null }> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  let readiness: BoardReadiness | null = null;
  let playback: Playback | null = null;
  if (surface.hud) {
    await page.waitForFunction(() => window.__antwar?.ready !== undefined, undefined, { timeout: 30_000 });
    // A page that draws no board (Watch showing a list) may never settle ready; a surface that needs one
    // (surface.board) is then invalid (boardProblem).
    readiness = await boardReadiness(page);
    const board = readiness.state === "ready";
    // Play the recording to HUD_PLAY_MS in 100 ms steps of the page's clock, yielding only while its download catches
    // up, then draw that one frame. Nothing moves after it. (A page with no board, such as Watch showing a list,
    // has nothing to play.)
    if (board) playback = await playRecording(page);
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
  return { readiness, playback };
}

/** Play a ready replay to HUD_PLAY_MS (see settle) and report how far it got and whether its HUD is shown. */
export async function playRecording(page: Page, playMs = HUD_PLAY_MS): Promise<Playback> {
  const played = await page.evaluate(async ({ playMs, hudRoot }) => {
    const clock = window as unknown as { __replayTime: number };
    let error: string | null = null;
    let last = { playbackTick: 0, playbackMs: 0 };
    try {
      for (let t = 0; t < playMs && !error; t += 100) {
        const r = window.__antwar.recording();
        error = r?.error ?? null;
        for (let wait = 0; r && !r.complete && r.stats.bufferedMessages < 3 && wait < 200; wait++) await new Promise(res => setTimeout(res, 0));
        clock.__replayTime += 100;
        window.__antwar.frame(false);
      }
      last = window.__antwar.frame();
      error ??= window.__antwar.recording()?.error ?? null;
    } catch (e) { error = String((e as Error)?.message ?? e); }
    const root = document.querySelector(hudRoot);
    const box = root?.getBoundingClientRect();
    // A box alone is not enough: visibility:hidden or opacity:0 (on the HUD or an ancestor) keeps the box but shows
    // nothing, and a HUD moved off screen (by position or transform) keeps it too. The HUD overlays the board, so its
    // box must lie inside the viewport, which it fills on both match HUDs.
    const visible = !!root && root.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const onScreen = !!box && box.width > 0 && box.height > 0
      && box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    // A container that clips its overflow (below html and body, whose overflow is the viewport's) must hold the HUD's
    // whole box. Measured, not lifted: changing a container's overflow lays it out again.
    let cutByContainer = false;
    for (let e = root?.parentElement; box && e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const c = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const left = r.left + e.clientLeft, top = r.top + e.clientTop;
      if (c.overflowX !== "visible" && (box.left < left - 1 || box.right > left + e.clientWidth + 1)) cutByContainer = true;
      if (c.overflowY !== "visible" && (box.top < top - 1 || box.bottom > top + e.clientHeight + 1)) cutByContainer = true;
    }
    const hud = !(visible && onScreen) ? "not shown" : cutByContainer ? "clipped" : "shown";
    return { playbackTick: last.playbackTick, playbackMs: last.playbackMs, hud, error } satisfies Playback;
  }, { playMs, hudRoot: HUD_ROOT });
  // Styles can still hide all or part of it (clip-path, mask, a clipping box, the board drawn over it): see hudOnScreen.
  return played.hud === "shown" ? { ...played, hud: await hudOnScreen(page) } : played;
}

export type HudOnScreen = "shown" | "not shown" | "clipped" | "screen not still";

/**
 * What the screen shows of the match HUD, by comparing it with two altered screens:
 * - with the HUD (HUD_ROOT and everything in it) hidden: if the screen is the same, the HUD painted nothing;
 * - with every clip-path, mask and clip lifted from the HUD and the elements containing it: if the screen changes, one
 *   cut part of it. (A container's overflow clipping is measured in playRecording instead.)
 * Nothing else may change between the shots: animation frames are held for the comparison (and run afterwards), CSS
 * animations are stopped, and the unaltered shot is taken again after each altered one. If those two differ,
 * something other than the HUD moved; that comparison is tried again, and after HUD_COMPARE_TRIES it is
 * "screen not still".
 */
export async function hudOnScreen(page: Page): Promise<HudOnScreen> {
  const shot = () => page.screenshot({ animations: "disabled", caret: "hide" });
  const hidden = `:is(${HUD_ROOT}), :is(${HUD_ROOT}) * { visibility: hidden !important; }`;
  const noClip = "clip-path: none !important; mask: none !important; -webkit-mask: none !important; clip: auto !important;";
  const unclipped = `:is(${HUD_ROOT}), :has(:is(${HUD_ROOT})) { ${noClip} }`;
  /** Whether the screen is the same with css added, or "screen not still". */
  const sameWith = async (css: string): Promise<boolean | "screen not still"> => {
    for (let attempt = 0; attempt < HUD_COMPARE_TRIES; attempt++) {
      const before = await shot();
      const style = await page.addStyleTag({ content: css });
      const altered = await shot();
      await style.evaluate(e => (e as Element).remove());
      if (before.equals(await shot())) return before.equals(altered);
    }
    return "screen not still";
  };
  await page.evaluate(() => {
    const w = window as unknown as { __heldFrames?: { run: typeof requestAnimationFrame; queued: FrameRequestCallback[] } };
    if (w.__heldFrames) return;
    const held = { run: window.requestAnimationFrame.bind(window), queued: [] as FrameRequestCallback[] };
    w.__heldFrames = held;
    window.requestAnimationFrame = cb => { held.queued.push(cb); return 0; };
  });
  try {
    await page.waitForTimeout(100); // frames already requested run once, and request the next from the held queue
    const withoutHud = await sameWith(hidden);
    if (withoutHud !== false) return withoutHud === true ? "not shown" : withoutHud;
    const withoutClips = await sameWith(unclipped);
    return withoutClips === true ? "shown" : withoutClips === false ? "clipped" : withoutClips;
  } finally {
    await page.evaluate(() => {
      const w = window as unknown as { __heldFrames?: { run: typeof requestAnimationFrame; queued: FrameRequestCallback[] } };
      const held = w.__heldFrames;
      if (!held) return;
      delete w.__heldFrames;
      window.requestAnimationFrame = held.run;
      for (const cb of held.queued) held.run(cb);
    });
  }
}

/** How many times hudOnScreen tries one comparison before it gives up on a screen that moves. */
export const HUD_COMPARE_TRIES = 3;

export interface Mark { box: Box; anchor: NonNullable<Finding["anchor"]>; label: string; held: boolean }

/**
 * The marked renders of the layout exactly as judged. The viewport never changes size: the first render is the
 * surface as it opens; each further one scrolls the first finding not yet shown into view (scrolling moves the
 * judged layout, it does not lay it out again) and outlines every finding then in view. There is no limit on the
 * renders: every finding is rendered in view, however many positions that takes. Returns the renders saved and, for
 * each mark, the render that shows it, and whether it is in view there: a finding no scrolling can bring into view
 * (past the edge of a fixed HUD) is reported with the render where scrolling stopped, said to be outside it.
 */
export async function shoot(page: Page, marks: Mark[], base: string, out: string): Promise<{ images: string[]; shownIn: string[]; inView: boolean[]; marksMoved: string | null; clipScrolled: string | null }> {
  const images: string[] = [];
  let marksMoved: string | null = null;
  let clipScrolled: string | null = null;
  const judgedClips = await clipOffsets(page);
  const shownIn: string[] = Array.from({ length: marks.length }, () => "");
  const seenInView: boolean[] = marks.map(() => false);
  // Each pass after the first renders the first finding not yet shown, so this ends after at most one pass per finding.
  for (let target = -1; ; ) {
    if (target >= 0) {
      // Bring the finding into view the way a reader can: by scrolling the boxes that scroll (and the page), never a box
      // that clips (overflow hidden or clip), whose cut is the finding. scrollIntoView would scroll those too.
      await page.evaluate(m => {
        const el = (window as unknown as { __renderCheckAnchors: Element[] }).__renderCheckAnchors[m.anchor.index]!;
        const centre = () => { const r = el.getBoundingClientRect(); return { x: r.left + m.anchor.dx + m.box.w / 2, y: r.top + m.anchor.dy + m.box.h / 2 }; };
        for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
          const cs = getComputedStyle(a), b = a.getBoundingClientRect();
          if (/auto|scroll/.test(cs.overflowY) && a.scrollHeight > a.clientHeight) a.scrollTop += centre().y - (b.top + a.clientHeight / 2);
          if (/auto|scroll/.test(cs.overflowX) && a.scrollWidth > a.clientWidth) a.scrollLeft += centre().x - (b.left + a.clientWidth / 2);
        }
        scrollBy(0, centre().y - innerHeight / 2);
      }, marks[target]!);
    }
    const drawn = await page.evaluate(ms => {
      document.querySelector("[data-render-check-marks]")?.remove();
      const anchors = (window as unknown as { __renderCheckAnchors: Element[] }).__renderCheckAnchors;
      // The page's size as laid out, which the marks must not change.
      const size = () => [innerWidth, innerHeight, visualViewport?.width, document.documentElement.clientWidth,
        document.documentElement.scrollWidth, document.documentElement.scrollHeight].join(" × ");
      const before = size();
      // Fixed to the viewport, clipped to it and contained: the layer adds nothing to the page's scrollable size, so
      // a mark past the edge cannot widen a phone's layout viewport.
      const layer = document.createElement("div");
      layer.setAttribute("data-render-check", "skip");
      layer.setAttribute("data-render-check-marks", "");
      layer.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;overflow:hidden;contain:strict;z-index:2147483647;pointer-events:none";
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
      const after = size();
      return { seen, moved: after === before ? null : `${before} before the marks, ${after} with them` };
    }, marks);
    const inView = drawn.seen;
    marksMoved ??= drawn.moved;
    const image = `${base}${images.length ? `-${images.length + 1}` : ""}.png`;
    await page.screenshot({ path: join(out, image) });
    // The render must show every clipping box as judged.
    const offsets = await clipOffsets(page);
    if (offsets !== judgedClips) clipScrolled ??= `judged at [${judgedClips || "none scrolled"}], rendered at [${offsets || "none scrolled"}]`;
    images.push(image);
    inView.forEach((v, i) => { if (v && !shownIn[i]) { shownIn[i] = image; seenInView[i] = true; } });
    // A finding that scrolling cannot bring into view (off the screen of a HUD) is shown where it was tried.
    if (target >= 0 && !shownIn[target]) shownIn[target] = image;
    target = shownIn.findIndex(s => !s);
    if (target < 0) break;
  }
  await page.evaluate(() => document.querySelector("[data-render-check-marks]")?.remove());
  await scrollHome(page);
  return { images, shownIn, inView: seenInView, marksMoved, clipScrolled };
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
  const surfaceFixtures = new Map(await Promise.all(o.surfaces.filter(s => s.fixtures)
    .map(async s => [s.id, { ...fixtures, ...await readFixtures([join(HERE, s.fixtures!)]) }] as const)));
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
        if (surface.fixtures) await context.clock.setFixedTime(new Date(snapshot.recordedAt));
        const served = await serveSite(context, { dist: o.dist, snapshot, fixtures: surfaceFixtures.get(surface.id) ?? fixtures, rulesPage, record: o.record });
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
        let failureInView: boolean[] = [];
        try {
          await page.goto(ORIGIN + surface.url, { waitUntil: "load", timeout: 30_000 });
          const settled = await settle(page, surface);
          const noBoard = boardProblem(surface, settled.readiness, settled.playback);
          if (noBoard) invalid.push(noBoard);
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
          if (shot.marksMoved) invalid.push(`the marks changed the page's size: ${shot.marksMoved}`);
          if (shot.clipScrolled) invalid.push(`a box that clips was scrolled while its renders were saved: ${shot.clipScrolled}`);
          failureImages = judged.failures.map(() => images[0]!);
          // A finding with no box (a page wider than the viewport) is about the whole page: its render is the first.
          failureInView = judged.failures.map(() => true);
          marked.forEach((m, k) => { failureImages[m.i] = shot.shownIn[k]!; failureInView[m.i] = shot.inView[k]!; });
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
        renders.push({ surface: surface.id, url: surface.url, width, typeface, failures: judged.failures, tight: judged.tight, images, failureImages, failureInView, fonts, invalid, pageErrors, fixtures: [...served.fixturesUsed] });
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
