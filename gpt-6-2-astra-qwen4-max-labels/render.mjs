// Usage: node render.mjs <built web dir> <base|head> <out dir> <leaderboard page JSON> <Chromium executable>
import { chromium } from "playwright-core";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, sep } from "node:path";
const [dist, label, out, liveFile, chrome] = process.argv.slice(2);
const dir = await realpath(dist);
const live = JSON.parse(await readFile(liveFile, "utf8"));
// FIXTURE rows: the eight new handles have no rated matches yet, so each is appended with a placeholder rating.
// Level and tier are what the head server returns for these handles (their fixed label values).
const FIXTURES = [["gpt-6-2-astra-low","low","fast"],["gpt-6-2-astra-medium","medium","fast"],["gpt-6-2-astra-high","high","fast"],["gpt-6-2-astra-xhigh","xhigh","fast"],["gpt-6-2-astra-max","max","fast"],["qwen4-max-low","low",null],["qwen4-max-high","high",null],["qwen4-max-xhigh","xhigh",null]]
  .map(([h, l, t], i) => ({ displayName: `antwars/${h}`, rating: 1500 - i, rd: 350, ratedMatches: 1, thinkingLevel: l, serviceTier: t, benchmark: true, wins: null, losses: null, draws: null, form: [] }));
const entries = [...live.entries, ...FIXTURES];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon" };
const ORIGIN = "http://localhost:4718";
const browser = await chromium.launch({ executablePath: chrome, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const manifest = [];
for (const [width, height] of [[1280, 900], [390, 844]]) {
  const touch = width < 900;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await ctx.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
    if (url.pathname === "/api/leaderboard") {
      const body = req.postDataJSON();
      const res = body.mode === "house-1v1" && !body.cursor ? { entries } : { entries: [] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    try {
      const real = await realpath(join(dir, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
      if (!real.startsWith(dir + sep)) return route.abort();
      let bytes = await readFile(real);
      if (url.pathname === "/") bytes = bytes.toString("utf8").replace("<head>", `<head><meta name="antwar-public-matches" content="true"><meta name="antwar-lobbies" content="false">`);
      return route.fulfill({ status: 200, contentType: types[extname(real)] ?? "application/octet-stream", body: bytes });
    } catch { return route.abort(); }
  });
  await page.goto(`${ORIGIN}/?page=leaderboard`);
  await page.waitForFunction(() => { const t = document.querySelectorAll("#aw-leaderboard-page section"); return t.length > 0 && [...t].every(s => s.getAttribute("aria-busy") === "false"); }, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  // The rows the viewport draws: the wide table on a desktop, the narrow list on a phone.
  const rows = await page.evaluate(() => [...document.querySelectorAll("#aw-leaderboard-page tbody tr, #aw-leaderboard-page .d1p-rows > li")].filter(e => e.checkVisibility()).map(r => [r.textContent.replace(/\s+/g, " ").trim()]));
  const file = `${label}-leaderboard-${width}-top.png`;
  await page.screenshot({ path: join(out, file) });
  const shots = [file];
  for (const [name, index] of [["retired-row", rows.findIndex(r => r[0].includes("Qwen3.8 Max"))], ["fixture-rows", rows.length - 8]]) {
    const f = `${label}-leaderboard-${width}-${name}.png`;
    // The rows of interest plus two rows of context either side, captured as one element-bounded clip.
    const box = await page.evaluate(([i, n]) => {
      const trs = [...document.querySelectorAll("#aw-leaderboard-page tbody tr, #aw-leaderboard-page .d1p-rows > li")].filter(e => e.checkVisibility());
      const first = trs[Math.max(0, i - (n === 1 ? 2 : 1))], last = trs[Math.min(trs.length - 1, i + n + 1)];
      // A phone layout may draw a row's cells without a box for the row itself: measure the union of its cells.
      const rect = el => { const rs = [el, ...el.querySelectorAll("*")].map(n => n.getBoundingClientRect()).filter(r => r.width && r.height);
        return { top: Math.min(...rs.map(r => r.top)), bottom: Math.max(...rs.map(r => r.bottom)) }; };
      first.style.scrollMarginTop = "96px"; first.scrollIntoView({ block: "start" });
      const a = rect(first), b = rect(last), t = first.closest("section").getBoundingClientRect();
      return { x: t.left, y: a.top, width: t.width, height: b.bottom - a.top, scrollY: window.scrollY };
    }, [index, name === "retired-row" ? 1 : 7]);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, f), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, height - box.y) } }); shots.push(f);
  }
  const pick = rows.filter(r => /GPT-6\.2 Astra|Qwen|Unlisted/.test(r[0])).map(r => r[0]);
  const files = [];
  for (const f of shots) files.push({ file: f, sha256: createHash("sha256").update(await readFile(join(out, f))).digest("hex") });
  manifest.push({ label, viewport: `${width}x${height}`, files, rowCount: rows.length, rowsOfInterest: pick, errors });
  await ctx.close();
}
await browser.close();
await writeFile(join(out, `${label}-manifest.json`), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.map(m => ({ files: m.files.map(f => f.file + ' ' + f.sha256.slice(0, 12)), rows: m.rowCount, interest: m.rowsOfInterest, errors: m.errors })), null, 1));
