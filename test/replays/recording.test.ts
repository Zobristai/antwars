import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage, encodeReplayMessage, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { ReplayRecording, replayId } from "../../src/replays/recording.ts";
import { ReplayCreateError, type ReplayObject, type ReplayStore } from "../../src/replays/store.ts";
import type { MatchInputs, RecordHandoff } from "../../src/records/handoff.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { playable } from "../playable.ts";

function opening(options: { historical?: boolean } = {}): StreamMessage {
  const config = playable(rulesConfig("redesign"));
  const r = new SpectatorRecorder(createMatch(6006, { ...config, ...(options.historical ? { terrain: undefined } : {}), players: 4 }));
  return { ...r.initial(), full: { ...r.initialFull(), match: 123456 } };
}
function withoutComparison(message: StreamMessage): StreamMessage {
  if (message.full === null) return message;
  const { rules: _r, seed: _s, players: _p, ...setup } = message.full.setup;
  return { ...message, full: { ...message.full, setup } };
}

it("uses only the UTC start time and sequence in the public id", () => {
  expect(replayId(Date.parse("2026-10-18T09:50:00.123Z"), 42)).toBe("2026-10-18T09-50-00-123Z-42");
});

it("redacts exactly three stored setup fields, without mutating live input or bytes", () => {
  const input = opening(), wire = encodeMessage(input), original = wire.slice();
  const stored = encodeReplayMessage(decodeMessage(wire));
  expect(decodeMessage(stored)).toEqual(withoutComparison(decodeMessage(wire)));
  expect(decodeMessage(wire).full!.setup).toMatchObject({ seed: 6006, rules: "redesign", players: 4 });
  expect(wire).toEqual(original);
  expect(encodeMessage(input)).toEqual(original);
  const copy = encodeReplayMessage(opening({ historical: true })); copy[3] = copy[3]! & ~2;
  // Fixed comparison slots hold zero placeholders. Version 6–9 setups that read them as seed 0 are refused now,
  // so a current setup without comparison metadata never decodes an invented seed, marker or not.
  expect(decodeMessage(copy).full!.setup).not.toHaveProperty("seed");
  expect(decodeMessage(stored).full!.setup).not.toHaveProperty("seed");
});

it("refuses a setup from before grid scales were stored, still decodes its delta messages, and never invents a zero seed", () => {
  // Archived recordings: the full setup carries no grid scale and is refused; lower-version deltas still decode.
  const [historicalSetup, ...deltas] = unpackMessages(readFileSync(new URL("../live/fixtures/historical-v4.bin", import.meta.url)));
  expect(() => decodeMessage(historicalSetup!)).toThrow("stream setup version 4 carries no grid scale: every match plays at grid scale 2");
  expect(deltas.length).toBeGreaterThan(0);
  for (const bytes of deltas) expect(() => decodeMessage(bytes)).not.toThrow();
  const message = opening({ historical: true });
  const { rules: _rules, seed: _seed, players: _players, ...setup } = message.full!.setup;
  const bytes = encodeMessage({ ...message, full: { ...message.full!, setup } });
  expect(bytes[3]).toBe(1);
  expect(decodeMessage(bytes).full!.setup).not.toHaveProperty("seed");
});

