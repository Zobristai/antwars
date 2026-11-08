import { describe, expect, it } from 'vitest';
import { rulesConfig, speedPerTick, SUB, type SimConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { houseDirection } from '../../src/sim/houseBot.js';
import { beginLocalGoals, currentLocalGoals, notePoint } from '../../src/sim/localArrival.js';
import { buildGrid, cloneState, createMatch, newAnt } from '../../src/sim/map.js';
import { advanceSoftAnts } from '../../src/sim/step.js';
import { toward } from '../../src/sim/forage.js';
import { isPassable } from '../../src/sim/terrain.js';
import type { Ant, SimState } from '../../src/sim/types.js';

// Frozen movement settings from pre-arrival main ba280fb7324e1ea90f0a100b89b2990c531100cc.
const { pointArrival: _pointArrival, ...preArrivalBase } = rulesConfig('redesign');
const PRE_ARRIVAL_CONFIG: SimConfig = Object.freeze({ ...preArrivalBase, softSeparation: Object.freeze({
  radius: 100, strength: 1600, maxStep: 200, arrivalSubunits: 300, epsilon: 1, arrivalLinkRadius: 150,
}) });

// Every match plays at grid scale 2: every length below is the reference length doubled.
function scene(scale: 2 = 2, base: SimConfig = rulesConfig('redesign')) {
  const config = { ...newMatchConfig(base), startAnts: 0, terrain: undefined,
    foodLayout: undefined, foodPatches: [] };
  const state = createMatch(6006, config);
  state.ants = []; state.food.fill(0);
  return state;
}
function guard(state: SimState, id: number, offset = 0): Ant {
  const queen = state.colonies[0].queens![0]!;
  const ant = newAnt(state.config, id, 0, queen.queenX + offset, queen.queenY, 'soldier');
  ant.role = 'guard'; ant.guardQueenId = queen.id; state.ants.push(ant);
  return ant;
}
function phase(state: SimState) {
  beginLocalGoals(state);
  const grid = buildGrid(state);
  const directions = new Map(state.ants.map(ant => [ant.id, houseDirection(state, grid, [], ant)]));
  return advanceSoftAnts(state, directions, new Set());
}
const positions = (state: SimState) => state.ants.map(a => [a.id, a.x, a.y, a.vx, a.vy]).sort((a, b) => a[0]! - b[0]!);

describe('current guard-post arrival under crowd spacing', () => {
  it.each([2] as const)('keeps native and linked post guards settled at grid scale %i', scale => {
    const state = scene(scale, PRE_ARRIVAL_CONFIG), root = guard(state, 4, 280 * scale), linked = guard(state, 13, 400 * scale);
    guard(state, 22, 280 * scale);
    const before = state.ants.map(a => [a.x, a.y]);
    for (let tick = 0; tick < 80; tick++) {
      state.tick = tick;
      const frame = phase(state);
      expect(frame.arrivals.get(root.id)?.native).toBe(true);
      expect(frame.arrivals.get(linked.id)).toMatchObject({ arrived: true, native: false });
      expect(frame.goals.get(linked.id)?.guardPost).toBe(true);
      expect(state.ants.map(a => [a.x, a.y])).toEqual(before);
      expect(state.ants.every(a => a.vx === 0 && a.vy === 0)).toBe(true);
    }
  });

  it('releases a linked guard when its current native root disappears', () => {
    const state = scene(), root = guard(state, 4, 560), linked = guard(state, 13, 800);
    phase(state);
    state.ants = state.ants.filter(a => a.id !== root.id);
    state.tick++;
    const before = linked.x, frame = phase(state);
    expect(frame.arrivals.get(linked.id)?.arrived).toBe(false);
    expect(linked.x).toBeLessThan(before);
  });

  it('responds to a moved post without retaining a stale arrival flag', () => {
    const state = scene(), ant = guard(state, 4);
    phase(state);
    const before = ant.x;
    const queen = state.colonies[0].queens![0]!;
    state.colonies[0].queens![0] = { ...queen, queenX: queen.queenX + 8000 };
    state.tick++;
    const frame = phase(state);
    expect(frame.goals.get(ant.id)?.guardPost).toBe(true);
    expect(frame.arrivals.get(ant.id)?.arrived).toBe(false);
    expect(ant.x).toBeGreaterThan(before);
  });

  it('responds to a real enemy after the existing assignment hold, and returns after it dies', () => {
    const state = scene(), ant = guard(state, 4);
    phase(state);
    const enemy = newAnt(state.config, 100, 1, ant.x + 6000, ant.y, 'soldier');
    state.ants.push(enemy);
    state.tick = 2 * state.config.ticksPerSecond;
    const before = ant.x, frame = phase(state);
    expect(frame.goals.get(ant.id)?.kind).toBe('combat');
    expect(frame.goals.get(ant.id)?.guardPost).toBeUndefined();
    expect(ant.x).toBeGreaterThan(before);
    state.ants = [ant]; state.tick++;
    expect(phase(state).goals.get(ant.id)?.guardPost).toBe(true);
  });

  it('does not tag adjacent combat or fighter rally goals as guard posts', () => {
    const state = scene(), ant = guard(state, 4);
    state.ants.push(newAnt(state.config, 100, 1, ant.x + 200, ant.y, 'soldier'));
    expect(phase(state).goals.get(ant.id)?.guardPost).toBeUndefined();
    state.ants = [ant]; ant.role = 'fighter'; state.tick++;
    expect(phase(state).goals.get(ant.id)?.guardPost).toBeUndefined();
  });

  it('keeps ordinary point goals spreading even when an ant still has the guard role', () => {
    const state = scene(), a = guard(state, 4), b = guard(state, 13);
    const x = a.x, y = a.y;
    beginLocalGoals(state);
    for (const ant of state.ants) notePoint(state, ant, x, y);
    advanceSoftAnts(state, new Map(state.ants.map(a => [a.id, { x: 0, y: 0 }])), new Set());
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
  });

  it('is order independent and does not turn stationary guards into impassable bodies', () => {
    const state = scene();
    for (let id = 4; id < 184; id += 9) guard(state, id);
    const reversed = cloneState(state); reversed.ants.reverse();
    phase(state); phase(reversed);
    expect(positions(state)).toEqual(positions(reversed));
    const queen = state.colonies[0].queens![0]!;
    const traveler = newAnt(state.config, 1000, 0, queen.queenX - 4000, queen.queenY, 'worker');
    state.ants.push(traveler);
    for (let tick = 0; tick < 100; tick++) {
      state.tick = tick; beginLocalGoals(state);
      const grid = buildGrid(state);
      const dirs = new Map(state.ants.map(ant => [ant.id, ant.id === traveler.id
        ? toward(ant, queen.queenX + 6000, queen.queenY, state) : houseDirection(state, grid, [], ant)]));
      expect(currentLocalGoals(state).get(traveler.id)?.guardPost).toBeUndefined();
      advanceSoftAnts(state, dirs, new Set());
    }
    expect(traveler.x).toBeGreaterThan(queen.queenX + 4000);
  });
});

describe('rules-25 independent guard resting places', () => {
  it.each([2] as const)('settles within the declared config bound at grid scale %i', scale => {
    const state = scene(scale);
    guard(state, 4, 280 * scale); guard(state, 13, 400 * scale); guard(state, 22, 280 * scale);
    const { config } = state, rules = config.pointArrival!, soft = config.softSeparation!;
    const nativeSpeed = speedPerTick(config), progress = nativeSpeed - 2;
    expect(progress).toBeGreaterThan(0);
    const restRadius = (Math.ceil(Math.sqrt(3)) + 1) * rules.pitch;
    const initialRange = soft.arrivalSubunits + soft.arrivalLinkRadius;
    // Manhattan travel allowance, integer rounding, then decision-frame handoff.
    const arrivalTicks = Math.ceil(2 * (initialRange + restRadius) / progress) + 2;
    const stillTicks = 5 * config.ticksPerSecond;
    const assigned = new Map<number, { x: number; y: number }>();
    const reached = new Map<number, number>(), stationary = new Map<number, number>();
    for (let tick = 0; tick < arrivalTicks + stillTicks; tick++) {
      state.tick = tick;
      const frame = phase(state);
      for (const ant of state.ants) {
        const label = `scale=${scale} tick=${tick} ant=${ant.id}`;
        const goal = frame.decisionGoals.get(ant.id)!;
        expect(goal, label).toMatchObject({ kind: 'point', guardPost: true });
        expect(frame.pointRests.has(ant.id), label).toBe(true);
        const rest = frame.pointRests.get(ant.id)!, origin = frame.origins.get(ant.id)!;
        if (tick === 0) {
          expect((origin.x - goal.x!) ** 2 + (origin.y - goal.y!) ** 2, label).toBeLessThanOrEqual(initialRange ** 2);
          assigned.set(ant.id, { ...rest });
        }
        expect(rest, label).toMatchObject(assigned.get(ant.id)!);
        expect((rest.x - goal.x!) ** 2 + (rest.y - goal.y!) ** 2, label).toBeLessThanOrEqual(restRadius ** 2);
        expect(isPassable(state, Math.floor(rest.x / SUB), Math.floor(rest.y / SUB)), label).toBe(true);
        expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)), label).toBe(true);
        expect((ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2, label).toBeLessThanOrEqual(nativeSpeed ** 2);
        if (ant.x === rest.x && ant.y === rest.y && !reached.has(ant.id)) reached.set(ant.id, tick + 1);
        if (origin.x === rest.x && origin.y === rest.y) {
          expect([ant.x, ant.y, ant.vx, ant.vy], label).toEqual([rest.x, rest.y, 0, 0]);
          expect(frame.arrivals.get(ant.id), label).toMatchObject({ arrived: true, native: true,
            rootId: ant.id, parentId: null, hops: 0 });
          stationary.set(ant.id, (stationary.get(ant.id) ?? 0) + 1);
        }
        if (tick + 1 >= arrivalTicks) {
          expect(reached.get(ant.id), `${label} deadline=${arrivalTicks} position=${ant.x},${ant.y} rest=${rest.x},${rest.y}`).toBeDefined();
          expect(reached.get(ant.id)!, label).toBeLessThanOrEqual(arrivalTicks);
          expect([ant.x, ant.y], label).toEqual([rest.x, rest.y]);
        }
      }
      const sites = [...assigned.values()];
      expect(sites).toHaveLength(3);
      for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
        expect((sites[i]!.x - sites[j]!.x) ** 2 + (sites[i]!.y - sites[j]!.y) ** 2)
          .toBeGreaterThanOrEqual(rules.minimumSpacing ** 2);
      }
    }
    for (const ant of state.ants) expect(stationary.get(ant.id) ?? 0, `ant=${ant.id}`).toBeGreaterThanOrEqual(stillTicks);
    console.log(JSON.stringify({ scale, arrivalTicks, stillTicks, reached: [...reached], stationary: [...stationary] }));
  });
});
