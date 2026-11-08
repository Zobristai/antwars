/** Offline browser evidence, run by hand. No live endpoint or match joining.
 * node --import ./src/ts-resolve.mjs web/capture/finer-grid.ts --manifest out/finer-grid/inputs.json --browser chromium --out out/finer-grid/chromium
 * Repeat with --browser webkit (iPhone 15). Input recordings must come from the
 * pinned simulation commits, not from relabelling candidate bytes as old footage.
 * Screenshots are observations awaiting review, never an automatic pass.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit, devices, type Browser, type Page } from "playwright-core";
import { decodeMessage } from "../../src/live/format.ts";
import { unpackMessages, TICK_MS } from "../../src/live/snapshot.ts";
import type { ClientInfo } from "../src/main.ts";
import { RENDER_DELAY_MS } from "../src/buffer.ts";
import { addCaptureReaders, type ClientPage } from "./browser.ts";
import type { Antwar3dApi } from "../src/board3d/main3d.ts";
import { settle3DBoard, boundedCapture, boardPixelCheck } from "./colony-scale.ts";
import { setTimeout as pause } from "node:timers/promises";
import { imagePin, measurementTemplate, type ScaleImage } from "./finer-grid-measurements.ts";

/** Readiness is paint, not a fixed number of immediate draws. Never advance the clock. */
export async function prepareFinerGridFrame(client: ClientPage, board: "2d" | "3d", tick: number, scene: string) {
  const frame = await client.frame(board !== "3d");
  assert.equal(frame.playbackTick, tick, "capture moved from requested tick");
  const primaryBoard = board === "3d" ? await settle3DBoard(client, tick, scene) : await settle2DBoard(client, tick, scene);
  return { frame, primaryBoard };
}

/** Same-tick Pixi draw/readback. Node's timer yields for async shader compilation;
 * page time, public camera and scene options are never changed by readiness.
 */
export async function settle2DBoard(client: ClientPage, expectedTick: number, scene: string) {
  const started = performance.now(), deadline = started + 20_000;
  const read = async () => {
    const pixels = await boundedCapture(client.page.evaluate(({ mapW, mapH, expectedTick }) => {
      const api = window.__antwar;
      const before = api.view();
      const frame = api.frame();
      if (frame.playbackTick !== expectedTick) throw new Error(`2D draw moved playback to ${frame.playbackTick}, expected ${expectedTick}`);
      const after = api.view();
      if (["ox", "oy", "tilePx"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error("2D readiness moved camera");
      const canvas = document.querySelector("canvas");
      const gl = canvas?.getContext("webgl2");
      if (!gl) throw new Error("2D primary canvas has no WebGL2 context");
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      if (!width || !height) throw new Error("2D primary canvas has no drawable pixels");
      const rgba = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      const at = (x: number, y: number): [number, number, number, number] => {
        const i = (y * width + x) * 4;
        return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!];
      };
      const a = window.__antwarCapture.boardArea(), area = { left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 }, box = canvas!.getBoundingClientRect();
      const samples: [number, number, number, number][] = [];
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        const [sx, sy] = api.tileToScreen(mapW * (0.08 + 0.84 * (x + 0.5) / 16), mapH * (0.08 + 0.84 * (y + 0.5) / 12));
        if (sx < Math.max(0, area.left, box.left) || sx >= Math.min(innerWidth, area.right, box.right) || sy < Math.max(0, area.top, box.top) || sy >= Math.min(innerHeight, area.bottom, box.bottom)) continue;
        samples.push(at(Math.floor((sx - box.left) * width / box.width), height - 1 - Math.floor((sy - box.top) * height / box.height)));
      }
      return { samples, background: at(0, height - 1) };
    }, { mapW: client.info.mapW, mapH: client.info.mapH, expectedTick }), scene, Math.max(1, deadline - performance.now()));
    return boardPixelCheck(pixels.samples, pixels.background);
  };
  const first = await read();
  let last = first, attempts = 1;
  while (!last.nonblank && performance.now() < deadline) {
    await pause(Math.min(100, Math.max(0, deadline - performance.now())));
    if (performance.now() >= deadline) break;
    last = await read(); attempts++;
  }
  if (!last.nonblank) throw new Error(`${scene}: blank primary 2D board after ${attempts} draws; ${JSON.stringify({ first, last })}`);
  return { first, last, attempts, elapsedMs: performance.now() - started, manualClockAdvanceMs: 0, playbackTick: expectedTick };
}

