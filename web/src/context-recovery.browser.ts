/** Local browser regression. Run after build:web with node --import ./src/ts-resolve.mjs web/src/context-recovery.browser.ts. */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { launchBrowser, servePage } from "../capture/browser.ts";
import { LiveServer, scripts, waitFor } from "../capture/live-check.ts";
import { scale2Packets, storedRecording } from "../capture/scale2-recording.ts";
import { RESTORE_WAIT_MS } from "./context-recovery.ts";

async function lose(page: Page) {
  const canvas = page.locator("canvas").first();
  const ext = await canvas.evaluateHandle((el: HTMLCanvasElement) => {
    const ext = el.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!ext) throw new Error("WebGL context loss is unavailable");
    return ext;
  });
  await canvas.evaluate((el, ext) => new Promise<void>(resolve => {
    el.addEventListener("webglcontextlost", () => resolve(), { once: true });
    ext.loseContext();
  }), ext);
  return () => canvas.evaluate((el, ext) => new Promise<void>(resolve => {
    el.addEventListener("webglcontextrestored", () => resolve(), { once: true });
    ext.restoreContext();
  }), ext);
}

const ready = async (page: Page) => {
  await page.waitForFunction(() => window.__antwar !== undefined, undefined, { polling: 50 });
  return page.evaluate(() => window.__antwar.ready);
};
const frame = (page: Page) => page.evaluate(() => window.__antwar.frame());
const browser = await launchBrowser();
try {
  const stored = storedRecording(scale2Packets(90));
  const { page, url, errors } = await servePage(browser, { replay: true, stored, recording: "", width: 390, height: 844, tilt: false });
  // Enter through the default board on a browser whose WebGL2 probe fails. Keep the
  // renderer itself unmodified so we can compare its actual pixels after a restore.
  await page.addInitScript(() => {
    const canvas = HTMLCanvasElement.prototype;
    canvas.getContext = new Proxy(canvas.getContext, {
      apply(getContext, receiver, args) {
        if (args[0] === "webgl2" && args.length === 1 && !new URLSearchParams(location.search).has("board")) return null;
        return Reflect.apply(getContext, receiver, args);
      },
    });
  });
  const entry = new URL(url);
  entry.searchParams.delete("board");
  entry.hash = "board";
  await page.goto(entry.href);
  await ready(page);
  await frame(page);
  for (let i = 0; i < 12; i++) { await page.clock.runFor(200); await frame(page); }
  const reached = await frame(page);
  assert(reached.playbackTick > 0);
  const hash = () => page.evaluate(() => window.__antwar.hashFrame());
  const baseline = await hash();
  await page.evaluate(() => window.__antwar.setOptions({ ants: false }));
  assert.notEqual(await hash(), baseline, "fixture must have visible ants");
  await page.evaluate(() => window.__antwar.setOptions({ ants: true }));
  const restore = await lose(page);
  await restore();
  assert.equal(await hash(), baseline, "all pixels of the restored replay frame must match");
  await page.clock.runFor(200);
  const beforeReload = await frame(page);
  assert(beforeReload.playbackTick > reached.playbackTick);

  const reloadLost = () => Promise.all([page.waitForEvent("load"), page.clock.fastForward(RESTORE_WAIT_MS)]);
  // Leave the next document waiting on replay discovery, after it has taken the position
  // but before it has a recording. Lose that canvas too, then let its replacement load.
  const discovery = Promise.withResolvers<void>();
  await page.route("**/matches", () => { discovery.resolve(); }, { times: 1 });
  await lose(page);
  await reloadLost();
  await discovery.promise;
  await lose(page);
  await reloadLost();
  assert.equal(page.url(), `${url}#board`);
  await ready(page);
  await waitFor(page, "the replay to resume", async () => (await frame(page)).playbackTick === beforeReload.playbackTick, 5000);
  // Stall a viewer's seek while its playback buffer is being rebuilt from the beginning.
  const rebuilding = Promise.withResolvers<void>();
  await page.route(`**/replays/${stored.id}`, () => { rebuilding.resolve(); }, { times: 1 });
  const scrubber = page.getByRole("slider", { name: "Replay position" });
  const seekMs = 6000;
  await scrubber.evaluate((slider: HTMLInputElement, ms) => {
    slider.value = String(ms);
    slider.dispatchEvent(new Event("change"));
  }, seekMs);
  await rebuilding.promise;
  await lose(page);
  await reloadLost();
  await ready(page);
  await waitFor(page, "the interrupted seek to land", async () => {
    const result = await frame(page);
    return result.playbackTick > beforeReload.playbackTick && Number(await scrubber.inputValue()) === seekMs;
  }, 5000);
  console.log(`Replay: interrupted seek resumed at ${seekMs} ms.`);
  assert.deepEqual(errors.filter(e => e.startsWith("page error:")), []);
  console.log(`Replay: identical pixels after restore; automatic 2D and interrupted recovery reloads resumed at tick ${beforeReload.playbackTick}.`);
  await page.context().close();

  const server = new LiveServer({ ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  try {
    const base = await server.listen();
    const { lobbyId } = server.start(1, scripts("default"));
    const live = await browser.newPage();
    await live.goto(`${base}/index.html?lobby=${lobbyId}&board=2d`);
    const { mapW, mapH } = await ready(live);
    const tick = () => live.evaluate(() => window.__antwar.board()?.tick ?? 0);
    const before = await waitFor(live, "live playback", tick, 10000);
    // Sample inside the map, not the HUD window (it can be much wider than the map).
    const groundColours = () => live.evaluate(({ mapW, mapH }) => {
      const api = window.__antwar;
      api.frame();
      const gl = document.querySelector("canvas")!.getContext("webgl2")!;
      const pixel = new Uint8Array(4), colours = new Set<string>();
      for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) {
        const [sx, sy] = api.tileToScreen(mapW * x / 8, mapH * y / 8);
        if (sx < 0 || sx >= innerWidth || sy < 0 || sy >= innerHeight) continue;
        gl.readPixels(Math.floor(sx), gl.drawingBufferHeight - 1 - Math.floor(sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        colours.add(pixel.join(","));
      }
      return colours.size;
    }, { mapW, mapH });
    assert(await groundColours() > 3, "live fixture must have visible terrain");
    const restore = await lose(live);
    await restore();
    await waitFor(live, "live playback after restore", async () => await tick() > before, 10000);
    assert(await groundColours() > 3, "restored live ground must not be blank");
    console.log("Live: restored board has terrain and playback advances.");
  } finally { await server.close(); }
} finally { await browser.close(); }
