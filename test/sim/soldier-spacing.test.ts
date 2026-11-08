import { describe, expect, it } from 'vitest';
import { SUB, rulesConfig, speedPerTick, type SimConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { threeMapRotation } from './three-map-rotation.js';
import { createMatch, newAnt, buildGrid } from '../../src/sim/map.js';
import { beginLocalGoals } from '../../src/sim/localArrival.js';
import { countMarkDirection } from '../../src/sim/agents.js';
import { advanceSoftAnts, step } from '../../src/sim/step.js';
import { applySoftSeparation } from '../../src/sim/softSeparation.js';
import { isPassable } from '../../src/sim/terrain.js';
import type { Caste, CountVerb, SimState } from '../../src/sim/types.js';

function liveConfig(): SimConfig { return threeMapRotation(newMatchConfig(rulesConfig('redesign'))); }
function scene(count: number, verb: CountVerb, config: SimConfig, caste: Caste = 'soldier') {
  const state = createMatch(7001, { ...config, startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] });
  state.ants = [];
  state.marks = [{ id: 1, agentId: 'spacing', colony: 0, tileX: 40, tileY: 40, words: [], laidTick: 0, steering: 0, verb, count }];
  for (let i = 0; i < count; i++) {
    const ant = newAnt(state.config, state.nextAntId++, 0, 40500, 40500, caste);
    ant.claim = 1; state.ants.push(ant);
  }
  return state;
}
function positions(state: SimState) { return state.ants.map(ant => [ant.id, ant.x, ant.y]); }
function phase(state: SimState) {
  beginLocalGoals(state);
  const grid = buildGrid(state);
  const dirs = new Map(state.ants.map(ant => [ant.id, countMarkDirection(state, grid, [], ant, state.marks[0]!).dir]));
  const frame = advanceSoftAnts(state, dirs, new Set());
  for (const ant of state.ants) {
    const origin = frame.origins.get(ant.id)!;
    expect(Math.hypot(ant.x - origin.x, ant.y - origin.y)).toBeLessThanOrEqual(speedPerTick(state.config));
  }
  state.tick++;
}
function medianNeighbour(state: SimState) {
  const distances = state.ants.map(ant => Math.min(...state.ants.filter(other => other.id !== ant.id)
    .map(other => Math.hypot(ant.x - other.x, ant.y - other.y) / (SUB * 2)))).sort((a, b) => a - b);
  return (distances[14]! + distances[15]!) / 2;
}
/**
 * House-only ticks of a live match, each timed, with every ant held to its native speed. The first step a process
 * ever runs pays its one-off cold start (lazy compilation), 55-67 ms locally and over 100 ms on a 2-CPU CI runner, against
 * about 8 ms for nearly every later tick. The test guards what a tick costs, not that start-up, so a separate match warms the
 * step path first; the timed match's own first tick stays timed. `hold` busy-waits inside one timed tick (forcing only).
 */