type HomeView = { view: { ox: number; oy: number; tilePx: number }; camera: ReturnType<Antwar3dApi["camera"]> | null };
export async function restoreFinerGridHome(page: Pick<Page, "evaluate">, initial: HomeView): Promise<void> {
  await page.evaluate(({ view, camera }) => {
    const api = window.__antwar;
    if (camera) (api as Antwar3dApi).setView(camera.view);
    else {
      api.zoomAt(view.tilePx / api.view().tilePx, innerWidth / 2, innerHeight / 2);
      const now = api.view();
      api.panBy(view.ox - now.ox, view.oy - now.oy);
    }
  }, initial);
}
export function assertReturnedHome(initial: HomeView, home: HomeView): void {
  for (const key of ["ox", "oy", "tilePx"] as const) {
    assert(Math.abs(home.view[key] - initial.view[key]) < 0.01, `returned home differs at ${key}`);
  }
  if (initial.camera) {
    assert(home.camera && home.camera.view === initial.camera.view, "returned home changed camera preset");
    for (const key of ["alpha", "beta", "radius"] as const) {
      assert(Math.abs(home.camera[key] - initial.camera[key]) < 0.01, `returned home differs at camera ${key}`);
    }
    assert(home.camera.target.every((v, i) => Math.abs(v - initial.camera!.target[i]!) < 0.01), "returned home changed camera target");
  }
}

/** Keep raw values even on a failed check; do not turn a failed case into an empty result. */
export function returnedHomeEvidence(initial: HomeView, home: HomeView) {
  const delta = { ox: home.view.ox - initial.view.ox, oy: home.view.oy - initial.view.oy, tilePx: home.view.tilePx - initial.view.tilePx };
  let failure: string | null = null;
  try { assertReturnedHome(initial, home); } catch (error) { failure = String(error); }
  return { initial: { view: initial.view, camera: initial.camera }, returned: { view: home.view, camera: home.camera }, delta, tolerance: 0.01, comparison: "absolute difference strictly less than tolerance", failure };
}

export async function scaleContext(page: Pick<Page, "evaluate">, mapW: number, mapH: number, physicalScale: number) {
  return page.evaluate(({ mapW, mapH, physicalScale }) => {
    const api = window.__antwar, stage = window.__antwarCapture.boardArea();
    const area = { x0: Math.max(0, stage.x0), y0: Math.max(0, stage.y0), x1: Math.min(innerWidth, stage.x1), y1: Math.min(innerHeight, stage.y1) };
    const corners = [[0, 0], [mapW, 0], [mapW, mapH], [0, mapH]].map(([x, y]) => api.tileToScreen(x!, y!));
    const positions = [[mapW / 2, mapH / 2], [mapW / 4, mapH / 4], [mapW * 3 / 4, mapH * 3 / 4]];
    const pixelsPerPhysicalTile = positions.map(([x, y]) => {
      const p = api.tileToScreen(x!, y!), px = api.tileToScreen(x! + physicalScale, y!), py = api.tileToScreen(x!, y! + physicalScale);
      return { tile: [x, y], screen: p, x: Math.hypot(px[0] - p[0], px[1] - p[1]), y: Math.hypot(py[0] - p[0], py[1] - p[1]) };
    });
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, area, physicalScale, mapW, mapH, corners,
      projectedBounds: { x0: Math.min(...corners.map(p => p[0])), y0: Math.min(...corners.map(p => p[1])), x1: Math.max(...corners.map(p => p[0])), y1: Math.max(...corners.map(p => p[1])) }, pixelsPerPhysicalTile };
  }, { mapW, mapH, physicalScale });
}

