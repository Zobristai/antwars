import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { buildGrid, createMatch, nearestQueen } from "../../src/sim/map.js";
import { routeToward } from "../../src/sim/navigation.js";
import { step } from "../../src/sim/step.js";
import type { ColonyId, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Under rules 27 an agent-seated colony holds no worker home
// guard; a free
// worker keeps the local basics and control boundaries.


function seat(state: SimState, colony: ColonyId): void {
  state.agents.push({ id: `seat-${colony}`, colony, joinSeq: colony, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] });
}

/** An empty scene at grid scale 2, both colonies seated, no squads, food, terrain or hatching. */
function scene(): { state: SimState; qx: number; qy: number } {
  const scaled = withGridScale(rulesConfig("redesign"));
  const state = emptyMatch(0, { ...scaled, startAnts: 0, squadSize: 0, terrain: undefined, foodLayout: undefined, foodPatches: [],
    hatchIntervalTicks: Number.MAX_SAFE_INTEGER, combatGraceTicks: 0 });
  seat(state, 0); seat(state, 1);
  const queen = nearestQueen(state.colonies[0], 0, 0)!;
  return { state, qx: Math.floor(queen.queenX / SUB), qy: Math.floor(queen.queenY / SUB) };
}

const decide = (state: SimState, id: number) => {
  const ant = state.ants.find((a) => a.id === id)!;
  return localDirection(state, buildGrid(state), ant, localSoldierAssignments(state));
};

describe("rules 27: no worker home guard in an agent-seated colony", () => {
  it("selects no worker guard for a seated colony, keeping the allocation shape", () => {
    const { state, qx, qy } = scene();
    for (let i = 0; i < 6; i++) addAnt(state, 0, qx + 2, qy + i, { caste: "worker" });
    const guards = localSoldierAssignments(state)!.workerGuards;
    expect(guards).toBeDefined();
    expect(guards!.size).toBe(0);
  });

  it("holds no worker as a guard at any tick of a seated rules-27 match", () => {
    // Every free soldier is sent to the front, which in an unseated colony would keep a standing worker guard.
    const forced = (): SimConfig => {
      const config = newMatchConfig(rulesConfig("redesign"));
      return { ...config, localAnts: { ...config.localAnts!, soldierFrontSharePermille: 1000 } };
    };
    const window = () => {
      let state = createMatch(6006, forced());
      seat(state, 0); seat(state, 1);
      let guardTicks = 0, settledWorkers = 0;
      for (let t = 0; t < 200; t++) {
        guardTicks += localSoldierAssignments(state)!.workerGuards?.size ?? 0;
        let settled: ReadonlySet<number> = new Set();
        state = step(state, [], undefined, undefined, { settledLocalGuards: (r) => { settled = r.antIds; } }, false, true).state;
        settledWorkers += state.ants.filter((a) => a.caste !== "soldier" && settled.has(a.id)).length;
      }
      expect(state.result).toBeNull();
      return { guardTicks, settledWorkers };
    };
    expect(window()).toEqual({ guardTicks: 0, settledWorkers: 0 });
  });
});

describe("rules 27: an unclaimed free seated worker's local basics", () => {
  it("delivers first when carrying, even beside an enemy near its queen", () => {
    const { state, qx, qy } = scene();
    const carrier = addAnt(state, 0, qx + 4, qy, { caste: "worker", carrying: true });
    addAnt(state, 1, qx + 5, qy, { caste: "worker" }); // adjacent, and an intruder within 6 fine tiles of the queen
    const queen = nearestQueen(state.colonies[0], carrier.x, carrier.y)!;
    const own = decide(state, carrier.id);
    expect(own.foraging).toBe(true);
    expect(own.dir).toEqual(routeToward(state, carrier, queen.queenX, queen.queenY));
    let next = state;
    for (let t = 0; t < 20 && next.ants.find((a) => a.id === carrier.id)?.carrying; t++) next = step(next, [], undefined, undefined, undefined, false, true).state;
    expect(next.ants.find((a) => a.id === carrier.id)?.carrying).toBe(false);
    expect(next.stats.delivered[0]).toBe(state.stats.delivered[0] + 1);
  });

  it("bites an enemy in reach", () => {
    const { state, qx, qy } = scene();
    const worker = addAnt(state, 0, qx + 12, qy, { caste: "worker" }); // outside the queen's defence radius
    const enemy = addAnt(state, 1, qx + 13, qy, { caste: "worker" });
    expect(decide(state, worker.id)).toEqual({ dir: { x: 0, y: 0 }, foraging: false });
    const next = step(state, [], undefined, undefined, undefined, false, true).state;
    expect(next.ants.find((a) => a.id === enemy.id)!.hp).toBeLessThan(enemy.hp);
  });

  // The radius is 3 reference tiles: 6 fine tiles at grid scale 2, the one grid scale.
  for (const [scale, inside] of [[2, 6]] as const) {
    describe(`grid scale ${scale}: chases intruders within ${inside} tiles of its own queen`, () => {
      it(`uses a ${inside}-tile radius`, () => {
        expect(scene().state.config.localAnts!.defendTiles).toBe(inside);
      });

      it("chases an intruder when both are within the radius", () => {
        const { state, qx, qy } = scene();
        const worker = addAnt(state, 0, qx + inside, qy, { caste: "worker" });
        addAnt(state, 0, qx + 4 * inside, qy + 4 * inside, { caste: "worker" });
        const intruder = addAnt(state, 1, qx, qy - inside, { caste: "worker" });
        expect(localSoldierAssignments(state)!.workerGuards!.has(worker.id)).toBe(false);
        const own = decide(state, worker.id);
        expect(own.foraging).toBe(false);
        expect(own.dir).toEqual(routeToward(state, worker, intruder.x, intruder.y));
        const next = step(state, [], undefined, undefined, undefined, false, true).state;
        const moved = next.ants.find((a) => a.id === worker.id)!;
        const gap = (a: { x: number; y: number }) => (a.x - intruder.x) ** 2 + (a.y - intruder.y) ** 2;
        expect(gap(moved)).toBeLessThan(gap(worker));
      });

      it(`does not chase from ${inside + 1} tiles out`, () => {
        const { state, qx, qy } = scene();
        const worker = addAnt(state, 0, qx + inside + 1, qy, { caste: "worker" });
        addAnt(state, 1, qx, qy - inside, { caste: "worker" });
        expect(decide(state, worker.id).foraging).toBe(true);
      });

      it(`does not chase an intruder ${inside + 1} tiles from the queen`, () => {
        const { state, qx, qy } = scene();
        const worker = addAnt(state, 0, qx + inside, qy, { caste: "worker" });
        addAnt(state, 1, qx, qy - inside - 1, { caste: "worker" });
        expect(decide(state, worker.id).foraging).toBe(true);
      });
    });
  }
});
