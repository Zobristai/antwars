/** Offline start-box browser evidence, run by hand at a chosen head.
 * npm run build:web
 * node --import ./src/ts-resolve.mjs web/capture/start-box-fixtures.ts --out out/start-box-recordings
 * node --import ./src/ts-resolve.mjs web/capture/start-boxes.ts --recordings DIR --browser chromium --out OUT
 * Add --framing for Open Field + Central Lake, both boards, desktop/portrait/landscape
 * opening containment only (12 stills per engine, no injected camera). Repeat with --browser webkit
 * (iPhone 15 for phones, ordinary WebKit for desktop). The unflagged full matrix stays unchanged. DIR contains <map-id>.bin from the finalized
 * nest-pick fixture generator. The pinned older legacy.bin is gone: it carries no grid scale and no longer
 * decodes, and with it the boardless (no-WebGL) scene that only it exercised.
 * No match creation or joining; every browser request is fulfilled from these files/the build.
 * Screenshots require a person's visual judgment; DOM/geometry observations alone are not a render pass.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { chromium, webkit, devices, type Browser } from "playwright-core";
import { decodeMessage, streamQueens, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { isStartingQueen, visibleStartBoxes, type StartLayout, type StartBoxSetup } from "../src/start-boxes.ts";
import { CHROMIUM_FLAGS, HEADLESS_SHELL, addCaptureReaders, type ClientPage } from "./browser.ts";
import { BlankPrimaryBoardError, settle3DBoard } from "./colony-scale.ts";

export const START_MAPS = ["open-field", "three-crossings", "central-lake"] as const;
export const FRAMING_MAPS = ["open-field", "central-lake"] as const;
export const FRAMING_VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  portrait: { width: 393, height: 852 },
  landscape: { width: 852, height: 393 },
} as const;
type FramingViewport = keyof typeof FRAMING_VIEWPORTS;
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Fail the evidence run on cropping; screenshots remain mandatory even on a failure. */
export function assertOpeningContainment(area: Rect, boxCorners: readonly { screen: readonly (readonly number[])[] }[], nests: readonly { rect: Rect }[]): void {
  assert(Object.values(area).every(Number.isFinite) && area.x1 > area.x0 && area.y1 > area.y0, "missing actual board viewport");
  const inside = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) &&
    x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
  assert.equal(boxCorners.length, 2, "opening needs both boxes");
  for (const box of boxCorners) {
    assert.equal(box.screen.length, 4, "box needs all corners");
    assert(box.screen.every(p => inside(p[0]!, p[1]!)), "start box is cropped by the board viewport");
  }
  assert(nests.length > 0, "opening has no starting nests");
  for (const { rect } of nests) assert(inside(rect.x0, rect.y0) && inside(rect.x1, rect.y1), "starting nest is cropped by the board viewport");
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reject missing coverage rather than manufacturing queens or relabelling a current recording as old. */
export function inspectStartRecording(messages: readonly StreamMessage[], mapId: string) {
  const first = messages[0];
  assert(first?.full, "recording needs an opening full snapshot");
  assert.equal(first.tick, 0, "new-match recording must start before the first tick");
  const setup: StartBoxSetup & StartLayout = first.full.setup;
  assert.equal(first.full.setup.terrain?.mapId, mapId, "recording map does not match its name");
  assert(setup.startingQueenIds, "recording lacks starting identities");
  const boxes = visibleStartBoxes(setup), scale = setup.gridScale ?? 1;
  assert.equal(boxes.length, 2, "recording lacks both valid start boxes");
  const strips = boxes.every(box => box.width === setup.mapW / 4 && box.height === setup.mapH);
  for (const box of boxes) {
    if (strips) {
      assert.equal(box.width, setup.mapW / 4); assert.equal(box.height, setup.mapH);
      assert.equal(box.x, box.colony === 0 ? 0 : setup.mapW - setup.mapW / 4); assert.equal(box.y, 0);
    } else {
      assert.equal(box.width, 12 * scale); assert.equal(box.height, 24 * scale);
    }
  }
  assert.equal(boxes[1]!.x, setup.mapW - boxes[0]!.x - boxes[0]!.width);
  assert.equal(boxes[1]!.y, boxes[0]!.y);
  const queens = streamQueens(first.full);
  for (const colony of [0, 1] as const) {
    const ids: readonly number[] = setup.startingQueenIds[colony];
    assert(ids.length >= 2, "fixture must exercise multiple starting queens per colony");
    assert.equal(new Set(ids).size, ids.length, "duplicate starting identity");
    assert.deepEqual(queens.filter(q => q.colony === colony).map(q => q.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
    const box = boxes.find(b => b.colony === colony)!;
    for (const queen of queens.filter(q => q.colony === colony)) {
      const x = queen.x / 256, y = queen.y / 256;
      assert(x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height, "starting nest outside box");
    }
  }
  let founding: { tick: number; colony: 0 | 1; id: number } | undefined;
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    assert.equal(message.tick, first.tick + i, "recording must have continuous ticks");
    assert.equal(message.full, null, "recording contains a second full snapshot");
    for (const event of message.events) if (event.kind === "queenFounded") {
      assert(!isStartingQueen(setup, event.queen), "fixture emits founding for a starting queen");
      founding ??= { tick: message.tick, colony: event.queen.colony, id: event.queen.id };
    }
  }
  assert(founding, "fixture must contain a true in-play founding");
  return { boxes, queens, founding, firstTick: first.tick, lastTick: messages.at(-1)!.tick };
}

/** Paint at the requested tick. Never redraw between a successful 3D check and its screenshot. */
export async function prepareStartFrame(client: ClientPage, board: "2d" | "3d", expectedTick: number, scene: string) {
  const frame = await client.frame(board !== "3d");
  assert.equal(frame.playbackTick, expectedTick, "capture moved from the requested playback tick");
  const primaryBoard = board === "3d" ? await settle3DBoard(client, expectedTick, scene) : null;
  return { frame, primaryBoard };
}

const ORIGIN = "http://localhost:4719";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".bin": "application/octet-stream" };

