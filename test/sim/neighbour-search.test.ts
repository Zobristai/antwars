import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { distance, withinTiles } from "../../src/sim/geometry.js";
import { newMatchConfig, gridScaleOf } from "../../src/sim/gridScale.js";
import { houseDirection, nearestIntruder, rebalanceRoles, sightScan } from "../../src/sim/houseBot.js";
import { stateHash } from "../../src/sim/log.js";
import { buildGrid, cloneState, forEachNear, newAnt, type Grid } from "../../src/sim/map.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { emptyMatch } from "./fixtures.js";

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

const config: SimConfig = { ...newMatchConfig(rulesConfig("redesign")), startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] };

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
