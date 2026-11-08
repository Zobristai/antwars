/** Identical scheduled SSE bytes through the built live client, never a substituted sampler.
 * npm run build:web && node --import ./src/ts-resolve.mjs web/capture/playback-pacing.ts --out out/playback-pacing
 * Software WebGL: JS phase costs are not physical-device GPU frame rates. No production connection.
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { launchBrowser, WEB_DIR } from "./browser.ts";
import { scale2Packets } from "./scale2-recording.ts";
import type { FrameResult } from "../src/main.ts";

const FILE_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

/** Read before committing a status: a missing fixture must send one 404, not a second set of headers. */
export async function serveFixtureFile(file: string, res: ServerResponse): Promise<void> {
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": FILE_TYPES[extname(file)] ?? "application/octet-stream" }).end(bytes);
}

/** Four opening ticks, a 1.1 s pause, then the missed ticks arriving together; later 133/50 ms pauses. */
export function arrivalSchedule(count: number): number[] {
  let last = 0;
  return Array.from({ length: count }, (_, i) => {
    const opening = i < 4 ? i * 100 : i <= 14 ? 1400 : i * 100;
    const jitter = i === 50 ? 133 : i === 90 ? 50 : 0;
    return last = Math.max(last, opening + jitter);
  });
}

export function series(values: readonly number[]) {
  if (!values.length) return { count: 0, p50: null, p95: null, peak: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), peak: sorted.at(-1)! };
}

export function motionSummary(frames: readonly { now: number; playback: number; waiting: boolean }[]) {
  const playing = frames.filter((f) => !f.waiting);
  let freezeMs = 0, longestFreezeMs = 0, catchupFrames = 0;
  for (let i = 1; i < playing.length; i++) {
    const prev = playing[i - 1]!, f = playing[i]!;
    const elapsed = f.now - prev.now, advance = f.playback - prev.playback;
    freezeMs = advance <= 0.001 ? freezeMs + elapsed : 0;
    longestFreezeMs = Math.max(longestFreezeMs, freezeMs);
    if (advance >= 99 && elapsed < 50) catchupFrames++;
  }
  return { firstDrawMs: playing[0]?.now ?? null, postStartFreezeMs: longestFreezeMs, wholeTickCatchupFrames: catchupFrames };
}

export async function measure(webDir: string, out: string, frameCount = 361) {
  const root = resolve(webDir);
  // An in-process grid-scale-2 recording: the bundled web/public/replays/agents.bin is deleted.
  const messages = scale2Packets(122).map(decodeMessage);
  const data = messages.map((m) => deflateRawSync(encodeMessage(m)).toString("base64"));
  const schedule = arrivalSchedule(data.length);
  const streams = new Set<ServerResponse>();
  let sent = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    if (path === "/live/current") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${data[0]}\n\n`);
      streams.add(res); sent = 1;
      req.on("close", () => streams.delete(res));
      return;
    }
    const file = resolve(root, `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    await serveFixtureFile(file, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__antwarRealNow = performance.now.bind(performance);
      const counters = { reads: 0 };
      Object.assign(window, { __pacing: counters });
      const read = WebGL2RenderingContext.prototype.readPixels;
      WebGL2RenderingContext.prototype.readPixels = function (this: WebGL2RenderingContext, ...args: Parameters<typeof read>) {
        counters.reads++;
        return Reflect.apply(read, this, args);
      } as typeof read;
    });
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    // Capture disables rAF only; gpuTiming=0 explicitly requests JS timing without GPU-finish synchronization.
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/?capture&board=2d&gpuTiming=0`);
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const info = await Promise.race([
      page.evaluate(() => window.__antwar.ready),
      new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error("built live client did not become ready in 30 s")), 30_000); }),
    ]).finally(() => clearTimeout(readyTimer));
    const frames: { now: number; playback: number; waiting: boolean; newest: number; reads: number; wallJsMs: number; result: FrameResult }[] = [];
    const tickIntake: number[] = [], workerTicks: number[] = [], deliveredTicks: number[] = [];
    for (let k = 0; k < frameCount; k++) {
      const now = Math.round(k * 1000 / 30);
      const prevNow = k === 0 ? 0 : Math.round((k - 1) * 1000 / 30);
      if (k > 0) await page.clock.runFor(now - prevNow);
      const before = sent;
      while (sent < data.length && schedule[sent]! <= now) {
        for (const stream of streams) stream.write(`data: ${data[sent]}\n\n`);
        sent++;
      }
      // Allow the real EventSource, DecompressionStream and (candidate) worker to deliver while the animation clock stays fixed.
      if (sent !== before || k === 0) await new Promise((done) => setTimeout(done, 30));
      const f = await page.evaluate(() => {
        const start = window.__antwarRealNow!();
        const result = window.__antwar.frame();
        return { result, wallJsMs: window.__antwarRealNow!() - start,
          waiting: !document.getElementById("aw-waiting")!.hidden,
          newest: window.__antwar.playback().newestTick,
          reads: (window as unknown as { __pacing: { reads: number } }).__pacing.reads };
      });
      if (f.newest !== messages[sent - 1]!.tick) throw new Error(`SSE delivery incomplete at ${now}: expected ${messages[sent - 1]!.tick}, got ${f.newest}`);
      if (sent !== before || k === 0) {
        tickIntake.push(f.result.ingestMs ?? NaN);
        if (f.result.workerMs !== undefined) workerTicks.push(f.result.workerMs);
        if (f.result.deliveryMs !== undefined) deliveredTicks.push(f.result.deliveryMs);
      }
      frames.push({ now, playback: f.result.playbackMs, ...f });
    }
    const summary = { webDir: root, renderer: info.rendererString, bytesDigest: createHash("sha256").update(data.join("\n")).digest("hex"), schedule,
      recording: "in-process grid-scale-2 recording (web/capture/scale2-recording.ts, seed 7001)", firstTick: messages[0]!.tick, viewport: [640, 360], fps: 30,
      method: "Built 2D live client; identical encoded SSE and stepped page clock, real decode/worker delivery. Capture disables automatic rAF; gpuTiming=0 requests no forced GPU finish. Software WebGL, not real-device FPS.",
      motion: motionSummary(frames), intakeMs: series(tickIntake), workerMs: series(workerTicks), mainDeliveryMs: series(deliveredTicks),
      timingScope: "Intake is main-thread frame ingestion, one sample per tick-bearing frame (a burst aggregates several ticks); worker elapsed decode/preparation and main-thread worker-message delivery are separate. Whole-frame JS excludes those between-frame callbacks. Missing worker readings are unavailable, not zero.",
      wholeFrameJsMs: series(frames.map((f) => f.wallJsMs)), readPixelsCalls: frames.at(-1)!.reads, errors };
    await mkdir(out, { recursive: true });
    await writeFile(resolve(out, "pacing.json"), JSON.stringify({ summary, frames }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (errors.length) throw new Error(errors.join("\n"));
    return summary;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({ options: { web: { type: "string", default: WEB_DIR }, out: { type: "string", default: "out/playback-pacing" }, frames: { type: "string", default: "361" } } });
  await measure(values.web!, values.out!, Number(values.frames));
}
