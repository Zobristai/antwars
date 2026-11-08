import { describe, expect, it } from 'vitest';
import { countMarkDirection } from '../../src/sim/agents.js';
import { adjacentEnemyQueen, resolveCombat } from '../../src/sim/combat.js';
import { rulesConfig, SUB } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { houseDirection, localDirection } from '../../src/sim/houseBot.js';
import { beginLocalGoals, currentLocalGoals, type LocalGoal } from '../../src/sim/localArrival.js';
import { buildGrid, hasAdjacentEnemy } from '../../src/sim/map.js';
import { assignPointRests, preparePointRests } from '../../src/sim/pointSlots.js';
import { advanceSoftAnts } from '../../src/sim/step.js';
import { isPassable } from '../../src/sim/terrain.js';
import type { Ant, ColonyId, Mark, SimState } from '../../src/sim/types.js';
import { addAnt, emptyMatch } from './fixtures.js';

function scene(scale: 1 | 2) {
  const base = rulesConfig('redesign');
  return emptyMatch(4000, { ...(scale === 1 ? base : newMatchConfig(base)), startAnts: 0,
    terrain: undefined, foodLayout: undefined, foodPatches: [] });
}
function decide(state: SimState, ant: Ant, local: boolean) {
  return local ? localDirection(state, buildGrid(state), ant).dir : houseDirection(state, buildGrid(state), [], ant);
}
function mark(state: SimState, verb: 'GATHER' | 'PATROL', tileX = 30): Mark {
  const value: Mark = { id: state.nextMarkId++, agentId: 'holder', colony: 0,
    tileX, tileY: 24, words: [], laidTick: state.tick, steering: 0, verb, count: 1 };
  state.marks.push(value);
  return value;
}

for (const scale of [1, 2] as const) for (const colony of [0, 1] as const) for (const local of [false, true]) {
  describe(`combat intent, scale ${scale}, colony ${colony}, ${local ? 'local' : 'house'}`, () => {
    it('keeps an attacker fighting an enemy ant instead of walking to an existing distant rest', () => {
      const state = scene(scale);
      const ant = addAnt(state, colony, 30 * scale, 24 * scale, { caste: 'soldier', role: 'fighter' });
      const target = addAnt(state, colony === 0 ? 1 : 0, 31 * scale, 24 * scale, { caste: 'soldier' });
      ant.pointRest = { key: 'previous-hold', x: 10 * scale * SUB, y: 10 * scale * SUB };
      const hp = target.hp;
      for (let tick = 0; tick < 3; tick++) {
        expect(hasAdjacentEnemy(state, buildGrid(state), ant)).toBe(true);
        beginLocalGoals(state);
        const dir = decide(state, ant, local);
        expect(dir).toEqual({ x: 0, y: 0 });
        expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: 'combat', targetId: target.id, nativeReached: true });
        const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
        expect(frame.pointRests.has(ant.id)).toBe(false);
        resolveCombat(state, buildGrid(state), state.tick++, []);
      }
      expect(target.hp).toBeLessThan(hp);
      expect(ant.pointRest?.key).toBe('previous-hold');
    });

    it('keeps biting an enemy queen after her screen dies, even when assigned as a distant home guard', () => {
      const state = scene(scale), queen = state.colonies[colony === 0 ? 1 : 0].queens![0]!;
      const ant = addAnt(state, colony, 0, 0, { x: queen.queenX, y: queen.queenY,
        caste: 'soldier', role: 'guard' });
      ant.pointRest = { key: 'previous-guard', x: state.colonies[colony].queenX, y: state.colonies[colony].queenY };
      const hp = queen.hp!;
      for (let tick = 0; tick < 3; tick++) {
        beginLocalGoals(state);
        const dir = decide(state, ant, local);
        expect(dir).toEqual({ x: 0, y: 0 });
        expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: 'combat', nativeReached: true,
          x: queen.queenX, y: queen.queenY });
        const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
        expect(frame.pointRests.has(ant.id)).toBe(false);
        expect(adjacentEnemyQueen(state, ant)).toBe(queen);
        resolveCombat(state, buildGrid(state), state.tick++, []);
      }
      expect(queen.hp).toBeLessThan(hp);
      expect([ant.x, ant.y]).toEqual([queen.queenX, queen.queenY]);
    });
  });
}

describe('holding versus passing through a point', () => {
  it('still gives a soldier sent to hold a point a stable organic rest on land', () => {
    const state = scene(1), held = mark(state, 'GATHER');
    const ant = addAnt(state, 0, held.tileX, held.tileY, { caste: 'soldier', claim: held.id });
    let assigned: Ant['pointRest'];
    for (let tick = 0; tick < 30; tick++) {
      beginLocalGoals(state);
      const { dir } = countMarkDirection(state, buildGrid(state), [], ant, held);
      const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
      expect(ant.pointRest).toBeDefined();
      if (tick === 0) assigned = { ...ant.pointRest! };
      expect(ant.pointRest).toEqual(assigned);
      expect(frame.pointRests.get(ant.id)).toMatchObject({ x: assigned!.x, y: assigned!.y });
      state.tick++;
    }
    expect(assigned!.key).toContain('organic-cluster');
    expect([assigned!.x, assigned!.y]).not.toEqual([(held.tileX + 0.5) * SUB, (held.tileY + 0.5) * SUB]);
    expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([assigned!.x, assigned!.y, 0, 0]);
    expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
  });

  it.each([1, 2])('%i PATROL marks: a lone post holds, linked waypoints pass through', count => {
    const state = scene(1), first = mark(state, 'PATROL');
    if (count === 2) mark(state, 'PATROL', 34);
    const ant = addAnt(state, 0, first.tileX, first.tileY, { caste: 'soldier', claim: first.id });
    beginLocalGoals(state);
    const { dir } = countMarkDirection(state, buildGrid(state), [], ant, first);
    expect(currentLocalGoals(state).get(ant.id)?.passingThrough).toBe(count === 2 ? true : undefined);
    const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
    expect(frame.pointRests.has(ant.id)).toBe(count === 1);
    expect(ant.pointRest !== undefined).toBe(count === 1);
    if (count === 2) expect(ant.patrolWaypoint).toBe(state.marks[1]!.id);
  });

  it('invalidates prepared resting allocation when the same goal becomes a passing waypoint', () => {
    const state = scene(1), ant = addAnt(state, 0, 30, 24, { caste: 'soldier' });
    const goal: LocalGoal = { key: 'same-point', kind: 'mark', targetId: 1, x: ant.x, y: ant.y, nativeReached: true };
    const prepared = preparePointRests(state, new Map([[ant.id, goal]]))!;
    const rests = assignPointRests(state, new Map([[ant.id, { ...goal, passingThrough: true }]]), prepared);
    expect(rests.size).toBe(0);
    expect(ant.pointRest).toBeUndefined();
  });
});
