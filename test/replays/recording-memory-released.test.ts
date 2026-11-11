// The released-replay copy is held compressed as its frames arrive.
// Scenario: the captured recording golden (captured at 8327b0816a43e559876262682c6320ec7f0f5527): seed 6006, redesign rules (27), four ticks, one join at tick 0.
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIVE_CONFIG } from "../../src/live/config.ts";
import { encodeMessage } from "../../src/live/format.ts";
import { LiveHub } from "../../src/live/hub.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { createRecordHandoff } from "../../src/records/handoff.ts";
import { GzipFrames } from "../../src/replays/pack.ts";
import { ReplayRecording } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayStore } from "../../src/replays/store.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { stateHash, tickLine } from "../../src/sim/log.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { ManualClock } from "../live/helpers.ts";
import { playable } from "../playable.ts";

// The released framed length depends on the random MatchStream identity's encoded size, so it is pinned to
// run one's identity, as recording-goldens.test.ts does.
const { GOLDEN_IDENTITY } = vi.hoisted(() => ({ GOLDEN_IDENTITY: 194180557898392 }));

// Only the MatchStream identity draw, randomInt(1, 2 ** 48) in src/live/hub.ts, is pinned; every other call is real.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomInt = (...args: unknown[]): unknown =>
    args.length === 2 && args[0] === 1 && args[1] === 2 ** 48 ? GOLDEN_IDENTITY : (actual.randomInt as (...a: unknown[]) => unknown)(...args);
  return { ...actual, randomInt };
});

/** The captured golden's run one: released framed bytes after gunzip, length prefixes included. */
const GOLDEN_RELEASED_FRAMED_BYTES = 16_511;
/** Bound: the rules-26 golden's raw frame bytes. Stricter than the rules-27 capture's 16,491. */
const RAW_FRAME_BYTES_BOUND = 16_473;

afterEach(() => { vi.restoreAllMocks(); });

function writer(objects: Map<string, Uint8Array>): ReplayStore {
  return { async create(object) {
    if (objects.has(object.name)) throw new ReplayCreateError(412);
    objects.set(object.name, new Uint8Array(object.body));
  } };
}

/** Every compressed copy pushed so far reflects its frames, so heldBytes counts compressed output only. */
async function settleAll(copies: readonly unknown[]): Promise<void> {
  await Promise.all(copies.map(copy => (copy as GzipFrames).settled()));
}

