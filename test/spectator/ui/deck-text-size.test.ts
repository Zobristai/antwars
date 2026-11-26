import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { GROUPED_SEATS_REPLAY, viewport } from "../../../web/render-check/check.ts";
import { applyTextSize } from "../../../web/render-check/fonts.ts";
import { ORIGIN, readFixtures, readSnapshot, serveSite } from "../../../web/render-check/serve.ts";

const web = resolve(import.meta.dirname, "../../../web");
const layout = (page: Page) => page.locator(".d1-hud").evaluate(hud => {
  const panel = hud.querySelector(".d1-below")!, box = panel.getBoundingClientRect();
  return {
    textSize: getComputedStyle(document.documentElement).fontSize,
    joined: hud.classList.contains("d1-joined"), boardInPanel: panel.firstElementChild === hud.querySelector(".d1-frame"),
    top: box.top, bottom: box.bottom,
  };
});

it("moves the board into the match panel when browser text doubles on an open replay", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] });
  try {
    const context = await browser.newContext({ ...viewport(320), viewport: { width: 320, height: 568 } });
    await serveSite(context, { dist: resolve(web, "dist"), snapshot: await readSnapshot(),
      fixtures: await readFixtures([resolve(web, "render-check/fixtures.json")]), rulesPage: () => "" });
    const load = async (size: 16 | 32) => {
      const page = await context.newPage();
      const cdp = await applyTextSize(page, size);
      await page.goto(`${ORIGIN}/?replay=${GROUPED_SEATS_REPLAY}&board=2d&capture=1`);
      // In capture mode playback advances only when asked. The waiting panel hides the HUD until its first match frame.
      await page.locator(".d1-hud").waitFor({ state: "attached", timeout: 8_000 });
      await page.waitForFunction(() => window.__antwar.frame(false).playbackTick > 0, undefined, { timeout: 5_000 });
      await page.locator(".d1-hud .aw-replay-controls").waitFor({ timeout: 3_000 });
      await page.evaluate(() => document.fonts.ready);
      return { page, cdp };
    };
    const fresh = await load(32), doubled = await layout(fresh.page);
    expect(doubled).toMatchObject({ textSize: "32px", joined: true, boardInPanel: true });
    await fresh.page.close();

    const { page, cdp } = await load(16), initial = await layout(page);
    expect(initial).toMatchObject({ textSize: "16px", joined: false, boardInPanel: false });
    const control = page.locator(".d1-btn-board");
    await control.evaluate(el => (el as HTMLElement).focus({ preventScroll: true }));
    // Only the browser font setting changes; no navigation, viewport resize, or scroll.
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
    await expect.poll(() => layout(page)).toEqual(doubled);
    const resized = await layout(page);
    console.info(`Panel bounds (CSS px): fresh ${doubled.top}–${doubled.bottom}, after text change ${resized.top}–${resized.bottom}`);
    expect(await control.evaluate(el => document.activeElement === el)).toBe(true);

    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 16 } });
    await expect.poll(() => layout(page)).toEqual(initial);
  } finally { await browser.close(); }
}, 30_000);