export function edgesVisible(corners: readonly (readonly number[])[], area: Area): boolean {
  return corners.length === 4 && corners.every(p => p.length === 2 && p.every(Number.isFinite) && p[0]! >= area.x0 + 4 && p[0]! <= area.x1 - 4 && p[1]! >= area.y0 + 4 && p[1]! <= area.y1 - 4);
}

type PhysicalPixels = { x: number; y: number };
type ScaleSnapshot = { scale: { pixelsPerPhysicalTile: PhysicalPixels[] } };
export const MATCHED_ZOOM_EPSILON = 0.000001;
export function zoomDifference(actual: PhysicalPixels, target: PhysicalPixels) {
  assert([actual.x, actual.y, target.x, target.y].every(v => Number.isFinite(v) && v > 0), "Invalid physical-tile projection");
  return { x: actual.x - target.x, y: actual.y - target.y,
    error: Math.hypot(Math.log(actual.x / target.x), Math.log(actual.y / target.y)),
    equal: Math.abs(actual.x - target.x) < MATCHED_ZOOM_EPSILON && Math.abs(actual.y - target.y) < MATCHED_ZOOM_EPSILON };
}

/** Every attempt is a genuine new screenshot reached using public zoom. When clamps
 * or differing projection angles prevent equality, retain the closest captured
 * pair and every attempted scale, not a fabricated equal-zoom image.
 */
export async function captureMatchedZoom<T extends ScaleSnapshot>(target: PhysicalPixels, sample: (attempt: number) => Promise<T>, zoom: (factor: number) => Promise<void>) {
  const attempts: T[] = [];
  let best = 0, bestError = Infinity, factor = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    await zoom(factor);
    const snapshot = await sample(attempt);
    attempts.push(snapshot);
    const current = snapshot.scale.pixelsPerPhysicalTile[0]!;
    const difference = zoomDifference(current, target);
    if (difference.error < bestError) { best = attempt; bestError = difference.error; }
    if (difference.equal) break;
    // The geometric mean minimizes log-scale error for two axes under one scalar zoom.
    // Perspective can make the axes incompatible; don't claim X equality implies Y equality.
    factor = Math.max(0.25, Math.min(4, Math.sqrt(target.x / current.x * target.y / current.y)));
    if (attempt > 0) {
      const prior = attempts[attempt - 1]!.scale.pixelsPerPhysicalTile[0]!;
      if (Math.abs(current.x - prior.x) < 1e-10 && Math.abs(current.y - prior.y) < 1e-10) break;
    }
  }
  return { best: attempts[best]!, attempts, difference: zoomDifference(attempts[best]!.scale.pixelsPerPhysicalTile[0]!, target), target, epsilonCssPx: MATCHED_ZOOM_EPSILON };
}

type MatchReference = PhysicalPixels & { file: string; sha256: string };
type AntPoint = { id: number; x: number; y: number };
type Area = { x0: number; y0: number; x1: number; y1: number };
export function assertVisibleDetour(point: readonly number[], area: Area, picked: number | null, id: number): void {
  assert(point.length === 2 && point.every(Number.isFinite), "detour ant projection is invalid");
  assert(point[0]! >= area.x0 + 12 && point[0]! <= area.x1 - 12 &&
    point[1]! >= area.y0 + 12 && point[1]! <= area.y1 - 12, "detour ant is outside the unobscured board interior");
  assert.equal(picked, id, "recorded detour ant is not present at the visible projected point");
}

/** The existing detour fixture has exactly one ant; never silently pick a different one. */
export function detourAnts(bytes: Uint8Array, ticks: readonly number[]): Map<number, AntPoint> {
  const messages = unpackMessages(bytes).map(decodeMessage);
  const id = messages[0]?.ants.id[0];
  assert(id !== undefined, "detour recording has no ant");
  return new Map(ticks.map(tick => {
    const ants = messages.find(m => m.tick === tick)?.ants;
    assert(ants?.count === 1 && ants.id[0] === id, "detour fixture must retain the same single ant");
    return [tick, { id, x: ants.x[0]! / 256, y: ants.y[0]! / 256 }];
  }));
}

