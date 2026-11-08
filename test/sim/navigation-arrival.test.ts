import { describe, expect, it } from "vitest";
import { rulesConfig, speedPerTick, SUB, type SimConfig } from "../../src/sim/config.js";
import { toward } from "../../src/sim/forage.js";
import { direction, tileCentre, ZERO } from "../../src/sim/geometry.js";
import { beginLocalGoals, readLocalGoal } from "../../src/sim/localArrival.js";
import { createMatch, newAnt } from "../../src/sim/map.js";
import { routeToward } from "../../src/sim/navigation.js";
import { advanceSoftAnts } from "../../src/sim/step.js";
import { isPassable, moveOnLand } from "../../src/sim/terrain.js";
import type { ColonyId } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

// Frozen movement settings from pre-arrival main ba280fb7324e1ea90f0a100b89b2990c531100cc.
const { pointArrival: _pointArrival, ...preArrivalBase } = rulesConfig("redesign");
const PRE_ARRIVAL_CONFIG: SimConfig = Object.freeze({ ...preArrivalBase, softSeparation: Object.freeze({
  radius: 100, strength: 1600, maxStep: 200, arrivalSubunits: 300, epsilon: 1, arrivalLinkRadius: 150,
}) });

function scene(colony: ColonyId, soft = true, base: SimConfig = rulesConfig("redesign")) {
  // At grid scale 2 the one-tile reference wall is two fine tiles (20 and 21), with land at 19 and 22.
  const config: SimConfig = playable({ ...base, startAnts: 0,
    terrain: undefined, foodLayout: undefined, foodPatches: [],
    ...(!soft ? { softSeparation: undefined } : {}) });
  const state = { ...createMatch(6006, config),
    terrain: { mapId: "wall", mapName: "Wall", water: [{ x: 20, y: 0, width: 2, height: config.mapHeight }] } };
  const landX = tileCentre(colony === 0 ? 19 : 22), y = tileCentre(40);
  const ant = newAnt(config, 1, colony, landX + (colony === 0 ? -4074 : 4074), y);
  state.ants = [ant];
  return { state, ant, landX, y, waterX: tileCentre(colony === 0 ? 20 : 21) };
}

