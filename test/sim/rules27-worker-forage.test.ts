import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { buildGrid, tileIndex } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import type { Ant, ColonyId, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// No worker patch dispatch. Baseline: stable patch dispatch and shared food memory
// (houseBot.ts:580-586, view.ts:182-194, forage.ts:64-118 at 1ef77182; unchanged at a128f4d).
const redesign = rulesConfig("redesign");
// The live redesign recipe with an empty scene and no worker home guard, so dispatch is observed on its own.
const rules27: SimConfig = {
  ...redesign, foodLayout: undefined, terrain: undefined, squadSize: 0, hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  localAnts: { ...redesign.localAnts!, workerHomeGuardCount: 0, workerHomeGuardSharePermille: 0 },
};

/** An empty map with one active seat on `colony` and no food anywhere or in either colony's memory. */
function seated(config: SimConfig, colony: ColonyId = 0): SimState {
  const state = emptyMatch(0, config);
  state.food.fill(0);
  for (const c of state.colonies) c.seenFood = [];
  state.agents.push({ id: "seat", colony, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
  return state;
}

/** Put food on tiles; `known` tiles also enter the colony's memory (kept sorted, as recordSeenFood keeps it). */
function stock(state: SimState, colony: ColonyId, tiles: readonly (readonly [number, number])[], known = true): number[] {
  const indices = tiles.map(([x, y]) => tileIndex(state.config, x, y));
  for (const index of indices) state.food[index] = 3;
  if (known) state.colonies[colony].seenFood = [...new Set([...state.colonies[colony].seenFood!, ...indices])].sort((a, b) => a - b);
  return indices;
}

function plan(state: SimState, ant: Ant) {
  return localDirection(state, buildGrid(state), ant, localSoldierAssignments(state));
}

// Colony 0's dispatch patches: every template patch off the nest row (houseBot.ts dispatchedWorkerDirection).
// emptyMatch plays at grid scale 2, where a reference cell's food lives in fine cell (2tx, 2ty).
const PATCH_CENTRES = redesign.foodPatches.filter((p) => p.tileY !== redesign.nestTileY).map((p) => [2 * p.tileX, 2 * p.tileY] as const);

describe("rules 27: no worker patch dispatch (patch-dispatch part)", () => {
  /** Twelve free workers on one tile; known food 4 tiles east, and known food at every template patch centre. */
  function scene(config: SimConfig) {
    const state = seated(config);
    const [near] = stock(state, 0, [[20, 24]]);
    const patchFood = stock(state, 0, PATCH_CENTRES);
    const workers = Array.from({ length: 12 }, () => addAnt(state, 0, 16, 24, { caste: "worker" }));
    return { state, near: near!, patchFood, workers };
  }


  it("rules 27: no free seated worker is kept on a template patch; all forage the closest known food", () => {
    const { state, near, workers } = scene(rules27);
    expect(localRulesSide(state, 0)).toBe(true);
    const plans = workers.map((ant) => plan(state, ant));
    for (const ant of workers) expect(ant.foodTarget).toBe(near);
    // Same tile, same memory: every worker plans the same move, whatever its id-selected patch.
    for (const next of plans) expect(next).toEqual(plans[0]);
    expect(plans[0]!.foraging).toBe(true);
    expect(plans[0]!.dir.x).toBeGreaterThan(0);
    expect(plans[0]!.dir.y).toBe(0);
  });

  it("rules 27: workers on the edge of a template patch take closer known food outside it", () => {
    const state = seated(rules27);
    const [patchTile] = stock(state, 0, [[18, 9]]); // centre of the (18, 9) radius-2 patch
    const [closer] = stock(state, 0, [[18, 12]]); // outside that patch, one tile from the workers
    const workers = Array.from({ length: 12 }, () => addAnt(state, 0, 18, 11, { caste: "worker" }));
    for (const ant of workers) {
      plan(state, ant);
      expect(ant.foodTarget).toBe(closer);
      expect(ant.foodTarget).not.toBe(patchTile);
    }
  });
});

describe("rules 27: closest known food, colony food memory as captured (part)", () => {
  it("chooses the closest food in colony memory, not closer food the colony has not recorded", () => {
    const state = seated(rules27);
    const [unrecorded] = stock(state, 0, [[17, 24]], false);
    const [closest, farther] = stock(state, 0, [[16, 28], [24, 24]]);
    const ant = addAnt(state, 0, 16, 24, { caste: "worker" });
    expect(plan(state, ant).foraging).toBe(true);
    expect(ant.foodTarget).toBe(closest);
    expect(ant.foodTarget).not.toBe(unrecorded);
    expect(ant.foodTarget).not.toBe(farther);
  });

  it("keeps a valid current target, and reselects the closest known food once it is depleted or forgotten", () => {
    const state = seated(rules27);
    const [closest, farther] = stock(state, 0, [[18, 24], [24, 24]]);
    const ant = addAnt(state, 0, 16, 24, { caste: "worker", foodTarget: farther! });
    plan(state, ant);
    expect(ant.foodTarget).toBe(farther); // valid target retained, not recomputed every tick

    const depleted = addAnt(state, 0, 16, 24, { caste: "worker", foodTarget: farther! });
    state.food[farther!] = 0; // depleted but still remembered (no hold record on this ant)
    plan(state, depleted);
    expect(depleted.foodTarget).toBe(closest);

    state.food[farther!] = 3;
    state.colonies[0].seenFood = [closest!];
    const forgotten = addAnt(state, 0, 16, 24, { caste: "worker", foodTarget: farther! });
    plan(state, forgotten); // a target that left colony memory is dropped
    expect(forgotten.foodTarget).toBe(closest);
  });

  it("breaks equal-distance ties by row then colony-relative x for the far colony (mirrored)", () => {
    const state = seated(rules27, 1);
    const [west, east] = stock(state, 1, [[44, 24], [50, 24]]);
    const ant = addAnt(state, 1, 47, 24, { caste: "worker" });
    plan(state, ant);
    expect(ant.foodTarget).toBe(east); // colony 1's x runs from its own (east) edge
    expect(ant.foodTarget).not.toBe(west);
  });

  it("a step adds seen food, drops seen-empty tiles, retains unseen entries and keeps memory sorted", () => {
      const state = seated(rules27);
      addAnt(state, 0, 16, 24, { caste: "worker" });
      const [unseen] = stock(state, 0, [[50, 40]]);
      const seenEmpty = tileIndex(state.config, 18, 24);
      state.colonies[0].seenFood = [seenEmpty, unseen!].sort((a, b) => a - b);
      const [seenStocked] = stock(state, 0, [[17, 27]], false);
      const next = step(state).state;
      expect(next.colonies[0].seenFood).toEqual([seenStocked!, unseen!].sort((a, b) => a - b));
      expect(next.colonies[1].seenFood).toEqual([]);
    });
});
