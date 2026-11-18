// Usage: DIST_BASE=.. DIST_HEAD=.. FONT_DIR=.. PLAYWRIGHT=<playwright-core index.mjs> CHROMIUM=<binary> FIXTURE_REC=<fixture.raw> node render-pages.mjs <outDir> [typeface]
// Review renders, base vs head, of every surface that shows the new handles' labels or qwen3-8-max's retired badge:
// Leaderboard (house 1v1), Matches (Waiting, Live now, Recordings), the landing page, and the replay HUD, at 1280 and 390
// wide, in Roboto and Liberation Sans. Every public read is fetched once from https://antwars.ai (no key, no game call)
// and the same bytes are replayed to every build, width and typeface. Added data, all labelled FIXTURE in the manifest:
// - Leaderboard: eight rows for the new handles (no rated match exists yet), one rated match each, in rating order.
// - Matches: two Waiting lobbies and two Live now matches seating the eight handles; one Recordings row for the fixture
//   recording below.
// - HUD: one recording made from the real stored index match claude-haiku-5-5 vs qwen3-8-max (REAL_REC), its two seats
//   renamed gpt-6-2-astra-medium and qwen4-max-xhigh (make-fixture-recording.ts); play and board are the real match's.
// Real rows: qwen3-8-max's leaderboard row, its real Recordings row (second history page, reached with Load more) and its
// real replay's HUD.
import { itemsCheck } from "./items-check.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT);
import { createHash } from "node:crypto"; import { mkdir, readFile, stat, writeFile } from "node:fs/promises"; import { extname, join } from "node:path";
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".json": "application/json", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
const out = process.argv[2]; const ONLY = process.argv[3];
const snapDir = join(out, "api", "snapshot"); await mkdir(snapDir, { recursive: true }); await mkdir(join(out, "pages"), { recursive: true });
const sha = b => createHash("sha256").update(b).digest("hex");
const cache = new Map(); const fetchLog = JSON.parse(await readFile(join(out, "api", "fetch-log.json"), "utf8").catch(() => "[]")); let n = fetchLog.length;
for (const e of fetchLog) { const bytes = await readFile(join(snapDir, `${String(e.n).padStart(3, "0")}.bin`)); if (sha(bytes) !== e.bodySha256) throw new Error(`snapshot read ${e.n} digest mismatch`); cache.set(e.request, Promise.resolve({ status: e.status, type: e.contentType ?? "application/octet-stream", bytes })); }
function upstream(method, path, body) {
  const key = `${method} ${path} ${body}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const r = await fetch("https://antwars.ai" + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body || undefined, redirect: "manual" });
    const bytes = Buffer.from(await r.arrayBuffer()); const i = ++n, at = new Date().toISOString(), contentType = r.headers.get("content-type");
    await writeFile(join(snapDir, `${String(i).padStart(3, "0")}.bin`), bytes);
    fetchLog.push({ n: i, request: key, status: r.status, contentType, fetchedAt: at, bodySha256: sha(bytes), bytes: bytes.length });
    await writeFile(join(out, "api", "fetch-log.json"), JSON.stringify(fetchLog, null, 1));
    return { status: r.status, type: contentType ?? "application/octet-stream", bytes };
  })());
  return cache.get(key);
}
const REAL_REC = "2026-11-12T09-58-04-540Z-134589846669134";
const FIX_REC = "2026-11-18T02-00-00-000Z-100000000000001";
const FIX_BYTES = await readFile(process.env.FIXTURE_REC);
const ASTRA = ["low", "medium", "high", "xhigh", "max"].map(l => ({ h: `gpt-6-2-astra-${l}`, level: l, tier: "fast", label: "openai/gpt-6.2-astra" }));
const QWEN = ["low", "high", "xhigh"].map(l => ({ h: `qwen4-max-${l}`, level: l, tier: null, label: "qwen-token-plan/qwen4-max" }));
const NEW = [...ASTRA, ...QWEN]; const NEW_SET = new Set(NEW.map(x => x.h)); const by = Object.fromEntries(NEW.map(x => [x.h, x]));
const json = c => JSON.parse(c.bytes.toString("utf8"));
// FIXTURE ratings: one rated match each, a win (1516) or a loss (1484), RD 330, as an unplayed handle's first result.
const ratingOf = i => (i % 2 === 0 ? 1516 : 1484);
const liveSeat = (h, i) => ({ displayName: `antwars/${h}`, modelLabel: by[h].label, thinkingLevel: by[h].level, serviceTier: by[h].tier, rating: ratingOf(i), rd: 330, ratedMatches: 1 });
async function transform(build, method, path, body) {
  const u = new URL("https://x" + path);
  if (method === "GET" && u.pathname === "/watch/catalog") {
    const live = json(await upstream(method, path, body));
    const row = (id, a, b, ia, ib) => ({ lobbyId: id, startedAt: Date.parse("2026-11-18T02:30:00Z"), rated: true, delaySeconds: 300, matchType: { kind: "index", size: 1 }, colonies: [[liveSeat(a, ia)], [liveSeat(b, ib)]] });
    const rows = [row("FIXTURE-live-1", "gpt-6-2-astra-medium", "qwen4-max-xhigh", 1, 7), row("FIXTURE-live-2", "gpt-6-2-astra-max", "qwen4-max-low", 4, 5)];
    return { status: 200, type: "application/json", text: JSON.stringify({ ...live, matches: [...(live.matches ?? []), ...rows] }), name: "live-catalog" };
  }
  if (method === "GET" && u.pathname === "/watch/queue") {
    const live = json(await upstream(method, path, body));
    const lobby = (a, b, s) => ({ mode: "house-1v1", size: 1, seated: 2, colonies: [[`antwars/${a}`], [`antwars/${b}`]], waitingSeconds: s });
    const lobbies = [lobby("gpt-6-2-astra-low", "qwen4-max-high", 25), lobby("gpt-6-2-astra-high", "gpt-6-2-astra-xhigh", 40)];
    return { status: 200, type: "application/json", text: JSON.stringify({ ...live, lobbies: [...(live.lobbies ?? []), ...lobbies] }), name: "queue" };
  }
  if (method === "GET" && u.pathname === "/matches" && !u.searchParams.has("pageToken")) {
    // Page 2 holds the real qwen3-8-max row; the fixture row goes on page 1, as the newest match, so Load more is still real.
    const page = json(await upstream(method, path, body)); const real = (await historyRow());
    const seat = (s, h) => ({ ...s, handle: `antwars/${h}`, modelLabel: by[h].label, thinkingLevel: by[h].level, serviceTier: by[h].tier, startRating: null });
    const fix = { ...real, id: FIX_REC, startedAt: "2026-11-18T02:00:00.000Z", endedAt: "2026-11-18T02:30:00.000Z", simulationEndedAt: "2026-11-18T02:29:59.000Z",
      seats: real.seats.map(s => seat(s, s.handle === "antwars/claude-haiku-5-5" ? "gpt-6-2-astra-medium" : "qwen4-max-xhigh")) };
    return { status: 200, type: "application/json", text: JSON.stringify({ ...page, matches: [fix, ...page.matches] }), name: "matches-page1" };
  }
  if (method === "GET" && u.pathname === `/replays/${FIX_REC}`) return { status: 200, type: "application/octet-stream", bytes: FIX_BYTES, name: "fixture-recording" };
  if (method === "GET" && u.pathname === `/watch/ratings/${FIX_REC}`) {
    const r = json(await upstream("GET", `/watch/ratings/${REAL_REC}`, ""));
    const ren = { "antwars/claude-haiku-5-5": "antwars/gpt-6-2-astra-medium", "antwars/qwen3-8-max": "antwars/qwen4-max-xhigh" };
    return { status: 200, type: "application/json", text: JSON.stringify({ ...r, ratings: r.ratings.map(x => ({ ...x, displayName: ren[x.displayName] ?? x.displayName })) }), name: "fixture-ratings" };
  }
  if (!(method === "POST" && u.pathname === "/api/leaderboard")) return null;
  const q = JSON.parse(body || "{}"); if (q.mode !== "house-1v1" || q.cursor) return null;
  const real = json(await upstream(method, path, body));
  // Each build's rows carry what its own server reports for an unplayed listed handle: base has no label row, so no level
  // or tier; head has the label row's level, and Fast for the Astra rows.
  const fixtures = NEW.map((x, i) => { const won = i % 2 === 0; return { displayName: `antwars/${x.h}`, rating: ratingOf(i), rd: 330, ratedMatches: 1,
    thinkingLevel: build === "head" ? x.level : null, serviceTier: build === "head" ? x.tier : null, benchmark: true, wins: won ? 1 : 0, losses: won ? 0 : 1, draws: 0,
    form: [{ result: won ? "W" : "L", replayId: null }] }; });
  const entries = real.entries.filter(e => !NEW_SET.has(e.displayName.slice("antwars/".length)));
  for (const f of fixtures) { const at = entries.findIndex(e => e.rating < f.rating); entries.splice(at < 0 ? entries.length : at, 0, f); }
  return { status: 200, type: "application/json", text: JSON.stringify({ ...real, entries }), name: `leaderboard-${q.scope ?? "all"}` };
}
let pageTwo = null;
async function historyRow() {
  if (!pageTwo) { const p1 = json(await upstream("GET", "/matches", "")); pageTwo = json(await upstream("GET", `/matches?pageToken=${encodeURIComponent(p1.nextPageToken)}`, "")); }
  const row = pageTwo.matches.find(m => m.id === REAL_REC); if (!row) throw new Error("real qwen3-8-max row not on page 2"); return row;
}
// A changed label: the model name alone, or the HUD's model line, the name with its badges in brackets.
const NAMES = /^(GPT-6\.2 Astra|Qwen4 Max|Qwen3\.8 Max|Unlisted model)( \(.*\))?$/;
const BADGES = /^((low|medium|high|xhigh|max|fast|retired)[\s·]*)+$/i;
const ALL_PAGES = [["leaderboard", "/?page=leaderboard&mode=house-1v1"], ["matches", "/?page=matches"], ["landing", "/"],
  ["hud-retired", `/?replay=${REAL_REC}&board=2d`], ["hud-fixture", `/?replay=${FIX_REC}&board=2d`]];
const PAGES = process.env.ONLY_PAGES ? ALL_PAGES.filter(([pg]) => process.env.ONLY_PAGES.split(",").includes(pg)) : ALL_PAGES;
const dist = { base: process.env.DIST_BASE, head: process.env.DIST_HEAD };
const served = { base: {}, head: {} };
async function runSet(tf) {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"], env: { ...process.env, FONTCONFIG_FILE: `${process.env.FONT_DIR}/fonts-${tf}.conf` } });
  await mkdir(join(out, "pages", tf), { recursive: true });
  // A rerun of some pages replaces only their entries in the existing report.
  const report = process.env.ONLY_PAGES ? JSON.parse(await readFile(join(out, `render-report-${tf}.json`), "utf8").catch(() => "[]")).filter(e => !PAGES.some(([pg]) => pg === e.page)) : [];
  for (const [page, path] of PAGES) for (const build of ["base", "head"]) for (const [w, h] of [[1280, 800], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 900, hasTouch: w < 900, serviceWorkers: "block" });
    const p = await ctx.newPage(); const errors = []; p.on("pageerror", e => errors.push(String(e).slice(0, 200)));
    await p.route("**/*", async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.pathname === "/" && req.resourceType() === "document") return route.fulfill({ status: 200, contentType: "text/html", body: (await readFile(join(dist[build], "index.html"), "utf8")).replace("<head>", '<head><meta name="antwar-lobbies" content="true"><meta name="antwar-public-matches" content="true">') });
      if (u.origin === "https://antwars.ai" && req.method() === "GET") { const f = join(dist[build], decodeURIComponent(u.pathname)); if (f.startsWith(dist[build] + "/") && await stat(f).then(x => x.isFile(), () => false)) return route.fulfill({ status: 200, contentType: TYPES[extname(f)] ?? "application/octet-stream", body: await readFile(f) }); }
      if (u.origin !== "https://antwars.ai") return route.abort();
      if (req.method() !== "GET" && req.method() !== "POST") return route.abort();
      const pth = u.pathname + u.search, body = req.postData() ?? "";
      try {
        const t = await transform(build, req.method(), pth, body);
        if (t) { if (t.text && !served[build][t.name]) { served[build][t.name] = true; await writeFile(join(out, "api", `served-${build}-${t.name}.json`), t.text); } return route.fulfill({ status: t.status, contentType: t.type, body: t.bytes ?? t.text }); }
        if (u.pathname.startsWith("/watch/live/") || u.pathname.startsWith("/watch/status/")) return route.fulfill({ status: 404, body: "" });
        const c = await upstream(req.method(), pth, body); return route.fulfill({ status: c.status, contentType: c.type, body: c.bytes });
      } catch (e) { errors.push(`serve ${pth}: ${e}`); return route.abort(); }
    });
    await p.goto(`https://antwars.ai${path}`, { waitUntil: "domcontentloaded" });
    const files = []; const shots = [];
    const leaves = (re) => p.evaluate((src) => [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && new RegExp(src).test(x.textContent.trim())).length, re.source);
    const centreOn = (src, which) => p.evaluate(([src, which]) => { const re = new RegExp(src);
      const els = [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && re.test(x.textContent.trim()));
      const el = which === "first" ? els[0] : els.at(-1); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; }, [src, which]);
    // Per screenshot: every visible changed label (a NAMES leaf) with the badges beside it, every item checked by
    // items-check.mjs, and the fonts Chromium drew each probed leaf with (CSS.getPlatformFontsForNode).
    const cdp = await ctx.newCDPSession(p); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const measure = async (tag) => {
      const rows = await p.evaluate(([ns, bs]) => { const N = new RegExp(ns), B = new RegExp(bs, "i");
        const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top))).size; };
        const clipped = el => { const b = el.getBoundingClientRect(); if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") return "own overflow";
          for (let a = el.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible") { const r = a.getBoundingClientRect(); if (b.right > r.right + 1 || b.left < r.left - 1) return `cut by ${a.tagName.toLowerCase()}`; } } return null; };
        const inView = el => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; };
        return [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && inView(x) && N.test(x.textContent.trim())).map(name => {
          const box = name.closest("td, li, .aw-deck-player, [class*=player], [class*=seat]") ?? name.parentElement;
          const badges = [...(box?.querySelectorAll("*") ?? [])].filter(x => x !== name && !x.children.length && B.test(x.textContent.trim()));
          return { text: (box?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 140), name: name.textContent.trim(), nameLines: lines(name), nameClipped: clipped(name),
            badges: badges.map(x => ({ text: x.textContent.trim(), lines: lines(x), clipped: clipped(x) })) }; });
      }, [NAMES.source, BADGES.source]);
      const items = await p.evaluate(itemsCheck).catch(e => ({ items: [], overlaps: [], error: String(e) }));
      await p.evaluate(([ns, bs]) => { const N = new RegExp(ns), B = new RegExp(bs, "i"); document.querySelectorAll("[data-font-probe]").forEach(e => e.removeAttribute("data-font-probe"));
        const inView = el => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; };
        const lv = [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && inView(x) && x.textContent.trim());
        let i = 0; for (const x of lv.filter(x => N.test(x.textContent.trim()))) { x.setAttribute("data-font-probe", `label ${++i}: ${x.textContent.trim()}`);
          let j = 0; for (const c of [...((x.closest("td, li, .aw-deck-player, [class*=player], [class*=seat]") ?? x.parentElement)?.querySelectorAll("*") ?? [])].filter(c => c !== x && !c.children.length && B.test(c.textContent.trim()))) c.setAttribute("data-font-probe", `label ${i} badge ${++j}: ${c.textContent.trim()}`); }
        for (const [k, sel] of [["heading", "h1, h2, h3"], ["column heading", "th"], ["button", "button, a[class*=button]"], ["body text", "p, td, li, span"]]) {
          const el = lv.find(x => x.matches(sel) && !x.hasAttribute("data-font-probe")); el?.setAttribute("data-font-probe", `${k}: ${el.textContent.trim().slice(0, 40)}`); } }, [NAMES.source, BADGES.source]);
      const fonts = {}; try { const { root } = await cdp.send("DOM.getDocument", { depth: 0 }); const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-font-probe]" });
        for (const id of nodeIds) { const { attributes } = await cdp.send("DOM.getAttributes", { nodeId: id }); const k = attributes[attributes.indexOf("data-font-probe") + 1];
          fonts[k] = (await cdp.send("CSS.getPlatformFontsForNode", { nodeId: id })).fonts.map(f => `${f.postScriptName} (${f.isCustomFont ? "web font" : "installed"}, ${f.glyphCount} glyphs)`); } } catch (e) { fonts.error = String(e); }
      shots.push({ tag, labels: rows, platformFonts: fonts, horizontalOverflow: await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        items: items.items, itemFailures: items.items.filter(x => x.wrapped || x.clipped), tight: items.items.filter(x => x.spare < 8 && !x.wrapped && !x.clipped), overlaps: items.overlaps, checkError: items.error ?? null });
    };
    const shoot = async tag => { const f = `pages/${tf}/${page}-${build}-${w}-${tag}.png`; await p.waitForTimeout(600); await p.screenshot({ path: join(out, f), timeout: 180000 }); files.push(f); await measure(tag); };
    const NEWNAME = build === "head" ? "^(GPT-6\\.2 Astra|Qwen4 Max)$" : "^Unlisted model$";
    if (page === "leaderboard") {
      await p.waitForTimeout(5000);
      await centreOn(NEWNAME, "first"); await shoot("01-fixture-first");
      await centreOn(NEWNAME, "last"); await shoot("02-fixture-last");
      await centreOn("^Qwen3\\.8 Max$", "first"); await shoot("03-qwen3-8-max");
    } else if (page === "matches") {
      await p.waitForTimeout(5000); await shoot("01-top");
      await centreOn(NEWNAME, "last"); await shoot("02-fixture-recording");
      // Load more until the real qwen3-8-max row is listed (it is on the second history page).
      for (let k = 0; k < 4 && !(await leaves(/^Qwen3\.8 Max$/)); k++) { const more = p.getByRole("button", { name: /load more/i }); if (!(await more.count())) break; await more.first().scrollIntoViewIfNeeded(); await more.first().click(); await p.waitForTimeout(4000); }
      await centreOn("^Qwen3\\.8 Max$", "first"); await shoot("03-qwen3-8-max");
    } else if (page === "landing") {
      await p.waitForTimeout(5000); await shoot("01-top");
      await p.evaluate(() => [...document.querySelectorAll("body *")].filter(x => !x.children.length && x.checkVisibility() && /^rated matches$/i.test(x.textContent.trim()))[0]?.scrollIntoView({ block: "center" })); await shoot("02-ranking");
    } else {
      // The replay HUD at 3:00 into the match: the slider is moved there and playback paused, as a viewer would.
      let ready = false; for (let i = 0; i < 240 && !ready; i++) { ready = await p.evaluate(() => { const s = document.querySelector('input[aria-label="Replay position"]'); return !!s && Number(s.max) > 0; }).catch(() => false); if (!ready) await p.waitForTimeout(500); }
      const at3 = () => p.evaluate(() => /^3:0\d/.test(document.querySelector(".aw-replay-time")?.textContent ?? "") && !/Seeking/.test(document.body.innerText));
      for (let attempt = 0; attempt < 4 && !(await at3()); attempt++) {
        await p.evaluate(() => { const s = document.querySelector('input[aria-label="Replay position"]'); if (!s) return; s.value = "180000"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); });
        await p.waitForTimeout(2000); for (let i = 0; i < 120 && !(await at3()); i++) await p.waitForTimeout(500); }
      const pause = p.getByRole("button", { name: /^pause/i }); if (await pause.count()) await pause.first().click().catch(() => {});
      await p.waitForTimeout(1500); await shoot("01-hud");
      shots.at(-1).replayTime = await p.evaluate(() => document.querySelector(".aw-replay-time")?.textContent ?? null); shots.at(-1).ready = ready;
      // On a phone the agents list sits below the board: one more screen, scrolled to it.
      // On a phone the agents list is a short pane under the board that scrolls on its own: one screen with the pane
      // scrolled to each agent row.
      if (w < 900) for (const [which, tag] of [["first", "02-agent-1"], ["last", "03-agent-2"]]) {
        await p.evaluate((which) => { const els = [...document.querySelectorAll(".d2-agents *")].filter(x => !x.children.length && x.checkVisibility() && /^(GPT-6\.2 Astra|Qwen4 Max|Qwen3\.8 Max|Unlisted model|Claude Haiku 5\.5)$/.test(x.textContent.trim()));
          const el = which === "first" ? els[0] : els.at(-1); const pane = el?.closest(".d2-pane"); if (el && pane) pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8; }, which);
        await shoot(tag); shots.at(-1).replayTime = await p.evaluate(() => document.querySelector(".aw-replay-time")?.textContent ?? null); }
    }
    // The whole page, taken last, after every measurement: each scrolling container is let grow to its content height,
    // the only change made to the page. Not taken for the HUD, which is one fixed screen.
    if (!page.startsWith("hud")) {
      await p.evaluate(() => { scrollTo(0, 0); const scrollers = [...document.querySelectorAll("body *")].filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1);
        for (const el of scrollers) { const fixed = getComputedStyle(el).position === "fixed"; el.scrollTop = 0; el.style.setProperty("overflow", "visible", "important"); el.style.setProperty("height", "auto", "important"); el.style.setProperty("max-height", "none", "important");
          if (fixed) { el.style.setProperty("position", "relative", "important"); el.style.setProperty("inset", "auto", "important"); } } });
      await p.waitForTimeout(500); const full = `pages/${tf}/${page}-${build}-${w}-full.png`; await p.screenshot({ path: join(out, full), fullPage: true, timeout: 180000 }); files.push(full);
    }
    report.push({ page, build, width: w, typeface: tf, files, shots, errors });
    const sum = shots.map(s => `${s.tag}: labels ${JSON.stringify(s.labels.map(r => [r.name, r.badges.map(x => x.text).join("+"), r.nameLines, r.nameClipped, ...r.badges.map(x => x.lines + (x.clipped ? "C" : ""))]))} fail ${s.itemFailures.length} ov ${s.overlaps.length} tight ${s.tight.length} hov ${s.horizontalOverflow}`).join(" | ");
    console.log(new Date().toISOString().slice(11, 19), tf, page, build, w, sum, errors.length ? JSON.stringify(errors) : "");
    await writeFile(join(out, `render-report-${tf}.json`), JSON.stringify(report, null, 1));
    await ctx.close();
  }
  await b.close();
}
for (const tf of ONLY ? [ONLY] : ["roboto", "liberation-sans"]) await runSet(tf);
console.log("RENDER-DONE", fetchLog.length, "reads");