describe.each([0, 1] as const)("substituted point arrival, colony %i", colony => {
  it("settles at the routed bank and stays still through the real soft-movement phase", () => {
    const { state, ant, landX, waterX, y } = scene(colony, true, PRE_ARRIVAL_CONFIG);
    const settled: number[][] = [];
    for (let tick = 0; tick < 80; tick++) {
      state.tick = tick;
      beginLocalGoals(state);
      const dir = toward(ant, waterX, y, state);
      const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
      const goal = frame.decisionGoals.get(ant.id)!;
      expect(goal).toMatchObject({ x: landX, y, kind: "point" });
      expect(goal.nativeReached).toBe(Math.abs(frame.origins.get(ant.id)!.x - landX) <= state.config.softSeparation!.arrivalSubunits);
      if (tick >= 30) settled.push([ant.x, ant.y, ant.vx, ant.vy]);
    }
    expect(Math.abs(ant.x - landX)).toBeLessThanOrEqual(state.config.softSeparation!.arrivalSubunits);
    expect(settled).toHaveLength(50);
    expect(settled.every(position => position[0] === ant.x && position[1] === y && position[2] === 0 && position[3] === 0)).toBe(true);
  });

  it("rests independently on its own bank within the declared config bounds", () => {
    const { state, ant, landX, waterX, y } = scene(colony);
    const { config } = state, nativeSpeed = speedPerTick(config), progress = nativeSpeed - 2;
    expect(progress).toBeGreaterThan(0);
    const restDistance = Math.ceil(Math.SQRT2 * config.pointArrival!.jitter);
    const startRange = config.sightTiles * SUB;
    const arrivalTicks = Math.ceil(2 * (startRange + restDistance) / progress) + 2;
    const stillTicks = 5 * config.ticksPerSecond;
    expect(Math.hypot(ant.x - landX, ant.y - y)).toBeLessThanOrEqual(startRange);
    let assigned: { x: number; y: number } | undefined, reachedTick: number | undefined;
    const settled: number[][] = [];
    for (let tick = 0; tick < arrivalTicks + stillTicks; tick++) {
      state.tick = tick; beginLocalGoals(state);
      const dir = toward(ant, waterX, y, state);
      const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
      const label = `colony=${colony} tick=${tick}`;
      expect(frame.decisionGoals.get(ant.id), label).toMatchObject({ kind: "point", x: landX, y });
      expect(frame.pointRests.has(ant.id), label).toBe(true);
      const rest = frame.pointRests.get(ant.id)!, origin = frame.origins.get(ant.id)!;
      assigned ??= { ...rest };
      expect(rest, label).toMatchObject(assigned);
      expect(Math.hypot(rest.x - landX, rest.y - y), `${label} rest=${rest.x},${rest.y} anchor=${landX},${y}`)
        .toBeLessThanOrEqual(restDistance);
      expect(isPassable(state, Math.floor(rest.x / SUB), Math.floor(rest.y / SUB)), label).toBe(true);
      expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)), label).toBe(true);
      const bank = Math.floor(rest.x / SUB), water = Math.floor(waterX / SUB);
      expect(colony === 0 ? bank < water : bank > water, label).toBe(true);
      expect((ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2, label).toBeLessThanOrEqual(nativeSpeed ** 2);
      if (ant.x === rest.x && ant.y === rest.y) reachedTick ??= tick + 1;
      if (tick + 1 >= arrivalTicks) {
        expect(reachedTick, `${label} deadline=${arrivalTicks} position=${ant.x},${ant.y} rest=${rest.x},${rest.y}`).toBeDefined();
        expect(reachedTick!, label).toBeLessThanOrEqual(arrivalTicks);
        expect([ant.x, ant.y], label).toEqual([rest.x, rest.y]);
      }
      if (tick >= arrivalTicks) {
        expect([ant.x, ant.y, ant.vx, ant.vy], label).toEqual([rest.x, rest.y, 0, 0]);
        settled.push([ant.x, ant.y, ant.vx, ant.vy]);
      }
    }
    expect(settled).toHaveLength(stillTicks);
    console.log(JSON.stringify({ colony, arrivalTicks, restDistance, stillTicks, reachedTick, assigned }));
  });

  it.each([599, 600, 601])("uses the existing arrival boundary at bank distance %i", distance => {
    const { state, ant, landX, waterX, y } = scene(colony);
    ant.x = landX + (colony === 0 ? -distance : distance);
    beginLocalGoals(state);
    expect(routeToward(state, ant, waterX, y)).toEqual(distance <= 600 ? ZERO : direction(landX - ant.x, 0));
    expect(readLocalGoal(state, ant)).toEqual({ key: `${colony}/point/${landX},${y}`, kind: "point", x: landX, y, nativeReached: distance <= 600 });
  });

  it.each([599, 600, 601, 4000])("preserves land-goal direction and arrival at distance %i", distance => {
    const { state, ant, landX, y } = scene(colony);
    ant.x = landX + (colony === 0 ? -distance : distance);
    beginLocalGoals(state);
    const expected = distance <= 600 ? ZERO : direction(landX - ant.x, 0);
    expect(routeToward(state, ant, landX, y)).toEqual(expected);
    expect(toward(ant, landX, y, state)).toEqual(expected);
    expect(readLocalGoal(state, ant)).toMatchObject({ x: landX, y, nativeReached: distance <= 600 });
  });

  it("preserves historical non-soft routing instead of introducing an arrival radius", () => {
    const { state, ant, landX, waterX, y } = scene(colony, false);
    ant.x = landX + (colony === 0 ? -74 : 74);
    const expected = direction(landX - ant.x, 0);
    expect(routeToward(state, ant, waterX, y)).toEqual(expected);
    moveOnLand(state.config, state.terrain, ant, expected, speedPerTick(state.config));
    expect(routeToward(state, ant, waterX, y)).toEqual(direction(landX - ant.x, 0));
  });
});
