/** Bounded early look. No public traffic, server match, timing benchmark or full stills run.
 * npm run build:web && node --import ./src/ts-resolve.mjs web/capture/page-polish.ts --out out/page-polish
 * Live-page shots use a local SSE fixture assembled from the shipped agent recording, not a live public match.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import type { ClientInfo } from "../src/main.ts";
import { decodeMessage, encodeMessage, encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { DEFAULT_CONFIG } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { launchBrowser, servePage, WEB_DIR } from "./browser.ts";
import { storedHistory, storedRecording, type StoredRecording } from "./scale2-recording.ts";

/** Seek just beyond the first newly recorded mark instead of asking an earlier frame to contain it. */
export function replayCaptureTick(messages: readonly StreamMessage[]): number {
  const firstMark = messages.find((message) => message.events.some((event) => event.kind === "mark"));
  if (!firstMark) throw new Error("The agent recording contains no new mark to capture");
  return firstMark.tick + 1;
}

/** Serve the page, assets, recording and held-open SSE from ONE real origin.
 * Redirecting a routed localhost page to a different loopback server hits Chrome's
 * local-network permission check, even with CORS headers. No browser bypass flags.
 */
export async function startFixtureStream(body: string, webDir = WEB_DIR, stored?: StoredRecording): Promise<{ url: string; close(): Promise<void> }> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".bin": "application/octet-stream" };
  const root = resolve(webDir);
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path === "/live/current") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(body);
      // Deliberately no end(): the browser closes this with its test context.
      return;
    }
    // A bare ?replay resolves stored history; the bundled recording is deleted.
    const history = stored ? storedHistory(path, stored) : null;
    if (history) { response.writeHead(200, { "content-type": history.type }); response.end(history.body); return; }
    const file = resolve(root, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      response.end(bytes);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/live/current`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/** Node's clock stays real when the page's capture clock is paused. */
export async function boundedReady<T>(ready: Promise<T>, scene: string, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ready, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${scene}: client ready timed out after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

type Pixel = readonly [number, number, number, number];

/** Sparse badges/ants on a clear canvas must not masquerade as a painted ground.
 * Samples come from the primary WebGL canvas, never the HTML/Pixi overlay.
 */
export function boardPixelCheck(samples: readonly Pixel[], background: Pixel): { nonblank: boolean; samples: number; opaqueFraction: number; groundFraction: number; rgbDeviation: number } {
  if (!samples.length) return { nonblank: false, samples: 0, opaqueFraction: 0, groundFraction: 0, rgbDeviation: 0 };
  const opaque = samples.filter((p) => p[3] >= 250);
  const ground = opaque.filter((p) => Math.abs(p[0] - background[0]) + Math.abs(p[1] - background[1]) + Math.abs(p[2] - background[2]) >= 12);
  const means = [0, 1, 2].map((c) => samples.reduce((n, p) => n + p[c]!, 0) / samples.length);
  const variance = samples.reduce((n, p) => n + means.reduce((sum, mean, c) => sum + (p[c]! - mean) ** 2, 0), 0) / samples.length;
  const opaqueFraction = opaque.length / samples.length;
  const groundFraction = ground.length / samples.length;
  const rgbDeviation = Math.sqrt(variance);
  return { nonblank: samples.length >= 32 && opaqueFraction >= 0.95 && groundFraction >= 0.4 && rgbDeviation >= 4, samples: samples.length, opaqueFraction, groundFraction, rgbDeviation };
}

/** Read one already-drawn primary canvas in a single GPU readback. Tile-grid
 * samples stay inside the actual stage and exclude every DOM/Pixi marker.
 */
async function primaryBoardPixels(page: Page, info: Pick<ClientInfo, "mapW" | "mapH">, draw: boolean) {
  const pixels = await page.evaluate(({ mapW, mapH, draw }) => {
    if (draw) window.__antwar.frame();
    const canvas = document.querySelector("canvas")!;
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("3D primary canvas has no WebGL2 context");
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const at = (x: number, y: number): [number, number, number, number] => {
      const offset = (y * width + x) * 4;
      return [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!];
    };
    const a = window.__antwar.boardArea();
    const stage = { left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 };
    const box = canvas.getBoundingClientRect();
    const samples: [number, number, number, number][] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
      const [sx, sy] = window.__antwar.tileToScreen(mapW * (0.08 + 0.84 * (x + 0.5) / 16), mapH * (0.08 + 0.84 * (y + 0.5) / 12));
      if (sx < Math.max(stage.left, box.left) || sx >= Math.min(stage.right, box.right) || sy < Math.max(stage.top, box.top) || sy >= Math.min(stage.bottom, box.bottom)) continue;
      samples.push(at(Math.floor((sx - box.left) * width / box.width), height - 1 - Math.floor((sy - box.top) * height / box.height)));
    }
    return { samples, background: at(0, height - 1) };
  }, { ...info, draw });
  return boardPixelCheck(pixels.samples, pixels.background);
}

/** Catch-up updates do not render; the first scene.render starts asynchronous
 * shader compilation. Real event-loop turns plus more DRAWN frames complete it.
 * Do not advance the paused simulation clock or silently accept a blank result.
 */
async function settle3DBoard(page: Page, info: Pick<ClientInfo, "mapW" | "mapH">, scene: string, draw = true) {
  const started = Date.now();
  const first = await boundedReady(primaryBoardPixels(page, info, draw), `${scene}: primary canvas`, 20_000);
  let last = first;
  let attempts = 1;
  while (!last.nonblank && Date.now() - started < 20_000) {
    await page.waitForTimeout(100);
    last = await boundedReady(primaryBoardPixels(page, info, draw), `${scene}: primary canvas`, Math.max(1, 20_000 - (Date.now() - started)));
    attempts++;
  }
  return { first, last, attempts, elapsedMs: Date.now() - started, manualClockAdvanceMs: 0 };
}

/** Only if capture stays blank: compare an unpaused, ordinary render-loop page.
 * This control diagnoses a page blocker; it never makes a failed capture pass.
 */
async function normal3DControl(browser: Browser, url: URL, width: number, height: number, name: string) {
  const { page, errors } = await servePage(browser, { recording: "", replay: true, width, height, tilt: false, board: "3d" });
  const target = new URL(url);
  target.searchParams.delete("capture");
  try {
    await page.clock.resume();
    await page.goto(target.href, { timeout: 20_000 });
    const info = await boundedReady(page.evaluate(() => window.__antwar.ready), `${name}: normal-page control`);
    if (!/babylon/i.test(info.rendererName)) throw new Error(`Normal-page control fell back to ${info.rendererName}`);
    const paint = await settle3DBoard(page, info, `${name}: normal-page control`, false);
    return { ...paint, errors, diagnosis: paint.last.nonblank ? "capture-only failure: ordinary render loop paints the ground" : "PAGE BLOCKER: ordinary render loop also has a blank primary canvas" };
  } catch (error) {
    return { errors, diagnosis: `Normal-page control inconclusive: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await page.context().close();
  }
}

