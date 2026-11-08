/** Intrinsic landscape browser regression, no live server or match joins.
 * npm run build:web && node --import ./src/ts-resolve.mjs test/spectator/phone-landscape-check.ts
 * Local Chromium/2D only. The recording-as-live-label and stored-replay fixture do NOT prove genuine-live,
 * real storage, full 3D or WebKit acceptance. Entry placement is checked separately and is absent in capture mode.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { CHROMIUM_FLAGS, servePage } from "../../web/capture/browser.ts";

const bytes = await readFile("web/public/replays/agents.bin");
const storedId = "2026-10-15T18-00-00-000Z-2";
const out = "out/phone-landscape";
/**
 * The board's area at 844x390 in both modes, [x, y, width, height], read from the base build (9c689f1) before the boardArea reader
 * changed it, by the HUD's own measure (ui/hud.ts boardArea), with a scripted recording standing in for
 * web/public/replays/agents.bin, which that build does not have. The old pin, the hidden stage's [0, 0, 476, 338], read
 * 0x0 at that build.
 */
const BASE_AREA = [12, 168, 560, 140];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.HEADLESS_SHELL ?? "/opt/chrome-for-testing/chrome-linux64/chrome",
  args: [...CHROMIUM_FLAGS, "--disable-dev-shm-usage"],
});
/** The board's area (the host's, window.__antwar.boardArea()) as [x, y, width, height]. */
const boardArea = (page: Page) => page.evaluate(() => {
  const a = window.__antwar.boardArea();
  return [a.x0, a.y0, a.x1 - a.x0, a.y1 - a.y0];
});
const results: unknown[] = [];
try {
  for (const mode of ["recording-with-live-label", "stored-replay-fixture"] as const) {
    const { page, url, errors } = await servePage(browser, { recording: "landscape", width: 844, height: 390, tilt: false, board: "2d", phone: true });
    try {
      page.setDefaultTimeout(15000);
      await page.route("**/recordings/landscape.bin", route => route.fulfill({ contentType: "application/octet-stream", body: bytes }));
      await page.route(`**/replays/${storedId}`, route => route.fulfill({ contentType: "application/octet-stream", body: bytes }));
      const target = new URL(url);
      if (mode === "stored-replay-fixture") { target.searchParams.delete("recording"); target.searchParams.set("replay", storedId); }
      await page.goto(target.href);
      const info = await page.evaluate(() => window.__antwar.ready);
      await page.evaluate(() => document.fonts.ready);
      await page.clock.runFor(5000);
      await page.evaluate(() => window.__antwar.frame());
      assert.equal(await page.locator(".d2-btn-board").count(), 1, "Wait for the mounted HUD, not readiness alone");
      if (mode === "stored-replay-fixture") assert.equal(info.source, `replay /replays/${storedId}`);
      const before = await boardArea(page);
      // The base build's board area in both landscape modes (9c689f1, read before the boardArea reader changed it).
      assert.deepEqual(before, BASE_AREA, "No board area loss from intrinsic controls");
      const samples = [];
      for (const ms of [1000, 5000, 10000]) {
        await page.clock.runFor(ms);
        await page.evaluate(() => window.__antwar.frame());
        const after = await boardArea(page);
        assert.deepEqual(after, before, "The settled board area keeps its exact geometry");
        samples.push(after);
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/${mode}.png` });
      results.push({ mode, info, before, samples, result: "passed" });
    } finally { await page.context().close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify({ head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim(), engine: "Chromium", board: "2D", limitation: "Intrinsic fixture checks only; not genuine live, real storage, 3D or WebKit.", results }, null, 2));
}
console.log("Landscape intrinsic Chromium/2D fixture checks passed; genuine-live, WebKit and full 3D remain unverified.");
