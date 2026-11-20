import { describe, expect, it } from "vitest";
import { countMarkDirection } from "../../src/sim/agents.js";
import { adjacentEnemyQueen, resolveCombat } from "../../src/sim/combat.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { beginLocalGoals, currentLocalGoals } from "../../src/sim/localArrival.js";
import { activeQueens, buildGrid, createMatch, newAnt } from "../../src/sim/map.js";
import { quadrantMapConfig } from "../../src/sim/quadrantMaps.js";
import { advance, advanceSoftAnts } from "../../src/sim/step.js";
import type { Ant, Caste, ColonyId, Mark, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Ground ants on an ATTACK mark at an enemy queen walk into her bite reach and stay there, as landed
// flyers already do, instead of resting at a spot elsewhere in the mark's area. Enemy ants keep priority:
// one in reach is fought where the ant stands, and one near the target is chased before the queen.

const cheb = (a: Ant, x: number, y: number) => Math.max(Math.abs(Math.floor(a.x / SUB) - x), Math.abs(Math.floor(a.y / SUB) - y));

describe("a ground ant on an ATTACK mark at an enemy queen", () => {
  function setup(caste: Caste, offset: number, colony: ColonyId = 1) {
    const base = rulesConfig("redesign");
    const state = emptyMatch(4000, { ...newMatchConfig(base), startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] });
    const queen = state.colonies[colony === 0 ? 1 : 0].queens![0]!;
    const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
    const attack: Mark = { id: state.nextMarkId++, agentId: "raider", colony, tileX: qx, tileY: qy,
      words: [], laidTick: state.tick, steering: 0, verb: "ATTACK", count: 1, caste };
    state.marks.push(attack);
    const ant = addAnt(state, colony, qx + offset, qy, { caste, claim: attack.id });
    return { state, queen, qx, qy, attack, ant };
  }

  for (const caste of ["worker", "soldier"] as const) for (const colony of [0, 1] as const) {
    it(`a ${caste} of colony ${colony} resting out of reach walks into her reach and bites her`, () => {
      const { state, queen, qx, qy, attack, ant } = setup(caste, 5, colony), hp = queen.hp!;
      beginLocalGoals(state);
      countMarkDirection(state, buildGrid(state), [], ant, attack);
      expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: "combat", nativeReached: false, x: queen.queenX, y: queen.queenY });
      let bitTick: number | null = null;
      for (let n = 0; n < 80 && bitTick === null; n++) {
        beginLocalGoals(state);
        const { dir } = countMarkDirection(state, buildGrid(state), [], ant, attack);
        const frame = advanceSoftAnts(state, new Map([[ant.id, dir]]), new Set());
        expect(frame.pointRests.has(ant.id)).toBe(false);
        resolveCombat(state, buildGrid(state), state.tick++, []);
        if (queen.hp! < hp) bitTick = n;
      }
      expect(bitTick).not.toBeNull();
      expect(cheb(ant, qx, qy)).toBeLessThanOrEqual(2);
      expect(adjacentEnemyQueen(state, ant)).toBe(queen);
    });
  }

  it("chases an enemy ant near the target before walking to her", () => {
    const { state, qx, qy, attack, ant } = setup("worker", 5);
    const enemy = addAnt(state, 0, qx, qy + 4, { caste: "worker" });
    beginLocalGoals(state);
    countMarkDirection(state, buildGrid(state), [], ant, attack);
    expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: "combat", targetId: enemy.id });
  });

  it("fights an enemy ant in its reach where it stands", () => {
    const { state, qx, qy, attack, ant } = setup("soldier", 5);
    const enemy = addAnt(state, 0, qx + 6, qy, { caste: "worker" });
    beginLocalGoals(state);
    const { dir } = countMarkDirection(state, buildGrid(state), [], ant, attack);
    expect(dir).toEqual({ x: 0, y: 0 });
    expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: "combat", targetId: enemy.id, nativeReached: true });
  });

  it.each(["shield", "no-point-arrival", "gather", "distant-mark"] as const)("keeps its earlier movement for %s", condition => {
    const setupResult = setup("worker", 5), { attack, ant } = setupResult;
    let state = setupResult.state;
    if (condition === "shield") state.tick = state.config.queenHp!.shieldTicks - 1;
    if (condition === "no-point-arrival") state = { ...state, config: { ...state.config, pointArrival: undefined } };
    if (condition === "gather") attack.verb = "GATHER";
    if (condition === "distant-mark") attack.tileX += state.config.attackRadiusTiles + 10;
    beginLocalGoals(state);
    countMarkDirection(state, buildGrid(state), [], ant, attack);
    expect(currentLocalGoals(state).get(ant.id)?.kind).not.toBe("combat");
  });
});

/**
 * Real maps, seed 12345. A scripted seat for colony 1 joins at tick 2,800. At 3,000 (her shield ends) every ant
 * within 12 tiles of colony 0's queen is removed and hatching stops, 80 colony-1 workers are placed about 10 tiles
 * east of her, and one accepted ATTACK count mark lands on her tile. Before the fix both raids stalled with her
 * alive and no surviving attacker within her reach.
 */
function raid(config: SimConfig) {
  let state: SimState = createMatch(12345, config);
  const to = (t: number) => { while (state.tick < t) state = advance(state).state; };
  const q = activeQueens(state.colonies[0])[0]!, qx = Math.floor(q.queenX / SUB), qy = Math.floor(q.queenY / SUB);
  to(2800);
  state = advance(state, [{ type: "join", agentId: "raider", placement: 1 }]).state;
  to(3000);
  state.ants = state.ants.filter(a => cheb(a, qx, qy) > 12);
  for (const c of state.colonies) if (c.id !== 1) c.foodStore = 0;
  const ids = new Set<number>();
  for (let r = 0; ids.size < 80; r++) {
    const tx = qx + 10 + (r % 5) - 2, ty = qy + Math.floor(r / 5) % 9 - 4;
    const a = newAnt(state.config, state.nextAntId++, 1, tx * SUB + 500, ty * SUB + 500, "worker");
    state.ants.push(a); ids.add(a.id);
  }
  const out = advance(state, [{ type: "count_mark", agentId: "raider", tileX: qx, tileY: qy, verb: "ATTACK", count: 80, caste: "worker" } as SimInput]);
  expect(out.results[0]?.ok).toBe(true);
  state = out.state;
  const queen = () => state.colonies[0].queens!.find(x => x.id === q.id)!;
  for (let s = 1; s <= 300 && queen().lostTick === null && state.ants.some(a => ids.has(a.id)); s++) state = advance(state).state;
  return { lost: queen().lostTick !== null, attackersAlive: state.ants.filter(a => ids.has(a.id)).length };
}

describe("80 ground workers on an accepted ATTACK mark at an unguarded queen", () => {
  it("kill her in a two-colony match on Open Field", () => {
    const result = raid(newMatchConfig(rulesConfig("redesign")));
    expect(result.lost, JSON.stringify(result)).toBe(true);
  }, 60_000);
  it("kill her in a four-colony match on Crossroads", () => {
    const result = raid(quadrantMapConfig("crossroads"));
    expect(result.lost, JSON.stringify(result)).toBe(true);
  }, 60_000);
});
