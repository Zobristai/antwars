/**
 * Render check: renders every surface of a built site at 1280, 390 and 320 px, at default (16 px) and doubled
 * (32 px browser default) text, in Roboto and in Liberation Sans, and judges each render by the in-page rules
 * (rules.ts). Data comes only from the committed snapshot and labelled fixtures (serve.ts). A failure fails the run
 * unless the reviewed held list (held.json) already holds it.
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
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { renderRules, rulesAssets } from "../rules.ts";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, TYPEFACES, applyTextSize, drawnFonts, fontProblem, fontconfigFor, rootFontSize, textSizeProblem, typefaceSlug, type TextSize } from "./fonts.ts";
import { heldFrom, judge, publish, readHeld, type Render } from "./report.ts";
import { RULE_LIMITS, judgePage, type Box, type Finding, type PageJudgement } from "./rules.ts";
import { ORIGIN, SNAPSHOT_DIR, readFixtures, readSnapshot, serveSite, writeSnapshot } from "./serve.ts";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "../..");
const CHROMIUM_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"];

export const WIDTHS = [1280, 390, 320] as const;
export { DEFAULT_TEXT_SIZE, TEXT_SIZES, type TextSize };

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
  /** Fixtures this surface alone answers with (a file beside this one), over the shared ones. Every surface runs with
   * the page's wall clock fixed at the snapshot's time, so derived times and "Loaded HH:MM UTC" labels never vary. */
  fixtures?: string;
  /** The surface exists to show a match HUD over a board (a replay): if its board never becomes ready, the HUD was
   * never judged and the render is invalid. Watch with no live match shows a list instead and leaves this unset. */
  board?: boolean;
  /** The window widths it is rendered at (default WIDTHS). */
  widths?: readonly number[];
  /** The browser default text sizes (px) it is rendered at (default TEXT_SIZES). */
  textSizes?: readonly TextSize[];
  /** Browser zoom, as Chrome lays out page zoom: the window keeps its size in device pixels, the page lays out in a
   * viewport that many times smaller, drawn at that many device pixels a CSS pixel. */
  zoom?: number;
  /** An element (CSS selector) focused from the keyboard once the page has settled, so its focus ring is judged and
   * rendered. A render where it is missing or does not show focus as keyboard focus is invalid. */
  focus?: string;
  /** What this browser remembers for the site (its local storage), set before the page loads. */
  storage?: Readonly<Record<string, string>>;
}

/**
 * The public Free-for-all recording the replay surface plays, so the four-colony HUD (the Score Band) is rendered:
 * 17 Nov 2026 08:55 UTC, four colonies on Strait, served at https://antwars.ai/?replay=<id>.
 */
export const FREE_FOR_ALL_REPLAY = "2026-11-17T08-55-08-583Z-151632020035470";

/**
 * The public recording the grouped-seat replay surface plays, so the Score Band shows grouped seats: 16 Nov 2026 09:21 UTC,
 * an Index 2v2 in which one player holds both seats of each colony, its seat badges in one head per colony.
 */
export const GROUPED_SEATS_REPLAY = "2026-11-16T09-21-43-735Z-11240848029112";

/** The recordings surfaces' focused element: the first recording's Replay link. */
const RECORDINGS_FOCUS = ".d1p-rec-rows > li:first-child .d1p-rec-replay";

