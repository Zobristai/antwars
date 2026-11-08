/** Static start-state fixtures; no agent joins, house players or playtests.
 * Run by hand: node --import ./src/ts-resolve.mjs web/capture/terrain.ts --out out/terrain --dist web/dist
 * Optional --baseline-dist captures matching before/after views and checks unchanged 2D dry pixels.
 * --live-layout --tick 3100 uses the existing snapshot-recording path in the shipped live-page layout.
 * Default framing is always captured first, then the shipped Whole board control, then the ring probe.
 * Blank 3D views get bounded attempts, then a re-shoot after the other views warm the renderer.
 * Open Field also tries one matched alternative tick for diagnosis only. Acceptance uses the requested tick.
 * Unrendered requested-tick pairs remain incomplete, never passed.
 * Only rendered before/after pairs are judged; real ground, edge, interaction and error checks still fail.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Browser } from "playwright-core";
import { decodeMessage, encodeMessage, SUB_TILE, TERRITORY_WIN_STREAM_VERSION, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { packMessages } from "../../src/live/snapshot.ts";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { Antwar3dApi } from "../src/board3d/main3d.ts";
import type { FrameResult } from "../src/main.ts";
import { type Area } from "../src/board3d/view.ts";
import { boardPixelCheck, boundedReady } from "./page-polish.ts";
import { BOUNDARY_TILES, WaterMask } from "../src/terrain.ts";
import { BlankPrimaryBoardError, settle3DBoard } from "./colony-scale.ts";
import { RECORDING_DIR, WEB_DIR, checkRenderer, launchBrowser, servePage, type ClientPage, type OpenOptions } from "./browser.ts";

/** An honest simulation snapshot, not a manufactured history. No inputs or agent joins. */
export function terrainFixture(template: SimConfig, tick = 0): StreamMessage {
  // Every match plays at grid scale 2: a reference-grid rules template is built at that scale here, once.
  const config = template.gridScale === undefined ? withGridScale(template) : template;
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > config.matchTicks) throw new Error("terrain fixture tick is outside the match");
  let state = createMatch(7001, config);
  while (state.tick < tick && state.result === null) state = step(state).state;
  if (state.tick !== tick) throw new Error(`terrain fixture ended at ${state.tick}, before requested tick ${tick}`);
  if (state.agents.length !== 0) throw new Error("terrain fixture must have no joined agents");
  const recorder = new SpectatorRecorder(state);
  return decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
}

/** A baseline projection, not a second simulated history. Main predates rocks:
 * preserve every other snapshot field and let the encoder select its legacy format.
 * The candidate is returned unchanged, including its version-12 appearance data.
 */
export function terrainPhaseFixture(fixture: StreamMessage, phase: "before" | "after"): StreamMessage {
  const full = fixture.full, terrain = full?.setup.terrain;
  if (phase === "after" || !full || !terrain || terrain.rocks === undefined) return fixture;
  const { rocks: _rocks, ...waterOnly } = terrain;
  return { ...fixture, full: { ...full, setup: { ...full.setup, terrain: waterOnly } } };
}

export function terrainRecordingName(mapId: string, tick: number, scenario: "ordinary" | "spread-queens", phase: "before" | "after"): string {
  return `terrain-${mapId}-${tick}-${scenario}-${phase}`;
}

interface TerrainScene {
  playbackTick: number;
  board: ReturnType<typeof window.__antwar.board>;
  waitingVisible: boolean;
  liveQueens: number;
}

/** Empty live pages may paint textured ground. Paint is not evidence of a match. */
export function assertTerrainScene(scene: TerrainScene, expectedTick: number): void {
  if (scene.waitingVisible || scene.liveQueens === 0 || scene.board === null) throw new Error("terrain capture is an empty live page: waiting for delayed footage or no live queens");
  if (scene.playbackTick !== expectedTick || scene.board.tick !== expectedTick) throw new Error(`terrain capture is not the requested match tick ${expectedTick}: frame ${scene.playbackTick}, board ${scene.board.tick}`);
}

async function terrainScene(client: ClientPage, expectedTick: number): Promise<TerrainScene> {
  const scene = await client.page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const waiting = document.getElementById("aw-waiting");
    const frame = window.__antwar.frame(false);
    return { playbackTick: frame.playbackTick, board: window.__antwar.board(),
      waitingVisible: waiting !== null && !waiting.hidden && visible(waiting),
      liveQueens: window.__antwar.nests().filter((queen) => !queen.lost).length };
  });
  assertTerrainScene(scene, expectedTick);
  return scene;
}

/** Deterministic dry controls outside the changed boundary band; no water-tile comparisons. */
export function dryControls(message: StreamMessage): [number, number][] {
  const setup = message.full!.setup;
  const mask = new WaterMask(setup.mapW, setup.mapH);
  mask.update(setup.terrain);
  const out: [number, number][] = [];
  for (let y = 3; y < setup.mapH - BOUNDARY_TILES; y += 7) {
    for (let x = 3; x < setup.mapW - BOUNDARY_TILES; x += 7) {
      const at = (y * setup.mapW + x) * 4;
      if (mask.data[at] === 0 && mask.data[at + 1] === 0) out.push([x + 0.5, y + 0.5]);
    }
  }
  return out;
}

