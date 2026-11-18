import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { measureLabels } from "../../../web/capture/match-label-fit.ts";

describe("scrolling HUD fit evidence", () => {
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
            expect(label.overflow).toBe("hidden"); expect(label.ellipsis).toBe("ellipsis"); expect(label.fontSize).toBe("12px");
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
