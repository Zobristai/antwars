/**
 * Launches the spectator client for capture on a machine with no GPU: Playwright's
 * headless shell with SwiftShader WebGL (never --disable-gpu), the built client
 * (web/dist) and recordings (out/recordings) served from disk through request
 * routing (no server), the
 * bench's real-time source saved BEFORE page.clock.install, and the clock
 * paused so time only moves when the capture tool steps it.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.ts";
import { renderRules } from "../rules.ts";
import type { ClientInfo, FrameResult, SceneOptions } from "../src/main.ts";
import type { Rect } from "../src/words.ts";
import { scale2Packets, storedHistory, storedRecording, type StoredRecording } from "./scale2-recording.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const OUT_DIR = join(REPO_ROOT, "out");
export const WEB_DIR = join(REPO_ROOT, "web/dist");
export const RECORDING_DIR = join(OUT_DIR, "recordings");
export const HEADLESS_SHELL =
  process.env.HEADLESS_SHELL ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell");
export const CHROMIUM_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
export const REQUIRED_RENDERER = "SwiftShader";
// localhost is a secure context (crypto.subtle for frame hashes); every request is answered by the route below.
const ORIGIN = "http://localhost:4718";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".bin": "application/octet-stream",
};

/**
 * Readers for the two client members window.__antwar.boardArea() and frameTimes(), that also read a
 * build from before them (9c689f1 and older), which a script loads through --dist, --baseline-dist or a live origin.
 * Each tests for the member when called, so after the script's own readiness wait; without window.__antwar they throw
 * as a direct call does.
 * - boardArea on an older build: the mounted HUD's window by that HUD's own rule at 9c689f1. The 3D deck (ui/deck/hud.ts
 *   230-235) clamps the window's top below the legend; the 2D and no-board HUD (ui/hud.ts 703-708) takes the lane off
 *   its bottom. Either falls back to the whole screen; so does no HUD, as Overlays.area() does.
 * - frameTimes on an older build: the ?frametime=1 readout element, .aw-frametimes, the base scripts read.
 */
export interface CaptureReaders {
  boardArea(): Rect;
  frameTimes(): string | null;
}

declare global {
  interface Window {
    __antwarCapture: CaptureReaders;
  }
}

/** Installed as an init script, so it is serialized: it may use nothing outside its own body. */
function installCaptureReaders(): void {
  const api = () => {
    if (!window.__antwar) throw new TypeError("window.__antwar is undefined");
    return window.__antwar;
  };
  const whole = () => ({ x0: 0, y0: 0, x1: window.innerWidth, y1: window.innerHeight });
  window.__antwarCapture = {
    boardArea() {
      const a = api();
      if (typeof a.boardArea === "function") return a.boardArea();
      const deck = document.querySelector(".d1-window");
      if (deck) {
        const r = deck.getBoundingClientRect();
        const top = Math.max(r.top, document.querySelector(".d1-legend")!.getBoundingClientRect().bottom);
        return r.width > 0 && r.bottom - top > 0 ? { x0: r.left, y0: top, x1: r.right, y1: r.bottom } : whole();
      }
      const hole = document.querySelector(".d2-window");
      if (hole) {
        const r = hole.getBoundingClientRect();
        const laneH = document.querySelector(".d2-lane")!.getBoundingClientRect().height;
        return r.width > 0 && r.height > laneH ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom - laneH } : whole();
      }
      return whole();
    },
    frameTimes() {
      const a = api();
      if (typeof a.frameTimes === "function") return a.frameTimes();
      return document.querySelector(".aw-frametimes")?.textContent ?? null;
    },
  };
}

/** Give every page of the context window.__antwarCapture. */
export async function addCaptureReaders(context: BrowserContext): Promise<void> {
  await context.addInitScript(installCaptureReaders);
}

/** webgl false: WebGL turned off in the browser (--disable-3d-apis), for the page's needs-WebGL message. */
export function launchBrowser(o: { webgl?: boolean } = {}): Promise<Browser> {
  return chromium.launch({ executablePath: HEADLESS_SHELL, args: o.webgl === false ? [...CHROMIUM_FLAGS, "--disable-3d-apis"] : CHROMIUM_FLAGS });
}

/**
 * The phone engine beside Chromium: Playwright WebKit under its
 * iPhone 15 profile (Safari user agent, 3x pixels, mobile viewport, touch), each phone scene at its own size. A WebKit
 * browser needs no SwiftShader; it runs the 3D board only where it has WebGL2.
 */
