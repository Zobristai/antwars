/** Offline 3D founding checks. No match join or deployment.
 * HEADLESS_SHELL=/path/to/chrome node --import ./src/ts-resolve.mjs web/capture/queen-framing-3d.ts
 * Geometry-only by default; --render draws full frames and --webkit selects that engine.
 * Each missing engine/render mode stays a gap in the report, not a substituted pass.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Page } from "playwright-core";
import { launchBrowser, launchWebKit, servePage } from "./browser.ts";
import type { AntwarApi } from "../src/main.ts";
import { QUEEN_FRAME_TILES } from "../src/buffer.ts";

export const FRAMING_VIEWPORTS = [[1920, 1080], [1366, 768], [390, 844], [360, 780], [844, 390]] as const;
type Point = readonly [number, number];
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface QueenFrameMeasurement {
  tick: number | null;
  stage: Box;
  view: unknown;
  camera: unknown;
  corners: Point[];
  envelope?: Box;
  nests: ReturnType<AntwarApi["nests"]>;
}

/** Same shifted tick100/101 fixture as the pinned baseline; no baseline recapture. */
export function foundingRecording(): Uint8Array {
  // Keep the captured bytes, not a call to today's simulation: unrelated simulation
  // fixes must not quietly change the scene used for base-versus-change comparison.
  const shifted = readFileSync(new URL("./fixtures/queen-framing-3d.bin", import.meta.url));
  assert.equal(createHash("sha256").update(shifted).digest("hex"), "ef3dd104456106c2677c98fa8c26633a2e558cc3bdec9dfeb03e8126579ff753", "pinned founding fixture bytes changed");
  return shifted;
}

