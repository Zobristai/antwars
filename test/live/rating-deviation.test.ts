// Each rated seat's rating deviation rides the spectator stream beside its rating as additive version 25, so the watch
// and replay screen can show "± RD" on its rating badge. Every message without one keeps its version and bytes, and
// nothing reaches a seat: a seat's game is built from the sim state, which never holds an identity.
import { describe, expect, it } from "vitest";
import {
  RATING_DEVIATION_STREAM_VERSION, SERVICE_TIER_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage, type StreamEvent, type StreamIdentity,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { buildGrid, createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { takeView } from "../../src/sim/view.ts";
import { HISTORICAL_CONFIG } from "../sim/fixtures.ts";
import { playable } from "../playable.ts";

const RD = 87.654321;
/** What the watch controller hands the recorder: the seat's identity with its rating, RD and private fields. */
const seats: Record<string, StreamIdentity & { readonly rd?: number; readonly ratedMatches?: number; readonly identityId?: string }> = {
  rated: { displayName: "kite", elo: 1540.25, rd: RD, ratedMatches: 12, identityId: "private-identity" },
  unrated: { displayName: "antwars/gpt-6-luna" },
  older: { displayName: "dove", elo: 1500 },
};

function joined(identity = (id: string) => seats[id]) {
  const initial = createMatch(17, playable({ ...HISTORICAL_CONFIG, matchTicks: 4 }));
  const recorder = new SpectatorRecorder(initial, { identity });
  const opening = decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
  const out = step(initial, [
    { type: "join", agentId: "rated", modelLabel: "openai/gpt-6.1-terra", serviceTier: "fast" },
    { type: "join", agentId: "unrated", modelLabel: "openai/gpt-6-luna" },
    { type: "join", agentId: "older", modelLabel: "" },
  ]);
  return { initial, recorder, opening, out };
}

describe("a seat's rating deviation on the spectator stream", () => {
  it("is a new version above every earlier one", () => {
    expect(RATING_DEVIATION_STREAM_VERSION).toBeGreaterThan(SERVICE_TIER_STREAM_VERSION);
  });

  it("round-trips join events, reconnect snapshots and a mid-match recorder, beside a rating only, with no private field", () => {
    const { recorder, opening, out } = joined();
    const delta = { ...recorder.record(out), full: null };
    const bytes = encodePublicMessage(delta);
    expect(bytes[2]).toBe(RATING_DEVIATION_STREAM_VERSION);
    const joins = decodeMessage(bytes).events.filter((event): event is Extract<StreamEvent, { kind: "join" }> => event.kind === "join");
    expect(joins.map(event => event.identity)).toEqual([
      { displayName: "kite", elo: 1540.25, rd: RD }, { displayName: "antwars/gpt-6-luna" }, { displayName: "dove", elo: 1500 },
    ]);
    expect(Buffer.from(bytes).includes(Buffer.from("private-identity"))).toBe(false);
    const spectator = new SpectatorState(opening.full!, opening.tick, opening.ants);
    spectator.apply(decodeMessage(bytes));
    const reconnect = encodeMessage(spectator.message());
    expect(reconnect[2]).toBe(RATING_DEVIATION_STREAM_VERSION);
    expect(decodeMessage(reconnect).full!.agents.map(agent => agent.identity)).toEqual(joins.map(event => event.identity));
    const mid = new SpectatorRecorder(out.state, { identity: id => seats[id] });
    expect(decodeMessage(encodeMessage({ ...mid.initial(), full: mid.initialFull() })).full!.agents.map(agent => agent.identity?.rd ?? null)).toEqual([RD, null, null]);
    // The rated-match count stays on the server.
    expect(JSON.stringify(decodeMessage(reconnect))).not.toContain("ratedMatches");
  });

  it("leaves every message with no RD on its earlier version, and drops an RD offered without a rating", () => {
    const plain = joined(id => {
      const { rd: _rd, ratedMatches: _count, ...rest } = seats[id] ?? { displayName: id };
      return rest;
    });
    const bytes = encodeMessage({ ...plain.recorder.record(plain.out), full: null });
    expect(bytes[2]).toBe(SERVICE_TIER_STREAM_VERSION);
    const unrated = joined(id => (id === "rated" ? { displayName: "kite", rd: RD } : seats[id]));
    const unratedBytes = encodeMessage({ ...unrated.recorder.record(unrated.out), full: null });
    expect(unratedBytes[2]).toBe(SERVICE_TIER_STREAM_VERSION);
    expect(decodeMessage(unratedBytes).events.find(event => event.kind === "join")).toMatchObject({ identity: { displayName: "kite" } });
    expect(JSON.stringify(decodeMessage(unratedBytes))).not.toContain(String(RD));
  });

  it("refuses an RD that is not a positive finite number, and one on a seat with no rating", () => {
    const { recorder, out } = joined();
    const message = { ...recorder.record(out), full: null };
    for (const rd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = structuredClone(message);
      (bad.events.find(event => event.kind === "join") as Extract<StreamEvent, { kind: "join" }>).identity = { displayName: "kite", elo: 1500, rd };
      expect(() => encodeMessage(bad)).toThrow("invalid spectator rating deviation");
    }
  });

  it("reaches no seat: the sim state and each seat's own view hold no identity, rating or RD", () => {
    const { out } = joined();
    for (const agent of out.state.agents) {
      const view = JSON.stringify(takeView(out.state, buildGrid(out.state), agent));
      for (const text of [String(RD), "1540.25", "kite", '"rd"', '"elo"', "identity"]) expect(view).not.toContain(text);
    }
    const state = JSON.stringify(out.state, (_key, value) => (ArrayBuffer.isView(value) ? undefined : value));
    for (const text of [String(RD), '"rd"', '"elo"']) expect(state).not.toContain(text);
  });
});