async function capture(browser: Browser, engine: "chromium" | "webkit", board: "2d" | "3d",
  name: string, bytes: Uint8Array, webDir: string, out: string, expected?: ReturnType<typeof inspectStartRecording>, framing?: FramingViewport) {
  const viewport = framing ? FRAMING_VIEWPORTS[framing] : undefined;
  const options = engine === "webkit" && framing !== "desktop" ? devices["iPhone 15"] : { viewport: FRAMING_VIEWPORTS.desktop, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...options, ...(viewport ? { viewport, screen: viewport } : {}) });
  await addCaptureReaders(context);
  const shotName = framing ? `${name}-${framing}` : name;
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { errors.push(`external request refused: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/recordings/fixture.bin") return route.fulfill({ body: Buffer.from(bytes), contentType: TYPES[".bin"] });
    if (url.pathname === "/live/replays") return route.fulfill({ json: { replays: [] } });
    const file = resolve(webDir, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${webDir}${sep}`)) return route.fulfill({ status: 403, body: "outside build" });
    try { return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" }); }
    catch { errors.push(`missing built resource ${url.pathname}`); return route.fulfill({ status: 404, body: "not found" }); }
  });
  const shots: unknown[] = [];
  try {
    await page.goto(`${ORIGIN}/index.html?recording=fixture&board=${board}&capture=1`);
    const info = await Promise.race([
      page.evaluate(() => window.__antwar.ready),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("browser board readiness exceeded 60 seconds")), 60_000); timer.unref(); }),
    ]);
    if (board === "3d") assert.match(info.rendererName, /babylon/i, "3D silently fell back");
    else assert(!/babylon/i.test(info.rendererName), "2D request started 3D");
    await page.clock.runFor(250);
    const client: ClientPage = { page, info, errors,
      frame: render => page.evaluate(value => window.__antwar.frame(value), render),
      advance: ms => page.clock.runFor(ms),
      setOptions: options => page.evaluate(value => window.__antwar.setOptions(value), options),
      close: () => context.close() };
    const openingTick = decodeMessage(unpackMessages(bytes)[0]!).tick;
    const observe = async (phase: string, expectedTick: number) => {
      const prepared = await prepareStartFrame(client, board, expectedTick, `${name}-${phase}`);
      const observation = { ...prepared, ...await page.evaluate(() => ({ board: window.__antwar.board(), nests: window.__antwar.nests() })) };
      assert(observation.board, "capture has no playback board");
      const geometry = await page.evaluate(({ mapW, mapH, boxes, sample2d }) => {
        const pixels: number[][] = [];
        // 3D has already checked the primary canvas with one readback at its actual
        // resolution. samplePixel redraws, so using it here would invalidate that check.
        if (sample2d) for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) {
          const [sx, sy] = window.__antwar.tileToScreen(mapW * x / 8, mapH * y / 8);
          if (sx >= 0 && sy >= 0 && sx < innerWidth && sy < innerHeight) pixels.push(window.__antwar.samplePixel(sx, sy));
        }
        const stage = window.__antwarCapture.boardArea();
        const area = { x0: Math.max(0, stage.x0), y0: Math.max(0, stage.y0), x1: Math.min(innerWidth, stage.x1), y1: Math.min(innerHeight, stage.y1) };
        return { pixels, area, boxCorners: boxes.map(b => ({ colony: b.colony, tiles: b,
          screen: [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]]
            .map(([x, y]) => window.__antwar.tileToScreen(x!, y!)) })) };
      }, { mapW: info.mapW, mapH: info.mapH, boxes: expected?.boxes ?? [], sample2d: board === "2d" });
      if (board === "2d") {
        assert(geometry.pixels.length >= 4, "fewer than four board samples are visible");
        assert(new Set(geometry.pixels.map(p => p.slice(0, 3).join(","))).size > 3, "primary board appears blank or uniform");
      }
      const file = `${engine}-${shotName}-${board}-${phase}.png`;
      await page.screenshot({ path: join(out, file) });
      shots.push({ file, info, ...observation, geometry });
      if (framing && phase === "first-frame") assertOpeningContainment(geometry.area, geometry.boxCorners, observation.nests);
      return observation;
    };
    const initial = await observe("first-frame", openingTick);
    if (expected) {
      assert.equal(initial.frame.playbackTick, 0);
      assert.deepEqual(initial.nests.map(q => [q.colony, q.id]).sort(), expected.queens.map(q => [q.colony, q.id]).sort());
      if (!framing) {
        await page.clock.runFor(expected.founding.tick * TICK_MS);
        const later = await observe("founded", expected.founding.tick);
        assert.equal(later.frame.playbackTick, expected.founding.tick);
        assert(later.nests.some(q => q.colony === expected.founding.colony && q.id === expected.founding.id));
      }
    } else {
      assert.equal(initial.nests.length, 2);
      assert(initial.nests.every(q => q.id === 0 && !q.lost));
      await page.clock.runFor(1000);
      await observe("playing", openingTick + 1000 / TICK_MS);
    }
    assert.deepEqual(errors, []);
    return { engine, board, name, viewport: viewport ?? options.viewport, framing, recordingSha256: hash(bytes), shots, errors };
  } catch (error) {
    writeFileSync(join(out, `${engine}-${shotName}-${board}-failure.json`), JSON.stringify({ engine, board, name, framing, viewport,
      recordingSha256: hash(bytes), shots, errors, error: error instanceof Error ? error.message : String(error),
      primaryBoard: error instanceof BlankPrimaryBoardError ? { attempts: error.attempts, first: error.first, last: error.last } : null }, null, 2));
    throw error;
  } finally { await context.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { recordings: { type: "string" }, browser: { type: "string" }, out: { type: "string" }, dist: { type: "string", default: "web/dist" }, framing: { type: "boolean", default: false } } });
  assert(values.recordings && values.out, "--recordings and --out required");
  assert(values.browser === "chromium" || values.browser === "webkit", "--browser chromium|webkit required");
  const out = resolve(values.out), webDir = resolve(values.dist), root = resolve(values.recordings);
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { head: string; records: { filename: string; sha256: string; [key: string]: unknown }[] };
  const candidates = (values.framing ? FRAMING_MAPS : START_MAPS).map(map => {
    const bytes = readFileSync(join(root, `${map}.bin`));
    assert.equal(manifest.records.find(r => r.filename === `${map}.bin`)?.sha256, hash(bytes), "recording differs from fixture provenance");
    return { map, bytes, expected: inspectStartRecording(unpackMessages(bytes).map(decodeMessage), map) };
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(manifest.head, head, "regenerate the fixtures at the exact capture head");
  const browser = values.browser === "chromium" ? await chromium.launch({ executablePath: HEADLESS_SHELL, args: CHROMIUM_FLAGS }) : await webkit.launch();
  const observations: unknown[] = [];
  try {
    for (const fixture of candidates) for (const board of ["2d", "3d"] as const) {
      if (values.framing) for (const viewport of Object.keys(FRAMING_VIEWPORTS) as FramingViewport[]) {
        observations.push(await capture(browser, values.browser, board, fixture.map, fixture.bytes, webDir, out, fixture.expected, viewport));
      } else observations.push(await capture(browser, values.browser, board, fixture.map, fixture.bytes, webDir, out, fixture.expected));
    }
  } finally {
    writeFileSync(join(out, "observations.json"), JSON.stringify({ head, fixtures: manifest, browser: values.browser, version: browser.version(), visualJudgment: "required from a person", observations }, null, 2));
    await browser.close();
  }
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
