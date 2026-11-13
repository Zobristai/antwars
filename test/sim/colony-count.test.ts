import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { gridScaleOf } from "../../src/sim/gridScale.js";
import { chooseJoinColony, defaultAllocator, fillSquads } from "../../src/sim/agents.js";
import { adjacentEnemyQueen, resolveCombat } from "../../src/sim/combat.js";
import { pickupAndDeliver } from "../../src/sim/forage.js";
import { houseDirection, nearestIntruder, sightScan } from "../../src/sim/houseBot.js";
import { beginLocalGoals, noteContact, readLocalGoal } from "../../src/sim/localArrival.js";
import { buildGrid, cloneState, createMatch, GridTracker, hasAdjacentEnemy, newColony, newStats, noEnemyNear, tileIndex, type Grid } from "../../src/sim/map.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { updateTerritory } from "../../src/sim/territory.js";
import type { Agent, Ant, ColonyId, Mark, QueenState, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt, HISTORICAL_CONFIG, PRE_FRONTLINE_CONFIGS } from "./fixtures.js";
import { playable } from "../playable.ts";

const LIVE = playable(rulesConfig("redesign"));
const SEED = 404;
/** After the combat grace and the queen shield, so ants and queens both fight. */
const FIGHT_TICK = Math.max(LIVE.combatGraceTicks, LIVE.queenHp!.shieldTicks) + 10;

function openTile(state: SimState, tx: number, ty: number): boolean {
  return !isBlockedTile(state.terrain, tx, ty) && (state.food[tileIndex(state.config, tx, ty)] ?? 0) === 0;
}

/** The first square of side `size` from (x0, y0) onward whose tiles are all passable and hold no food. */
function openArea(state: SimState, size: number, x0 = 8, y0 = 8): { tx: number; ty: number } {
  const { mapWidth, mapHeight } = state.config;
  for (let ty = y0; ty + size < mapHeight; ty += 1) for (let tx = x0; tx + size < mapWidth; tx += 1) {
    let open = true;
    for (let dy = 0; open && dy < size; dy += 1) for (let dx = 0; open && dx < size; dx += 1) open = openTile(state, tx + dx, ty + dy);
    if (open) return { tx, ty };
  }
  throw new Error("no open area");
}

/**
 * A four-colony match: a live-rules match with colonies 2 and 3 added from the production initialisers, queens
 * on distinct passable tiles without food, four-colony stats, and no ants.
 */
function fourColonyMatch(tick = FIGHT_TICK): SimState {
  const state = createMatch(SEED, LIVE);
  const taken = new Set(state.colonies.map((c) => tileIndex(state.config, Math.floor(c.queenX / SUB), Math.floor(c.queenY / SUB))));
  for (const id of [2, 3]) {
    const { tx, ty } = openArea(state, 1, 60, id === 2 ? 10 : 80);
    expect(taken.has(tileIndex(state.config, tx, ty))).toBe(false);
    taken.add(tileIndex(state.config, tx, ty));
    state.colonies.push(newColony(state.config, id, tileCentre(tx), tileCentre(ty)));
  }
  state.stats = newStats(4);
  state.ants = [];
  state.tick = tick;
  return state;
}

function queenOf(state: SimState, colony: ColonyId, id = 0): QueenState {
  return state.colonies[colony]!.queens!.find((q) => q.id === id)!;
}

function grids(state: SimState): [string, Grid][] {
  return [["buildGrid", buildGrid(state)], ["tracked", new GridTracker().sync(state)]];
}

const PAIRS: [ColonyId, ColonyId][] = [];
for (let a = 0; a < 4; a += 1) for (let b = 0; b < 4; b += 1) if (a !== b) PAIRS.push([a, b]);

