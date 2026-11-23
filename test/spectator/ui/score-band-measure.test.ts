import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { measureLabels } from "../../../web/capture/match-label-fit.ts";
import { roster } from "../../../web/src/ui/deck/model.ts";
import { scoreFrame } from "./score-band-frame.ts";

describe("scrolling HUD fit evidence", () => {
  it("lets the outer host scroll to every narrow board control without losing panel scrolling", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const hostCss = readFileSync(new URL("../../../web/src/ui/ui.css", import.meta.url), "utf8");
    const roboto = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/600SemiBold/Roboto_600SemiBold.ttf", import.meta.url)).toString("base64");
    for (const defaultFontSize of [16, 32]) {
      const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox", `--blink-settings=defaultFontSize=${defaultFontSize}`] });
      try {
        // Half-width viewports exercise the layout produced by 200% desktop zoom.
        for (const width of [160, 195, 320, 390, 640]) for (const font of ["Roboto", "Liberation Sans"]) {
          const page = await browser.newPage({ viewport: { width, height: 844 } });
          try {
            await page.setContent("<span>Browser default</span>");
            expect(await page.locator("span").evaluate(e => getComputedStyle(e).fontSize)).toBe(`${defaultFontSize}px`);
            await page.setContent(`<style>@font-face{font-family:Roboto;font-weight:600;src:url(data:font/ttf;base64,${roboto})}html,body{margin:0;overflow:hidden}:root{--aw-sans:'${font}',sans-serif}${hostCss}${css}</style><div class="aw-hud"><main class="d1 d1-hud score-band"><section class="d1-frame"><div class="sb-metadata"><span class="sb-meta-item">rated match</span></div><div class="d1-window"></div><div class="d1-lane"><div class="d1-caption" data-kind="none"></div><div class="d1-transport" hidden></div><div class="d1-controls" role="group" aria-label="Board controls"><select class="aw-team-view" aria-label="View"><option>Full view</option><option>Very Large Colony</option><option>Lake Hodges Colony</option></select><button class="d1-btn" aria-label="Whole board">□</button><button class="d1-btn" aria-label="Zoom out">−</button><button class="d1-btn" aria-label="Zoom in">+</button><a class="d1-btn d1-btn-board" href="#board">2D</a></div></div></section><div class="d1-below"><section class="d1-deck"><p>Colony details</p><div style="height:1500px;flex:none"></div><button id="panel-end">Last detail</button></section></div></main></div>`);
            await page.evaluate(() => document.fonts.ready);
            const host = page.locator(".aw-hud"), button = page.locator(".d1-btn-board");
            const initial = await button.boundingBox();
            expect(initial).not.toBeNull();
            if (initial!.x + initial!.width > width) {
              const lane = await page.locator(".d1-lane").boundingBox();
              await page.mouse.move(Math.min(width - 5, 60), lane!.y + lane!.height / 2);
              await page.mouse.wheel(1000, 0);
              await expect.poll(() => host.evaluate(e => e.scrollLeft), { timeout: 2000 }).toBeGreaterThan(0);
              const scrolled = await button.boundingBox();
              expect(scrolled!.x).toBeGreaterThanOrEqual(0);
              expect(scrolled!.x + scrolled!.width).toBeLessThanOrEqual(width + 1);
            }
            // Keyboard activation and horizontal wheel access must both survive the outer layout boundary.
            await page.evaluate(() => {
              document.querySelector<HTMLElement>(".aw-hud")!.scrollLeft = 0;
              document.querySelectorAll<HTMLElement>(".d1-controls button,.d1-controls a").forEach(e => e.addEventListener("click", event => { event.preventDefault(); e.dataset.activated = "yes"; }));
            });
            await page.locator(".aw-team-view").focus();
            for (const control of await page.locator(".d1-controls button,.d1-controls a").all()) {
              await page.keyboard.press("Tab");
              expect(await control.evaluate(e => document.activeElement === e)).toBe(true);
              const focused = await control.boundingBox();
              // Chromium may leave a partially visible focused control in place, as it does in the legacy HUD.
              if (focused!.x < 0 || focused!.x + focused!.width > width + 1) {
                await page.mouse.move(Math.max(5, Math.min(width - 5, focused!.x + 2)), focused!.y + focused!.height / 2);
                await page.mouse.wheel(focused!.x < 0 ? -1000 : 1000, 0);
                await expect.poll(async () => { const r = await control.boundingBox(); return r!.x >= -1 && r!.x + r!.width <= width + 1; }, { timeout: 2000 }).toBe(true);
              }
              const box = await control.boundingBox();
              expect(box!.x).toBeGreaterThanOrEqual(-1);
              expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
              expect(await control.evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
              await page.keyboard.press("Enter");
              expect(await control.getAttribute("data-activated")).toBe("yes");
            }
            await page.evaluate(() => { document.querySelector<HTMLElement>(".aw-hud")!.scrollLeft = 0; });
            const panel = page.locator(".d1-below");
            await panel.evaluate(e => { e.scrollTop = e.scrollHeight; });
            expect(await panel.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
            const end = await page.locator("#panel-end").boundingBox(), panelBox = await panel.boundingBox();
            expect(end!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
            expect(end!.y + end!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
          } finally { await page.close(); }
        }
      } finally { await browser.close(); }
    }
  }, 60_000);
  it("keeps zoom-narrow score groups readable with the browser default font setting", async () => {
    const tokens = readFileSync(new URL("../../../web/src/design-system/tokens.css", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    for (const defaultFontSize of [16, 32]) {
      const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox", `--blink-settings=defaultFontSize=${defaultFontSize}`] });
      try {
        const page = await browser.newPage();
        await page.setContent("<span>Browser default</span>");
        expect(await page.locator("span").evaluate(e => getComputedStyle(e).fontSize)).toBe(`${defaultFontSize}px`);
        const metrics = [["workers", "Workers", "224"], ["soldiers", "Soldiers", "58"], ["flyers", "Flyers", "0"], ["food", "Food", "4,457"], ["next", "Next spawn", "—"], ["ants", "Ants", "282/512"], ["queen-kills", "Queen kills", "—"]];
        const card = `<section class="d1-team"><div class="sb-identity"><header class="d1-team-head"><h2 class="d1-name">Lake Hodges Colony</h2><span class="d1-team-members">◇ ◇ ◇ ◇</span></header><div class="d1-who"><span class="d1-title">Claude Sonnet 5.5</span><span class="d1-model">GPT-6.1 Terra</span></div></div><div class="d1-econ has-flyers">${metrics.map(([key, label, value]) => `<div class="d1-cell sb-${key}"><span class="d1-ml">${label}</span><span class="d1-mv">${value}</span></div>`).join("")}</div><button class="sb-history">≡</button></section>`;
        for (const width of [160, 195, 320, 390]) for (const font of ["Roboto", "Liberation Sans"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(`<style>body{margin:0}:root{--aw-sans:'${font}',sans-serif}${tokens}${css}.d1{position:relative;inset:auto}.d1-frame{margin-top:8px;--d1-window-h:80px}</style><main class="d1 score-band"><section class="d1-frame"><p class="d1-legend"><span class="d1-dot"></span><span class="d1-mode">LIVE</span><span class="d1-legend-rest"> · Waiting for new data</span></p><div class="d1-window"></div></section><div class="d1-below"><div class="sb-metadata"><span class="sb-meta-item">rated match</span><span class="sb-meta-item">300 s policy delay</span></div><div class="d1-lane"></div><div class="d1-deck"><header class="sb-clock-map"><p class="d1-clock">10:04 · 19:56 left</p><div class="d1-map"><span class="d1-glabel">Map</span><span class="d1-map-name">Three Crossings v2</span></div></header>${card}</div></div></main>`);
          await page.evaluate(() => document.fonts.ready);
          const items = await page.evaluate(measureLabels, ".d1-name,.d1-title,.d1-model,.d1-ml,.d1-mv,.d1-clock,.d1-map-name,.d1-glabel,.d1-mode,.d1-legend-rest,.sb-meta-item,.sb-history");
          const visible = items.filter(i => i.target);
          expect(visible.filter(i => i.clipped || i.outside), `${width}px ${font} default${defaultFontSize}: cut`).toEqual([]);
          expect(visible.filter(i => i.overlaps.some(index => visible.some(other => other.index === index))), `${width}px ${font} default${defaultFontSize}: overlap`).toEqual([]);
          if (width >= 320) expect(visible.filter(i => i.lines > 1), "ordinary labels stay whole").toEqual([]);
          const brokenWords = await page.locator(".d1-name,.d1-title,.d1-model,.d1-ml,.d1-legend-rest,.sb-meta-item").evaluateAll(nodes => nodes.flatMap(e => {
            const broken: string[] = [], walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
              const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
              if (new Set([...range.getClientRects()].map(r => Math.round(r.top))).size > 1) broken.push(match[0]);
            }
            return broken;
          }));
          expect(brokenWords, "zoom may wrap words, never split them").toEqual([]);
          const history = await page.locator(".sb-history").boundingBox();
          expect(history!.width).toBeGreaterThanOrEqual(44);
          expect(history!.height).toBeGreaterThanOrEqual(44);
          expect(await page.locator(".d1-title").evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(13);
          expect(await page.locator(".d1-mode").evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12);
        }
      } finally { await browser.close(); }
    }
  }, 60_000);
  it("keeps metric cells inside the deck across the narrow-to-desktop boundary", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      for (const flyers of [false, true]) for (const font of ["Roboto", "Liberation Sans"]) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
        const metrics = [["workers", "Workers"], ["soldiers", "Soldiers"], ...(flyers ? [["flyers", "Flyers"]] : []), ["food", "Food"], ["next", "Next spawn"], ["ants", "Ants"], ["queens", "Queens"], ["queen-kills", "Queen kills"]];
        const team = `<section class="d1-team"><div class="sb-identity"><header class="d1-team-head"><h2 class="d1-name">Very Large Colony</h2></header></div><div class="d1-econ${flyers ? " has-flyers" : ""}">${metrics.map(([key, label]) => `<div class="d1-cell sb-${key}"><span class="d1-ml">${label}</span><span class="d1-mv">123</span></div>`).join("")}</div><button class="sb-history">≡</button></section>`;
        await page.setContent(`<style>body{margin:0}*{box-sizing:border-box}:root{--aw-sans:'${font}',sans-serif}${css}</style><main class="d1 d1-hud score-band"><div class="d1-below"><div class="d1-deck">${team}</div></div></main>`);
        for (const width of [390, 1099, ...Array.from({ length: 181 }, (_, i) => 1100 + i)]) {
          await page.setViewportSize({ width, height: 900 });
          const result = await page.evaluate(() => {
            const deck = document.querySelector(".d1-deck")!, b = deck.getBoundingClientRect();
            const cells = [...document.querySelectorAll(".d1-name,.d1-cell,.sb-history")].map(e => e.getBoundingClientRect());
            return { display: getComputedStyle(deck).display, outside: cells.some(r => r.left < b.left - 1 || r.right > b.right + 1 || r.right > innerWidth), overlap: cells.some((a, i) => cells.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)) };
          });
          expect(result, `${width}px, ${font}, flyers=${flyers}`).toEqual({ display: width < 1200 ? "flex" : "grid", outside: false, overlap: false });
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }, 60_000);

  it("aligns partial queen-health fill and dark text masks for all colonies", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const lamps = [0, 1, 2, 3].map(c => `<span class="d1-lamps c${c}"><span class="d1-lamp" style="--d1-f:40%"><span class="d1-lamp-fill"></span><span class="d1-lamp-hp">40</span><span class="d1-lamp-hp is-on">40</span></span></span>`).join("");
      await page.setContent(`<style>${css}</style><main class="d1 score-band">${lamps}</main>`);
      for (const width of [390, 1100, 1199, 1200, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const masks = await page.locator(".d1-lamp").evaluateAll(nodes => nodes.map(e => ({ fill: getComputedStyle(e.querySelector(".d1-lamp-fill")!).clipPath, text: getComputedStyle(e.querySelector(".is-on")!).clipPath })));
        expect(masks).toEqual(Array.from({ length: 4 }, () => ({ fill: "inset(0px 60% 0px 0px)", text: "inset(0px 60% 0px 0px)" })));
      }
    } finally { await browser.close(); }
  });
  it("lays shuffled numbered seats left to right in both colonies at both widths and font stacks", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const frame = scoreFrame(2, 8), seats = [1, 1, 2, 4, 4, 3, 3, 2];
    frame.board!.agents.forEach((a, index) => { a.identity = { displayName: `player-${a.colony} #${seats[index]}`, elo: 1500 }; });
    const groups = roster(frame).groups;
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const teams = groups.map(g => `<section class="d1-team"><div class="sb-identity"><header class="d1-team-head"><h2 class="d1-name">${g.colony === 0 ? "Very Large" : "Lake Hodges"} Colony</h2><span class="d1-team-members">${g.members.map(m => `<button class="d1-member" data-seat="${seats[m.index]}"><span class="sb-seat-badge">${m.badge}</span><span class="sb-idle"></span></button>`).join("")}</span></header></div></section>`).join("");
      await page.setContent(`<style>body{margin:0;font:13px/1.35 sans-serif}*{box-sizing:border-box}${css}</style><main class="d1 score-band"><div class="d1-deck">${teams}</div></main>`);
      for (const width of [390, 1280]) for (const font of ["Roboto", "Liberation Sans"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(async font => {
          document.body.style.fontFamily = `'${font}',sans-serif`;
          await document.fonts.load(`13px '${font}'`);
          await document.fonts.ready;
        }, font);
        const rows = await page.locator(".d1-team-members").evaluateAll(nodes => nodes.map(n => [...n.children].map(e => ({ seat: Number(e.getAttribute("data-seat")), x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y }))));
        for (const row of rows) {
          expect(row.map(m => m.seat)).toEqual([1, 2, 3, 4]);
          expect(row.map(m => m.x)).toEqual(row.map(m => m.x).sort((a, b) => a - b));
          expect(Math.max(...row.map(m => m.y)) - Math.min(...row.map(m => m.y))).toBeLessThan(1);
        }
      }
    } finally { await browser.close(); }
  });
  it("keeps phone headers whole and fills every metric row through the Queens edge", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      for (const flyers of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const cells = [["workers", "Workers"], ["soldiers", "Soldiers"], ...(flyers ? [["flyers", "Flyers"]] : []), ["food", "Food"], ["next", "Next spawn"], ["ants", "Ants"]];
        const team = (name: string) => `<section class="d1-team"><div class="sb-identity"><header class="d1-team-head"><h2 class="d1-name">${name}</h2><span class="d1-team-members">${Array.from({ length: 4 }, () => '<button class="d1-member"><span class="sb-seat-badge"><svg width="16" height="16"></svg></span><span class="sb-idle"><svg width="14" height="14"></svg></span></button>').join("")}</span><span class="d1-team-player">Player</span></header><ol class="d1-agents"><li>Identity divider</li></ol></div><div class="d1-econ${flyers ? " has-flyers" : ""}">${cells.map(([key, label]) => `<div class="d1-cell sb-${key}"><span class="d1-ml">${label}</span><span class="d1-mv">123</span></div>`).join("")}<div class="d1-cell sb-queens"><span>Queens</span><span class="sb-queen-value">100</span></div><div class="d1-cell sb-queen-kills"><span class="d1-ml">Queen kills</span><span class="d1-mv">—</span></div></div><button class="sb-history">≡</button></section>`;
        await page.setContent(`<style>body{margin:0;font:13px/1.35 'Liberation Sans'}*{box-sizing:border-box}:root{--aw-ink-bright:white}${css}</style><main class="d1 score-band"><div class="d1-deck">${team("Very Large Colony")}${team("Lake Hodges Colony")}</div></main>`);
        const geometry = await page.locator(".d1-team").evaluateAll(teams => teams.map(team => {
          const rect = (e: Element) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, width: b.width, height: b.height }; };
          const members = [...team.querySelectorAll(".d1-member")].map(rect);
          const cells = [...team.querySelectorAll(".d1-cell:not(.sb-queens)")].map(rect);
          const rows: typeof cells[] = [];
          for (const cell of cells) { let row = rows.find(r => Math.abs(r[0]!.y - cell.y) < 1); if (!row) rows.push(row = []); row.push(cell); }
          rows.sort((a, b) => a[0]!.y - b[0]!.y);
          return { head: rect(team.querySelector(".d1-team-head")!), name: rect(team.querySelector(".d1-name")!), members, rows,
            queens: rect(team.querySelector(".sb-queens")!), divider: rect(team.querySelector(".d1-agents")!) };
        }));
        for (const g of geometry) {
          expect(g.members.every(m => Math.abs(m.y - g.name.y) < 2), "badges must share the colony name line").toBe(true);
          expect(g.members.at(-1)!.right).toBeLessThanOrEqual(g.head.right + 1);
          expect(g.rows.map(r => r.length)).toEqual(flyers ? [4, 3] : [3, 3]);
          for (const row of g.rows) {
            expect(Math.min(...row.map(c => c.x))).toBeCloseTo(g.queens.x, 0);
            expect(Math.max(...row.map(c => c.right))).toBeCloseTo(g.queens.right, 0);
            expect(Math.max(...row.map(c => c.width)) - Math.min(...row.map(c => c.width))).toBeLessThan(1);
          }
          expect(g.divider.right).toBeCloseTo(g.queens.right, 0);
        }
        expect(geometry[0]!.head.height).toBeCloseTo(geometry[1]!.head.height, 0);
        await page.close();
      }
    } finally { await browser.close(); }
  });

  it("puts persistent selected emphasis on the badge, not its empty idle slot", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>:root{--aw-ink-bright:rgb(248,252,252);--aw-raise:rgb(38,50,55)}${css}</style><main class="score-band"><button class="d1-member" aria-expanded="true"><span class="sb-seat-badge"><svg width="16" height="16"></svg></span><span class="sb-idle"></span></button></main>`);
      await page.mouse.move(500, 500);
      const selected = await page.locator(".d1-member").evaluate(e => ({ button: getComputedStyle(e).backgroundColor,
        badge: getComputedStyle(e.querySelector(".sb-seat-badge")!).outlineStyle, idle: getComputedStyle(e.querySelector(".sb-idle")!).outlineStyle }));
      expect(selected.button).toBe("rgba(0, 0, 0, 0)"); expect(selected.badge).toBe("solid"); expect(selected.idle).toBe("none");
    } finally { await browser.close(); }
  });
  it("reserves idle slots and lets the footer Key expand without clipping or breaking its controls", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
        const footer = `<footer class="d1-foot"><span class="sb-rules-key"><a class="d2-link">Rules</a><button class="d2-link sb-key-toggle" aria-expanded="false" aria-controls="key">Key</button></span><a>Inspired by creator</a><div id="key" class="sb-key" hidden><p>Warm or cool = colony · colour and shape = agent · square badge = squad · ring = mark · crown = queen</p><p>Thoughts: an agent's stated intent, not observed action; only spectators see them. Marks are the only messages between teammates; a mark directs only squads whose agent ordered follow_trail, and moves no other ants.</p></div></footer>`;
        const seats = Array.from({ length: 4 }, (_, i) => `<button class="d1-member" aria-label="Seat ${i}"><span class="sb-seat-badge"><svg width="16" height="16"></svg></span><span class="sb-idle" aria-hidden="true"><svg width="14" height="14"></svg></span></button>`).join("");
        const deck = `<section class="d1-deck"><div class="sb-identity"><div class="d1-team-members">${seats}</div></div></section>`;
        const frame = `<section class="d1-frame"><div class="sb-metadata">Match</div><div class="d1-window"></div><div class="d1-lane"></div></section>`;
        await page.setContent(`<style>body{margin:0;font:12px/18px 'Liberation Sans',sans-serif}*{box-sizing:border-box}:root{--aw-bg:#111;--aw-ink:#eee;--aw-ink-3:#bbb;--aw-ink-bright:white}${css}</style><main class="d1 d1-hud score-band"><header class="d1-top">Match</header>${width === 390 ? frame + '<div class="d1-below">' + deck + footer + '</div>' : '<div class="d1-below">' + deck + '</div>' + frame + footer}</main>`);
        const buttons = page.locator(".d1-member");
        const before = await buttons.evaluateAll(nodes => nodes.map(e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }));
        await buttons.first().focus();
        await page.locator(".sb-idle").evaluateAll(nodes => nodes.forEach(e => e.classList.add("is-idle")));
        expect(await buttons.evaluateAll(nodes => nodes.map(e => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }))).toEqual(before);
        expect(await buttons.first().evaluate(e => e === document.activeElement)).toBe(true);
        expect(await page.locator(".sb-idle").first().evaluate(e => ({ width: e.getBoundingClientRect().width, visibility: getComputedStyle(e).visibility }))).toEqual({ width: 14, visibility: "visible" });
        const closed = await page.locator(".d1-foot").evaluate(e => e.getBoundingClientRect().height);
        await page.locator(".sb-key").evaluate(e => { (e as HTMLElement).hidden = false; });
        await page.locator(".sb-key p").last().scrollIntoViewIfNeeded();
        const geometry = await page.evaluate(() => {
          const foot = document.querySelector(".d1-foot")!, key = document.querySelector(".sb-key")!, button = document.querySelector(".sb-key-toggle")!;
          const f = foot.getBoundingClientRect(), k = key.getBoundingClientRect(), b = button.getBoundingClientRect();
          const group = document.querySelector(".sb-rules-key")!.getBoundingClientRect();
          return { footHeight: f.height, keyInside: k.top >= f.top && k.bottom <= f.bottom + 1, keyWidth: k.width,
            buttonHeight: b.height, buttonWidth: b.width, groupRight: group.right, groupWhiteSpace: getComputedStyle(button.parentElement!).whiteSpace,
            visibleBottom: k.bottom <= innerHeight + 1, pageWidth: document.documentElement.scrollWidth };
        });
        expect(geometry.footHeight).toBeGreaterThan(closed);
        expect(geometry.keyInside).toBe(true); expect(geometry.visibleBottom).toBe(true);
        expect(geometry.keyWidth).toBeLessThanOrEqual(width);
        expect(geometry.groupRight).toBeLessThanOrEqual(width);
        expect(geometry.groupWhiteSpace).toBe("nowrap"); expect(geometry.pageWidth).toBe(width);
        if (width === 390) { expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44); expect(geometry.buttonWidth).toBeGreaterThanOrEqual(44); }
        await page.close();
      }
    } finally { await browser.close(); }
  });

  it("keeps expanded-history labels and mark icons whole beside long arrival orders", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.setContent(`<style>body{margin:0;font:12px/18px 'Liberation Sans',sans-serif}*{box-sizing:border-box}${css}</style>
          <div class="d1-timeline" style="width:${width === 390 ? 374 : 300}px;margin:8px">
          <div class="d1-tl-entry d1-log is-arrival"><span class="d1-when"></span><span class="d1-log-who"></span><span class="d1-log-icon"></span>
          <span class="d1-tl-what"><span class="d1-log-lead">On arrival</span><span class="d1-log-text">attack Lake Hodges Colony's Queen 1</span><span class="d1-log-intent">“attack exposed enemy queens”</span><span class="d1-log-mark"><span class="d1-log-mark-word">mark</span><span class="d1-log-icon"><svg width="13" height="13" viewBox="0 0 13 13"><path d="M1 1L12 12"/></svg></span><span class="d1-log-text">ATTACK · soldier · 10 requested · 10 answered</span></span></span></div>
          <div class="d1-tl-entry d1-log is-refused"><span class="d1-when">10:00</span><span class="d1-log-who"></span><span class="d1-log-icon"></span><span class="d1-tl-what"><span class="d1-log-text">attack</span></span><span class="d1-log-refused">Refused</span></div>
          </div>`);
        const labels = await page.evaluate(measureLabels, ".d1-log-lead,.d1-log-mark-word,.d1-when,.d1-log-refused");
        const fixed = labels.filter(item => item.target && item.text);
        expect(fixed.map(item => item.text)).toEqual(["On arrival", "mark", "10:00", "Refused"]);
        for (const label of fixed) {
          expect(label.lines, label.text).toBe(1);
          expect(label.clipped, label.text).toBe(false);
          expect(label.outside, label.text).toBe(false);
          expect(label.overlaps, label.text).toEqual([]);
        }
        const icon = await page.locator(".d1-log-mark > .d1-log-icon").boundingBox();
        expect(icon?.width).toBe(13);
        expect(await page.locator(".d1-log-mark-word").innerText()).toBe("mark");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.close();
      }
    } finally { await browser.close(); }
  });
  it("contains supported-limit identity text without shrinking labels or badges", async () => {
    const css = readFileSync(new URL("../../../web/src/ui/deck/deck.css", import.meta.url), "utf8");
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    const model = "W".repeat(64), username = "N".repeat(32);
    try {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.setContent(`<style>body{margin:0;font:12px/16px Arial}*{box-sizing:border-box}${css}</style>
          <main class="score-band"><div class="d1-below"><section class="d1-deck">
          <article class="d1-team"><div class="sb-identity"><header class="d1-team-head">
          <span class="d1-team-player"><span class="d1-team-player-name"><span class="d1-title">${username}</span> <span class="d1-model">${model}</span></span><span class="d1-tags"><span class="d1-tag">MAX</span><span class="d1-tag">FAST</span></span></span>
          </header></div></article>
          <article class="d1-team"><div class="sb-identity"><ol class="d1-agents"><li class="d1-agent-item"><button class="d1-agent"><span class="d1-who">
          <span class="d1-title-box"><span class="d1-title">${username}</span></span><span class="d1-model-box"><span class="d1-model">${model}</span><span class="d1-tags"><span class="d1-tag">MAX</span><span class="d1-tag">FAST</span></span></span>
          </span></button></li></ol></div></article>
          </section></div></main>`);
        const labels = await page.locator(".d1-title,.d1-model,.d1-tag").evaluateAll(nodes => nodes.map(e => {
          const r = e.getBoundingClientRect(), owner = e.closest(".sb-identity")!.getBoundingClientRect(), s = getComputedStyle(e);
          return { text: e.textContent, left: r.left, right: r.right, ownerLeft: owner.left, ownerRight: owner.right,
            whiteSpace: s.whiteSpace, overflow: s.overflowX, ellipsis: s.textOverflow, fontSize: s.fontSize, width: r.width, clipped: e.scrollWidth > e.clientWidth + 1 };
        }));
        for (const label of labels) {
          expect(label.left).toBeGreaterThanOrEqual(label.ownerLeft - 1);
          expect(label.right).toBeLessThanOrEqual(Math.min(width, label.ownerRight) + 1);
          expect(label.whiteSpace).toBe("nowrap");
          if (label.text === model || label.text === username) {
            expect(label.overflow).toBe("hidden"); expect(label.ellipsis).toBe("ellipsis"); expect(label.fontSize).toBe(width < 560 ? "13px" : "12px");
          } else {
            expect(label.fontSize).toBe("10px"); expect(label.clipped).toBe(false); expect(label.width).toBeGreaterThan(25);
          }
        }
        expect(labels.filter(n => n.text === model).every(n => n.clipped)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.close();
      }
    } finally { await browser.close(); }
  });
  it("ignores text outside its scroll clip without hiding genuine painted overlaps", async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`<style>body{margin:0;font:20px/24px sans-serif}.fixed{position:absolute;top:10px;left:0}.scroll{position:absolute;top:50px;left:0;width:300px;height:100px;overflow:hidden}.scrolled{position:relative;top:-40px;display:block;height:80px}.overlap{position:absolute;top:0;left:2px}</style><span class="fixed">Board</span><div class="scroll"><span class="scrolled">History</span></div>`);
      const clipped = await page.evaluate(measureLabels, ".fixed,.scrolled");
      expect(clipped.find(i => i.text === "Board")!.overlaps).toEqual([]);
      expect(clipped.find(i => i.text === "History")!.visibleRects).toEqual([]);
      await page.evaluate(() => {
        (document.querySelector(".scrolled") as HTMLElement).style.top = "0";
        const duplicate = document.createElement("span"); duplicate.className = "overlap"; duplicate.textContent = "Overlap";
        document.querySelector(".scroll")!.append(duplicate);
      });
      const actual = await page.evaluate(measureLabels, ".scrolled,.overlap");
      expect(actual.find(i => i.text === "History")!.overlaps.length).toBeGreaterThan(0);
      expect(actual.find(i => i.text === "Overlap")!.overlaps.length).toBeGreaterThan(0);
    } finally { await browser.close(); }
  });
});
