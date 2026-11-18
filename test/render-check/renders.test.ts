// The render check's marked renders (web/render-check/check.ts, shoot) on small pages in Chromium: they show the
// layout exactly as judged. The marks never change the page's size, and bringing a finding into view never scrolls a
// box that clips.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { RULE_LIMITS, judgePage } from "../../web/render-check/rules.ts";
import { shoot, type Mark } from "../../web/render-check/check.ts";

let browser: Browser;
let out: string;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] });
  out = await mkdtemp(join(tmpdir(), "render-check-"));
});
afterAll(async () => { await browser?.close(); await rm(out, { recursive: true, force: true }); });

async function marked(page: Page): Promise<Mark[]> {
  const j = await page.evaluate(judgePage, RULE_LIMITS);
  return j.failures.flatMap(f => f.box && f.anchor ? [{ box: f.box, anchor: f.anchor, label: f.rule, held: false }] : []);
}

it("draws marks past a phone's right edge without widening its layout", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0"><div style="width:390px;overflow:hidden"><div style="margin-left:300px;width:250px;white-space:nowrap">A long colony name past the edge</div></div></body>');
  const marks = await marked(page);
  expect(marks.length).toBeGreaterThan(0);
  const shot = await shoot(page, marks, "wide", out);
  expect(shot.marksMoved).toBeNull();
  expect(await page.evaluate(() => innerWidth)).toBe(390);
  await context.close();
});

it("never scrolls a box that clips to bring a finding into view", async () => {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.setContent(`<body style="margin:0"><div style="height:600px"></div><div id="clip" style="height:80px;overflow:hidden"><div style="height:117px"></div><div>Cut below the box</div></div></body>`);
  const marks = await marked(page);
  expect(marks.length).toBeGreaterThan(0);
  const shot = await shoot(page, marks, "clip", out);
  expect(shot.clipScrolled ?? "").toBe("");
  expect(await page.evaluate(() => document.getElementById("clip")!.scrollTop)).toBe(0);
  await page.close();
});

it("renders every finding in view, however many positions they take", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const labels = Array.from({ length: 28 }, (_, i) => `<label style="display:block;width:60px;margin-bottom:900px">Rated matches ${i}</label>`).join("");
  await page.setContent(`<body style="margin:0;font:16px/20px monospace">${labels}</body>`);
  // The wrapped labels only (the empty bands between them are findings too).
  const marks = (await marked(page)).filter(m => m.label === "wrap");
  expect(marks.length).toBe(28);
  const shot = await shoot(page, marks, "long", out);
  expect(shot.images.length).toBeGreaterThan(24);
  expect(shot.inView.every(Boolean)).toBe(true);
  // The last label is on its own render, not the first.
  expect(shot.shownIn[27]).not.toBe(shot.images[0]);
  expect(new Set(shot.shownIn).size).toBe(28);
  await page.close();
});
