// Usage: DIST_BASE=.. DIST_HEAD=.. FONT_DIR=.. PLAYWRIGHT=<playwright-core index.mjs> CHROMIUM=<binary> node render-pages.mjs <outDir>
// Base vs head renders of the Leaderboard (house 1v1), landing and Matches at 1280 and 390 wide, each also captured full-page,, in Roboto and Liberation Sans.
// Every API read is fetched once from the public site (no key, no game call) and the same bytes are replayed to every build,
// width and typeface. The only added data: four FIXTURE rows for the Gemini 4 Hydrogen handles, which have no matches yet,
// each with one rated match, inserted in rating order into the house 1v1 leaderboard read. Each build's rows carry the level its own server
// would report for an unplayed handle: base has no label row for them, so no level; head has the label row's level.
import { itemsCheck } from "./items-check.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT);
import { createHash } from "node:crypto"; import { mkdir, readFile, stat, writeFile } from "node:fs/promises"; import { extname, join } from "node:path";
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
const out = process.argv[2]; await mkdir(join(out, "api", "snapshot"), { recursive: true }); await mkdir(join(out, "pages"), { recursive: true });
const sha = b => createHash("sha256").update(b).digest("hex");
const snapDir = join(out, "api", "snapshot");
const cache = new Map(); const fetchLog = JSON.parse(await readFile(join(out, "api", "fetch-log.json"), "utf8").catch(() => "[]")); let n = fetchLog.length;
for (const e of fetchLog) { const bytes = await readFile(join(snapDir, `${String(e.n).padStart(3, "0")}.bin`)); if (sha(bytes) !== e.bodySha256) throw new Error(`snapshot read ${e.n} digest mismatch`); cache.set(e.request, Promise.resolve({ status: e.status, type: e.contentType ?? "application/octet-stream", bytes })); }
function upstream(method, path, body) {
  const key = `${method} ${path} ${body}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const r = await fetch("https://antwars.ai" + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body || undefined });
    const bytes = Buffer.from(await r.arrayBuffer()); const i = ++n, at = new Date().toISOString(), contentType = r.headers.get("content-type");
    await writeFile(join(snapDir, `${String(i).padStart(3, "0")}.bin`), bytes);
    fetchLog.push({ n: i, request: key, status: r.status, contentType, fetchedAt: at, bodySha256: sha(bytes), bytes: bytes.length });
    await writeFile(join(out, "api", "fetch-log.json"), JSON.stringify(fetchLog, null, 1));
    return { status: r.status, type: contentType ?? "application/octet-stream", bytes };
  })());
  return cache.get(key);
}
const LEVELS = ["low", "medium", "high", "xhigh"];
const HANDLES = LEVELS.map(l => `gemini-4-hydrogen-${l}`);
const json = c => JSON.parse(c.bytes.toString("utf8"));
// Seeded Waiting and Live now rows (FIXTURE): production has no match for these handles. Ratings as in the fixture rows below.
const seat = (h, i) => ({ displayName: `antwars/${h}`, modelLabel: "antigravity/gemini-4-hydrogen", rating: i % 2 === 0 ? 1516 : 1484, rd: 330, ratedMatches: 1 });
async function transform(build, method, path, body) {
  const u = new URL("https://x" + path);
  if (method === "GET" && u.pathname === "/watch/catalog") {
    const live = json(await upstream(method, path, body));
    const row = { ...(live.matches?.[0] ?? { rated: true, delaySeconds: 300 }), matchType: { kind: "index", size: 1 }, lobbyId: "FIXTURE-live-1", startedAt: Date.parse("2026-11-13T02:00:00Z"),
      colonies: [[seat(HANDLES[3], 3)], [seat(HANDLES[0], 0)]] };
    return { status: 200, type: "application/json", text: JSON.stringify({ ...live, matches: [...(live.matches ?? []), row] }), name: "live-catalog" };
  }
  if (method === "GET" && u.pathname === "/watch/queue") {
    const live = json(await upstream(method, path, body));
    const lobby = { mode: "house-1v1", size: 1, seated: 2, colonies: [[`antwars/${HANDLES[1]}`], [`antwars/${HANDLES[2]}`]], waitingSeconds: 25 };
    return { status: 200, type: "application/json", text: JSON.stringify({ ...live, lobbies: [...(live.lobbies ?? []), lobby] }), name: "queue" };
  }
  if (!(method === "POST" && u.pathname === "/api/leaderboard")) return null;
  const q = JSON.parse(body || "{}"); if (q.mode !== "house-1v1" || q.cursor) return null;
  const real = JSON.parse((await upstream(method, path, body)).bytes.toString("utf8"));
  const shape = real.entries.find(e => e.benchmark) ?? {};
  // The leaderboard lists only handles with at least one rated match, so each fixture row has one: a win for low and high,
  // a loss for medium and xhigh, with no stored replay.
  const fixtures = HANDLES.map((h, i) => { const won = i % 2 === 0; return { displayName: `antwars/${h}`, rating: won ? 1516 : 1484, rd: 330, ratedMatches: 1,
    thinkingLevel: build === "head" ? LEVELS[i] : null, serviceTier: null, benchmark: true, wins: won ? 1 : 0, losses: won ? 0 : 1, draws: 0,
    form: [{ result: won ? "W" : "L", replayId: null }] }; });
  const entries = [...real.entries].filter(e => !HANDLES.includes(e.displayName.slice("antwars/".length)));
  for (const f of fixtures) { const at = entries.findIndex(e => e.rating < f.rating); entries.splice(at < 0 ? entries.length : at, 0, f); }
    return { status: 200, type: "application/json", text: JSON.stringify({ ...real, entries }), name: `leaderboard-${q.scope ?? "all"}` };
}
const PAGES = [["leaderboard", "/?page=leaderboard&mode=house-1v1", 5000], ["landing", "/", 5000], ["matches", "/?page=matches", 5000]];
const dist = { base: process.env.DIST_BASE, head: process.env.DIST_HEAD };
const served = { base: {}, head: {} };
async function runSet(tf) {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM, env: { ...process.env, FONTCONFIG_FILE: `${process.env.FONT_DIR}/fonts-${tf}.conf` } });
  await mkdir(join(out, "pages", tf), { recursive: true });
  const report = [];
  for (const [page, path, wait] of PAGES) for (const build of ["base", "head"]) for (const [w, h] of [[1280, 800], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 900, hasTouch: w < 900 });
    const p = await ctx.newPage();
    await p.route("**/*", async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.pathname === "/" && req.resourceType() === "document") return route.fulfill({ status: 200, contentType: "text/html", body: (await readFile(join(dist[build], "index.html"), "utf8")).replace("<head>", '<head><meta name="antwar-lobbies" content="true"><meta name="antwar-public-matches" content="true">') });
      if (u.origin === "https://antwars.ai" && req.method() === "GET") { const f = join(dist[build], decodeURIComponent(u.pathname)); if (f.startsWith(dist[build] + "/") && await stat(f).then(x => x.isFile(), () => false)) return route.fulfill({ status: 200, contentType: TYPES[extname(f)] ?? "application/octet-stream", body: await readFile(f) }); }
      if (u.origin !== "https://antwars.ai") return route.abort();
      if (req.method() !== "GET" && req.method() !== "POST") return route.abort();
      const pth = u.pathname + u.search, body = req.postData() ?? "";
      const t = await transform(build, req.method(), pth, body);
      if (t) { if (!served[build][t.name]) { served[build][t.name] = true; await writeFile(join(out, "api", `served-${build}-${t.name}.json`), t.text); } return route.fulfill({ status: t.status, contentType: t.type, body: t.text }); }
      if (u.pathname.startsWith("/watch/live/")) return route.fulfill({ status: 404, body: "" });
      const c = await upstream(req.method(), pth, body); return route.fulfill({ status: c.status, contentType: c.type, body: c.bytes });
    });
    await p.goto(`https://antwars.ai${path}`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(wait);
    const files = [];
    const shoot = async tag => { const f = `pages/${tf}/${page}-${build}-${w}-${tag}.png`; await p.screenshot({ path: join(out, f) }); files.push(f); };
    let found = null;
    if (page === "leaderboard") {
      // Scroll the first Hydrogen row into view, then one screen.
      // One screen centred on the first fixture row (the 1516 pair), one on the last (the 1484 pair).
      const centre = (which) => p.evaluate((w) => { const rows = [...document.querySelectorAll("tr, li")].filter(r => /Gemini 4 Hydrogen|Unlisted model/.test(r.textContent) && /15(16)|14(84)/.test(r.textContent) && r.checkVisibility() && !r.querySelector("tr, li"));
        const row = w === "first" ? rows[0] : rows.at(-1); if (!row) return false; row.scrollIntoView({ block: "center" }); return true; }, which);
      found = await centre("first"); await p.waitForTimeout(800); await shoot("01");
      found = (await centre("last")) && found; await p.waitForTimeout(800); await shoot("02");
    } else {
      // The top screen, then one screen centred on the second section that shows the data: Matches, the seeded Live now
      // row; landing, the ranking card (its top ten, which the fixture rows do not reach).
      await shoot("01");
      const target = page === "matches" ? "last-label" : "ranking";
      await p.evaluate((t) => {
        const el = t === "last-label" ? [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && /^(Gemini 4 Hydrogen|Unlisted model)$/.test(x.textContent.trim())).at(-1)
          : [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && /^rated matches$/i.test(x.textContent.trim())).at(0);
        el?.scrollIntoView({ block: "center" }); }, target);
      await p.waitForTimeout(800); await shoot("02");
    }
    const f = files;
    const rows = await p.evaluate(() => {
      const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top))).size; };
      const clipped = el => { const b = el.getBoundingClientRect(); if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") return "own overflow";
        for (let a = el.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible" || s.overflow !== "visible") { const r = a.getBoundingClientRect(); if (b.right > r.right + 1 || b.left < r.left - 1) return `cut by ${a.tagName.toLowerCase()}`; } } return null; };
      // Every visible leaf naming a Hydrogen handle (head) or the unlisted name (base), with the level badges beside it.
      return [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && /^(Gemini 4 Hydrogen|Unlisted model)$/.test(x.textContent.trim())).map(name => {
        const box = name.closest("td, li") ?? name.parentElement;
        const badges = [...(box?.querySelectorAll("*") ?? [])].filter(x => x !== name && !x.children.length && /^(high|xhigh|medium|low|max|fast|standard)$/i.test(x.textContent.trim()));
        return { text: (box?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120), name: name.textContent.trim(), nameLines: lines(name), nameClipped: clipped(name),
          badges: badges.map(x => ({ text: x.textContent.trim(), lines: lines(x), clipped: clipped(x) })) };
      });
    });
    const items = await p.evaluate(itemsCheck);
    // The fonts Chromium actually drew the first label and the first level badge with (CSS.getPlatformFontsForNode).
    // Probed: every fixture label and every level badge beside it, plus the first visible heading, column heading, button and
    // body-text leaf, so each set reports the fonts actually drawn on the page as well as on the changed rows.
    await p.evaluate(() => { const leaves = [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && x.textContent.trim());
      let i = 0; for (const x of leaves.filter(x => /^(Gemini 4 Hydrogen|Unlisted model)$/.test(x.textContent.trim()))) { x.setAttribute("data-font-probe", `label ${++i}: ${x.textContent.trim()}`);
        let j = 0; for (const b of [...((x.closest("td, li") ?? x.parentElement)?.querySelectorAll("*") ?? [])].filter(b => b !== x && !b.children.length && /^(high|xhigh|medium|low|max|fast|standard)$/i.test(b.textContent.trim()))) b.setAttribute("data-font-probe", `label ${i} badge ${++j}: ${b.textContent.trim()}`); }
      for (const [k, sel] of [["heading", "h1, h2, h3"], ["column heading", "th"], ["button", "button, a[class*=button]"], ["body text", "p, td, li, span"]]) {
        const el = leaves.find(x => x.matches(sel) && !x.hasAttribute("data-font-probe")); el?.setAttribute("data-font-probe", `${k}: ${el.textContent.trim().slice(0, 40)}`); } });
    const fonts = {}; try { const cdp = await ctx.newCDPSession(p); await cdp.send("DOM.enable"); await cdp.send("CSS.enable"); const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-font-probe]" });
      for (const id of nodeIds) { const { attributes } = await cdp.send("DOM.getAttributes", { nodeId: id }); const k = attributes[attributes.indexOf("data-font-probe") + 1];
        fonts[k] = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: id })).fonts.map(f => `${f.postScriptName} (${f.isCustomFont ? "web font" : "installed"}, ${f.glyphCount} glyphs)`); } } catch (e) { fonts.error = String(e); }
    // The whole page, top to bottom, taken last, after every measurement. The site scrolls inside its own container,
    // so for this one image each scrolling container (overflow auto or scroll) is let grow to its full content height
    // in the page flow (overflow visible, no height cap, a fixed one made relative), which is the only change made to the page; the full image is for reading every row, while the
    // measurements above come from the unchanged page.
    await p.evaluate(() => { scrollTo(0, 0);
      const scrollers = [...document.querySelectorAll("body *")].filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
      for (const el of scrollers) { const fixed = getComputedStyle(el).position === "fixed"; el.scrollTop = 0;
        el.style.setProperty("overflow", "visible", "important"); el.style.setProperty("height", "auto", "important"); el.style.setProperty("max-height", "none", "important");
        if (fixed) { el.style.setProperty("position", "relative", "important"); el.style.setProperty("inset", "auto", "important"); } } });
    await p.waitForTimeout(500);
    { const full = `pages/${tf}/${page}-${build}-${w}-full.png`; await p.screenshot({ path: join(out, full), fullPage: true }); files.push(full); }
    report.push({ page, build, width: w, typeface: tf, file: f, scrolledToFixture: found, fixtureRows: rows, platformFonts: fonts, horizontalOverflow: await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      items: items.items, itemFailures: items.items.filter(x => x.wrapped || x.clipped), tight: items.items.filter(x => x.spare < 8 && !x.wrapped && !x.clipped), overlaps: items.overlaps });
    console.log(tf, build, w, "rows", rows.length, JSON.stringify(rows.map(r => [r.name, r.badges.map(b => b.text).join("+"), r.nameLines, r.nameClipped])), "itemFail", report.at(-1).itemFailures.length, "overlap", items.overlaps.length);
    await ctx.close();
  }
  await b.close();
  await writeFile(join(out, `render-report-${tf}.json`), JSON.stringify(report, null, 1));
}
for (const tf of ["roboto", "liberation-sans"]) await runSet(tf);
console.log("RENDER-DONE", fetchLog.length, "reads");
