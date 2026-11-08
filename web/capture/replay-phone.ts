/** Local same-origin gzip replay, no agents/network service/cloud credentials.
 * node --import ./src/ts-resolve.mjs web/capture/replay-phone.ts [--quick]
 * Full run: all 18,001 ticks through the production client at each phone width.
 * Accelerated deterministic clock updates every tick without drawing; draw start, midpoint and end.
 * Do not feed skipped synthetic frames to the production frame-cadence controller. Separately exercise
 * normal-clock animation at each width. This is memory/correctness evidence, not a full-match FPS claim.
 * Memory is sampled CDP JS heap and backing storage, not OS/GPU memory or physical-phone evidence.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { playScripted } from "../../src/live/record.ts";
import { encodeReplayMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { launchBrowser, OUT_DIR, WEB_DIR } from "./browser.ts";

declare global { interface Window { __replayTime: number } }
const quick = process.argv.includes("--quick");
const dir = join(OUT_DIR, "replay-phone");
await mkdir(dir, { recursive: true });
const id = "2026-10-18T13-58-00-000Z-12";
const listed = "2026-10-18T13-00-00-000Z-11";
const gzipPath = join(dir, "full.bin.gz");
const metaPath = join(dir, "fixture.json");
async function fixture() {
  try { return JSON.parse(await readFile(metaPath, "utf8")) as { ticks: number; rawBytes: number; gzipBytes: number; sha256: string; agents: number; seed: number }; } catch { /* generate */ }
  const config = withGridScale(rulesConfig("redesign"));
  const recorder = new SpectatorRecorder(createMatch(6006, config));
  const packets = [encodeReplayMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  const result = playScripted({ seed: 6006, config, agents: 8, ticks: 18_000, attack: false }, (out) => {
    const r = recorder.record(out);
    packets.push(encodeReplayMessage({ tick: r.tick, ants: r.ants, full: null, events: r.events }));
  });
  assert.equal(result.state.tick, 18_000);
  assert.equal(result.state.agents.length, 8);
  assert.equal(result.state.result?.reason, "time_up");
  const raw = packMessages(packets);
  const gzip = gzipSync(raw, { level: 9 });
  const meta = { ticks: result.state.tick, rawBytes: raw.byteLength, gzipBytes: gzip.byteLength, sha256: createHash("sha256").update(gzip).digest("hex"), agents: 8, seed: 6006 };
  await writeFile(gzipPath, gzip);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}
