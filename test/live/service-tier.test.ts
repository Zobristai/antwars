// Each seat's self-reported join service tier rides the spectator stream as additive version 24.
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, IDLE_STREAM_VERSION, SERVICE_TIER_STREAM_VERSION, THINKING_LEVEL_STREAM_VERSION, type StreamEvent } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

const tier = "⚡".repeat(32);

describe("seat service-tier stream metadata", () => {
  it("is a new version above every earlier one", () => {
    expect(SERVICE_TIER_STREAM_VERSION).toBeGreaterThan(IDLE_STREAM_VERSION);
  });

  it("round-trips join deltas, reconnect snapshots and a mid-match recorder beside thinking levels", () => {
    const initial = createMatch(17, playable({ ...HISTORICAL_CONFIG, matchTicks: 4 }));
    const recorder = new SpectatorRecorder(initial);
    const opening = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const spectator = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const out = step(initial, [
      { type: "join", agentId: "fast", modelLabel: "same", thinkingLevel: "xhigh", serviceTier: "fast" },
      { type: "join", agentId: "unicode", modelLabel: "same", serviceTier: tier },
      { type: "join", agentId: "level-only", modelLabel: "same", thinkingLevel: "high" },
      { type: "join", agentId: "omitted", modelLabel: "same" },
    ]);
    const encoded = encodeMessage({ ...recorder.record(out), full: null });
    expect(encoded[2]).toBe(SERVICE_TIER_STREAM_VERSION);
    const message = decodeMessage(encoded);
    const joins = message.events.filter((event): event is Extract<StreamEvent, { kind: "join" }> => event.kind === "join");
    expect(joins.map(event => [event.thinkingLevel ?? null, event.serviceTier ?? null])).toEqual([["xhigh", "fast"], [null, tier], ["high", null], [null, null]]);
    spectator.apply(message);
    const reconnect = encodeMessage(spectator.message());
    expect(reconnect[2]).toBe(SERVICE_TIER_STREAM_VERSION);
    expect(decodeMessage(reconnect).full!.agents.map(agent => agent.serviceTier ?? null)).toEqual(["fast", tier, null, null]);
    const midRecorder = new SpectatorRecorder(out.state);
    const midMatch = decodeMessage(encodeMessage({ ...midRecorder.initial(), full: midRecorder.initialFull() }));
    expect(midMatch.full!.agents.map(agent => [agent.thinkingLevel ?? null, agent.serviceTier ?? null])).toEqual([["xhigh", "fast"], [null, tier], ["high", null], [null, null]]);
  });

  it("does not upgrade messages without a tier, and an older version reads no tier", () => {
    const initial = createMatch(17, playable(HISTORICAL_CONFIG));
    const recorder = new SpectatorRecorder(initial);
    const out = step(initial, [{ type: "join", agentId: "old", modelLabel: "same", thinkingLevel: "max" }]);
    const encoded = encodeMessage({ ...recorder.record(out), full: null });
    expect(encoded[2]).toBe(THINKING_LEVEL_STREAM_VERSION);
    const join = decodeMessage(encoded).events.find(event => event.kind === "join");
    expect(join).toMatchObject({ thinkingLevel: "max" });
    expect(join).not.toHaveProperty("serviceTier");
    expect(out.state.agents[0]).not.toHaveProperty("serviceTier");
  });
});
