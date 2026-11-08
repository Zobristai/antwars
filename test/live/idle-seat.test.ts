import { describe, expect, it } from "vitest";
import { GRID_SCALE_STREAM_VERSION, decodeMessage, encodeMessage, isIdle, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput } from "../../src/sim/types.ts";

import { playable } from "../playable.ts";
const roundTrip = (message: StreamMessage) => decodeMessage(encodeMessage(message));

describe("command-idle stream and existing IDLE rail helper", () => {
  it("matches simulation expiry across incremental calls, binary roundtrips and reconnect snapshots", () => {
    // This version-8 fixture predates the terrain extension.
    let state = createMatch(42, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: 5, commandFloorTicks: 1 }));
    const recorder = new SpectatorRecorder(state);
    const opening = roundTrip({ ...recorder.initial(), full: recorder.initialFull() });
    expect(encodeMessage(opening)[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(opening.full!.setup.commandIdleTicks).toBe(5);
    const board = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const script: SimInput[][] = [
      [{ type: "join", agentId: "a", placement: 0 }],
      [],
      [{ type: "observe", agentId: "a" }],
      [{ type: "rejoin", agentId: "a" }],
      [{ type: "mark", agentId: "a", words: ["INVALID"] }],
      [{ type: "observe", agentId: "a" }],
      [{ type: "rejoin", agentId: "a" }],
      [{ type: "order", agentId: "a", order: { kind: "hold" } }],
      [], [], [], [], [],
    ];
    for (const inputs of script) {
      const out = step(state, inputs);
      state = out.state;
      board.apply(roundTrip({ ...recorder.record(out), full: null }));
      const agent = board.full.agents[0]!;
      expect(isIdle(agent, board.tick, board.full.setup.idleTicks)).toBe(state.agents[0]!.idle);
      expect(agent.lastCommandTick).toBe(state.agents[0]!.lastCommandTick ?? -1);
      const reconnect = roundTrip({ tick: board.tick, ants: board.ants, full: board.full, events: [] });
      expect(reconnect.full!.agents).toEqual(board.full.agents);
      expect(isIdle(reconnect.full!.agents[0]!, reconnect.tick, reconnect.full!.setup.idleTicks)).toBe(state.agents[0]!.idle);
    }
    expect(state.agents[0]!.idle).toBe(true);
  });

  it("preserves join and accepted-command times in a recorder opened on a populated state", () => {
    let state = step(createMatch(43, playable(rulesConfig("redesign"))), [{ type: "join", agentId: "a" }]).state;
    state = step(state, [{ type: "order", agentId: "a", order: { kind: "hold" } }]).state;
    state = step(state, [{ type: "observe", agentId: "a" }]).state;
    const recorder = new SpectatorRecorder(state);
    const message = roundTrip({ ...recorder.initial(), full: recorder.initialFull() });
    expect(message.full!.agents[0]).toMatchObject({ joinTick: 0, lastCallTick: 2, lastCommandTick: 1 });
  });

  it("keeps historical call-based IDLE semantics when command timing is absent", () => {
    const recorder = new SpectatorRecorder(createMatch(44, playable({ ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined })));
    const message = { ...recorder.initial(), full: recorder.initialFull() };
    expect(encodeMessage(message)[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(roundTrip(message).full!.setup).not.toHaveProperty("commandIdleTicks");
    const agent = { colony: 0 as const, modelLabel: "", joinTick: 0, lastCallTick: 4, prevCallTick: 0, order: "hold" as const, orderX: 0, orderY: 0, intent: "" };
    expect(isIdle(agent, 9, 5)).toBe(false);
    expect(isIdle(agent, 10, 5)).toBe(true);
  });
});