type Point = readonly [number, number];
interface Area { x0: number; y0: number; x1: number; y1: number }

/** Geometry, not a pixel measurement: report perspective envelope and visible widths separately. */
export function boardWidths(corners: readonly Point[], stage: Area): { projectedBoundsWidth: number; boardWidth: number; midlineWidth: number } {
  let polygon = [...corners];
  for (const [axis, edge, direction] of [[0, stage.x0, 1], [0, stage.x1, -1], [1, stage.y0, 1], [1, stage.y1, -1]] as const) {
    const clipped: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      const insideA = direction * (a[axis] - edge) >= 0;
      const insideB = direction * (b[axis] - edge) >= 0;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        const fraction = (edge - a[axis]) / (b[axis] - a[axis]);
        clipped.push([a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])]);
      }
    }
    polygon = clipped;
  }
  const width = (points: readonly Point[]) => points.length ? Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)) : 0;
  const middle = (stage.y0 + stage.y1) / 2;
  const crossings: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    if ((a[1] <= middle && b[1] > middle) || (b[1] <= middle && a[1] > middle)) crossings.push(a[0] + (middle - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
  }
  return { projectedBoundsWidth: width(corners), boardWidth: width(polygon), midlineWidth: crossings.length ? Math.max(...crossings) - Math.min(...crossings) : 0 };
}

/** A scripted grid-scale-2 agent match, made in process: the bundled agent excerpt is deleted. */
function agentRecording(): StreamMessage[] {
  const lines = playScripted({ seed: 5205, config: withGridScale(DEFAULT_CONFIG), agents: 4, ticks: 1800, attack: true }).lines;
  return recordLog(lines, 1800).map(decodeMessage);
}

