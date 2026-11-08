import { describe, expect, it } from "vitest";
import { GRID_SCALE_STREAM_VERSION, decodeMessage, encodeMessage, encodePublicMessage, encodeReplayMessage, type StreamMessage } from "../../src/live/format.js";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { MAPS, rulesConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";

import { playable } from "../playable.ts";
describe.each(MAPS)("$name streamed rocks", map => {
  it("preserves exact geometry/appearance, redaction and optional qualifying leads without exposing the seed", () => {
    const base = rulesConfig("redesign"), state = createMatch(7001, playable({ ...base, terrain: { ...base.terrain!, mapId: map.id }, players: 2 }));
    const recorder = new SpectatorRecorder(state);
    const setup = recorder.initialFull().setup;
    expect(setup.terrain!.rocks).toEqual(state.terrain!.rocks!.map(r => [r.x, r.y, r.width, r.height, r.appearance]));
    for (const lead of [undefined, { colony: 0 as const, startTick: 6000, winTick: 8999 }]) {
      const message: StreamMessage = { ...recorder.initial(), full: { ...recorder.initialFull(), ...(lead ? { territoryWin: lead } : {}) } };
      const original = structuredClone(message);
      for (const encode of [encodeMessage, encodePublicMessage, encodeReplayMessage]) {
        const bytes = encode(message), decoded = decodeMessage(bytes);
        expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
        expect(decoded.full!.setup.terrain).toEqual(setup.terrain);
        expect(decoded.full!.territoryWin).toEqual(lead);
        expect(decoded.full!.queens).toEqual(message.full!.queens);
        if (encode !== encodeMessage) {
          for (const key of ["seed", "rules", "players"]) expect(decoded.full!.setup).not.toHaveProperty(key);
        } else expect(decoded.full!.setup).toMatchObject({ seed: 7001, rules: "redesign", players: 2 });
        expect(message).toEqual(original);
      }
    }
    const { rocks: _rocks, ...waterOnly } = setup.terrain!;
    const legacy: StreamMessage = { ...recorder.initial(), full: { ...recorder.initialFull(), setup: { ...setup, terrain: waterOnly } } };
    expect(encodeMessage(legacy)[2]).toBe(GRID_SCALE_STREAM_VERSION);
    expect(decodeMessage(encodeMessage(legacy)).full!.setup.terrain).not.toHaveProperty("rocks");
  });

  it("keeps rocks through deltas and reconnect, including count metadata and idle clocks", () => {
    const base = rulesConfig("redesign");
    let state = createMatch(7002, playable({ ...base, terrain: { ...base.terrain!, mapId: map.id } }));
    const recorder = new SpectatorRecorder(state);
    const opening = decodeMessage(encodePublicMessage({ ...recorder.initial(), full: recorder.initialFull() }));
    const viewer = new SpectatorState(opening.full!, opening.tick, opening.ants);
    for (let i = 0; i < 5; i++) {
      const out = step(state); viewer.apply(decodeMessage(encodePublicMessage({ ...recorder.record(out), full: null }))); state = out.state;
    }
    const message = viewer.message();
    message.full!.marks = [{ id: 1, agent: 0, colony: 0, tileX: 8, tileY: 24, words: [], laidTick: 0,
      answered: 1, verb: "GATHER", count: 2, claimed: 1, revision: 0 }];
    const reconnect = decodeMessage(encodePublicMessage(message));
    expect(reconnect.tick).toBe(5);
    expect(reconnect.full!.setup.terrain).toEqual(opening.full!.setup.terrain);
    expect(reconnect.full!.setup.commandIdleTicks).toBe(base.commandIdleTicks);
    expect(reconnect.full!.marks).toEqual(message.full!.marks);
  });
});
