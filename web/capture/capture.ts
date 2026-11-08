/**
 * Capture command (extended): builds the client, and from a
 * match's JSONL log re-simulates the match (the replay's re-simulation), encodes it
 * with the live stream's encoder (src/live/record.ts), and plays it through the
 * client on Playwright's stepped clock. On the capture host's SwiftShader WebGL2:
 *  - video: the whole match at 1080p30 without tilt-shift, with every overlay shown;
 *    beside it the commit, the match log it played, the viewport, the browser,
 *    the renderer string and the raw frame timings;
 *  - video: a 10 s 4K clip of the 2,000-ant recording without tilt-shift
 *    (rendered internally at the 2560 long-side cap, upscaled to 3840x2160);
 *  - three colour-blindness frames (protanopia, deuteranopia, tritanopia);
 *  - verify: the same span rendered in two fresh pages hashes identically,
 *    re-rendering without advancing the clock reproduces the frame, and a tile
 *    changing owner blends over the frames between its two snapshots.
 * Every video is MP4 (H.264) within 50 MB, decoded end to end with ffmpeg and
 * checked for size and frame count; its metadata JSON sits beside it. Time moves only through
 * Playwright's clock. Before anything is captured the WebGL renderer string must
 * name SwiftShader, or the command stops with an error (exit code 2).
 *
 * Usage: node web/capture/capture.ts [--log <match.jsonl>] [--only match,large,cvd,verify]
 *          [--require-renderer <substring>] [--keep <dir>]
 * Without --log, the match is a scripted one on the default map, played by
 * src/live/record.ts's attacking agents and logged as the server logs.
 * --require-renderer adds a further substring the renderer string must contain;
 * it never replaces the SwiftShader requirement.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import type { Browser } from "playwright-core";
import { TICK_MS, packMessages } from "../../src/live/snapshot.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { SpectatorState } from "../../src/live/model.ts";
import { LARGE_CONFIG, RECORD_CONFIG, playScripted, recordLog } from "../../src/live/record.ts";
import { loadReplayFile } from "../../src/live/replayOptions.ts";
import { parseLog } from "../../src/sim/log.ts";
import { holdBehaviour } from "../../src/sim/holdBehaviour.ts";
import { CHROMIUM_FLAGS, HEADLESS_SHELL, OUT_DIR, RECORDING_DIR, REPO_ROOT, RendererMismatch, frameClockMs, launchBrowser, openClient, type ClientPage } from "./browser.ts";
import { MAX_VIDEO_BYTES, Mp4Encoder, decodeVideo, fitBitrate, type DecodeResult } from "./ffmpeg.ts";
import type { ClientInfo } from "../src/main.ts";

const FPS = 30;
const RENDER_DELAY_MS = 250;
const CAPTURE_DIR = join(OUT_DIR, "capture");
const DEFICIENCIES = ["protanopia", "deuteranopia", "tritanopia"] as const;
const COLONY_HEX = ["#FFB000", "#00C2FF"] as const;

export interface Provenance {
  commit: string;
  dirty: boolean;
  browser: { executable: string; version: string; flags: string[] };
}

export function provenance(browser: Browser): Provenance {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain") !== "",
    browser: { executable: HEADLESS_SHELL, version: browser.version(), flags: CHROMIUM_FLAGS },
  };
}

/** A match log re-simulated and encoded with the live stream's encoder, ready for the client. */
export interface Recorded {
  name: string;
  /** The JSONL match log played, and its digest. */
  log: string;
  logSha256: string;
  /** The packed recording (out/recordings/NAME.bin), and its digest. */
  path: string;
  sha256: string;
  mapW: number;
  mapH: number;
  /** Messages, the first a full snapshot at tick 0; the last tick is messages - 1. */
  messages: number;
}

