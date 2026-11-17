/** Offline Recordings comparison: --dist DIR --input JSON --fonts DIR --out DIR --label base|head --browser FILE.
 * Input is a saved public /matches response or a separately labelled synthetic response. No browser request leaves locally served assets.
 * Capture both surfaces and widths in Roboto and Liberation Sans; output complete geometry, actual fonts and image hashes.
 * Each capture runs in two conditions: "overlay" (scrollbars take no width, unhinted glyph advances) and "live"
 * (a classic page scrollbar that takes width, and fully hinted whole-pixel glyph advances, as many desktop browsers render).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values: a } = parseArgs({ options: Object.fromEntries(["dist", "input", "fonts", "out", "label", "browser"].map(k => [k, { type: "string" as const }])) });
for (const k of ["dist", "input", "fonts", "out", "label", "browser"]) assert(a[k], `Missing --${k}`);
assert(/^[a-z0-9-]+$/.test(a.label!));
const dist = await realpath(a.dist!), out = resolve(a.out!), input = await readFile(a.input!);
const history: unknown = JSON.parse(input.toString());
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fontFiles = await Promise.all([400, 600, 700].map(async weight => ({ weight, bytes: await readFile(join(a.fonts!, `roboto-${weight}.ttf`)) })));
const fontCss = fontFiles.map(f => `@font-face { font-family: Roboto; font-style: normal; font-weight: ${f.weight}; src: url(data:font/ttf;base64,${f.bytes.toString("base64")}); }`).join("\n");
const origin = "http://recordings.local";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
await mkdir(out, { recursive: true });
// Full hinting on top of the system font configuration, read by the live-condition browser at launch.
const hintingDir = await mkdtemp(join(tmpdir(), "recordings-hinting-"));
const hintingConfig = join(hintingDir, "fonts.conf");
await writeFile(hintingConfig, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <match target="font">
    <edit name="antialias" mode="assign"><bool>true</bool></edit>
    <edit name="hinting" mode="assign"><bool>true</bool></edit>
    <edit name="hintstyle" mode="assign"><const>hintfull</const></edit>
    <edit name="autohint" mode="assign"><bool>false</bool></edit>
  </match>
</fontconfig>
`);
const browsers = {
  overlay: await chromium.launch({ executablePath: a.browser!, headless: true, args: ["--no-sandbox"] }),
  live: await chromium.launch({ executablePath: a.browser!, headless: true, args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"], env: { ...process.env, FONTCONFIG_FILE: hintingConfig } }),
};
const results = [];
try {
  for (const condition of ["overlay", "live"] as const) for (const font of ["Roboto", "Liberation Sans"]) for (const width of [1280, 390]) for (const surface of ["recordings", "landing"]) {
    const context = await browsers[condition].newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage(), errors: string[] = [], assets: Record<string, string> = {};
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", e => { if (e.type() === "error") errors.push(e.text()); });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      const json = (v: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(v) });
      if (url.pathname === "/matches") return json(history);
      if (url.pathname === "/watch/queue") return json({ waiting: [], lobbies: [] });
      if (url.pathname === "/watch/catalog") return json({ matches: [] });
      if (url.pathname === "/api/leaderboard") return json({ entries: [] });
      if (route.request().method() !== "GET" || (url.pathname !== "/" && !/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname))) {
        errors.push(`Unexpected request: ${url.pathname}`); return route.abort();
      }
      const file = await realpath(join(dist, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
      assert(file.startsWith(dist + sep) && types[extname(file)]);
      let body: Buffer | string = await readFile(file);
      assets[url.pathname] = hash(body);
      if (url.pathname === "/") body = body.toString().replace("<head>", '<head><meta name="antwar-public-matches" content="true"><meta name="antwar-lobbies" content="true">');
      return route.fulfill({ contentType: types[extname(file)], body });
    });
    try {
      await page.goto(`${origin}/${surface === "recordings" ? "?page=matches" : ""}`);
      await page.waitForSelector(".d1p-rec-name");
      // The live condition keeps the page's classic scrollbar even after the viewport grows to fit the whole card.
      await page.addStyleTag({ content: `${fontCss}\nbody, .d1p-rec4, .d1p-rec4 * { font-family: "${font}" !important; }${condition === "live" ? "\n.aw-page-host { overflow-y: scroll !important; }" : ""}` });
      await page.evaluate(async () => { await Promise.all([400, 600, 700].map(w => document.fonts.load(`${w} 12px Roboto`))); await document.fonts.ready; });
      const card = page.locator("section.d1p-card").filter({ has: page.getByRole("heading", { name: "Recordings", exact: true }) });
      assert.equal(await card.count(), 1);
      // Keep fixed bottom navigation outside the whole-card screenshot, including long saved lists.
      const bounds = await card.boundingBox(); assert(bounds);
      await page.setViewportSize({ width, height: Math.ceil(Math.max(1000, bounds.y + bounds.height + 100)) });
      const geometry = await card.evaluate(root => {
        const box = (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const nodes = [...root.querySelectorAll<HTMLElement>(".d1p-rec-head > *, .d1p-rec-name, .d1p-rec-level, .d1p-rec-count, .d1p-rec-rating, .d1p-rec-colony, .d1p-rec-meta span, .d1p-rec-replay, .d1p-rec-dash")].filter(e => e.checkVisibility() && e.getBoundingClientRect().width > 0);
        const items = nodes.map(e => {
          const style = getComputedStyle(e), rect = box(e), range = document.createRange(); range.selectNodeContents(e);
          const textRects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
          const lineTops: number[] = [];
          for (const r of textRects) if (!lineTops.some(y => Math.abs(y - r.top) < 2)) lineTops.push(r.top);
          const clone = e.cloneNode(true) as HTMLElement;
          Object.assign(clone.style, { position: "absolute", visibility: "hidden", width: "max-content", maxWidth: "none", minWidth: "0", flex: "none", whiteSpace: "nowrap" });
          e.parentElement!.append(clone); const needed = clone.getBoundingClientRect().width; clone.remove();
          const slot = e.closest(".d1p-rec-slot"), line = e.closest(".d1p-rec-player");
          return { text: e.textContent ?? "", rowId: e.closest<HTMLElement>("[data-rec-row]")?.dataset.recRow ?? null, cls: e.className, title: e.title, box: rect, needed,
            spare: 100 * (1 - needed / rect.width), lines: lineTops.length,
            clipped: e.scrollWidth > e.clientWidth + 1, whiteSpace: style.whiteSpace, overflow: style.overflowX, ellipsis: style.textOverflow,
            fontSize: style.fontSize, spacing: style.letterSpacing, colour: style.color,
            header: e.parentElement!.classList.contains("d1p-rec-head"), name: e.classList.contains("d1p-rec-name"),
            outsideSlot: slot ? rect.left < box(slot).left - 0.5 || rect.right > box(slot).right + 0.5 : false,
            siblingOverlap: line ? [...line.children].filter(other => other !== e).some(other => { const b = box(other); return Math.min(rect.right, b.right) - Math.max(rect.left, b.left) > 0.5 && Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) > 0.5; }) : false };
        });
        return { items, rows: root.querySelectorAll(".d1p-rec-rows > li").length,
          lost: root.querySelectorAll(".is-lost").length, dashes: root.querySelectorAll(".d1p-rec-dash").length,
          freeForAll: [...root.querySelectorAll(".d1p-rec-type")].filter(e => e.textContent?.includes("Free-for-all")).length,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          scrollbar: (host => host ? host.offsetWidth - host.clientWidth : -1)(document.querySelector<HTMLElement>(".aw-page-host")) };
      });
      const cdp = await context.newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".d1p-rec-name, .d1p-rec-head .d1p-rec-colony" });
      const fonts = [];
      for (const nodeId of nodeIds) fonts.push(...(await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts);
      const prefix = `${a.label}-${condition}-${font.toLowerCase().replaceAll(" ", "-")}-${width}-${surface}`;
      const snapshot = await card.ariaSnapshot();
      const missingAccessibleNames = geometry.items.filter(i => i.name && !snapshot.includes(i.text)).map(i => i.text);
      await writeFile(join(out, `${prefix}.aria.txt`), snapshot);
      const png = await card.screenshot({ path: join(out, `${prefix}.png`) });
      const headerSpare = geometry.items.filter(i => i.header && i.cls.includes("d1p-rec-colony")).map(i => ({ text: i.text, width: i.box.width, needed: i.needed, spare: i.spare }));
      console.log(`${condition}\t${font}\t${width}\t${surface}\t${headerSpare.map(h => `${h.text} ${h.spare.toFixed(2)}%`).join("\t")}`);
      results.push({ label: a.label, condition, font, width, surface, headerSpare, capturedAt: new Date().toISOString(), inputHash: hash(input), assets,
        fontHashes: fontFiles.map(f => ({ weight: f.weight, sha256: hash(f.bytes) })), fonts, geometry, errors, missingAccessibleNames,
        image: `${prefix}.png`, imageHash: hash(png), accessibility: `${prefix}.aria.txt` });
    } finally { await context.close(); }
  }
} finally {
  await Promise.all(Object.values(browsers).map(b => b.close()));
  await rm(hintingDir, { recursive: true, force: true });
  await writeFile(join(out, `${a.label}.json`), JSON.stringify(results, null, 2));
}
assert.equal(results.length, 16);
assert(results.every(r => r.condition === "live" ? r.geometry.scrollbar > 0 : r.geometry.scrollbar === 0), "Scrollbar condition not observed");
assert(results.every(r => r.errors.length === 0), "Render errors; inspect manifests");
if (a.label!.startsWith("head-")) {
  assert(results.every(r => !r.geometry.horizontalOverflow && r.missingAccessibleNames.length === 0), "Page overflow or incomplete accessible names");
  for (const r of results) {
    const names = r.geometry.items.filter(i => i.name);
    const headers = r.geometry.items.filter(i => i.header && i.cls.includes("d1p-rec-colony"));
    assert(names.length > 0 && headers.length === 4, "Missing names or shared headers");
    assert(names.every(i => i.lines === 1 && i.title === i.text && i.whiteSpace === "nowrap" && i.overflow === "hidden" && i.ellipsis === "ellipsis"), "Name lost one-line ellipsis or complete title");
    assert(headers.every(i => i.lines === 1 && !i.clipped && i.spare >= 8), "Header has less than 8% spare");
    assert(r.geometry.items.every(i => !i.outsideSlot && !i.siblingOverlap), "Player details overlap or escape their slot");
  }
}
assert(results.every(r => r.fonts.some(f => f.familyName === r.font && f.glyphCount > 0) && r.fonts.every(f => !f.glyphCount || f.familyName === r.font)), "Requested fonts not exclusively observed");
