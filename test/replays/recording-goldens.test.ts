// Golden parity: new recordings of the captured scenario (seed 6006, redesign rules, four
// ticks, one join at tick 0) still decompress, record and hand off exactly as the captured goldens.
// Goldens: run one of the capture at commit 8327b0816a43e559876262682c6320ec7f0f5527 (rules 27), whose exporter
// this test follows step for step. The hashes below are run one's, except the readable record: it is run one's plus the two null seat fields
// (serviceTier, handle), which every SeatRecord now carries; and the final state hash, both frame digests and the private envelope, which were
// re-pinned when each reference cell's opening food moved to the fine row its start ants stand in (same lengths, other food bytes).
//
// The one documented run-to-run difference is the random MatchStream identity: it is /0/full/match in
// both frame arrays and the suffix of the replay, envelope and readable-record id. Here it is pinned to
// run one's identity, so every other byte must equal run one's. Compressed bytes are free to change
// (the compressed copy is written in parts while the match runs), so the stored replay and the checkpoint
// are compared after decompression, and the envelope with its checkpoint repacked by gzipMessages.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { decodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { createRecordReplayStore } from "../../src/records/replay-store.ts";
import { createRecordService } from "../../src/records/service.ts";
import { gzipMessages } from "../../src/replays/pack.ts";
import { ReplayCreateError, type ReplayObject } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { stateHash, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "../live/helpers.ts";
import { playable } from "../playable.ts";
import { createOnlyRecords } from "../records/create-only-records.js";

const { GOLDEN_IDENTITY } = vi.hoisted(() => ({ GOLDEN_IDENTITY: 194180557898392 }));

// Only the MatchStream identity draw, randomInt(1, 2 ** 48) in src/live/hub.ts, is pinned; every other call is real.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomInt = (...args: unknown[]): unknown =>
    args.length === 2 && args[0] === 1 && args[1] === 2 ** 48 ? GOLDEN_IDENTITY : (actual.randomInt as (...a: unknown[]) => unknown)(...args);
  return { ...actual, randomInt };
});

/** The capture's code version, carried in the envelope header. */
const CAPTURE_COMMIT = "8327b0816a43e559876262682c6320ec7f0f5527";
const STARTED_AT = Date.parse("2026-01-01T00:00:00.000Z");
const GOLDEN_ID = `2026-01-01T00-00-00-000Z-${GOLDEN_IDENTITY}`;

/** The captured golden's run one: byte length and SHA-256 of each payload. */
const GOLDEN = {
  checkpointFramed: { byteLength: 16503, sha256: "891244c659cbfabe6913fddcc2cef0dfc98c50b3e30d4697e363756bb7a12d55" },
  releasedFramed: { byteLength: 16511, sha256: "d0bdf143e3fb9022308b06fe88d25c5727b00593e81574604d45ffd9cf796a9f" },
  checkpointDecoded: { byteLength: 157641, sha256: "8a3d0393fbffa46a31819fa9b2e0ddb83c30774045915c392682a54995f16985" },
  releasedDecoded: { byteLength: 157650, sha256: "e01f384d3e7c2f6b6a5db450c49a322adf96c88162fcfb838993c7065ae67594" },
  // Run one's readable record (5700 bytes, f5db6739…) plus the two null seat fields on its one seat,
  // `"serviceTier":null,"handle":null,` (33 bytes) after thinkingLevel (5733 bytes, a3224f49…); then, as the record
  // service publishes it, its one unavailable reason as REPLIES_NOT_RETAINED (+25 bytes),
  // `,"codeVersion":"8327b0816a43e559876262682c6320ec7f0f5527"` (+57) and `,"replies":null` (+15) last (5830 bytes,
  // 2855643e…); then, a public record, `,"rerun":{"seed":6006,"stops":[],"abandonments":[],"idle":[],"houseActive":[]}`
  // (+78) after its events, run one's log seed and its server controls (none: this capture logs no control); every other
  // byte is run one's.
  readableRecord: { byteLength: 5908, sha256: "f0ba6894e471fe70af00119fc6e30d08421cdf7df2cf62d237d8edd84b667e92" },
  privateEnvelope: { byteLength: 7087, sha256: "2dd70568cdbc0fb0cb72a33f8cb20cfc72673ac6bfcf02f86bb66eb0ef094b43" },
  logJsonl: { byteLength: 4449, sha256: "bee2ef46b57482e748c5042aa0d1b9fe76dc4b6db0daad8eb997ab05e5809762" },
} as const;