describe("colony initialisers", () => {
  const families: [string, SimConfig][] = [
    ["default", DEFAULT_CONFIG], ["historical", HISTORICAL_CONFIG], ["public", rulesConfig(undefined)],
    ["pre-frontline public", PRE_FRONTLINE_CONFIGS.public], ["pre-frontline count-marks", PRE_FRONTLINE_CONFIGS["count-marks"]],
    ["pre-frontline redesign", PRE_FRONTLINE_CONFIGS.redesign], ["live redesign", rulesConfig("redesign")],
  ];
  for (const [name, config] of families) it(`builds colonies 0 to 3 like createMatch (${name})`, () => {
    const state = createMatch(SEED, playable(config));
    for (const colony of state.colonies) expect(newColony(state.config, colony.id, colony.queenX, colony.queenY)).toStrictEqual(colony);
    for (const id of [2, 3]) {
      const colony = newColony(state.config, id, tileCentre(40 + id), tileCentre(30));
      expect(colony.id).toBe(id);
      expect([colony.queenX, colony.queenY]).toEqual([tileCentre(40 + id), tileCentre(30)]);
      if (colony.queens !== undefined) expect(colony.queens.map((q) => [q.id, q.queenX, q.queenY])).toEqual([[0, tileCentre(40 + id), tileCentre(30)]]);
    }
    expect(newStats(2)).toStrictEqual(state.stats);
  });

  it("gives four-colony stats one entry per colony and clones every colony independently", () => {
    const stats = newStats(4);
    for (const counts of [stats.delivered, stats.hatched, stats.deaths, stats.bonusHits]) expect(counts).toEqual([0, 0, 0, 0]);
    const state = fourColonyMatch();
    const copy = cloneState(state);
    expect(copy.colonies).toHaveLength(4);
    expect(copy.colonies).toStrictEqual(state.colonies);
    copy.colonies[3]!.foodStore += 5;
    copy.colonies[2]!.queens![0]!.hp = 1;
    copy.stats.deaths[3] += 1;
    expect(state.colonies[3]!.foodStore).toBe(0);
    expect(queenOf(state, 2).hp).toBe(LIVE.queenHp!.hp);
    expect(state.stats.deaths[3]).toBe(0);
  });
});

describe("every ordered pair of colonies are enemies", () => {
  for (const [a, b] of PAIRS) it(`colony ${a} and colony ${b}`, () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 2);
    const first = addAnt(state, a, tx, ty), second = addAnt(state, b, tx + 1, ty);
    for (const [name, grid] of grids(state)) {
      expect(hasAdjacentEnemy(state, grid, first), name).toBe(true);
      expect(hasAdjacentEnemy(state, grid, second), name).toBe(true);
      expect(noEnemyNear(state, grid, a, tx, ty, gridScaleOf(state.config)), name).toBe(false);
    }
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), state.tick, events);
    const fights = events.flatMap((e) => e.type === "fight" ? [[e.antId, e.targetId]] : []);
    expect(fights).toEqual(expect.arrayContaining([[first.id, second.id], [second.id, first.id]]));
  });

  for (const colony of [0, 1, 2, 3]) it(`never sets colony ${colony} against itself`, () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 2);
    const first = addAnt(state, colony, tx, ty);
    addAnt(state, colony, tx + 1, ty);
    for (const [name, grid] of grids(state)) expect(hasAdjacentEnemy(state, grid, first), name).toBe(false);
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), state.tick, events);
    expect(events.filter((e) => e.type === "fight")).toEqual([]);
  });
});

describe("sight", () => {
  it("sees a colony-3 enemy from a colony-2 ant, as the per-ant scan does", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 6);
    const ant = addAnt(state, 2, tx, ty);
    addAnt(state, 2, tx + 1, ty + 1);
    const enemy = addAnt(state, 3, tx + 5, ty);
    const r = state.config.sightTiles;
    const perAnt = sightScan(state, new Map(buildGrid(state)), ant, tx, ty, r);
    for (const [name, grid] of grids(state)) {
      const scan = sightScan(state, grid, ant, tx, ty, r);
      expect(scan.enemy, name).toBeGreaterThanOrEqual(1);
      expect(scan.nearestEnemy, name).toBe(enemy);
      expect(scan, name).toEqual(perAnt);
    }
  });
});

describe("per-tile memos keep colonies apart", () => {
  /** Colony 0 at tile t + 1, listed first, and colony 2 at tile t: one key under a two-colony key. */
  function collision() {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 3);
    const zero = addAnt(state, 0, tx + 1, ty);
    const two = addAnt(state, 2, tx, ty);
    const twoBelow = addAnt(state, 2, tx, ty + 1);
    return { state, tx, ty, zero, two, twoBelow };
  }
  const colonyOf = (state: SimState, id: number) => state.ants.find((ant) => ant.id === id)!.colony;

  it("in combat targets", () => {
    const { state } = collision();
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), state.tick, events);
    const fights = events.flatMap((e) => e.type === "fight" ? [e] : []);
    expect(fights.length).toBeGreaterThan(0);
    for (const fight of fights) expect(colonyOf(state, fight.targetId)).not.toBe(fight.colony);
  });

  it("in contact goals", () => {
    const { state, zero, two } = collision();
    beginLocalGoals(state);
    const grid = buildGrid(state);
    expect(noteContact(state, zero, grid)).toBe(true);
    expect(noteContact(state, two, grid)).toBe(true);
    expect(colonyOf(state, readLocalGoal(state, two)!.targetId!)).not.toBe(2);
    expect(readLocalGoal(state, two)!.targetId).toBe(zero.id);
  });

  it("in queen intruders", () => {
    const { state, tx, ty, zero, two } = collision();
    const grid = buildGrid(state);
    expect(nearestIntruder(state, grid, zero, tx + 1, ty, 4)?.colony).toBe(2);
    expect(nearestIntruder(state, grid, two, tx, ty, 4)).toBe(zero);
  });
});

