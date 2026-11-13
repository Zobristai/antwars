/** A tuning-map match starts at a chosen per-side count, every start ant on the board. */
import { describe, expect, it } from "vitest";
import { ROCK_RULES, SUB } from "../../src/sim/config.js";
import { createMatch, mirrorX } from "../../src/sim/map.js";
import { startBoxes } from "../../src/sim/startPlacement.js";
import { advance } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { TUNING_MAP_ID, tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { SimState } from "../../src/sim/types.js";
import { recordedHousePlan } from "../house-plan.ts";

const SEEDS = [1, 7, 6006];

/** Every colony's start ants inside its start area, on land (rocks included), and colony 1 the mirror of colony 0. */
function expectStartLayout(state: SimState, perSide: number): void {
  const { config } = state;
  expect(config.startAnts).toBe(perSide);
  expect(state.ants).toHaveLength(2 * perSide);
  expect(state.nextAntId).toBe(2 * perSide + 1);
  const boxes = startBoxes(config);
  for (const ant of state.ants) {
    const tx = Math.floor(ant.x / SUB), ty = Math.floor(ant.y / SUB), box = boxes[ant.colony];
    expect(tx >= box.x && tx < box.x + box.width && ty >= box.y && ty < box.y + box.height).toBe(true);
    expect(isBlockedTile(state.terrain, tx, ty)).toBe(false);
  }
  for (let i = 0; i < perSide; i += 1) {
    const left = state.ants[2 * i]!, right = state.ants[2 * i + 1]!;
    expect([left.colony, right.colony]).toEqual([0, 1]);
    expect([right.x, right.y]).toEqual([mirrorX(config, left.x), left.y]);
  }
}

describe("tuning map start population", () => {
  for (const perSide of [1, 1_024, 10_000]) {
    it(`starts ${perSide} ants per side inside each start area, on land, mirrored, with the seed's rock pairs`, () => {
      for (const seed of SEEDS) {
        const state = createMatch(seed, tuningMapConfig(perSide));
        expect(state.terrain?.mapId).toBe(TUNING_MAP_ID);
        expect(state.config.colonyCap).toBe(perSide);
        expectStartLayout(state, perSide);
        const rocks = state.terrain?.rocks ?? [];
        expect(rocks.length).toBeGreaterThanOrEqual(2 * ROCK_RULES.minPairs);
        expect(rocks.length).toBeLessThanOrEqual(2 * ROCK_RULES.maxPairs);
        // Deterministic: the same seed and count start the same ants.
        expect(createMatch(seed, tuningMapConfig(perSide)).ants).toEqual(state.ants);
      }
    });
  }

  it("gives each start ant its own tile, and refuses more start ants than the start area has land tiles", () => {
    const tilesHeld = (state: SimState) => new Set(state.ants.filter(ant => ant.colony === 0)
      .map(ant => Math.floor(ant.y / SUB) * state.config.mapWidth + Math.floor(ant.x / SUB))).size;
    for (const perSide of [1_024, 10_000]) expect(tilesHeld(createMatch(1, tuningMapConfig(perSide)))).toBe(perSide);
    // The back-quarter start area is 64 x 184 land tiles on the tuning board.
    expect(() => createMatch(1, { ...tuningMapConfig(10_000), startAnts: 64 * 184 + 1 })).toThrow(RangeError);
  });

  // Pinned to the house-planned config of matches recorded before the no-bot-moves rule: on a new match the first
  // tick already runs the local rules for all 20,000 ants at 10,000 per side, which takes minutes (as every later
  // seated tick already did), so this seating check keeps the house-planned first tick it was written against.
  it("seats one agent per colony on the first tick under server policy at the chosen count", () => {
    for (const perSide of [1, 1_024, 10_000]) {
      const state = createMatch(6006, recordedHousePlan(tuningMapConfig(perSide)));
      const { state: next } = advance(state, [{ type: "join", agentId: "a", colony: 0 }, { type: "join", agentId: "b", colony: 1 }],
        undefined, undefined, undefined, false, true);
      expect(next.tick).toBe(1);
      expect(next.result).toBeNull();
      expect(next.agents.map(agent => [agent.id, agent.colony, agent.joinedTick])).toEqual([["a", 0, 0], ["b", 1, 0]]);
      expect(next.ants.filter(ant => ant.colony === 0)).toHaveLength(perSide);
      expect(next.ants.filter(ant => ant.colony === 1)).toHaveLength(perSide);
    }
  }, 60_000); // 10,000 per side: one first tick takes seconds.
});