export const WEBKIT_DEVICE = "iPhone 15";
export function launchWebKit(): Promise<Browser> {
  return webkit.launch();
}
export const isWebKit = (browser: Browser): boolean => browser.browserType().name() === "webkit";
/** The prefix a WebKit pass puts on its stills and records: webkit-; Chromium has none. */
export const enginePrefix = (browser: Browser): string => (isWebKit(browser) ? "webkit-" : "");

export interface ClientPage {
  page: Page;
  info: ClientInfo;
  /** Page errors and console errors seen so far, in order. */
  errors: string[];
  /** render false: the 3D board updates without drawing, for catching up; the 2D board always draws. */
  frame(render?: boolean): Promise<FrameResult>;
  /** Advance Playwright's clock by ms (whole milliseconds). */
  advance(ms: number): Promise<void>;
  setOptions(o: SceneOptions): Promise<void>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** A recording in out/recordings, written by src/live/record.ts; ignored with replay. */
  recording: string;
  /** Open ?replay instead: it plays the newest stored match, which is `stored` (the bundled one is deleted). */
  replay?: boolean;
  /**
   * The one stored match the server's history lists and serves. With replay or emptyServer it defaults to an in-process
   * grid-scale-2 recording as long as the deleted bundled excerpt (1,801 messages); null serves empty history.
   */
  stored?: StoredRecording | null;
  /** Open the live page on an empty server instead: /live/status says idle and /live/current has no match. */
  emptyServer?: boolean;
  /** The server's finished-match recordings (/live/replays), which the masthead lists; none by default. */
  replays?: readonly { seq: number; match: number; replayId: string }[];
  width: number;
  height: number;
  tilt: boolean;
  /** The built client to serve; defaults to this checkout's web/dist (stills.ts serves an older build beside it). */
  webDir?: string;
  /**
   * An extra substring the WebGL renderer string must also contain. It can only
   * narrow the check: SwiftShader is always required.
   */
  requireRenderer?: string;
  /** Capture defaults to explicit 2D; board=3d still selects 3D independently of the public default. */
  board?: "2d" | "3d";
  /** Requests whose path matches are aborted (a 3D board whose code fails to load). */
  abort?: RegExp;
  /** A phone: mobile viewport and touch, so the page sees a coarse pointer (emulated-phone timing). */
  phone?: boolean;
  /** The rules the Rules page (/rules) is rendered with for this context, as the live server renders it from the match's; the public rules without. */
  rules?: SimConfig;
}

/**
 * A page with the client and recordings served from disk, the paused clock installed, and its
 * page and console errors collected (and logged) as they happen; goto the returned URL.
 */
let defaultStored: StoredRecording | undefined;
/** Made once, on first use: a full snapshot and 1,800 one-tick deltas of today's match. */
export function defaultStoredRecording(): StoredRecording {
  return defaultStored ??= storedRecording(scale2Packets(1801));
}

export async function servePage(browser: Browser, o: Pick<OpenOptions, "recording" | "replay" | "emptyServer" | "replays" | "stored" | "width" | "height" | "tilt" | "webDir" | "board" | "abort" | "phone" | "rules">): Promise<{ page: Page; errors: string[]; url: string }> {
  const stored = o.stored === undefined ? (o.replay || o.emptyServer ? defaultStoredRecording() : null) : o.stored;
  const viewport = { width: o.width, height: o.height };
  const context = await browser.newContext(isWebKit(browser) && o.phone ? { ...devices[WEBKIT_DEVICE], viewport } : { viewport, deviceScaleFactor: 1, ...(o.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(`page error: ${e.message}`);
    console.error(`[page] ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console error: ${m.text()}`);
  });
  // Must precede clock.install: a handle saved afterwards is the fake clock. On the context, so that WebKit, which
  // runs a context's init scripts before a page's, saves it before the clock's too.
  await context.addInitScript(() => {
    window.__antwarRealNow = performance.now.bind(performance);
  });
  await addCaptureReaders(context);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  // The whole context is served, so a page the client opens beside itself (the Rules page, the tab stills) loads too.
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (o.abort?.test(path)) return route.abort();
    // Match the real no-storage server; unrelated missing resources must still fail below.
    if (route.request().method() === "GET" && path === "/live/replays") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ replays: o.replays ?? [] }) });
    }
    // The stored-match history (replay.ts newestStoredReplay), the match's record and its recording.
    const history = stored && route.request().method() === "GET" ? storedHistory(path, stored) : null;
    if (history) return route.fulfill({ status: 200, contentType: history.type, headers: { "cache-control": "no-store" }, body: Buffer.from(history.body) });
    // Otherwise one empty page, as a server with no stored matches answers.
    if (route.request().method() === "GET" && path === "/matches") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ matches: [], nextPageToken: null }) });
    }
    if (o.emptyServer && path === "/live/status") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ kind: "idle", match: null }) });
    }
    if (path === "/rules") return route.fulfill({ body: renderRules(o.rules ?? PUBLIC_CONFIG), contentType: "text/html; charset=utf-8" });
    const file = path.startsWith("/recordings/") ? join(RECORDING_DIR, normalize(path.slice("/recordings/".length))) : join(o.webDir ?? WEB_DIR, normalize(path));
    try {
      await route.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" });
    } catch {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
  return { page, errors, url: `${ORIGIN}/index.html?${captureQuery(o)}` };
}