export const SURFACES: readonly Surface[] = [
  { id: "landing", url: "/", hud: false, what: "the front page" },
  // Not capture=1: on Watch that also changes what the page shows with no live match.
  { id: "watch", url: "/?watch=1", hud: true, what: "Watch with no live match (fixture: no live match), its top matches' results hidden as a visitor first sees them" },
  { id: "watch-results-shown", url: "/?watch=1", hud: true, what: "Watch with no live match (fixture: no live match), in a browser that chose to show the top matches' results", storage: { "aw.topMatches.showResults": "true" } },
  { id: "matches", url: "/?page=matches", hud: false, what: "the Matches page (all recordings)" },
  { id: "waiting", url: "/?page=matches", hud: false, what: "the Matches page with agents waiting and matches live (fixture: Waiting and Live now rows)", fixtures: "waiting-fixture.json" },
  { id: "recordings", url: "/?page=matches", hud: false, what: "the Matches page with a Recordings list of the cases the snapshot lacks (fixture: a sample Scripted bot win in Lake Skinner; snapshot rows), its first Replay link focused", fixtures: "recordings-fixture.json", focus: RECORDINGS_FOCUS },
  { id: "recordings-zoom-200", url: "/?page=matches", hud: false, what: "the recordings surface in a 1280 px window at 200 % browser zoom", fixtures: "recordings-fixture.json", focus: RECORDINGS_FOCUS, widths: [1280], textSizes: [DEFAULT_TEXT_SIZE], zoom: 2 },
  { id: "recordings-zoom-400", url: "/?page=matches", hud: false, what: "the recordings surface in a 1280 px window at 400 % browser zoom", fixtures: "recordings-fixture.json", focus: RECORDINGS_FOCUS, widths: [1280], textSizes: [DEFAULT_TEXT_SIZE], zoom: 4 },
  { id: "leaderboard", url: "/?page=leaderboard", hud: false, what: "the Leaderboard" },
  { id: "rules", url: "/rules", hud: false, what: "the Rules page, as the server renders it before a map is drawn" },
  { id: "replay-free-for-all", url: `/?replay=${FREE_FOR_ALL_REPLAY}&capture=1`, hud: true, board: true, what: "a Free-for-all replay: the match HUD (Score Band) over the board" },
  { id: "replay-grouped-seats", url: `/?replay=${GROUPED_SEATS_REPLAY}&capture=1`, hud: true, board: true, what: "a 2v2 replay where one player holds both seats of each colony: the Score Band's grouped seat badges over the board" },
];

/** The browser context of a window `width` px wide, at a browser zoom of `zoom` (Surface.zoom). Phone screens
 * (width < 600) render at 2× device scale so subpixel text layout matches real phones rather than 1× integer hinting. */
export const viewport = (width: number, zoom = 1) => width < 600
  ? { viewport: { width: Math.round(width / zoom), height: Math.round(844 / zoom) }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 * zoom }
  : { viewport: { width: Math.round(width / zoom), height: Math.round(800 / zoom) }, deviceScaleFactor: zoom };

/** Return scrollable boxes to their start without disturbing clipping boxes, then let scroll events and the
 * animation-frame work they schedule finish before judging the layout. */
