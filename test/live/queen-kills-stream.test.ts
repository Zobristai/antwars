// Queen kills on the spectator stream (version 33): the recorder takes each colony's credited queen kills straight from
// the simulation, where the rules credit them, into the full snapshot and a cumulative event on change; the codec
// carries them for two and four colonies; older content keeps its version and bytes and carries none.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  KILLS_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION, QUEEN_KILLS_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage,
  withoutQueenBites, withoutQueenKills, type StreamEvent, type StreamMessage,
} from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { unpackMessages } from "../../src/live/snapshot.ts";
import { PUBLIC_CONFIG, rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimState } from "../../src/sim/types.ts";
import { playable } from "../playable.ts";
import { rules27Redesign } from "../rules27.ts";

/** Test-only quadrant geometry, as in kill-stream-compatibility.test.ts. */
const QUADRANTS: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants", water: [],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
const redesign = newMatchConfig(rulesConfig("redesign"));
const fourColonyConfig: SimConfig = { ...redesign, matchTicks: 300, terrain: { ...redesign.terrain!, maps: [QUADRANTS] } };
const publicConfig = (matchTicks = 300): SimConfig => playable({ ...PUBLIC_CONFIG, terrain: undefined, matchTicks });

function opening(recorder: SpectatorRecorder): StreamMessage {
  return { ...recorder.initial(), full: recorder.initialFull() };
}

/** Plays to the result with no commands; `credit` labels queen kills on chosen ticks (attribution is the sim's own tests'). */
function play(config: SimConfig, credit: (state: SimState) => void = () => {}) {
  let state = createMatch(17, config);
  const recorder = new SpectatorRecorder(state);
  const messages: StreamMessage[] = [opening(recorder)];
  while (state.result === null) {
    credit(state);
    const out = step(state, []);
    messages.push({ ...recorder.record(out), full: null });
    state = out.state;
  }
  return { state, messages };
}

function replayed(messages: readonly StreamMessage[]): SpectatorState {
  const decoded = messages.map(m => decodeMessage(encodePublicMessage(m)));
  const first = decoded[0]!;
  const model = new SpectatorState(first.full!, first.tick, first.ants);
  for (const m of decoded.slice(1)) model.apply(m);
  return model;
}

