/**
 * In a streamed or replayed rules-27 match each colony's projected hatch
 * cost and timing derive from each live queen's own brood, not the colony-wide caste storesOf read before,
 * with no new wire fields. Colonies with no registered agent, rules 26 and older, and historical states without
 * queens project exactly as before; the base formula is restated below as the oracle.
 */
import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { activeQueens } from "../../src/sim/map.ts";
import { nextCaste } from "../../src/sim/forage.ts";
import { step } from "../../src/sim/step.ts";
import type { QueenState, SimState } from "../../src/sim/types.ts";
import { decodeMessage, encodeMessage, type StreamEvent, type StreamStore } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState, storesOf } from "../../src/live/model.ts";
import { packMessages, unpackMessages } from "../../src/live/snapshot.ts";
import { playable } from "../playable.ts";

/** storesOf as captured at d332b049: the colony's nextCaste sets every queen's interval and the cost. */
function capturedStoresOf(state: SimState): [StreamStore, StreamStore] {
  const { config } = state;
  const store = (i: 0 | 1): StreamStore => {
    const soldier = config.castes !== undefined && nextCaste(state, state.colonies[i]) === "soldier";
    const interval = config.hatchIntervalTicks * (soldier ? config.hatchTiming?.soldierIntervalMultiplier ?? 1 : 1);
    return {
      food: state.colonies[i].foodStore,
      nextHatchTick: state.colonies[i].queens === undefined ? state.colonies[i].lastHatchTick + interval
        : Math.min(...activeQueens(state.colonies[i]).map((q) => q.lastHatchTick + interval), config.matchTicks),
      nextCost: soldier ? config.castes!.soldierCost : config.hatchCost,
    };
  };
  return [store(0), store(1)];
}

const MULTIPLIER = 3;
const redesign = (overrides: Partial<SimConfig> = {}): SimConfig => playable({ ...rulesConfig("redesign"), terrain: undefined,
  foodLayout: undefined, startAnts: 0, hatchIntervalTicks: 10, hatchTiming: { soldierIntervalMultiplier: MULTIPLIER }, ...overrides });

/** A match whose colony 0 has one seated agent and a second live queen; colony 1 has no agent. */
function twoQueenMatch(config: SimConfig): SimState {
  let state = createMatch(7101, config);
  state = step(state, [{ type: "join", agentId: "owner", placement: 0 }]).state;
  expect(state.agents.map((a) => a.colony)).toEqual([0]);
  for (const colony of state.colonies) {
    const first = colony.queens![0]!;
    colony.queens!.push({ ...first, id: 1, queenX: first.queenX + 500, spawnPoint: undefined });
    for (const queen of colony.queens!) queen.lastHatchTick = 0;
    colony.foodStore = 0;
  }
  return state;
}

const queens = (state: SimState, colony: 0 | 1): [QueenState, QueenState] => state.colonies[colony].queens as [QueenState, QueenState];
const wire = (recorder: SpectatorRecorder) => decodeMessage(encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));

