/** Reproducible HUD renders from an explicitly supplied real recording excerpt or labelled fixture. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { servePage, CHROMIUM_FLAGS } from "./browser.ts";
import { measureLabels } from "./match-label-fit.ts";
const { values } = parseArgs({ options: {
  snapshot: { type: "string" }, build: { type: "string" }, output: { type: "string" },
  commit: { type: "string" }, label: { type: "string" }, provenance: { type: "string" },
  "font-dir": { type: "string" }, font: { type: "string", default: "Liberation Sans" },
  board: { type: "string", default: "3d" },
  width: { type: "string", default: "390" }, fixture: { type: "boolean", default: false },
} });
for (const key of ["snapshot", "build", "output", "commit", "label", "provenance", "font-dir"] as const) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
if (!["Roboto", "Liberation Sans"].includes(values.font!)) throw new Error("Choose a judged font");
if (!["2d", "3d"].includes(values.board!)) throw new Error("Choose 2d or 3d");
const width = Number(values.width);
if (![390, 1280].includes(width)) throw new Error("Choose width 390 or 1280");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = readFileSync(values.snapshot!), output = resolve(values.output!);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox", ...CHROMIUM_FLAGS] });
try {
  const served = await servePage(browser, { recording: "hud-evidence", width, height: 900, tilt: false, board: values.board as "2d" | "3d", webDir: resolve(values.build!) });
  const { page, errors } = served;
  await page.context().route("**/recordings/hud-evidence.bin", route => route.fulfill({ contentType: "application/octet-stream", body: bytes }));
  await page.context().route("**/evidence-font-*.ttf", route => {
    const weight = /evidence-font-(\d+)\.ttf/.exec(route.request().url())?.[1];
    return route.fulfill({ contentType: "font/ttf", body: readFileSync(join(values["font-dir"]!, `Roboto-${weight}.ttf`)) });
  });
  await page.goto(served.url);
  await page.waitForFunction(() => !!window.__antwar);
  await page.evaluate(() => window.__antwar.ready);
  const font = values.font!;
  const faces = font === "Roboto" ? [400, 600, 700].map(weight => `@font-face{font-family:Roboto;font-style:normal;font-weight:${weight};src:url('/evidence-font-${weight}.ttf')}`).join("\n") : "";
  await page.addStyleTag({ content: `${faces}\n:root{--aw-sans:'${font}',sans-serif !important}` });
  await page.evaluate(async () => { await document.fonts.ready; });
  // Incremental recording download is backpressured: step and draw the same fixed playback interval.
  for (let i = 0; i < 12; i++) { await page.clock.runFor(500); await page.evaluate(() => window.__antwar.frame()); }
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".d1-name,.d1-title,.d1-model,.d1-glabel,.d1-clock,.d1-ml,.d2-name-text,.d2-slabel,.d2-clock" });
  const fonts = [];
  for (const nodeId of nodeIds) fonts.push(...(await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts);
  const used = fonts.filter(f => f.glyphCount > 0);
  // The official static semibold font reports its weight in the family name, unlike regular/bold.
  const expectedFont = (f: typeof used[number]) => f.familyName === font || (font === "Roboto" &&
    f.familyName === "Roboto SemiBold" && f.postScriptName === "Roboto-SemiBold" && f.isCustomFont);
  if (!used.length || used.some(f => !expectedFont(f))) throw new Error(`Actual fonts differ: ${JSON.stringify(used)}`);
  const measured = await page.evaluate(() => {
    const selectors = ".d1-name,.d1-crow-name,.d1-crow-share,.d1-title,.d1-model,.d1-tag,.d1-ml,.d1-glabel,.d1-kicker,.d1-clock,.d1-legend,.d1-hold-text,.d1-match-meta,.sb-holder,.sb-rule,.sb-meta-item,.sb-value,.d2-name-text,.d2-slabel,.d2-clock";
    const labels = [...document.querySelectorAll<HTMLElement>(selectors)].filter(e => {
      if (!e.checkVisibility()) return false;
      // The desktop column headers replace the per-cell labels visually, not for screen readers.
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      return !(s.clipPath === "inset(50%)" && r.width <= 1 && r.height <= 1);
    }).map(e => {
      const rect = e.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(e);
      const text = range.getBoundingClientRect();
      const tops = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top));
      const lineHeight = parseFloat(getComputedStyle(e).lineHeight);
      const lines = Number.isFinite(lineHeight) ? Math.max(1, Math.round(text.height / lineHeight)) : new Set(tops).size;
      const spare = rect.width > 0 ? (rect.width - text.width) / rect.width : null;
      return { text: e.textContent, className: e.className, font: getComputedStyle(e).fontFamily, lines, textWidth: text.width, availableWidth: rect.width, spare,
        clipped: e.scrollWidth > e.clientWidth + 1, horizontalOverflow: rect.left < -1 || rect.right > innerWidth + 1,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    });
    // Retain raw fit findings above. An explicit field-limit fixture may intentionally elide
    // identity text; record its painted box and full hover text rather than suppressing clipping.
    const identityLabels = [...document.querySelectorAll<HTMLElement>(".sb-identity .d1-title,.sb-identity .d1-model")]
      .filter(e => e.checkVisibility()).map(e => {
        const box = e.getBoundingClientRect(), owner = e.closest(".sb-identity")!.getBoundingClientRect(), style = getComputedStyle(e);
        return { text: e.textContent, title: e.title, fontSize: style.fontSize, whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow, overflowX: style.overflowX, elided: e.scrollWidth > e.clientWidth + 1,
          contained: box.left >= Math.max(0, owner.left) - 1 && box.right <= Math.min(innerWidth, owner.right) + 1,
          box: { x: box.x, y: box.y, width: box.width, height: box.height }, owner: { x: owner.x, width: owner.width } };
      });
    return { labels, identityLabels, tightFits: labels.filter(x => x.spare !== null && x.spare < 0.08), board: window.__antwar.board(), width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
  const prefix = `${values.label}-${values.board}-${font.replaceAll(" ", "-")}-${width}`;
  const images: { file: string; sha256: string; view: string }[] = [];
  const fits: { view: string; items: ReturnType<typeof measureLabels> }[] = [];
  async function capture(view: string) {
    const items = await page.evaluate(measureLabels, ".d1-name,.d1-crow-name,.d1-crow-share,.d1-title,.d1-model,.d1-tag,.d1-ml,.d1-glabel,.d1-kicker,.d1-clock,.d1-legend,.sb-holder,.sb-rule,.sb-meta-item,.sb-value,.sb-history,.d1-btn,.d2-nav-link,.d2-name-text,.d2-slabel,.d2-clock");
    const file = `${prefix}-${view}.png`, image = await page.screenshot({ path: join(output, file) });
    images.push({ file, sha256: digest(image), view });
    fits.push({ view, items });
  }
  await capture("viewport");
  // Preserve real scrolling rather than changing the layout to fabricate a full-page image.
  const scrolls: { file: string; top: number; height: number; total: number; box: { x: number; y: number; width: number; height: number } }[] = [];
  if (width === 390) {
    const panel = page.locator(".d1-below");
    const box = await panel.count() ? await panel.boundingBox() : null;
    if (box) {
      const size = await panel.evaluate(e => ({ height: e.clientHeight, total: e.scrollHeight }));
      for (let top = 0, index = 0; top < size.total; top += size.height, index++) {
        await panel.evaluate((e, y) => { e.scrollTop = y; }, top);
        const actual = await panel.evaluate(e => e.scrollTop);
        await capture(`scroll-${index}`);
        scrolls.push({ file: images.at(-1)!.file, top: actual, ...size, box });
        if (actual + size.height >= size.total) break;
      }
    }
  }
  const record = { commit: values.commit, provenance: values.provenance, fixture: values.fixture, inputSha256: digest(bytes),
    buildManifestSha256: digest(readFileSync(join(values.build!, ".vite/manifest.json"))), viewport: { width, height: 900 }, requestedFont: font,
    actualFonts: used, images, scrolls, fits, measured, errors };
  writeFileSync(join(output, `${prefix}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ prefix, images: images.length, issues: measured.labels.filter(l => l.lines > 1 || l.clipped || l.horizontalOverflow), errors }));
  await page.context().close();
} finally { await browser.close(); }
