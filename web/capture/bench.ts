/**
 * Frame-time bench, on a recorded
 * 2,000-ant match stream carrying the per-match cap of 50 agents with their
 * squads, marks laid at the rules' rate and intent lines, with time stepped
 * through Playwright's clock:
 *  - client update (interpolation, positions and words, no drawing) and render
 *    (finished by a 1-pixel readPixels) are timed separately inside the page,
 *    from the real-time source saved before the clock was installed;
 *  - a capture frame is timed from Node around advance + frame + JPEG screenshot;
 *  - p50 and p95 over 300 frames; budgets apply to p50;
 *  - the 300 measured frames sit on the frame where the scene shows the most
 *    live labels the client will draw, found first by playing the whole match
 *    frame by frame at 30 fps (jumping straight to an instant lays labels out
 *    differently from playing up to it, so the scan plays as the runs do); the
 *    report gives the agent, mark, live-label and intent-line counts beside the
 *    timings;
 *  - every timed run plays the match frame by frame from its start up to the
 *    measured window too, so it reaches the scan's peak;
 *  - the marker check (marks are markers, their words in the
 *    chat and on hover or tap): the scan fails unless every live mark is drawn
 *    as a marker on every frame;
 *  - a 1080p frame of that crowded scene, played up to the scan's peak, and the
 *    same frame scaled down to 640 px wide, are kept with the marker counts.
 *
 * Usage: node web/capture/bench.ts   (exit code 1 if a budget is missed or the marker check fails)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { prepare, provenance, scriptedRecording } from "./capture.ts";
import { OUT_DIR, frameClockMs, launchBrowser, openClient, scalePng } from "./browser.ts";
import type { FrameResult } from "../src/main.ts";

const FRAMES = 300;
const WARMUP = 10;
const FPS = 30;

interface Series {
  p50: number;
  p95: number;
  raw: number[];
}

function series(xs: number[]): Series {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), raw: xs.map((x) => +x.toFixed(2)) };
}

interface Load {
  agents: number;
  marks: number;
  liveLabels: number;
  markers: number;
  squadTags: number;
  intentLines: number;
  chatLines: number;
}

function loadOf(r: FrameResult): Load {
  return { agents: r.agents, marks: r.marks.marks, liveLabels: r.labels, markers: r.marks.markers, squadTags: r.squadTags.full, intentLines: r.intentLines, chatLines: r.chat };
}

interface Scan {
  frames: number;
  /** The first frame showing the most live labels (badges and markers). */
  peak: { frame: number; playbackMs: number; labels: number };
  /** Live labels drawn on every frame, in order. */
  labels: number[];
  /** The marker check: frames where some live mark has no marker, and the most marks without one. */
  shortFrames: { frame: number; playbackMs: number; marks: number; markers: number }[];
  maxDropped: number;
}

/**
 * Find the playback time where the client draws the most live labels, by playing the whole match
 * frame by frame at 30 fps from its start, exactly as the measured runs play.
 */
async function densest(browser: Browser, recording: string, endMs: number): Promise<{ startFrame: number; scan: Scan }> {
  const c = await openClient(browser, { recording, width: 1920, height: 1080, tilt: false });
  const labels: number[] = [];
  const shortFrames: Scan["shortFrames"] = [];
  let maxDropped = 0;
  let peak: Scan["peak"] = { frame: 0, playbackMs: 0, labels: -1 };
  let clock = 0;
  for (let k = 0; frameClockMs(k, FPS, 250) < endMs; k++) {
    const target = frameClockMs(k, FPS, 250);
    await c.advance(target - clock);
    clock = target;
    const r = await c.frame();
    labels.push(r.labels);
    if (r.marks.markers < r.marks.marks) shortFrames.push({ frame: k, playbackMs: r.playbackMs, marks: r.marks.marks, markers: r.marks.markers });
    maxDropped = Math.max(maxDropped, r.marks.marks - r.marks.markers);
    if (r.labels > peak.labels) peak = { frame: k, playbackMs: r.playbackMs, labels: r.labels };
  }
  await c.close();
  // Measure from 2 s before the peak, so the 10 s window sits on it.
  return { startFrame: Math.max(0, peak.frame - 2 * FPS), scan: { frames: labels.length, peak, labels, shortFrames, maxDropped } };
}

