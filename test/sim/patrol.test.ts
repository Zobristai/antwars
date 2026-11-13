import { describe, expect, it } from "vitest";
import { applyInput, countMarkDirection, defaultAllocator, lapseSquads } from "../../src/sim/agents.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { buildGrid } from "../../src/sim/map.js";
import { claimCountMarks, expireMarks } from "../../src/sim/marks.js";
import { countMarkVerbs, patrolChains, patrolWaypoint } from "../../src/sim/patrol.js";
import { step } from "../../src/sim/step.js";
import type { Agent, ColonyId, Mark, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";
import { addAnt, emptyMatch } from "./fixtures.js";

const config: SimConfig = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0,
  combatGraceTicks: 99_999, earlyWin: undefined };
function scene(extra: Partial<SimConfig> = {}, base: SimConfig = config) {
  const state = emptyMatch(100, { ...base, ...extra });
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 100, lastCommandTick: 100, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return state;
}
// Every match plays at grid scale 2: these helpers take reference tiles and place marks, count marks
// and ants at fine tile 2t, so every distance (and the six-tile patrol link, now twelve) doubles exactly.
function put(state: SimState, colony: ColonyId, tx: number, ty: number, patch: Parameters<typeof addAnt>[4] = {}) {
  return addAnt(state, colony, 2 * tx, 2 * ty, patch);
}
function mark(state: SimState, tileX: number, tileY = 20, options: Partial<Mark> = {}) {
  const item: Mark = { id: state.nextMarkId++, agentId: "a", colony: 0, tileX: 2 * tileX, tileY: 2 * tileY,
    words: [], laidTick: 10, steering: 0, verb: "PATROL", count: 20, ...options };
  state.marks.push(item);
  return item;
}
function lay(state: SimState, verb: string, tileX = 20, count = 2, caste?: string) {
  return applyInput(state, { type: "count_mark", agentId: "a", verb, tileX: 2 * tileX, tileY: 2 * 20, count, caste }, state.tick, defaultAllocator, []);
}

