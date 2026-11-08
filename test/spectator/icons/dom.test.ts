// Isolated browser DOM checks for the HUD icons, not served-build visual evidence.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { stripTypeScriptTypes } from "node:module";
const source = stripTypeScriptTypes(readFileSync("web/src/icons/dom.ts", "utf8"), { mode: "strip" }).replace('import { iconMasks } from "./textures.ts";', 'const nativeSet = SVGElement.prototype.setAttribute; SVGElement.prototype.setAttribute = function(name, value) { nativeSet.call(this, name, value); if (!window.realImages && this instanceof SVGImageElement && name === "href") queueMicrotask(() => this.dispatchEvent(new Event("load"))); }; const iconMasks = () => { const state = window.testState; state.isReady = key => !!state.get(key); return state; };')
  .replaceAll("export function ", "function ") + "\nwindow.domIcon = domIcon; window.textIcon = textIcon; window.mountIconDom = mountIconDom;";
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });
describe("DOM icon mount", () => {
  it("preserves the vector exactly, changes existing and newly added icons, and restores on clear and destroy", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button title="Close" aria-label="Close" style="color:rgb(255,176,0)"></button>');
      await page.evaluate(() => {
        const w = window as any;
        w.ready = new Map(); w.listeners = new Set();
        w.testState = { version: 0, get: (key: string) => w.ready.get(key), subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: source });
      expect(await page.evaluate(() => {
        const w = window as any;
        w.original = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';
        document.querySelector("button")!.innerHTML = w.domIcon("close", w.original);
        w.before = document.querySelector("button")!.innerHTML; w.destroyIcons = w.mountIconDom(document);
        return document.querySelector("button")!.innerHTML === w.before;
      })).toBe(true);
      await page.evaluate(() => {
        const w = window as any;
        w.ready.set("close", { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==" });
        w.testState.version++; for (const fn of w.listeners) fn();
      });
      const icon = page.locator("button svg");
      expect(await icon.getAttribute("width")).toBe("16"); expect(await icon.getAttribute("aria-hidden")).toBe("true");
      expect(await page.locator("button").getAttribute("title")).toBe("Close");
      await page.waitForFunction(() => document.querySelector<SVGElement>("button svg path")?.style.display === "none");
      expect(await icon.locator("path").getAttribute("style")).toContain("display: none");
      expect(await icon.locator("g[data-icon-layer] > rect").evaluate(el => getComputedStyle(el).fill)).toBe("color(srgb 1 0.690196 0)");
      expect(await icon.locator("image").getAttribute("href")).toContain("data:image/png");
      await page.evaluate(() => { const w = window as any; const div = document.createElement("div"); div.innerHTML = w.domIcon("close", w.original); document.body.append(div); });
      await page.waitForFunction(() => document.querySelectorAll("g[data-icon-layer]").length === 2);
      await page.evaluate(() => { const w = window as any; w.ready.clear(); w.testState.version++; for (const fn of w.listeners) fn(); });
      expect(await page.evaluate(() => document.querySelector("button")!.innerHTML === (window as any).before)).toBe(true);
      expect(await page.locator("g[data-icon-layer]").count()).toBe(0);
      await page.evaluate(() => (window as any).destroyIcons());
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(0);
    } finally { await page.close(); }
  });
  it("keeps its masks through a back/forward-cache pagehide and restores the vector only on a final pagehide", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button title="Close" aria-label="Close" style="color:rgb(255,176,0)"></button>');
      await page.evaluate(() => {
        const w = window as any;
        w.ready = new Map([["close", { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==" }]]); w.listeners = new Set();
        w.testState = { version: 1, get: (key: string) => w.ready.get(key), subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        const w = window as any;
        w.original = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';
        document.querySelector("button")!.innerHTML = w.domIcon("close", w.original);
        w.before = document.querySelector("button")!.innerHTML; w.mountIconDom(document);
      });
      await page.waitForFunction(() => document.querySelector<SVGElement>("button svg path")?.style.display === "none");
      await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
      expect(await page.locator("button g[data-icon-layer]").count()).toBe(1);
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(1);
      // Still observing after the cached return: a newly added icon is enhanced too.
      await page.evaluate(() => { const w = window as any; const div = document.createElement("div"); div.innerHTML = w.domIcon("close", w.original); document.body.append(div); });
      await page.waitForFunction(() => document.querySelectorAll("g[data-icon-layer]").length === 2);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
      expect(await page.locator("g[data-icon-layer]").count()).toBe(0);
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(0);
      expect(await page.evaluate(() => document.querySelector("button")!.innerHTML === (window as any).before)).toBe(true);
    } finally { await page.close(); }
  });
  it("keeps an agent badge's plate while masking only the glyph", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="badge"></div>');
      await page.evaluate(() => { (window as any).testState = { version: 1, get: () => ({ src: "data:image/png;base64,test" }), subscribe: () => () => {} }; });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        const w = window as any;
        document.getElementById("badge")!.innerHTML = w.domIcon("glyph-diamond", '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="1" y="1" width="18" height="18"/><polygon points="10,4 16,10 10,16 4,10"/></svg>', "#00c2ff", { x: 4.4, y: 4.4, w: 11.2, h: 11.2, keep: 1 });
        w.destroyIcons = w.mountIconDom(document);
      });
      expect(await page.locator("svg > rect").getAttribute("style")).toBeNull();
      await page.waitForFunction(() => document.querySelector<SVGElement>("polygon")?.style.display === "none");
      expect(await page.locator("polygon").getAttribute("style")).toContain("display: none");
      expect(await page.locator("mask").getAttribute("width")).toBe("11.2");
      expect(await page.locator("g[data-icon-layer] > rect").evaluate(el => getComputedStyle(el).fill)).toBe("color(srgb 0 0.760784 1)");
      await page.evaluate(() => (window as any).destroyIcons());
    } finally { await page.close(); }
  });
});

