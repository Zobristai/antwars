import { describe, expect, it } from "vitest";
import { foundQueen } from "../../src/sim/agents.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { hatch } from "../../src/sim/forage.js";
import { activeQueens } from "../../src/sim/map.js";
import type { SimEvent, SimState } from "../../src/sim/types.js";
import { emptyMatch, setOwner } from "./fixtures.js";

// The served redesign rules (rules 28): each live queen hatches on her own clock at 2 food per second, so a worker
// (2 food) every 10 ticks and a soldier (6 food) every 30. No agent is seated, so each colony's brood is mixed.
const served: SimConfig = { ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined, foodPatches: [], startAnts: 0 };

/** Each hatch of colony 0 from tick `from` to `to` inclusive, as [tick, queen nest x, caste]. */
function hatches(state: SimState, from: number, to: number): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (let tick = from; tick <= to; tick++) {
    const events: SimEvent[] = [];
    hatch(state, tick, events);
    for (const event of events) if (event.type === "hatch" && event.colony === 0) out.push([tick, event.tileX, event.caste ?? "none"]);
  }
  return out;
}

describe("served rules: hatching at 2 food per second", () => {
  it("is rules 28 at 2 food per second", () => {
    expect(served).toMatchObject({ rules28: true, hatchRate: { foodPerSecond: 2 }, hatchCost: 2, castes: { soldierCost: 6 } });
  });

  it("hatches the starting queen's mixed brood in today's caste order: a worker at tick 0, then a soldier 30 ticks after it and a worker 10 after that", () => {
    const state = emptyMatch(0, served);
    state.colonies[0].foodStore = 1000;
    expect(hatches(state, 0, 120).map(([tick, , caste]) => [tick, caste])).toEqual([
      [0, "worker"], [30, "soldier"], [40, "worker"], [70, "soldier"], [80, "worker"], [110, "soldier"], [120, "worker"]]);
    expect(state.colonies[0].foodStore).toBe(1000 - 4 * 2 - 3 * 6);
  });

  it("waits until the store covers the next ant's cost, then hatches on the next tick it does", () => {
    const state = emptyMatch(0, served);
    state.colonies[0].foodStore = 1;
    expect(hatches(state, 0, 49)).toEqual([]);
    state.colonies[0].foodStore = 2;
    expect(hatches(state, 50, 50).map(([tick, , caste]) => [tick, caste])).toEqual([[50, "worker"]]);
    // A soldier is next: 6 food, 30 ticks after the worker.
    state.colonies[0].foodStore = 5;
    expect(hatches(state, 51, 100)).toEqual([]);
    state.colonies[0].foodStore = 6;
    expect(hatches(state, 101, 101).map(([tick, , caste]) => [tick, caste])).toEqual([[101, "soldier"]]);
  });

  it("starts a queen founded mid-match on her own clock at her founding", () => {
    const state = emptyMatch(served.queenFounding!.firstFoundTick! + 1, served);
    const rules = state.config.queenFounding!;
    const colony = state.colonies[0];
    const first = activeQueens(colony)[0]!;
    const tileX = Math.floor(first.queenX / SUB) + rules.minDistanceTiles + 1, tileY = Math.floor(first.queenY / SUB);
    setOwner(state, tileX, tileY, 0);
    for (let i = 0; i < state.owner.length; i++) if (state.owner[i] !== -1) state.lastVisit[i] = state.tick;
    colony.foodStore = 100_000;
    // The starting queen sits out this window, so every hatch below is the new queen's.
    first.lastHatchTick = state.tick + 1000;
    const founded = state.tick;
    expect(foundQueen(state, 0, tileX, tileY, founded, [])).toBeNull();
    expect(activeQueens(colony).map(q => q.foundedTick)).toEqual([0, founded]);
    // Her first ant waits one full worker interval from her founding, then the brood alternates at its own intervals.
    const nearNew = ([, x]: [number, number, string]) => Math.abs(x - tileX) < rules.minDistanceTiles;
    const seen = hatches(state, founded, founded + 45);
    expect(seen.every(nearNew)).toBe(true);
    expect(seen.map(([tick, , caste]) => [tick - founded, caste])).toEqual([[10, "worker"], [40, "soldier"]]);
  });
});
