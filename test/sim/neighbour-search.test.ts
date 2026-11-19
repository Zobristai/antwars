import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { distance, withinTiles } from "../../src/sim/geometry.js";
import { newMatchConfig, gridScaleOf } from "../../src/sim/gridScale.js";
import { houseDirection, nearestIntruder, rebalanceRoles, sightScan } from "../../src/sim/houseBot.js";
import { stateHash } from "../../src/sim/log.js";
import { buildGrid, cloneState, createMatch, forEachNear, hasAdjacentEnemy, newAnt, noEnemyNear, type Grid } from "../../src/sim/map.js";
import { quadrantMapConfig } from "../../src/sim/quadrantMaps.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { emptyMatch } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// The neighbour-search speed-ups must choose exactly what the code at
// a967cef404365381d91ed800426ac83cf7dc263f chose. The oracles below are verbatim
// copies of that commit's forEachNear Map path, fighterDirection count and nearestEnemy.

function oracleForEachNear(state: SimState, grid: Grid, tx: number, ty: number, r: number, visit: (ant: Ant) => void): void {
  const { mapWidth, mapHeight } = state.config;
  const x0 = Math.max(0, tx - r), x1 = Math.min(mapWidth - 1, tx + r);
  const y0 = Math.max(0, ty - r), y1 = Math.min(mapHeight - 1, ty + r);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const bucket = grid.get(y * mapWidth + x);
      if (bucket) for (const ant of bucket) visit(ant);
    }
  }
}

function oracleNearestEnemy(state: SimState, grid: Grid, ant: Ant, tx: number, ty: number, r: number): Ant | null {
  let best: Ant | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  oracleForEachNear(state, grid, tx, ty, r, (other) => {
    if (other.colony === ant.colony) return;
    if (!withinTiles(tx, ty, Math.floor(other.x / SUB), Math.floor(other.y / SUB), r)) return;
    const d = distance(ant.x, ant.y, other.x, other.y);
    if (d < bestD || (d === bestD && best !== null && other.id < best.id)) {
      best = other;
      bestD = d;
    }
  });
  return best;
}

function oracleCounts(state: SimState, grid: Grid, ant: Ant, tx: number, ty: number, r: number): [number, number] {
  let own = 0, enemy = 0;
  oracleForEachNear(state, grid, tx, ty, r, (other) => {
    if (!withinTiles(tx, ty, Math.floor(other.x / SUB), Math.floor(other.y / SUB), r)) return;
    if (other.colony === ant.colony) own += 1;
    else enemy += 1;
  });
  return [own, enemy];
}

/** Deterministic LCG: no Math.random, so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const config: SimConfig = { ...newMatchConfig(recordedHousePlan(rulesConfig("redesign"))), startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] };

/** Both colonies crowded around colony 0's queen, with exact-position duplicates for distance ties. */
function crowdedState(): SimState {
  const state = emptyMatch(100, config);
  const queen = state.colonies[0].queens![0]!;
  const random = lcg(486);
  const spread = (config.guardEngageTiles + 4) * SUB;
  const maxX = config.mapWidth * SUB - 1, maxY = config.mapHeight * SUB - 1;
  for (let i = 0; i < 600; i++) {
    const colony = i % 3 === 0 ? 0 : 1;
    const x = Math.max(0, Math.min(maxX, Math.floor(queen.queenX + (random() * 2 - 1) * spread)));
    const y = Math.max(0, Math.min(maxY, Math.floor(queen.queenY + (random() * 2 - 1) * spread)));
    state.ants.push(newAnt(config, state.nextAntId++, colony, x, y, i % 2 === 0 ? "worker" : "soldier"));
    // Every fifth ant gets a same-colony twin on the same point: to an enemy the two
    // are equally distant, so the choice falls to the lowest id.
    if (i % 5 === 0) state.ants.push(newAnt(config, state.nextAntId++, colony, x, y, "soldier"));
  }
  // A few ants on the board edge exercise the clamped scan bounds.
  state.ants.push(newAnt(config, state.nextAntId++, 1, 0, 0), newAnt(config, state.nextAntId++, 0, maxX, maxY));
  return state;
}

