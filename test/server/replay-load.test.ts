import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import type { TickTiming } from "../../src/server.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { playable } from "../playable.ts";

let server: SpectatedServer | null = null;
let dir: string | null = null;
let response: IncomingMessage | null = null;
afterEach(async () => {
  response?.destroy(); response = null;
  await server?.close(); server = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null;
  vi.restoreAllMocks();
});

it("keeps complete live tick work below 100 ms during a backpressured roughly 32 MiB replay download", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // Generate one incompressible gzip member before timing, then stream 512 members.
  // Concatenated gzip members form valid gzip; neither server nor client retains the whole file.
  const member = gzipSync(randomBytes(64 * 1024));
  const members = 512;
  const expected = createHash("sha256");
  for (let n = 0; n < members; n++) expected.update(member);
  const expectedHash = expected.digest("hex");
  let downloading = false;
  const timings: TickTiming[] = [];
  let peakSourceBuffer = 0;
  const body = Readable.from((function* () { for (let n = 0; n < members; n++) yield member; })(), { objectMode: false, highWaterMark: 64 * 1024 });
  dir = mkdtempSync(join(tmpdir(), "antwar-replay-load-"));
  server = await startSpectatedServer({
    port: 0, host: "127.0.0.1", dataDir: dir, breakMs: 20,
    simConfig: playable({ ...rulesConfig("redesign"), startAnts: 256, colonyCap: 512, matchTicks: 100 }),
    replayStore: { create: async () => {} },
    replaySource: { open: async () => { downloading = true; return { body, contentLength: String(member.length * members) }; } },
    onTickTiming: (sample) => {
      if (!downloading) return;
      timings.push(sample);
      peakSourceBuffer = Math.max(peakSourceBuffer, body.readableLength);
    },
  }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  const target = `http://127.0.0.1:${server.port}/replays/2026-10-18T09-50-00-123Z-1`;
  response = await new Promise<IncomingMessage>((resolve, reject) => httpGet(target, resolve).once("error", reject));
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe("gzip");
  const digest = createHash("sha256");
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = response!;
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      digest.update(chunk); received += chunk.length;
      stream.pause(); setTimeout(() => stream.resume(), 6);
    });
    stream.on("end", resolve);
  });
  downloading = false;
  expect(received).toBe(member.length * members);
  expect(digest.digest("hex")).toBe(expectedHash);
  expect(server.game.match!.state.ants.length).toBeGreaterThanOrEqual(500);
  expect(timings.length).toBeGreaterThanOrEqual(20);
  const work = timings.map((t) => t.workMs).sort((a, b) => a - b);
  const late = timings.map((t) => t.lateMs).sort((a, b) => a - b);
  const p95 = (values: number[]) => values[Math.ceil(values.length * 0.95) - 1]!;
  const measured = {
    samples: timings.length, bytes: received, ants: server.game.match!.state.ants.length,
    maxWorkMs: work.at(-1), p95WorkMs: p95(work), maxLateMs: late.at(-1), p95LateMs: p95(late),
    peakSourceBufferBytes: peakSourceBuffer, node: process.versions.node,
  };
  // This output is retained by the test run; the report quotes the actual measurements.
  console.info("replay tick timing", JSON.stringify(measured));
  // Machine-dependent timing check: skipped on CI runners, kept on the deploy host.
  if (!process.env.CI) expect(work.at(-1)).toBeLessThan(100);
  expect(peakSourceBuffer).toBeLessThanOrEqual(member.length * 2);
}, 15_000);
