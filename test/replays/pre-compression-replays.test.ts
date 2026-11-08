import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { comparisonOptions } from "../../src/server.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { openRecording } from "../../web/src/recording.ts";

/**
 * Replays stored before the in-memory compression change still load and play back unchanged.
 *
 * fixtures/pre-compression-replay.bin is a stored replay object exactly as the code before that change wrote it:
 * the scenario of the golden exporter (seed 6006, redesign rules, four ticks,
 * one join at tick 0, ManualClock from 2026-01-01T00:00:00.000Z) run with Node v24.19.0 on a git archive of
 * 8905980bde1e12861a8eae658903341647f0d64d, keeping the normal released `<id>.bin` object. It was kept because its
 * frames equal the captured golden run-one's apart from the documented random match identity at /0/full/match.
 */
const FIXTURE = readFileSync(new URL("./fixtures/pre-compression-replay.bin", import.meta.url));
const STORED_SHA256 = "ef2eb8d4c609b3b65c0eaec9f5f3f2e860cd9025046db28b403795606d9e7bcd";
const REPLAY_ID = "2026-01-01T00-00-00-000Z-115301433259845";
const IDENTITY = 115301433259845;
/** run-one's identity and the SHA256 of JSON.stringify of its decoded released frames (manifest: releasedDecoded). */
const RUN_ONE_IDENTITY = 136137678499777;
const RUN_ONE_RELEASED_DECODED = { bytes: 157_554, sha256: "f6f0837aa84edf9d1773751a618234a22204664dddd17326e91e1c630cfc7286" };

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/**
 * The decoded frames as run-one's golden records them: only the opening snapshot's match identity is replaced.
 * The golden's JSON was taken over frames decoded from Node Buffers (unpackMessages(gunzipSync(...))), whose byte
 * fields serialize differently from Uint8Array ones, so it is compared only over frames decoded the same way.
 */
function asRunOne(messages: readonly StreamMessage[]): string {
  const [opening, ...rest] = messages;
  return JSON.stringify([{ ...opening!, full: { ...opening!.full!, match: RUN_ONE_IDENTITY } }, ...rest]);
}

const dirs: string[] = [];
let server: SpectatedServer | null = null;
afterEach(async () => {
  await server?.close(); server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("the stored pre-change replay decodes to run-one's golden frames, apart from the documented match identity", () => {
  expect(FIXTURE.length).toBe(1859);
  expect(sha256(FIXTURE)).toBe(STORED_SHA256);
  const messages = unpackMessages(gunzipSync(FIXTURE)).map(decodeMessage);
  expect(messages.map((m) => m.tick)).toEqual([0, 1, 2, 3, 4]);
  expect(messages[0]!.full!.match).toBe(IDENTITY);
  const golden = asRunOne(messages);
  expect(Buffer.byteLength(golden)).toBe(RUN_ONE_RELEASED_DECODED.bytes);
  expect(sha256(golden)).toBe(RUN_ONE_RELEASED_DECODED.sha256);
});

it("today's replay route serves the stored object unchanged and the web player plays every frame back unchanged", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "antwar-pre-compression-")); dirs.push(dataDir);
  const publicOptions = comparisonOptions({}, DEFAULT_MCP_CONFIG);
  server = await startSpectatedServer({ ...publicOptions, port: 0, host: "127.0.0.1", dataDir, match: "held", replaySource: {
    open: async (id) => id === REPLAY_ID ? { body: Readable.from([FIXTURE]), contentLength: String(FIXTURE.length) } : null,
  } }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
  const url = `http://127.0.0.1:${server.port}/replays/${REPLAY_ID}`;

  // Load: the stored bytes, untouched, labelled for the browser to decode.
  const response = await raw(url);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(await bytes(response)).toEqual(FIXTURE);

  // Play back: native fetch performs the browser's HTTP gzip decoding for the web player's recording reader.
  const errors: Error[] = [];
  const recording = openRecording(url, (error) => errors.push(error));
  try {
    await recording.first;
    await vi.waitFor(() => expect(recording.complete).toBe(true));
    const playback = new Playback(), frame = new Frame();
    const played: StreamMessage[] = [];
    // The rendered frame trails delivery by the player's render delay; play until it shows the last tick.
    for (let real = 0; (played.length < 5 || frame.tick < 4) && real <= 5_000; real += 100) {
      // Each frame is kept as it arrived, before Playback consumes it.
      for (const { m, at } of recording.take(real)) { played.push(structuredClone(m)); playback.push(m, at); }
      playback.sample(recording.time, frame);
    }
    expect(errors).toEqual([]);
    expect(played.map((m) => m.tick)).toEqual([0, 1, 2, 3, 4]);
    expect(frame.tick).toBe(4);
    // Stored replays are public, so the public encoder reproduces each stored frame exactly from what was played:
    // the player received the stored frames, which the first test ties to run-one's golden.
    const stored = unpackMessages(gunzipSync(FIXTURE)).map((frame) => new Uint8Array(frame));
    expect(played.map((m) => encodePublicMessage(m))).toEqual(stored);
  } finally {
    recording.close();
  }
});

function raw(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => { httpGet(url, resolve).once("error", reject); });
}
async function bytes(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