const sha256 = (b: Buffer | Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Re-simulate a JSONL match log, optionally bounded by completed stopTick.
 * Existing whole-match callers keep the unbounded default. */
export function recordMatch(name: string, logLines: string[], stopTick = Number.POSITIVE_INFINITY): Recorded {
  if (stopTick !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(stopTick) || stopTick < 0)) {
    throw new Error("recordMatch stopTick must be a nonnegative whole tick");
  }
  mkdirSync(RECORDING_DIR, { recursive: true });
  const logText = `${logLines.filter((l) => l.trim() !== "").join("\n")}\n`;
  const log = join(RECORDING_DIR, `${name}.jsonl`);
  writeFileSync(log, logText);
  const messages = recordLog(logText.split("\n"), stopTick);
  const packed = packMessages(messages);
  const path = join(RECORDING_DIR, `${name}.bin`);
  writeFileSync(path, packed);
  const setup = decodeMessage(messages[0]!).full!.setup;
  return { name, log, logSha256: sha256(logText), path, sha256: sha256(packed), mapW: setup.mapW, mapH: setup.mapH, messages: messages.length };
}

/** Guard the source before writing a canonical copy; that copy records the selected holds too. */
export function recordMatchFile(name: string, path: string, holds?: string): Recorded {
  const { lines } = loadReplayFile(path, { holds });
  const { header } = parseLog(lines);
  const first = lines.findIndex(line => line.trim() !== "");
  lines[first] = JSON.stringify({ ...JSON.parse(lines[first]!), holdBehaviour: holdBehaviour(header.config) });
  return recordMatch(name, lines);
}

/** The scripted matches the harnesses use when no log is given: agents attack, so the battle comes. */
export function scriptedRecording(size: "default" | "large", ticks?: number): Recorded {
  const large = size === "large";
  const config = large ? LARGE_CONFIG : RECORD_CONFIG;
  const { lines } = playScripted({ seed: 6006, config, agents: large ? 50 : 10, ticks: ticks ?? config.matchTicks, attack: true });
  return recordMatch(size, lines);
}

export async function prepare(): Promise<void> {
  await build({ configFile: join(REPO_ROOT, "web/vite.config.ts"), logLevel: "warn" });
}

interface FrameTiming {
  frame: number;
  clockMs: number;
  playbackMs: number;
  underrun: boolean;
  ingestMs: number;
  updateMs: number;
  renderMs: number;
  /** Node wall time for advance + frame + JPEG screenshot. */
  captureMs: number;
}

interface VideoJob {
  name: string;
  recording: Recorded;
  width: number;
  height: number;
  tilt: boolean;
  /** Playback time (match ms) of the first frame. */
  fromMs: number;
  frames: number;
  /** Requested bits per second; lowered to fit MAX_VIDEO_BYTES. */
  bitrate: number;
  /** Frame index at which to save the colour-blindness frames, if any. */
  cvdAtFrame?: number;
  /** Frame index at which to save a tilt-shift on/off pair of stills, if any. */
  tiltPairAtFrame?: number;
}

