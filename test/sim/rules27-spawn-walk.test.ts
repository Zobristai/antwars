import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { activeQueens, cloneState } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import { passableMask, segmentOnLand } from "../../src/sim/terrain.js";
import type { Ant, Caste, QueenState, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Rules-27 hatchlings walk to their queen's spawn point.
const join: SimInput = { type: "join", agentId: "a", placement: 0 };
const wake: SimInput = { type: "order", agentId: "a", order: { kind: "hold" } };
// Arrival radii at grid scale 2, in fine tiles: 1 reference tile for a worker, 3 for a soldier.
const ARRIVAL_FINE_TILES: Record<Caste, number> = { worker: 2, soldier: 6 };

function rules27(extra: Partial<SimConfig> = {}): SimConfig {
  const base = withGridScale(recordedHousePlan(rulesConfig("redesign")));
  return { ...base, rules27: true, startAnts: 0, squadSize: 0, terrain: undefined, foodLayout: undefined,
    foodPatches: [], groundFoodIntervalTicks: undefined, ...extra };
}

/** Colony 0 seated by a real join; colony 1 is a house bot with no food. */
function seated(config = rules27()): SimState {
  const state = step(emptyMatch(0, config), [join]).state;
  state.colonies[0].foodStore = 0;
  state.colonies[1].foodStore = 0;
  expect(state.config.gridScale).toBe(2);
  expect(localRulesSide(state, 0)).toBe(true);
  expect(localRulesSide(state, 1)).toBe(false);
  return state;
}

const queen = (state: SimState, index = 0): QueenState => activeQueens(state.colonies[0])[index] as QueenState;
const tile = (v: number): number => Math.floor(v / SUB);
const queenTile = (q: QueenState) => ({ tileX: tile(q.queenX), tileY: tile(q.queenY) });
const fineDistance2 = (ant: Ant, at: { tileX: number; tileY: number }): number =>
  (tile(ant.x) - at.tileX) ** 2 + (tile(ant.y) - at.tileY) ** 2;

/** Rules 27: each of the seated colony's queens hatches her own brood. */
function brood(state: SimState, caste: Caste): void {
  for (const q of state.colonies[0].queens!) q.brood = caste === "worker" ? "workers" : "soldiers";
}

/** Fund exactly one hatch of the colony's next caste and step until it happens. */
function hatchOne(state: SimState, max = 100): { state: SimState; born: Ant[] } {
  const known = new Set(state.ants.map((ant) => ant.id));
  state.colonies[0].foodStore = state.config.castes!.soldierCost;
  for (let i = 0; i < max; i++) {
    state = step(state).state;
    const born = state.ants.filter((ant) => !known.has(ant.id) && ant.colony === 0);
    if (born.length > 0) {
      state.colonies[0].foodStore = 0;
      return { state, born };
    }
  }
  throw new Error("no hatch");
}

/** Step until the ant's walk ends; returns the state before and after that tick. */
function walkUntilArrival(state: SimState, id: number, max = 600) {
  for (let i = 0; i < max; i++) {
    const next = step(state).state;
    if (antById(next, id)!.spawnWalk === undefined) return { before: state, after: next };
    state = next;
  }
  throw new Error("walk did not end");
}

describe("rules 27: hatchlings walk to their queen's spawn point", () => {
  for (const caste of ["worker", "soldier"] as const) {
    it(`a ${caste} hatched while its queen has a spawn point walks there and arrives within ${ARRIVAL_FINE_TILES[caste]} fine tiles`, () => {
      let state = seated();
      brood(state, caste);
      const q = queen(state);
      const spawn = { tileX: queenTile(q).tileX + 40, tileY: queenTile(q).tileY - 12 };
      q.spawnPoint = spawn;
      const hatched = hatchOne(state);
      state = hatched.state;
      expect(hatched.born).toHaveLength(1);
      const born = hatched.born[0]!;
      expect(born.caste).toBe(caste);
      expect(born.spawnWalk).toEqual({ queenId: q.id, ...spawn });
      expect(born.holdPoint).toBeUndefined();
      expect(fineDistance2(born, queenTile(q))).toBeLessThanOrEqual(2 * state.config.nestDeliverTiles ** 2);

      // It walks: every tick it is still walking, it is closer to the spawn tile.
      let distance = Math.hypot(born.x - (spawn.tileX + 0.5) * SUB, born.y - (spawn.tileY + 0.5) * SUB);
      const radius = ARRIVAL_FINE_TILES[caste];
      for (;;) {
        const before = antById(state, born.id)!;
        const next = step(state).state;
        const ant = antById(next, born.id)!;
        if (ant.spawnWalk === undefined) {
          // Arrival is decided from the tick's starting position, on entering the radius.
          expect(fineDistance2(before, spawn)).toBeLessThanOrEqual(radius * radius);
          expect(ant.holdPoint).toEqual(caste === "soldier" ? spawn : undefined);
          break;
        }
        expect(fineDistance2(before, spawn)).toBeGreaterThan(radius * radius);
        expect(ant.carrying).toBe(false);
        const now = Math.hypot(ant.x - (spawn.tileX + 0.5) * SUB, ant.y - (spawn.tileY + 0.5) * SUB);
        expect(now).toBeLessThan(distance);
        distance = now;
        state = next;
      }
    });

    it(`an arrived ${caste} starts its rules-27 defaults that tick, exactly as a free ${caste} at the same spot`, () => {
      const config = rules27({ foodPatches: [{ tileX: 60, tileY: 30, radius: 3, perTile: 5 }] });
      const walker = seated(config);
      const q = queen(walker);
      const spawn = { tileX: queenTile(q).tileX + 30, tileY: queenTile(q).tileY - 8 };
      q.spawnPoint = spawn;
      walker.colonies[0].seenFood = walker.food.flatMap((food, index) => food > 0 ? [index] : []);
      // Inside the arrival radius: a worker 1 tile diagonally off (2 <= 2*2), a soldier at (5, -3) (34 <= 6*6).
      const at = caste === "worker" ? { tileX: spawn.tileX + 1, tileY: spawn.tileY + 1 } : { tileX: spawn.tileX + 5, tileY: spawn.tileY - 3 };
      expect(Math.sqrt((at.tileX - spawn.tileX) ** 2 + (at.tileY - spawn.tileY) ** 2)).toBeLessThanOrEqual(ARRIVAL_FINE_TILES[caste]);
      const ant = addAnt(walker, 0, at.tileX, at.tileY, { caste, role: caste === "soldier" ? "fighter" : "forager",
        spawnWalk: { queenId: q.id, ...spawn } });
      const free = cloneState(walker);
      const twin = antById(free, ant.id)!;
      delete twin.spawnWalk;
      if (caste === "soldier") twin.holdPoint = spawn;

      let a = walker, b = free;
      for (let i = 0; i < 40; i++) {
        const left = step(a), right = step(b);
        expect(left.state).toEqual(right.state);
        expect(left.events).toEqual(right.events);
        a = left.state; b = right.state;
      }
      expect(antById(a, ant.id)!.spawnWalk).toBeUndefined();
      expect(antById(a, ant.id)!.holdPoint).toEqual(caste === "soldier" ? spawn : undefined);
    });
  }

  it("an arrived soldier with no enemy in sight then holds within 3 tiles (6 fine tiles) of the spawn tile", () => {
    let state = seated();
    brood(state, "soldier");
    const q = queen(state);
    const spawn = { tileX: queenTile(q).tileX + 40, tileY: queenTile(q).tileY - 12 };
    q.spawnPoint = spawn;
    const hatched = hatchOne(state);
    const id = hatched.born[0]!.id;
    expect(hatched.born[0]!.caste).toBe("soldier");
    state = walkUntilArrival(hatched.state, id).after;
    expect(antById(state, id)!.holdPoint).toEqual(spawn);
    expect(state.ants.filter((ant) => ant.colony === 1)).toHaveLength(0);
    // 3 reference tiles at grid scale 2, stated explicitly rather than read from localAnts.defendTiles.
    const HOLD_FINE_TILES = 6;
    for (let i = 0; i <= 300; i++) {
      expect(fineDistance2(antById(state, id)!, spawn)).toBeLessThanOrEqual(HOLD_FINE_TILES ** 2);
      state = step(state).state;
    }
    expect(antById(state, id)!.holdPoint).toEqual(spawn);
  });

  it("a walker just outside its radius keeps walking instead of starting its defaults", () => {
    const state = seated(rules27({ foodPatches: [{ tileX: 60, tileY: 30, radius: 3, perTile: 5 }] }));
    const q = queen(state);
    const spawn = { tileX: queenTile(q).tileX + 30, tileY: queenTile(q).tileY - 8 };
    // 3 fine tiles off: outside a worker's 2, inside a soldier's 6.
    const worker = addAnt(state, 0, spawn.tileX + 3, spawn.tileY, { spawnWalk: { queenId: q.id, ...spawn } });
    const soldier = addAnt(state, 0, spawn.tileX - 7, spawn.tileY, { caste: "soldier", role: "fighter", spawnWalk: { queenId: q.id, ...spawn } });
    const next = step(state).state;
    expect(antById(next, worker.id)!.spawnWalk).toEqual({ queenId: q.id, ...spawn });
    expect(antById(next, worker.id)!.x).toBeLessThan(worker.x);
    expect(antById(next, soldier.id)!.spawnWalk).toEqual({ queenId: q.id, ...spawn });
    expect(antById(next, soldier.id)!.holdPoint).toBeUndefined();
    expect(antById(next, soldier.id)!.x).toBeGreaterThan(soldier.x);
  });

  it("ants hatched before the spawn point was set, and ants of a queen without one, start at the nest", () => {
    let state = seated();
    brood(state, "worker");
    // A second live queen with no spawn point, 20 fine tiles south of the first.
    const first = queen(state);
    const maxId = Math.max(...state.colonies[0].queens!.map((q) => q.id));
    state.colonies[0].queens!.push({ ...first, id: maxId + 1, queenY: first.queenY + 20 * SUB, starting: undefined });
    const second = queen(state, 1);
    expect(second.spawnPoint).toBeUndefined();

    // Before any spawn point: newborns start at their nest.
    state.colonies[0].foodStore = 2 * state.config.hatchCost;
    let early: Ant[] = [];
    for (let i = 0; early.length < 2 && i < 50; i++) {
      state = step(state).state;
      early = state.ants.filter((ant) => ant.colony === 0);
    }
    expect(early).toHaveLength(2);
    for (const ant of early) expect(ant.spawnWalk).toBeUndefined();

    // Setting one queen's spawn point now does not route the ants already hatched.
    const spawn = { tileX: queenTile(first).tileX + 40, tileY: queenTile(first).tileY };
    const routed = cloneState(state);
    queen(routed).spawnPoint = spawn;
    let unrouted = state;
    let current = routed;
    const strip = (s: SimState) => ({ ...s, colonies: s.colonies.map((c) => ({ ...c,
      queens: c.queens?.map(({ spawnPoint: _spawnPoint, ...q }) => q) })) });
    for (let i = 0; i < 60; i++) {
      current = step(current).state;
      unrouted = step(unrouted).state;
      expect(strip(current)).toEqual(strip(unrouted));
    }
    for (const ant of early) expect(antById(current, ant.id)!.spawnWalk).toBeUndefined();

    // Both queens hatch again: only the one with a spawn point routes her newborn.
    current.colonies[0].foodStore = 2 * current.config.hatchCost;
    const known = new Set(current.ants.map((ant) => ant.id));
    let later: Ant[] = [];
    for (let i = 0; later.length < 2 && i < 50; i++) {
      current = step(current).state;
      later = current.ants.filter((ant) => !known.has(ant.id) && ant.colony === 0);
    }
    expect(later).toHaveLength(2);
    const near = (ant: Ant, q: QueenState) => fineDistance2(ant, queenTile(q)) <= 2 * current.config.nestDeliverTiles ** 2;
    const fromFirst = later.find((ant) => near(ant, first))!, fromSecond = later.find((ant) => near(ant, second))!;
    expect(fromFirst.spawnWalk).toEqual({ queenId: first.id, ...spawn });
    expect(fromSecond.spawnWalk).toBeUndefined();
  });

  it("moving or clearing the spawn point changes only where later hatchlings go", () => {
    let state = seated();
    brood(state, "worker");
    const q = queen(state);
    const home = queenTile(q);
    const first = { tileX: home.tileX + 40, tileY: home.tileY - 12 };
    const moved = { tileX: home.tileX + 16, tileY: home.tileY + 20 };
    q.spawnPoint = first;
    const a = hatchOne(state);
    const walkerA = a.born[0]!;
    expect(walkerA.spawnWalk).toEqual({ queenId: q.id, ...first });

    // Move: A keeps walking to the first tile; the next hatchling walks to the new one.
    state = a.state;
    queen(state).spawnPoint = moved;
    const b = hatchOne(state);
    const walkerB = b.born[0]!;
    expect(walkerB.spawnWalk).toEqual({ queenId: q.id, ...moved });
    expect(antById(b.state, walkerA.id)!.spawnWalk).toEqual({ queenId: q.id, ...first });

    // Clear: the next hatchling starts at the nest; A and B finish their walks.
    state = b.state;
    delete queen(state).spawnPoint;
    const c = hatchOne(state);
    expect(c.born[0]!.spawnWalk).toBeUndefined();
    state = c.state;
    expect(antById(state, walkerA.id)!.spawnWalk).toEqual({ queenId: q.id, ...first });
    expect(antById(state, walkerB.id)!.spawnWalk).toEqual({ queenId: q.id, ...moved });

    for (const [id, target, other] of [[walkerA.id, first, moved], [walkerB.id, moved, first]] as const) {
      const arrived = walkUntilArrival(state, id);
      const ant = antById(arrived.before, id)!;
      expect(fineDistance2(ant, target)).toBeLessThanOrEqual(ARRIVAL_FINE_TILES.worker ** 2);
      expect(fineDistance2(ant, other)).toBeGreaterThan(ARRIVAL_FINE_TILES.worker ** 2);
      expect(queen(arrived.after).spawnPoint).toBeUndefined();
    }
  });

  it("walks around the map's terrain to the spawn tile", () => {
    const terrain = withGridScale(recordedHousePlan(rulesConfig("redesign"))).terrain;
    let state = seated(rules27({ terrain }));
    expect(state.terrain).toBeDefined();
    brood(state, "worker");
    const q = queen(state);
    const mask = passableMask(state.config, state.terrain!);
    const { mapWidth: width, mapHeight: height } = state.config;
    // The first passable tile (row-major) within 60 fine tiles whose straight line from the queen crosses terrain.
    let spawn: { tileX: number; tileY: number } | undefined;
    for (let y = 0; y < height && spawn === undefined; y++) for (let x = 0; x < width && spawn === undefined; x++) {
      if (!mask[y * width + x] || (x - queenTile(q).tileX) ** 2 + (y - queenTile(q).tileY) ** 2 > 60 ** 2) continue;
      if (!segmentOnLand(state.config, state.terrain, q.queenX, q.queenY, (x + 0.5) * SUB, (y + 0.5) * SUB)) spawn = { tileX: x, tileY: y };
    }
    expect(spawn).toBeDefined();
    q.spawnPoint = spawn!;
    const hatched = hatchOne(state);
    state = hatched.state;
    const arrived = walkUntilArrival(state, hatched.born[0]!.id, 1200);
    expect(fineDistance2(antById(arrived.before, hatched.born[0]!.id)!, spawn!)).toBeLessThanOrEqual(ARRIVAL_FINE_TILES.worker ** 2);
  });

  it("while the colony has no active seat its spawn point routes no hatchlings; routing resumes when a seat is active again", () => {
    // Command-idle lapse on step()'s houseActive=false path.
    let state = seated(rules27({ commandIdleTicks: 40, commandFloorTicks: 1 }));
    brood(state, "worker");
    const q = queen(state);
    const spawn = { tileX: queenTile(q).tileX + 60, tileY: queenTile(q).tileY };
    q.spawnPoint = spawn;

    // A walker hatched while seated is still walking when the last seat lapses.
    const hatched = hatchOne(state);
    const walker = hatched.born[0]!;
    expect(walker.spawnWalk).toEqual({ queenId: q.id, ...spawn });
    state = hatched.state;
    while (!state.agents[0]!.idle) {
      expect(antById(state, walker.id)!.spawnWalk).toBeDefined();
      state = step(state).state;
    }
    // The lapse tick's house phase ends the walk; house-bot planning takes the ant, no hold point.
    expect(localRulesSide(state, 0)).toBe(false);
    expect(antById(state, walker.id)!.spawnWalk).toBeUndefined();
    expect(antById(state, walker.id)!.holdPoint).toBeUndefined();

    // While idle, the stored spawn point routes no hatchling.
    const idle = hatchOne(state);
    expect(idle.born[0]!.spawnWalk).toBeUndefined();
    state = idle.state;
    expect(queen(state).spawnPoint).toEqual(spawn);

    // An accepted command reactivates the seat: later hatchlings walk to the stored point; earlier ants do not resume.
    const woken = step(state, [wake]);
    expect(woken.results[0]!.ok).toBe(true);
    state = woken.state;
    expect(state.agents[0]!.idle).toBe(false);
    expect(localRulesSide(state, 0)).toBe(true);
    brood(state, "worker");
    const later = hatchOne(state);
    expect(later.born[0]!.spawnWalk).toEqual({ queenId: q.id, ...spawn });
    for (const id of [walker.id, idle.born[0]!.id]) expect(antById(later.state, id)!.spawnWalk).toBeUndefined();
  });
});
