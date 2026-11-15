import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { linkPatrolMarks, patrolChains } from "../../src/sim/patrol.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Mark, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Test plan check 8, scripted on the grid-scale-2 match map (10 ticks/s), after the combat grace period.
// Every coordinate below is a fine tile of that map; the PATROL link range there is 12 tiles.
const config: SimConfig = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, earlyWin: undefined };
const START = 700;

function scene(): SimState {
  const state = emptyMatch(START, config);
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: START, lastCommandTick: START, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return state;
}

type MarkCasteName = "flyer" | "worker" | "soldier";
/** A mark whose caste may be "flyer", the caste a flyer order's mark carries. */
type ScriptedMark = Omit<Mark, "caste"> & { caste?: string };
/** A scripted PATROL count mark of colony 0, laid by agent "a". */
function patrol(state: SimState, tileX: number, tileY: number, caste: MarkCasteName | undefined, laidTick: number): number {
  const mark: ScriptedMark = { id: state.nextMarkId++, agentId: "a", colony: 0, tileX, tileY, words: [], laidTick,
    steering: 0, verb: "PATROL", count: 2, revision: 0, ...(caste === undefined ? {} : { caste }) };
  state.marks.push(mark as Mark);
  return mark.id;
}
/** Re-cast a scripted mark in place, as a re-lay does: caste and revision change; id, tile and laid tick do not. */
function recast(state: SimState, id: number, caste: MarkCasteName): void {
  const mark = state.marks.find(item => item.id === id)! as ScriptedMark;
  mark.caste = caste;
  mark.revision = (mark.revision ?? 0) + 1;
}
/** The ids of the chain holding mark id, in the chain's laid order, as the next movement phase derives it. */
function chainOf(state: SimState, id: number): number[] {
  return patrolChains(state).get(id)!.chain.map(mark => mark.id);
}
const isFlyer = (mark: Mark) => (mark as ScriptedMark).caste === "flyer";
/** No derived chain holds both a flyer mark and a ground mark. */
function noMixedChain(state: SimState): boolean {
  return [...patrolChains(state).values()].every(({ chain }) => chain.every(mark => isFlyer(mark) === isFlyer(chain[0]!)));
}
function tick(state: SimState, inputs: readonly SimInput[] = []): SimState {
  const out = step(state, inputs);
  expect(out.results.every(result => result.ok)).toBe(true);
  return out.state;
}