/** Play from the match's start frame by frame (unmeasured) up to startFrame, then warm up and measure. */
async function run(browser: Browser, recording: string, startFrame: number, width: number, height: number, tilt: boolean, screenshot: boolean) {
  const c = await openClient(browser, { recording, width, height, tilt });
  const update: number[] = [];
  const render: number[] = [];
  const capture: number[] = [];
  const loads: Load[] = [];
  let clock = 0;
  for (let k = 0; k < startFrame + WARMUP + FRAMES; k++) {
    const target = frameClockMs(k, FPS, 250);
    const timed = k >= startFrame;
    const t0 = performance.now();
    await c.advance(target - clock);
    clock = target;
    const r = await c.frame();
    if (screenshot && timed) await c.page.screenshot({ type: "jpeg", quality: 90 });
    const wall = performance.now() - t0;
    if (k < startFrame + WARMUP) continue;
    update.push(r.updateMs!);
    render.push(r.renderMs!);
    capture.push(wall);
    loads.push(loadOf(r));
  }
  const info = c.info;
  await c.close();
  const labels = loads.map((l) => l.liveLabels);
  const sorted = [...labels].sort((a, b) => a - b);
  const liveLabels = { p50: sorted[Math.ceil(0.5 * sorted.length) - 1]!, max: sorted.at(-1)!, raw: labels };
  const peak = loads.reduce((a, b) => (b.liveLabels > a.liveLabels ? b : a));
  return { info, update: series(update), render: series(render), capture: series(capture), liveLabels, load: peak };
}

/**
 * The crowded scene at the scan's peak frame, played up to frame by frame as the scan does, at
 * 1080p and scaled down to 640 px wide, with its marker counts.
 */
async function crowdedFrame(browser: Browser, recording: string, peakFrame: number, dir: string, tag: string) {
  const c = await openClient(browser, { recording, width: 1920, height: 1080, tilt: true });
  let clock = 0;
  let r: FrameResult | undefined;
  for (let k = 0; k <= peakFrame; k++) {
    const target = frameClockMs(k, FPS, 250);
    await c.advance(target - clock);
    clock = target;
    r = await c.frame();
  }
  if (!r) throw new Error("no crowded frame");
  const full = join(dir, `crowded-1080p-${tag}.png`);
  const small = join(dir, `crowded-640w-${tag}.png`);
  const png = await c.page.screenshot({ type: "png" });
  writeFileSync(full, png);
  writeFileSync(small, await scalePng(browser, png, 640, 1920, 1080));
  const rects = await c.page.evaluate(() => window.__antwar.labelRects());
  await c.close();
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i]!;
    const b = rects[j]!;
    if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlaps++;
  }
  return { frame: peakFrame, playbackMs: r.playbackMs, frame1080: full, frame640: small, marks: r.marks, squadTags: r.squadTags, load: loadOf(r), labelRects: rects.length, overlappingLabelPairs: overlaps };
}