it("holds the captured scenario's released copy compressed, below its golden raw frame bytes at every point while the match runs", async () => {
  const append = vi.spyOn(ReplayRecording.prototype, "append");
  const push = vi.spyOn(GzipFrames.prototype, "push");
  const clock = new ManualClock();
  clock.advance(Date.parse("2026-01-01T00:00:00.000Z"));
  const startedAt = clock.now(), published = new Map<string, Uint8Array>(), pending = new Map<string, Uint8Array>();
  const hub = new LiveHub({ clock, replayStore: writer(published), captureMatchLogs: true, config: DEFAULT_LIVE_CONFIG,
    recordHandoff: createRecordHandoff({ codeVersion: "8327b0816a43e559876262682c6320ec7f0f5527", store: writer(pending), log: () => {} }) });
  const live: number[] = [];
  try {
    let state = createMatch(6006, playable({ ...rulesConfig("redesign"), matchTicks: 4 }));
    hub.startMatch(1, state, { lobbyId: "synthetic-fixture-lobby", visibility: "public", rated: false });
    while (state.result === null) {
      const commands = state.tick === 0 ? [{ type: "join" as const, agentId: "synthetic-secret-agent", modelLabel: "fixture-agent", thinkingLevel: "high" as const }] : [];
      hub.appendLog(1, tickLine(state.tick, commands));
      const out = step(state, commands);
      clock.advance(100);
      hub.pushTick(1, out);
      state = out.state;
    }
    expect(stateHash(state)).toBe("3eb15f773ded978a"); // the golden's final state, re-pinned with the opening food's fine-row move
    await vi.waitFor(() => expect(pending.size).toBe(1));
    hub.setNextStart(1, new Date(startedAt + 120_000));
    // Delayed release: check the live recording after every frame it appends, until the final release uploads it.
    while (published.size === 0) {
      const before = append.mock.calls.length;
      clock.advance(100);
      if (append.mock.calls.length === before || published.size > 0) continue;
      const recording = append.mock.contexts[0] as ReplayRecording;
      await settleAll(push.mock.contexts);
      const held = recording.heldBytes().released;
      if (held === 0) break; // the final release handed the copy to upload
      live.push(held);
    }
    await vi.waitFor(() => expect(published.size).toBe(1));
  } finally {
    hub.close();
  }

  const stored = new Uint8Array(gunzipSync([...published.values()][0]!));
  const frames = unpackMessages(stored);
  expect(stored.length).toBe(GOLDEN_RELEASED_FRAMED_BYTES);
  expect(frames.reduce((sum, frame) => sum + frame.length, 0)).toBe(GOLDEN_RELEASED_FRAMED_BYTES - 4 * frames.length);
  expect(live.length).toBeGreaterThan(0);
  for (const held of live) expect(held).toBeLessThan(RAW_FRAME_BYTES_BOUND);

  // The same released frames, appended one at a time, including the last before the upload begins.
  const payloads = append.mock.calls.map(([payload]) => payload);
  expect(payloads).toHaveLength(frames.length);
  const objects = new Map<string, Uint8Array>();
  const recording = new ReplayRecording(startedAt, 1, writer(objects));
  const points: number[] = [];
  for (const payload of payloads) {
    recording.append(payload);
    await settleAll(push.mock.contexts);
    points.push(recording.heldBytes().released);
  }
  expect(points).toHaveLength(5);
  for (const held of points) {
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(RAW_FRAME_BYTES_BOUND);
  }
  expect(recording.heldBytes().checkpoint).toBe(0);
  expect(await recording.finish()).toBe(true);
  expect(recording.heldBytes().released).toBe(0);
  expect(unpackMessages(new Uint8Array(gunzipSync([...objects.values()][0]!)))).toEqual(frames);
});

it("queues each released frame and returns before compressing it, and holds nothing once failed or discarded", async () => {
  const frame = encodeMessage({ ...new SpectatorRecorder(createMatch(6006, playable(rulesConfig("redesign")))).initial(), tick: 1, full: null, events: [] });
  const push = vi.spyOn(GzipFrames.prototype, "push");
  const recording = new ReplayRecording(0, 2, writer(new Map()));
  recording.append(frame);
  // Nothing is compressed on the caller's turn: zlib works on its pool after append returns.
  expect(recording.heldBytes().released).toBe(4 + frame.length);
  await settleAll(push.mock.contexts);
  expect(recording.heldBytes().released).toBeGreaterThan(0);
  recording.discard();
  expect(recording.heldBytes()).toEqual({ released: 0, checkpoint: 0 });

  const errors: string[] = [];
  const failed = new ReplayRecording(0, 3, writer(new Map()), error => errors.push(error));
  failed.append(frame);
  failed.append(new Uint8Array([0, 0, 0, 1]));
  expect(failed.heldBytes().released).toBe(0);
  expect(await failed.finish()).toBe(false);
  expect(errors).toHaveLength(1);
});

it("drops a copy whose compression fails, logging once and uploading nothing", async () => {
  let fail: ((error: Error) => void) | undefined;
  const original = GzipFrames.prototype.push;
  vi.spyOn(GzipFrames.prototype, "push").mockImplementation(function (this: GzipFrames, frame: Uint8Array) {
    fail = error => (this as unknown as { gzip: { destroy(error: Error): void } }).gzip.destroy(error);
    original.call(this, frame);
  });
  let attempts = 0;
  const errors: string[] = [];
  const recording = new ReplayRecording(0, 4, { create: async () => { attempts++; } }, error => errors.push(error));
  recording.append(new Uint8Array([0, 0, 0, 0]));
  fail!(new Error("zlib out of memory"));
  await vi.waitFor(() => expect(errors).toEqual(["antwar match 4 replay upload failed: zlib out of memory"]));
  expect(recording.heldBytes().released).toBe(0);
  recording.append(new Uint8Array([0, 0, 0, 0]));
  expect(await recording.finish()).toBe(false);
  expect(attempts).toBe(0);
  expect(errors).toHaveLength(1);
});
