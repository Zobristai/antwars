import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { houseDirection } from "../../src/sim/houseBot.js";
import { beginLocalGoals, readLocalGoal } from "../../src/sim/localArrival.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { buildGrid, createMatch, newAnt } from "../../src/sim/map.js";
import { advanceSoftAnts } from "../../src/sim/step.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { Ant, ColonyId, SimState } from "../../src/sim/types.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Immutable baseline: 59ed9a6d309b48d31b7c9d09e283d6b1a5fcbab5.
// Pinned at that baseline: rally interpolation, laneY and navigation's nearest-land/own-side tie
// rank, forced substituted notePoint and arrival check, and both exported callers.
// These are fixed geometric expectations, not outputs from a second router call.
// Queens at x=8500 and 56500 (reference), rally fraction 1/2, paired ant ids 1/2 (rules-24 lane row 39).
// Every match plays at grid scale 2:
// scale 2 -> raw (65000,79000), blocked column 65, land columns 64/66.
// The native one-column rock wall spans every row, so its two horizontal
// neighbours tie; colony 0 chooses left and colony 1 right. A substituted
// target is a native tile centre, including y=79500 on the finer grid.
const geometry = {
  2: { rawX: 65000, rawY: 79000, rockX: 65, landX: [64500, 66500], landY: 79500, arrival: 600 },
} as const;
const callers = ["house worker", "house soldier"] as const;
type Caller = typeof callers[number];
type RallyAnt = Ant & { houseIntentHold?: { intent: {
  kind: string; homeId?: number; targetId?: number; x: number; y: number;
} } };

function scene(colony: ColonyId, scale: 2, founding: boolean, caller: Caller) {
  const scaled = newMatchConfig(recordedHousePlan(rulesConfig("redesign")));
  const config: SimConfig = { ...scaled, startAnts: 0, terrain: undefined,
    foodLayout: undefined, foodPatches: [], rallyStartPermille: 500, rallyEndPermille: 500,
    queenFounding: founding ? scaled.queenFounding : undefined,
    localAnts: { ...scaled.localAnts!, soldierFrontSharePermille: 1000, soldierPatchSharePermille: 0 } };
  const expected = geometry[scale];
  const state: SimState = { ...createMatch(6006, config), terrain: {
    mapId: "rock-rally", mapName: "Rock rally", water: [],
    rocks: [{ x: expected.rockX, y: 0, width: 1, height: config.mapHeight, appearance: 0 }],
  } };
  for (const side of [0, 1] as const) {
    const x = (side === 0 ? 8500 : 56500) * scale;
    const old = state.colonies[side], queen = old.queens?.[0];
    state.colonies[side] = { ...old, queenX: x,
      ...(queen === undefined ? {} : { queens: [{ ...queen, queenX: x }] }) };
  }
  const landX = expected.landX[colony];
  const ant = newAnt(config, 1 + colony, colony, landX + (colony === 0 ? -2000 : 2000),
    expected.landY, caller === "house worker" ? "worker" : "soldier") as RallyAnt;
  ant.role = "fighter";
  state.ants = [ant];
  return { state, ant, expected, landX };
}

function choose(state: SimState, ant: Ant) {
  return houseDirection(state, buildGrid(state), [], ant);
}

