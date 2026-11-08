import { expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Agent, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: the reference template is built at grid scale 2 by
// emptyMatch and playable. An ant at reference tile t stands at its centre, fine tile 2t + 0.5.
const put = (state: SimState, colony: 0 | 1, tx: number, ty: number, patch: Parameters<typeof addAnt>[4] = {}) =>
  addAnt(state, colony, 2 * tx + 0.5, 2 * ty + 0.5, patch);

/** Remove only the combat-accounting telemetry, never gameplay, timers, PRNG, events or results. */
function withoutAccounting(state: SimState): SimState {
  const { combatTotals: _flag, ...countMarks } = state.config.countMarks!;
  return { ...state, config: { ...state.config, countMarks },
    marks: state.marks.map(({ antsLost: _lost, enemiesKilled: _killed, ...mark }) => mark) };
}

it("accounting on/off preserves every tick's complete gameplay bytes and events through claimed combat and queen bites", () => {
  const base = rulesConfig("redesign");
  const config: SimConfig = { ...base, terrain: undefined, foodLayout: undefined, startAnts: 0,
    antSpeedTilesPerSecond: 0, hatchIntervalTicks: 1_000_000, combatGraceTicks: 0,
    defenderBonusPermille: 1000, commandFloorTicks: 1, squadSize: 1,
    queenHp: { ...base.queenHp!, biteDamage: 100, biteIntervalTicks: 2, shieldTicks: 0 } };
  let on = emptyMatch(2000, config);
  for (const colony of [0, 1] as const) {
    const id = `script-${colony}`;
    const squad = put(on, colony, 30 + colony, 20, { squad: id });
    const agent: Agent = { id, colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [squad.id], order: { kind: "hold" }, lastCallTick: 2000, lastCommandTick: null,
      joinedTick: 2000, idle: false, pendingEvents: [] };
    on.agents.push(agent);
    put(on, colony, 30 + colony, 23, { hp: 100, caste: "worker" });
    // Both free ants by colony 0's queen are claimed; the queen's bite joins their simultaneous hits.
    // The colony-1 ant stands in the reference tile beside the queen's, in the fine tile within her two-tile bite reach.
    addAnt(on, colony, colony === 0 ? 16.5 : 18, 48.5, { hp: 1000, caste: "worker" });
  }
  let off = withoutAccounting(structuredClone(on));
  let deaths = 0, countedLosses = 0, countedKills = 0, queenBit = false;
  const original = JSON.stringify(on);
  for (let tick = 0; tick < 100; tick++) {
    const inputs: SimInput[] = tick === 0 ? ([0, 1] as const).map(colony => ({
      type: "count_mark", agentId: `script-${colony}`, verb: "GATHER", count: 3,
    })) : tick === 4 ? [{ type: "count_mark", agentId: "script-0", verb: "GATHER", count: 2, caste: "worker" }]
      : tick % 3 === 0 ? [{ type: "observe", agentId: "script-0" }] : [];
    const before = JSON.stringify(on);
    const a = step(on, inputs), b = step(off, inputs);
    expect(JSON.stringify(on)).toBe(before); // immutable input, including counter objects
    expect(JSON.stringify(withoutAccounting(a.state))).toBe(JSON.stringify(b.state));
    expect(a.events).toEqual(b.events);
    expect(a.results.map(r => r.ok)).toEqual(b.results.map(r => r.ok));
    deaths += a.events.filter(e => e.type === "death").length;
    countedLosses = Math.max(countedLosses, ...a.state.marks.map(m => m.antsLost ?? 0));
    countedKills = Math.max(countedKills, ...a.state.marks.map(m => m.enemiesKilled ?? 0));
    queenBit ||= a.state.colonies[0].queens!.some(q => (q.lastBiteTick ?? -1) >= 2000);
    on = a.state; off = b.state;
  }
  expect(original).not.toContain('"antsLost"');
  expect(deaths).toBeGreaterThan(0);
  expect(countedLosses).toBeGreaterThan(0); expect(countedKills).toBeGreaterThan(0);
  expect(queenBit).toBe(true);
});

it("replays a flagged count-mark log to the same complete state including totals, without rewriting old configs", () => {
  const config = playable({ ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined });
  let state = createMatch(7001, config);
  const lines = [headerLine(7001, config)];
  for (let tick = 0; tick < 40; tick++) {
    const inputs: SimInput[] = tick === 0 ? [{ type: "join", agentId: "script", colony: 0 }]
      : tick === 1 ? [{ type: "count_mark", agentId: "script", verb: "GATHER", count: 2 }] : [];
    if (inputs.length) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    expect(out.results.every(r => r.ok)).toBe(true);
    state = out.state;
  }
  expect(state.marks).toHaveLength(1);
  expect(state.marks[0]).toMatchObject({ antsLost: 0, enemiesKilled: 0 });
  expect(stateHash(replay(lines, 40))).toBe(stateHash(state));
});