describe("patrol count-mark opt-in and unchanged claims", () => {
  it("scales the explicit six-tile link range to twelve fine tiles, never injecting it into old configs", () => {
    expect(newMatchConfig(rulesConfig("redesign")).patrolLinkTiles).toBe(12);
    for (const old of [rulesConfig("count-marks")]) {
      expect(old).not.toHaveProperty("patrolLinkTiles");
      expect(newMatchConfig(old)).not.toHaveProperty("patrolLinkTiles");
      expect(countMarkVerbs(old)).not.toContain("PATROL");
    }
  });

  it.each([undefined, "worker", "soldier"])("accepts, claims and re-lays PATROL with caste %s using existing allocation", caste => {
    const state = scene();
    const worker = put(state, 0, 20, 20, { caste: "worker" });
    const soldier = put(state, 0, 21, 20, { caste: "soldier" });
    expect(lay(state, "PATROL", 20, 2, caste).error).toBeNull();
    claimCountMarks(state, state.tick);
    const patrol = state.marks[0]!;
    expect(worker.claim).toBe(caste === "soldier" ? undefined : patrol.id);
    expect(soldier.claim).toBe(caste === "worker" ? undefined : patrol.id);
    state.tick++;
    expect(lay(state, "PATROL", 20, 1, caste).error).toBeNull();
    claimCountMarks(state, state.tick);
    expect(state.marks).toHaveLength(1);
    expect(patrol).toMatchObject({ laidTick: 100, count: 1, revision: 1 });
    expect(state.ants.filter(ant => ant.claim === patrol.id)).toHaveLength(1);
    expireMarks(state, 100 + config.markLifetimeTicks);
    claimCountMarks(state, state.tick);
    expect(state.marks).toEqual([]);
    expect(state.ants.every(ant => ant.claim === undefined)).toBe(true);
  });

  it("changes caste without renewing expiry and recruits far-away colony ants, never enemy or squad ants", () => {
    const state = scene();
    put(state, 0, 20, 20, { squad: "squad" });
    const worker = put(state, 0, 45, 20, { caste: "worker" });
    const soldier = put(state, 0, 44, 20, { caste: "soldier" });
    const enemy = put(state, 1, 20, 20);
    expect(lay(state, "PATROL", 20, 1, "worker").error).toBeNull();
    claimCountMarks(state, 100);
    expect(worker.claim).toBe(state.marks[0]!.id);
    expect(lay(state, "PATROL", 20, 1, "soldier").error).toBeNull();
    claimCountMarks(state, 100);
    expect(worker.claim).toBeUndefined();
    expect(soldier.claim).toBe(state.marks[0]!.id);
    expect(enemy.claim).toBeUndefined();
    expect(state.ants[0]!.claim).toBeUndefined();
    expect(state.marks[0]!.laidTick).toBe(100);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("refuses invalid patrol count %s just like GATHER", count => {
    const state = scene(); put(state, 0, 20, 20);
    expect(lay(state, "PATROL", 20, count).error?.code).toBe("bad_count_mark");
    expect(lay(state, "GATHER", 20, count).error?.code).toBe("bad_count_mark");
    expect(state.marks).toEqual([]);
  });

  it("shares placement, obstacles, invalid caste and command budget with existing jobs", () => {
    for (const verb of ["PATROL", "GATHER"]) {
      let state = scene({ commandFloorTicks: 100 }); put(state, 0, 20, 20);
      state.agents[0]!.lastCommandTick = null;
      expect(lay(state, verb, 27).error?.code).toBe("count_mark_not_visible");
      expect(lay(state, verb, 26, 1, "queen").error?.code).toBe("bad_count_mark");
      state = { ...state, terrain: { mapId: "blocked", mapName: "Blocked", water: [{ x: 50, y: 40, width: 2, height: 2 }],
        rocks: [{ x: 48, y: 40, width: 2, height: 2, appearance: 0 }] } };
      expect(lay(state, verb, 25).error?.code).toBe("water_tile");
      expect(lay(state, verb, 24).error?.code).toBe("rock_tile");
      expect(lay(state, verb, 26).error).toBeNull();
      expect(lay(state, verb, 21).error?.code).toBe("rate_limited");
      expect(state.marks).toHaveLength(1);
    }
  });
});

describe("derived patrol components and waypoints", () => {
  it("links Euclidean transitive components across teammates, not enemies, then joins/splits on a bridge", () => {
    const state = scene();
    const first = mark(state, 10), last = mark(state, 22, 20, { agentId: "mate" });
    const enemy = mark(state, 10, 20, { colony: 1 });
    const outOfEuclideanRange = mark(state, 28, 21);
    expect(patrolChains(state).get(first.id)!.chain).toEqual([first]);
    const bridge = mark(state, 16, 20, { laidTick: 11 });
    const chains = patrolChains(state);
    expect(chains.get(first.id)!.chain).toEqual([first, last, bridge]);
    expect(chains.get(last.id)!.chain).toBe(chains.get(first.id)!.chain);
    expect(chains.get(enemy.id)!.chain).toEqual([enemy]);
    expect(chains.get(outOfEuclideanRange.id)!.chain).toEqual([outOfEuclideanRange]);
    state.marks = state.marks.filter(item => item.id !== bridge.id);
    expect(patrolChains(state).get(last.id)!.chain).toEqual([last]);
  });

  it("orders by laying tick then id, starts nearest with lowest-id ties and repairs waypoints after splits", () => {
    const state = scene();
    const oldest = mark(state, 10, 20, { id: 90, laidTick: 0 });
    const newest = mark(state, 22, 20, { id: 2, laidTick: 10 });
    const bridge = mark(state, 16, 20, { id: 1, laidTick: 10 });
    const ant = put(state, 0, 19, 20, { claim: oldest.id });
    let chains = patrolChains(state);
    expect(chains.get(oldest.id)!.chain.map(item => item.id)).toEqual([90, 1, 2]);
    expect(patrolWaypoint(ant, chains.get(oldest.id)!, chains)).toBe(bridge);
    ant.patrolWaypoint = newest.id;
    state.marks = state.marks.filter(item => item !== bridge);
    chains = patrolChains(state);
    expect(patrolWaypoint(ant, chains.get(oldest.id)!, chains)).toBe(oldest);
    expect(ant.patrolWaypoint).toBe(oldest.id);
  });

  it("expiry and command-idle seat lapse split live components and clear released waypoints", () => {
    let state = scene();
    const left = mark(state, 10, 20, { laidTick: 100, agentId: "mate" });
    const bridge = mark(state, 16, 20, { laidTick: 0 });
    const right = mark(state, 22, 20, { laidTick: 100, agentId: "mate" });
    state.agents.push({ ...state.agents[0]!, id: "mate", lastCommandTick: 200, pendingEvents: [] });
    put(state, 0, 16, 20, { claim: bridge.id, patrolWaypoint: right.id });
    expireMarks(state, config.markLifetimeTicks);
    expect(patrolChains(state).get(left.id)!.chain).toEqual([left]);
    expect(patrolChains(state).get(right.id)!.chain).toEqual([right]);
    state = step(state).state;
    expect(state.ants[0]!.patrolWaypoint).toBe(left.id); // Released, then reclaimed by the remaining oldest mark.
    expect(state.ants[0]!.claim).toBe(left.id);
    const newBridge = mark(state, 16, 20);
    expect(patrolChains(state).get(left.id)!.chain).toHaveLength(3);
    lapseSquads(state, state.agents[0]!.lastCommandTick! + config.commandIdleTicks!, []);
    expect(state.marks.some(item => item.id === newBridge.id)).toBe(false);
    expect(patrolChains(state).get(right.id)!.chain).toEqual([right]);
    state.marks = [];
    state = step(state).state;
    expect(state.ants[0]!.patrolWaypoint).toBeUndefined();
  });

  it.each([2, 3])("travels a %i-mark laid-order loop and returns to oldest", size => {
    let state = scene();
    const first = mark(state, 20), second = mark(state, 24, 20, { laidTick: 11 });
    const third = size === 3 ? mark(state, 22, 24, { laidTick: 12 }) : undefined;
    const ant = put(state, 0, 20, 20, { claim: first.id, patrolWaypoint: first.id });
    const changes: number[] = [];
    let prior = first.id;
    for (let i = 0; i < 140; i++) {
      state = step(state).state;
      const waypoint = state.ants.find(item => item.id === ant.id)!.patrolWaypoint!;
      if (waypoint !== prior) { changes.push(waypoint); prior = waypoint; }
    }
    expect(changes.slice(0, size + 1)).toEqual(third ? [second.id, third.id, first.id, second.id] : [second.id, first.id, second.id]);
  });

  it("advances a same-goal crowd, including ants outside the native arrival radius", () => {
    let state = scene(); const first = mark(state, 20), second = mark(state, 24);
    const ants = [580, 860, 1140].map(dx => put(state, 0, 20, 20,
      { x: 40.5 * SUB + dx, claim: first.id, patrolWaypoint: first.id }));
    state = step(state).state;
    for (const ant of ants) expect(state.ants.find(item => item.id === ant.id)!.patrolWaypoint).toBe(second.id);
    state = step(state).state;
    expect(state.ants.every(ant => ant.vx > 0)).toBe(true);
  });

  it("pauses to bite enemies in reach and resumes the retained waypoint", () => {
    let state = scene({ combatGraceTicks: 0 });
    const first = mark(state, 20), second = mark(state, 24);
    const own = put(state, 0, 21, 20, { claim: first.id, patrolWaypoint: second.id });
    const enemy = put(state, 1, 21, 20, { hp: 1 });
    expect(countMarkDirection(state, buildGrid(state), [], own, first).dir).toEqual({ x: 0, y: 0 });
    state = step(state).state;
    expect(state.ants.some(ant => ant.id === enemy.id)).toBe(false);
    expect(state.ants.find(ant => ant.id === own.id)!.patrolWaypoint).toBe(second.id);
    state = step(state).state;
    expect(state.ants.find(ant => ant.id === own.id)!.vx).toBeGreaterThan(0);
  });

  it.each(["worker", "soldier"] as const)("a lone patrol has identical %s movement to DEFEND, including post-push area bounds", caste => {
    const start = scene({ antSpeedTilesPerSecond: 0 });
    const point = mark(start, 20);
    put(start, 0, 23, 20, { caste, claim: point.id, x: 2 * (24 * SUB - 1) });
    put(start, 0, 23, 20, { caste, x: 2 * (24 * SUB - 90) });
    const patrol = step(start).state;
    point.verb = "DEFEND";
    const defend = step(start).state;
    expect(patrol.ants.map(({ x, y, vx, vy }) => ({ x, y, vx, vy }))).toEqual(defend.ants.map(({ x, y, vx, vy }) => ({ x, y, vx, vy })));
  });

  it("observe reports each patrol mark’s oldest chain id and zero-based position only on patrols", () => {
    const state = scene();
    const first = mark(state, 20), second = mark(state, 24, 20, { agentId: "mate", laidTick: 11 });
    const gather = mark(state, 20, 21, { verb: "GATHER" });
    put(state, 0, 22, 20);
    const view = takeView(state, buildGrid(state), state.agents[0]!);
    expect(view.marks.find(item => item.markId === first.id)).toMatchObject({ chain: first.id, position: 0 });
    expect(view.marks.find(item => item.markId === second.id)).toMatchObject({ chain: first.id, position: 1 });
    expect(view.myMarks.find(item => item.markId === first.id)).toMatchObject({ chain: first.id, position: 0 });
    expect(view.marks.find(item => item.markId === gather.id)).not.toHaveProperty("chain");
  });
});

describe("patrol-free count-mark configs", () => {
  it("refuses PATROL without changing marks, command allowance or ant state", () => {
    const { patrolLinkTiles: _patrol, ...old } = config;
    const state = scene({}, old);
    put(state, 0, 20, 20);
    const before = JSON.stringify(state);
    expect(lay(state, "PATROL").error?.code).toBe("bad_count_mark");
    expect(JSON.stringify(state)).toBe(before);
    const after = step(state).state;
    expect(after.ants.every(ant => !("patrolWaypoint" in ant))).toBe(true);
    expect(after.config).not.toHaveProperty("patrolLinkTiles");
  });
});
