import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { rulesConfig, type SimConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { threeMapRotation } from './three-map-rotation.js';
import { cloneState, createMatch } from '../../src/sim/map.js';
import { step } from '../../src/sim/step.js';
import type { SimState } from '../../src/sim/types.js';

// In seated rules-25 matches, a forager walking to food past its own
// colony's point-resting soldiers stepped into their soldier radius and was pushed
// back to its origin every tick. Both colonies are seated with agents that send nothing.
const HELD = 300;

function seated(config: SimConfig, seed: number): SimState {
  const state = createMatch(seed, config);
  for (const colony of [0, 1] as const) state.agents.push({ id: `a${colony}`, colony, joinSeq: colony, modelLabel: null,
    parentAgentId: null, squad: [], order: { kind: 'hold' }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] });
  return state;
}

const tick = (state: SimState) => step(state, [], undefined, undefined, undefined, false, true).state;

/** Foragers with a live food target held still HELD ticks that move once soldier pairs use the small radius. */
function soldierPushStalls(config: SimConfig, seed: number, ticks: number) {
  const rules = config.softSeparation!;
  let state = seated(config, seed), stalls = 0;
  const run = new Map<number, number>();
  while (state.tick < ticks) {
    const previous = state; state = tick(previous);
    assert.equal(state.result, null);
    const before = new Map(previous.ants.map(a => [a.id, a]));
    for (const ant of state.ants) {
      const b = before.get(ant.id);
      const still = b !== undefined && b.x === ant.x && b.y === ant.y;
      const live = ant.caste !== 'soldier' && ant.role === 'forager' && !ant.carrying && ant.foodTarget >= 0;
      const length = live && still ? (run.get(ant.id) ?? 0) + 1 : 0;
      run.set(ant.id, length);
      if (length !== HELD) continue;
      const counterfactual: SimState = { ...cloneState(previous),
        config: { ...previous.config, softSeparation: { ...rules, soldierRadius: rules.radius } } };
      const moved = tick(counterfactual).ants.find(a => a.id === ant.id)!;
      if (moved.x !== ant.x || moved.y !== ant.y) stalls++;
    }
  }
  return stalls;
}

describe('foragers pass their own point-resting soldiers', () => {
  const config = threeMapRotation(newMatchConfig(rulesConfig('redesign')));

  it('seed 6007, ticks 0-6000: no forager is held by the push of its own resting soldiers', () => {
    assert.equal(config.softSeparation?.restPass, true);
    assert.equal(soldierPushStalls(config, 6007, 6000), 0, 'foragers held 300+ ticks by the soldier push');
  }, 240_000);
});
