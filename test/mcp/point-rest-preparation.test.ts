import { describe, expect, it } from 'vitest';
import { Game } from '../../src/mcp/game.js';
import { SUB, rulesConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { cloneState, createMatch } from '../../src/sim/map.js';
import { prepareInitialPointRests, step } from '../../src/sim/step.js';
import type { SimInput } from '../../src/sim/types.js';
import { sevenMapRotation } from '../sim/seven-map-rotation.js';

function initial(mapId = 'open-field') {
  const base = rulesConfig('redesign');
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  return createMatch(7004, sevenMapRotation(newMatchConfig({ ...base, startAnts: 64, terrain: { ...base.terrain!, mapId } })));
}

describe('match-start resting-place preparation', () => {
  it.each(['open-field', 'central-lake', 'three-crossings'])('prepares before publication without changing state, RNG, logs or the first tick on %s', mapId => {
    const state = initial(mapId), before = cloneState(state);
    const lines: string[] = [];
    const game = new Game({ simConfig: state.config, onLogLine: line => lines.push(line) });
    game.startMatch(state.seed, { state });
    // The match advances in place, so it starts from a copy and the caller keeps its own state.
    expect(game.match!.state).not.toBe(state);
    expect(game.match!.state).toEqual(state);
    expect(state).toEqual(before);
    expect(state.rngState).toBe(before.rngState);
    expect(state.ants.every(ant => ant.pointRest === undefined)).toBe(true);
    expect(lines).toHaveLength(1);
    const expected = step(cloneState(before));
    const actual = game.tick()!;
    expect(actual).toEqual(expected);
    const rests = actual.state.ants.flatMap(ant => ant.pointRest === undefined ? [] : [ant.pointRest]);
    expect(rests.length).toBeGreaterThan(0);
    // Only the startup hook supplies shared immutable prepared destinations.
    expect(rests.every(Object.isFrozen)).toBe(true);
    const prepared = prepareInitialPointRests(state);
    expect(prepared).toBeDefined();
    expect(prepareInitialPointRests(state)).toBe(prepared);
    expect(state).toEqual(before);
    // Every live tick logs the houseActive policy line; preparation adds nothing of its own.
    expect(lines.slice(1).map(line => JSON.parse(line))).toEqual([{ tick: 0, inputs: [], houseActive: true }]);
  });

  it('keeps queued joins identical to an unprepared first tick', async () => {
    const state = initial(), before = cloneState(state);
    const game = new Game({ simConfig: state.config });
    const queued = await game.join({});
    expect(queued.agentId).not.toBeNull();
    expect(queued.outcome.kind).toBe('queued');
    game.startMatch(state.seed, { state });
    const inputs: SimInput[] = [{ type: 'join', agentId: queued.agentId! }];
    const expected = step(cloneState(before), inputs);
    expect(game.tick()).toEqual(expected);
    expect(state).toEqual(before);
  });

  it('invalidates safely when the first tick accepts a new count mark', () => {
    const joined = step(initial(), [{ type: 'join', agentId: 'first-mark' }]).state;
    const state = { ...joined, tick: 0 }, before = cloneState(state);
    expect(prepareInitialPointRests(state)).toBeDefined();
    const ant = state.ants.find(ant => ant.colony === 0)!;
    const inputs: SimInput[] = [{ type: 'count_mark', agentId: 'first-mark', verb: 'DEFEND', count: 8,
      tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) }];
    const expected = step(cloneState(before), inputs);
    expect(expected.results[0]!.ok).toBe(true);
    expect(expected.state.marks.length).toBeGreaterThan(0);
    expect(step(state, inputs)).toEqual(expected);
    expect(step(state, inputs)).toEqual(expected);
    expect(state).toEqual(before);
  });

  it('leaves recorded configs without the point-arrival opt-in on their original path', () => {
    const current = initial();
    const state = createMatch(current.seed, { ...current.config, pointArrival: undefined });
    const before = cloneState(state), game = new Game({ simConfig: state.config });
    game.startMatch(state.seed, { state });
    expect(prepareInitialPointRests(state)).toBeUndefined();
    expect(state).toEqual(before);
    expect(game.tick()).toEqual(step(cloneState(before)));
  });
});
