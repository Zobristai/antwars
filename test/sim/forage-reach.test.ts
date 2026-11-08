import { describe, expect, it } from "vitest";
import { rulesConfig, speedPerTick, SUB, type SimConfig } from "../../src/sim/config.js";
import { foodTiles, forageDirection, pickupAndDeliver } from "../../src/sim/forage.js";
import { tileCentre, velocity, ZERO } from "../../src/sim/geometry.js";
import { newMatchConfig, resourceCellIndex } from "../../src/sim/gridScale.js";
import { createMatch, newAnt } from "../../src/sim/map.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { threeMapRotation } from "./three-map-rotation.js";

// Main bf26506, seed 6007, both colonies seated. Ant 47 stops 0.54 tile
// from food tile (56,20), across the resource-cell edge, and freezes from tick 1467.
const NEW_RULES = threeMapRotation(newMatchConfig(rulesConfig("redesign")));
const { forageReachArrival: _flag, ...recordedRules } = NEW_RULES;
// Pin the bf26506 movement: the guardSettle, the restPass and the
// workerGuardSettle postdate the recorded freeze and change the seated match, so they
// are stripped here too.
const { guardSettle: _settle, restPass: _rest, ...recordedSeparation } = NEW_RULES.softSeparation!;
const { workerGuardSettle: _workerSettle, ...recordedLocalAnts } = NEW_RULES.localAnts!;
const RECORDED: SimConfig = { ...recordedRules, softSeparation: recordedSeparation, localAnts: recordedLocalAnts };
const TARGET_X = 56, TARGET_Y = 20;

const cellOf = (s: SimState, a: Ant) => resourceCellIndex(s.config, Math.floor(a.y / SUB) * s.config.mapWidth + Math.floor(a.x / SUB));
const toCentre = (a: Ant) => Math.hypot(a.x - tileCentre(TARGET_X), a.y - tileCentre(TARGET_Y));

describe("forager reach at a resource-cell edge", () => {
  it("new matches opt in; recorded configs keep the absent flag", () => {
    expect(NEW_RULES.forageReachArrival).toBe(true);
    expect(rulesConfig(undefined).forageReachArrival).toBeUndefined();
  });
});

/** One worker and one food tile, no terrain or other ants: the forage decision,
 * movement at full speed and pickup, exactly as the step applies them. */
function isolated(config: SimConfig, x: number, y: number) {
  const scene: SimConfig = { ...config, startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] };
  const state = createMatch(6007, scene);
  state.food.fill(0);
  const target = TARGET_Y * scene.mapWidth + TARGET_X;
  state.food[target] = 1;
  const worker = newAnt(scene, 1, 0, x, y, "worker");
  state.ants = [worker];
  const tick = () => {
    const dir = forageDirection(state, worker, foodTiles(state));
    const v = velocity(dir, speedPerTick(scene));
    worker.x += v.x; worker.y += v.y;
    pickupAndDeliver(state, new Set([worker.id]));
    return dir;
  };
  return { state, worker, target, tick };
}

describe.each([
  ["the recorded stop point", 56338, 19989, true],
  ["straight above the edge", tileCentre(TARGET_X), tileCentre(TARGET_Y) - 590, true],
  ["diagonally across the cell corner", 55990, 19990, false],
  ["from several tiles away", 52700, 17300, false],
] as const)("isolated approach from %s", (_name, x, y, recordedFreezes) => {
  it(`without the flag the recorded rules ${recordedFreezes ? "freeze outside the cell" : "already reach it"}`, () => {
    const { worker, tick } = isolated(RECORDED, x, y);
    for (let i = 0; i < 40 && !worker.carrying; i++) tick();
    expect(worker.carrying).toBe(!recordedFreezes);
  });

  it("with the flag it closes on the centre every tick, stops once inside the cell and picks up", () => {
    const { state, worker, target, tick } = isolated(NEW_RULES, x, y);
    let previous = toCentre(worker);
    for (let i = 0; i < 40 && !worker.carrying; i++) {
      const dir = tick();
      expect(dir).not.toEqual(ZERO);
      const distance = toCentre(worker);
      // No overshoot past the centre and no back-and-forth: strictly closer each tick.
      expect(distance).toBeLessThan(previous);
      previous = distance;
      // Inside the food cell is pickup on the same tick, never a stand-off.
      if (cellOf(state, worker) === resourceCellIndex(state.config, target)) expect(worker.carrying).toBe(true);
    }
    expect(worker.carrying).toBe(true);
    expect(state.food[target]).toBe(0);
    expect(cellOf(state, worker)).toBe(resourceCellIndex(state.config, target));
    expect(toCentre(worker)).toBeLessThan(SUB);
  });
});