const tileOf = (ant: Ant) => [Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)] as const;

describe("neighbour search equivalence", () => {
  it("visits the same ants in the same order through the dense path as through the Map path", () => {
    const state = crowdedState();
    const grid = buildGrid(state);
    const foreign: Grid = new Map(grid); // not built by buildGrid: takes the Map path
    for (const r of [0, 1, gridScaleOf(config), config.sightTiles, config.guardEngageTiles]) {
      for (const ant of state.ants) {
        const [tx, ty] = tileOf(ant);
        const dense: number[] = [], viaMap: number[] = [], oracle: number[] = [];
        forEachNear(state, grid, tx, ty, r, (other) => dense.push(other.id));
        forEachNear(state, foreign, tx, ty, r, (other) => viaMap.push(other.id));
        oracleForEachNear(state, grid, tx, ty, r, (other) => oracle.push(other.id));
        expect(dense).toEqual(oracle);
        expect(viaMap).toEqual(oracle);
      }
    }
  });

  it("sightScan counts and picks the nearest enemy exactly as the two scans did", () => {
    const state = crowdedState();
    const grid = buildGrid(state);
    let ties = 0;
    for (const ant of state.ants) {
      const [tx, ty] = tileOf(ant);
      const scan = sightScan(state, grid, ant, tx, ty, config.sightTiles);
      expect([scan.own, scan.enemy]).toEqual(oracleCounts(state, grid, ant, tx, ty, config.sightTiles));
      const expected = oracleNearestEnemy(state, grid, ant, tx, ty, config.sightTiles);
      expect(scan.nearestEnemy?.id ?? null).toBe(expected?.id ?? null);
      if (expected !== null && state.ants.some(o => o !== expected && o.colony === expected.colony && o.x === expected.x && o.y === expected.y)) ties += 1;
    }
    expect(ties).toBeGreaterThan(0);
  });

  it("nearestIntruder over shared queen candidates picks what nearestEnemy picked, for every ant on one grid", () => {
    const state = crowdedState();
    const grid = buildGrid(state);
    const queens = [state.colonies[0].queens![0]!, state.colonies[1].queens![0]!];
    let found = 0;
    for (const queen of queens) {
      const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
      for (const ant of state.ants) {
        const expected = oracleNearestEnemy(state, grid, ant, qx, qy, config.guardEngageTiles);
        expect(nearestIntruder(state, grid, ant, qx, qy, config.guardEngageTiles)?.id ?? null).toBe(expected?.id ?? null);
        if (expected !== null) found += 1;
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it("house-phase directions and state are identical with one shared grid and a fresh grid per ant", () => {
    const start = crowdedState();
    rebalanceRoles(start);
    expect(start.ants.filter(a => a.role === "guard").length).toBeGreaterThan(1);
    const shared = cloneState(start);
    const sharedGrid = buildGrid(shared);
    const sharedDirs = shared.ants.map(ant => houseDirection(shared, sharedGrid, [], ant));
    const fresh = cloneState(start);
    const freshDirs = fresh.ants.map(ant => houseDirection(fresh, buildGrid(fresh), [], ant));
    expect(sharedDirs).toEqual(freshDirs);
    expect(stateHash(shared)).toBe(stateHash(fresh));
  });
});

// The same checks with four colonies. The per-tile colony counts used to cover two colonies only, so a
// four-colony match took the per-ant scans; now every colony count reads them, and enemies are every other
// colony's ants. The oracles above (and the per-ant adjacency scan below) are what those scans chose.

function oracleAdjacentEnemy(state: SimState, grid: Grid, ant: Ant): boolean {
  const airborne = ant.air !== undefined;
  let found = false;
  oracleForEachNear(state, grid, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), gridScaleOf(state.config), (other) => {
    if (other.colony !== ant.colony && (other.air !== undefined) === airborne) found = true;
  });
  return found;
}

function oracleNoEnemyNear(state: SimState, grid: Grid, ant: Ant, r: number): boolean {
  let none = true;
  oracleForEachNear(state, grid, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), r, (other) => { if (other.colony !== ant.colony) none = false; });
  return none;
}

/** Four colonies crowded around the centre of a four-colony board, with exact-position twins for distance ties. */
function crowdedFourColonyState(): SimState {
  const state = createMatch(100, quadrantMapConfig("strait"));
  expect(state.colonies.length).toBe(4);
  state.ants = [];
  const { config } = state;
  const random = lcg(4486);
  const spread = (config.sightTiles + 6) * SUB;
  const cx = (config.mapWidth * SUB) / 2, cy = (config.mapHeight * SUB) / 2;
  const maxX = config.mapWidth * SUB - 1, maxY = config.mapHeight * SUB - 1;
  for (let i = 0; i < 800; i++) {
    // Uneven shares, so no colony's count stands in for another's.
    const colony = i % 7 === 0 ? 0 : i % 7 < 3 ? 1 : i % 7 < 5 ? 2 : 3;
    const x = Math.max(0, Math.min(maxX, Math.floor(cx + (random() * 2 - 1) * spread)));
    const y = Math.max(0, Math.min(maxY, Math.floor(cy + (random() * 2 - 1) * spread)));
    state.ants.push(newAnt(config, state.nextAntId++, colony, x, y, i % 2 === 0 ? "worker" : "soldier"));
    if (i % 5 === 0) state.ants.push(newAnt(config, state.nextAntId++, colony, x, y, "soldier"));
  }
  // Lone ants of each colony far from the crowd: their neighbourhoods hold only their own colony or nothing.
  for (let colony = 0; colony < 4; colony++) state.ants.push(newAnt(config, state.nextAntId++, colony, colony % 2 === 0 ? 0 : maxX, colony < 2 ? 0 : maxY));
  return state;
}

describe("neighbour search equivalence with four colonies", () => {
  it("sightScan counts and picks the nearest enemy exactly as the per-ant scans did", () => {
    const state = crowdedFourColonyState();
    const grid = buildGrid(state);
    const r = state.config.sightTiles;
    let ties = 0, mixed = 0;
    for (const ant of state.ants) {
      const [tx, ty] = tileOf(ant);
      const scan = sightScan(state, grid, ant, tx, ty, r);
      expect([scan.own, scan.enemy]).toEqual(oracleCounts(state, grid, ant, tx, ty, r));
      const expected = oracleNearestEnemy(state, grid, ant, tx, ty, r);
      expect(scan.nearestEnemy?.id ?? null).toBe(expected?.id ?? null);
      if (expected !== null && state.ants.some(o => o !== expected && o.colony === expected.colony && o.x === expected.x && o.y === expected.y)) ties += 1;
      if (scan.enemy > 0 && scan.own > 0) mixed += 1;
    }
    expect(ties).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(100);
  });

  it("hasAdjacentEnemy and noEnemyNear answer as the per-ant scans did", () => {
    const state = crowdedFourColonyState();
    const grid = buildGrid(state);
    let adjacent = 0, clear = 0;
    for (const ant of state.ants) {
      const expected = oracleAdjacentEnemy(state, grid, ant);
      expect(hasAdjacentEnemy(state, grid, ant)).toBe(expected);
      if (expected) adjacent += 1;
      for (const r of [0, 1, gridScaleOf(state.config), state.config.sightTiles]) {
        const none = oracleNoEnemyNear(state, grid, ant, r);
        expect(noEnemyNear(state, grid, ant.colony, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB), r)).toBe(none);
        if (none) clear += 1;
      }
    }
    expect(adjacent).toBeGreaterThan(50);
    expect(clear).toBeGreaterThan(50);
  });
});
