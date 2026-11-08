/** Offline board-area geometry and same-scene area report. No live endpoint, joins or baseline recapture.
 * node --import ./src/ts-resolve.mjs web/capture/stage-sizing.ts --out /tmp/stage-sizing
 * The board's area is the host's (window.__antwar.boardArea()): the HUD's window the camera fits the board to.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "playwright-core";
import { decodeMessage, encodeMessage } from "../../src/live/format.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { launchBrowser, servePage, RECORDING_DIR } from "./browser.ts";
import { startBoxFixture } from "./start-box-fixtures.ts";

// 1024px additionally exercises the conditional-rail desktop layout; it is not a retained-base fixture cell.
export const STAGE_VIEWPORTS = [[1920, 1080], [1366, 768], [1024, 768], [390, 844], [393, 659], [360, 780], [844, 390]] as const;

/** Same rectangular projection definition as the retained base; not raster-segmented visible area. */
async function measure(page: Page, mapW: number, mapH: number) {
  return page.evaluate(({ mapW, mapH }) => {
    const api = window.__antwar!;
    const a = api.boardArea();
    const r = { left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 };
    const stage = { x: a.x0, y: a.y0, width: a.x1 - a.x0, height: a.y1 - a.y0 };
    type Point = [number, number];
    const corners: Point[] = [[0, 0], [mapW, 0], [mapW, mapH], [0, mapH]].map(([x, y]) => api.tileToScreen(x!, y!));
    const clip = (polygon: Point[], axis: 0 | 1, boundary: number, lower: boolean): Point[] => {
      const output: Point[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!;
        const inside = (v: Point) => lower ? v[axis] >= boundary : v[axis] <= boundary;
        if (inside(p)) output.push(p);
        if (inside(p) !== inside(q)) {
          const t = (boundary - p[axis]) / (q[axis] - p[axis]);
          output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
      }
      return output;
    };
    const bounds = (points: Point[]) => {
      if (!points.length) return null;
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
      return { x: Math.min(...xs), y: Math.min(...ys), width, height, area: width * height };
    };
    const screen = clip(clip(clip(clip(corners, 0, 0, true), 0, innerWidth, false), 1, 0, true), 1, innerHeight, false);
    const visible = clip(clip(clip(clip(screen, 0, r.left, true), 0, r.right, false), 1, r.top, true), 1, r.bottom, false);
    return { tick: api.board()?.tick, stage, projectedBoard: bounds(corners), viewportProjection: bounds(screen),
      stageVisibleFootprint: bounds(visible), view: api.view(), nests: api.nests() };
  }, { mapW, mapH });
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: "/tmp/stage-sizing" }, populated: { type: "boolean", default: false } } });
  const out = resolve(values.out!); mkdirSync(out, { recursive: true }); mkdirSync(RECORDING_DIR, { recursive: true });
  const fixture = startBoxFixture("central-lake");
  const shifted = packMessages(unpackMessages(fixture.bytes).map(bytes => {
    const message = decodeMessage(bytes); return encodeMessage({ ...message, tick: message.tick + 100 });
  }));
  const digest = createHash("sha256").update(shifted).digest("hex");
  if (digest !== "ef3dd104456106c2677c98fa8c26633a2e558cc3bdec9dfeb03e8126579ff753") throw new Error(`Fixture differs from retained base: ${digest}`);
  // Extra CSS-state regression probe, not a replacement for the retained no-agent baseline.
  // Add offline wire metadata only; no simulation join, connection, model or inference runs.
  const recording = values.populated ? packMessages(unpackMessages(shifted).map(bytes => {
    const message = decodeMessage(bytes);
    if (!message.full) return bytes;
    return encodeMessage({ ...message, full: { ...message.full, agents: ([0, 1] as const).map(colony => ({
      colony, modelLabel: "Offline layout fixture", joinTick: 100, lastCallTick: 100, prevCallTick: -1,
      order: "hold" as const, orderX: 0, orderY: 0, intent: "Hold position",
    })) } });
  })) : shifted;
  writeFileSync(resolve(RECORDING_DIR, "stage-sizing.bin"), recording);
  const report = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }), startedAt: new Date().toISOString(),
    engine: "Chromium", populatedMetadataProbe: values.populated, sourceFixtureSha256: digest,
    fixtureSha256: createHash("sha256").update(recording).digest("hex"),
    definition: "Corner projection bounds; viewport-clipped projection; board-area-visible footprint (window.__antwar.boardArea()). Not unobscured raster area.",
    cells: [] as unknown[], errors: [] as string[], endedAt: "" };
  const browser = await launchBrowser();
  try {
    for (const board of ["2d", "3d"] as const) for (const [width, height] of STAGE_VIEWPORTS) {
      const served = await servePage(browser, { recording: "stage-sizing", width, height, tilt: true, board, phone: width < 900 });
      const page = served.page;
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === "http://localhost:4718" ? route.fallback() : route.abort());
        await page.goto(served.url);
        const info = await page.evaluate(() => window.__antwar!.ready);
        if (board === "2d") await page.waitForSelector(".d2-btn-board", { state: "attached" });
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(1); await page.evaluate(() => window.__antwar!.frame());
        await page.clock.runFor(249); await page.evaluate(() => window.__antwar!.frame());
        const before = await measure(page, info.mapW, info.mapH);
        await page.clock.runFor(100); await page.evaluate(() => window.__antwar!.frame());
        const after = await measure(page, info.mapW, info.mapH);
        const stable = JSON.stringify(before.stage) === JSON.stringify(after.stage);
        const validTicks = before.tick === 100 && after.tick === 101;
        report.cells.push({ board, width, height, info, before, after, stable, validTicks, errors: served.errors });
        if (!stable || !validTicks || served.errors.length) report.errors.push(`${board} ${width}x${height}: board area/tick/console check failed`);
        console.log(`${board} ${width}x${height}: board area ${before.stage.width}x${before.stage.height}, stable=${stable}`);
      } finally { await page.context().close(); }
      writeFileSync(resolve(out, "measurements.json"), JSON.stringify(report, null, 2));
    }
  } finally {
    await browser.close(); report.endedAt = new Date().toISOString();
    writeFileSync(resolve(out, "measurements.json"), JSON.stringify(report, null, 2));
  }
  if (report.errors.length) throw new Error(report.errors.join("\n"));
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