describe("repeated DOM icon swaps", () => {
  it("swaps again on mask arrivals and changes without reading hidden vector styles first", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<main></main>");
      await page.evaluate(() => {
        const w = window as any;
        w.ready = new Map(); w.listeners = new Set();
        w.testState = { version: 0, get: (key: string) => w.ready.get(key), subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: source });
      const swaps = await page.evaluate(() => {
        const w = window as any;
        const add = (key: string, body: string, colour = "currentColor", region?: object) => {
          const div = document.createElement("div");
          div.innerHTML = w.domIcon(key, `<svg viewBox="0 0 24 24" width="16" height="16" stroke="${colour}">${body}</svg>`, colour, region);
          document.querySelector("main")!.append(div);
        };
        add("chevron", '<path d="m6 9 6 6 6-6"/>');
        add("info", '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.4"/>');
        add("whole", '<path d="M3 7V3h4M13 3h4v4"/>');
        add("glyph-diamond", '<rect width="24" height="24"/><polygon points="12,4 20,12 12,20 4,12" fill="#00c2ff"/>', "#00c2ff", { x: 4, y: 4, w: 16, h: 16, keep: 1 });
        add("crown", '<g><path d="M4 18h16L12 4Z" style="opacity:.7"/></g>', "#ffb000");
        w.before = document.querySelector("main")!.innerHTML;
        w.destroyIcons = w.mountIconDom(document);
        w.notify = () => { w.testState.version++; for (const fn of w.listeners) fn(); };
        w.select = (suffix: string) => { for (const key of ["chevron", "info", "whole", "glyph-diamond", "crown"]) w.ready.set(key, { src: `${key}-${suffix}.png` }); w.notify(); };
        w.select("first");
        const first = document.querySelectorAll("g[data-icon-layer]").length;
        // Keep both swaps in one task, without serializing the SVG or reading vector
        // styles: those reads flush Chromium's CSSOM and conceal the restore failure.
        w.ready.set("chevron", { src: "chevron-first.png", second: { src: "chevron-shade.png" } }); w.notify();
        return [first, document.querySelectorAll("g[data-icon-layer]").length];
      });
      expect(swaps).toEqual([5, 5]);
      expect(await page.locator("g[data-icon-layer] > rect[fill^='color-mix(']").count()).toBe(1);
      await page.evaluate(() => (window as any).select("second"));
      expect(await page.locator("g[data-icon-layer]").count()).toBe(5);
      expect(await page.locator("image").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))))
        .toEqual(["chevron", "info", "whole", "glyph-diamond", "crown"].map(key => `${key}-second.png`));
      await page.evaluate(() => { const w = window as any; w.ready.clear(); w.notify(); });
      expect(await page.locator("g[data-icon-layer]").count()).toBe(0);
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).before)).toBe(true);
      await page.evaluate(() => (window as any).select("third"));
      expect(await page.locator("g[data-icon-layer]").count()).toBe(5);
      await page.evaluate(() => (window as any).destroyIcons());
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).before)).toBe(true);
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(0);
    } finally { await page.close(); }
  });

  it("tolerates added descendant attributes but still checks registered structure, geometry, colours and styles", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<main></main>");
      await page.evaluate(() => { (window as any).testState = { version: 1, get: () => ({ src: "mask.png" }), subscribe: () => () => {} }; });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        const w = window as any;
        const markup = '<svg viewBox="0 0 24 24"><g><path d="M4 18h16L12 4Z" fill="#ffb000" style="opacity:.7"/><circle r="2"/></g></svg>';
        w.domIcon("crown", markup, "#ffb000");
        const variants = ["added", "geometry", "colour", "style", "structure", "text"];
        for (const kind of variants) {
          const wrap = document.createElement("div"); wrap.id = kind; wrap.innerHTML = markup;
          for (const element of wrap.querySelectorAll("svg, g, path, circle")) {
            element.setAttribute("class", "runtime"); element.setAttribute("data-live", "true");
          }
          wrap.querySelector("g")!.setAttribute("style", "");
          if (kind === "geometry") wrap.querySelector("path")!.setAttribute("d", "M0 0h2");
          if (kind === "colour") wrap.querySelector("path")!.setAttribute("fill", "#00c2ff");
          if (kind === "style") wrap.querySelector("path")!.setAttribute("style", "opacity:.2");
          if (kind === "structure") wrap.querySelector("circle")!.remove();
          if (kind === "text") wrap.querySelector("g")!.append("different");
          document.querySelector("main")!.append(wrap);
        }
        w.before = document.querySelector("main")!.innerHTML;
        w.destroyIcons = w.mountIconDom(document);
      });
      expect(await page.locator("#added g[data-icon-layer]").count()).toBe(1);
      expect(await page.locator("g[data-icon-layer]").count()).toBe(1);
      await page.evaluate(() => (window as any).destroyIcons());
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).before)).toBe(true);
    } finally { await page.close(); }
  });
});