function houseTicks(ticks: number, hold?: { tick: number; holdMs: number }) {
  const live = liveConfig();
  let warm = createMatch(7, live);
  for (let tick = 0; tick < 20; tick++) warm = step(warm).state;
  let state = createMatch(1427628562, live), antTicks = 0;
  const timings: number[] = [], budgetMs = 1000 / live.ticksPerSecond;
  for (let tick = 0; tick < ticks; tick++) {
    const origins = new Map(state.ants.map(ant => [ant.id, { x: ant.x, y: ant.y }]));
    const started = performance.now();
    state = step(state).state;
    if (hold?.tick === tick) while (performance.now() - started < hold.holdMs);
    timings.push(performance.now() - started);
    for (const ant of state.ants) {
      const origin = origins.get(ant.id); if (origin === undefined) continue;
      expect(Math.hypot(ant.x - origin.x, ant.y - origin.y)).toBeLessThanOrEqual(speedPerTick(live)); antTicks++;
    }
  }
  return { state, antTicks, timings, budgetMs };
}
/** Every timed tick within the live budget; a failure names the slowest tick and its time. */
function expectWithinBudget({ timings, budgetMs }: { timings: number[]; budgetMs: number }) {
  const maxTickMs = Math.max(...timings), slowestTick = timings.indexOf(maxTickMs);
  expect(maxTickMs, `tick ${slowestTick} took ${maxTickMs} ms, live budget ${budgetMs} ms`).toBeLessThan(budgetMs);
}
describe('organic cluster shared by workers and soldiers', () => {
  const groups = [
    ['soldier', 'DEFEND'], ['soldier', 'ATTACK'],
    ['worker', 'GATHER'], ['worker', 'DEFEND'], ['worker', 'ATTACK'],
  ] as const;
  it.each(groups)('30 %s ants sent to %s settle a body width apart and stay still', (caste, verb) => {
    const state = scene(30, verb, liveConfig(), caste);
    for (let tick = 0; tick < 400; tick++) phase(state);
    const median = medianNeighbour(state);
    console.log(`organic-cluster/${caste}/${verb}: median ${median} original tiles`);
    expect(median).toBeGreaterThanOrEqual(0.6); expect(median).toBeLessThanOrEqual(1.0);
    expect(new Set(state.ants.map(ant => `${ant.x},${ant.y}`)).size).toBe(30);
    for (const ant of state.ants) {
      expect([ant.x, ant.y]).toEqual([ant.pointRest!.x, ant.pointRest!.y]);
      expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    }
    const settled = positions(state);
    for (let tick = 0; tick < 100; tick++) { phase(state); expect(positions(state)).toEqual(settled); }
  });
  it('gives 30 workers the exact same resting geometry as 30 soldiers', () => {
    const workers = scene(30, 'GATHER', liveConfig(), 'worker');
    const soldiers = scene(30, 'GATHER', liveConfig(), 'soldier');
    for (let tick = 0; tick < 400; tick++) { phase(workers); phase(soldiers); }
    expect(positions(workers)).toEqual(positions(soldiers));
  });
  it.each([[1, 'soldier'], [30, 'soldier'], [30, 'worker']] as const)(
    'caps actual displacement for %i moving %s ants, both piled and spread', (count, caste) => {
      for (const spread of [false, true]) {
        const state = scene(count, 'ATTACK', liveConfig(), caste);
        for (const [i, ant] of state.ants.entries()) {
          ant.x = 20500 + (spread ? i % 6 * 1600 : 0);
          ant.y = 40500 + (spread ? Math.floor(i / 6) * 1600 : 0);
        }
        for (let tick = 0; tick < 160; tick++) phase(state);
      }
    });
  it('stays within native speed and the live tick budget during 3,000 house-only ticks', () => {
    const run = houseTicks(3000);
    expect(run.state.tick).toBe(3000); expect(run.antTicks).toBeGreaterThan(0);
    const sorted = [...run.timings].sort((a, b) => a - b);
    console.info('Organic house tick timing', JSON.stringify({ ticks: run.state.tick, antTicks: run.antTicks, budgetMs: run.budgetMs,
      p99TickMs: sorted[Math.ceil(sorted.length * 0.99) - 1], maxTickMs: sorted.at(-1),
      overBudget: sorted.filter(ms => ms >= run.budgetMs).length }));
    expectWithinBudget(run);
  }, 120000);
  it('still fails the live tick budget when a warmed tick is slow (forcing)', () => {
    // The warm-up hides only the process's cold start: a timed tick held past the budget fails, named by its index.
    const run = houseTicks(200, { tick: 100, holdMs: 110 });
    expect(() => expectWithinBudget(run)).toThrow(/^tick 100 took 1\d\d\.?\d* ms, live budget 100 ms/);
  }, 120000);
});
it('preserves worker–worker soft motion outside point arrival', () => {
  const live = liveConfig(), { soldierRadius: _radius, ...oldSoft } = live.softSeparation!;
  const current = scene(30, 'GATHER', live, 'worker'), prior = scene(30, 'GATHER', { ...live, softSeparation: oldSoft }, 'worker');
  for (let t = 0; t < 50; t++) for (const state of [current, prior]) {
    applySoftSeparation(state, new Map(state.ants.map(ant => [ant.id, { x: ant.x, y: ant.y }])));
  }
  expect(current.ants).toEqual(prior.ants);
});
