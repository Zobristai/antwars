/// <reference types="node" />
/**
 * Late-match save within 19.9 s: a late match's recording copies run to hundreds of megabytes, so a
 * handover save takes each copy as the full blocks the server already holds it in, copying only its output since the
 * last of them into one more (at most one block); the resuming server carries those blocks on, and the finished match's replay and
 * private checkpoint are the same bytes an uninterrupted recording produces.
 */
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { decodeInput } from "../../src/records/inputs.ts";
import { GZIP_BLOCK_BYTES } from "../../src/replays/pack.ts";
import { recordingPart, ReplayRecording, replayId, type RecordingSaveMeta } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.ts";

/** Create-only replay and record-input objects, and the handoff writing inputs to them. */
function storage() {
  const published = new Map<string, Uint8Array>(), inputs = new Map<string, Uint8Array>();
  const createOnly = (objects: Map<string, Uint8Array>): ReplayStore => ({ async create(object) {
    if (objects.has(object.name)) throw new ReplayCreateError(412);
    objects.set(object.name, object.body);
  } });
  return { published, inputs, replayStore: createOnly(published), handoff: createRecordHandoff({ codeVersion: "a".repeat(40), store: createOnly(inputs) }) };
}

/** Incompressible delta frames (byte 3's low bit clear, so each is held as it is), enough for several blocks per copy. */
function frames(count: number, bytes: number): Uint8Array[] {
  return Array.from({ length: count }, () => {
    const frame = randomBytes(bytes);
    frame[3] = frame[3]! & 0xfe;
    return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  });
}

function record(recording: ReplayRecording, played: readonly Uint8Array[], from: number): void {
  played.forEach((frame, i) => {
    recording.appendLog(JSON.stringify({ tick: from + i }));
    recording.capture(frame);
    recording.append(frame);
  });
}

async function finished(recording: ReplayRecording, target: ReturnType<typeof storage>, endedAt: number) {
  recording.ended(endedAt, { publishAfter: endedAt, rated: true });
  expect(await recording.finish()).toBe(true);
  await expect.poll(() => target.inputs.size).toBe(1);
  return { replay: gunzipSync([...target.published.values()][0]!), input: decodeInput([...target.inputs.values()][0]!) };
}

describe("a recording held in blocks across a handover", { timeout: 120_000 }, () => {
  it("is saved as the blocks it is held in, uncopied, and resumes to the same replay and checkpoint", async () => {
    const before = frames(160, 256 * 1024), after = frames(8, 256 * 1024);
    const reference = storage(), target = storage();
    const uninterrupted = new ReplayRecording(0, 1, reference.replayStore, undefined, { handoff: reference.handoff, logHeader: "{}" });
    const saving = new ReplayRecording(0, 1, target.replayStore, undefined, { handoff: target.handoff, logHeader: "{}" });
    record(uninterrupted, before, 0);
    record(saving, before, 0);
    // Let compression catch up, as it does between a server's ticks, so held bytes are compressed bytes.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(saving.heldBytes().released).toBeGreaterThan(2 * GZIP_BLOCK_BYTES);

    const saved = await saving.save();
    const meta = saved.meta;
    const savedBytes = { released: 0, checkpoint: 0 };
    for (const [copy, count] of [["released", meta.released], ["checkpoint", meta.checkpoint]] as const) {
      const parts = Array.from({ length: count }, (_, i) => saved.parts.get(recordingPart(copy, i))!);
      savedBytes[copy] = parts.reduce((sum, part) => sum + part.byteLength, 0);
      expect(count).toBe(Math.ceil(savedBytes[copy] / GZIP_BLOCK_BYTES));
      // Every part but the last is a whole held block itself, not a copy of one.
      for (const part of parts.slice(0, -1)) expect([part.byteLength, part.byteOffset, part.buffer.byteLength]).toEqual([GZIP_BLOCK_BYTES, 0, GZIP_BLOCK_BYTES]);
      expect(parts.at(-1)!.byteLength).toBeLessThanOrEqual(GZIP_BLOCK_BYTES);
    }

    // Across servers the meta travels as JSON, the parts as stored bytes.
    const resumed = new ReplayRecording(0, 2, target.replayStore, undefined, { handoff: target.handoff,
      resume: { meta: JSON.parse(JSON.stringify(meta)) as RecordingSaveMeta, parts: new Map([...saved.parts].map(([name, bytes]) => [name, bytes.slice()])) } });
    expect(resumed.heldBytes()).toEqual(savedBytes);
    record(uninterrupted, after, before.length);
    record(resumed, after, before.length);
    const [expected, actual] = await Promise.all([finished(uninterrupted, reference, 99), finished(resumed, target, 99)]);
    expect(actual.replay.equals(expected.replay)).toBe(true);
    expect(gunzipSync(actual.input.binary).equals(gunzipSync(expected.input.binary))).toBe(true);
    expect(actual.input.logLines).toEqual(expected.input.logLines);
  });

  it("refuses a save whose held copies are not whole part counts", () => {
    const meta = { id: replayId(0, 1), endedAt: null, checkpointed: false, captureFailed: false, released: 0, checkpoint: 0, log: false };
    const resume = (saved: unknown) => () => new ReplayRecording(0, 2, storage().replayStore, undefined, { resume: { meta: saved, parts: new Map() } });
    expect(resume({ ...meta, released: true })).toThrow("invalid recording save");
    expect(resume({ ...meta, checkpoint: -1 })).toThrow("invalid recording save");
    expect(resume({ ...meta, released: 1.5 })).toThrow("invalid recording save");
  });
});