/** Pin capture to its requested renderer, including replay, rather than inheriting the public default. */
export function captureQuery(o: Pick<OpenOptions, "recording" | "replay" | "emptyServer" | "tilt" | "board">): URLSearchParams {
  return new URLSearchParams({ ...(o.emptyServer ? {} : o.replay ? { replay: "" } : { recording: o.recording }), capture: "1", tilt: o.tilt ? "1" : "0", board: o.board ?? "2d" });
}

export async function openClient(browser: Browser, o: OpenOptions): Promise<ClientPage> {
  const { page, errors, url } = await servePage(browser, o);
  const context = page.context();
  await page.goto(url);
  const info = await page.evaluate(() => window.__antwar.ready);
  const webKit = isWebKit(browser);
  const mismatch = webKit ? null : checkRenderer(info.rendererString, o.requireRenderer);
  if (mismatch) {
    await context.close();
    throw mismatch;
  }
  if (!info.webgl2 && (!webKit || o.board === "3d")) {
    await context.close();
    throw new Error(`client is not on WebGL2 (renderer ${info.rendererName})`);
  }
  await page.evaluate((tilt) => window.__antwar.setOptions({ tilt }), o.tilt);
  return {
    page,
    info,
    errors,
    frame: (render) => page.evaluate((r) => window.__antwar.frame(r), render),
    advance: (ms) => page.clock.runFor(ms),
    setOptions: (opts) => page.evaluate((x) => window.__antwar.setOptions(x), opts),
    close: () => context.close(),
  };
}

/**
 * The renderer guard: the string must name SwiftShader, and also contain
 * `extra` when one is given. Returns the refusal, or null when capture may go on.
 */
export function checkRenderer(rendererString: string, extra?: string): RendererMismatch | null {
  for (const required of [REQUIRED_RENDERER, ...(extra ? [extra] : [])]) {
    if (!rendererString.includes(required)) return new RendererMismatch(required, rendererString);
  }
  return null;
}

export class RendererMismatch extends Error {
  readonly required: string;
  readonly actual: string;
  constructor(required: string, actual: string) {
    super(`WebGL renderer string "${actual}" does not contain "${required}"; refusing to capture (a software or other fallback cannot stand in as evidence)`);
    this.required = required;
    this.actual = actual;
  }
}

/** Clock time of frame k at fps, in whole ms, starting at the render delay so frame 0 shows tick 0. */
export function frameClockMs(k: number, fps: number, startMs: number): number {
  return startMs + Math.round((k * 1000) / fps);
}

/**
 * Scale a PNG down to `width` px wide in the browser (the bundled ffmpeg cannot
 * read PNG), losslessly from the full frame: used for the 1080p frame scaled to
 * 640 px wide that the readability evidence keeps.
 */
export async function scalePng(browser: Browser, png: Buffer, width: number, sourceWidth: number, sourceHeight: number): Promise<Buffer> {
  const height = Math.round((sourceHeight * width) / sourceWidth);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(`<html><body style="margin:0;background:#000"><img style="display:block;width:${width}px;height:${height}px" src="data:image/png;base64,${png.toString("base64")}"></body></html>`);
  await page.waitForFunction(() => (document.querySelector("img") as HTMLImageElement).complete);
  const out = await page.screenshot({ type: "png" });
  await context.close();
  return out;
}