describe("queens", () => {
  it("lets a colony-2 ant bite colony 1's queen beside it", () => {
    const state = fourColonyMatch();
    const queen = queenOf(state, 1);
    const ant = addAnt(state, 2, Math.floor(queen.queenX / SUB) - 1, Math.floor(queen.queenY / SUB));
    expect(adjacentEnemyQueen(state, ant)).toBe(queen);
  });

  /**
   * A colony-2 house fighter in sight of colony 0's queens and of no enemy ant, holding a queen intent selected
   * one tick ago.
   */
  function heldFighter(state: SimState, hold: { targetId: number; targetColony: ColonyId }) {
    const queen = queenOf(state, 0);
    const { tx, ty } = openArea(state, 1, Math.floor(queen.queenX / SUB) + 6, Math.floor(queen.queenY / SUB) - 2);
    expect(Math.abs(tx - Math.floor(queen.queenX / SUB)) + Math.abs(ty - Math.floor(queen.queenY / SUB))).toBeLessThan(state.config.sightTiles);
    const ant = addAnt(state, 2, tx, ty, { role: "fighter" });
    const intent = { kind: "queen" as const, targetId: hold.targetId, x: ant.x, y: ant.y, targetColony: hold.targetColony };
    (ant as Ant & { houseIntentHold?: unknown }).houseIntentHold = { intent, role: "fighter", selectedTick: state.tick - 1 };
    houseDirection(state, buildGrid(state), [], ant);
    return (ant as Ant & { houseIntentHold: { intent: { targetId: number; targetColony?: ColonyId }; selectedTick: number } }).houseIntentHold;
  }

  it("keeps a held colony-3 queen target while she lives, with colony 0's first queen lost", () => {
    const state = fourColonyMatch();
    const zero = state.colonies[0]!;
    zero.queens = [{ ...zero.queens![0]!, lostTick: 1 }, { ...zero.queens![0]!, id: 1, starting: undefined }];
    const held = heldFighter(state, { targetId: 0, targetColony: 3 });
    expect(held.intent).toMatchObject({ targetId: 0, targetColony: 3 });
    expect(held.selectedTick).toBe(state.tick - 1);
  });

  it("drops a held target naming the ant's own colony, though that queen lives", () => {
    const state = fourColonyMatch();
    const held = heldFighter(state, { targetId: 0, targetColony: 2 });
    expect(held.intent.targetColony).not.toBe(2);
    expect(held.selectedTick).toBe(state.tick);
  });

  it("drops a held colony-3 queen target once she is lost, while colony 0's first queen lives", () => {
    const state = fourColonyMatch();
    queenOf(state, 3).lostTick = 1;
    const held = heldFighter(state, { targetId: 0, targetColony: 3 });
    expect(held.intent.targetColony).not.toBe(3);
    expect(held.selectedTick).toBe(state.tick);
  });
});

describe("territory", () => {
  function ownersAround(state: SimState, tx: number, ty: number, width: number): number[] {
    const owners: number[] = [];
    for (let y = ty; y < ty + 2; y += 1) for (let x = tx; x < tx + width; x += 1) owners.push(state.owner[tileIndex(state.config, x, y)]!);
    return owners;
  }

  it("locks a colony-2 ant's cell and the adjacent colony-3 ant's cell", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 6, 40, 40);
    // Original cells are two fine tiles wide: start on a cell boundary.
    const x = tx + (tx % 2), y = ty + (ty % 2);
    addAnt(state, 2, x + 1, y);
    addAnt(state, 3, x + 2, y);
    updateTerritory(state, undefined, state.tick);
    expect(ownersAround(state, x, y, 4)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("locks a cell colonies 1 and 3 share", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 6, 40, 40);
    // Original cells are two fine tiles wide: start on a cell boundary.
    const x = tx + (tx % 2), y = ty + (ty % 2);
    addAnt(state, 1, x, y);
    addAnt(state, 3, x + 1, y + 1);
    updateTerritory(state, undefined, state.tick);
    expect(ownersAround(state, x, y, 2)).toEqual([-1, -1, -1, -1]);
  });
});

