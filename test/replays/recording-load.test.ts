import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { createGcsReplayStore } from "../../src/replays/store.ts";
import type { TickTiming } from "../../src/server.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { createRng } from "../../src/sim/rng.ts";
import { startSpectatedServer } from "../../src/spectator.ts";
import { playable } from "../playable.ts";
import { comparison, startComparisonMatch } from "../server/helpers.ts";

const percentile = (values: number[], fraction: number): number => {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1]!;
};

it("measures full-size final recording packing/upload blocking, then starts the next match", async () => {
  // A full-size, valid encoded stream with deterministic moving ant arrays. Build
  // all inputs before timing: this isolates final packing/gzip/upload, not capture.
  const recorder = new SpectatorRecorder(createMatch(6006, playable({ ...rulesConfig("redesign"), startAnts: 256, colonyCap: 512 })));
  const first = { ...recorder.initial(), full: recorder.initialFull() };
  const digest = createHash("sha256");
  const errors: string[] = [];
  const uploadedChunks: Uint8Array[] = [];
  let compressedBytes = 0, maxUploadChunkBytes = 0;
  let jsonUploads = 0;
  let uploadCalls = 0, storeStartedAt = 0, storePreparationMs = 0;
  // Real store code and progressive request-body consumption, fake HTTP only. No network,
  // cloud resources, provider credentials, or identity service requests.
  const request: typeof fetch = async (url, init) => {
    if (String(url).startsWith("http://metadata.google.internal/")) {
      storeStartedAt = performance.now();
      return Response.json({ access_token: "scripted-test-token" });
    }
    storePreparationMs = performance.now() - storeStartedAt;
    expect(String(url)).toContain("/upload/storage/v1/b/scripted-only/");
    if (new URL(String(url)).searchParams.get("name")!.endsWith(".json")) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of init!.body as ReadableStream<Uint8Array>) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({ source: "binary", status: "partial" });
      jsonUploads++;
      return new Response(null, { status: 200 });
    }
    uploadCalls++;
    for await (const chunk of init!.body as ReadableStream<Uint8Array>) {
      uploadedChunks.push(chunk);
      compressedBytes += chunk.byteLength;
      maxUploadChunkBytes = Math.max(maxUploadChunkBytes, chunk.byteLength);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(null, { status: 200 });
  };
  const recording = new ReplayRecording(0, 1, createGcsReplayStore("scripted-only", request), (error) => errors.push(error));
  let rawBytes = 0, messageCount = 0;
  function append(bytes: Uint8Array) {
    recording.append(bytes);
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length);
    digest.update(prefix); digest.update(bytes);
    rawBytes += 4 + bytes.length; messageCount++;
  }
  append(encodePublicMessage(first));
  const ants = first.ants;
  const rng = createRng(6006);
  for (let tick = 1; rawBytes < 48_400_000; tick++) {
    for (let i = 0; i < ants.count; i++) {
      ants.x[i] = (ants.x[i]! + Math.floor(rng.next() * 257) - 128 + 16384) % 16384;
      ants.y[i] = (ants.y[i]! + Math.floor(rng.next() * 257) - 128 + 12288) % 12288;
      ants.heading[i] = Math.floor(rng.next() * 256);
    }
    append(encodePublicMessage({ tick, ants, full: null, events: [] }));
  }
  append(encodePublicMessage({ tick: messageCount, ants, full: null, events: [{ kind: "end", result: {
    winner: null, reason: "time_up", decidedBy: "draw", tick: messageCount - 1, nextStartMs: 0,
  } }] }));
  const expectedHash = digest.digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "antwar-recording-load-"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const timings: TickTiming[] = [];
  const heartbeatDelays: number[] = [];
  let measuring = false, heartbeat: ReturnType<typeof setTimeout> | undefined;
  let firstTicksReady!: () => void;
  const firstTicks = new Promise<void>((resolve) => { firstTicksReady = resolve; });
  const server = await startSpectatedServer({ port: 0, host: "127.0.0.1", dataDir: dir, ...comparison(0),
    simConfig: playable({ ...rulesConfig("redesign"), startAnts: 256, colonyCap: 512, matchTicks: 100 }),
    onTickTiming: (sample) => {
      timings.push(sample);
      if (timings.length === 5) firstTicksReady();
    },
  }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  let finishSyncMs = 0, elapsedMs = 0;
  try {
    measuring = true;
    function beat() {
      const due = performance.now() + 5;
      heartbeat = setTimeout(() => {
        heartbeatDelays.push(Math.max(0, performance.now() - due));
        if (measuring) beat();
      }, 5);
    }
    beat();
    // The 100 ms limit covers the
    // upload/pack period only and stops before the next match starts; the synchronous
    // match-start stall is tracked separately.
    const startedAt = performance.now();
    const saved = await new Promise<boolean>((resolve, reject) => setTimeout(() => {
      const start = performance.now();
      const done = recording.finish();
      finishSyncMs = performance.now() - start;
      done.then(resolve, reject);
    }, 90));
    elapsedMs = performance.now() - startedAt - 90;
    // Flush a pending heartbeat so the final synchronous upload section counts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    measuring = false;
    clearTimeout(heartbeat);
    // The next match starts after the measured window; its first ticks are logged, not budgeted.
    await startComparisonMatch(server, 0);
    await firstTicks;
    expect(saved).toBe(true);
    expect(uploadCalls).toBe(1);
    // The readable record is built by the record service, never during this upload.
    expect(jsonUploads).toBe(0);
    expect(errors).toEqual([]);
    const measured = {
      rawBytes, compressedBytes, maxUploadChunkBytes, messageCount, ants: ants.count,
      finishSyncMs, uploadElapsedMs: elapsedMs, storePreparationMs,
      maxBlockingMs: Math.max(finishSyncMs, ...heartbeatDelays), p95BlockingMs: percentile(heartbeatDelays, 0.95),
      heartbeatSamples: heartbeatDelays.length, tickSamples: timings.length,
      firstTickLateMs: timings[0]!.lateMs, firstFiveTickLateMs: timings.slice(0, 5).map((sample) => sample.lateMs),
      maxTickWorkMs: Math.max(...timings.map((sample) => sample.workMs)), p95TickWorkMs: percentile(timings.map((sample) => sample.workMs), 0.95),
      node: process.versions.node,
    };
    console.info("recording upload timing", JSON.stringify(measured));
    // Verify bytes outside the measured section (sync gunzip/hash must not inflate
    // measured upload blocking). No timing result is inferred from this check.
    const packed = gunzipSync(Buffer.concat(uploadedChunks));
    expect(createHash("sha256").update(packed).digest("hex")).toBe(expectedHash);
    const messages = unpackMessages(packed);
    expect(messages).toHaveLength(messageCount);
    expect(decodeMessage(messages[0]!).full!.setup).not.toHaveProperty("seed");
    expect(decodeMessage(messages.at(-1)!).events[0]!.kind).toBe("end");
    expect(maxUploadChunkBytes).toBeLessThanOrEqual(64 * 1024);
    expect(measured.maxBlockingMs).toBeLessThan(100);
  } finally {
    measuring = false;
    clearTimeout(heartbeat);
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    log.mockRestore();
  }
}, 30_000);
