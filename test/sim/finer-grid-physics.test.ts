import { describe, expect, it } from "vitest";
import { rulesConfig, SUB } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { markDirection } from "../../src/sim/marks.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { sustainedTerritoryWin, territoryCounts, updateTerritory } from "../../src/sim/territory.js";
import { isBlockedTile, moveOnLand, segmentOnLand } from "../../src/sim/terrain.js";
import { routeToward } from "../../src/sim/navigation.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { groundIncome, pickupAndDeliver, regrow, toward } from "../../src/sim/forage.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { step } from "../../src/sim/step.js";
import { applySoftSeparation } from "../../src/sim/softSeparation.js";
import { beginLocalGoals, clusterArrivals, currentLocalGoals, foodWithinReach, noteContact, noteFood } from "../../src/sim/localArrival.js";

const sum = (a: readonly number[]) => a.reduce((total, n) => total + n, 0);

// Every match plays at grid scale 2: scale is that one grid scale, and grid scales 1 and 4 are retired.
describe("finer terrain with original physical rules", () => {

  it.each([2] as const)("keeps AVOID's physical arrival dead-zone without recording a toward goal at scale %i", scale => {
    const state = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined }));
    const ant = state.ants[0]!;
    const mark = { id: 1, agentId: "test", colony: 0 as const, tileX: 20 * scale,
      tileY: 20 * scale, words: ["AVOID"] as const, laidTick: 0, steering: 0 };
    ant.y = tileCentre(mark.tileY);
    beginLocalGoals(state);
    for (const offset of [0.2, 0.3, 0.4]) {
      ant.x = tileCentre(mark.tileX) - offset * SUB * scale;
      const dir = markDirection(mark, ant, state);
      if (offset <= 0.3) expect(dir.x === 0 && dir.y === 0).toBe(true);
      else expect(dir.x).toBeLessThan(0);
    }
    expect(currentLocalGoals(state).size).toBe(0);
  });

  it("seeds starting food within the layout's bounds and never on a blocked fine cell", () => {
    for (const mapId of ["open-field", "three-crossings", "central-lake"]) {
      const base = rulesConfig("redesign");
      const fine = createMatch(7001, withGridScale({ ...base, terrain: { ...base.terrain!, mapId } }));
      expect(sum(fine.food)).toBeGreaterThanOrEqual(base.foodLayout!.minStartingFood);
      expect(sum(fine.food)).toBeLessThanOrEqual(base.foodLayout!.maxStartingFood);
      fine.food.forEach((food, i) => {
        if (food > 0) expect(isBlockedTile(fine.terrain, i % fine.config.mapWidth,
          Math.floor(i / fine.config.mapWidth))).toBe(false);
      });
    }
  });

  it.each([2] as const)("holds and decays one physical cell, not one fine cell, at %i", scale => {
    const base = { ...rulesConfig("redesign"), terrain: undefined };
    const fine = createMatch(7001, withGridScale(base));
    fine.ants = fine.ants.slice(0, 1);
    updateTerritory(fine, buildGrid(fine), 1);
    expect(fine.owner.filter(x => x === 0)).toHaveLength(scale * scale);
    expect(territoryCounts(fine)).toEqual([1, 0]);
    fine.ants = [];
    updateTerritory(fine, buildGrid(fine), 1 + fine.config.territoryDecayTicks);
    expect(territoryCounts(fine)).toEqual([0, 0]);
  });

  it.each([2] as const)("keeps early-win thresholds in original-area units at %i", scale => {
    const fine = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined,
      earlyWin: { minTick: 0, holdTicks: 1, territoryRatioPermille: 6000, minHeldTiles: 100 } }));
    fine.owner.fill(0, 0, 100 * scale * scale - 1);
    expect(sustainedTerritoryWin(fine, 1)).toBeNull();
    fine.owner[100 * scale * scale - 1] = 0;
    expect(sustainedTerritoryWin(fine, 2)).toMatchObject({ winner: 0, reason: "sustained_territory" });
  });

  it.each([2] as const)("never claims blocked fine cells within a physical presence footprint at %i", scale => {
    const config = withGridScale({ ...rulesConfig("redesign"), terrain: undefined });
    const made = createMatch(7001, config);
    const fine = { ...made, terrain: { mapId: "partial", mapName: "partial",
      water: [{ x: 20 * scale, y: 20 * scale, width: 1, height: 1 }] } };
    fine.ants = fine.ants.slice(0, 1);
    fine.ants[0]!.x = (20 * scale + 1.5) * SUB;
    fine.ants[0]!.y = (20 * scale + 1.5) * SUB;
    updateTerritory(fine, buildGrid(fine), 1);
    expect(fine.owner[20 * scale * config.mapWidth + 20 * scale]).toBe(-1);
    expect(territoryCounts(fine)).toEqual([(scale * scale - 1) / (scale * scale), 0]);
    expect(Number.isInteger(groundIncome(fine, config.groundFoodIntervalTicks!)[0])).toBe(true);
  });

  it.each([2] as const)("preserves adjacent-ant combat reach at %i", scale => {
    const fine = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined }));
    fine.ants = fine.ants.slice(0, 2);
    fine.ants[0]!.x = 20.5 * SUB * scale;
    fine.ants[0]!.y = 20.5 * SUB * scale;
    fine.ants[1]!.x = 21.5 * SUB * scale;
    fine.ants[1]!.y = 20.5 * SUB * scale;
    const before = fine.ants[1]!.hp;
    resolveCombat(fine, buildGrid(fine), fine.config.combatGraceTicks, []);
    expect(fine.ants[1]!.hp).toBeLessThan(before);
  });

  it.each([2] as const)("preserves imported soft-separation distances, caps and arrival links at %i", scale => {
    const fine = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined }));
    for (const [state, factor] of [[fine, scale]] as const) {
      state.ants = state.ants.slice(0, 3).map((a, i) => ({ ...a, colony: 0,
        x: (20_000 + i * 50) * factor, y: 20_000 * factor }));
      const origins = new Map(state.ants.map(a => [a.id, { x: a.x - 200 * factor, y: a.y }]));
      const motion = applySoftSeparation(state, origins);
      expect(motion.colonies[0]!.maxTotalDisplacement).toBeLessThanOrEqual(state.config.softSeparation!.maxStep);
      const goals = new Map(state.ants.map((a, i) => [a.id, { key: "same-point", nativeReached: i === 0 }]));
      // Use a straight local chain to isolate the imported graph's length units.
      state.ants.forEach((a, i) => { a.x = (20_000 + i * 100) * factor; a.y = 20_000 * factor; });
      const arrival = clusterArrivals(state.ants, goals, state.config.softSeparation!.arrivalLinkRadius);
      expect([...arrival.values()].map(a => [a.arrived, a.rootId, a.hops])).toEqual([[true, 1, 0], [true, 1, 1], [true, 1, 2]]);
    }
  });

  it.each([2] as const)("uses physical food cells and combat reach in imported native-arrival goals at %i", scale => {
    const fine = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined }));
    fine.ants = fine.ants.slice(0, 2);
    const [ant, enemy] = fine.ants;
    ant!.x = (20 * scale + 0.1) * SUB; ant!.y = (20 * scale + 0.1) * SUB;
    enemy!.x = ant!.x + SUB * scale; enemy!.y = ant!.y;
    beginLocalGoals(fine);
    expect(noteContact(fine, ant!)).toBe(true);
    const first = 20 * scale * fine.config.mapWidth + 20 * scale;
    expect(foodWithinReach(fine, ant!, first + scale - 1)).toBe(true);
    noteFood(fine, ant!, first);
    const key = currentLocalGoals(fine).get(ant!.id)!.key;
    noteFood(fine, ant!, first + scale - 1);
    expect(currentLocalGoals(fine).get(ant!.id)).toMatchObject({ key, nativeReached: true });
  });

  it.each([2] as const)("keeps pickup footprints, regrowth and ground-income rates physical at %i", scale => {
    const fine = createMatch(7001, withGridScale({ ...rulesConfig("redesign"), terrain: undefined }));
    // The original (reference) cell holding the first food, and its corner fine cell.
    const source = fine.food.findIndex(amount => amount > 0), width = fine.config.mapWidth;
    const x = Math.floor((source % width) / scale), y = Math.floor(Math.floor(source / width) / scale);
    // One unit regrows per original cell with any food capacity, never per fine cell.
    let originalCells = 0;
    for (let cy = 0; cy < fine.config.mapHeight / scale; cy++) for (let cx = 0; cx < width / scale; cx++) {
      let cap = 0;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) cap += fine.foodCap[(cy * scale + dy) * width + cx * scale + dx]!;
      if (cap > 0) originalCells++;
    }
    fine.ants = fine.ants.slice(0, 1);
    const ant = fine.ants[0]!;
    // Corner of the original cell, away from the distributed resource units.
    ant.x = (x * scale + 0.05) * SUB;
    ant.y = (y * scale + 0.05) * SUB;
    const food = sum(fine.food);
    pickupAndDeliver(fine, new Set([ant.id]));
    expect(ant.carrying).toBe(true);
    expect(sum(fine.food)).toBe(food - 1);
    fine.food.fill(0);
    regrow(fine, fine.config.foodRegrowTicks);
    expect(sum(fine.food)).toBe(originalCells);
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      fine.owner[(y * scale + dy) * fine.config.mapWidth + x * scale + dx] = 0;
    }
    // Today's redesign rules pay no held-ground income (ground-income.test.ts), at any grid scale.
    expect(groundIncome(fine, fine.config.groundFoodIntervalTicks!)).toEqual([0, 0]);
    expect(toward(ant, ant.x + 290 * scale, ant.y, fine)).toEqual({ x: 0, y: 0 });
    expect(toward(ant, ant.x + 310 * scale, ant.y, fine)).not.toEqual({ x: 0, y: 0 });
  });

  it.each([2] as const)("replays fine-grid configs deterministically at %i", () => {
    const config = withGridScale(rulesConfig("redesign"));
    let state = createMatch(7001, config);
    for (let i = 0; i < 8; i++) state = step(state, []).state;
    expect(stateHash(replay([headerLine(7001, config)], 8))).toBe(stateHash(state));
  });

  it.each([2] as const)("routes around a wall rather than stalling at fine-grid corners at %i", scale => {
    const config = withGridScale({ ...rulesConfig("redesign"), terrain: undefined });
    const state = createMatch(7001, config);
    const terrain = { mapId: "wall", mapName: "wall", water: [{ x: 31 * scale, y: 8 * scale, width: 2 * scale, height: 32 * scale }] };
    const routed = { ...state, terrain };
    const ant = routed.ants[0]!;
    ant.x = 28.5 * SUB * scale; ant.y = 24.5 * SUB * scale;
    const x = 36.5 * SUB * scale, y = 24.5 * SUB * scale;
    for (let i = 0; i < 1000 && Math.hypot(ant.x - x, ant.y - y) > 300 * scale; i++) {
      const before = { x: ant.x, y: ant.y };
      moveOnLand(config, terrain, ant, routeToward(routed, ant, x, y), 200 * scale);
      expect(segmentOnLand(config, terrain, before.x, before.y, ant.x, ant.y)).toBe(true);
    }
    expect(Math.hypot(ant.x - x, ant.y - y)).toBeLessThanOrEqual(300 * scale);
  });

  it.each([2] as const)("refuses crossings and corner cuts of an individual fine tile at %i", () => {
    const config = withGridScale(rulesConfig("redesign"));
    const terrain = { mapId: "test", mapName: "test", water: [{ x: 10, y: 10, width: 1, height: 1 }] };
    expect(segmentOnLand(config, terrain, 9.5 * SUB, 10.5 * SUB, 11.5 * SUB, 10.5 * SUB)).toBe(false);
    expect(segmentOnLand(config, terrain, 9.5 * SUB, 10.5 * SUB, 10.5 * SUB, 9.5 * SUB)).toBe(false);
    expect(segmentOnLand(config, terrain, 9.5 * SUB, 9.5 * SUB, 11.5 * SUB, 9.5 * SUB)).toBe(true);
  });
});