describe("linkPatrolMarks: flyer PATROL marks link only with flyer PATROL marks", () => {
  type Item = { id: number; colony: number; verb?: string; count?: number; caste?: string; tileX: number; tileY: number; laidTick: number };
  const item = (id: number, tileX: number, tileY: number, caste?: string, colony = 0): Item =>
    ({ id, colony, verb: "PATROL", count: 1, tileX, tileY, laidTick: 10, ...(caste === undefined ? {} : { caste }) });

  it("links flyer marks within 12 tiles, never across flyer and ground, while ground marks of any caste still link", () => {
    const flyerA = item(1, 20, 40, "flyer"), flyerB = item(2, 32, 40, "flyer"); // exactly 12 tiles apart
    const flyerOut = item(3, 45, 40, "flyer"); // 13 tiles from flyerB
    const groundA = item(4, 26, 46), groundB = item(5, 38, 46, "soldier"), groundC = item(6, 44, 52, "worker");
    const enemyFlyer = item(7, 20, 40, "flyer", 1);
    const notPatrol = { ...item(8, 26, 40, "flyer"), verb: "GATHER" };
    const marks = [flyerA, flyerB, flyerOut, groundA, groundB, groundC, enemyFlyer, notPatrol];
    const chains = linkPatrolMarks(marks, 12);
    expect(chains.get(1)!.chain).toEqual([flyerA, flyerB]);
    expect(chains.get(2)).toEqual({ chain: chains.get(1)!.chain, position: 1 });
    expect(chains.get(3)!.chain).toEqual([flyerOut]);
    expect(chains.get(4)!.chain).toEqual([groundA, groundB, groundC]);
    expect(chains.get(7)!.chain).toEqual([enemyFlyer]);
    expect(chains.has(8)).toBe(false);
    expect(marks.map(mark => mark.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("never bridges two flyer marks through a ground mark, nor two ground marks through a flyer mark", () => {
    const chains = linkPatrolMarks([item(1, 60, 40, "flyer"), item(2, 67, 40), item(3, 74, 40, "flyer"),
      item(4, 90, 40), item(5, 97, 40, "flyer"), item(6, 104, 40)], 12);
    for (const id of [1, 2, 3, 4, 5, 6]) expect(chains.get(id)!.chain.map(mark => mark.id)).toEqual([id]);
  });
});

describe("check 8, Patrol, line and hover: flyer and ground patrol chains", () => {
  it("never links a flyer chain with a ground mark, while the two ground marks (positive control) link", () => {
    let state = scene();
    const queen = state.colonies[0]!;
    const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
    const pair = [patrol(state, 40, 30, "flyer", START - 20), patrol(state, 50, 30, "flyer", START - 19)];
    const ring = [patrol(state, qx, qy - 8, "flyer", START - 18), patrol(state, qx + 8, qy, "flyer", START - 17),
      patrol(state, qx, qy + 8, "flyer", START - 16), patrol(state, qx - 8, qy, "flyer", START - 15)];
    // Laid within 12 tiles of both flyer marks of the pair; the second ground mark is within 12 tiles of the first.
    const ground = [patrol(state, 45, 36, undefined, START - 14), patrol(state, 55, 40, undefined, START - 13)];
    addAnt(state, 0, 45, 36, { caste: "worker" });
    addAnt(state, 1, 55, 40, { caste: "worker" });
    for (let i = 0; i < 20; i++) {
      expect(chainOf(state, pair[0]!)).toEqual(pair);
      expect(chainOf(state, ring[0]!)).toEqual(ring);
      expect(chainOf(state, ground[0]!)).toEqual(ground);
      expect(noMixedChain(state)).toBe(true);
      state = tick(state);
    }
  });
});

describe("check 8, Re-lay, caste and chains: chains follow re-cast and expiry on the next tick", () => {
  it("drops a mark re-cast from flyer to soldier out of the flyer chain into the ground chain, and splits the chain on the oldest flyer mark's expiry", () => {
    let state = scene();
    const lifetime = state.config.markLifetimeTicks;
    // A flyer chain of 3 whose middle mark is the oldest; the ground mark is within 12 tiles of the middle and last only.
    const middle = patrol(state, 32, 40, "flyer", START - lifetime + 5);
    const first = patrol(state, 20, 40, "flyer", START - 10);
    const last = patrol(state, 44, 40, "flyer", START - 9);
    const ground = patrol(state, 38, 46, undefined, START - 8);
    addAnt(state, 0, 32, 40, { caste: "worker" });
    expect(state.config.patrolLinkTiles).toBe(12);
    expect(chainOf(state, middle)).toEqual([middle, first, last]);
    expect(chainOf(state, ground)).toEqual([ground]);

    // Re-lay the middle mark as caste soldier: from the next tick it links with the ground mark, and the flyer chain splits.
    state = tick(state, [{ type: "count_mark", agentId: "a", verb: "PATROL", tileX: 32, tileY: 40, count: 2, caste: "soldier" }]);
    const relaid = state.marks.find(mark => mark.id === middle)!;
    expect(relaid).toMatchObject({ caste: "soldier", revision: 1, laidTick: START - lifetime + 5 });
    expect(chainOf(state, middle)).toEqual([middle, ground]);
    expect(chainOf(state, first)).toEqual([first]);
    expect(chainOf(state, last)).toEqual([last]);

    // Back to flyer, then the ground mark re-cast as flyer: one flyer chain of 4 in laid order.
    recast(state, middle, "flyer");
    state = tick(state);
    expect(chainOf(state, middle)).toEqual([middle, first, last]);
    expect(chainOf(state, ground)).toEqual([ground]);
    recast(state, ground, "flyer");
    state = tick(state);
    expect(chainOf(state, middle)).toEqual([middle, first, last, ground]);

    // The oldest flyer mark expires at the end of the tick before START + 5: the chain splits from tick START + 5.
    state = tick(state);
    expect(state.tick).toBe(START + 4);
    expect(chainOf(state, middle)).toEqual([middle, first, last, ground]);
    state = tick(state);
    expect(state.tick).toBe(START + 5);
    expect(state.marks.some(mark => mark.id === middle)).toBe(false);
    expect(chainOf(state, first)).toEqual([first]);
    expect(chainOf(state, last)).toEqual([last, ground]);
    expect(noMixedChain(state)).toBe(true);
  });
});
