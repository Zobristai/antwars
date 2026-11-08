import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, THINKING_LEVEL_STREAM_VERSION, type StreamEvent } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";

import { playable } from "../playable.ts";
const level = "🧠".repeat(32);

describe("seat thinking-level stream metadata", () => {
  it("round-trips mixed join deltas, reconnect snapshots and a mid-match recorder without losing Unicode", () => {
    const initial = createMatch(17, playable({ ...HISTORICAL_CONFIG, matchTicks: 4 }));
    const recorder = new SpectatorRecorder(initial);
    const opening = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const spectator = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const out = step(initial, [
      { type: "join", agentId: "high", modelLabel: "same", thinkingLevel: level },
      { type: "join", agentId: "low", modelLabel: "same", thinkingLevel: "low" },
      { type: "join", agentId: "omitted", modelLabel: "same" },
    ]);
    const encoded = encodeMessage({ ...recorder.record(out), full: null });
    expect(encoded[2]).toBe(THINKING_LEVEL_STREAM_VERSION);
    const message = decodeMessage(encoded);
    const joins = message.events.filter((event): event is Extract<StreamEvent, { kind: "join" }> => event.kind === "join");
    expect(joins.map(event => event.thinkingLevel ?? null)).toEqual([level, "low", null]);
    spectator.apply(message);
    const reconnect = encodeMessage(spectator.message());
    expect(reconnect[2]).toBe(THINKING_LEVEL_STREAM_VERSION);
    expect(decodeMessage(reconnect).full!.agents.map(agent => agent.thinkingLevel ?? null)).toEqual([level, "low", null]);
    const midRecorder = new SpectatorRecorder(out.state);
    const midMatch = { ...midRecorder.initial(), full: midRecorder.initialFull() };
    expect(decodeMessage(encodeMessage(midMatch)).full!.agents.map(agent => agent.thinkingLevel ?? null)).toEqual([level, "low", null]);
  });

  it("preserves house activity clocks and rated identity alongside thinking levels", () => {
    const initial = createMatch(17, playable(HISTORICAL_CONFIG));
    const out = step(initial, [{ type: "join", agentId: "house", modelLabel: "same", thinkingLevel: "max" }]);
    const recorder = new SpectatorRecorder(out.state);
    const full = recorder.initialFull();
    full.setup = { ...full.setup, rated: true, houseIdleTicks: 1800 };
    full.agents[0]!.lastHouseCallTick = 7;
    full.agents[0]!.identity = { displayName: "House model", elo: 1500 };
    const events: StreamEvent[] = [
      { kind: "join", agent: 1, colony: 1, modelLabel: "same", thinkingLevel: "low", identity: { displayName: "Opponent", elo: 1600 } },
      { kind: "call", agent: 0, call: "observe", accepted: true, houseActivityTick: 8 },
    ];
    const decoded = decodeMessage(encodeMessage({ ...recorder.initial(), full, events }));
    expect(decoded.full!.setup).toMatchObject({ rated: true, houseIdleTicks: 1800 });
    expect(decoded.full!.agents[0]).toMatchObject({ thinkingLevel: "max", lastHouseCallTick: 7, identity: { displayName: "House model", elo: 1500 } });
    expect(decoded.events).toEqual(events);
  });

  it("does not upgrade messages without a level or invent metadata in historical bytes", () => {
    const initial = createMatch(17, playable(HISTORICAL_CONFIG));
    const recorder = new SpectatorRecorder(initial);
    const out = step(initial, [{ type: "join", agentId: "old", modelLabel: "same" }]);
    const encoded = encodeMessage({ ...recorder.record(out), full: null });
    expect(encoded[2]).toBeLessThan(THINKING_LEVEL_STREAM_VERSION);
    expect(decodeMessage(encoded).events.find(event => event.kind === "join")).not.toHaveProperty("thinkingLevel");
    // The recording's version-4 setup no longer decodes; its delta messages still do.
    const historical = unpackMessages(readFileSync(new URL("fixtures/historical-v4.bin", import.meta.url))).slice(1).map(decodeMessage);
    for (const message of historical) {
      for (const agent of message.full?.agents ?? []) expect(agent).not.toHaveProperty("thinkingLevel");
      for (const event of message.events.filter(event => event.kind === "join")) expect(event).not.toHaveProperty("thinkingLevel");
    }
  });
});