describe("count marks", () => {
  function countMark(state: SimState, colony: ColonyId, tx: number, ty: number): Mark {
    const mark: Mark = { id: state.nextMarkId++, agentId: `agent-${colony}`, colony, tileX: tx, tileY: ty, words: [], laidTick: state.tick,
      steering: 0, verb: "ATTACK", count: 4, antsLost: 0, enemiesKilled: 0 };
    state.marks.push(mark);
    return mark;
  }

  it("credits a colony-3 death to the colony-2 claimants' mark only", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 2);
    const two = countMark(state, 2, tx, ty), three = countMark(state, 3, tx, ty);
    addAnt(state, 2, tx, ty, { claim: two.id });
    const victim = addAnt(state, 3, tx + 1, ty, { claim: three.id, hp: 1 });
    resolveCombat(state, buildGrid(state), state.tick, []);
    expect(state.ants.some((ant) => ant.id === victim.id)).toBe(false);
    expect([two.enemiesKilled, two.antsLost, three.enemiesKilled, three.antsLost]).toEqual([1, 0, 0, 1]);
    expect(state.stats.deaths).toEqual([0, 0, 0, 1]);
  });

  it("recruits colony 2 and colony 3 ants to their own colony's marks only", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 3);
    const two = countMark(state, 2, tx, ty), three = countMark(state, 3, tx + 2, ty);
    const ants = [addAnt(state, 2, tx, ty + 1), addAnt(state, 3, tx + 1, ty), addAnt(state, 2, tx + 2, ty + 1), addAnt(state, 3, tx + 1, ty + 2)];
    claimCountMarks(state, state.tick);
    for (const ant of ants) expect(ant.claim).toBe(ant.colony === 2 ? two.id : three.id);
  });
});

describe("joins, squads and delivery", () => {
  it("joins the colony with the fewest agents, then the lowest colony, and honours placement of any colony in the match", () => {
    expect(chooseJoinColony([2, 1, 1, 0], {})).toBe(3);
    expect(chooseJoinColony([1, 0, 0, 1], {})).toBe(1);
    expect(chooseJoinColony([1, 1, 1, 1], {})).toBe(0);
    expect(chooseJoinColony([0, 0, 0, 0], { placement: 3 })).toBe(3);
    expect(chooseJoinColony([0, 0, 0, 0], { colony: 2 })).toBe(2);
    // A placement outside a two-colony match is ignored, as before.
    expect(chooseJoinColony([1, 0], { placement: 3 })).toBe(1);
    const state = fourColonyMatch();
    const agent = (id: string, colony: ColonyId, joinSeq: number): Agent => ({ id, colony, joinSeq, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
    state.agents.push(agent("a", 0, 0), agent("b", 1, 1), agent("c", 3, 2));
    expect(defaultAllocator.chooseColony(state, { type: "join", agentId: "d" })).toBe(2);
  });

  it("fills squads for colonies 2 and 3", () => {
    const state = fourColonyMatch();
    const { tx, ty } = openArea(state, 4);
    for (let i = 0; i < 4; i += 1) { addAnt(state, 2, tx + i, ty); addAnt(state, 3, tx + i, ty + 3); }
    state.agents.push(
      { id: "two", colony: 2, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] },
      { id: "three", colony: 3, joinSeq: 1, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] },
    );
    fillSquads(state, defaultAllocator, state.tick, []);
    for (const agent of state.agents) {
      expect(agent.squad.length).toBeGreaterThan(0);
      for (const id of agent.squad) expect(state.ants.find((ant) => ant.id === id)!.colony).toBe(agent.colony);
    }
  });

  it("delivers a colony-3 carrier's food to colony 3", () => {
    const state = fourColonyMatch();
    const queen = queenOf(state, 3);
    const carrier = addAnt(state, 3, Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB), { carrying: true });
    pickupAndDeliver(state, new Set());
    expect(carrier.carrying).toBe(false);
    expect(state.colonies[3]!.foodStore).toBe(1);
    expect(state.stats.delivered).toEqual([0, 0, 0, 1]);
  });
});
