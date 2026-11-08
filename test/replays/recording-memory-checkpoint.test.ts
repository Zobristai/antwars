// The private checkpoint copy is held compressed as its frames arrive.
// Scenario: the captured recording golden (captured at
// 8905980bde1e12861a8eae658903341647f0d64d): seed 6006, redesign rules, four ticks, one join at tick 0.
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { encodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import type { MatchInputs, RecordHandoff } from "../../src/records/handoff.ts";
import { GzipFrames } from "../../src/replays/pack.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "../live/helpers.ts";
import { playable } from "../playable.ts";

/** The golden's run one: checkpoint framed bytes 16,485, less five 4-byte length prefixes. */
const GOLDEN_CHECKPOINT_RAW_BYTES = 16_465;

afterEach(() => { vi.restoreAllMocks(); });

function writer(objects: Map<string, Uint8Array>): ReplayStore {
  return { async create(object) {
    if (objects.has(object.name)) throw new ReplayCreateError(412);
    objects.set(object.name, new Uint8Array(object.body));
  } };
}

function handed(): { submitted: MatchInputs[]; handoff: RecordHandoff } {
  const submitted: MatchInputs[] = [];
  return { submitted, handoff: { submit: inputs => { submitted.push(inputs); } } };
}

/** Every compressed copy pushed so far reflects its frames, so heldBytes counts compressed output only. */
async function settleAll(copies: readonly unknown[]): Promise<void> {
  await Promise.all(copies.map(copy => (copy as GzipFrames).settled()));
}

const frame = () => encodeMessage({ ...new SpectatorRecorder(createMatch(6006, playable(rulesConfig("redesign")))).initial(), tick: 1, full: null, events: [] });

it("holds the captured scenario's checkpoint copy compressed, below its golden raw frame bytes at every point while the match runs", async () => {
  const capture = vi.spyOn(ReplayRecording.prototype, "capture");
  const push = vi.spyOn(GzipFrames.prototype, "push");
  const clock = new ManualClock();
  clock.advance(Date.parse("2026-01-01T00:00:00.000Z"));
  const { submitted, handoff } = handed();
  const hub = new LiveHub({ clock, replayStore: writer(new Map()), captureMatchLogs: true, config: DEFAULT_LIVE_CONFIG, recordHandoff: handoff });
  const live: number[] = [];
  try {
    let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
    hub.startMatch(1, state, { lobbyId: "synthetic-fixture-lobby", visibility: "public", rated: false });
    const recording = capture.mock.contexts[0] as ReplayRecording;
    // The live checkpoint after every frame it captures, until the final tick hands it off at match end.
    for (;;) {
      await settleAll(push.mock.contexts);
      const held = recording.heldBytes().checkpoint;
      if (state.result !== null) {
        expect(held).toBe(0);
        break;
      }
      live.push(held);
      const commands = state.tick === 0 ? [{ type: "join" as const, agentId: "synthetic-secret-agent", modelLabel: "fixture-agent", thinkingLevel: "high" as const }] : [];
      hub.appendLog(1, tickLine(state.tick, commands));
      const out = step(state, commands);
      clock.advance(100);
      hub.pushTick(1, out);
      state = out.state;
    }
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
  } finally {
    hub.close();
  }

  // Frame parity with the goldens is test/replays/recording-goldens.test.ts's; here the bound is the golden's raw bytes.
  const frames = unpackMessages(new Uint8Array(gunzipSync(submitted[0]!.binary)));
  expect(frames).toHaveLength(5);
  const rawBytes = frames.reduce((sum, bytes) => sum + bytes.length, 0);
  expect(live).toHaveLength(4);
  for (const held of live) {
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(GOLDEN_CHECKPOINT_RAW_BYTES);
    expect(held).toBeLessThan(rawBytes);
  }

  // The same captured frames, one at a time, including the last before match end hands the copy off.
  const payloads = capture.mock.calls.map(([payload]) => payload);
  expect(payloads).toHaveLength(frames.length);
  const again = handed();
  const recording = new ReplayRecording(0, 1, writer(new Map()), undefined, { logHeader: "{}", handoff: again.handoff });
  const points: number[] = [];
  for (const payload of payloads) {
    recording.capture(payload);
    await settleAll(push.mock.contexts);
    points.push(recording.heldBytes().checkpoint);
  }
  expect(points).toHaveLength(5);
  for (const held of points) {
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(GOLDEN_CHECKPOINT_RAW_BYTES);
    expect(held).toBeLessThan(rawBytes);
  }
  expect(recording.heldBytes().released).toBe(0);
  recording.ended(400, { publishAfter: 60_400, rated: false });
  expect(recording.heldBytes().checkpoint).toBe(0);
  await vi.waitFor(() => expect(again.submitted).toHaveLength(1));
  expect(unpackMessages(new Uint8Array(gunzipSync(again.submitted[0]!.binary)))).toEqual(frames);
});

it("queues each captured frame and returns before compressing it, and holds no checkpoint without a log and handoff or once discarded", async () => {
  const bytes = frame();
  const push = vi.spyOn(GzipFrames.prototype, "push");
  const { handoff } = handed();
  const recording = new ReplayRecording(0, 2, writer(new Map()), undefined, { logHeader: "{}", handoff });
  recording.capture(bytes);
  // Nothing is compressed on the caller's turn: zlib works on its pool after capture returns.
  expect(recording.heldBytes().checkpoint).toBe(4 + bytes.length);
  await settleAll(push.mock.contexts);
  expect(recording.heldBytes().checkpoint).toBeGreaterThan(0);
  recording.discard();
  expect(recording.heldBytes()).toEqual({ released: 0, checkpoint: 0 });

  push.mockClear();
  for (const options of [{ logHeader: "{}" }, { handoff }, {}]) {
    const uncaptured = new ReplayRecording(0, 3, writer(new Map()), undefined, options);
    uncaptured.capture(bytes);
    expect(uncaptured.heldBytes().checkpoint).toBe(0);
  }
  expect(push).not.toHaveBeenCalled();
});

it("drops a checkpoint whose frame cannot be encoded or whose compression fails, logging once and handing nothing off", async () => {
  for (const fault of ["encoding", "compression"] as const) {
    let fail: ((error: Error) => void) | undefined;
    const original = GzipFrames.prototype.push;
    const push = vi.spyOn(GzipFrames.prototype, "push").mockImplementation(function (this: GzipFrames, frame: Uint8Array) {
      fail = error => (this as unknown as { gzip: { destroy(error: Error): void } }).gzip.destroy(error);
      original.call(this, frame);
    });
    const { submitted, handoff } = handed(), errors: string[] = [];
    const recording = new ReplayRecording(0, 4, writer(new Map()), error => errors.push(error), { logHeader: "{}", handoff });
    recording.capture(new Uint8Array([0, 0, 0, 0]));
    if (fault === "encoding") recording.capture(new Uint8Array([0, 0, 0, 1]));
    else fail!(new Error("zlib out of memory"));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/^antwar match 4 private checkpoint failed: /);
    if (fault === "compression") expect(errors[0]).toBe("antwar match 4 private checkpoint failed: zlib out of memory");
    expect(recording.capturesInputs).toBe(false);
    expect(recording.heldBytes().checkpoint).toBe(0);
    recording.capture(new Uint8Array([0, 0, 0, 0]));
    recording.ended(400, { publishAfter: 60_400, rated: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(submitted).toEqual([]);
    expect(errors).toHaveLength(1);
    push.mockRestore();
  }
});

it("reports a compression failure after match end once, from the handed-off checkpoint", async () => {
  let fail: ((error: Error) => void) | undefined;
  const original = GzipFrames.prototype.push;
  vi.spyOn(GzipFrames.prototype, "push").mockImplementation(function (this: GzipFrames, frame: Uint8Array) {
    fail = error => (this as unknown as { gzip: { destroy(error: Error): void } }).gzip.destroy(error);
    original.call(this, frame);
  });
  const { submitted, handoff } = handed(), errors: string[] = [];
  const recording = new ReplayRecording(0, 5, writer(new Map()), error => errors.push(error), { logHeader: "{}", handoff });
  recording.capture(new Uint8Array([0, 0, 0, 0]));
  recording.ended(400, { publishAfter: 60_400, rated: false });
  fail!(new Error("zlib out of memory"));
  await vi.waitFor(() => expect(errors).toEqual(["antwar match 5 private checkpoint failed: zlib out of memory"]));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(errors).toHaveLength(1);
  expect(submitted).toEqual([]);
});