describe("recorded queen kills", () => {
  it("record zero for every colony from the opening snapshot, at version 33", () => {
    const { messages } = play(publicConfig(3));
    expect(messages[0]!.full!.queenKills).toEqual([0, 0]);
    expect(encodeMessage(messages[0]!)[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(messages.slice(1).flatMap(m => m.events).some(e => e.kind === "queenKills")).toBe(false);
    expect(replayed(messages).full.queenKills).toEqual([0, 0]);
  });

  it("match the result a time-up decides on queen kills, through the codec, zero included", () => {
    const { state, messages } = play(publicConfig(4), s => { if (s.tick === 2) s.colonies[1]!.queenKills = 1; });
    expect(state.result).toMatchObject({ winner: 1, decidedBy: "queen_kills" });
    const changes = messages.flatMap(m => m.events.filter(e => e.kind === "queenKills").map(e => [m.tick, e.totals]));
    expect(changes).toEqual([[3, [0, 1]]]);
    const model = replayed(messages);
    expect(model.full.result).toMatchObject({ winner: 1, decidedBy: "queen_kills" });
    expect(model.full.queenKills).toEqual(state.colonies.map(c => c.queenKills ?? 0));
    expect(model.full.queenKills).toEqual([0, 1]);
  });

  it("are not recorded where the rules credit no queen kills", () => {
    const config = playable({ ...rules27Redesign(), terrain: undefined, matchTicks: 3 });
    expect(config.queenKillsFirst).toBeUndefined();
    const { messages } = play(config);
    expect(messages[0]!.full).not.toHaveProperty("queenKills");
    expect(messages.every(m => encodeMessage(m)[2]! < QUEEN_KILLS_STREAM_VERSION)).toBe(true);
    expect(replayed(messages).full.queenKills).toBeUndefined();
  });

  it("carry on from a resumed baseline without restating it, and restate it for a stream that had none", () => {
    const config = publicConfig(300);
    const state = createMatch(17, config);
    state.colonies[0]!.queenKills = 2;
    const resume = (queenKills?: number[]) => new SpectatorRecorder(state, {}, {
      setup: opening(new SpectatorRecorder(state)).full!.setup, agents: [], initialFull: null, ants: new SpectatorRecorder(state).initial().ants,
      ...(queenKills === undefined ? {} : { queenKills }),
    });
    const kinds = (recorder: SpectatorRecorder) => recorder.record(step(state, [])).events.filter(e => e.kind === "queenKills");
    expect(kinds(resume([2, 0]))).toEqual([]);
    expect(kinds(resume())).toEqual([{ kind: "queenKills", totals: [2, 0] }]);
  });
});

describe("queen kills on the wire", () => {
  it("round-trip in a four-colony snapshot beside kill totals, and in an event", () => {
    const state = createMatch(17, fourColonyConfig);
    expect(state.colonies).toHaveLength(4);
    const recorder = new SpectatorRecorder(state);
    const first = opening(recorder);
    expect(fourColonyConfig.queenKillsFirst).toBe(true);
    expect(first.full!.queenKills).toEqual([0, 0, 0, 0]);
    first.full!.queenKills = [0, 2, 0, 1];
    const decoded = decodeMessage(encodePublicMessage(first));
    expect(decoded.full!.queenKills).toEqual([0, 2, 0, 1]);
    expect(decoded.full!.kills).toEqual(first.full!.kills);
    const delta: StreamMessage = { ...recorder.initial(), full: null, events: [{ kind: "queenKills", totals: [1, 2, 0, 1] }] };
    expect(decodeMessage(encodeMessage(delta)).events).toEqual([{ kind: "queenKills", totals: [1, 2, 0, 1] }]);
  });

  it("are stripped for a viewer that has not opted in, leaving the earlier version and every other field", () => {
    const { messages } = play(publicConfig(4), s => { if (s.tick === 2) s.colonies[0]!.queenKills = 1; });
    for (const message of messages) {
      const earlier = withoutQueenKills(message);
      expect(earlier.full ?? {}).not.toHaveProperty("queenKills");
      expect(earlier.events.some(e => e.kind === "queenKills")).toBe(false);
      expect(encodeMessage(earlier)[2]!).toBeLessThan(QUEEN_KILLS_STREAM_VERSION);
      expect(earlier.events).toEqual(message.events.filter(e => e.kind !== "queenKills"));
    }
    expect(messages[0]!.full!.queenKills).toEqual([0, 0]);
  });

  it("leave older bytes unchanged and unknown", () => {
    const { messages } = play(publicConfig(3));
    const old = encodeMessage(withoutQueenKills(messages[0]!));
    expect(old[2]).toBeLessThanOrEqual(KILLS_STREAM_VERSION);
    const decoded = decodeMessage(old);
    expect(decoded.full!.queenKills).toBeUndefined();
    expect(encodeMessage(decoded)).toEqual(old);
  });

  it.each([[[1, 2, 3]], [[-1, 0]], [[0.5, 0]], [[0x1_0000_0000, 0]]])("refuse malformed totals %j", totals => {
    const { messages } = play(publicConfig(3));
    expect(() => encodeMessage({ ...messages[0]!, full: { ...messages[0]!.full!, queenKills: totals } })).toThrow("queen kills");
    expect(() => encodeMessage({ ...messages[1]!, events: [{ kind: "queenKills", totals }] })).toThrow("queen kills");
  });

  it("refuse a snapshot whose totals do not name every colony", () => {
    const { messages } = play(publicConfig(3));
    expect(() => encodeMessage({ ...messages[0]!, full: { ...messages[0]!.full!, queenKills: [0, 0, 0, 0] } })).toThrow("one total per colony");
  });

  it("refuse a queen-kill event under a version below 33", () => {
    const { messages } = play(publicConfig(3));
    const bytes = encodeMessage({ ...messages[1]!, events: [{ kind: "queenKills", totals: [0, 1] }] });
    expect(bytes[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    // Version 32 (queen bites) holds no queen kills either.
    for (const version of [KILLS_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION]) {
      bytes[2] = version;
      expect(() => decodeMessage(bytes)).toThrow("queen kills need version 33");
    }
  });
});

describe("queen kills beside queen bites (version 32)", () => {
  type Bites = Extract<StreamEvent, { kind: "queenBites" }>;
  const cases: [string, SimConfig, number[]][] = [["two", publicConfig(3), [0, 1]], ["four", fourColonyConfig, [0, 2, 0, 1]]];

  it.each(cases)("decode together in a %s-colony change message and full message", (_colonies, config, totals) => {
    const recorder = new SpectatorRecorder(createMatch(17, config));
    const first = opening(recorder);
    const bites: Bites = { kind: "queenBites", colony: 1, queenId: 0, biters: [first.ants.id[0]!, first.ants.id[3]!], targetId: first.ants.id[1]! };
    const delta: StreamMessage = { ...recorder.initial(), full: null, events: [bites, { kind: "queenKills", totals }] };
    const bytes = encodePublicMessage(delta);
    expect(bytes[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(decodeMessage(bytes).events).toEqual(delta.events);
    const board = encodePublicMessage({ ...first, full: { ...first.full!, queenKills: totals }, events: [bites] });
    expect(board[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    const decoded = decodeMessage(board);
    expect(decoded.full!.queenKills).toEqual(totals);
    expect(decoded.full!.kills).toEqual(first.full!.kills);
    expect(decoded.events).toEqual([bites]);
    // Each alone keeps its own version: bites 32, queen kills 33.
    expect(encodeMessage(withoutQueenKills(delta))[2]).toBe(QUEEN_BITES_STREAM_VERSION);
    expect(decodeMessage(encodeMessage(withoutQueenKills(decoded))).full).not.toHaveProperty("queenKills");
    expect(encodeMessage(withoutQueenBites(delta))[2]).toBe(QUEEN_KILLS_STREAM_VERSION);
    expect(decodeMessage(encodeMessage(withoutQueenBites(decoded))).full!.queenKills).toEqual(totals);
  });

  it("leave recordings stored at version 32 decoding and re-encoding unchanged, with no queen kills", () => {
    // A four-colony opening, a bitten tick and the board at that tick, as main 900e46c54b6c1465183736398c18ba0906e4f8c4
    // wrote them (kill totals and queen bites, no queen kills), with the SHA-256 of what its decoder read from each.
    const stored = unpackMessages(Uint8Array.from(gunzipSync(readFileSync(new URL("./fixtures/queen-bites-900e46c5.bin", import.meta.url)))));
    expect(stored.map(bytes => bytes[2])).toEqual([KILLS_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION, QUEEN_BITES_STREAM_VERSION]);
    expect(stored.map(bytes => createHash("sha256").update(JSON.stringify(decodeMessage(bytes))).digest("hex"))).toEqual([
      "6c6dfcc0a9bc834789cd5a641fb1b825b06a0e2aecb9415d4fbf183f50f33088",
      "27d23845141913190f989f3535a438aadbbf0dbd47f62733a5c4ac3f611a54c5",
      "2dfbb83d57d9f8212dc73cd58f887147a198165f6d7b003fcf46cb739114cc34",
    ]);
    for (const bytes of stored) {
      const decoded = decodeMessage(bytes);
      expect(decoded.full ?? {}).not.toHaveProperty("queenKills");
      expect(Buffer.from(encodePublicMessage(decoded)).equals(Buffer.from(bytes))).toBe(true);
    }
    expect(decodeMessage(stored[2]!).events.map(e => e.kind)).toEqual(["queenBites"]);
  });
});
