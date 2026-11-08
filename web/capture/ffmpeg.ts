/**
 * Video encoding and decode verification. Videos for viewers are MP4 (H.264).
 * The capture host has no system ffmpeg and Playwright's
 * ffmpeg-1011 encodes only VP8, so the encoder is the static ffmpeg of the
 * dev-only @ffmpeg-installer/ffmpeg package (libx264), which the runtime image
 * never installs.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FFMPEG: string = process.env.ANTWAR_FFMPEG ?? (createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg") as { path: string }).path;

/** The most a committed video may weigh (at most 50 MB). */
export const MAX_VIDEO_BYTES = 50_000_000;

/**
 * The requested bitrate, lowered if needed so a video of this many seconds stays
 * under MAX_VIDEO_BYTES with 5% to spare for the container and rate overshoot.
 */
export function fitBitrate(requestedBitsPerSecond: number, seconds: number): number {
  return Math.min(requestedBitsPerSecond, Math.floor((MAX_VIDEO_BYTES * 8 * 0.95) / Math.max(1, seconds)));
}

/** Pipes JPEG frames into an MP4 (H.264, yuv420p), at most bitsPerSecond. */
export class Mp4Encoder {
  private proc: ChildProcessByStdio<Writable, null, Readable>;
  private done: Promise<void>;
  private stderr = "";

  constructor(out: string, fps: number, bitsPerSecond: number) {
    const rate = String(bitsPerSecond);
    this.proc = spawn(
      FFMPEG,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p",
        "-b:v", rate, "-maxrate", rate, "-bufsize", String(bitsPerSecond * 2),
        "-movflags", "+faststart",
        out,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.proc.stderr.on("data", (d: Buffer) => (this.stderr += d.toString()));
    this.done = new Promise((resolve, reject) => {
      this.proc.on("error", reject);
      this.proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg encode exited ${code}: ${this.stderr}`))));
    });
  }

  async write(jpeg: Buffer): Promise<void> {
    if (!this.proc.stdin.write(jpeg)) await new Promise<void>((r) => this.proc.stdin.once("drain", () => r()));
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await this.done;
  }
}

export interface DecodeResult {
  codec: string;
  width: number;
  height: number;
  frames: number;
  /** ffmpeg's own report, for the record. */
  log: string;
}

/**
 * Decode every frame of a video end to end (-xerror: any decode error fails),
 * scaling each to a thumbnail so the work is the decode. Reports the stream's
 * codec and size and the number of frames decoded.
 */
export async function decodeVideo(path: string): Promise<DecodeResult> {
  const dir = mkdtempSync(join(tmpdir(), "antwar-decode-"));
  try {
    const log = await new Promise<string>((resolve, reject) => {
      let err = "";
      const p = spawn(FFMPEG, ["-hide_banner", "-xerror", "-i", path, "-vf", "scale=64:-2", "-f", "image2", "-update", "1", "-y", join(dir, "last.png")], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg decode of ${path} exited ${code}: ${err}`))));
    });
    const stream = /Stream #\d+:\d+.*?Video: (\w+).*?, (\d+)x(\d+)/.exec(log);
    const frames = [...log.matchAll(/frame=\s*(\d+)/g)].at(-1);
    if (!stream || !frames) throw new Error(`could not read stream or frame count from ffmpeg output:\n${log}`);
    return { codec: stream[1]!, width: Number(stream[2]), height: Number(stream[3]), frames: Number(frames[1]), log: log.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
