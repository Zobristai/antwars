import { describe, expect, it } from "vitest";
import { resolveCombat } from "../../src/sim/combat.js";
import { QUEEN_HP_RULES, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { activeQueens, buildGrid, cloneState } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import { updateOverrun } from "../../src/sim/territory.js";
import type { Ant, ColonyId, QueenState, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";

// "when a queen dies, her spawn point clears, and her
// unclaimed ants still walking to it start their caste's rules-27 defaults from
// where they are." Both queen-loss paths: queen HP (combat) and overrun.

const TICK = QUEEN_HP_RULES.shieldTicks;
/** No squads, so every ant here stays free for local planning. */
const HP_RULES: SimConfig = { ...rulesConfig("redesign"), rules27: true, terrain: undefined, foodLayout: undefined,
  squadSize: 0, commandFloorTicks: 1 };
const { queenHp: _queenHp, ...withoutQueenHp } = HP_RULES;
/** Without queen HP, a queen is lost to overrun; one tick of enemy majority is enough here. */
const OVERRUN_RULES: SimConfig = { ...withoutQueenHp, overrunGraceTicks: 0, overrunTicks: 1 };

function seat(state: SimState, colony: ColonyId): void {
  state.agents.push({ id: `seat-${colony}`, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: state.tick, idle: false, pendingEvents: [] });
}

function walker(state: SimState, colony: ColonyId, queen: QueenState, tx: number, ty: number, caste: Ant["caste"]): Ant {
  const point = queen.spawnPoint!;
  return addAnt(state, colony, tx, ty, { caste, spawnWalk: { queenId: queen.id, tileX: point.tileX, tileY: point.tileY } });
}

/**
 * Both colonies seated on rules 27. Colony 0 has two live queens, each with a
 * spawn point and walkers heading to it; colony 1's queen shares the doomed
 * queen's id and has a walker of her own. A colony-1 ant stands on the doomed
 * queen's nest, away from every walker.
 */
function scene(config: SimConfig) {
  const state = emptyMatch(TICK, config);
  const [doomed, enemyQueen] = [state.colonies[0].queens![0]!, state.colonies[1].queens![0]!];
  const survivor: QueenState = { id: 1, queenX: tileCentre(12), queenY: tileCentre(40), foundedTick: 0,
    lastHatchTick: TICK, overrunTicks: 0, lostTick: null,
    ...(config.queenHp === undefined ? {} : { hp: config.queenHp.hp }) };
  state.colonies[0].queens!.push(survivor);
  seat(state, 0); seat(state, 1);
  doomed.spawnPoint = { tileX: 30, tileY: 10 };
  survivor.spawnPoint = { tileX: 30, tileY: 38 };
  enemyQueen.spawnPoint = { tileX: 34, tileY: 12 };
  const freed = [walker(state, 0, doomed, 16, 16, "worker"), walker(state, 0, doomed, 20, 30, "soldier")];
  const kept = [walker(state, 0, survivor, 18, 36, "worker"), walker(state, 1, enemyQueen, 44, 18, "soldier")];
  const raider = addAnt(state, 1, Math.floor(doomed.queenX / SUB), Math.floor(doomed.queenY / SUB), { caste: "worker" });
  expect(localRulesSide(state, 0) && localRulesSide(state, 1)).toBe(true);
  return { state, doomed, survivor, enemyQueen, freed, kept, raider };
}

/** The same scene with the doomed queen's walkers never walking: free ants standing on the same tiles. */
function neverWalked(state: SimState, freed: readonly Ant[]): SimState {
  const control = cloneState(state);
  for (const ant of freed) delete antById(control, ant.id)!.spawnWalk;
  return control;
}

function expectCleared(s: ReturnType<typeof scene>, events: readonly SimEvent[]): void {
  const { state, doomed, survivor, enemyQueen, freed, kept } = s;
  expect(events).toContainEqual(expect.objectContaining({ type: "queen_lost", colony: 0, queenId: doomed.id }));
  expect(activeQueens(state.colonies[0]).map((q) => q.id)).toEqual([survivor.id]);
  expect(doomed.spawnPoint).toBeUndefined();
  for (const ant of freed) {
    const now = antById(state, ant.id)!;
    expect(now.spawnWalk).toBeUndefined();
    expect(now.claim).toBeUndefined();
    expect(now.squad).toBeNull();
    // From where they are: the loss moves no ant.
    expect([now.x, now.y]).toEqual([ant.x, ant.y]);
  }
  // Only her spawn point and her colony's walks: another queen's, and the enemy's same-id queen's, stay.
  expect(survivor.spawnPoint).toEqual({ tileX: 30, tileY: 38 });
  expect(enemyQueen.spawnPoint).toEqual({ tileX: 34, tileY: 12 });
  expect(antById(state, kept[0]!.id)!.spawnWalk).toEqual({ queenId: survivor.id, tileX: 30, tileY: 38 });
  expect(antById(state, kept[1]!.id)!.spawnWalk).toEqual({ queenId: enemyQueen.id, tileX: 34, tileY: 12 });
}

/** Freed walkers now plan exactly as free ants of their caste on the same tiles, in a real step. */
function expectDefaultsFromHere(state: SimState, control: SimState): void {
  expect(state).toEqual(control);
  const next = step(state), nextControl = step(control);
  expect(next.state.result).toBeNull();
  expect(next.state).toEqual(nextControl.state);
  expect(next.events).toEqual(nextControl.events);
}

describe("rules 27: queen death clears her spawn point", () => {
  it("queen killed in combat: her spawn point clears and her walkers take their caste defaults where they stand", () => {
    const s = scene(HP_RULES);
    s.doomed.hp = 1;
    const control = neverWalked(s.state, s.freed);
    const events: SimEvent[] = [], controlEvents: SimEvent[] = [];
    resolveCombat(s.state, buildGrid(s.state), TICK, events);
    resolveCombat(control, buildGrid(control), TICK, controlEvents);
    expect(s.doomed.lostTick).toBe(TICK);
    expectCleared(s, events);
    expect(events).toEqual(controlEvents);
    expectDefaultsFromHere(s.state, control);
  });

  it("queen lost to overrun: her spawn point clears and her walkers take their caste defaults where they stand", () => {
    const s = scene(OVERRUN_RULES);
    const control = neverWalked(s.state, s.freed);
    const events: SimEvent[] = [], controlEvents: SimEvent[] = [];
    expect(updateOverrun(s.state, buildGrid(s.state), TICK, events)).toBeNull();
    expect(updateOverrun(control, buildGrid(control), TICK, controlEvents)).toBeNull();
    expect(s.doomed.lostTick).toBe(TICK);
    expectCleared(s, events);
    expect(events).toEqual(controlEvents);
    expectDefaultsFromHere(s.state, control);
  });

  it("clears inside a full step too, on the tick the queen falls", () => {
    const s = scene(HP_RULES);
    s.doomed.hp = 1;
    const { state, events } = step(s.state);
    expect(events).toContainEqual(expect.objectContaining({ type: "queen_lost", colony: 0, queenId: s.doomed.id }));
    expect(state.colonies[0].queens![0]!.spawnPoint).toBeUndefined();
    for (const ant of s.freed) expect(antById(state, ant.id)!.spawnWalk).toBeUndefined();
    expect(state.colonies[0].queens![1]!.spawnPoint).toEqual({ tileX: 30, tileY: 38 });
    expect(antById(state, s.kept[0]!.id)!.spawnWalk).toEqual({ queenId: 1, tileX: 30, tileY: 38 });
  });
});
