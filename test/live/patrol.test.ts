import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, STREAM_COUNT_VERBS, type StreamMark, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { COUNT_VERBS } from "../../src/sim/types.ts";

import { playable } from "../playable.ts";
function delta(verb: StreamMark["verb"]): StreamMessage {
  const recorder = new SpectatorRecorder(createMatch(42, playable(rulesConfig("redesign"))));
  return { tick: 1, ants: recorder.initial().ants, full: null, events: [{ kind: "mark", mark: {
    id: 1, agent: 0, colony: 0, tileX: 20, tileY: 20, words: [], laidTick: 0, answered: 0, verb,
  } }] };
}

describe("append-only patrol wire verb", () => {
  it("writes index 4, preserving every legacy index and all other bytes", () => {
    for (const [index, verb] of [...COUNT_VERBS, "PATROL" as const].entries()) {
      const bytes = encodeMessage(delta(verb));
      expect(bytes.at(-1)).toBe(index);
      expect(bytes.slice(0, -1)).toEqual(encodeMessage(delta("DEFEND")).slice(0, -1));
      expect(decodeMessage(bytes).events).toEqual(delta(verb).events);
    }
    expect(STREAM_COUNT_VERBS.slice(0, 4)).toEqual(COUNT_VERBS);
  });

  it("carries a real patrol mark through a full snapshot and spectator state", () => {
    const state = createMatch(42, playable(rulesConfig("redesign")));
    state.marks.push({ id: state.nextMarkId++, agentId: "fixture", colony: 0, tileX: 20, tileY: 20,
      words: [], laidTick: 0, steering: 0, verb: "PATROL", count: 4, revision: 0 });
    const recorder = new SpectatorRecorder(state);
    const message = { ...recorder.initial(), full: recorder.initialFull() };
    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded.full!.marks[0]).toMatchObject({ verb: "PATROL", count: 4 });
    const board = new SpectatorState(decoded.full!, decoded.tick, decoded.ants);
    expect(board.full.marks[0]).toMatchObject({ verb: "PATROL", count: 4 });
  });

});