export interface RecordingPin { path: string; sha256: string }
export interface CaptureCase {
  name: string;
  kind: "map" | "lake-detour" | "legacy";
  mapId?: string;
  recording: RecordingPin;
  /** Absolute simulation ticks, including approach/edge/detour for the motion case. */
  ticks: number[];
  baseline?: RecordingPin;
}
export interface CaptureManifest {
  head: string;
  baselineHead: string;
  dist: string;
  baselineDist: string;
  cases: CaptureCase[];
}

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAPS = ["open-field", "three-crossings", "central-lake"];
export function validateManifest(input: CaptureManifest): void {
  if (!SHA.test(input.head) || !SHA.test(input.baselineHead)) throw new Error("Full head and baseline commit pins required");
  if (!input.dist || !input.baselineDist || !Array.isArray(input.cases)) throw new Error("Built candidate, baseline and cases required");
  const names = new Set<string>();
  for (const c of input.cases) {
    if (!/^[a-z0-9-]+$/.test(c.name) || names.has(c.name)) throw new Error("Unique safe capture names required");
    names.add(c.name);
    if (!["map", "lake-detour", "legacy"].includes(c.kind)) throw new Error("Unknown capture kind");
    if (!Array.isArray(c.ticks) || !c.ticks.length || c.ticks.some((tick, i) => !Number.isSafeInteger(tick) || tick < 0 || (i > 0 && tick <= c.ticks[i - 1]!))) throw new Error("Capture ticks must increase");
    for (const pin of [c.recording, ...(c.baseline ? [c.baseline] : [])]) {
      if (!pin?.path || !DIGEST.test(pin.sha256)) throw new Error("Recording path and SHA-256 required");
    }
    if (c.kind === "map" && (!c.baseline || !c.mapId)) throw new Error("Each map needs a matched baseline recording");
    if (c.kind === "lake-detour" && (c.mapId !== "central-lake" || c.ticks.length < 3)) throw new Error("Lake motion needs approach, edge and detour ticks");
  }
  for (const mapId of MAPS) if (!input.cases.some(c => c.kind === "map" && c.mapId === mapId)) throw new Error(`Missing map ${mapId}`);
  for (const kind of ["lake-detour", "legacy"]) if (!input.cases.some(c => c.kind === kind)) throw new Error(`Missing ${kind} playback`);
}

export function inspectRecording(bytes: Uint8Array, pin: RecordingPin, c: CaptureCase) {
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`Recording digest mismatch: ${pin.path}`);
  const messages = unpackMessages(bytes).map(decodeMessage);
  if (!messages.length || !messages[0]!.full) throw new Error("Recording must start with a full frame");
  for (let i = 1; i < messages.length; i++) if (messages[i]!.tick !== messages[i - 1]!.tick + 1) throw new Error("Recording ticks are discontinuous");
  const setup = messages[0]!.full!.setup;
  if (c.mapId && setup.terrain?.mapId !== c.mapId) throw new Error(`Recording is not ${c.mapId}`);
  const firstTick = messages[0]!.tick, lastTick = messages.at(-1)!.tick;
  if (c.ticks.some(t => t < firstTick || t > lastTick)) throw new Error("Requested tick outside recording");
  return { firstTick, lastTick, messages: messages.length, setup };
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".bin": "application/octet-stream" };
const ORIGIN = "http://localhost:4718";

