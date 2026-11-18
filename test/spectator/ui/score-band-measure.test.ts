import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { measureLabels } from "../../../web/capture/match-label-fit.ts";

describe("scrolling HUD fit evidence", () => {
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