describe("optional match recorder", () => {
  it("retains comparison metadata only with the explicit comparison opt-in", async () => {
    const objects: ReplayObject[] = [];
    const r = new ReplayRecording(0, 9, { create: async (object) => { objects.push(object); } }, undefined,
      { includeComparisonSetup: true });
    const first = encodeMessage(opening());
    r.append(first);
    expect(await r.finish()).toBe(true);
    const messages = unpackMessages(new Uint8Array(gunzipSync(objects[0]!.body)));
    expect(messages).toEqual([first]);
    expect(decodeMessage(messages[0]!).full!.setup).toMatchObject({ seed: 6006, rules: "redesign", players: 4 });
  });

  it("uploads packed gzip exactly once and retains deltas byte-for-byte", async () => {
    const objects: ReplayObject[] = [];
    const store: ReplayStore = { create: async (object) => { objects.push(object); } };
    const errors: string[] = [], r = new ReplayRecording(0, 7, store, (error) => errors.push(error));
    const first = encodeMessage(opening());
    const delta = encodeMessage({ ...opening(), tick: 1, full: null, events: [] });
    r.append(first); r.append(delta);
    expect(objects).toEqual([]);
    const done = r.finish();
    expect(r.finish()).toBe(done);
    expect(await done).toBe(true);
    // Only the binary: the readable record is built by the record service, never here.
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ name: "1970-01-01T00-00-00-000Z-7.bin", contentType: "application/octet-stream", contentEncoding: "gzip", ifGenerationMatch: 0 });
    const messages = unpackMessages(new Uint8Array(gunzipSync(objects[0]!.body)));
    expect(messages.map(decodeMessage)).toEqual([withoutComparison(decodeMessage(first)), decodeMessage(delta)]);
    expect(messages[1]).toEqual(delta);
    expect(errors).toEqual([]);
    r.append(delta);
    expect(await r.finish()).toBe(true);
    expect(objects).toHaveLength(1);
  });

  it("discards interrupted matches without uploading", async () => {
    let attempts = 0;
    const r = new ReplayRecording(0, 1, { create: async () => { attempts++; } });
    r.append(encodeMessage(opening())); r.discard();
    expect(await r.finish()).toBe(false);
    expect(attempts).toBe(0);
  });

  it("isolates a recording encoding failure from the stream and logs it once", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const r = new ReplayRecording(0, 1, { create: async () => { attempts++; } }, (error) => errors.push(error));
    const invalidFull = new Uint8Array([0, 0, 0, 1]);
    expect(() => r.append(invalidFull)).not.toThrow();
    r.append(invalidFull);
    expect(await r.finish()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(attempts).toBe(0);
  });

  it("logs a rejected store once and resolves failure instead of rejecting into the tick loop", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const r = new ReplayRecording(0, 8, { create: async () => { attempts++; throw new Error("fake store unavailable"); } }, (e) => errors.push(e));
    r.append(encodeMessage(opening()));
    expect(await r.finish()).toBe(false);
    expect(await r.finish()).toBe(false);
    expect(attempts).toBe(1);
    expect(errors).toEqual(["antwar match 8 replay upload failed: fake store unavailable"]);
  });

  it("settles finish only after the store write and the saved-recording announcement", async () => {
    const order: string[] = [];
    let stored: (() => void) | undefined;
    const r = new ReplayRecording(0, 4, { create: () => new Promise<void>(resolve => { stored = () => { order.push("stored"); resolve(); }; }) },
      undefined, { onBinarySaved: id => order.push(`saved ${id}`) });
    r.append(encodeMessage(opening()));
    let settled = false;
    const done = r.finish().then(ok => { settled = true; order.push("settled"); return ok; });
    await vi.waitFor(() => expect(stored).toBeDefined());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    stored!();
    expect(await done).toBe(true);
    expect(order).toEqual(["stored", "saved 1970-01-01T00-00-00-000Z-4", "settled"]);
  });
});