const digest = (bytes: Uint8Array) => ({ byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
const utf8 = (text: string) => new TextEncoder().encode(text);

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

let hub: LiveHub | null = null;
afterEach(() => { hub?.close(); hub = null; });

it("the stored replay, checkpoint, readable record and private input envelope match run one's goldens", async () => {
  const clock = new ManualClock();
  clock.advance(STARTED_AT);
  const pending = new Map<string, Uint8Array>(), published = new Map<string, Uint8Array>();
  const writer = (objects: Map<string, Uint8Array>) => ({
    async create(object: ReplayObject) {
      if (objects.has(object.name)) throw new ReplayCreateError(412);
      objects.set(object.name, new Uint8Array(object.body));
    },
  });
  const publicStore = writer(published);
  const logs: string[] = [];
  const handoff = createRecordHandoff({ codeVersion: CAPTURE_COMMIT, store: writer(pending), log: (line) => logs.push(line) });
  hub = new LiveHub({ clock, replayStore: publicStore, captureMatchLogs: true, recordHandoff: handoff, config: DEFAULT_LIVE_CONFIG });
  const service = createRecordService({
    inputs: { list: async () => [...pending.keys()], get: async (name) => pending.get(name) ?? null, createMarker: async () => true, markerReason: async () => null,
      delete: async (name) => { pending.delete(name); } },
    records: createOnlyRecords(publicStore),
    replays: createRecordReplayStore({ publicStore, readPublic: async (id) => published.get(`${id}.bin`) ?? null }),
    codeVersion: CAPTURE_COMMIT, now: () => clock.now(), log: (line) => logs.push(line),
  });

  let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
  hub.startMatch(1, state, { lobbyId: "synthetic-fixture-lobby", visibility: "public", rated: false });
  while (state.result === null) {
    expect(state.tick).toBeLessThan(4);
    const commands = state.tick === 0 ? [{ type: "join" as const, agentId: "synthetic-secret-agent", modelLabel: "fixture-agent", thinkingLevel: "high" as const }] : [];
    hub.appendLog(1, tickLine(state.tick, commands));
    const out = step(state, commands);
    clock.advance(100);
    hub.pushTick(1, out);
    state = out.state;
  }
  expect(stateHash(state)).toBe("18347152c163d969"); // re-pinned with the opening food's fine-row move

  // The private checkpoint is handed off at match end; nothing is public yet.
  await until(() => pending.size === 1, "the private input envelope");
  const envelope = [...pending.values()][0]!;
  const input = decodeInput(envelope);
  expect(published.size).toBe(0);
  hub.setNextStart(1, new Date(STARTED_AT + 120_000));
  await service.sweep();
  expect(published.size).toBe(0);
  clock.advance(59_999);
  expect(published.size).toBe(0);
  clock.advance(1);
  await until(() => published.has(`${GOLDEN_ID}.bin`), "the released replay");
  await service.sweep();
  expect([...published.keys()].sort()).toEqual([`${GOLDEN_ID}.bin`, `${GOLDEN_ID}.json`]);
  expect(pending.size).toBe(0);

  // Frames: both copies decompress to run one's exact framed bytes and decoded frames.
  const checkpointFramed = gunzipSync(input.binary), releasedFramed = gunzipSync(published.get(`${GOLDEN_ID}.bin`)!);
  const checkpointFrames = unpackMessages(checkpointFramed).map(decodeMessage);
  const releasedFrames = unpackMessages(releasedFramed).map(decodeMessage);
  expect(checkpointFrames[0]!.full!.match).toBe(GOLDEN_IDENTITY);
  expect(releasedFrames[0]!.full!.match).toBe(GOLDEN_IDENTITY);
  expect(digest(checkpointFramed)).toEqual(GOLDEN.checkpointFramed);
  expect(digest(releasedFramed)).toEqual(GOLDEN.releasedFramed);
  expect(digest(utf8(JSON.stringify(checkpointFrames)))).toEqual(GOLDEN.checkpointDecoded);
  expect(digest(utf8(JSON.stringify(releasedFrames)))).toEqual(GOLDEN.releasedDecoded);

  // The readable record the record service wrote is run one's, byte for byte.
  expect(digest(published.get(`${GOLDEN_ID}.json`)!)).toEqual(GOLDEN.readableRecord);

  // The private input envelope: run one's header, and a checkpoint that repacks to run one's envelope.
  expect({ ...input, binary: undefined, logLines: undefined }).toEqual({ id: GOLDEN_ID, codeVersion: CAPTURE_COMMIT, endedAt: STARTED_AT + 400,
    lobbyId: null, publishAfter: STARTED_AT + 60_400, rated: false, binary: undefined, logLines: undefined });
  expect(digest(utf8(`${input.logLines.join("\n")}\n`))).toEqual(GOLDEN.logJsonl);
  const headerBytes = 4 + new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).getUint32(0);
  const repacked = await gzipMessages(unpackMessages(checkpointFramed));
  const canonical = new Uint8Array(headerBytes + repacked.byteLength);
  canonical.set(envelope.subarray(0, headerBytes));
  canonical.set(repacked, headerBytes);
  expect(digest(canonical)).toEqual(GOLDEN.privateEnvelope);
  expect(logs).toEqual([]);
});