/** A labelled static visual fixture, not a simulated history: only the original
 * live queens and their setup anchors move; the snapshot's other contents stay intact.
 */
export function spreadQueenFixture(message: StreamMessage): StreamMessage {
  const fixture = structuredClone(message), full = fixture.full;
  if (!full || full.agents.length || full.result) throw new Error("spread-queen scene needs a nonterminal full snapshot with no agents");
  const { mapW, mapH } = full.setup;
  if (mapW < 8 || mapH < 8) throw new Error("spread-queen scene needs room for corner nests");
  const positions: [[number, number], [number, number]] = [[3.5 * SUB_TILE, 3.5 * SUB_TILE], [(mapW - 3.5) * SUB_TILE, (mapH - 3.5) * SUB_TILE]];
  for (const colony of [0, 1] as const) {
    const queen = full.queens?.find((queen) => queen.colony === colony && queen.id === 0 && queen.lostTick === null);
    if (!queen) throw new Error("spread-queen scene requires both original live queens");
    [queen.x, queen.y] = positions[colony];
  }
  const water = new WaterMask(mapW, mapH);
  water.update(full.setup.terrain);
  if (positions.some(([x, y]) => water.data[(Math.floor(y / SUB_TILE) * mapW + Math.floor(x / SUB_TILE)) * 4] !== 0)) throw new Error("spread-queen corner is in water");
  full.setup.queens = positions;
  return fixture;
}

export function boardEdgeTiles(mapW: number, mapH: number): [number, number][] {
  const tiles: [number, number][] = [];
  for (let x = 0; x <= mapW; x++) tiles.push([x, 0]);
  for (let y = 1; y <= mapH; y++) tiles.push([mapW, y]);
  for (let x = mapW - 1; x >= 0; x--) tiles.push([x, mapH]);
  for (let y = mapH - 1; y > 0; y--) tiles.push([0, y]);
  return tiles;
}

export type MarginReport = {
  status: "no-margin-in-frame" | "margin-present-not-sampled" | "margin-present";
  area: number;
  points: [number, number][];
};

/** Screen-space clipping only: all perimeter points come from the renderer's
 * tileToScreen (including its real ground heights). Backdrop pixels are excluded.
 * Geometry presence is independent of whether a margin contains CSS pixel centres.
 */