describe("record service handoff", () => {
  function handed() {
    const submitted: MatchInputs[] = [];
    return { submitted, handoff: { submit: (inputs: MatchInputs) => { submitted.push(inputs); } } satisfies RecordHandoff };
  }

  it("hands the saved binary, captured log and observed end over once, after the binary save and live feed, and writes no JSON", async () => {
    const objects: ReplayObject[] = [], order: string[] = [];
    const { submitted, handoff } = handed();
    const r = new ReplayRecording(0, 5, { create: async object => { objects.push(object); order.push(object.name); } }, undefined, {
      logHeader: "{\"header\":1}", lobbyId: "secret", onBinarySaved: id => order.push(`saved ${id}`),
      handoff: { submit: inputs => { order.push("handoff"); handoff.submit(inputs); } },
    });
    r.append(encodeMessage(opening()));
    r.appendLog("{\"tick\":0}");
    r.ended(400);
    expect(await r.finish()).toBe(true);
    expect(await r.finish()).toBe(true);
    expect(order).toEqual(["1970-01-01T00-00-00-000Z-5.bin", "saved 1970-01-01T00-00-00-000Z-5", "handoff"]);
    expect(objects.map(object => object.name)).toEqual(["1970-01-01T00-00-00-000Z-5.bin"]);
    expect(submitted).toEqual([{ id: "1970-01-01T00-00-00-000Z-5", endedAt: 400, lobbyId: "secret",
      logLines: ["{\"header\":1}", "{\"tick\":0}"], binary: objects[0]!.body }]);
  });

  it("defaults to a public match and hands nothing off without captured logs, a saved binary or a finish", async () => {
    const pub = handed();
    const r = new ReplayRecording(0, 6, { create: async () => {} }, undefined, { logHeader: "{}", handoff: pub.handoff });
    r.append(encodeMessage(opening())); r.ended(1);
    await r.finish();
    expect(pub.submitted.map(inputs => inputs.lobbyId)).toEqual([null]);

    const none = handed(), errors: string[] = [];
    const noLogs = new ReplayRecording(0, 7, { create: async () => {} }, undefined, { handoff: none.handoff });
    noLogs.append(encodeMessage(opening())); noLogs.ended(1);
    expect(await noLogs.finish()).toBe(true);
    const failed = new ReplayRecording(0, 8, { create: async () => { throw new Error("fake store unavailable"); } }, e => errors.push(e), { logHeader: "{}", handoff: none.handoff });
    failed.append(encodeMessage(opening())); failed.ended(1);
    expect(await failed.finish()).toBe(false);
    const discarded = new ReplayRecording(0, 9, { create: async () => {} }, undefined, { logHeader: "{}", handoff: none.handoff });
    discarded.append(encodeMessage(opening())); discarded.discard();
    expect(await discarded.finish()).toBe(false);
    expect(none.submitted).toEqual([]);
    expect(errors).toEqual(["antwar match 8 replay upload failed: fake store unavailable"]);
  });

  it("logs a match that reached upload without an observed end instead of handing it off", async () => {
    const { submitted, handoff } = handed(), errors: string[] = [];
    const r = new ReplayRecording(0, 3, { create: async () => {} }, e => errors.push(e), { logHeader: "{}", handoff });
    r.append(encodeMessage(opening()));
    expect(await r.finish()).toBe(true);
    expect(submitted).toEqual([]);
    expect(errors).toEqual(["antwar match 3 record input not handed off: no observed end time"]);
  });
});

 describe("finished match private checkpoint", () => {
   it("survives immediate close during compression without publishing a binary or submitting twice", async () => {
     const inputs: MatchInputs[] = [], writes: ReplayObject[] = [];
     const r = new ReplayRecording(0, 409, { create: async object => { writes.push(object); } }, undefined,
       { logHeader: "{}", handoff: { submit: input => { inputs.push(input); } } });
     const first = encodeMessage(opening());
     r.capture(first); r.appendLog('{"tick":0}');
     r.ended(100, { publishAfter: 300_100, rated: true });
     r.ended(100, { publishAfter: 300_100, rated: true });
     r.discard();
     await vi.waitFor(() => expect(inputs).toHaveLength(1));
     expect(await r.finish()).toBe(false);
     expect(writes).toEqual([]);
     expect(inputs[0]).toMatchObject({ endedAt: 100, publishAfter: 300_100, rated: true, logLines: ["{}", '{"tick":0}'] });
     const frames = unpackMessages(new Uint8Array(gunzipSync(inputs[0]!.binary)));
     expect(decodeMessage(frames[0]!)).toEqual(withoutComparison(decodeMessage(first)));
   });

   it("a normal release losing a create race announces the already saved replay without overwriting it", async () => {
     const saved: string[] = [];
     const r = new ReplayRecording(0, 410, { create: async () => { throw new ReplayCreateError(412); } }, undefined,
       { onBinarySaved: id => { saved.push(id); } });
     r.append(encodeMessage(opening()));
     expect(await r.finish()).toBe(true);
     expect(saved).toEqual([r.id]);
   });
 });
