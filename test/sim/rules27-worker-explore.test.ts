import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { gridScaleOf, withGridScale } from "../../src/sim/gridScale.js";
import { localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { buildGrid, cloneState, nearestQueen } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// A free seated worker whose colony knows no stocked food explores outward in
// rules 27 instead of the captured idle patch patrol.
// Patch dispatch is a separate captured rule; a zero dispatch share keeps every worker
// here on the no-known-food branch whatever that rule's state.
const redesign = rulesConfig("redesign");
const base: SimConfig = { ...redesign, foodLayout: undefined, squadSize: 0, hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  localAnts: { ...redesign.localAnts!, workerPatchDispatchSharePermille: 0 } };
const configs = () => ({ rules27: withGridScale(base) });

/** A seated colony 0 with no food anywhere; one free soldier keeps today's worker home guard unselected. */
function seated(config: SimConfig, workers = 12): SimState {
  const s = emptyMatch(0, config);
  s.agents.push({ id: "agent", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
  s.food.fill(0);
  (s.foodCap as number[]).fill(0);
  // Ants stand where they hatch: on the queen's own coordinates.
  const q = s.colonies[0].queens![0]!, at = { x: q.queenX, y: q.queenY };
  addAnt(s, 0, 0, 0, { caste: "soldier", role: "fighter", ...at });
  for (let i = 0; i < workers; i++) addAnt(s, 0, 0, 0, { caste: "worker", ...at });
  return s;
}
const fromQueen = (s: SimState, ant: Ant): number => {
  const q = nearestQueen(s.colonies[ant.colony], ant.x, ant.y)!;
  return Math.hypot(ant.x - q.queenX, ant.y - q.queenY) / SUB;
};
const workersOf = (s: SimState): Ant[] => s.ants.filter((a) => a.colony === 0 && a.caste === "worker");
/** Within a template patch's disc (plus one tile), on either side's copy of it. */
const atTemplatePatch = (s: SimState, ant: Ant): boolean => s.config.foodPatches.some((p) =>
  [p.tileX, s.config.mapWidth - 1 - p.tileX].some((x) =>
    Math.hypot(ant.x / SUB - (x + 0.5), ant.y / SUB - (p.tileY + 0.5)) <= p.radius + gridScaleOf(s.config)));

describe("rules 27: an idle seated worker explores outward instead of patrolling a template patch", () => {
  it.each([2] as const)("moves every worker away from its nest, never to a template patch, at grid scale %i", () => {
    const { rules27 } = configs();
    const ticks = 600;
    let s = seated(rules27);
    const start = new Map(workersOf(s).map((a) => [a.id, fromQueen(s, a)]));
    let last = new Map(start);
    for (let tick = 0; tick < ticks; tick++) {
      s = step(s).state;
      expect(s.agents[0]!.idle).toBe(false);
      expect(s.colonies[0].seenFood ?? []).toEqual([]); // The colony still knows no food.
      for (const ant of workersOf(s)) {
        const d = fromQueen(s, ant);
        // Outward every tick, allowing only soft-spacing jostle; no creeping back along the edge.
        expect(d).toBeGreaterThanOrEqual(last.get(ant.id)! - 0.05 * gridScaleOf(s.config));
        last.set(ant.id, d);
      }
    }
    const { mapWidth: w, mapHeight: h, localAnts } = s.config;
    for (const ant of workersOf(s)) {
      // Out of the nest's defence radius and all the way to the map edge.
      expect(fromQueen(s, ant)).toBeGreaterThan(start.get(ant.id)! + localAnts!.defendTiles);
      const tx = ant.x / SUB, ty = ant.y / SUB;
      expect(Math.min(tx, ty, w - tx, h - ty)).toBeLessThan(1.5);
      expect(atTemplatePatch(s, ant)).toBe(false);
    }
  });

  it("heads along the ray from its queen through the ant and keeps foraging on, even with depleted memory", () => {
    const { rules27 } = configs();
    const s = seated({ ...rules27, terrain: undefined }, 0);
    const q = s.colonies[0].queens![0]!;
    const qx = Math.floor(q.queenX / SUB), qy = Math.floor(q.queenY / SUB);
    const offsets = [[6, 0], [0, 7], [0, -7], [5, 5], [4, -9], [12, 3], [-3, 2]] as const;
    const ants = offsets.map(([dx, dy]) => addAnt(s, 0, qx + dx, qy + dy, { caste: "worker" }));
    const depleted = (qy + 1) * s.config.mapWidth + qx + 1;
    s.colonies[0].seenFood = [depleted]; // Retained but empty memory counts as knowing no food, as captured.
    const assigned = localSoldierAssignments(s);
    for (const ant of ants) {
      const own = localDirection(s, buildGrid(s), ant, assigned);
      expect(own.foraging).toBe(true);
      const ox = ant.x - q.queenX, oy = ant.y - q.queenY;
      const cos = (own.dir.x * ox + own.dir.y * oy) / Math.hypot(own.dir.x, own.dir.y) / Math.hypot(ox, oy);
      expect(cos).toBeGreaterThan(0.999);
    }
    // Stocked memory is the captured trigger's end: the worker forages that food instead.
    const stocked = (qy + 12) * s.config.mapWidth + qx + 20;
    s.food[stocked] = 3;
    s.colonies[0].seenFood = [stocked];
    const forager = ants[0]!;
    localDirection(s, buildGrid(s), forager, assigned);
    expect(forager.foodTarget).toBe(stocked);
  });

  it("gives a worker at its queen a stable per-ant heading, spread across workers", () => {
    const { rules27 } = configs();
    const s = seated({ ...rules27, terrain: undefined }, 16);
    const headings = (state: SimState) => workersOf(state).map((ant) => {
      const dir = localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir;
      expect(dir.x !== 0 || dir.y !== 0).toBe(true);
      return `${dir.x},${dir.y}`;
    });
    const first = headings(cloneState(s));
    const later = cloneState(s);
    later.tick = 777;
    expect(headings(later)).toEqual(first);
    expect(new Set(first).size).toBeGreaterThanOrEqual(12);
  });
});
