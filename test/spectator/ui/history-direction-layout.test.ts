import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";

// Mount the real HUD in a browser: at doubled browser text, 1200 and 1280 px are below 75em.
it("keeps mounted narrow History readable and sticky at doubled desktop text", async () => {
  const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 0 }, appType: "custom", logLevel: "silent" });
  server.middlewares.use((req, res, next) => {
    if (req.url !== "/history-test") { next(); return; }
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><html><head></head><body><div class='aw-hud'></div></body></html>");
  });
  await server.listen();
  const addr = server.httpServer!.address();
  if (!addr || typeof addr === "string") throw new Error("Vite did not bind a port");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox", "--blink-settings=defaultFontSize=32"] });
  const index = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
  const rootTokens = index.slice(index.indexOf(":root {"), index.indexOf("html, body")).trim();
  const roboto400 = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf", import.meta.url)).toString("base64");
  const roboto600 = readFileSync(new URL("../../../node_modules/@expo-google-fonts/roboto/600SemiBold/Roboto_600SemiBold.ttf", import.meta.url)).toString("base64");
  try {
    for (const width of [1200, 1280]) for (const font of ["Roboto", "Liberation Sans"]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.goto(`http://127.0.0.1:${addr.port}/history-test`);
        await page.addStyleTag({ content: `@font-face{font-family:Roboto;font-weight:400;src:url(data:font/ttf;base64,${roboto400})}@font-face{font-family:Roboto;font-weight:600;src:url(data:font/ttf;base64,${roboto600})}${rootTokens} html,body{margin:0;height:100%;overflow:hidden} .aw-hud{position:fixed;inset:0;overflow:auto} .d1{--aw-sans:'${font}',sans-serif!important}` });
        await page.addScriptTag({ type: "module", content: `
          import { mountDeckHud } from "/web/src/ui/deck/hud.ts";
          import { scoreFrame } from "/test/spectator/ui/score-band-frame.ts";
          const actions = { select() {}, selectAgent() {}, pointOrder() {}, hover() {}, focusMark() {}, openSheet() {} };
          const host = document.querySelector(".aw-hud");
          const hud = mountDeckHud({ doc: document, host, tips: [], replay: null, teamView: null, waiting: null, boardAspect: null, actions });
          const frame = scoreFrame(4);
          frame.story = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, kind: "queen_founded", tick: 10 + i * 10, colony: 0, agent: -1, x: 0, y: 0, queenId: i + 1 }));
          frame.commands = [{ id: 1, tick: 5000, agent: 0, colony: 0, call: "order", accepted: true, order: { kind: "attack", tileX: 0, tileY: 0, intent: "protect the colony while scouting nearby territory ".repeat(20).trim() } }];
          hud.update({ frame, board: "3d", connection: "live", selected: null, selectedAgent: -1, mode: null, stalled: false });
          document.body.dataset.hudReady = "true";
        ` });
        await page.waitForFunction(() => document.body.dataset.hudReady === "true");
        await page.evaluate(() => document.fonts.ready);
        const button = page.locator(".d1-team:not([hidden]) .sb-history").first();
        await button.scrollIntoViewIfNeeded();
        await button.click();
        expect(await button.getAttribute("aria-expanded")).toBe("true");
        const result = await page.evaluate(() => {
          const below = document.querySelector<HTMLElement>(".d1-below")!;
          const team = document.querySelector<HTMLElement>(".d1-team.is-history-open")!;
          const bar = team.querySelector<HTMLElement>(".sb-sticky-bar")!;
          const timeline = team.querySelector<HTMLElement>(".d1-timeline")!;
          const rows = [...timeline.querySelectorAll<HTMLElement>(".d1-tl-entry")];
          const name = bar.querySelector<HTMLElement>(".d1-name")!;
          const frame = document.querySelector<HTMLElement>(".d1-window")!;
          below.scrollTop = Math.max(0, team.offsetTop + 180);
          const br = below.getBoundingClientRect(), barRect = bar.getBoundingClientRect(), nameRect = name.getBoundingClientRect();
          const overlaps = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
          const textRects = (element: Element) => {
            const rects: DOMRect[] = [], splitWords: string[] = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const range = document.createRange(); range.selectNodeContents(node);
              rects.push(...[...range.getClientRects()].filter(r => r.width > .5 && r.height > .5));
              for (const word of (node.textContent ?? "").matchAll(/\S+/g)) {
                const wr = document.createRange(); wr.setStart(node, word.index!); wr.setEnd(node, word.index! + word[0].length);
                if (new Set([...wr.getClientRects()].filter(r => r.width > .5).map(r => Math.round(r.top))).size > 1) splitWords.push(word[0]);
              }
            }
            return { rects, splitWords };
          };
          const rowData = rows.map(row => {
            const what = row.querySelector<HTMLElement>(".d1-tl-what") ?? row;
            const box = what.getBoundingClientRect(), text = textRects(what);
            const hidden = [row, what].some(e => e.hidden || getComputedStyle(e).display === "none" || getComputedStyle(e).visibility === "hidden");
            let ancestorCut = false;
            for (let a = what.parentElement; a && a !== below; a = a.parentElement) {
              const cs = getComputedStyle(a), b = a.getBoundingClientRect();
              if (/^(hidden|clip)$/.test(cs.overflowX) && (box.left < b.left - 1 || box.right > b.right + 1)) ancestorCut = true;
              if (/^(hidden|clip)$/.test(cs.overflowY) && (box.top < b.top - 1 || box.bottom > b.bottom + 1)) ancestorCut = true;
            }
            return { cut: what.scrollWidth > what.clientWidth + 1 || ancestorCut, hidden, past: box.right > innerWidth + 1, overlapsName: text.rects.some(r => overlaps(r, nameRect)), splitWords: text.splitWords, lines: new Set(text.rects.map(r => Math.round(r.top))).size };
          });
          const labels = [name, ...timeline.querySelectorAll<HTMLElement>(".sb-history-kicker,.sb-detail-stat dt,.sb-detail-stat dd")];
          const labelData = labels.map(label => {
            const text = textRects(label), box = label.getBoundingClientRect();
            return { text: label.textContent, hidden: label.hidden || getComputedStyle(label).display === "none", cut: label.scrollWidth > label.clientWidth + 1 || box.right > innerWidth + 1, lines: new Set(text.rects.map(r => Math.round(r.top))).size };
          });
          return { scrollable: below.scrollHeight > below.clientHeight, scrolled: below.scrollTop, stickyDelta: Math.abs(barRect.top - br.top), barPosition: getComputedStyle(bar).position, rowData, labelData, windowH: frame.getBoundingClientRect().height, stripHidden: document.querySelector<HTMLElement>(".sb-history-strip")!.hidden };
        });
        expect(result.stripHidden).toBe(true);
        expect(result.scrollable).toBe(true);
        expect(result.scrolled).toBeGreaterThan(0);
        expect(result.barPosition).toBe("sticky");
        expect(result.stickyDelta).toBeLessThanOrEqual(2);
        expect(result.rowData.length).toBeGreaterThan(0);
        expect(result.rowData.filter(row => row.cut || row.hidden || row.past || row.overlapsName || row.splitWords.length)).toEqual([]);
        expect(result.rowData.some(row => row.lines > 1), "long History text wraps").toBe(true);
        expect(result.labelData.filter(label => label.hidden || label.cut || label.lines !== 1)).toEqual([]);
        expect(result.windowH).toBeGreaterThan(0);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
}, 60_000);