export const scrollHome = (page: Page) => page.evaluate(async () => {
  scrollTo(0, 0);
  for (const e of document.querySelectorAll("*")) {
    if (!e.scrollTop && !e.scrollLeft) continue;
    const cs = getComputedStyle(e);
    if (/auto|scroll/.test(cs.overflowY)) e.scrollTop = 0;
    if (/auto|scroll/.test(cs.overflowX)) e.scrollLeft = 0;
  }
  // A scroll event can schedule work for the next animation frame. Cross both frame boundaries rather than
  // racing that callback when the page is judged or using a time-based sleep.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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

/**
 * Wait for a Watch page (which may show either a live board or the top-matches list) to settle: resolves with
 * BoardReadiness if its board becomes ready or rejects, or null as soon as the top-matches list (#aw-top-matches-page)
 * mounts so a no-live-match render does not wait 30 s for a board that will not load.
 */
export async function watchReadiness(page: Page, timeoutMs = 30_000): Promise<BoardReadiness | null> {
  return page.evaluate(ms => new Promise<BoardReadiness | null>(res => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    const done = (v: BoardReadiness | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      res(v);
    };
    if (document.getElementById("aw-top-matches-page")) { done(null); return; }
    observer = new MutationObserver(() => {
      if (document.getElementById("aw-top-matches-page")) done(null);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__antwar.ready.then(
      () => done({ state: "ready" }),
      (e: unknown) => done({ state: "rejected", reason: String((e as Error)?.message ?? e) }),
    );
    timer = setTimeout(() => done({ state: "timed out", ms }), ms);
  }), timeoutMs);
}

/** What playing a replay's recording to HUD_PLAY_MS showed: how far its board got, and whether its HUD is on screen. */
export interface Playback {
  /** The first tick the board showed while playing (the recording's own first tick, not tick 0), from the client's own frame. */
  startTick: number;
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
 * board. It must become ready, play its recording past the tick it began at without error, and show its HUD.
 */
export function boardProblem(surface: Pick<Surface, "board">, readiness: BoardReadiness | null, playback: Playback | null): string | null {
  if (!surface.board) return null;
  const why = !readiness ? "the page never offered a board"
    : readiness.state === "rejected" ? `its board failed to load (${readiness.reason})`
    : readiness.state === "timed out" ? `its board was not ready after ${readiness.ms / 1000} s`
    : !playback ? "its recording was never played"
    : playback.error ? `its recording failed while playing (${playback.error})`
    : playback.playbackTick <= playback.startTick ? `its recording did not play: the board was still at its first tick (${playback.startTick}) after ${HUD_PLAY_MS / 1000} s`
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
async function settle(page: Page, surface: Surface, evidence: RenderEvidence): Promise<{ readiness: BoardReadiness | null; playback: Playback | null }> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  let readiness: BoardReadiness | null = null;
  let playback: Playback | null = null;
  if (surface.hud) {
    await page.waitForFunction(() => window.__antwar?.ready !== undefined, undefined, { timeout: 30_000 });
    // A page that draws no board (Watch showing the top-matches list) never resolves __antwar.ready; watchReadiness
    // returns null as soon as the list mounts instead of waiting out the 30 s board timeout. A surface that needs a
    // board (surface.board) waits on boardReadiness and is invalid if it never settles (boardProblem).
    readiness = surface.board ? await boardReadiness(page) : await watchReadiness(page);
    const board = readiness?.state === "ready";
    // Play the recording to HUD_PLAY_MS in 100 ms steps of the page's clock, yielding only while its download catches
    // up, then draw that one frame (again once what it loads has arrived). Nothing moves after it. (A page with no board, such as Watch showing a list,
    // has nothing to play.)
    if (board) playback = await playRecording(page, HUD_PLAY_MS, evidence);
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

/**
 * Resolves once the page has had no request in flight for quietMs, or after timeoutMs. Requests are counted from the
 * call of watchRequests, so start it before what may request.
 */
function watchRequests(page: Page): { settled(quietMs?: number, timeoutMs?: number): Promise<void> } {
  let inFlight = 0;
  let changed = Date.now();
  const start = () => { inFlight++; changed = Date.now(); };
  const end = () => { inFlight = Math.max(0, inFlight - 1); changed = Date.now(); };
  page.on("request", start); page.on("requestfinished", end); page.on("requestfailed", end);
  return {
    async settled(quietMs = 500, timeoutMs = 10_000) {
      try {
        for (const until = Date.now() + timeoutMs; Date.now() < until && (inFlight > 0 || Date.now() - changed < quietMs);) await page.waitForTimeout(50);
      } finally { page.off("request", start); page.off("requestfinished", end); page.off("requestfailed", end); }
    },
  };
}

/**
 * Play a ready replay to HUD_PLAY_MS (see settle) and report how far it got and whether its HUD is shown. What the
 * played frame loads (the HUD's icons, the board's shaders) is let finish before that frame is drawn again, at the same
 * moment, and judged.
 */
export async function playRecording(page: Page, playMs = HUD_PLAY_MS, evidence?: RenderEvidence): Promise<Playback> {
  const requests = watchRequests(page);
  const stepped = await page.evaluate(async ({ playMs }) => {
    const clock = window as unknown as { __replayTime: number };
    let error: string | null = null;
    let startTick: number | null = null;
    try {
      for (let t = 0; t < playMs && !error; t += 100) {
        const r = window.__antwar.recording();
        error = r?.error ?? null;
        for (let wait = 0; r && !r.complete && r.stats.bufferedMessages < 3 && wait < 200; wait++) await new Promise(res => setTimeout(res, 0));
        clock.__replayTime += 100;
        // An excerpt starts at its own tick (thousands into its match), not 0: playing means getting past the first
        // tick the board shows. The board shows a recording a few ticks behind its clock, so the first step still
        // shows that tick; a frame before any data (tick 0) does not count as it.
        const tick = window.__antwar.frame(false).playbackTick;
        if (startTick === null && tick > 0) startTick = tick;
      }
      window.__antwar.frame();
    } catch (e) { error = String((e as Error)?.message ?? e); }
    return { error, startTick };
  }, { playMs });
  await requests.settled();
  const played = await page.evaluate(async ({ stepped, hudRoot }) => {
    let { error } = stepped;
    let last = { playbackTick: 0, playbackMs: 0 };
    try {
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
    return { startTick: stepped.startTick ?? last.playbackTick, playbackTick: last.playbackTick, playbackMs: last.playbackMs, hud, error } satisfies Playback;
  }, { stepped, hudRoot: HUD_ROOT });
  if (evidence) {
    try { evidence.clipState = await captureClipState(page); }
    catch (error) { evidence.clipState = { unavailable: String(error) }; }
  }
  // Styles can still hide all or part of it (clip-path, mask, a clipping box, the board drawn over it): see hudOnScreen.
  return played.hud === "shown" ? { ...played, hud: await hudOnScreen(page, evidence) } : played;
}

export type HudOnScreen = "shown" | "not shown" | "clipped" | "screen not still";

/** Evidence kept only if the render is invalid; comparisons that never ran are explicitly absent. */
export interface RenderEvidence {
  clipState?: unknown;
  comparisons: { kind: "hidden" | "unclipped"; attempt: number; before?: Buffer; altered?: Buffer; after?: Buffer }[];
}

/** Geometry and clipping styles of the HUD and its ancestors, at the time playback is judged. */
export const captureClipState = (page: Page) => page.evaluate(hudRoot => {
  const root = document.querySelector(hudRoot);
  const measure = (e: Element) => {
    const cs = getComputedStyle(e), rect = e.getBoundingClientRect();
    return { element: `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${[...e.classList].map(c => `.${c}`).join("")}`,
      rect: rect.toJSON(), clientWidth: e.clientWidth, clientHeight: e.clientHeight, clientLeft: e.clientLeft,
      clientTop: e.clientTop, scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, scrollLeft: e.scrollLeft,
      scrollTop: e.scrollTop, overflowX: cs.overflowX, overflowY: cs.overflowY, clipPath: cs.clipPath,
      maskImage: cs.maskImage, clip: cs.clip, opacity: cs.opacity, visibility: cs.visibility };
  };
  const chain: object[] = [];
  for (let e = root; e; e = e.parentElement) chain.push(measure(e));
  // For a non-HUD or failed navigation, capture the page's clipping and scrolling boxes instead.
  const boxes = root ? [] : [...document.querySelectorAll("*")].filter(e => {
    const cs = getComputedStyle(e);
    return cs.overflowX !== "visible" || cs.overflowY !== "visible" || cs.clipPath !== "none" || cs.maskImage !== "none" || cs.clip !== "auto";
  }).map(measure);
  return { viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, rootFound: !!root, chain, boxes };
}, HUD_ROOT);

/** Write the comparisons that actually ran, including partial captures if a screenshot failed. */
export async function saveInvalidEvidence(out: string, id: string, invalid: string[], evidence: RenderEvidence): Promise<string> {
  const dir = join(out, "invalid-evidence");
  await mkdir(dir, { recursive: true });
  const comparisons = await Promise.all(evidence.comparisons.map(async ({ kind, attempt, before, altered, after }) => {
    const files: Record<string, string | null> = {};
    for (const [stage, data] of [["before", before], ["altered", altered], ["after", after]] as const) {
      const name = `${id}-${kind}-${attempt}-${stage}.png`;
      if (data) await writeFile(join(dir, name), data);
      files[stage] = data ? name : null;
    }
    return { kind, attempt, files };
  }));
  const ref = `invalid-evidence/${id}.json`;
  await writeFile(join(out, ref), JSON.stringify({ invalid, clipState: evidence.clipState, comparisons }, null, 2) + "\n");
  return ref;
}

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
export async function hudOnScreen(page: Page, evidence?: RenderEvidence): Promise<HudOnScreen> {
  const shot = () => page.screenshot({ animations: "disabled", caret: "hide" });
  const hidden = `:is(${HUD_ROOT}), :is(${HUD_ROOT}) * { visibility: hidden !important; }`;
  const noClip = "clip-path: none !important; mask: none !important; -webkit-mask: none !important; clip: auto !important;";
  const unclipped = `:is(${HUD_ROOT}), :has(:is(${HUD_ROOT})) { ${noClip} }`;
  /** Whether the screen is the same with css added, or "screen not still". */
  const sameWith = async (css: string): Promise<boolean | "screen not still"> => {
    for (let attempt = 0; attempt < HUD_COMPARE_TRIES; attempt++) {
      const comparison: RenderEvidence["comparisons"][number] = { kind: css === hidden ? "hidden" : "unclipped", attempt };
      evidence?.comparisons.push(comparison);
      const before = await shot();
      if (evidence) comparison.before = before;
      const style = await page.addStyleTag({ content: css });
      const altered = await shot();
      if (evidence) comparison.altered = altered;
      await style.evaluate(e => (e as Element).remove());
      const after = await shot();
      if (evidence) comparison.after = after;
      if (before.equals(after)) return before.equals(altered);
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

/** A bounded permit gate so software-rendered 3D replays stay capped while lightweight DOM surfaces run in parallel. */
function createGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(res => queue.push(res));
    active++;
    try { return await fn(); } finally {
      active--;
      queue.shift()?.();
    }
  };
}

async function renderAll(o: Options): Promise<Render[]> {
  const snapshot = await readSnapshot().catch(() => ({ recordedFrom: "https://antwars.ai", recordedAt: new Date().toISOString(), responses: {} }));
  const fixtures = await readFixtures([join(HERE, "fixtures.json"), ...o.fixtureFiles]);
  const surfaceFixtures = new Map(await Promise.all(o.surfaces.filter(s => s.fixtures)
    .map(async s => [s.id, { ...fixtures, ...await readFixtures([join(HERE, s.fixtures!)]) }] as const)));
  const manifest = JSON.parse(await readFile(join(o.dist, ".vite/manifest.json"), "utf8"));
  const rulesPage = () => renderRules(newMatchConfig(PUBLIC_CONFIG), { undrawn: true, assets: rulesAssets(manifest) });
  const held = await readHeld(o.heldFile).catch(() => ({ note: "", held: [] }));
  const fontRoot = join(o.out, ".fontconfig");
  await mkdir(join(o.out, "renders"), { recursive: true });
  const jobs: { width: number; textSize: TextSize; surface: Surface }[] = [];
  for (const width of WIDTHS) for (const textSize of TEXT_SIZES) for (const surface of o.surfaces) {
    if (!(surface.widths ?? WIDTHS).includes(width)) continue;
    if (!(surface.textSizes ?? TEXT_SIZES).includes(textSize)) continue;
    jobs.push({ width, textSize, surface });
  }
  const perBrowser = o.record ? 1 : Math.max(1, Math.min(2, Math.floor(availableParallelism() / TYPEFACES.length)));
  const renderTypeface = async (typeface: (typeof TYPEFACES)[number]): Promise<Render[]> => {
    const conf = await fontconfigFor(typeface, fontRoot);
    const out: Render[] = Array.from({ length: jobs.length });
    const boardGate = createGate(1);
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ executablePath: o.chrome, args: CHROMIUM_FLAGS, env: { ...process.env, FONTCONFIG_FILE: conf } });
      const activeBrowser = browser;
      let next = 0;
      const runJob = async ({ width, textSize, surface }: (typeof jobs)[number]): Promise<Render> => {
        const context = await activeBrowser.newContext({ ...viewport(width, surface.zoom), timezoneId: "UTC", locale: "en-GB", reducedMotion: "reduce" });
        let textSession: CDPSession | null = null;
        try {
          // Fix wall-clock Date to snapshot.recordedAt on every surface so "Loaded HH:MM UTC" and relative times never
          // drift by the current minute (timers and performance.now are unaffected).
          await context.clock.setFixedTime(new Date(snapshot.recordedAt));
          const served = await serveSite(context, { dist: o.dist, snapshot, fixtures: surfaceFixtures.get(surface.id) ?? fixtures, rulesPage, record: o.record });
          const page = await context.newPage();
          textSession = await applyTextSize(page, textSize);
          if (surface.storage) await page.addInitScript(stored => { for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value); }, surface.storage);
          if (surface.hud) {
            await page.addInitScript(() => {
              const clock = window as unknown as { __replayTime: number };
              clock.__replayTime = 0;
              Object.defineProperty(performance, "now", { value: () => clock.__replayTime });
            });
          }
          const pageErrors: string[] = [];
          page.on("pageerror", e => pageErrors.push(String(e.message ?? e)));
          const base = `renders/${surface.id}-${width}-${textSize}px-${typefaceSlug(typeface)}`;
          const invalid: string[] = [];
          const evidence: RenderEvidence = { comparisons: [] };
          let judged: PageJudgement = { failures: [], tight: [], counted: { items: 0, grids: 0, tiles: 0 } };
          let fonts: Record<string, number> = {};
          let images: string[] = [];
          let failureImages: string[] = [];
          let failureInView: boolean[] = [];
          try {
            await page.goto(ORIGIN + surface.url, { waitUntil: "load", timeout: 30_000 });
            const settled = await settle(page, surface, evidence);
            const wrongTextSize = textSizeProblem(textSize, await rootFontSize(page));
            if (wrongTextSize) invalid.push(wrongTextSize);
            const noBoard = boardProblem(surface, settled.readiness, settled.playback);
            if (noBoard) invalid.push(noBoard);
            if (surface.focus) {
              // Focused as the keyboard does, which scrolls it into view: the page is judged and rendered from there.
              const focused = await page.evaluate(selector => {
                const el = document.querySelector<HTMLElement>(selector);
                el?.focus();
                return !!el && el.matches(":focus-visible");
              }, surface.focus);
              if (!focused) invalid.push(`${surface.focus} was not shown with keyboard focus`);
            }
            judged = await page.evaluate(judgePage, RULE_LIMITS);
            fonts = await drawnFonts(page);
            const wrongFont = fontProblem(typeface, fonts);
            if (wrongFont) invalid.push(wrongFont);
            if (judged.counted.items === 0) invalid.push("the page laid out no text to judge");
            // Marked as held when the held list has this rule on this element and text; the verdict decides by extent.
            const heldAt = new Set(held.held.filter(h => h.surface === surface.id && h.width === width && h.textSize === textSize && h.typeface === typeface)
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
          let invalidEvidence: string | undefined;
          if (invalid.length) {
            if (evidence.clipState === undefined) {
              try { evidence.clipState = await captureClipState(page); }
              catch (error) { evidence.clipState = { unavailable: String(error) }; }
            }
            invalidEvidence = await saveInvalidEvidence(o.out, `${surface.id}-${width}-${textSize}px-${typefaceSlug(typeface)}`, invalid, evidence);
          }
          console.log(`${surface.id} ${width} ${textSize}px ${typeface}: ${judged.failures.length} failures, ${judged.tight.length} tight, ${judged.counted.items} items, ${judged.counted.grids} grids${invalid.length ? `; INVALID: ${invalid.join("; ")}` : ""}`);
          return { surface: surface.id, url: surface.url, width, textSize, typeface, failures: judged.failures, tight: judged.tight, images, failureImages, failureInView, fonts, invalid, ...(invalidEvidence ? { invalidEvidence } : {}), pageErrors, fixtures: [...served.fixturesUsed] };
        } finally {
          await textSession?.detach().catch(() => undefined);
          await context.close();
        }
      };
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          const job = jobs[i]!;
          out[i] = job.surface.board ? await boardGate(() => runJob(job)) : await runJob(job);
        }
      };
      await Promise.all(Array.from({ length: Math.min(perBrowser, jobs.length) }, worker));
      return out;
    } finally {
      await browser?.close();
    }
  };
  let renders: Render[];
  try {
    if (o.record) {
      renders = [];
      for (const typeface of TYPEFACES) renders.push(...await renderTypeface(typeface));
    } else {
      renders = (await Promise.all(TYPEFACES.map(renderTypeface))).flat();
    }
  } finally {
    if (o.record) await writeSnapshot(snapshot);
    await rm(fontRoot, { recursive: true, force: true });
  }
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
  const startedAt = Date.now();
  await rm(join(o.out, "renders"), { recursive: true, force: true });
  await rm(join(o.out, "invalid-evidence"), { recursive: true, force: true });
  const renders = await renderAll(o);
  const held = await readHeld(o.heldFile).catch(() => ({ note: "Failures already on main, reviewed. Only a failure not held here, or above its count, fails the check.", held: [] }));
  if (o.updateHeld) {
    await writeFile(o.heldFile, JSON.stringify(heldFrom(renders, held, "Already on main when this coverage was added to the render check."), null, 1) + "\n");
    console.log(`held list rewritten: ${o.heldFile}`);
  }
  const snapshot = await readSnapshot();
  const verdict = judge(renders, o.updateHeld ? await readHeld(o.heldFile) : held);
  await publish(o.out, verdict, renders, {
    build: values.label || process.env.GITHUB_SHA || o.dist,
    snapshot: `${snapshot.recordedFrom} recorded ${snapshot.recordedAt} (web/render-check/snapshot) plus labelled fixtures`,
  });
  console.log(`render check wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (!verdict.passed) process.exitCode = 1;
}

if (import.meta.main) await main();
export { SNAPSHOT_DIR };
