// Stream version 23 carries the idle result and the idle clock outside the Model Index;
// earlier versions still decode, and the Model Index stays marked.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, HOUSE_IDLE_STREAM_VERSION, IDLE_STREAM_VERSION, LINE_MARK_STREAM_VERSION } from "../../src/live/format.ts";
import { SpectatorRecorder } from "../../src/live/model.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

const clock = { idleTicks: 3000, activityTick: () => 0 };

function opening(players: ConstructorParameters<typeof SpectatorRecorder>[1]) {
  const recorder = new SpectatorRecorder(createMatch(524, playable({ ...HISTORICAL_CONFIG, startAnts: 0 })), players);
  return { recorder, message: { ...recorder.initial(), full: recorder.initialFull() } };
}

describe("idle stream version 23", () => {
  it("keeps the Model Index clock at version 20 and marks it on decode", () => {
    const { message } = opening({ houseIdle: clock, modelIndex: true });
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(HOUSE_IDLE_STREAM_VERSION);
    expect(decodeMessage(bytes).full!.setup).toMatchObject({ houseIdleTicks: 3000, modelIndex: true });
  });

  it("selects 23 for a clock outside the Model Index, decoded without the marker", () => {
    const { message } = opening({ houseIdle: clock });
    const bytes = encodeMessage(message);
    expect(bytes[2]).toBe(IDLE_STREAM_VERSION);
    const setup = decodeMessage(bytes).full!.setup;
    expect(setup.houseIdleTicks).toBe(3000);
    expect(setup).not.toHaveProperty("modelIndex");
    // Presence 2 does not exist before version 23.
    const older = Uint8Array.from(bytes); older[2] = LINE_MARK_STREAM_VERSION;
    expect(() => decodeMessage(older)).toThrow();
  });

  it("leaves streams without a clock on their earlier version and bytes", () => {
    const { message } = opening({});
    expect(encodeMessage(message)[2]).toBeLessThan(HOUSE_IDLE_STREAM_VERSION);
  });

  it.each([[[0], { winner: 1, decidedBy: "idle" }], [[0, 1], { winner: null, decidedBy: "draw" }]] as const)(
    "round-trips an idle end for colonies %j and refuses it below 23", (colonies, expected) => {
      const { recorder } = opening({});
      const initial = createMatch(524, playable({ ...HISTORICAL_CONFIG, startAnts: 0 }));
      const out = step(initial, [], undefined, undefined, undefined, { idle: colonies });
      expect(out.state.result).toEqual({ ...expected, reason: "idle", tick: 0 });
      const record = recorder.record(out);
      const bytes = encodeMessage({ ...record, full: null });
      expect(bytes[2]).toBe(IDLE_STREAM_VERSION);
      expect(decodeMessage(bytes).events.find(event => event.kind === "end")).toMatchObject({ result: { ...expected, reason: "idle" } });
      const older = Uint8Array.from(bytes); older[2] = LINE_MARK_STREAM_VERSION;
      expect(() => decodeMessage(older)).toThrow("unknown match result");
    });
});