/** A real recorded board with a recorded mark, plus one newly laid test mark, exercising the live EventSource path. */
function liveFixture(messages: readonly StreamMessage[]): string {
  const head = messages[0]!;
  const state = new SpectatorState(structuredClone(head.full!), head.tick, head.ants);
  const marked = replayCaptureTick(messages);
  for (const message of messages.slice(1)) {
    if (message.tick > marked) break;
    state.apply(message);
  }
  const full = state.message();
  const mark = full.full!.marks[0];
  if (!mark) throw new Error("The local live fixture needs a recorded mark");
  const tick = full.tick + 1;
  const next: StreamMessage = { tick, ants: full.ants, full: null, events: [{ kind: "mark", mark: { ...mark, id: Math.max(...full.full!.marks.map((m) => m.id)) + 1, laidTick: tick } }] };
  return [full, next].map((message) => `data: ${deflateRawSync(encodeMessage(message)).toString("base64")}\n\n`).join("");
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (!values.out) throw new Error("--out DIR is required");
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const messages = agentRecording();
  const fixture = liveFixture(messages);
  const replayTick = replayCaptureTick(messages);
  const stream = await startFixtureStream(fixture, WEB_DIR, storedRecording(messages.map(message => encodePublicMessage(message))));
  const browser = await launchBrowser().catch(async (error: unknown) => { await stream.close(); throw error; });
  const scenes: unknown[] = [];
  const failures: string[] = [];
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  try {
    for (const board of ["2d", "3d"] as const) {
      for (const [width, height, mode] of [[1920, 1080, "live"], [1920, 1080, "replay"], [390, 844, "live"], [390, 844, "replay"], [1280, 900, "replay"]] as const) {
        const name = `${board}-${width}x${height}-${mode}`;
        const { page, errors, url } = await servePage(browser, { recording: "", replay: true, width, height, tilt: false, board });
        // The helper installs the paused clock and error collectors, but its virtual
        // localhost route is unused: all traffic goes to this real same-origin server.
        const original = new URL(url);
        const target = new URL(original.pathname + original.search, stream.url);
        if (mode === "live") target.searchParams.delete("replay");
        try {
          await page.goto(target.href, { timeout: 20_000 });
          const info = await boundedReady(page.evaluate(() => window.__antwar.ready), name);
          if ((board === "3d") !== /babylon/i.test(info.rendererName)) throw new Error(`Requested ${board}, got ${info.rendererName}`);
          // Keep the marks assertion: seek past the first actual mark instead of weakening coverage.
          const duration = mode === "replay" ? (replayTick - messages[0]!.tick) * 100 + 250 : 500;
          for (let now = 0; now < duration;) {
            const step = Math.min(1000, duration - now);
            await page.clock.runFor(step);
            now += step;
            await page.evaluate(() => window.__antwar.frame(false));
          }
          const boardPaint = board === "3d" ? await settle3DBoard(page, info, name) : null;
          const normalPage = boardPaint && !boardPaint.last.nonblank ? await normal3DControl(browser, target, width, height, name) : null;
          if (normalPage) {
            pageErrorCount += normalPage.errors.filter((e) => e.startsWith("page error:")).length;
            consoleErrorCount += normalPage.errors.filter((e) => e.startsWith("console error:")).length;
            failures.push(...normalPage.errors.map((e) => `${name}: normal-page control: ${e}`));
          }
          if (boardPaint && !boardPaint.last.nonblank) failures.push(`${name}: blank primary 3D board after ${boardPaint.attempts} drawn frames; ${normalPage?.diagnosis}`);
          if (board === "2d") {
            await page.evaluate(() => window.__antwar.frame());
            await page.waitForTimeout(350);
          }
          const metrics = await page.evaluate(({ mapW, mapH }) => {
            const a = window.__antwar.boardArea();
            const corners = [[0, 0], [mapW, 0], [mapW, mapH], [0, mapH]].map(([x, y]) => window.__antwar.tileToScreen(x!, y!));
            return { stageWidth: a.x1 - a.x0, stageTop: a.y0, projectedCorners: corners, stageArea: { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 },
              // The stream's state as the HUD says it: the 2D board's connection, or the deck's legend.
              streamState: document.querySelector(".d2-connection, .d1-legend")?.textContent ?? "" };
          }, { mapW: info.mapW, mapH: info.mapH });
          if (mode === "live" && /interrupted|reconnecting/i.test(metrics.streamState)) failures.push(`${name}: local SSE fixture did not remain open`);
          const file = `${name}.png`;
          if (width !== 1280) writeFileSync(join(out, file), await page.screenshot({ type: "png" }));
          scenes.push({ name, file: width === 1280 ? null : file, viewport: [width, height], renderer: info.rendererName, source: mode === "live" ? "held-open local SSE fixture from a scripted grid-scale-2 agent recording plus one test mark; no public match" : "scripted grid-scale-2 agent recording, served as stored history", boardPaint, normalPage, replayTick: mode === "replay" ? replayTick : null, ...metrics, ...boardWidths(metrics.projectedCorners, metrics.stageArea), widthMeasurement: "projected ground polygon; boardWidth clipped to stage, midlineWidth at stage centre, projectedBoundsWidth unclipped perspective envelope", errors });
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
          scenes.push({ name, failed: true, errors });
        } finally {
          await page.context().close();
          pageErrorCount += errors.filter((e) => e.startsWith("page error:")).length;
          consoleErrorCount += errors.filter((e) => e.startsWith("console error:")).length;
          failures.push(...errors.map((e) => `${name}: ${e}`));
        }
      }
    }
  } finally {
    await browser.close();
    await stream.close();
  }
  const exitCode = failures.length ? 1 : 0;
  const report = { exitCode, pageErrorCount, consoleErrorCount, scenes, failures };
  writeFileSync(join(out, "page-polish.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`exit code: ${exitCode}\n${JSON.stringify(report, null, 2)}`);
  process.exitCode = exitCode;
}

if (import.meta.main) main().catch((error: unknown) => { console.error("exit code: 1", error); process.exitCode = 1; });