export async function captureFinerGridCase(browser: Browser, browserName: "chromium" | "webkit", dist: string, bytes: Uint8Array,
  recording: ReturnType<typeof inspectRecording>, c: CaptureCase, board: "2d" | "3d", phase: string, out: string, device: "desktop" | "iphone15", scaleImages: ScaleImage[], detail = false, matchReferences = new Map<string, MatchReference>()) {
  const context = await browser.newContext(device === "iphone15" ? devices["iPhone 15"] : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await addCaptureReaders(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { errors.push(`Unexpected network request ${url.origin}`); return route.abort(); }
    if (url.pathname === "/recordings/finer-grid.bin") return route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" });
    if (url.pathname === "/live/replays") return route.fulfill({ json: { replays: [] } });
    // The stored-match history (replay.ts loadHistory): one empty page, as a server with no stored matches answers.
    if (url.pathname === "/matches") return route.fulfill({ json: { matches: [], nextPageToken: null } });
    const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${resolve(dist)}/`)) return route.abort();
    try { return await route.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] ?? "application/octet-stream" }); }
    catch { errors.push(`Missing offline resource ${url.pathname}`); return route.fulfill({ status: 404 }); }
  });
  const observations: unknown[] = [], failures: string[] = [];
  let capturedInfo: ClientInfo | null = null;
  try {
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1000);
    await page.goto(`${ORIGIN}/index.html?recording=finer-grid&capture=1&tilt=0&board=${board}`);
    await page.waitForFunction(() => typeof window.__antwar !== "undefined", undefined, { timeout: 30_000 });
    const info = await Promise.race([
      page.evaluate(() => window.__antwar.ready),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Board readiness timeout")), 30_000); timer.unref(); }),
    ]) as ClientInfo;
    capturedInfo = info;
    if (!info.webgl2) throw new Error(`No WebGL2: ${info.rendererString}`);
    const client: ClientPage = { page, info, errors,
      frame: render => page.evaluate(render => window.__antwar.frame(render), render),
      advance: ms => page.clock.runFor(ms),
      setOptions: options => page.evaluate(options => window.__antwar.setOptions(options), options),
      close: () => context.close() };
    const antPositions = detail ? detourAnts(bytes, c.ticks) : null;
    const observe = async (tick: number, label: string, ant?: AntPoint) => {
      const prepared = await prepareFinerGridFrame(client, board, tick, `${c.name}/${phase}/${board}/${label}`);
      // These accessors do not draw. Preserve the successful primary-canvas readback until the screenshot.
      const state = await page.evaluate(ant => {
        const api = window.__antwar;
        const stage = window.__antwarCapture.boardArea();
        const area = { x0: Math.max(0, stage.x0), y0: Math.max(0, stage.y0), x1: Math.min(innerWidth, stage.x1), y1: Math.min(innerHeight, stage.y1) };
        const point = ant ? api.tileToScreen(ant.x, ant.y) : null;
        return { board: api.board(), nests: api.nests(), view: api.view(),
          camera: "camera" in api ? (api as Antwar3dApi).camera() : null,
          detour: ant && point ? { ...ant, point, area, picked: api.antAt(...point) } : null };
      }, ant);
      const scale = await scaleContext(page, recording.setup.mapW, recording.setup.mapH, recording.setup.gridScale ?? 1);
      const file = `${c.name}-${phase}-${device}-${board}-${tick}-${label}.png`;
      const bytes = await page.screenshot({ path: join(out, file) });
      const image = imagePin(file, bytes, scale.viewport.width, scale.viewport.height);
      if (c.kind === "map" && (label === "default" || label === "returned-home")) scaleImages.push({ image,
        context: { map: c.name, phase, board, browser: browserName, device, tick, label }, scale });
      assert(state.board?.tick === tick && state.nests.length, `Wrong/empty frame at requested tick ${tick}`);
      if (state.detour) assertVisibleDetour(state.detour.point, state.detour.area, state.detour.picked, state.detour.id);
      return { tick, file, image, label, scale, ...prepared, ...state };
    };
    let elapsed = 0;
    for (const tick of c.ticks) {
      const wanted = (tick - recording.firstTick) * TICK_MS + RENDER_DELAY_MS;
      if (wanted > elapsed) await page.clock.runFor(wanted - elapsed);
      elapsed = wanted;
      if (detail) {
        const ant = antPositions!.get(tick)!;
        // Viewer pan only, in a separate labelled pass. Default evidence is never replaced.
        for (let i = 0; i < 4; i++) {
          await client.frame(false);
          await page.evaluate(ant => {
            const stage = window.__antwarCapture.boardArea();
            const x = (Math.max(0, stage.x0) + Math.min(innerWidth, stage.x1)) / 2;
            const y = (Math.max(0, stage.y0) + Math.min(innerHeight, stage.y1)) / 2;
            const point = window.__antwar.tileToScreen(ant.x, ant.y);
            window.__antwar.panBy(x - point[0], y - point[1]);
          }, ant);
        }
        observations.push(await observe(tick, "detour-detail", ant));
        continue;
      }
      const initial = await observe(tick, "default");
      observations.push(initial);
      if (c.kind === "map") {
        const whole = page.getByRole("button", { name: "Whole board", exact: true });
        assert.equal(await whole.count(), 1, "Whole-board capture control is missing or ambiguous");
        await whole.click();
        observations.push(await observe(tick, "whole-board"));
        // Exercise the viewer's zoom/pan, then return to the saved initial home.
        // 3D's view preset is its home; 2D restores its saved home through its public zoom/pan API.
        await page.evaluate(() => {
          window.__antwar.zoomAt(1.2, innerWidth / 2, innerHeight / 2);
          window.__antwar.panBy(24, 16);
        });
        await client.frame(false);
        const excursion = await page.evaluate(() => window.__antwar.view());
        assert.notDeepEqual(excursion, initial.view, "camera excursion did not leave home");
        await restoreFinerGridHome(page, initial);
        const home = await observe(tick, "returned-home");
        const homeCheck = returnedHomeEvidence(initial, home);
        observations.push({ ...home, excursion, homeCheck, returnMethod: initial.camera ? "shipped 3D view preset" : "public zoom/pan restoring initial home" });
        if (homeCheck.failure) failures.push(`${tick}: ${homeCheck.failure}; ${JSON.stringify(homeCheck)}`);
        const matchKey = `${c.name}/${device}/${board}/${tick}`;
        const reference = phase === "baseline" ? null : matchReferences.get(matchKey);
        const target = phase === "baseline" ? initial.scale.pixelsPerPhysicalTile[0]! : reference;
        if (target) {
          const matched = await captureMatchedZoom(target,
            attempt => observe(tick, `matched-zoom-attempt-${attempt}`),
            factor => page.evaluate(factor => { window.__antwar.zoomAt(factor, innerWidth / 2, innerHeight / 2); }, factor));
          const best = matched.best;
          observations.push({ ...best, label: "matched-zoom", matchedZoom: { reference, target: matched.target,
            actual: best.scale.pixelsPerPhysicalTile[0], difference: matched.difference, epsilonCssPx: matched.epsilonCssPx,
            at: "map centre; both projected physical-tile axes", attempts: matched.attempts.map(a => ({ image: a.image, scale: a.scale, view: a.view, camera: a.camera })) } });
          scaleImages.push({ image: best.image, context: { map: c.name, phase, board, browser: browserName, device, tick, label: "matched-zoom" }, scale: best.scale,
            normalization: { target: { x: matched.target.x, y: matched.target.y }, baseline: reference ? { file: reference.file, sha256: reference.sha256 } : null } });
          if (phase === "baseline") matchReferences.set(matchKey, { ...best.scale.pixelsPerPhysicalTile[0]!, file: best.image.file, sha256: best.image.sha256 });
          // Reached zoom and target stay in the evidence. Size is judged from measured
          // objects normalized to that target, not from camera convergence alone.
        } else {
          failures.push(`${tick}: missing baseline matched-zoom reference; no equal-scale comparison claimed`);
        }
        if (device === "iphone15" && board === "3d") {
          await restoreFinerGridHome(page, initial);
          // A separately labelled viewer adjustment, never a replacement default/home view.
          // Shipped zoom/pan may clamp; an unreachable edge remains an explicit gap.
          let scale = await scaleContext(page, recording.setup.mapW, recording.setup.mapH, recording.setup.gridScale ?? 1);
          const moves = [];
          for (let attempt = 0; attempt < 8 && !edgesVisible(scale.corners, scale.area); attempt++) {
            const move = await page.evaluate(({ area, bounds }) => {
              const api = window.__antwar;
              const dx = (area.x0 + area.x1 - bounds.x0 - bounds.x1) / 2;
              const dy = (area.y0 + area.y1 - bounds.y0 - bounds.y1) / 2;
              api.panBy(dx, dy);
              api.zoomAt(0.8, (area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2);
              return { pan: [dx, dy], zoomFactor: 0.8 };
            }, { area: scale.area, bounds: scale.projectedBounds });
            await client.frame(false);
            scale = await scaleContext(page, recording.setup.mapW, recording.setup.mapH, recording.setup.gridScale ?? 1);
            moves.push({ ...move, scale });
          }
          const edge = await observe(tick, "board-edges-public-camera");
          const visible = edgesVisible(edge.scale.corners, edge.scale.area);
          observations.push({ ...edge, moves, edgesVisible: visible });
          if (!visible) failures.push(`${tick}: shipped public camera controls did not expose all board edges; water outside the board remains unjudgeable`);
          await restoreFinerGridHome(page, initial);
        }
      }
    }
  } catch (error) { failures.push(String(error)); }
  finally { await context.close(); }
  failures.push(...errors);
  return { name: c.name, phase, board, browser: browser.version(), device, info: capturedInfo, recording, observations, failures };
}

export async function runCapture(manifestPath: string, browserName: "chromium" | "webkit", out: string) {
  const manifest: CaptureManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== manifest.head) throw new Error("Checkout head differs from requested render head");
  const root = dirname(resolve(manifestPath));
  await mkdir(out, { recursive: true });
  const results: unknown[] = [], failures: string[] = [], scaleImages: ScaleImage[] = [];
  const matchReferences = new Map<string, MatchReference>();
  const browser = await (browserName === "webkit" ? webkit.launch() : chromium.launch({ executablePath: process.env.HEADLESS_SHELL, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }));
  try {
    for (const c of manifest.cases) for (const phase of [...(c.baseline ? ["baseline"] : []), "candidate"]) {
      const pin = phase === "baseline" ? c.baseline! : c.recording;
      const bytes = await readFile(resolve(root, pin.path));
      const recording = inspectRecording(bytes, pin, c);
      for (const device of ["desktop", "iphone15"] as const) for (const board of ["2d", "3d"] as const) for (const detail of c.kind === "lake-detour" ? [false, true] : [false]) {
        try {
          const result = await captureFinerGridCase(browser, browserName, resolve(root, phase === "baseline" ? manifest.baselineDist : manifest.dist), bytes, recording, c, board, phase, out, device, scaleImages, detail, matchReferences);
          results.push(result);
          failures.push(...result.failures.map(failure => `${c.name}/${phase}/${device}/${board}${detail ? "/detour-detail" : ""}: ${failure}`));
        } catch (error) { failures.push(`${c.name}/${phase}/${device}/${board}: ${String(error)}`); }
      }
    }
  } finally {
    await browser.close();
    await writeFile(join(out, "observations.json"), JSON.stringify({ head, baselineHead: manifest.baselineHead, browserName,
      status: failures.length ? "capture-failed" : "captured-awaiting-visual-review", results, failures, scaleImages }, null, 2));
    await writeFile(join(out, "object-bounds.json"), JSON.stringify(measurementTemplate(scaleImages), null, 2));
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, out: { type: "string" }, browser: { type: "string", default: "chromium" } } });
  if (!values.manifest || !values.out || !["chromium", "webkit"].includes(values.browser)) throw new Error("--manifest, --out and --browser chromium|webkit required");
  await runCapture(values.manifest, values.browser as "chromium" | "webkit", resolve(values.out));
}