export function clipPolygon(points: readonly Point[], box: Box): Point[] {
  let polygon = [...points];
  for (const [axis, bound, lower] of [[0, box.x0, true], [0, box.x1, false], [1, box.y0, true], [1, box.y1, false]] as const) {
    const input = polygon; polygon = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i]!, q = input[(i + 1) % input.length]!;
      const inside = (v: Point) => lower ? v[axis] >= bound : v[axis] <= bound;
      if (inside(p)) polygon.push(p);
      if (inside(p) !== inside(q)) {
        const t = (bound - p[axis]) / (q[axis] - p[axis]);
        polygon.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return polygon;
}

export function projectedArea(points: readonly Point[]): { width: number; height: number; area: number } {
  if (!points.length) return { width: 0, height: 0, area: 0 };
  const width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
  const height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
  return { width, height, area: width * height };
}

export function foundingProblems(before: QueenFrameMeasurement, after: QueenFrameMeasurement): string[] {
  const problems: string[] = [];
  if (before.tick !== 100 || after.tick !== 101) problems.push("founding ticks were not 100 and 101");
  if (before.nests.length !== 8 || after.nests.length !== 9) problems.push("expected eight starting nests and one later-founded nest");
  if (!before.camera || !after.camera) problems.push("3D camera diagnostic missing");
  for (const key of ["stage", "view", "camera", "corners", "envelope"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) problems.push(`${key} moved on founding`);
  }
  for (const [label, measurement] of [["before", before], ["after", after]] as const) {
    for (const nest of measurement.nests) {
      const r = nest.rect, s = measurement.stage;
      const margin = Math.min(r.x0 - s.x0, r.y0 - s.y0, s.x1 - r.x1, s.y1 - r.y1);
      if (!Number.isFinite(margin) || margin < 0.5) problems.push(`${label}: colony ${nest.colony} nest ${nest.id} has only ${margin}px clearance`);
    }
  }
  return problems;
}

async function measure(page: Page, mapW: number, mapH: number): Promise<QueenFrameMeasurement> {
  return page.evaluate(({ mapW, mapH, radius }) => {
    const api = window.__antwar as AntwarApi & { camera?: () => unknown };
    const area = api.boardArea();
    const stage = { left: area.x0, top: area.y0, right: area.x1, bottom: area.y1 };
    const envelope = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    // Same public projection as nests(), for every possible integer nest corner.
    // This measures the stable edge allowance separately from the map footprint.
    for (let y = -radius; y <= mapH + radius; y++) for (let x = -radius; x <= mapW + radius; x++) {
      const p = api.tileToScreen(x, y);
      envelope.x0 = Math.min(envelope.x0, p[0]); envelope.x1 = Math.max(envelope.x1, p[0]);
      envelope.y0 = Math.min(envelope.y0, p[1]); envelope.y1 = Math.max(envelope.y1, p[1]);
    }
    return { tick: api.board()?.tick ?? null, stage: { x0: stage.left, y0: stage.top, x1: stage.right, y1: stage.bottom },
      view: api.view(), camera: api.camera?.() ?? null, envelope,
      corners: [[0, 0], [mapW, 0], [mapW, mapH], [0, mapH]].map(([x, y]) => api.tileToScreen(x!, y!)), nests: api.nests() };
  }, { mapW, mapH, radius: QUEEN_FRAME_TILES });
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: "out/queen-framing-3d" }, render: { type: "boolean", default: false }, webkit: { type: "boolean", default: false } } });
  const out = resolve(values.out); mkdirSync(out, { recursive: true }); mkdirSync("out/recordings", { recursive: true });
  writeFileSync("out/recordings/queen-framing-3d.bin", foundingRecording());
  const browser = await (values.webkit ? launchWebKit() : launchBrowser());
  const records: unknown[] = [];
  // Pinned baseline 8a1815b. Width*height of projected
  // bounds is not pixel segmentation or an unobscured raster-area measurement.
  const baseline = [[1604.800, 1201.031, 1548, 837], [1028.413, 770.102, 994, 505.75],
    [570.675, 427.492, 390, 318.0625], [509.524, 381.688, 360, 284.0625], [613.704, 459.017, 476, 338]];
  let failed = false;
  try {
    for (const [index, [width, height]] of FRAMING_VIEWPORTS.entries()) {
      const client = await servePage(browser, { recording: "queen-framing-3d", width, height, tilt: true, board: "3d", phone: width < 900 });
      const { page, errors } = client;
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === "http://localhost:4718" ? route.fallback() : route.abort());
        await page.goto(client.url);
        const info = await page.evaluate(() => window.__antwar.ready);
        assert.match(info.rendererName, /^babylon /, "3D recovery is not a 3D framing pass");
        await page.evaluate(() => document.fonts.ready);
        for (const ms of [1, 249]) {
          await page.clock.runFor(ms); await page.evaluate(render => window.__antwar.frame(render), values.render);
        }
        const before = await measure(page, info.mapW, info.mapH);
        await page.clock.runFor(100); await page.evaluate(render => window.__antwar.frame(render), values.render);
        const after = await measure(page, info.mapW, info.mapH);
        const problems = [...errors, ...foundingProblems(before, after)];
        const projection = projectedArea(after.corners);
        const viewport = { x0: 0, y0: 0, x1: width, y1: height };
        const onScreen = projectedArea(clipPolygon(after.corners, viewport));
        const footprint = projectedArea(clipPolygon(clipPolygon(after.corners, viewport), after.stage));
        const b = baseline[index]!;
        const loss = { projectedBoundsPercent: 100 * (1 - projection.area / (b[0]! * b[1]!)), stageFootprintPercent: 100 * (1 - footprint.area / (b[2]! * b[3]!)) };
        const envelope = after.envelope!, stage = after.stage;
        const unusedBeyondEnvelopePx = { left: envelope.x0 - stage.x0, top: envelope.y0 - stage.y0,
          right: stage.x1 - envelope.x1, bottom: stage.y1 - envelope.y1 };
        if (Object.values(unusedBeyondEnvelopePx).some(n => !Number.isFinite(n) || n < 0.5)) problems.push("stable future-nest envelope lacks margin");
        records.push({ viewport: [width, height], renderer: info, rendered: values.render, before, after, projection, onScreen, footprint, loss,
          unusedBeyondEnvelopePx, disclosureRequired: Object.values(loss).some(percent => percent > 10), problems });
        failed ||= problems.length > 0;
        console.log(JSON.stringify({ viewport: [width, height], rendered: values.render, loss, problems }));
      } finally { await page.context().close(); }
    }
  } finally {
    await browser.close();
    writeFileSync(`${out}/measurements.json`, JSON.stringify({ engine: values.webkit ? "webkit" : "chromium", rendered: values.render,
      baseline: { commit: "8a1815bec17decf53d5c161e437bf1d85879d6f0" },
      otherEngine: "not run", records }, null, 2));
  }
  if (failed) process.exitCode = 1;
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