export function offboardScreenProbes(outline: readonly (readonly [number, number])[], stage: Area): MarginReport {
  if (outline.length < 3 || outline.some((point) => point.some((value) => !Number.isFinite(value))) || !Object.values(stage).every(Number.isFinite) || stage.x1 <= stage.x0 || stage.y1 <= stage.y0) throw new Error("invalid projected board outline or stage");
  let clipped = outline.map(([x, y]): [number, number] => [x, y]);
  for (const [axis, edge, direction] of [[0, stage.x0, 1], [0, stage.x1, -1], [1, stage.y0, 1], [1, stage.y1, -1]] as const) {
    const next: [number, number][] = [];
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i]!, b = clipped[(i + 1) % clipped.length]!;
      const insideA = direction * (a[axis] - edge) >= 0, insideB = direction * (b[axis] - edge) >= 0;
      if (insideA) next.push(a);
      if (insideA !== insideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    clipped = next;
  }
  const boardArea = Math.abs(clipped.reduce((sum, a, i) => { const b = clipped[(i + 1) % clipped.length]!; return sum + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  const area = Math.max(0, (stage.x1 - stage.x0) * (stage.y1 - stage.y0) - boardArea);
  const points: [number, number][] = [];
  if (area <= 1e-6) return { status: "no-margin-in-frame", area: 0, points };
  // Walk every visible CSS row. Sample the ends and middle of each outside
  // interval, including thin strips/corner wedges that a coarse grid misses.
  for (let y = Math.ceil(stage.y0 - 0.5) + 0.5; y < stage.y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    if (xs.length % 2) throw new Error("projected board outline has unmatched crossings");
    const sample = (left: number, right: number) => {
      const first = Math.ceil(left - 0.5) + 0.5, last = Math.ceil(right - 0.5) - 0.5;
      if (last < first) return;
      for (const x of new Set([first, Math.floor((first + last) / 2) + 0.5, last])) if (x >= left && x < right) points.push([x, y]);
    };
    let cursor = stage.x0;
    for (let i = 0; i < xs.length; i += 2) {
      const left = Math.max(stage.x0, xs[i]!), right = Math.min(stage.x1, xs[i + 1]!);
      if (right <= stage.x0 || left >= stage.x1) continue;
      if (left > cursor) sample(cursor, left);
      cursor = Math.max(cursor, right);
    }
    if (cursor < stage.x1) sample(cursor, stage.x1);
  }
  return { status: points.length ? "margin-present" : "margin-present-not-sampled", area, points };
}

/** Keep qualification separate from sampling and pixel success: missing evidence
 * cannot silently turn into a board-filled frame or a per-map coverage pass.
 */
export function defaultMarginCoverage(map: string, qualifyingDefaultPairs: number): string[] {
  return qualifyingDefaultPairs > 0 ? [] : [`${map}: no verified default 3D margin frame`];
}

export function terrainCaptureKey(scenario: "ordinary" | "spread-queens", board: "3d" | "2d", width: number, height: number, view: string): string {
  return `${scenario}-${board}-${width}x${height}-${view}`;
}

interface ResourceResponse { method: string; path: string; status: number; url: string }
interface CaptureError { kind: "console" | "page"; message: string; url: string; line?: number; column?: number }

/** The replay-404 exception is a recorded HTTP fact, never a substring in an error message.
 * Ambiguous same-URL responses fail closed; each excluded console occurrence consumes one 404.
 * Page errors are never excluded, even if they mention the replay endpoint.
 */
export function auditCaptureErrors(errors: readonly CaptureError[], responses: readonly ResourceResponse[]) {
  const used = new Set<ResourceResponse>();
  const excluded: { error: CaptureError; response: ResourceResponse }[] = [];
  const fatal: CaptureError[] = [];
  for (const error of errors) {
    const candidates = responses.filter((response) => response.url === error.url);
    const exact = (response: ResourceResponse) => response.method === "GET" && response.path === "/live/replays" && response.status === 404;
    const response = error.kind === "console" && candidates.length > 0 && candidates.every(exact)
      ? candidates.find((candidate) => !used.has(candidate)) : undefined;
    if (response) { used.add(response); excluded.push({ error, response }); }
    else fatal.push(error);
  }
  return { fatal, excluded };
}

/** Attach HTTP/error evidence BEFORE navigation: openClient's string-only errors cannot
 * distinguish this one allowed 404 from another resource, status, method or page exception.
 * Reuse the capture server, clock and renderer guards without changing or stubbing any route.
 */
async function openTerrainClient(browser: Browser, options: OpenOptions, record: (audit: ReturnType<typeof auditCaptureErrors>) => void): Promise<ClientPage> {
  const { page, url } = await servePage(browser, options);
  const errors: CaptureError[] = [], responses: ResourceResponse[] = [];
  page.on("response", (response) => {
    const address = new URL(response.url());
    responses.push({ method: response.request().method(), path: address.pathname + address.search, status: response.status(), url: response.url() });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    errors.push({ kind: "console", message: message.text(), url: location.url, line: location.lineNumber, column: location.columnNumber });
  });
  page.on("pageerror", (error) => errors.push({ kind: "page", message: error.message, url: "" }));
  const close = async () => {
    await page.context().close();
    const audit = auditCaptureErrors(errors, responses);
    record(audit);
    if (audit.fatal.length) throw new Error(audit.fatal.map((error) => `${error.kind} error: ${error.message}`).join("\n"));
  };
  try {
    // Same snapshot-loading route as board-parity/openClient; ?recording keeps the live layout.
    await page.goto(url);
    const info = await boundedReady(page.evaluate(() => window.__antwar.ready), "terrain client");
    const mismatch = checkRenderer(info.rendererString, options.requireRenderer);
    if (mismatch) throw mismatch;
    if (!info.webgl2) throw new Error(`client is not on WebGL2 (renderer ${info.rendererName})`);
    await page.evaluate((tilt) => window.__antwar.setOptions({ tilt }), options.tilt);
    return {
      page, info,
      get errors() { return auditCaptureErrors(errors, responses).fatal.map((error) => `${error.kind} error: ${error.message}`); },
      frame: (render) => page.evaluate((value) => window.__antwar.frame(value), render),
      advance: (ms) => page.clock.runFor(ms),
      setOptions: (value) => page.evaluate((settings) => window.__antwar.setOptions(settings), value),
      close,
    };
  } catch (error) { await close(); throw error; }
}

type Pixel = [number, number, number, number];
export const CAPTURE_ATTEMPTS = 3;
export type CaptureResult<T> =
  | { name: string; status: "rendered"; attempts: number; value: T }
  | { name: string; status: "unrendered"; attempts: number };

/** Only a blank draw returns null. Errors (including audits) are never retried or hidden. */
export async function retryBlankCapture<T>(name: string, capture: (attempt: number) => Promise<T | null>): Promise<CaptureResult<T>> {
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    const value = await capture(attempt);
    if (value !== null) return { name, status: "rendered", attempts: attempt, value };
  }
  return { name, status: "unrendered", attempts: CAPTURE_ATTEMPTS };
}

/** Prefer an earlier, known-reachable snapshot; only tick zero needs a later one. */
export function alternateTerrainTick(tick: number, lastTick: number): number | null {
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(lastTick) || tick < 0 || lastTick < tick) throw new Error("invalid fallback tick range");
  if (lastTick === 0) return null;
  return tick >= 100 ? tick - 100 : tick > 0 ? 0 : Math.min(100, lastTick);
}

/** Replace BOTH sides or neither. A rendered alternative before must never be
 * compared with the original after at a different simulation tick.
 */
export function selectRenderedPair<T>(before: CaptureResult<T> | undefined, after: CaptureResult<T> | undefined, alternativeBefore: CaptureResult<T> | undefined, alternativeAfter: CaptureResult<T> | undefined) {
  if (before?.status === "rendered" && after?.status === "rendered") return { before, after, usedAlternative: false };
  if (alternativeBefore?.status === "rendered" && alternativeAfter?.status === "rendered") return { before: alternativeBefore, after: alternativeAfter, usedAlternative: true };
  return { before, after, usedAlternative: false };
}

export interface PairReport {
  name: string;
  status: "passed" | "failed" | "unrendered";
  missing: ("before" | "after")[];
  problems: string[];
}
/** A missing side is incomplete evidence, not a failed comparison and never a pass. */
export function judgeRenderedPair<T>(name: string, before: CaptureResult<T> | undefined, after: CaptureResult<T> | undefined, check: (before: T, after: T) => string[]): PairReport {
  if (before?.status !== "rendered" || after?.status !== "rendered") {
    const missing: PairReport["missing"] = [];
    if (before?.status !== "rendered") missing.push("before");
    if (after?.status !== "rendered") missing.push("after");
    return { name, status: "unrendered", missing, problems: [] };
  }
  const problems = check(before.value, after.value);
  return { name, status: problems.length ? "failed" : "passed", missing: [], problems };
}

export function terrainEvidenceStatus(pairs: readonly PairReport[], executionError: string | null = null): "failed" | "incomplete" | "passed" {
  if (executionError !== null || pairs.some((pair) => pair.status === "failed")) return "failed";
  return pairs.length > 0 && pairs.every((pair) => pair.status === "passed") ? "passed" : "incomplete";
}

/** Mirrored positions one tile either side of the edge: enough opaque controls,
 * with a >=10% mean luminance step and at least 3/4 individually darker outside.
 * The screenshots remain the visual evidence; a flat/empty/sparse boundary cannot pass this control.
 */
export function edgeStepCheck(pairs: readonly { inside: Pixel; outside: Pixel }[]) {
  const luma = ([r, g, b]: Pixel) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const usable = pairs.filter(({ inside, outside }) => inside[3] >= 250 && outside[3] >= 250 && luma(inside) >= 12);
  const inside = usable.reduce((sum, pair) => sum + luma(pair.inside), 0);
  const outside = usable.reduce((sum, pair) => sum + luma(pair.outside), 0);
  const ratio = inside > 0 ? outside / inside : null;
  const darkerFraction = usable.length ? usable.filter((pair) => luma(pair.outside) < luma(pair.inside)).length / usable.length : 0;
  return { clear: usable.length >= 8 && ratio !== null && ratio <= 0.9 && darkerFraction >= 0.75, comparisons: usable.length, luminanceRatio: ratio, darkerFraction };
}

/** One draw and one GPU readback, not a new render for every samplePixel call.
 * Use actual canvas scaling, including quality tiers. draw=false inspects the SAME
 * preserved frame that passed the paint check and is saved to the screenshot.
 */
async function samplePixels(client: ClientPage, points: [number, number][], space: "tile" | "screen" = "tile", draw = true) {
  return client.page.evaluate(({ points, space, draw }) => {
    const api = window.__antwar;
    const frame = draw ? api.frame() : null;
    const canvas = document.querySelector("canvas")!;
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("primary canvas has no WebGL2 context");
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, box = canvas.getBoundingClientRect();
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const pixels = points.map(([x, y]): [number, number, number, number] | null => {
      const [sx, sy] = space === "tile" ? api.tileToScreen(x, y) : [x, y];
      if (sx < box.left || sy < box.top || sx >= box.right || sy >= box.bottom) return null;
      const px = Math.floor((sx - box.left) * width / box.width);
      const py = height - 1 - Math.floor((sy - box.top) * height / box.height);
      const offset = (py * width + px) * 4;
      return [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!];
    });
    return { frame, pixels };
  }, { points, space, draw });
}

async function ringProbe(client: ClientPage) {
  return client.page.evaluate((mapWidth) => {
    const api = window.__antwar as Antwar3dApi;
    const [x, y] = api.tileToScreen(mapWidth / 2, -2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error("ring probe is off-screen, not valid selection evidence");
    return { point: [x, y], ant: api.antAt(x, y), click: api.clickAt(x, y), marks: api.markers().length, labels: api.markLabels().length };
  }, client.info.mapW);
}

async function boundaryPixels(client: ClientPage, stage: Area) {
  const tiles: [number, number][] = [];
  for (let i = 0; i < 12; i++) {
    const x = 2 + (i + 0.5) * (client.info.mapW - 4) / 12;
    const y = 2 + (i + 0.5) * (client.info.mapH - 4) / 12;
    tiles.push([x, 1], [x, -1], [x, client.info.mapH - 1], [x, client.info.mapH + 1], [1, y], [-1, y], [client.info.mapW - 1, y], [client.info.mapW + 1, y]);
  }
  const screen = await client.page.evaluate((tiles) => tiles.map(([x, y]) => window.__antwar.tileToScreen(x, y)), tiles);
  const controls: [number, number][] = [];
  const visible = ([x, y]: [number, number]) => x >= stage.x0 && x < stage.x1 && y >= stage.y0 && y < stage.y1;
  for (let i = 0; i < screen.length; i += 2) {
    const inside = screen[i]!, outside = screen[i + 1]!;
    if (visible(inside) && visible(outside) && Math.hypot(inside[0] - outside[0], inside[1] - outside[1]) >= 2) controls.push(inside, outside);
  }
  const { pixels } = await samplePixels(client, controls, "screen", false);
  const pairs: { inside: Pixel; outside: Pixel }[] = [];
  for (let i = 0; i < pixels.length; i += 2) if (pixels[i] && pixels[i + 1]) pairs.push({ inside: pixels[i]!, outside: pixels[i + 1]! });
  return { ...edgeStepCheck(pairs), pairs, controls };
}

export function assertStableDryPixels(first: readonly (Pixel | null)[], second: readonly (Pixel | null)[]): void {
  if (!first.some((pixel) => pixel !== null && pixel[3] >= 250)) throw new Error("2D dry readback has no opaque visible controls");
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("2D dry readback is unstable within the same build at a frozen match tick; not product-comparison evidence");
}

export function marginPairProblems(before: Pick<CapturedView, "outside" | "boundary">, after: Pick<CapturedView, "outside" | "boundary">): string[] {
  const actual = after.outside, expected = before.outside, issues: string[] = [];
  if (actual.status === "no-margin-in-frame" && expected.status === "no-margin-in-frame") return issues;
  if (actual.status !== "margin-present" || expected.status !== "margin-present") return ["margin is present but not sampled in both builds"];
  if (JSON.stringify(actual.points) !== JSON.stringify(expected.points)) return ["before/after outside probes changed"];
  if (actual.pixels.length !== actual.points.length || expected.pixels.length !== expected.points.length || actual.pixels.some((p) => p === null) || expected.pixels.some((p) => p === null)) return ["off-board pixel readback is incomplete"];
  const painted = (p: Pixel | null) => p !== null && p[3] >= 250 && Math.abs(p[0] - 11) + Math.abs(p[1] - 8) + Math.abs(p[2] - 5) >= 12;
  if (!actual.pixels.some(painted)) issues.push("off-board ground has no visible painted pixels");
  const rows = new Map<number, { samples: number; painted: number }>();
  actual.points.forEach(([, y], i) => { const row = rows.get(y) ?? { samples: 0, painted: 0 }; row.samples++; if (painted(actual.pixels[i]!)) row.painted++; rows.set(y, row); });
  if ([...rows.values()].some((row) => row.samples >= 3 && row.painted === 0)) issues.push("margin scanlines show void rather than painted ground");
  if (!actual.pixels.some((p, i) => JSON.stringify(p) !== JSON.stringify(expected.pixels[i]))) issues.push("off-board pixels are unchanged; margin extension is not demonstrated");
  if (!before.boundary?.clear || !after.boundary?.clear) issues.push("playable edge step is not clear across the projected boundary");
  return issues;
}

interface CapturedView {
  file: string;
  scenario: "ordinary" | "spread-queens";
  fixtureQueens: readonly (readonly [number, number])[];
  scene: TerrainScene;
  projection: ReturnType<typeof window.__antwar.view>;
  dryRepeat: (Pixel | null)[] | null;
  fixtureTick: number;
  frame: FrameResult;
  paint: ReturnType<typeof boardPixelCheck> | null;
  camera: ReturnType<Antwar3dApi["camera"]> | null;
  layout: { stage: Area };
  outside: MarginReport & { outline: [number, number][]; pixels: (Pixel | null)[] };
  boundary: Awaited<ReturnType<typeof boundaryPixels>> | null;
  ring: Awaited<ReturnType<typeof ringProbe>> | null;
  dry: (Pixel | null)[] | null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, dist: { type: "string" }, "baseline-dist": { type: "string" }, "live-layout": { type: "boolean" }, tick: { type: "string" }, task: { type: "string" } } });
  if (!values.out) throw new Error("terrain capture needs --out; it never starts a match or builds implicitly");
  const out = resolve(values.out), webDir = resolve(values.dist ?? WEB_DIR);
  mkdirSync(out, { recursive: true }); mkdirSync(RECORDING_DIR, { recursive: true });
  const rules = withGridScale(rulesConfig("redesign"));
  if (!rules.terrain) throw new Error("public rules contain no terrain");
  const tick = Number(values.tick ?? (values["live-layout"] ? 3100 : 0));
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > rules.matchTicks) throw new Error("--tick must name a tick in the match");
  const browser = await launchBrowser();
  const shots: unknown[] = [], errorAudits: unknown[] = [], pairs: PairReport[] = [], fallbacks: unknown[] = [];
  const problems: string[] = [];
  let executionError: string | null = null;
  const builds = [
    ...(values["baseline-dist"] ? [{ phase: "before" as const, dist: resolve(values["baseline-dist"]) }] : []),
    { phase: "after" as const, dist: webDir },
  ];
  try {
    for (const map of rules.terrain.maps) {
      const config = { ...rules, terrain: { ...rules.terrain, mapId: map.id } };
      const captures = new Map<string, CaptureResult<CapturedView>>();
      // Desktop and portrait phone are required; retain the existing landscape control too.
      const sizes = [[1920, 1080], [390, 844], [844, 390]] as const;
      const views = ["default", "whole-board", "boundary"] as const;
      const scenarios = ["ordinary", "spread-queens"] as const;
      let qualifyingDefaultPairs = 0;
      const needsAlternative = new Set<string>();
      const captureBuilds = async (fixture: StreamMessage, sourceStage: "initial" | "alternate-tick", target: Map<string, CaptureResult<CapturedView>>, scenario: typeof scenarios[number] = "ordinary") => {
        const sceneStem = `${map.id}-${fixture.tick}-${sourceStage}-${scenario}`;
        for (const { phase, dist } of builds) for (const [width, height] of sizes) for (const board of ["3d", "2d"] as const) {
          if (scenario === "spread-queens" && board === "2d") continue;
          if (sourceStage === "alternate-tick" && (board !== "3d" || !["default", "whole-board"].some((view) => needsAlternative.has(`${scenario}-${board}-${width}x${height}-${view}`)))) continue;
          const name = terrainRecordingName(map.id, fixture.tick, scenario, phase);
          const phaseFixture = terrainPhaseFixture(fixture, phase), encoded = encodeMessage(phaseFixture);
          const streamVersion = encoded[2]!;
          if (phase === "before" && streamVersion > TERRITORY_WIN_STREAM_VERSION) throw new Error(`baseline cannot read stream version ${streamVersion}`);
          // Separate files prevent the candidate's rock format reaching the old baseline.
          writeFileSync(join(RECORDING_DIR, `${name}.bin`), phase === "after" ? packMessages([encodeMessage(fixture)]) : packMessages([encoded]));
          const client = await openTerrainClient(browser, { recording: name, width, height, phone: width !== 1920, tilt: false, board, webDir: dist, rules: config },
            (audit) => errorAudits.push({ map: map.id, fixtureTick: fixture.tick, sourceStage, phase, dist, board, viewport: [width, height], ...audit }));
          try {
            if (board === "3d" && !client.info.rendererName.includes("babylon")) throw new Error("3D capture fell back to 2D");
            await client.advance(2000);
            await client.frame(); await client.frame();
            const save = async (view: typeof views[number], shotStage = "first") => {
              const key = terrainCaptureKey(scenario, board, width, height, view);
              const captureName = `${map.id} ${key} ${phase} tick-${fixture.tick} ${sourceStage} ${shotStage}`;
              const result = await retryBlankCapture<CapturedView>(captureName, async (attempt) => {
                const scene = await terrainScene(client, fixture.tick);
                let paint: ReturnType<typeof boardPixelCheck> | null = null;
                let frame: FrameResult;
                if (board === "3d") {
                  try {
                    // Reuse colony-scale's real draws and event-loop turns unchanged.
                    // Only exhausted blank paint is retryable; execution errors stay fatal.
                    const settled = await settle3DBoard(client, fixture.tick, captureName);
                    paint = settled.last;
                    frame = await client.frame(false);
                  } catch (error) {
                    if (!(error instanceof BlankPrimaryBoardError)) throw error;
                    const file = `${sceneStem}-${shotStage}-${board}-${width}-${view}-${phase}-blank-${attempt}.png`;
                    writeFileSync(join(out, file), await client.page.screenshot());
                    const geometry = await client.page.evaluate(() => {
                      const rect = (element: Element | null) => element ? { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } : null;
                      const canvas = document.querySelector("canvas");
                      const a = window.__antwarCapture.boardArea();
                      return { stage: { x: a.x0, y: a.y0, width: a.x1 - a.x0, height: a.y1 - a.y0 }, canvas: rect(canvas), projection: window.__antwar.view(), camera: (window.__antwar as Antwar3dApi).camera() };
                    });
                    shots.push({ name: captureName, status: "blank-attempt", attempt, file, scene, geometry, paint: error.last, draws: error.attempts, renderer: client.info.rendererString });
                    return null;
                  }
                } else frame = await client.frame();
                // Do not redraw between the successful paint check, measurements and image.
                const camera = board === "3d" ? await client.page.evaluate(() => (window.__antwar as Antwar3dApi).camera()) : null;
                const layout = await client.page.evaluate(() => {
                  const a = window.__antwarCapture.boardArea();
                  return { stage: { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 } };
                });
                const outline = board === "3d" ? await client.page.evaluate((tiles) => tiles.map(([x, y]) => window.__antwar.tileToScreen(x, y)), boardEdgeTiles(client.info.mapW, client.info.mapH)) : [];
                const visibleStage = { x0: Math.max(0, layout.stage.x0), y0: Math.max(0, layout.stage.y0), x1: Math.min(width, layout.stage.x1), y1: Math.min(height, layout.stage.y1) };
                const margin: MarginReport = board === "3d" ? offboardScreenProbes(outline, visibleStage) : { status: "no-margin-in-frame", area: 0, points: [] };
                const outside = { ...margin, outline, pixels: board === "3d" ? (await samplePixels(client, margin.points, "screen", false)).pixels : [] };
                const boundary = board === "3d" && (view === "boundary" || margin.status !== "no-margin-in-frame") ? await boundaryPixels(client, visibleStage) : null;
                const ring = board === "3d" && view === "boundary" ? await ringProbe(client) : null;
                const dry = board === "2d" && view === "boundary" ? (await samplePixels(client, dryControls(fixture), "tile", true)).pixels : null;
                const dryRepeat = dry ? (await samplePixels(client, dryControls(fixture), "tile", true)).pixels : null;
                const projection = await client.page.evaluate(() => window.__antwar.view());
                if (dry && dryRepeat) {
                  shots.push({ name: captureName, status: "2d-readback-control", phase, scene, projection, layout, dry, dryRepeat });
                  assertStableDryPixels(dry, dryRepeat);
                }
                const rockCentres = (fixture.full!.setup.terrain?.rocks ?? []).map(([x, y, w, h]): [number, number] => [x + w / 2, y + h / 2]);
                const rocks = phase === "after" ? { centres: rockCentres, pixels: (await samplePixels(client, rockCentres, "tile", false)).pixels } : undefined;
                const file = `${sceneStem}-${shotStage}-${board}-${width}-${view}-${phase}.png`;
                writeFileSync(join(out, file), await client.page.screenshot());
                const value: CapturedView = { file, scenario, fixtureQueens: fixture.full!.setup.queens, scene, projection, dryRepeat, fixtureTick: fixture.tick, frame: frame!, paint, camera, layout, outside, boundary, ring, dry };
                shots.push({ name: captureName, status: "rendered", attempt, sourceStage, shotStage, phase, dist, recording: name, streamVersion,
                  fixtureProjection: phase === "before" ? "water-only baseline projection; all non-rock state retained" : "unchanged candidate snapshot",
                  map: phaseFixture.full!.setup.terrain, board, viewport: [width, height], view, ...value, renderer: client.info.rendererString, rocks });
                return value;
              });
              target.set(`${phase}-${key}`, result);
              if (result.status === "unrendered") shots.push(result);
            };
            await save("default");
            // A blank default never prevents trying the actual Whole board control and top boundary.
            await client.page.evaluate(() => {
              const whole = [...document.querySelectorAll("button")].find((button) => button.textContent === "Whole board");
              if (!whole) throw new Error("Whole board control is missing");
              whole.click();
            });
            await save("whole-board");
            // A separate diagnostic, not a replacement for either default framing. Keep enough
            // pixels per tile to read the edge step, with the outside ring in view on both sizes.
            await client.page.evaluate((mode) => {
              const api = window.__antwar;
              if (mode === "3d") (api as Antwar3dApi).setView("top");
              api.zoomAt(0.5, innerWidth / 2, innerHeight / 2);
            }, board);
            await save("boundary");
            // The first default-distance tilted draw can be blank under SwiftShader
            // while close/top views paint. Restore the shipped default, not a close-up,
            // and re-shoot only unrendered views after those other draws have warmed it.
            if (board === "3d") for (const view of ["default", "whole-board"] as const) {
              if (target.get(`${phase}-${scenario}-${board}-${width}x${height}-${view}`)?.status !== "unrendered") continue;
              await client.page.evaluate((view) => {
                (window.__antwar as Antwar3dApi).setView("tilted");
                window.__antwar.frame();
                if (view === "whole-board") {
                  const whole = [...document.querySelectorAll("button")].find((button) => button.textContent === "Whole board");
                  if (!whole) throw new Error("Whole board control is missing");
                  whole.click();
                }
              }, view);
              await save(view, "after-other-views");
            }
            if (client.errors.length) throw new Error(client.errors.join("\n"));
          } finally { await client.close(); }
        }
      };
      const ordinary = terrainFixture(config, tick);
      await captureBuilds(ordinary, "initial", captures);
      await captureBuilds(spreadQueenFixture(ordinary), "initial", captures, "spread-queens");
      if (map.id === "open-field") {
        for (const [width, height] of sizes) for (const view of ["default", "whole-board"]) {
          const key = `ordinary-3d-${width}x${height}-${view}`;
          if (captures.get(`before-${key}`)?.status === "unrendered" || captures.get(`after-${key}`)?.status === "unrendered") needsAlternative.add(key);
        }
        const alternativeTick = alternateTerrainTick(tick, config.matchTicks);
        if (needsAlternative.size && alternativeTick !== null) {
          const alternative = new Map<string, CaptureResult<CapturedView>>();
          await captureBuilds(terrainFixture(config, alternativeTick), "alternate-tick", alternative);
          for (const key of needsAlternative) {
            const selected = selectRenderedPair(captures.get(`before-${key}`), captures.get(`after-${key}`), alternative.get(`before-${key}`), alternative.get(`after-${key}`));
            // Fresh acceptance is only at the requested tick. A different tick can
            // diagnose blank paint, never replace missing tick-3100 match evidence.
            fallbacks.push({ name: `${map.id} ${key}`, originalTick: tick, alternativeTick, diagnosticOnly: true, renderedAlternativePair: selected.usedAlternative, usedForAcceptance: false, before: alternative.get(`before-${key}`), after: alternative.get(`after-${key}`) });
          }
        }
      }
      // Judge only matching rendered pairs. A blank BEFORE cannot fail the run or
      // suppress the other build, maps, sizes or views; it remains named and incomplete.
      for (const scenario of scenarios) for (const [width, height] of sizes) for (const board of ["3d", "2d"] as const) for (const view of views) {
        if (scenario === "spread-queens" && board === "2d") continue;
        const key = terrainCaptureKey(scenario, board, width, height, view);
        const pair = judgeRenderedPair(`${map.id} ${key}`, captures.get(`before-${key}`), captures.get(`after-${key}`), (before, after) => {
          const issues: string[] = [];
          if (JSON.stringify(before.camera) !== JSON.stringify(after.camera) || JSON.stringify(before.projection) !== JSON.stringify(after.projection) || JSON.stringify(before.layout) !== JSON.stringify(after.layout)) issues.push("before/after camera, projection or layout changed");
          if (before.fixtureTick !== after.fixtureTick || before.frame.playbackTick !== after.frame.playbackTick) issues.push("before/after fixture or playback tick changed");
          if (board === "3d" && view !== "boundary") issues.push(...marginPairProblems(before, after));
          if (board === "3d" && view === "boundary") {
            for (const [phase, capture] of [["before", before], ["after", after]] as const) {
              if (!capture.boundary?.clear) issues.push(`${phase}: playable edge step is not clear in rendered boundary controls`);
              const ring = capture.ring;
              if (!ring || ring.ant !== null || ring.click !== null || ring.marks !== 0 || ring.labels !== 0) issues.push(`${phase}: terrain ring gained an ant, mark, label or selection`);
            }
          }
          if (board === "2d" && view === "boundary") {
            if (!before.dry || !after.dry || after.dry.filter((p) => p !== null).length === 0) issues.push("no visible dry interior comparison controls");
            else if (JSON.stringify(before.dry) !== JSON.stringify(after.dry)) issues.push("dry interior differs from the baseline");
          }
          return issues;
        });
        pairs.push(pair);
        problems.push(...pair.problems.map((problem) => `${pair.name}: ${problem}`));
        const after = captures.get(`after-${key}`);
        if (board === "3d" && view === "default" && pair.status === "passed" && after?.status === "rendered" && after.value.outside.status === "margin-present") qualifyingDefaultPairs++;
      }
      const coverage = defaultMarginCoverage(map.id, qualifyingDefaultPairs);
      if (coverage.length) { pairs.push({ name: `${map.id} default margin coverage`, status: "failed", missing: [], problems: coverage }); problems.push(...coverage); }
    }
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try { await browser.close(); }
    finally {
      const status = terrainEvidenceStatus(pairs, executionError);
      const unrendered = pairs.filter((pair) => pair.status === "unrendered");
      const realGpuLookRequired = unrendered.filter((pair) => pair.name.startsWith("open-field ") && pair.name.includes("3d-") && !pair.name.endsWith("-boundary")).map(({ name }) => name);
      // Exit zero for an exhausted blank BEFORE is not a coverage pass. Consumers must
      // read status and every named missing view; other real failures still exit nonzero.
      writeFileSync(join(out, "terrain.json"), JSON.stringify({ task: values.task ?? "terrain", status
, complete: status === "passed", retry: { attemptsPerStage: CAPTURE_ATTEMPTS, paintBudgetMsPerAttempt: 20_000, stages: ["first", "after-other-views"], openFieldAlternateTicks: 1 }, builds, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "", fixture: { tick, transport: "existing snapshot recording path", layout: "shipped live page (not replay)", agents: 0, simulation: "ordinary: actual no-input simulation; spread-queens: labelled static queen-placement control, not simulated history", scenarios: ["ordinary", "spread-queens"] }, shots, pairs, unrendered, fallbacks, realGpuLookRequired, errorAudits, executionError, problems }, null, 2));
      console.log(JSON.stringify({ status, unrendered: unrendered.map(({ name, missing }) => ({ name, missing })), realGpuLookRequired, problems }));
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

if (import.meta.main) main().catch((error) => { console.error(error); process.exitCode = 1; });