const meta = await fixture();
const requests: string[] = [];
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".bin": "application/octet-stream" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  requests.push(path);
  if (path === "/live/replays") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ replays: [{ seq: 11, match: 11, replayId: listed }] }));
    return;
  }
  if (path === `/replays/${id}`) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "gzip", "content-length": meta.gzipBytes, "cache-control": "no-store" });
    await pipeline(createReadStream(gzipPath, { highWaterMark: 16_384 }), res).catch(() => undefined);
    return;
  }
  try {
    const file = join(WEB_DIR, path === "/" ? "index.html" : path);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await launchBrowser();
const results: unknown[] = [];
try {
  // Default renderer for both full runs; explicit 2D is a short wiring/compatibility check.
  for (const width of [390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) { errors.push(`unexpected external request: ${route.request().url()}`); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(() => {
      window.__replayTime = 0;
      Object.defineProperty(performance, "now", { value: () => window.__replayTime });
    });
    const cdp = await context.newCDPSession(page);
    let peakHeap = 0;
    let peakBacking = 0;
    let peakCombined = 0;
    const memory = async () => {
      const m = await cdp.send("Runtime.getHeapUsage");
      peakHeap = Math.max(peakHeap, m.usedSize);
      peakBacking = Math.max(peakBacking, m.backingStorageSize ?? 0);
      peakCombined = Math.max(peakCombined, m.usedSize + (m.backingStorageSize ?? 0));
    };
    const started = performance.now();
    await page.goto(`${origin}/?replay=${id}&capture=1`, { waitUntil: "domcontentloaded" });
    const info = await page.evaluate(() => window.__antwar.ready);
    assert.equal(new URL(page.url()).searchParams.get("board"), null, "default renderer silently fell back");
    assert.match(info.rendererName, /^babylon /);
    assert(info.rendererString.includes("SwiftShader"));
    await page.evaluate(() => window.__antwar.frame());
    const firstFrameMs = performance.now() - started;
    await memory();
    // The HUD's status line: the deck's legend (the 2D board's status line below).
    const status = await page.locator(".d2-status, .d1-legend").innerText();
    assert.match(status, /RECORDING.*not live/);
    assert.match(status, /18 Oct 2026/);
    let tick = 0;
    let midpointDrawn = false;
    let batches = 0;
    const checkpoints: unknown[] = [];
    const target = quick ? 30 : meta.ticks;
    while (tick < target) {
      const progress = await page.evaluate(async () => {
        for (let i = 0; i < 100; i++) {
          const r = window.__antwar.recording()!;
          if (r.error) throw new Error(r.error);
          // Let native streaming fill after backpressure, without changing the virtual match clock.
          if (r.stats.bufferedMessages < 3 && !r.complete) await new Promise((resolve) => setTimeout(resolve, 0));
          window.__replayTime += 100;
          window.__antwar.frame(false);
          if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return { board: window.__antwar.board(), recording: window.__antwar.recording(), tick: window.__antwar.frame(false).playbackTick };
      });
      tick = progress.tick;
      if (!midpointDrawn && tick >= meta.ticks / 2) {
        await page.evaluate(() => window.__antwar.frame());
        midpointDrawn = true;
      }
      await memory();
      batches++;
      if (batches % 30 === 0 || tick >= target) { checkpoints.push({ tick, heapBytes: peakHeap }); console.log(JSON.stringify({ width, tick, peakHeap })); }
      assert(batches < 250, "playback stalled before completing the match");
    }
    for (let i = 0; i < 30; i++) await page.evaluate(() => { window.__replayTime += 100; window.__antwar.frame(false); });
    await page.evaluate(() => window.__antwar.frame());
    await memory();
    const final = await page.evaluate(() => ({ board: window.__antwar.board(), recording: window.__antwar.recording(), mode: document.querySelector(".d2-status, .d1-legend")?.textContent }));
    if (!quick) {
      assert.equal(final.board?.tick, meta.ticks);
      assert.equal(final.board?.ended, true);
      assert.equal(final.recording?.complete, true);
      assert.equal(final.recording?.stats.messages, meta.ticks + 1);
      assert.equal(final.recording?.stats.decodedBytes, meta.rawBytes);
      assert.match(final.mode ?? "", /recording ended/);
      assert.equal(await page.locator(".d1-result").isVisible(), true);
    }
    assert(final.recording!.stats.peakBufferedMessages <= 20);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(dir, `${width}${quick ? "-quick" : "-final"}.png`) });
    const resource = await page.evaluate((id) => {
      const entry = performance.getEntriesByType("resource").find((entry) => entry.name.endsWith(`/replays/${id}`)) as PerformanceResourceTiming | undefined;
      return entry ? { durationMs: entry.duration, transferBytes: entry.transferSize, encodedBodyBytes: entry.encodedBodySize, decodedBodyBytes: entry.decodedBodySize } : null;
    }, id);
    const acceleratedCompletionMs = performance.now() - started;
    await context.close();
    // A separate, unmodified clock and animation loop exercises the actual displayed playback cadence.
    // The accelerated run above deliberately does not purport to benchmark that cadence.
    const nativeContext = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const nativePage = await nativeContext.newPage();
    const nativeErrors: string[] = [];
    nativePage.on("pageerror", (error) => nativeErrors.push(error.message));
    const nativeCdp = await nativeContext.newCDPSession(nativePage);
    const nativeStarted = performance.now();
    await nativePage.goto(`${origin}/?replay=${id}`);
    const nativeInfo = await nativePage.evaluate(() => window.__antwar.ready);
    await nativePage.waitForFunction(() => (window.__antwar.board()?.tick ?? -1) >= 10);
    const nativeTick = await nativePage.evaluate(() => window.__antwar.board()!.tick);
    const nativeMemory = await nativeCdp.send("Runtime.getHeapUsage");
    const nativeBacking = nativeMemory.backingStorageSize ?? 0;
    peakHeap = Math.max(peakHeap, nativeMemory.usedSize);
    peakBacking = Math.max(peakBacking, nativeBacking);
    peakCombined = Math.max(peakCombined, nativeMemory.usedSize + nativeBacking);
    assert.deepEqual(nativeErrors, []);
    const nativePlayback = { elapsedMs: performance.now() - nativeStarted, tick: nativeTick, info: nativeInfo, jsHeapBytes: nativeMemory.usedSize, backingBytes: nativeBacking };
    await nativeContext.close();
    results.push({ width, height: 844, firstFrameMs, acceleratedCompletionMs, peakJsHeapBytes: peakHeap, peakBackingBytes: peakBacking, peakJsAndBackingBytes: peakCombined, nativePlayback, resource, info, final, checkpoints });
  }
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  for (const query of [`replay=${id}&board=2d`, "replay&board=2d"]) {
    await page.goto(`${origin}/?${query}`);
    await page.evaluate(() => window.__antwar.ready);
    await page.waitForFunction(() => (window.__antwar.board()?.tick ?? -1) > (new URLSearchParams(location.search).get("replay") ? 5 : 1505));
    assert.match(await page.locator(".d2-mode-label").innerText(), /RECORDING.*not live/);
  }
  await context.close();
  assert(!requests.includes("/live/current"), "recordings must not open the live stream");
  const report = { measuredAt: new Date().toISOString(), quick, fixture: meta, methodology: "Local streamed HTTP gzip; Chromium mobile emulation/SwiftShader; cold contexts; accelerated every-tick updates with start/midpoint/end drawing, plus separate normal-clock animated playback at each width; CDP heap/backing sampled every 100 ticks and in normal-clock playback. Full-match state/memory correctness, not full-match rendering/FPS, physical-device, cellular, GPU or OS peak memory evidence.", results, requests: [...new Set(requests)] };
  await writeFile(join(dir, quick ? "quick.json" : "measurements.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
