// Controlled frame/loader regression for the DOM icon handoff, not served-build captures.
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { chromium, webkit, type Browser, type BrowserServer, type Page } from "playwright-core";
const dom = stripTypeScriptTypes(readFileSync("web/src/icons/dom.ts", "utf8"), { mode: "strip" })
  .replace('import { iconMasks } from "./textures.ts";', "const iconMasks = () => window.testState;")
  .replaceAll("export function ", "function ");
const masks = stripTypeScriptTypes(readFileSync("web/src/icons/masks.ts", "utf8"), { mode: "transform" }).replace("export class ", "class ");
let browser: Browser;
// Every case drives a real browser; covers a cold browser launch on a CI runner.
const BROWSER_TEST_TIMEOUT = 30_000;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"], headless: true }); }, BROWSER_TEST_TIMEOUT);
afterAll(async () => { await browser?.close(); });
describe("DOM mask paint handoff", { timeout: BROWSER_TEST_TIMEOUT }, () => {
  it("centres a 40×20 single text mask while stretching the same mask to an SVG icon region", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 80 } });
    try {
      await page.setContent('<style>body{margin:0;background:white;display:grid;grid-template-columns:40px 40px}button{margin:0;padding:0;border:0;width:40px;height:40px;font:40px/1 sans-serif;color:#00c2ff;background:transparent}svg{display:block}</style><button id="text">+</button><div id="svg"></div>');
      await page.addScriptTag({ content: masks + '\nwindow.IconMasks = IconMasks;' });
      await page.evaluate(async () => {
        const w = window as any, canvas = document.createElement("canvas");
        canvas.width = 40; canvas.height = 20;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, 40, 20);
        const src = canvas.toDataURL("image/png");
        // One real non-square PNG, two registered kinds; image shape must not select sizing.
        w.testState = new w.IconMasks({ "zoom-in": { src }, whole: { src } }, async (url: string) => url);
        await w.testState.start();
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        w.textIcon("zoom-in", document.getElementById("text"));
        document.getElementById("svg")!.innerHTML = w.domIcon("whole", '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M0 0h40v40H0Z"/></svg>', "#00c2ff");
        w.destroy = w.mountIconDom(document);
      });
      await page.waitForFunction(() => getComputedStyle(document.querySelector("#text > i > i")!).visibility === "hidden"
        && getComputedStyle(document.querySelector("#svg path")!).display === "none");
      const painted = async (selector: string) => {
        const png = (await page.locator(selector).screenshot()).toString("base64");
        return page.evaluate(async (png: string) => {
          const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
          let minX = image.width, minY = image.height, maxX = -1, maxY = -1, count = 0;
          for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            if (pixels[i] === 0 && pixels[i + 1] === 194 && pixels[i + 2] === 255 && pixels[i + 3] === 255) {
              count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
          }
          return { minX, minY, maxX, maxY, count };
        }, png);
      };
      expect.soft(await painted("#text")).toEqual({ minX: 0, minY: 10, maxX: 39, maxY: 29, count: 800 });
      expect(await painted("#svg")).toEqual({ minX: 0, minY: 0, maxX: 39, maxY: 39, count: 1600 });
    } finally { await page.evaluate(() => (window as any).destroy?.()); await page.close(); }
  });

  it("keeps vectors/text through a paint opportunity, waits for both masks and leaves unrelated keys alone", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button id="svg"></button><button id="text">+</button><button id="other"></button>');
      await page.addScriptTag({ content: masks + '\nwindow.IconMasks = IconMasks;' });
      await page.evaluate(() => {
        const w = window as any;
        w.frames = new Map(); let next = 0;
        // Hold the actual SVG image events independently of loader publication.
        // Do not start invalid relative test URLs in this controlled-frame case.
        const nativeSet = SVGElement.prototype.setAttribute;
        SVGElement.prototype.setAttribute = function(name, value) {
          if (this instanceof SVGImageElement && name === "href") nativeSet.call(this, "data-pending-src", value);
          else nativeSet.call(this, name, value);
        };
        w.loadImages = () => { for (const image of document.querySelectorAll("image")) image.dispatchEvent(new Event("load")); };
        window.requestAnimationFrame = fn => { w.frames.set(++next, fn); return next; };
        window.cancelAnimationFrame = id => { w.frames.delete(id); };
        w.frame = () => { const callbacks = [...w.frames.values()]; w.frames.clear(); for (const fn of callbacks) fn(performance.now()); };
        w.loads = new Map();
        w.testState = new w.IconMasks({
          whole: { src: "whole-fill.png", second: { src: "whole-shade.png" } },
          "zoom-in": { src: "zoom-fill.png", second: { src: "zoom-shade.png" } },
          close: { src: "close.png" },
        }, (src: string) => new Promise(resolve => w.loads.set(src, resolve)));
        w.finish = async (src: string) => { w.loads.get(src)(src); await Promise.resolve(); await Promise.resolve(); };
        w.pending = w.testState.start();
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        document.getElementById("svg")!.innerHTML = w.domIcon("whole", '<svg viewBox="0 0 24 24"><path d="M3 7V3h4"/></svg>');
        document.getElementById("other")!.innerHTML = w.domIcon("close", '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/></svg>');
        w.textIcon("zoom-in", document.getElementById("text"));
        w.original = document.body.innerHTML;
        w.destroy = w.mountIconDom(document);
      });
      // Fill arrives, shade is still pending: not even a one-shade layer may be mounted.
      await page.evaluate(async () => { const w = window as any; await w.finish("whole-fill.png"); await w.finish("zoom-fill.png"); });
      expect.soft(await page.locator("g[data-icon-layer]").count()).toBe(0);
      expect.soft(await page.locator("#text").textContent()).toBe("+");
      await page.evaluate(async () => { const w = window as any; await w.finish("whole-shade.png"); await w.finish("zoom-shade.png"); });
      expect(await page.locator("g[data-icon-layer]").count()).toBe(2);
      expect.soft(await page.locator("#svg path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      await page.evaluate(() => document.querySelector("#svg image")!.dispatchEvent(new Event("load")));
      expect(await page.locator("#svg g[data-icon-layer]").evaluate(el => getComputedStyle(el).visibility)).toBe("hidden");
      expect(await page.locator("#svg path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      await page.evaluate(() => (window as any).loadImages());
      expect(await page.locator('#text > i > i[style*="visibility: hidden"]').count()).toBe(0);
      // A rAF callback runs before paint. Retiring the vector in that first callback is too early.
      await page.waitForFunction(() => (window as any).frames.size > 0);
      await page.evaluate(() => (window as any).frame());
      expect(await page.locator("#svg path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      await page.evaluate(() => (window as any).frame());
      expect(await page.locator("#svg path").evaluate(el => getComputedStyle(el).display)).toBe("none");
      expect(await page.locator('#text > i > i[style*="visibility: hidden"]').count()).toBe(1);
      await page.evaluate(() => { (window as any).painted = document.querySelector("g[data-icon-layer]"); });
      await page.evaluate(async () => { const w = window as any; await w.finish("close.png"); });
      expect(await page.evaluate(() => document.querySelector("#svg g[data-icon-layer]") === (window as any).painted)).toBe(true);
      expect(await page.locator("g[data-icon-layer]").count()).toBe(3);
      await page.evaluate(() => { const w = window as any; w.destroy(); w.frame(); w.frame(); });
      expect(await page.evaluate(() => document.body.innerHTML === (window as any).original)).toBe(true);
      expect(await page.evaluate(() => (window as any).frames.size)).toBe(0);
    } finally { await page.close(); }
  });
  it("does not hide the vector while the CSS mask resource is still pending", async () => {
    const page = await browser.newPage();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.route("https://mask.test/icon.png", async route => {
        await pending;
        await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64") });
      });
      await page.setContent('<svg viewBox="0 0 24 24" width="24" height="24"><path d="M0 0h24v24H0Z"/></svg>');
      await page.evaluate(() => {
        // The existing Pixi consumer is ready; CSS is an independent image consumer.
        (window as any).testState = { version: 1, get: () => ({ src: "https://mask.test/icon.png" }), isReady: () => true, subscribe: () => () => {} };
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        w.domIcon("whole", document.querySelector("svg")!.outerHTML);
        w.destroy = w.mountIconDom(document);
      });
      // Give multiple actual rendering opportunities while the image is withheld.
      await page.evaluate(() => new Promise<void>(resolve => {
        let frames = 0; const tick = () => { if (++frames === 5) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      }));
      expect(await page.locator("path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      release();
      await page.waitForFunction(() => getComputedStyle(document.querySelector("path")!).display === "none");
    } finally { release(); await page.evaluate(() => (window as any).destroy?.()); await page.close(); }
  });

  it("retains the vector when Image.decode completes but the no-store SVG mask image response is held", async () => {
    const page = await browser.newPage();
    let release!: () => void, requested!: () => void, requests = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const cssRequested = new Promise<void>(resolve => { requested = resolve; });
    try {
      await page.route("https://mask.test/no-store.png", async route => {
        if (++requests > 1) { requested(); await held; }
        await route.fulfill({ contentType: "image/png", headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
          body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64") });
      });
      await page.setContent('<svg viewBox="0 0 24 24" width="24" height="24"><path d="M0 0h24v24H0Z"/></svg>');
      await page.evaluate(() => {
        const w = window as any, nativeDecode = Image.prototype.decode;
        w.nativeDecode = nativeDecode;
        w.testState = { version: 1, get: () => ({ src: "https://mask.test/no-store.png" }), isReady: () => true, subscribe: () => () => {} };
      });
      await page.evaluate(async () => {
        // CORS mode: Chromium 153 hands a same-document no-cors <image> the probe's no-store image instead of refetching.
        const w = window as any, probe = new Image(); probe.crossOrigin = "anonymous"; probe.src = "https://mask.test/no-store.png";
        await w.nativeDecode.call(probe); w.imageDecoded = true;
        // The separate probe is demonstrably decoded; it says nothing about the render consumer.
        Image.prototype.decode = async () => {};
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        w.domIcon("whole", document.querySelector("svg")!.outerHTML); w.destroy = w.mountIconDom(document);
      });
      await page.waitForFunction(() => (window as any).imageDecoded === true);
      await cssRequested;
      await page.evaluate(() => new Promise<void>(resolve => {
        let frames = 0; const tick = () => { if (++frames === 5) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      }));
      expect(requests).toBe(2);
      expect(await page.evaluate(() => ({ imageDecoded: (window as any).imageDecoded,
        originalVisible: getComputedStyle(document.querySelector("path")!).display !== "none",
        replacementHidden: getComputedStyle(document.querySelector("g[data-icon-layer]")!).visibility === "hidden",
      }))).toEqual({ imageDecoded: true, originalVisible: true, replacementHidden: true });
      release();
      await page.waitForFunction(() => getComputedStyle(document.querySelector("path")!).display === "none");
    } finally { release(); await page.evaluate(() => (window as any).destroy?.()); await page.close(); }
  });

  it("keeps the original when the actual second mask image fails, with no retry or partial shade", async () => {
    const page = await browser.newPage();
    const requests: string[] = [];
    try {
      await page.route("https://mask.test/*.png", async route => {
        const src = route.request().url(); requests.push(src);
        await route.fulfill(src.endsWith("shade.png") ? { status: 503, body: "missing" } : {
          contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64"),
        });
      });
      await page.setContent('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0Z"/></svg>');
      await page.evaluate(() => {
        const w = window as any; w.listeners = new Set(); w.errors = 0;
        document.addEventListener("error", () => w.errors++, true);
        w.testState = { version: 1, get: () => ({ src: "https://mask.test/fill.png", second: { src: "https://mask.test/shade.png" } }),
          isReady: () => true, subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => { const w = window as any; w.domIcon("whole", document.querySelector("svg")!.outerHTML); w.destroy = w.mountIconDom(document); });
      await page.waitForFunction(() => (window as any).errors === 1);
      await page.evaluate(() => { for (const fn of (window as any).listeners) fn(); });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.locator("path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      expect(await page.locator("[data-icon-layer]").evaluate(el => getComputedStyle(el).visibility)).toBe("hidden");
      expect(requests.sort()).toEqual(["https://mask.test/fill.png", "https://mask.test/shade.png"]);
      await page.evaluate(() => (window as any).destroy());
      expect(await page.locator("mask, [data-icon-layer]").count()).toBe(0);
    } finally { await page.close(); }
  });

  it("uses document-unique alpha masks owned and removed by each SVG/text replacement", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="aw-icon-mask-1"></div><main></main><button id="text">+</button>');
      await page.evaluate(() => {
        const w = window as any; w.listeners = new Set(); w.ready = true;
        w.testState = { version: 1, get: () => w.ready ? { src: "fill.png", second: { src: "shade.png" } } : undefined,
          isReady: () => w.ready, subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any, markup = w.domIcon("whole", '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0Z"/></svg>');
        document.querySelector("main")!.innerHTML = markup + markup; w.textIcon("zoom-in", document.getElementById("text"));
        w.original = document.body.innerHTML; w.destroy = w.mountIconDom(document);
      });
      const masks = await page.locator("mask").evaluateAll(nodes => nodes.map(mask => ({ id: mask.id,
        alpha: getComputedStyle(mask).maskType, src: mask.querySelector("image")!.getAttribute("href"),
        ownRect: !!mask.closest("[data-icon-layer]")!.querySelector('[mask="url(#' + mask.id + ')"]'),
      })));
      const allIds = await page.locator("mask, filter").evaluateAll(nodes => nodes.map(resource => resource.id));
      expect(allIds).toHaveLength(9); expect(new Set(allIds).size).toBe(9);
      expect(masks).toHaveLength(6); expect(new Set(masks.map(mask => mask.id)).size).toBe(6);
      expect(masks.every(mask => mask.id !== "aw-icon-mask-1" && mask.alpha === "alpha" && mask.ownRect)).toBe(true);
      expect(masks.map(mask => mask.src)).toEqual(["fill.png", "shade.png", "fill.png", "shade.png", "fill.png", "shade.png"]);
      await page.evaluate(() => { const w = window as any; w.ready = false; for (const fn of w.listeners) fn(); });
      expect(await page.locator("mask, [data-icon-layer]").count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerHTML === (window as any).original)).toBe(true);
      await page.evaluate(() => (window as any).destroy());
    } finally { await page.close(); }
  });

  it("never retries failed image loads and restores exact SVG/text after clearing", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button id="svg"></button><button id="text">+</button>');
      await page.evaluate(() => {
        const w = window as any;
        w.requests = []; w.listeners = new Set(); w.mask = { src: "failed.png" };
        const nativeSet = SVGElement.prototype.setAttribute;
        SVGElement.prototype.setAttribute = function(name, value) { nativeSet.call(this, name, value); if (this instanceof SVGImageElement && name === "href") { w.requests.push(value); queueMicrotask(() => this.dispatchEvent(new Event("error"))); } };
        w.testState = { version: 1, get: () => w.mask, isReady: () => !!w.mask, subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        document.getElementById("svg")!.innerHTML = w.domIcon("whole", '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0Z"/></svg>');
        w.textIcon("zoom-in", document.getElementById("text")); w.original = document.body.innerHTML;
        w.destroy = w.mountIconDom(document);
      });
      await page.waitForFunction(() => (window as any).requests.length === 2);
      await page.evaluate(async () => {
        const w = window as any;
        for (const fn of w.listeners) fn();
        w.mask = undefined; for (const fn of w.listeners) fn();
        w.mask = { src: "failed.png" }; for (const fn of w.listeners) fn();
        await Promise.resolve();
      });
      expect(await page.evaluate(() => (window as any).requests)).toEqual(["failed.png", "failed.png"]);
      expect(await page.locator("path").evaluate(el => getComputedStyle(el).display)).not.toBe("none");
      expect(await page.locator('#text > i > i').evaluate(el => getComputedStyle(el).visibility)).toBe("visible");
      expect(await page.locator("#svg g[data-icon-layer]").evaluate(el => getComputedStyle(el).visibility)).toBe("hidden");
      await page.evaluate(() => (window as any).destroy());
      expect(await page.evaluate(() => document.body.innerHTML === (window as any).original)).toBe(true);
    } finally { await page.close(); }
  });

  it("cancels late image and frame callbacks on clear, removal and destruction", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main></main>');
      await page.evaluate(() => {
        const w = window as any;
        w.finish = []; w.listeners = new Set(); w.mask = { src: "late.png" };
        w.testState = { version: 1, get: () => w.mask, isReady: () => !!w.mask, subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.mountIconDom = mountIconDom;' });
      await page.evaluate(() => {
        const w = window as any;
        const markup = w.domIcon("whole", '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0Z"/></svg>');
        document.querySelector("main")!.innerHTML = markup + markup;
        w.original = document.body.innerHTML; w.destroy = w.mountIconDom(document);
        for (const image of document.querySelectorAll("image")) w.finish.push(() => image.dispatchEvent(new Event("load")));
        w.removed = document.querySelector("svg"); w.removed.remove();
      });
      // Let the observer prune detached work, then clear and destroy the remainder.
      await page.evaluate(() => { const w = window as any; w.mask = undefined; for (const fn of w.listeners) fn(); w.destroy(); for (const resolve of w.finish) resolve(); });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.locator("g[data-icon-layer]").count()).toBe(0);
      expect(await page.locator("path").getAttribute("style")).toBeNull();
      expect(await page.evaluate(() => (window as any).removed.querySelector("g[data-icon-layer]"))).toBeNull();
      expect(await page.evaluate(() => (window as any).removed.querySelector("path").getAttribute("style"))).toBeNull();
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(0);
    } finally { await page.close(); }
  });

});

// Diagnostic only: names the phase a CI stall is in. Each phase races one shared deadline set
// 500 ms inside the test budget, so a stall fails with the phase and every phase time in its message
// (the failure annotation) instead of vitest's bare timeout. What the case asserts is unchanged; no retry.
const PHASE_DEADLINE = BROWSER_TEST_TIMEOUT - 500;
const STALLED = Symbol("stalled");
function phaseClock(label: string) {
  const start = performance.now(), times: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, stalled = false;
  const deadline = new Promise<typeof STALLED>(resolve => { timer = setTimeout(() => resolve(STALLED), PHASE_DEADLINE); });
  const ms = (from: number) => Math.round(performance.now() - from);
  return {
    label,
    get stalled() { return stalled; },
    async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
      const from = performance.now();
      const result = await Promise.race([work(), deadline]);
      if (result === STALLED) {
        stalled = true;
        throw new Error(`${label}: stalled in phase "${name}" for ${ms(from)}ms at ${ms(start)}ms of the ${BROWSER_TEST_TIMEOUT}ms budget; completed phases: ${times.join(", ") || "none"}`);
      }
      times.push(`${name} ${ms(from)}`);
      return result as T;
    },
    finish() { clearTimeout(timer); },
  };
}

// WebKit's graceful close sends Playwright.close, then waits for its process group to exit with
// no deadline; on the CI runner it once never exited (28.5 s in "close" after every assertion passed).
// Each case launches its own browser server so the test owns that process group and can bound teardown.
const CLOSE_BOUND = 5_000;
// Allowance for SIGKILL and process exit after the bound; the forcing check asserts within it.
const KILL_MARGIN = 2_000;
type PaintBrowser = { server: BrowserServer; browser: Browser };
async function launchPaintBrowser(engine: "Chromium" | "WebKit"): Promise<PaintBrowser> {
  const type = engine === "WebKit" ? webkit : chromium;
  const server = await (engine === "WebKit" ? webkit.launchServer({ headless: true })
    : chromium.launchServer({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"], headless: true }));
  try { return { server, browser: await type.connect(server.wsEndpoint()) }; }
  catch (error) { await server.kill(); throw error; }
}
// Page close plus graceful browser close, together bounded at CLOSE_BOUND. Past the bound the browser's
// process group is killed and awaited, and one ::warning annotation reports the forced close. Runs only
// after every assertion; it changes nothing the case proves. The forcing check's own kill is annotated
// under a separate title so it never reads as a real forced close in a paint case. Titles carry no comma
// or colon: those delimit workflow-command properties.
async function closePaintBrowser(label: string, { server, browser }: PaintBrowser, page?: Page, forcingCheck = false): Promise<{ elapsedMs: number; forced: boolean }> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceful = (async () => { await page?.close(); await browser.close(); await server.close(); })();
  const outcome = await Promise.race([
    graceful.then(() => ({ closed: true as const }), (error: unknown) => ({ closed: false as const, error })),
    new Promise<{ closed: false }>(resolve => { timer = setTimeout(() => resolve({ closed: false }), CLOSE_BOUND); }),
  ]);
  clearTimeout(timer);
  if (outcome.closed) return { elapsedMs: Math.round(performance.now() - start), forced: false };
  graceful.catch(() => {}); // the kill below settles it; its rejection is not the case's outcome
  await server.kill();
  const elapsedMs = Math.round(performance.now() - start);
  if ("error" in outcome) throw outcome.error;
  // Written straight to stdout so the runner reads the workflow command at the start of a line.
  const title = forcingCheck ? "paint.test.ts FORCING CHECK - intentional SIGSTOP kill - not a real stall" : `paint.test.ts ${label} forced close`;
  process.stdout.write(`::warning title=${title}::${label}: browser did not exit within ${CLOSE_BOUND}ms of graceful close; process group killed, settled at ${elapsedMs}ms\n`);
  return { elapsedMs, forced: true };
}

describe.each(["Chromium", "WebKit"] as const)("%s second-mask paint", { timeout: BROWSER_TEST_TIMEOUT }, engine => {
  it("paints a solid 70% shade for explicit and inherited colours on light and dark backgrounds", async () => {
    const clock = phaseClock(`${engine} solid shade`);
    let launching: Promise<PaintBrowser> | undefined, paintBrowser: PaintBrowser | undefined, page: Page | undefined;
    try {
      paintBrowser = await clock.phase("launch", () => launching = launchPaintBrowser(engine));
      page = await clock.phase("newPage", () => paintBrowser!.browser.newPage({ viewport: { width: 100, height: 180 }, deviceScaleFactor: 1 }));
      await clock.phase("setContent", () => page!.setContent('<style>body{margin:0}section{display:flex;background:white;color:#64c8fa}section+section{background:black}button{padding:0;border:0;width:40px;height:40px;font:40px/1 sans-serif;color:inherit;background:transparent}svg{display:block}</style><section><div id="light"></div><button>+</button></section><section><div id="dark"></div><button>+</button></section>'));
      await clock.phase("masks", () => page!.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 40;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, 40, 40);
        const src = canvas.toDataURL("image/png");
        ctx.clearRect(0, 0, 40, 40); ctx.fillRect(20, 0, 20, 40);
        const mask = { src, second: { src: canvas.toDataURL("image/png") } };
        (window as any).testState = { version: 1, get: () => mask, isReady: () => true, subscribe: () => () => {} };
      }));
      await clock.phase("script", () => page!.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' }));
      await clock.phase("mount", () => page!.evaluate(() => {
        const w = window as any;
        for (const host of document.querySelectorAll("section > div")) {
          host.innerHTML = w.domIcon("whole", '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M0 0h40v40H0Z"/></svg>', "#64c8fa");
        }
        for (const button of document.querySelectorAll("button")) w.textIcon("zoom-in", button);
        w.destroy = w.mountIconDom(document);
      }));
      await clock.phase("swap", () => page!.waitForFunction(() => [...document.querySelectorAll("path")].every(el => getComputedStyle(el).display === "none")
        && [...document.querySelectorAll("button > i > i")].every(el => getComputedStyle(el).visibility === "hidden")));
      for (const selector of ["#light", "section:first-of-type button", "#dark", "section:last-of-type button"]) {
        const png = (await clock.phase(`screenshot ${selector}`, () => page!.locator(selector).screenshot())).toString("base64");
        const pixels = await clock.phase(`read ${selector}`, () => page!.evaluate(async png => {
          const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
          return [10, 30].map(x => [...ctx.getImageData(x, 20, 1, 1).data]);
        }, png));
        const [base, shade] = pixels as [number[], number[]];
        console.log(engine, selector, JSON.stringify({ base, shade, ratios: [0, 1, 2].map(channel => shade[channel]! / base[channel]!) }));
        expect.soft(base[3], `${selector} opaque base`).toBe(255);
        expect.soft(shade[3], `${selector} opaque shade`).toBe(255);
        for (const [channel, value] of [100, 200, 250].entries()) {
          // SVG filter surfaces can round a channel by one 8-bit step in WebKit.
          expect.soft(Math.abs(base[channel]! - value), `${selector} unchanged base channel ${channel}`).toBeLessThanOrEqual(1);
          expect.soft(Math.abs(shade[channel]! - value * 0.70), `${selector} channel ${channel} shade`).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      try {
        // After a stall, kill without waiting so the named failure lands inside the budget.
        if (clock.stalled) void launching?.then(launched => launched.server.kill()).catch(() => {});
        else {
          if (page) await clock.phase("cleanup", () => page!.evaluate(() => (window as any).destroy?.()));
          if (paintBrowser) await clock.phase("close", () => closePaintBrowser(clock.label, paintBrowser!, page));
        }
      } finally { clock.finish(); }
    }
  });
  it("keeps translucent --aw-ink-2 at 70% shade with the ink alpha applied once", async () => {
    const clock = phaseClock(`${engine} translucent ink`);
    let launching: Promise<PaintBrowser> | undefined, paintBrowser: PaintBrowser | undefined, page: Page | undefined;
    try {
      paintBrowser = await clock.phase("launch", () => launching = launchPaintBrowser(engine));
      page = await clock.phase("newPage", () => paintBrowser!.browser.newPage({ viewport: { width: 100, height: 180 }, deviceScaleFactor: 1 }));
      await clock.phase("setContent", () => page!.setContent('<style>body{margin:0;--aw-ink-2:rgba(233,239,240,0.76)}section{display:flex;background:white;color:var(--aw-ink-2)}section+section{background:black}button{padding:0;border:0;width:40px;height:40px;font:40px/1 sans-serif;color:inherit;background:transparent}svg{display:block}</style><section><div id="light"></div><button>+</button></section><section><div id="dark"></div><button>+</button></section>'));
      await clock.phase("masks", () => page!.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 40;
        const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, 40, 40);
        const src = canvas.toDataURL("image/png");
        ctx.clearRect(0, 0, 40, 40); ctx.fillRect(20, 0, 20, 40);
        const mask = { src, second: { src: canvas.toDataURL("image/png") } };
        (window as any).testState = { version: 1, get: () => mask, isReady: () => true, subscribe: () => () => {} };
      }));
      await clock.phase("script", () => page!.addScriptTag({ content: dom + '\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;' }));
      await clock.phase("mount", () => page!.evaluate(() => {
        const w = window as any;
        for (const host of document.querySelectorAll("section > div")) {
          host.innerHTML = w.domIcon("whole", '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M0 0h40v40H0Z"/></svg>', "var(--aw-ink-2)");
        }
        for (const button of document.querySelectorAll("button")) w.textIcon("zoom-in", button);
        w.destroy = w.mountIconDom(document);
      }));
      await clock.phase("swap", () => page!.waitForFunction(() => [...document.querySelectorAll("path")].every(el => getComputedStyle(el).display === "none")
        && [...document.querySelectorAll("button > i > i")].every(el => getComputedStyle(el).visibility === "hidden")));
      for (const [selector, ground] of [["#light", 255], ["section:first-of-type button", 255], ["#dark", 0], ["section:last-of-type button", 0]] as const) {
        const png = (await clock.phase(`screenshot ${selector}`, () => page!.locator(selector).screenshot())).toString("base64");
        const pixels = await clock.phase(`read ${selector}`, () => page!.evaluate(async png => {
          const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
          return [10, 30].map(x => [...ctx.getImageData(x, 20, 1, 1).data]);
        }, png));
        const [base, shade] = pixels as [number[], number[]];
        // Remove the background contribution before comparing the visible ink signal.
        const background = ground * (1 - 0.76);
        const ratios = [0, 1, 2].map(channel => (shade[channel]! - background) / (base[channel]! - background));
        console.log(engine, selector, JSON.stringify({ base, shade, ratios }));
        for (const [channel, value] of [233, 239, 240].entries()) {
          expect.soft(Math.abs(base[channel]! - (value * 0.76 + background)), `${selector} base alpha channel ${channel}`).toBeLessThanOrEqual(1);
          expect.soft(Math.abs(shade[channel]! - (value * 0.70 * 0.76 + background)), `${selector} shade alpha channel ${channel}`).toBeLessThanOrEqual(1);
          expect.soft(ratios[channel]!, `${selector} shade ratio channel ${channel}`).toBeGreaterThanOrEqual(0.695);
          expect.soft(ratios[channel]!, `${selector} shade ratio channel ${channel}`).toBeLessThanOrEqual(0.71);
        }
      }
    } finally {
      try {
        // After a stall, kill without waiting so the named failure lands inside the budget.
        if (clock.stalled) void launching?.then(launched => launched.server.kill()).catch(() => {});
        else {
          if (page) await clock.phase("cleanup", () => page!.evaluate(() => (window as any).destroy?.()));
          if (paintBrowser) await clock.phase("close", () => closePaintBrowser(clock.label, paintBrowser!, page));
        }
      } finally { clock.finish(); }
    }
  });

});

// Live (non-zombie) processes left in a process group, polled until none or KILL_MARGIN passes. Reads
// Linux /proc: kill(-group, 0) still succeeds for exited processes an init that does not reap has kept.
async function liveGroupMembers(pgid: number): Promise<number[]> {
  for (const until = performance.now() + KILL_MARGIN; ;) {
    const live: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; } // exited mid-scan
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid && state !== "Z") live.push(Number(entry));
    }
    if (live.length === 0 || performance.now() > until) return live;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe("WebKit second-mask teardown", { timeout: BROWSER_TEST_TIMEOUT }, () => {
  // Forces a stall: a stopped WebKit process group cannot answer Playwright.close or exit.
  it("kills a WebKit browser that never exits on graceful close, within the close bound", async () => {
    const launched = await launchPaintBrowser("WebKit");
    const pgid = launched.server.process().pid!; // Playwright starts the browser as its own process group
    const signal = (name: NodeJS.Signals) => { try { process.kill(-pgid, name); } catch { /* group already gone */ } };
    // Runs on pass, failure and timeout alike, so a stopped group never outlives the case.
    onTestFinished(() => { signal("SIGKILL"); signal("SIGCONT"); });
    const page = await launched.browser.newPage();
    process.kill(-pgid, "SIGSTOP");
    const { elapsedMs, forced } = await closePaintBrowser("forcing check (SIGSTOP)", launched, page, true);
    expect(forced).toBe(true);
    expect(elapsedMs).toBeLessThanOrEqual(CLOSE_BOUND + KILL_MARGIN);
    expect(await liveGroupMembers(pgid)).toEqual([]);
  });
});
