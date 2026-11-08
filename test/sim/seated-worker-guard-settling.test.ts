import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { rulesConfig, type SimConfig } from '../../src/sim/config.js';
import { newMatchConfig } from '../../src/sim/gridScale.js';
import { settledWorkerScreen, type LocalSoldierAssignments } from '../../src/sim/houseBot.js';
import { stateHash } from '../../src/sim/log.js';
import { cloneState, createMatch, nearestQueen } from '../../src/sim/map.js';
import { step } from '../../src/sim/step.js';
import type { SimState } from '../../src/sim/types.js';

// In agent-seated rules-25 colonies, the standing worker guard bounced in
// and out of the queen point. Under workerGuardSettle a worker guard arrives within
// the soft arrival radius of its queen, or within the arrival link radius of an
// arrived worker guard of the same queen, and is then held. Both colonies are seated
// with agents that send nothing; houseActive is true.
function seated(config: SimConfig, seed: number): SimState {
  const state = createMatch(seed, config);
  for (const colony of [0, 1] as const) state.agents.push({ id: `a${colony}`, colony, joinSeq: colony, modelLabel: null,
    parentAgentId: null, squad: [], order: { kind: 'hold' }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] });
  return state;
}

function withFlag(config: SimConfig, on: boolean): SimConfig {
  const { workerGuardSettle: _flag, ...rules } = config.localAnts!;
  return { ...config, localAnts: { ...rules, ...(on ? { workerGuardSettle: true as const } : {}) } };
}

describe('seated worker guards settle at their queen', () => {
  const config = newMatchConfig(rulesConfig('redesign'));

  it('is set for new redesign matches only', () => {
    assert.equal(config.localAnts?.workerGuardSettle, true);
    assert.equal(rulesConfig('count-marks').localAnts?.workerGuardSettle, undefined);
  });


  it('house-only matches are unchanged by the flag', () => {
    const run = (on: boolean): string => {
      let state = createMatch(6006, withFlag(config, on));
      while (state.tick < 1500) state = step(state, []).state;
      return stateHash({ ...state, config: withFlag(config, false) });
    };
    assert.equal(run(true), run(false));
  }, 120_000);

  describe('the screen', () => {
    const base = seated(withFlag(config, true), 6006);
    const queen = nearestQueen(base.colonies[0]!, base.colonies[0]!.queenX, base.colonies[0]!.queenY)!;
    const soft = base.config.softSeparation!;
    const workers = base.ants.filter(ant => ant.colony === 0 && ant.caste !== 'soldier').slice(0, 4);

    function screenOf(offsets: readonly (readonly [number, number])[]): ReadonlySet<number> {
      const state = cloneState(base);
      const placed = workers.map((worker, i) => {
        const ant = state.ants.find(a => a.id === worker.id)!;
        ant.x = queen.queenX + offsets[i]![0]; ant.y = queen.queenY + offsets[i]![1];
        return ant.id;
      });
      for (const ant of state.ants) if (ant.colony === 0 && !placed.includes(ant.id)) { ant.x = 0; ant.y = 0; }
      const allocation: LocalSoldierAssignments = { front: new Set(), patches: new Set(), workerGuards: new Set(placed) };
      return settledWorkerScreen(state, allocation)!;
    }

    it('roots within the soft arrival radius, links within the arrival link radius, and leaves a lone guard walking', () => {
      const r = soft.arrivalSubunits, link = soft.arrivalLinkRadius;
      const screen = screenOf([[r - 1, 0], [r - 1 + link - 1, 0], [r - 1 + 2 * (link - 1), 0], [-(r + link + 1), 0]]);
      const [root, linked, chained, lone] = workers.map(w => w.id);
      assert.ok(screen.has(root!), 'root within the arrival radius');
      assert.ok(screen.has(linked!) && screen.has(chained!), 'chain through arrived worker guards');
      assert.ok(!screen.has(lone!), 'an unlinked guard outside the arrival radius still walks in');
    });

    it('does not chain through an unarrived guard', () => {
      const r = soft.arrivalSubunits, link = soft.arrivalLinkRadius;
      const screen = screenOf([[r + 1, 0], [r + link, 0], [-(r + 5 * link), 0], [0, r + 5 * link]]);
      assert.equal(screen.size, 0);
    });
  });
});