async function main() {
  await prepare();
  const rec = scriptedRecording("large");
  const browser = await launchBrowser();
  try {
    const prov = provenance(browser);
    const dir = join(OUT_DIR, "bench");
    mkdirSync(dir, { recursive: true });
    const tag = `${prov.commit.slice(0, 12)}${prov.dirty ? "-dirty" : ""}`;
    const { startFrame, scan } = await densest(browser, rec.name, (rec.messages - 1) * 100);
    const startMs = frameClockMs(startFrame, FPS, 250);
    const wordsCheck = { case: "every live mark drawn as a marker, on every scan frame", shortFrames: scan.shortFrames.length, maxDropped: scan.maxDropped, pass: scan.shortFrames.length === 0 };
    console.log(`densest labels (continuous playback, ${scan.frames} frames): ${scan.peak.labels} live labels at playback ${scan.peak.playbackMs} ms (frame ${scan.peak.frame}); measuring from frame ${startFrame} (clock ${startMs} ms)`);
    console.log(`${wordsCheck.pass ? "PASS" : "FAIL"}  ${wordsCheck.case}: ${wordsCheck.shortFrames} short frames, at most ${wordsCheck.maxDropped} marks without a marker`);
    const crowded = await crowdedFrame(browser, rec.name, scan.peak.frame, dir, tag);
    console.log(`crowded frame (played to frame ${crowded.frame}): ${crowded.load.liveLabels} live labels, ${crowded.marks.marks} live marks, ${crowded.marks.markers} markers, ${crowded.load.chatLines} chat lines; ${crowded.overlappingLabelPairs} overlapping badge pairs`);
    const r1080 = await run(browser, rec.name, startFrame, 1920, 1080, false, false);
    console.log(`1080p all effects except tilt-shift: render p50 ${r1080.render.p50} ms, update p50 ${r1080.update.p50} ms`);
    const r4k = await run(browser, rec.name, startFrame, 3840, 2160, false, false);
    console.log(`4K without tilt-shift: render p50 ${r4k.render.p50} ms`);
    const cap = await run(browser, rec.name, startFrame, 1920, 1080, false, true);
    console.log(`1080p capture frame without tilt-shift: p50 ${cap.capture.p50} ms`);
    const capTilt = await run(browser, rec.name, startFrame, 1920, 1080, true, true);
    console.log(`1080p capture frame with tilt-shift: p50 ${capTilt.capture.p50} ms (reported, no budget)`);

    const loadOfRun = (x: typeof r1080) => ({ liveLabels: { p50: x.liveLabels.p50, max: x.liveLabels.max, scanPeak: scan.peak.labels }, atPeak: x.load });
    const checks = [
      { case: "client update, 2,000 ants (1080p run)", budgetMs: 4, ...pick(r1080.update), ...loadOfRun(r1080) },
      { case: "1080p frame, all effects except tilt-shift", budgetMs: 30, ...pick(r1080.render), ...loadOfRun(r1080) },
      { case: "4K frame without tilt-shift (internal 2560x1440)", budgetMs: 90, ...pick(r4k.render), ...loadOfRun(r4k) },
      { case: "1080p capture frame without tilt-shift (render + JPEG screenshot)", budgetMs: 120, ...pick(cap.capture), ...loadOfRun(cap) },
      { case: "1080p capture frame with tilt-shift (render + JPEG screenshot)", budgetMs: null, ...pick(capTilt.capture), ...loadOfRun(capTilt) },
    ].map((c) => ({ ...c, pass: c.budgetMs === null ? null : c.p50 <= c.budgetMs }));
    const result = {
      task: "bench",
      ...prov,
      recording: { name: rec.name, matchLog: rec.log, logSha256: rec.logSha256, sha256: rec.sha256, ticks: rec.messages - 1, mapW: rec.mapW, mapH: rec.mapH },
      frames: FRAMES,
      warmupFrames: WARMUP,
      fps: FPS,
      startFrame,
      startClockMs: startMs,
      densestLabelScan: scan,
      wordsCheck,
      crowdedFrame: crowded,
      rendererString: r1080.info.rendererString,
      internalRender4k: r4k.info.canvasSize,
      checks,
      raw: {
        "1080p": { update: r1080.update.raw, render: r1080.render.raw, liveLabels: r1080.liveLabels.raw },
        "4k": { update: r4k.update.raw, render: r4k.render.raw, liveLabels: r4k.liveLabels.raw },
        "1080p-capture": { update: cap.update.raw, render: cap.render.raw, capture: cap.capture.raw, liveLabels: cap.liveLabels.raw },
        "1080p-capture-tiltshift": { update: capTilt.update.raw, render: capTilt.render.raw, capture: capTilt.capture.raw, liveLabels: capTilt.liveLabels.raw },
      },
    };
    const file = join(dir, `bench-${tag}.json`);
    writeFileSync(file, JSON.stringify(result, null, 1));
    for (const c of checks) {
      const l = c.atPeak;
      console.log(`${c.pass === null ? "REPORT" : c.pass ? "PASS" : "FAIL"}  ${c.case}: p50 ${c.p50} ms, p95 ${c.p95} ms${c.budgetMs ? `, budget ${c.budgetMs} ms` : ""}; live labels p50 ${c.liveLabels.p50}, max ${c.liveLabels.max} of the scan's peak ${c.liveLabels.scanPeak} (agents ${l.agents}, marks ${l.marks}, markers ${l.markers}, squad tags ${l.squadTags}, intent lines ${l.intentLines})`);
    }
    console.log(file);
    console.log(`${wordsCheck.pass ? "PASS" : "FAIL"}  ${wordsCheck.case}: ${wordsCheck.shortFrames} short frames of ${scan.frames}`);
    if (checks.some((c) => c.pass === false) || !wordsCheck.pass) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

function pick(s: Series) {
  return { p50: s.p50, p95: s.p95 };
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
