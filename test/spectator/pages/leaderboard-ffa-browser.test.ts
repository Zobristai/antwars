import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fontconfigFor } from "../../../web/render-check/fonts.ts";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ORIGIN, readFixtures, readSnapshot, serveSite } from "../../../web/render-check/serve.ts";

const web = resolve(import.meta.dirname, "../../../web");
let browser: Browser;
let fonts: string;
beforeAll(async () => {
  fonts = await mkdtemp(resolve(tmpdir(), "ffa-board-fonts-"));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
    args: ["--no-sandbox"], env: { ...process.env, FONTCONFIG_FILE: await fontconfigFor("Roboto", fonts) } });
});
afterAll(async () => { await browser?.close(); if (fonts) await rm(fonts, { recursive: true, force: true }); });

it.each([1280, 390])("fits seven Free-for-all records and opens their recent replays at %i px", async width => {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390 });
  try {
    const fixtures = await readFixtures([resolve(web, "render-check/leaderboard-ffa-fixture.json")]);
    const expected = Object.values(fixtures)[0].body as { entries: { places: number[]; form: { place: number; replayId: string }[] }[] };
    const served = await serveSite(context, { dist: resolve(web, "dist"), fixtures, snapshot: await readSnapshot(), rulesPage: () => "" });
    await context.clock.setFixedTime(new Date("2026-11-27T22:30:00Z"));
    const page = await context.newPage(); await page.goto(ORIGIN + "/?page=leaderboard&mode=quadrants&board=2d");
    const rows = page.locator(width === 390 ? ".d1p-ffa-narrow li" : ".d1p-ffa-table tbody tr");
    await rows.nth(6).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const measure = await rows.evaluateAll(nodes => nodes.map(row => {
      const name = row.querySelector(".c-name, .is-lead")!;
      const range = document.createRange(); range.selectNodeContents(name);
      const lines = [...range.getClientRects()].filter(r => r.width > 0);
      const strip = row.querySelector<HTMLElement>(".d1p-place-strip")!;
      const chips = [...row.querySelectorAll<HTMLAnchorElement>("a.d1p-form-mark")];
      const rect = strip.getBoundingClientRect(), first = chips[0].getBoundingClientRect();
      const count = row.querySelector(".c-matches, .d1p-stat")!.getBoundingClientRect();
      return { oneLine: lines.every(r => Math.abs(r.y - lines[0].y) < 7), stripWidth: rect.width,
        segments: [...strip.children].map(n => ({ n: Number(n.textContent), width: n.getBoundingClientRect().width })),
        alongsideCount: count.bottom > rect.top && rect.bottom > count.top, chipsBelow: first.top >= rect.bottom,
        chipSize: [first.width, first.height], chips: chips.map(c => [c.dataset.result, c.getAttribute("href")]),
        noOverflow: row.scrollWidth <= row.clientWidth + 1 && chips.every(c => c.getBoundingClientRect().right <= innerWidth),
      };
    }));
    expect(measure).toHaveLength(7);
    measure.forEach((r, i) => {
      expect(r.oneLine, `name and badges of row ${i + 1}`).toBe(true);
      expect(r.noOverflow && r.alongsideCount).toBe(true);
      expect(r.stripWidth).toBe(150);
      expect(r.segments.map(s => s.n)).toEqual(expected.entries[i].places);
      expect(r.segments.every(s => s.width >= 20)).toBe(true);
      expect(r.chips).toEqual(expected.entries[i].form.map(f => [String(f.place), `/?replay=${f.replayId}&board=2d`]));
      if (width === 390) { expect(r.chipsBelow).toBe(true); expect(r.chipSize).toEqual([40, 44]); }
    });
    expect(measure[0].segments[3].n).toBe(0);
    const first = rows.first().locator("a").first();
    await page.getByRole("switch").focus(); await page.keyboard.press("Tab");
    expect(await first.evaluate(e => e.matches(":focus-visible") && getComputedStyle(e).outlineStyle !== "none")).toBe(true);
    const out = resolve(web, "../out/ffa-board"); await mkdir(out, { recursive: true });
    // The page scrolls inside a host. Fit the whole board vertically for the evidence photo without changing its width.
    await page.setViewportSize({ width, height: width === 390 ? 1900 : 960 });
    const board = await page.locator(".d1p-main").boundingBox();
    if (!board) throw new Error("Board not rendered");
    await page.screenshot({ path: resolve(out, `board-${width}.png`), clip: { x: 0, y: board.y, width, height: board.height + 8 } });
    // Intercept only the destination: activation must navigate to this exact recording.
    const destination = await first.getAttribute("href"); await page.route(url => url.searchParams.has("replay"), route => route.fulfill({ body: "Replay destination" }));
    await Promise.all([page.waitForURL(ORIGIN + destination), page.keyboard.press("Enter")]);
    expect(served.unanswered).toEqual([]);
  } finally { await context.close(); }
}, 30_000);