describe("Projected hatch stores follow each queen's brood in rules 27", () => {
  it("takes the earliest live queen's ready tick and her own caste's cost, ties to the first queen", () => {
    const config = redesign();
    const { hatchCost } = config, soldierCost = config.castes!.soldierCost;
    const state = twoQueenMatch(config);
    const [first, second] = queens(state, 0);
    // The colony-wide caste says soldier on every count; neither queen's own brood does until set.
    state.agents[0]!.brood = "soldiers";
    state.colonies[0].mixedNext = "soldier";
    expect(nextCaste(state, state.colonies[0])).toBe("soldier");
    // Unset brood breeds mixed, from worker, per queen.
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 10, nextCost: hatchCost });
    // A soldier queen waits her own multiplied interval; the worker queen's earlier tick wins.
    first.brood = "soldiers";
    second.brood = "workers";
    second.lastHatchTick = 5;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 15, nextCost: hatchCost });
    second.lastHatchTick = 25;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 10 * MULTIPLIER, nextCost: soldierCost });
    // Tie at 30: the first queen in array order, as hatch visits them.
    second.lastHatchTick = 20;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 30, nextCost: soldierCost });
    first.brood = "workers";
    first.lastHatchTick = 20;
    second.brood = "soldiers";
    second.lastHatchTick = 0;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 30, nextCost: hatchCost });
    // Mixed alternates per queen: her own mixedNext, not the colony's.
    first.brood = "mixed";
    first.mixedNext = "soldier";
    first.lastHatchTick = 0;
    second.brood = undefined;
    second.lastHatchTick = 0;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 10, nextCost: hatchCost });
    second.lastHatchTick = 25;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 10 * MULTIPLIER, nextCost: soldierCost });
    // A lost queen no longer counts; the match end still caps the tick.
    first.lostTick = 1;
    expect(storesOf(state)[0]).toEqual({ food: 0, nextHatchTick: 35, nextCost: hatchCost });
    second.lostTick = 1;
    expect(storesOf(state)[0]!.nextHatchTick).toBe(config.matchTicks);
  });

  it("streams and replays the per-queen projection with the existing store fields only", () => {
    const config = redesign();
    const soldierCost = config.castes!.soldierCost;
    let state = twoQueenMatch(config);
    queens(state, 0)[0]!.brood = "soldiers";
    queens(state, 0)[1]!.brood = "soldiers";
    const recorder = new SpectatorRecorder(state);
    const opening = wire(recorder);
    expect(opening.full!.stores).toEqual(storesOf(state));
    expect(opening.full!.stores![0]).toEqual({ food: 0, nextHatchTick: 10 * MULTIPLIER, nextCost: soldierCost });
    const board = new SpectatorState(structuredClone(opening.full!), opening.tick, opening.ants);
    const bytes = [encodeMessage({ ...recorder.initial(), full: recorder.initialFull() })];
    const storeEvents: Extract<StreamEvent, { kind: "store" }>[] = [];
    const play = () => {
      const out = step(state, []);
      state = out.state;
      const rec = recorder.record(out);
      const encoded = encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events });
      bytes.push(encoded);
      const message = decodeMessage(encoded);
      board.apply(message);
      storeEvents.push(...message.events.filter((e): e is Extract<StreamEvent, { kind: "store" }> => e.kind === "store" && e.colony === 0));
    };
    play();
    // Only the second queen's brood changes: the colony's projection moves to her worker tick and cost.
    queens(state, 0)[1]!.brood = "workers";
    storeEvents.length = 0;
    play();
    const expected = storesOf(state)[0];
    expect(expected.nextHatchTick).toBe(10);
    expect(expected.nextCost).toBe(config.hatchCost);
    expect(storeEvents).toEqual([{ kind: "store", colony: 0, ...expected }]);
    expect(Object.keys(storeEvents[0]!).sort()).toEqual(["colony", "food", "kind", "nextCost", "nextHatchTick"]);
    expect(board.full.stores).toEqual(storesOf(state));
    // Replayed from the stored bytes: the same stores, from the recorded events alone.
    const [first, ...rest] = unpackMessages(packMessages(bytes)).map(decodeMessage);
    const replay = new SpectatorState(first!.full!, first!.tick, first!.ants);
    for (const message of rest) replay.apply(message);
    expect(replay.full.stores).toEqual(storesOf(state));
    expect(decodeMessage(encodeMessage(replay.message())).full!.stores).toEqual(storesOf(state));
  });

  it("a colony with no registered agent projects the colony caste exactly as captured", () => {
    const state = twoQueenMatch(redesign());
    const [first, second] = queens(state, 1);
    const before = capturedStoresOf(state)[1];
    expect(storesOf(state)[1]).toEqual(before);
    // Queen brood fields do not apply without an agent; the colony's mixed alternation does.
    first.brood = "soldiers";
    second.brood = "workers";
    second.mixedNext = "soldier";
    second.lastHatchTick = 4;
    state.colonies[1].mixedNext = "soldier";
    expect(storesOf(state)[1]).toEqual(capturedStoresOf(state)[1]);
    expect(storesOf(state)[1]).toEqual({ food: 0, nextHatchTick: 10 * MULTIPLIER, nextCost: state.config.castes!.soldierCost });
  });

});
