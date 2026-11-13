import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage, encodePublicMessage, type StreamMessage } from "../../src/live/format.ts";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { binaryRecord } from "../../src/replays/history.ts";
import { comparisonOptions } from "../../src/server.ts";
import { PUBLIC_CONFIG, rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { replay, stateHash } from "../../src/sim/log.ts";
import { startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { Frame, Playback } from "../../web/src/buffer.ts";
import { openRecording } from "../../web/src/recording.ts";
import { playable } from "../playable.ts";

/**
 * Recordings made before the economy cleanup still play and re-simulate as recorded.
 *
 * fixtures/scripted-public.jsonl and fixtures/scripted-redesign.jsonl are the match logs of
 * playScripted({ seed: 6006, agents: 4, ticks: 900, attack: true }) on the public and new-match redesign configs,
 * written on main 810fe97148ef600b5b7c802bae3fdee4a8ee5b80. fixtures/scripted-hashes.json holds that commit's
 * stateHash after every one of the 900 ticks (replay) and the SHA256 of recordLog's concatenated stream frames.
 *
 * fixtures/pre-frontline-replay.b64 is the base64 text of a public replay object (gzipped framed public messages)
 * written on the same commit from a 620-tick match of the stored pre-frontline redesign config, under that config's
 * economy: at tick 600 both colonies' stores rose with no delivery. The simulation no longer has that rule, so this
 * replay plays only from its stored frames, as every saved replay does. fixtures/pre-frontline-replay.md says how it
 * was made; the test serves the decoded bytes exactly.
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TICKS = 900;
const RECORDED = JSON.parse(readFileSync(fixture("scripted-hashes.json"), "utf8")) as
  Record<"public" | "redesign", { ticks: number; hashes: string[]; frames: number; framesSha256: string }>;
const CONFIGS = { public: playable(PUBLIC_CONFIG), redesign: newMatchConfig(rulesConfig("redesign")) } as const;

describe.each(["public", "redesign"] as const)("a %s match log recorded before the change", name => {
  const text = readFileSync(fixture(`scripted-${name}.jsonl`), "utf8");
  const lines = text.split("\n").filter(line => line !== "");
  const recorded = RECORDED[name];

  it("re-simulates to the recorded hash after every tick", () => {
    const hashes: string[] = [];
    replay(lines, TICKS, state => { hashes.push(stateHash(state)); });
    expect(recorded.ticks).toBe(TICKS);
    expect(hashes).toEqual(recorded.hashes);
  }, 60_000);

  it("re-records the recorded stream frames byte for byte", () => {
    const frames = recordLog(lines, TICKS);
    expect(frames).toHaveLength(recorded.frames);
    expect(sha256(Buffer.concat(frames.map(frame => Buffer.from(frame))))).toBe(recorded.framesSha256);
  }, 60_000);

  it("is the log the same match writes today, header included", () => {
    const { lines: today } = playScripted({ seed: 6006, config: CONFIGS[name], agents: 4, ticks: TICKS, attack: true });
    expect(`${today.join("\n")}\n`).toBe(text);
  }, 60_000);
});

describe("a replay saved before frontline foraging", () => {
  // Node's base64 decoder skips the line breaks.
  const FILE = Buffer.from(readFileSync(fixture("pre-frontline-replay.b64"), "utf8"), "base64");
  const REPLAY_ID = "2026-11-13T00-00-00-000Z-600600600";
  const stored = () => unpackMessages(gunzipSync(FILE)).map(frame => new Uint8Array(frame));

  it("decodes to its recorded frames, including the recorded tick-600 store rise with no delivery", () => {
    expect([FILE.length, sha256(FILE)]).toEqual([196952, "ec8016e6db4345a219ee0ed296b59ca1ffc941c538201ce86b6229474cbf7d67"]);
    const messages = stored().map(frame => decodeMessage(frame));
    expect(messages.map(m => m.tick)).toEqual(Array.from({ length: 621 }, (_, tick) => tick));
    const stores = (tick: number) => messages[tick]!.events.flatMap(e => e.kind === "store" ? [[e.colony, e.food]] : []);
    expect(stores(600)).toEqual([[0, 6]]);
    expect(stores(601)).toEqual([[0, 116], [1, 114]]);
    expect(stored().map(frame => encodePublicMessage(decodeMessage(frame)))).toEqual(stored());
  });

  it("reads as a match record from its recorded facts only", () => {
    const record = binaryRecord({ id: REPLAY_ID, binary: FILE });
    expect(record.status).toBe("partial");
    expect(record.seats).toHaveLength(2);
    expect(record.setup).toMatchObject({ mapW: 128, mapH: 96, gridScale: 2 });
    expect(record.result).toMatchObject({ reason: "time_up", tick: 619 });
  });

  let server: SpectatedServer | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    await server?.close(); server = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is served unchanged and the web player plays every frame", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "antwar-pre-frontline-")); dirs.push(dataDir);
    server = await startSpectatedServer({ ...comparisonOptions({}, DEFAULT_MCP_CONFIG), port: 0, host: "127.0.0.1", dataDir,
      match: "held", expectedPlayers: 2, replaySource: {
        open: async (id) => id === REPLAY_ID ? { body: Readable.from([FILE]), contentLength: String(FILE.length) } : null,
      } }, { ...DEFAULT_LIVE_CONFIG, delaySeconds: 0 });
    const errors: Error[] = [];
    const recording = openRecording(`http://127.0.0.1:${server.port}/replays/${REPLAY_ID}`, (error) => errors.push(error));
    try {
      await recording.first;
      const playback = new Playback(), frame = new Frame();
      const played: StreamMessage[] = [];
      // The player decodes at most two seconds ahead, so the recording completes as playback consumes it.
      const deadline = Date.now() + 30_000;
      for (let real = 0; (played.length < 621 || frame.tick < 620) && Date.now() < deadline; real += 100) {
        for (const { m, at } of recording.take(real)) { played.push(structuredClone(m)); playback.push(m, at); }
        playback.sample(recording.time, frame);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(recording.complete).toBe(true);
      expect(errors).toEqual([]);
      expect(frame.tick).toBe(620);
      expect(played.map((m) => encodePublicMessage(m))).toEqual(stored());
    } finally {
      recording.close();
    }
  }, 60_000);
});