for (const scale of [2] as const) for (const colony of [0, 1] as const) {
  for (const founding of [false, true]) describe.each(callers)(
    `rock rally: %s, colony ${colony}, scale ${scale}, founding ${founding}`, caller => {
      it("keeps the raw rally intent and routes to the nearest own-side land on a tie", () => {
        const { state, ant, expected, landX } = scene(colony, scale, founding, caller);
        expect(localRulesSide(state, colony)).toBe(false);
        expect(ant.squad).toBeNull();
        expect(ant.claim).toBeUndefined();
        expect(isRockTile(state.terrain, Math.floor(expected.rawX / 1000), Math.floor(expected.rawY / 1000))).toBe(true);
        expect(isWaterTile(state.terrain, Math.floor(expected.rawX / 1000), Math.floor(expected.rawY / 1000))).toBe(false);
        beginLocalGoals(state);
        expect(choose(state, ant)).toEqual({ x: colony === 0 ? 1000 : -1000, y: 0 });
        expect(ant.houseIntentHold?.intent).toEqual({ kind: "rally", homeId: 0, targetId: 0,
          x: expected.rawX, y: expected.rawY });
        expect(readLocalGoal(state, ant)).toEqual({ key: `${colony}/point/${landX},${expected.landY}`,
          kind: "point", x: landX, y: expected.landY, nativeReached: false });
      });

      it("keeps the substituted-point arrival boundary rather than approaching the rock", () => {
        for (const delta of [-1, 0, 1]) {
          const { state, ant, expected, landX } = scene(colony, scale, founding, caller);
          ant.x = landX + (colony === 0 ? -1 : 1) * (expected.arrival + delta);
          beginLocalGoals(state);
          expect(choose(state, ant)).toEqual(delta <= 0
            ? { x: 0, y: 0 } : { x: colony === 0 ? 1000 : -1000, y: 0 });
          expect(readLocalGoal(state, ant)).toMatchObject({ kind: "point", x: landX,
            y: expected.landY, nativeReached: delta <= 0 });
          expect(ant.houseIntentHold?.intent).toMatchObject({ kind: "rally", x: expected.rawX, y: expected.rawY });
        }
      });

      it("arrives on the same land and remains still through repeated soft-movement phases", () => {
        const { state, ant, expected, landX } = scene(colony, scale, founding, caller);
        const settled: number[][] = [];
        let assigned: Ant['pointRest'];
        for (let tick = 0; tick < 80; tick++) {
          state.tick = tick;
          beginLocalGoals(state);
          const dir = choose(state, ant);
          const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
          expect(frame.decisionGoals.get(ant.id)).toMatchObject({ kind: "point", x: landX, y: expected.landY });
          expect(ant.pointRest).toBeDefined();
          if (tick === 0) assigned = { ...ant.pointRest! };
          expect(ant.pointRest).toEqual(assigned);
          expect(frame.pointRests.get(ant.id)).toMatchObject({ x: assigned!.x, y: assigned!.y });
          expect(ant.houseIntentHold?.intent).toMatchObject({ kind: "rally", x: expected.rawX, y: expected.rawY });
          expect(isRockTile(state.terrain, Math.floor(ant.x / 1000), Math.floor(ant.y / 1000))).toBe(false);
          if (tick >= 40) settled.push([ant.x, ant.y, ant.vx, ant.vy]);
        }
        expect(Math.abs(ant.x - landX)).toBeLessThanOrEqual(expected.arrival);
        expect(settled).toHaveLength(40);
        expect(Math.abs(assigned!.y - expected.landY)).toBeLessThanOrEqual(expected.arrival);
        // Bound: one configured spacing from the old land spot; a lone organic
        // site's displacement is tighter still, at most jitter on either axis.
        const spacing = state.config.pointArrival!.pitch, jitter = state.config.pointArrival!.jitter;
        expect(Math.hypot(assigned!.x - landX, assigned!.y - expected.landY)).toBeLessThanOrEqual(spacing);
        expect(Math.abs(assigned!.x - landX)).toBeLessThanOrEqual(jitter);
        expect(Math.abs(assigned!.y - expected.landY)).toBeLessThanOrEqual(jitter);
        expect(isWaterTile(state.terrain, Math.floor(assigned!.x / 1000), Math.floor(assigned!.y / 1000))).toBe(false);
        expect([ant.x, ant.y]).toEqual([assigned!.x, assigned!.y]);
        expect(settled.every(row => row[0] === assigned!.x && row[1] === assigned!.y && row[2] === 0 && row[3] === 0)).toBe(true);
      });
    });
}
