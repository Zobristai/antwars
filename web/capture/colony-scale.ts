/// <reference types="node" />
/** Render the measured private match's real start and peak.
 * node --import ./src/ts-resolve.mjs web/capture/colony-scale.ts --head <commit>
 * Run test/tools/colonyScale.ts first in the same checkout. No public URL.
 * Phone numbers describe a 390x844 touch/mobile SwiftShader emulation, not a device.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { timing } from "../../test/tools/colonyScale.ts";
import { prepare } from "./capture.ts";
import { launchBrowser, openClient, type ClientPage } from "./browser.ts";

const reportSchema = z.object({
  exitCode: z.number(),
  declaredHead: z.string(),
  seed: z.number(),
  sources: z.record(z.string(), z.string()),
  recordings: z.record(z.string(), z.string()),
  candidate: z.object({ totalPeak: z.object({ tick: z.number(), counts: z.array(z.number()) }) }),
});

type Pixel = readonly [number, number, number, number];

/** Broad, opaque, textured ground is evidence; clear canvases and sparse markers are not.
 * Samples are taken only from the primary WebGL canvas, never the DOM/Pixi overlay.
 */
export function boardPixelCheck(samples: readonly Pixel[], background: Pixel) {
  if (!samples.length) return { nonblank: false, samples: 0, opaqueFraction: 0, groundFraction: 0, rgbDeviation: 0 };
  const opaque = samples.filter((p) => p[3] >= 250);
  const ground = opaque.filter((p) => Math.abs(p[0] - background[0]) + Math.abs(p[1] - background[1]) + Math.abs(p[2] - background[2]) >= 12);
  const means = [0, 1, 2].map((c) => samples.reduce((n, p) => n + p[c]!, 0) / samples.length);
  const variance = samples.reduce((n, p) => n + means.reduce((sum, mean, c) => sum + (p[c]! - mean) ** 2, 0), 0) / samples.length;
  const opaqueFraction = opaque.length / samples.length;
  const groundFraction = ground.length / samples.length;
  const rgbDeviation = Math.sqrt(variance);
  return { nonblank: samples.length >= 32 && opaqueFraction >= 0.95 && groundFraction >= 0.4 && rgbDeviation >= 4,
    samples: samples.length, opaqueFraction, groundFraction, rgbDeviation };
}

/** Node timers stay real even while the page's simulation clock is paused. */
export async function boundedCapture<T>(work: Promise<T>, scene: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${scene}: primary-board capture timed out after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Draw and read the primary canvas in one browser operation, not a screenshot of overlay badges. */
async function primaryBoardPixels(client: ClientPage, expectedTick: number) {
  const pixels = await client.page.evaluate(({ mapW, mapH, expectedTick }) => {
    const frame = window.__antwar.frame();
    if (frame.playbackTick !== expectedTick) throw new Error(`3D draw moved playback to ${frame.playbackTick}, expected ${expectedTick}`);
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("3D primary canvas is missing");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("3D primary canvas has no WebGL2 context");
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height) throw new Error("3D primary canvas has no drawable pixels");
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const at = (x: number, y: number): [number, number, number, number] => {
      const offset = (y * width + x) * 4;
      return [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!];
    };
    const a = window.__antwarCapture.boardArea();
    const area = { left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 };
    const box = canvas.getBoundingClientRect();
    const samples: [number, number, number, number][] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
      const [sx, sy] = window.__antwar.tileToScreen(mapW * (0.08 + 0.84 * (x + 0.5) / 16), mapH * (0.08 + 0.84 * (y + 0.5) / 12));
      if (sx < Math.max(area.left, box.left) || sx >= Math.min(area.right, box.right) || sy < Math.max(area.top, box.top) || sy >= Math.min(area.bottom, box.bottom)) continue;
      samples.push(at(Math.floor((sx - box.left) * width / box.width), height - 1 - Math.floor((sy - box.top) * height / box.height)));
    }
    return { samples, background: at(0, height - 1) };
  }, { mapW: client.info.mapW, mapH: client.info.mapH, expectedTick });
  return boardPixelCheck(pixels.samples, pixels.background);
}

/** Only exhausted blank draws are retryable; renderer, tick and readback errors are not. */
export class BlankPrimaryBoardError extends Error {
  readonly attempts: number;
  readonly first: ReturnType<typeof boardPixelCheck>;
  readonly last: ReturnType<typeof boardPixelCheck>;
  constructor(scene: string, attempts: number, first: ReturnType<typeof boardPixelCheck>, last: ReturnType<typeof boardPixelCheck>) {
    super(`${scene}: blank primary 3D board after ${attempts} draws; ${JSON.stringify({ first, last })}`);
    this.name = "BlankPrimaryBoardError";
    this.attempts = attempts;
    this.first = first;
    this.last = last;
  }
}

/** The first capture draw starts async shader compilation. Finish it with more real
 * draws and event-loop turns, without advancing the simulation/playback clock.
 */
export async function settle3DBoard(client: ClientPage, expectedTick: number, scene: string) {
  if (!/babylon/i.test(client.info.rendererName)) throw new Error(`${scene}: requested 3D, got ${client.info.rendererName}`);
  const started = performance.now();
  const deadline = started + 20_000;
  const read = () => boundedCapture(primaryBoardPixels(client, expectedTick), scene, Math.max(1, deadline - performance.now()));
  const first = await read();
  let last = first;
  let attempts = 1;
  while (!last.nonblank && performance.now() < deadline) {
    await pause(Math.min(100, Math.max(0, deadline - performance.now())));
    if (performance.now() >= deadline) break;
    last = await read();
    attempts++;
  }
  if (!last.nonblank) throw new BlankPrimaryBoardError(scene, attempts, first, last);
  return { first, last, attempts, elapsedMs: performance.now() - started, manualClockAdvanceMs: 0, playbackTick: expectedTick };
}

