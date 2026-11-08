import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { rulesConfig, speedPerTick, SUB, type SimConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { foodTiles } from '../../src/sim/forage.js';
import { houseDirection, rebalanceRoles } from '../../src/sim/houseBot.js';
import { beginLocalGoals } from '../../src/sim/localArrival.js';
import { activeQueens, buildGrid, cloneState, createMatch } from '../../src/sim/map.js';
import { advanceSoftAnts, step } from '../../src/sim/step.js';
import { isPassable } from '../../src/sim/terrain.js';
import type { SimState } from '../../src/sim/types.js';
import { sevenMapRotation } from './seven-map-rotation.js';

// Frozen movement settings from pre-arrival main ba280fb7324e1ea90f0a100b89b2990c531100cc.
const { pointArrival: _pointArrival, ...preArrivalBase } = rulesConfig('redesign');
const PRE_ARRIVAL_CONFIG: SimConfig = Object.freeze({ ...preArrivalBase, softSeparation: Object.freeze({
  radius: 100, strength: 1600, maxStep: 200, arrivalSubunits: 300, epsilon: 1, arrivalLinkRadius: 150,
}) });

// Candidate-side reproduction of the guard selections captured at
// 59ed9a6. The captured BEFORE is
// reused, not re-executed; trajectories/populations may differ after the fix.
function probe(previous: SimState) {
  const state = cloneState(previous);
  beginLocalGoals(state); rebalanceRoles(state);
  const grid = buildGrid(state), food = foodTiles(state);
  const directions = new Map(state.ants.map(a => [a.id, houseDirection(state, grid, food, a)]));
  const frame = advanceSoftAnts(state, directions, new Set(state.ants.filter(a => a.role === 'forager').map(a => a.id)));
  return { state, frame };
}

describe('seeded guard settling evidence', () => {
  it.each(['central-lake', 'three-crossings'] as const)('%s runs 7200 ordinary offline steps', mapId => {
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    const base = sevenMapRotation(newMatchConfig(PRE_ARRIVAL_CONFIG));
    const config = { ...base, terrain: { ...base.terrain!, mapId } };
    const scale = config.gridScale ?? 1;
    let state = createMatch(6006, config), eligibleIds = new Set<number>();
    const lastVelocity = new Map<number, { vx: number; vy: number }>();
    const reversals = new Map<number, number>();
    let eligibleAntTicks = 0, totalSpeed = 0, parityAnts = 0, heldPostTicks = 0, linkedPostTicks = 0;
    let continuedPosts = 0, linkedContinuedPosts = 0;
    const priorHeld = new Map<number, { key: string; x: number; y: number; linked: boolean }>();
    const selectedId = mapId === 'central-lake' ? 265 : 175;
    const trace: unknown[] = [];
    for (let t = 1; t <= 7200 && state.result === null; t++) {
      const previous = state;
      // Observe the same ordinary match before the late diagnostic windows too,
      // until a linked guard has demonstrably stayed at its post across ticks.
      const diagnostic = (mapId === 'central-lake' && linkedContinuedPosts === 0)
        || (previous.tick >= 4780 && previous.tick <= 4830)
        || (previous.tick >= 5100 && previous.tick < 5200);
      const observation = diagnostic ? probe(previous) : undefined;
      state = step(previous).state;
      assert.equal(state.tick, t); assert.equal(state.agents.length, 0);
      if (observation) {
        const surviving = new Map(state.ants.map(a => [a.id, a]));
        for (const ant of observation.state.ants) {
          const ordinary = surviving.get(ant.id);
          if (ordinary) {
            assert.deepEqual([ant.x, ant.y, ant.vx, ant.vy], [ordinary.x, ordinary.y, ordinary.vx, ordinary.vy]);
            parityAnts++;
          }
          const frame: ReturnType<typeof advanceSoftAnts> = observation.frame;
          const goal = frame.goals.get(ant.id), arrival = frame.arrivals.get(ant.id);
          const origin: { x: number; y: number } = frame.origins.get(ant.id)!;
          if (goal?.guardPost && arrival?.arrived) {
            heldPostTicks++;
            if (!arrival.native) linkedPostTicks++;
            assert.deepEqual([ant.x, ant.y, ant.vx, ant.vy], [origin.x, origin.y, 0, 0]);
            const held = priorHeld.get(ant.id);
            if (held !== undefined && held.key === goal.key && held.x === origin.x && held.y === origin.y) {
              continuedPosts++;
              if (held.linked && !arrival.native) linkedContinuedPosts++;
            }
            priorHeld.set(ant.id, { key: goal.key, x: ant.x, y: ant.y, linked: !arrival.native });
          } else priorHeld.delete(ant.id);
          if (previous.tick <= 4830 && ant.id === selectedId) trace.push({
            decisionTick: previous.tick, id: ant.id, post: goal?.guardPost ?? false,
            goal: goal?.key ?? null, arrived: arrival?.arrived ?? false, native: arrival?.native ?? false,
            origin: [origin.x, origin.y], velocity: [ant.vx, ant.vy],
          });
        }
      } else priorHeld.clear();
      if (t === 4800) eligibleIds = new Set(state.ants.filter(a => a.role === 'guard').map(a => a.id));
      if (t >= 5101 && t <= 5200) {
        for (const ant of state.ants) {
          const queen = activeQueens(state.colonies[ant.colony]).find(q => q.id === ant.guardQueenId);
          const id = state.config.colonyMirror ? ant.id - ant.colony : ant.id;
          const side = state.config.colonyMirror && ant.colony === 1 ? -1 : 1;
          const x = queen && queen.queenX + ((id % 3) - 1) * SUB * scale * side;
          const y = queen && queen.queenY + ((Math.trunc(id / 3) % 3) - 1) * SUB * scale;
          const eligible = eligibleIds.has(ant.id) && ant.role === 'guard' && x !== undefined && y !== undefined
            && Math.hypot(ant.x - x, ant.y - y) <= 1000 * scale;
          if (!eligible) { lastVelocity.delete(ant.id); continue; }
          const last = lastVelocity.get(ant.id);
          if (last && last.vx * ant.vx + last.vy * ant.vy < 0) reversals.set(ant.id, (reversals.get(ant.id) ?? 0) + 1);
          lastVelocity.set(ant.id, { vx: ant.vx, vy: ant.vy }); // zeros break adjacency, as in the fixture
          eligibleAntTicks++; totalSpeed += Math.hypot(ant.vx, ant.vy);
        }
      }
    }
    assert(heldPostTicks > 0); assert(linkedPostTicks > 0); assert(continuedPosts > 0); assert(parityAnts > 0);
    if (mapId === 'central-lake') assert(linkedContinuedPosts > 0);
    console.log(JSON.stringify({ mapId, seed: 6006, ticks: state.tick, gridScale: config.gridScale,
      before: mapId === 'central-lake' ? { totalReversals: 1295, guardsAtLeast10: 49 } : { totalReversals: 1074, guardsAtLeast10: 36 },
      lateGuardWindow: { resultTicks: [5101, 5200], eligibleAtTick4800: eligibleIds.size,
        totalReversals: [...reversals.values()].reduce((a, b) => a + b, 0),
        guardsAtLeast10: [...reversals.values()].filter(n => n >= 10).length,
        eligibleAntTicks, meanSpeed: totalSpeed / eligibleAntTicks },
      phaseParity: { survivingAntPositionsAndVelocities: parityAnts, mismatches: 0 },
      settling: { heldPostTicks, linkedPostTicks, continuedPosts, linkedContinuedPosts }, selectedGuardTrace: trace }));
  }, 240_000);
});

interface GuardEpisode {
  readonly goal: string;
  readonly x: number;
  readonly y: number;
  reached: boolean;
}
interface InitialGuard extends GuardEpisode {
  readonly colony: number;
  reachedTick?: number;
  stationary: number;
  completed: boolean;
}

describe('rules-25 seeded independent guard settling', () => {
  it.each(['central-lake', 'three-crossings'] as const)('%s keeps bounded own-site arrival through 7200 ordinary steps', mapId => {
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    const base = sevenMapRotation(newMatchConfig(rulesConfig('redesign')));
    const config = { ...base, terrain: { ...base.terrain!, mapId } };
    const nativeSpeed = speedPerTick(config), progress = nativeSpeed - 2;
    assert(progress > 0);
    // Declared two-map-Manhattan-span allowance, not an observed timing or a universal route theorem.
    const arrivalTicks = Math.ceil(2 * (config.mapWidth + config.mapHeight) * SUB / progress) + 2;
    const stillTicks = 5 * config.ticksPerSecond;
    assert(arrivalTicks + stillTicks < 7200);
    const cohort = new Map<number, InitialGuard>(), episodes = new Map<number, GuardEpisode>();
    let state = createMatch(6006, config), parityAnts = 0, heldTicks = 0, transitions = 0;
    for (let t = 1; t <= 7200 && state.result === null; t++) {
      const observation = probe(state), frame = observation.frame;
      const ordinary = step(state).state;
      assert.equal(ordinary.tick, t); assert.equal(ordinary.agents.length, 0);
      const surviving = new Map(ordinary.ants.map(ant => [ant.id, ant]));
      const seen = new Set<number>(), sites = new Set<string>();
      for (const ant of observation.state.ants) {
        const goal = frame.goals.get(ant.id), rest = frame.pointRests.get(ant.id);
        const origin = frame.origins.get(ant.id)!;
        const label = `${mapId} tick=${t} ant=${ant.id}`;
        const displacementSquared = (ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2;
        assert(displacementSquared <= nativeSpeed ** 2,
          `${label} displacementSquared=${displacementSquared} nativeSquared=${nativeSpeed ** 2}`);
        const after = surviving.get(ant.id);
        if (after !== undefined) {
          assert.deepEqual([ant.x, ant.y, ant.vx, ant.vy], [after.x, after.y, after.vx, after.vy], label);
          parityAnts++;
        }
        if (t === 1 && goal?.guardPost) {
          assert(rest !== undefined, label);
          cohort.set(ant.id, { colony: ant.colony, goal: goal.key, x: rest.x, y: rest.y,
            reached: false, stationary: 0, completed: false });
        }
        const initial = cohort.get(ant.id);
        seen.add(ant.id);
        if (initial !== undefined && !initial.completed) {
          assert(goal?.guardPost && goal.key === initial.goal && rest !== undefined,
            `${label} initial cohort changed before completing ${stillTicks} samples: ${JSON.stringify({ goal, rest, initial })}`);
          assert.deepEqual([rest.x, rest.y], [initial.x, initial.y], label);
        }
        if (!goal?.guardPost) {
          if (episodes.delete(ant.id)) transitions++;
          continue;
        }
        assert.equal(goal.kind, 'point', label); assert(rest !== undefined, label);
        assert(isPassable(state, Math.floor(rest.x / SUB), Math.floor(rest.y / SUB)), label);
        assert(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)), label);
        const siteKey = `${rest.x},${rest.y}`;
        assert(!sites.has(siteKey), `${label} duplicate resting place ${siteKey}`); sites.add(siteKey);
        let episode = episodes.get(ant.id);
        if (episode?.goal === goal.key) {
          assert.deepEqual([rest.x, rest.y], [episode.x, episode.y], `${label} resting place changed under the same goal`);
        } else {
          if (episode !== undefined) transitions++;
          episode = { goal: goal.key, x: rest.x, y: rest.y, reached: false };
          episodes.set(ant.id, episode);
        }
        if (episode.reached) {
          assert.deepEqual([ant.x, ant.y, ant.vx, ant.vy], [rest.x, rest.y, 0, 0], `${label} moved after own-site arrival`);
          heldTicks++;
        }
        if (origin.x === rest.x && origin.y === rest.y) {
          assert.deepEqual(frame.arrivals.get(ant.id), { key: goal.key, arrived: true, native: true,
            rootId: ant.id, parentId: null, hops: 0 }, label);
        }
        const atRest = ant.x === rest.x && ant.y === rest.y;
        if (atRest) episode.reached = true;
        if (initial !== undefined && !initial.completed) {
          if (atRest) initial.reachedTick ??= t;
          if (t >= arrivalTicks) assert(initial.reachedTick !== undefined && initial.reachedTick <= arrivalTicks,
            `${label} deadline=${arrivalTicks} position=${ant.x},${ant.y} site=${rest.x},${rest.y} reached=${initial.reachedTick}`);
          initial.stationary = atRest && ant.vx === 0 && ant.vy === 0 ? initial.stationary + 1 : 0;
          initial.completed = initial.stationary >= stillTicks;
        }
      }
      for (const [id, initial] of cohort) if (!initial.completed) {
        assert(seen.has(id), `${mapId} tick=${t} initial guard ${id} disappeared before completing stationary samples`);
        if (t >= arrivalTicks + stillTicks) assert.fail(`${mapId} tick=${t} guard=${id} deadline=${arrivalTicks} stillTicks=${stillTicks} actual=${JSON.stringify(initial)}`);
      }
      for (const id of episodes.keys()) if (!seen.has(id)) { episodes.delete(id); transitions++; }
      if (t === 1) for (const colony of [0, 1]) {
        assert([...cohort.values()].filter(guard => guard.colony === colony).length >= config.guardCount,
          `${mapId} colony=${colony} initial guard cohort is empty or below config.guardCount`);
      }
      state = ordinary;
    }
    assert(cohort.size > 0); assert([...cohort.values()].every(guard => guard.completed));
    assert(parityAnts > 0); assert(heldTicks > 0);
    console.log(JSON.stringify({ mapId, seed: 6006, ticks: state.tick, arrivalTicks, stillTicks,
      cohort: [...cohort].map(([id, guard]) => ({ id, colony: guard.colony, reachedTick: guard.reachedTick, stationary: guard.stationary })),
      parityAnts, heldTicks, transitions }));
  }, 240_000);
});