describe("runtime SVG attributes and text controls", () => {
  it("matches decorated team badges, history icons and whole-board buttons without losing colour or plate", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main></main>');
      await page.evaluate(() => {
        (window as any).testState = { version: 1, get: (key: string) => ({ src: `${key}.png` }), subscribe: () => () => {} };
      });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        const w = window as any;
        const add = (key: string, body: string, colour = "currentColor", region?: object) => {
          const markup = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="${colour}" aria-hidden="true">${body}</svg>`;
          const wrap = document.createElement("div"); wrap.innerHTML = w.domIcon(key, markup, colour, region);
          const svg = wrap.firstElementChild!;
          svg.setAttribute("style", ""); svg.setAttribute("class", "runtime"); svg.setAttribute("data-live", "true");
          document.querySelector("main")!.append(wrap);
        };
        add("glyph-diamond", '<rect width="24" height="24"/><polygon points="12,4 20,12 12,20 4,12"/>', "#00c2ff", { x: 4, y: 4, w: 16, h: 16, keep: 1 });
        add("crown", '<path d="M4 18h16L12 4Z"/>', "#ffb000");
        add("crown", '<path d="M4 18h16L12 4Z"/>', "#00c2ff");
        add("whole", '<path d="M3 7V3h4M13 3h4v4"/>');
        w.original = document.querySelector("main")!.innerHTML;
        w.destroyIcons = w.mountIconDom(document);
      });
      expect(await page.locator("g[data-icon-layer]").count()).toBe(4);
      expect(await page.locator("svg > rect").getAttribute("style")).toBeNull();
      await page.waitForFunction(() => document.querySelector<SVGElement>("polygon")?.style.display === "none");
      expect(await page.locator("polygon").getAttribute("style")).toContain("display: none");
      expect(await page.locator("g[data-icon-layer] > rect").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill)))
        .toEqual(["color(srgb 0 0.760784 1)", "color(srgb 1 0.690196 0)", "color(srgb 0 0.760784 1)", "color(srgb 0 0 0)"]);
      // A newly registered history icon inserted after mount also carries runtime attributes.
      await page.evaluate(() => {
        const w = window as any, wrap = document.createElement("div");
        wrap.innerHTML = w.domIcon("order-go_to", '<svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg>');
        wrap.firstElementChild!.setAttribute("style", "opacity: 0.7"); document.body.append(wrap);
      });
      await page.waitForFunction(() => document.querySelectorAll("g[data-icon-layer]").length === 5);
      await page.evaluate(() => (window as any).destroyIcons());
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).original)).toBe(true);
      expect(await page.locator('svg[style="opacity: 0.7"]').count()).toBe(1);
    } finally { await page.close(); }
  });

  it("keeps text bytes, boxes, labels, tooltips and actions through pending, partial, selected and cleared sets", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<style>button { width:44px;height:44px;padding:0;font:18px/1 sans-serif;color:rgb(0,194,255) }</style><main></main>');
      await page.evaluate(() => {
        const w = window as any;
        w.ready = new Map(); w.listeners = new Set(); w.clicks = [];
        w.testState = { version: 0, get: (key: string) => w.ready.get(key), subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        const w = window as any;
        for (const [key, text, label] of [["zoom-out", "−", "Zoom out"], ["zoom-in", "+", "Zoom in"], ["close", "×", "Close"]]) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = text!;
          button.title = label!; button.setAttribute("aria-label", label!);
          button.addEventListener("click", () => w.clicks.push(key));
          document.querySelector("main")!.append(w.textIcon(key, button));
        }
        // An unregistered control (for example on another surface) is never touched.
        const other = document.createElement("button"); other.textContent = "×"; document.querySelector("main")!.append(other);
        w.original = document.querySelector("main")!.innerHTML;
        w.destroyIcons = w.mountIconDom(document);
      });
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).original)).toBe(true);
      // A partial set leaves omitted/pending/failed keys as exact text.
      await page.evaluate(() => { const w = window as any; w.ready.set("zoom-out", { src: "minus.png" }); w.testState.version++; for (const fn of w.listeners) fn(); });
      expect(await page.locator("button > i > svg").count()).toBe(1);
      expect(await page.locator("button").nth(1).textContent()).toBe("+");
      expect(await page.locator("button").nth(2).textContent()).toBe("×");
      await page.evaluate(() => { const w = window as any; for (const key of ["zoom-in", "close"]) w.ready.set(key, { src: `${key}.png` }); w.testState.version++; for (const fn of w.listeners) fn(); });
      expect(await page.locator("button > i > svg").count()).toBe(3);
      expect(await page.locator("button").last().textContent()).toBe("×");
      for (const [index, label] of ["Zoom out", "Zoom in", "Close"].entries()) {
        const button = page.locator("button").nth(index);
        expect(await button.getAttribute("aria-label")).toBe(label); expect(await button.getAttribute("title")).toBe(label);
        expect(await button.boundingBox()).toMatchObject({ width: 44, height: 44 });
        expect(await button.locator("svg").getAttribute("aria-hidden")).toBe("true");
        expect(await button.locator("svg").evaluate(el => getComputedStyle(el).color)).toBe("rgb(0, 194, 255)");
        await button.click();
      }
      expect(await page.evaluate(() => (window as any).clicks)).toEqual(["zoom-out", "zoom-in", "close"]);
      await page.evaluate(() => { const w = window as any; w.ready.clear(); w.testState.version++; for (const fn of w.listeners) fn(); });
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).original)).toBe(true);
      // Destruction also restores original text while masks are selected.
      await page.evaluate(() => { const w = window as any; w.ready.set("close", { src: "close.png" }); w.testState.version++; for (const fn of w.listeners) fn(); w.destroyIcons(); });
      expect(await page.evaluate(() => document.querySelector("main")!.innerHTML === (window as any).original)).toBe(true);
      expect(await page.evaluate(() => (window as any).listeners.size)).toBe(0);
    } finally { await page.close(); }
  });

  it("registers only the named zoom and close call sites in both HUDs", () => {
    const flat = readFileSync("web/src/ui/hud.ts", "utf8"), deck = readFileSync("web/src/ui/deck/hud.ts", "utf8");
    expect(flat).toContain('textIcon("zoom-out", button("d2-btn", PAGE_COPY.zoomOut, "−"))');
    expect(flat).toContain('textIcon("zoom-in", button("d2-btn", PAGE_COPY.zoomIn, "+"))');
    expect(flat).toContain('textIcon("close", button("d2-close", D2_COPY.closeCard, "×"))');
    expect(deck).toContain('textIcon("zoom-out", control(PAGE_COPY.zoomOut, "−"))');
    expect(deck).toContain('textIcon("zoom-in", control(PAGE_COPY.zoomIn, "+"))');
  });
});

describe("optional second DOM mask", () => {
  it("overlays a solid 70% colour on fixed and inherited hues, independent of the ground, and restores exact bytes", async () => {
    const page = await browser.newPage({ viewport: { width: 300, height: 100 } });
    try {
      await page.setContent('<style>body{margin:0}button{display:inline-block;margin:10px;padding:0;border:0;width:40px;height:40px;font:40px/1 sans-serif;vertical-align:top;color:#00c2ff;background:transparent}svg{display:block}</style><button id="fixed" aria-label="Fixed"></button><button id="inherited" aria-label="Inherited"></button><button id="text" aria-label="Zoom in">+</button>');
      await page.evaluate(() => {
        const w = window as any;
        const mask = (half: boolean) => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 40;
          const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white";
          ctx.fillRect(half ? 20 : 0, 0, half ? 20 : 40, 40); return canvas.toDataURL();
        };
        w.realImages = true;
        w.ready = { src: mask(false), second: { src: mask(true) } }; w.listeners = new Set();
        w.testState = { version: 1, get: () => w.ready, subscribe: (fn: () => void) => { w.listeners.add(fn); return () => w.listeners.delete(fn); } };
      });
      await page.addScriptTag({ content: source });
      await page.evaluate(async () => {
        const w = window as any;
        for (const [id, colour] of [["fixed", "#ffb000"], ["inherited", "currentColor"]]) {
          const markup = `<svg viewBox="0 0 40 40" width="40" height="40" fill="${colour}" aria-hidden="true"><rect width="40" height="40"/></svg>`;
          document.getElementById(id!)!.innerHTML = w.domIcon("crown", markup, colour);
        }
        w.textIcon("zoom-in", document.getElementById("text"));
        w.before = [...document.querySelectorAll("button")].map(button => button.innerHTML);
        w.destroyIcons = w.mountIconDom(document);
        await Promise.all([w.ready.src, w.ready.second.src].map(src => new Promise<void>(resolve => { const img = new Image(); img.onload = () => resolve(); img.src = src; })));
      });
      const samples = async () => {
        const points = [];
        for (const id of ["fixed", "inherited", "text"]) {
          const box = (await page.locator(`#${id} g[data-icon-layer]`).first().boundingBox())!;
          points.push([Math.round(box.x + box.width / 4), Math.round(box.y + box.height / 2)], [Math.round(box.x + box.width * 3 / 4), Math.round(box.y + box.height / 2)]);
        }
        const png = (await page.screenshot()).toString("base64");
        return page.evaluate(async ({ png, points }) => {
          const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
          const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
          return points.map(([x, y]) => [...ctx.getImageData(x!, y!, 1, 1).data]);
        }, { png, points });
      };
      const expected = [[255, 176, 0, 255], [179, 123, 0, 255], [0, 194, 255, 255], [0, 136, 179, 255], [0, 194, 255, 255], [0, 136, 179, 255]];
      await page.evaluate(() => { document.body.style.background = "#ffffff"; });
      const light = await samples();
      await page.evaluate(() => { document.body.style.background = "#101010"; });
      const dark = await samples();
      expect(light).toEqual(dark);
      // Browser colour quantisation can differ from Pixi tint by one channel value.
      for (const [i, rgba] of light.entries()) for (const [c, value] of rgba.entries()) expect(Math.abs(value - expected[i]![c]!)).toBeLessThanOrEqual(1);
      expect(await page.locator("rect[fill^='color-mix(']").evaluateAll(nodes => nodes.map(el => getComputedStyle(el).opacity))).toEqual(["1", "1", "1"]);
      expect(await page.locator("#text").boundingBox()).toMatchObject({ width: 40, height: 40 });
      // Inherited colours still respond to runtime hover/theme changes.
      await page.evaluate(() => { document.getElementById("inherited")!.style.color = "rgb(255,176,0)"; });
      const recoloured = await samples(); expect(recoloured.slice(2, 4)).toEqual(light.slice(0, 2));
      await page.evaluate(() => { const w = window as any; w.ready = undefined; for (const fn of w.listeners) fn(); });
      expect(await page.locator("g[data-icon-layer]").count()).toBe(0);
      expect(await page.evaluate(() => [...document.querySelectorAll("button")].map(button => button.innerHTML))).toEqual(await page.evaluate(() => (window as any).before));
      await page.evaluate(() => (window as any).destroyIcons());
    } finally { await page.close(); }
  });
});