async function main() {
  const { values } = parseArgs({ options: { head: { type: "string" } } });
  if (!values.head || !/^[a-f0-9]{40}$/.test(values.head)) throw new Error("--head requires the full committed SHA");
  const dir = "out/colony-scale";
  const report = reportSchema.parse(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")));
  if (report.declaredHead !== values.head) throw new Error("measurement and capture head pins differ");
  for (const [path, digest] of Object.entries(report.sources)) {
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== digest) throw new Error(`source changed since measurement: ${path}`);
  }
  for (const [name, digest] of Object.entries(report.recordings)) {
    if (createHash("sha256").update(readFileSync(`out/recordings/${name}.bin`)).digest("hex") !== digest) throw new Error(`recording changed since measurement: ${name}`);
  }
  await prepare();
  mkdirSync(dir, { recursive: true });
  const browser = await launchBrowser();
  const stills: { board: string; scene: string; tick: number; clock: string; path: string; renderer: string; primaryBoard: Awaited<ReturnType<typeof settle3DBoard>> | null }[] = [];
  try {
    for (const board of ["2d", "3d"] as const) {
      for (const scene of ["start", "peak"] as const) {
        const c = await openClient(browser, { recording: `colony-${scene}`, board, width: 1920, height: 1080, tilt: false });
        try {
          await c.advance(250);
          const expected = scene === "start" ? 0 : report.candidate.totalPeak.tick;
          const primaryBoard = board === "3d" ? await settle3DBoard(c, expected, `${scene}-3d`) : null;
          const frame = await c.frame();
          if (frame.playbackTick !== expected) throw new Error(`${scene} rendered tick ${frame.playbackTick}, expected ${expected}`);
          // The HUD's clock: the 2D board's, or the deck's ("0:00 · 30:00 left").
          const clock = await c.page.locator(".d2-clock, .d1-clock").innerText();
          if (scene === "start" && !clock.endsWith("30:00 left")) throw new Error(`start clock is ${JSON.stringify(clock)}, not 30:00 left`);
          if (c.errors.length) throw new Error(c.errors.join("\n"));
          const path = join(dir, `${scene}-${board}.png`);
          await c.page.screenshot({ path });
          stills.push({ board, scene, tick: frame.playbackTick, clock, path, renderer: c.info.rendererString, primaryBoard });
        } finally { await c.close(); }
      }
    }
    const phone = await openClient(browser, { recording: "colony-peak", board: "3d", width: 390, height: 844, phone: true, tilt: false });
    try {
      await phone.advance(250);
      const primaryBoard = await settle3DBoard(phone, report.candidate.totalPeak.tick, "peak-phone-3d");
      const first = await phone.frame();
      if (first.playbackTick !== report.candidate.totalPeak.tick) throw new Error("phone did not reach measured peak");
      // Freeze at the exact measured peak, so all timed frames retain that population.
      for (let i = 0; i < 20; i++) await phone.frame();
      const rawMs: number[] = [];
      const rawRenderMs: number[] = [];
      const rawUpdateMs: number[] = [];
      for (let i = 0; i < 300; i++) {
        const frame = await phone.frame();
        if (frame.playbackTick !== report.candidate.totalPeak.tick) throw new Error("phone timing advanced the measured peak");
        if (frame.renderMs === undefined || frame.updateMs === undefined || frame.ingestMs === undefined) throw new Error("frame timing source unavailable");
        rawMs.push(frame.ingestMs + frame.updateMs + frame.renderMs);
        rawRenderMs.push(frame.renderMs);
        rawUpdateMs.push(frame.updateMs);
      }
      if (phone.errors.length) throw new Error(phone.errors.join("\n"));
      const finalBoard = await boundedCapture(primaryBoardPixels(phone, report.candidate.totalPeak.tick), "peak-phone-3d final", 20_000);
      if (!finalBoard.nonblank) throw new Error(`phone primary board became blank; discarding frame timings: ${JSON.stringify(finalBoard)}`);
      await phone.page.screenshot({ path: join(dir, "peak-phone-3d.png") });
      const frameTime = timing(rawMs);
      const fallback2d = frameTime.medianMs > 1000 / 30;
      const phoneReport = {
        viewport: { width: 390, height: 844, mobile: true, touch: true, deviceScaleFactor: 1 },
        renderer: phone.info.rendererString,
        method: "300 real-time instrumented frames after primary-board paint validation and 20 warmups; clock frozen at actual match peak; ingest + update + readPixels-finished render; not a physical phone",
        primaryBoard, finalBoard,
        tick: first.playbackTick,
        counts: report.candidate.totalPeak.counts,
        frameTime, render: timing(rawRenderMs), update: timing(rawUpdateMs),
        rawMs, rawRenderMs, rawUpdateMs,
        fallback2dRecommended: fallback2d,
      };
      const result = { exitCode: report.exitCode, declaredHead: values.head, seed: report.seed, stills, phone: phoneReport };
      writeFileSync(join(dir, "render-report.json"), `${JSON.stringify(result, null, 2)}\n`);
      console.log(`Exit code ${result.exitCode}`);
      console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    } finally { await phone.close(); }
  } finally { await browser.close(); }
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error("Exit code 1");
  console.error(error);
  process.exitCode = 1;
});