async function captureVideo(browser: Browser, prov: Provenance, job: VideoJob, requireRenderer: string | undefined) {
  const client = await openClient(browser, { recording: job.recording.name, width: job.width, height: job.height, tilt: job.tilt, requireRenderer });
  const file = join(CAPTURE_DIR, `${job.name}.mp4`);
  const bitrate = fitBitrate(job.bitrate, job.frames / FPS);
  const encoder = new Mp4Encoder(file, FPS, bitrate);
  const timings: FrameTiming[] = [];
  const start = RENDER_DELAY_MS + job.fromMs;
  let clock = 0;
  const cvd: Record<string, string> = {};
  let tiltPair: Record<string, string | number> | undefined;
  for (let k = 0; k < job.frames; k++) {
    const target = frameClockMs(k, FPS, start);
    const t0 = performance.now();
    await client.advance(target - clock);
    clock = target;
    const r = await client.frame();
    const jpeg = await client.page.screenshot({ type: "jpeg", quality: 90 });
    const captureMs = performance.now() - t0;
    await encoder.write(jpeg);
    timings.push({ frame: k, clockMs: r.clockMs, playbackMs: r.playbackMs, underrun: r.underrun, ingestMs: r.ingestMs!, updateMs: r.updateMs!, renderMs: r.renderMs!, captureMs });
    if (k === job.cvdAtFrame) Object.assign(cvd, await saveCvdFrames(client, job.name));
    if (k === job.tiltPairAtFrame) tiltPair = { playbackMs: r.playbackMs, ...(await saveTiltPair(client, job.name, job.tilt)) };
    if (k % 150 === 0) console.log(`${job.name}: frame ${k}/${job.frames}`);
  }
  await encoder.close();
  await client.close();
  const decoded = await decodeVideo(file);
  const expected = { width: job.width, height: job.height, frames: job.frames };
  const bytes = statSync(file).size;
  const ok = decoded.codec === "h264" && decoded.width === expected.width && decoded.height === expected.height && decoded.frames === expected.frames && bytes <= MAX_VIDEO_BYTES;
  const meta = {
    task: "capture",
    video: `${job.name}.mp4`,
    container: "MP4 (H.264, libx264)",
    bytes,
    maxBytes: MAX_VIDEO_BYTES,
    bitsPerSecond: bitrate,
    ...prov,
    matchLog: { file: `${job.name}.match.jsonl`, sha256: job.recording.logSha256 },
    recording: { name: job.recording.name, sha256: job.recording.sha256, mapW: job.recording.mapW, mapH: job.recording.mapH, ticks: job.recording.messages - 1 },
    viewport: { width: job.width, height: job.height },
    internalRender: { width: client.info.canvasSize[0], height: client.info.canvasSize[1], resolution: client.info.resolution },
    upscaled:
      client.info.canvasSize[0] !== job.width
        ? `Rendered internally at ${client.info.canvasSize[0]}x${client.info.canvasSize[1]} (2560 long-side cap) and upscaled to ${job.width}x${job.height}.`
        : null,
    tiltShift: job.tilt,
    fps: FPS,
    playback: { fromMs: job.fromMs, toMs: job.fromMs + Math.round(((job.frames - 1) * 1000) / FPS), renderDelayMs: RENDER_DELAY_MS },
    rendererString: client.info.rendererString,
    webgl2: client.info.webgl2,
    fontLicence: client.info.fontLicence,
    decoded: { codec: decoded.codec, width: decoded.width, height: decoded.height, frames: decoded.frames, expected, ok },
    cvdFrames: Object.keys(cvd).length ? cvd : undefined,
    tiltShiftPair: tiltPair,
    rawFrameTimingsMs: timings,
  };
  writeFileSync(join(CAPTURE_DIR, `${job.name}.json`), JSON.stringify(meta, null, 1));
  cpSync(job.recording.log, join(CAPTURE_DIR, `${job.name}.match.jsonl`));
  console.log(`${job.name}: ${file} ${decoded.codec} ${decoded.width}x${decoded.height} ${decoded.frames} frames, ${bytes} bytes; expected h264 ${expected.width}x${expected.height} ${expected.frames} frames within ${MAX_VIDEO_BYTES} bytes: ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) process.exitCode = 1;
  return { file, decoded, info: client.info };
}

/** Re-render the current frame under each simulation (no clock advance) and save PNGs. */
async function saveCvdFrames(client: ClientPage, prefix: string): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  const shot = async (label: string) => {
    await client.frame();
    const name = `${prefix}-${label}.png`;
    writeFileSync(join(CAPTURE_DIR, name), await client.page.screenshot({ type: "png" }));
    saved[label] = name;
  };
  await shot("normal-vision");
  for (const d of DEFICIENCIES) {
    await client.setOptions({ cvd: d });
    await shot(d);
  }
  await client.setOptions({ cvd: null });
  await client.frame();
  return saved;
}

/**
 * Re-render the current frame (no clock advance) with tilt-shift on and off and save
 * both as PNGs, everything else unchanged; then restore the job's setting.
 */
async function saveTiltPair(client: ClientPage, prefix: string, tilt: boolean): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  for (const on of [true, false]) {
    await client.setOptions({ tilt: on });
    await client.frame();
    const name = `${prefix}-tilt-${on ? "on" : "off"}.png`;
    writeFileSync(join(CAPTURE_DIR, name), await client.page.screenshot({ type: "png" }));
    saved[on ? "on" : "off"] = name;
  }
  await client.setOptions({ tilt });
  await client.frame();
  return saved;
}

// --- Colour distance of the colony colours under each simulation -------------

function srgbToLab([r, g, b]: number[]): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r!), lin(g!), lin(b!)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function colonyDeltaE(matrices: ClientInfo["cvdMatrices"]) {
  const rgb = COLONY_HEX.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255));
  const apply = (m: readonly number[], c: number[]) =>
    [0, 1, 2].map((r) => Math.min(1, Math.max(0, m[r * 3]! * c[0]! + m[r * 3 + 1]! * c[1]! + m[r * 3 + 2]! * c[2]!)));
  const dE = (a: number[], b: number[]) => Math.hypot(...srgbToLab(a).map((v, i) => v - srgbToLab(b)[i]!));
  const out: Record<string, { amber: string; cyan: string; deltaE76: number }> = {};
  const hex = (c: number[]) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  out["normal-vision"] = { amber: COLONY_HEX[0], cyan: COLONY_HEX[1], deltaE76: +dE(rgb[0]!, rgb[1]!).toFixed(1) };
  for (const d of DEFICIENCIES) {
    const a = apply(matrices[d], rgb[0]!);
    const c = apply(matrices[d], rgb[1]!);
    out[d] = { amber: hex(a), cyan: hex(c), deltaE76: +dE(a, c).toFixed(1) };
  }
  return out;
}

// --- Determinism and territory blending -------------------------------------

async function verify(browser: Browser, prov: Provenance, recording: Recorded, requireRenderer: string | undefined, holds?: string) {
  const span = { fromMs: 20_000, frames: 60 };
  const run = async () => {
    const c = await openClient(browser, { recording: recording.name, width: 1920, height: 1080, tilt: true, requireRenderer });
    const hashes: string[] = [];
    let clock = 0;
    for (let k = 0; k < span.frames; k++) {
      const target = frameClockMs(k, FPS, RENDER_DELAY_MS + span.fromMs);
      await c.advance(target - clock);
      clock = target;
      hashes.push(await c.page.evaluate(() => window.__antwar.hashFrame()));
    }
    const again = await c.page.evaluate(() => window.__antwar.hashFrame());
    await c.close();
    return { hashes, again };
  };
  const first = await run();
  const second = await run();
  const mismatched = first.hashes.flatMap((h, i) => (h === second.hashes[i] ? [] : [i]));
  const distinct = new Set(first.hashes).size;
  const determinism = {
    span: { ...span, fps: FPS, width: 1920, height: 1080, tiltShift: true },
    framesCompared: span.frames,
    identicalAcrossCaptures: mismatched.length === 0,
    mismatchedFrames: mismatched,
    distinctFrames: distinct,
    sameFrameWithoutAdvancing: first.again === first.hashes.at(-1) && second.again === second.hashes.at(-1),
    hashes: first.hashes,
  };

  const blend = await territoryProbe(browser, recording, requireRenderer, holds);
  const result = { task: "capture", ...prov, recording: { name: recording.name, sha256: recording.sha256 }, determinism, territoryBlend: blend };
  writeFileSync(join(CAPTURE_DIR, "verify.json"), JSON.stringify(result, null, 1));
  const ok = determinism.identicalAcrossCaptures && determinism.sameFrameWithoutAdvancing && distinct > 1 && blend.ok;
  console.log(
    `verify: identical across captures ${determinism.identicalAcrossCaptures} (${distinct} distinct frames), same without advancing ${determinism.sameFrameWithoutAdvancing}, territory blends ${blend.ok}`,
  );
  if (!ok) process.exitCode = 1;
}

/**
 * Pick an interior tile that changes owner between two consecutive snapshots,
 * show the ground layer alone, and sample the tile's centre pixel on every
 * frame from just before the first snapshot to just after the second.
 */
export function territoryMessages(recording: Pick<Recorded, "log">, holds?: string) {
  return recordLog(loadReplayFile(recording.log, { holds }).lines).map(decodeMessage);
}

async function territoryProbe(browser: Browser, recording: Recorded, requireRenderer: string | undefined, holds?: string) {
  const msgs = territoryMessages(recording, holds);
  const first = msgs[0]!;
  const board = new SpectatorState(structuredClone(first.full!), first.tick, first.ants);
  const grids = [board.full.territory.slice()];
  for (const m of msgs.slice(1)) {
    board.apply(m);
    grids.push(board.full.territory.slice());
  }
  const { mapW, mapH } = first.full!.setup;
  let pick: { tick: number; col: number; row: number } | null = null;
  for (let t = 150; t < msgs.length - 1 && !pick; t++) {
    const a = grids[t]!;
    const b = grids[t + 1]!;
    for (let row = 8; row < mapH - 8 && !pick; row++) {
      for (let col = 8; col < mapW - 8; col++) {
        const i = row * mapW + col;
        // A tile passing straight from one colony to the other: the largest change of tint on screen.
        if (a[i] !== b[i] && a[i] !== 0 && b[i] !== 0) {
          pick = { tick: t, col, row };
          break;
        }
      }
    }
  }
  if (!pick) throw new Error("no flipping tile found for the territory probe");
  const c = await openClient(browser, { recording: recording.name, width: 1920, height: 1080, tilt: false, requireRenderer });
  await c.setOptions({ ants: false, words: false, front: false, battles: false, trails: false, overlays: false });
  const [sx, sy] = await c.page.evaluate(([x, y]) => window.__antwar.tileToScreen(x, y), [pick.col + 0.5, pick.row + 0.5] as [number, number]);
  const samples: { playbackMs: number; rgb: number[] }[] = [];
  let clock = 0;
  // Frames fall at -17, 16, 50, 83 and 116 ms around the flip: none within a millisecond of either
  // snapshot, where 8-bit colour cannot show the last percent of the blend.
  const from = pick.tick * TICK_MS - 17;
  for (let k = 0; ; k++) {
    const target = frameClockMs(k, FPS, RENDER_DELAY_MS + from);
    if (target - RENDER_DELAY_MS > (pick.tick + 1) * TICK_MS + 17) break;
    await c.advance(target - clock);
    clock = target;
    const px = await c.page.evaluate(([x, y]) => window.__antwar.samplePixel(x, y), [sx, sy] as [number, number]);
    samples.push({ playbackMs: target - RENDER_DELAY_MS, rgb: px.slice(0, 3) });
  }
  await c.close();
  const startMs = pick.tick * TICK_MS;
  const endMs = (pick.tick + 1) * TICK_MS;
  const before = samples.filter((s) => s.playbackMs <= startMs).at(-1)!;
  const after = samples.find((s) => s.playbackMs >= endMs)!;
  const between = samples.filter((s) => s.playbackMs > startMs && s.playbackMs < endMs);
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));
  const total = dist(before.rgb, after.rgb);
  // The change is spread over the in-between frames. Each frame's progress along the colour path is
  // d(start, frame) / (d(start, frame) + d(frame, end)), which also handles a path that curves (the tint
  // passes through bare soil as ownership crosses over). Progress must rise frame by frame, stay strictly
  // between the ends, and no single frame may carry more than half of the change.
  const fractions = between.map((s) => +(dist(before.rgb, s.rgb) / (dist(before.rgb, s.rgb) + dist(s.rgb, after.rgb))).toFixed(3));
  const path = [0, ...fractions, 1];
  const steps = path.slice(1).map((f, i) => +(f - path[i]!).toFixed(3));
  const ok = total > 10 && between.length >= 2 && fractions.every((f) => f > 0 && f < 1) && steps.every((d) => d > 0 && d <= 0.5);
  return { tile: pick, screen: [sx, sy], fromTick: pick.tick, toTick: pick.tick + 1, samples, colourDistance: +total.toFixed(1), inBetweenFractions: fractions, stepFractions: steps, ok };
}

async function main() {
  const { values } = parseArgs({
    options: {
      log: { type: "string" },
      holds: { type: "string" },
      only: { type: "string" },
      "require-renderer": { type: "string" },
      keep: { type: "string", default: join(tmpdir(), "antwar-captures") },
    },
  });
  const only = new Set((values.only ?? "match,large,cvd,verify").split(","));
  const requireRenderer = values["require-renderer"];
  // Validate a supplied path before build or browser work.
  const match = values.log ? recordMatchFile("match", values.log, values.holds) : undefined;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await prepare();
  const recording = match ?? scriptedRecording("default");
  const large = only.has("large") ? scriptedRecording("large", 800) : null;
  const browser = await launchBrowser();
  try {
    const prov = provenance(browser);
    const results: Record<string, { file: string; decoded: DecodeResult }> = {};
    let info: ClientInfo | undefined;
    if (only.has("match")) {
      // The whole match, from tick 0 to its final tick, without tilt-shift.
      const frames = Math.floor(((recording.messages - 1) * TICK_MS * FPS) / 1000) + 1;
      const r = await captureVideo(browser, prov, {
        name: "match-1080p", recording, width: 1920, height: 1080, tilt: false,
        fromMs: 0, frames, bitrate: 14_000_000, cvdAtFrame: only.has("cvd") ? Math.min(frames - 1, 70 * FPS) : undefined,
        tiltPairAtFrame: Math.min(frames - 1, 70 * FPS),
      }, requireRenderer);
      results.match = r;
      info = r.info;
    }
    if (large) {
      const r = await captureVideo(browser, prov, {
        name: "large-4k-clip", recording: large, width: 3840, height: 2160, tilt: false,
        fromMs: 62_000, frames: 10 * FPS, bitrate: 40_000_000,
      }, requireRenderer);
      results.large = r;
      info ??= r.info;
    }
    if (only.has("cvd")) {
      if (!info) {
        const c = await openClient(browser, { recording: recording.name, width: 1920, height: 1080, tilt: true, requireRenderer });
        info = c.info;
        await c.close();
      }
      const deltaE = colonyDeltaE(info.cvdMatrices);
      writeFileSync(join(CAPTURE_DIR, "cvd.json"), JSON.stringify({ task: "capture", ...prov, method: "Machado 2009 matrices applied to sRGB values, as the client's filter does; CIE76 deltaE in Lab", colonies: deltaE }, null, 1));
      console.log(`cvd: ${Object.entries(deltaE).map(([k, v]) => `${k} dE ${v.deltaE76}`).join(", ")}`);
    }
    if (only.has("verify")) await verify(browser, prov, recording, requireRenderer, values.holds);
    const keep = join(values.keep!, prov.commit.slice(0, 12));
    mkdirSync(keep, { recursive: true });
    cpSync(CAPTURE_DIR, keep, { recursive: true });
    const sums = Object.entries(results).map(([k, r]) => `${k} sha256 ${sha256(readFileSync(r.file))}`);
    console.log(`kept in ${keep}${sums.length ? "\n" + sums.join("\n") : ""}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof RendererMismatch) {
      console.error(`capture refused: ${e.message}`);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
