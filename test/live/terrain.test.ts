import { describe, expect, it } from "vitest";
import { GRID_SCALE_STREAM_VERSION, decodeMessage, encodeMessage, encodeReplayMessage, type StreamMessage } from "../../src/live/format.js";
import { LiveHub } from "../../src/live/hub.js";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.js";
import { playScripted, recordLog } from "../../src/live/record.js";
import { MAPS, PUBLIC_CONFIG, TERRAIN_RULES, rulesConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";

import { playable } from "../playable.ts";
describe("map stream metadata", () => {
  it.each(MAPS)("$name keeps public setup and terrain private while comparison retains setup and both retain displayed queen HP", map => {
    const config = { ...rulesConfig("redesign"), terrain: { ...TERRAIN_RULES, rocks: undefined, mapId: map.id }, players: 2 as const };
    const recorder = new SpectatorRecorder(createMatch(7001, playable(config)));
    const message: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
    const original = structuredClone(message);
    const terrain = { mapId: map.id, mapName: map.name, water: map.water.map(rect => [rect.x * 2, rect.y * 2, rect.width * 2, rect.height * 2]) };
    for (const comparison of [false, true]) {
      const hub = new LiveHub({ includeComparisonSetup: comparison });
      try {
        const bytes = hub.payload(message), full = decodeMessage(bytes).full!;
        expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
        if (comparison) expect(full.setup).toMatchObject({ rules: "redesign", seed: 7001, players: 2 });
        else for (const field of ["rules", "seed", "players"]) expect(full.setup).not.toHaveProperty(field);
        expect(full.setup.terrain).toEqual(terrain);
        for (const field of ["rules", "seed", "players", "hp", "maxHp", "queenHp"]) {
          expect(full.setup.terrain).not.toHaveProperty(field);
        }
        for (const field of ["hp", "maxHp", "queenHp"]) expect(full.setup).not.toHaveProperty(field);
        expect(full.queens).toEqual(original.full!.queens);
        expect(full.queens!.map(queen => queen.hp)).toEqual([config.queenHp!.hp, config.queenHp!.hp]);
        expect(message).toEqual(original);
      } finally { hub.close(); }
    }
  });

  it.each(MAPS)("$name composes replay redaction with terrain while leaving live metadata unchanged", map => {
    for (const base of [PUBLIC_CONFIG, { ...rulesConfig("redesign"), players: 2 as const }]) {
      const config = { ...base, terrain: { ...TERRAIN_RULES, rocks: undefined, mapId: map.id } };
      const recorder = new SpectatorRecorder(createMatch(7001, playable(config)));
      const live: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
      const originalSetup = structuredClone(live.full!.setup);
      const replayBytes = encodeReplayMessage(live), replay = decodeMessage(replayBytes).full!;
      expect(replayBytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
      expect(replay.setup.terrain).toEqual(originalSetup.terrain);
      for (const field of ["rules", "seed", "players"]) expect(replay.setup).not.toHaveProperty(field);
      expect(replay.queens).toEqual(live.full!.queens);
      expect(live.full!.setup).toEqual(originalSetup);
      expect(decodeMessage(encodeMessage(live)).full!.setup).toEqual(originalSetup);
      const delta: StreamMessage = { ...recorder.initial(), full: null };
      expect(encodeReplayMessage(delta)).toEqual(encodeMessage(delta));
    }
  });

  it.each(MAPS)("$name survives full frames, deltas and reconnect", map => {
    const config = { ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, rocks: undefined, mapId: map.id }, matchTicks: 5 };
    const { lines } = playScripted({ seed: 17, config: playable(config), agents: 2, ticks: 5 });
    const bytes = recordLog(lines);
    const [first, ...rest] = bytes.map(decodeMessage);
    expect(bytes[0]![2]).toBe(GRID_SCALE_STREAM_VERSION);
    const expected = { mapId: map.id, mapName: map.name, water: map.water.map(r => [r.x * 2, r.y * 2, r.width * 2, r.height * 2]) };
    expect(first!.full!.setup.terrain).toEqual(expected);
    expect(first!.full!.setup).not.toHaveProperty("rules");
    expect(first!.full!.setup).not.toHaveProperty("seed");
    expect(first!.full!.setup).not.toHaveProperty("players");
    const viewer = new SpectatorState(first!.full!, first!.tick, first!.ants);
    for (const delta of rest) viewer.apply(delta);
    const reconnect = decodeMessage(encodeMessage(viewer.message())).full!;
    expect(reconnect.setup.terrain).toEqual(expected);
    expect(reconnect.setup).not.toHaveProperty("rules");
    expect(reconnect.setup).not.toHaveProperty("seed");
    expect(reconnect.setup).not.toHaveProperty("players");
    expect(viewer.tick).toBe(5);
  });

  it.each(MAPS)("$name composes count marks, optional idle clocks and early-win results under terrain in a grid-scale-2 snapshot", map => {
    for (const commandIdleTicks of [undefined, 0, 600]) {
      const config = { ...rulesConfig("redesign"), terrain: { ...TERRAIN_RULES, rocks: undefined, mapId: map.id }, players: 2 as const, commandIdleTicks };
      const recorder = new SpectatorRecorder(createMatch(7001, playable(config)));
      const counted = { id: 1, agent: 0, colony: 0 as const, tileX: 20, tileY: 20, words: [],
        laidTick: 3, answered: 4, verb: "DEFEND" as const, count: 8, claimed: 0, revision: 0 };
      const markEvent = { kind: "mark" as const, mark: { ...counted, claimed: 8, revision: 300 } };
      const result = { winner: 0 as const, reason: "sustained_territory" as const,
        decidedBy: "territory" as const, tick: 7800, nextStartMs: null };
      for (const ended of [false, true]) {
        const message: StreamMessage = { ...recorder.initial(), tick: 7801,
          full: { ...recorder.initialFull(), marks: [counted], result: ended ? result : null },
          events: ended ? [markEvent, { kind: "end", result }] : [markEvent] };
        const bytes = encodeMessage(message), decoded = decodeMessage(bytes);
        expect(bytes[2]).toBe(GRID_SCALE_STREAM_VERSION);
        expect(decoded.full!.setup).toEqual(message.full!.setup);
        expect(decoded.full!.setup).toMatchObject({ rules: "redesign", seed: 7001, players: 2 });
        expect(decoded.full!.queens).toEqual(message.full!.queens);
        expect(decoded.full!.marks).toEqual(message.full!.marks);
        expect(decoded.full!.result).toEqual(message.full!.result);
        expect(decoded.events).toEqual(message.events);
        if (commandIdleTicks === undefined) expect(decoded.full!.setup).not.toHaveProperty("commandIdleTicks");
        else expect(decoded.full!.setup.commandIdleTicks).toBe(commandIdleTicks);
      }
    }
  });
});
