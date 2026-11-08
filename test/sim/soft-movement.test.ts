import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { rulesConfig } from "../../src/sim/config.js";
import { createMatch, newAnt, buildGrid, cloneState } from "../../src/sim/map.js";
import { withinTiles, type Vec } from "../../src/sim/geometry.js";
import { beginLocalGoals, clusterArrivals, type LocalGoal } from "../../src/sim/localArrival.js";
import { advanceSoftAnts, step } from "../../src/sim/step.js";
import { countMarkDirection } from "../../src/sim/agents.js";
import { localDirection } from "../../src/sim/houseBot.js";
import { forageDirection, pickupAndDeliver, foodTargetHeld } from "../../src/sim/forage.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { segmentOnLand } from "../../src/sim/terrain.js";
import type { Ant, Caste, ColonyId, CountVerb, Mark, SimEvent, SimState } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

// These fixtures are the frozen spread/fixed-check inputs, now exercising production modules.
// Every match plays at grid scale 2: reference tile t is fine tiles 2t and 2t+1, and every length doubles.
// Reference tile 20's centre (20500) is placed at fine tile 40's centre (40500); offsets between ants double.
const { soldierRadius: _soldierRadius, guardSettle: _guardSettle, restPass: _restPass, ...frozenSoft } = rulesConfig("redesign").softSeparation!;
const config = playable({ ...rulesConfig("redesign"), pointArrival: undefined, softSeparation: frozenSoft, startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] });
function scene(): SimState {
  const state = createMatch(10, config);
  state.ants = [];
  state.food.fill(0);
  return state;
}
function add(state: SimState, colony: ColonyId, x: number, y: number, caste: Caste = "soldier"): Ant {
  const ant = newAnt(config, state.nextAntId++, colony, x, y, caste);
  state.ants.push(ant);
  return ant;
}
function mark(id: number, colony: ColonyId, verb: CountVerb, tileX = 40, tileY = 40): Mark {
  return { id, agentId: "check", colony, tileX, tileY, words: [], laidTick: 0, steering: 0, verb, count: 512 };
}
function phase(state: SimState) {
  beginLocalGoals(state);
  const dirs = new Map<number, Vec>(), foraging = new Set<number>(), grid = buildGrid(state);
  for (const ant of state.ants) {
    const choice = ant.claim === undefined ? localDirection(state, grid, ant)
      : countMarkDirection(state, grid, [], ant, state.marks.find(m => m.id === ant.claim)!);
    dirs.set(ant.id, choice.dir);
    if (choice.foraging) foraging.add(ant.id);
  }
  const frame = advanceSoftAnts(state, dirs, foraging);
  for (const ant of state.ants) {
    const origin = frame.origins.get(ant.id)!;
    expect((ant.x - origin.x) ** 2 + (ant.y - origin.y) ** 2).toBeLessThanOrEqual(400 ** 2);
  }
  return frame;
}
function positions(state: SimState) {
  return state.ants.map(a => [a.id, a.x, a.y]).sort((a, b) => a[0]! - b[0]!);
}

describe("frozen autonomous soft movement", () => {
  it("keeps the frozen configuration and spreads the exact 200-ant pile in 150 ticks", () => {
    expect(config.softSeparation).toEqual({ radius: 200, strength: 3200, maxStep: 400, arrivalSubunits: 600, epsilon: 2, arrivalLinkRadius: 300 });
    const state = scene();
    state.marks = [{ ...mark(1, 0, "GATHER"), count: 200 }];
    for (let i = 0; i < 200; i++) add(state, 0, 40500, 40500, i % 2 ? "soldier" : "worker").claim = 1;
    for (let tick = 1; tick <= 150; tick++) {
      state.tick = tick;
      const frame = phase(state);
      for (const [id, arrival] of frame.decisionArrival) {
        if (!arrival.arrived) continue;
        const goal = frame.decisionGoals.get(id)!;
        const root = frame.decisionGoals.get(arrival.rootId!)!;
        expect(root.nativeReached).toBe(true);
        expect(root.key).toBe(goal.key);
        if (arrival.parentId !== null) {
          const a = frame.origins.get(id)!, b = frame.origins.get(arrival.parentId)!;
          expect((a.x - b.x) ** 2 + (a.y - b.y) ** 2).toBeLessThanOrEqual(300 ** 2);
        }
      }
    }
    const within = state.ants.filter(a => (a.x - 40500) ** 2 + (a.y - 40500) ** 2 <= 600 ** 2).length;
    const counts = new Map<string, number>();
    for (const a of state.ants) counts.set(`${a.x},${a.y}`, (counts.get(`${a.x},${a.y}`) ?? 0) + 1);
    expect(within).toBeLessThanOrEqual(35);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it.each([0, 80, 2000])("preserves actual enemy bites and contact at offset %i", offset => {
    const state = scene(), a = add(state, 0, 40500, 40500), b = add(state, 1, 40500 + offset, 40500);
    const hp = [a.hp, b.hp];
    state.tick = config.combatGraceTicks + 1;
    phase(state);
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), state.tick, events);
    expect(a.hp).toBeLessThan(hp[0]!);
    expect(b.hp).toBeLessThan(hp[1]!);
    expect(events.filter(e => e.type === "fight")).toHaveLength(2);
  });

  for (const verb of ["DEFEND", "ATTACK"] as const) {
    it.each(["inside", "outside-unarrived", "outside-old-arrival-flags"])(`${verb} stays or returns: %s`, mode => {
      const state = scene();
      state.marks = [mark(1, 0, verb)];
      const x = mode === "inside" ? 40500 : 50500;
      add(state, 0, x, 40500).claim = 1;
      add(state, 0, x + 200, 40500).claim = 1;
      if (mode === "outside-old-arrival-flags") for (const ant of state.ants) Object.assign(ant, { oldArrival: { arrived: true } });
      let entered = mode === "inside";
      for (let tick = 1; tick <= 100; tick++) {
        state.tick = tick;
        const frame = phase(state);
        if (tick === 1 && mode !== "inside") expect([...frame.decisionArrival.values()].map(a => a.arrived)).toEqual([false, false]);
        const inside = state.ants.every(a => withinTiles(Math.floor(a.x / 1000), Math.floor(a.y / 1000), 40, 40, 6));
        if (entered) expect(inside).toBe(true);
        if (inside) entered = true;
      }
      expect(entered).toBe(true);
    });
  }

  it("ATTACK pursues inside its area until real contact deals damage", () => {
    const state = scene();
    state.marks = [mark(1, 0, "ATTACK"), mark(2, 1, "GATHER", 44, 40)];
    const a = add(state, 0, 40500, 40500), b = add(state, 1, 45300, 40500);
    a.claim = 1; b.claim = 2;
    let fights = 0;
    for (let tick = 1; tick <= 30; tick++) {
      state.tick = config.combatGraceTicks + tick;
      phase(state);
      expect(withinTiles(Math.floor(a.x / 1000), Math.floor(a.y / 1000), 40, 40, 6)).toBe(true);
      if (Math.abs(Math.floor(a.x / 1000) - Math.floor(b.x / 1000)) <= 2 && Math.abs(Math.floor(a.y / 1000) - Math.floor(b.y / 1000)) <= 2) {
        const hp = a.hp + b.hp, events: SimEvent[] = [];
        resolveCombat(state, buildGrid(state), state.tick, events);
        expect(a.hp + b.hp).toBeLessThan(hp);
        fights = events.filter(e => e.type === "fight").length;
        break;
      }
    }
    expect(fights).toBeGreaterThan(0);
  });

  it("recomputes anchored arrival after removal of the native seed", () => {
    const state = scene(); state.marks = [mark(1, 0, "GATHER")];
    const a = add(state, 0, 41100, 40500), b = add(state, 0, 41400, 40500), c = add(state, 0, 41700, 40500);
    for (const ant of state.ants) ant.claim = 1;
    const first = phase(state);
    expect([...first.decisionArrival.values()].every(a => a.arrived)).toBe(true);
    expect(first.decisionArrival.get(c.id)!.hops).toBe(2);
    state.ants = state.ants.filter(ant => ant.id !== a.id);
    for (const ant of state.ants) Object.assign(ant, { oldArrival: { arrived: true } });
    expect([...phase(state).decisionArrival.values()].every(a => !a.arrived)).toBe(true);
    expect(b.id).not.toBe(c.id);
  });

  it("does not propagate arrival across a goal or colony", () => {
    const state = scene(), a = add(state, 0, 41100, 40500), b = add(state, 0, 41400, 40500), c = add(state, 1, 41400, 40500);
    const goals = new Map<number, LocalGoal>([[a.id, { key: "same", nativeReached: true }], [b.id, { key: "different", nativeReached: false }], [c.id, { key: "same", nativeReached: false }]]);
    const arrivals = clusterArrivals(state.ants, goals, 300);
    expect(arrivals.get(b.id)!.arrived).toBe(false);
    expect(arrivals.get(c.id)!.arrived).toBe(false);
  });

  it("still pushes ants exactly at the push-radius boundary", () => {
    const state = scene(); state.marks = [mark(1, 0, "GATHER")];
    const a = add(state, 0, 40500, 40500), b = add(state, 0, 40700, 40500); a.claim = 1; b.claim = 1;
    phase(state);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(200);
    expect(a.x).not.toBe(40500); expect(b.x).not.toBe(40700);
  });

  it("retargets a cluster-only forager but grants food only on its actual tile", () => {
    const state = scene(), a = add(state, 0, 40020, 40500, "worker"), b = add(state, 0, 39980, 40500, "worker");
    const target = 40 * config.mapWidth + 40, other = target - 1;
    state.food[target] = 5; state.food[other] = 3; a.foodTarget = target; b.foodTarget = target;
    beginLocalGoals(state);
    const dirs = new Map(state.ants.map(ant => [ant.id, forageDirection(state, ant, [target, other], true)]));
    const frame = advanceSoftAnts(state, dirs, new Set([a.id, b.id]));
    expect(frame.retargeted).toContain(b.id);
    expect(frame.goals.get(b.id)!.targetId).toBe(other);
    expect(Math.floor(b.x / 1000)).toBe(39); expect(b.carrying).toBe(false);
    pickupAndDeliver(state, new Set([a.id, b.id]));
    expect(b.carrying).toBe(true); expect(state.food[other]).toBe(2);
  });

  it("uses the ordinary no-food home fallback when there is no alternative", () => {
    const state = scene(), a = add(state, 0, 40020, 40500, "worker"), b = add(state, 0, 39980, 40500, "worker");
    const target = 40 * config.mapWidth + 40; state.food[target] = 5; a.foodTarget = target; b.foodTarget = target;
    const expected = cloneState(state), expectedAnt = expected.ants.find(a => a.id === b.id)!;
    expectedAnt.foodTarget = -1;
    const expectedHeading = forageDirection(expected, expectedAnt, [], true);
    beginLocalGoals(state);
    const dirs = new Map(state.ants.map(ant => [ant.id, forageDirection(state, ant, [target], true)]));
    const frame = advanceSoftAnts(state, dirs, new Set([a.id, b.id]));
    expect(frame.retargeted).toContain(b.id); expect(frame.directions.get(b.id)).toEqual(expectedHeading);
    expect(b.foodTarget).toBe(-1); expect(frame.goals.get(b.id)!.kind).toBe("fallback");
  });

  it("keeps the on-tile depletion release and en-route target hold", () => {
    const state = scene(), a = add(state, 0, 40500, 40500, "worker");
    const east = 40 * config.mapWidth + 44, west = east - 8;
    state.food[east] = 1; state.food[west] = 5;
    // Test an existing en-route target, not the current mirrored tie-break for a new one.
    a.foodTarget = east;
    forageDirection(state, a, [east, west], true);
    expect(a.foodTarget).toBe(east); state.food[east] = 0; state.tick = 1;
    expect(foodTargetHeld(state, a)).toBe(true); a.x = 44500;
    expect(foodTargetHeld(state, a)).toBe(false); forageDirection(state, a, [west], true);
    expect(a.foodTarget).toBe(west); expect(foodTargetHeld(state, a)).toBe(true);
  });

  it("has order-independent integrated arrival and motion", () => {
    const state = scene(); state.marks = [mark(1, 0, "GATHER")];
    for (let i = 0; i < 32; i++) add(state, 0, 40500, 40500).claim = 1;
    const reversed = cloneState(state); reversed.ants.reverse();
    phase(state); phase(reversed); expect(positions(state)).toEqual(positions(reversed));
  });

  it("never pushes through blocked terrain", () => {
    const state: SimState = { ...scene(), terrain: { mapId: "probe", mapName: "probe", water: [{ x: 42, y: 40, width: 2, height: 2 }] } };
    state.marks = [mark(1, 0, "GATHER")];
    add(state, 0, 41998, 40500).claim = 1; add(state, 0, 41920, 40500).claim = 1;
    const origins = new Map(state.ants.map(a => [a.id, { x: a.x, y: a.y }])); phase(state);
    for (const a of state.ants) {
      const origin = origins.get(a.id)!;
      expect(segmentOnLand(config, state.terrain, origin.x, origin.y, a.x, a.y)).toBe(true);
    }
  });

  it("lets a traveler cross the dense shared-goal cluster", () => {
    const state = scene(); state.marks = [mark(1, 0, "GATHER"), mark(2, 0, "GATHER", 60, 40)];
    for (let i = 0; i < 100; i++) add(state, 0, 40500, 40500).claim = 1;
    const traveler = add(state, 0, 32500, 40500, "worker"); traveler.claim = 2;
    for (let tick = 1; tick <= 100; tick++) { state.tick = tick; phase(state); }
    expect(traveler.x).toBeGreaterThan(48500);
  });

  it("leaves queens fixed while ants on a queen tile separate and delivery still needs physical reach", () => {
    const state = scene(), queen = state.colonies[0]!.queens![0]!;
    const { queenX, queenY } = queen;
    const a = add(state, 0, queenX, queenY, "worker"), b = add(state, 0, queenX, queenY, "worker");
    a.carrying = true; b.carrying = true;
    phase(state);
    expect([queen.queenX, queen.queenY]).toEqual([queenX, queenY]);
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    const before = state.stats.delivered[0]!; pickupAndDeliver(state, new Set());
    expect(state.stats.delivered[0]).toBe(before + 2);
    const remote = add(state, 0, queenX + (config.nestDeliverTiles + 4) * 1000, queenY, "worker");
    remote.carrying = true; pickupAndDeliver(state, new Set());
    expect(remote.carrying).toBe(true); expect(state.stats.delivered[0]).toBe(before + 2);
  });

  it("the actual step wires soft motion for a newly hatched native state", () => {
    const state = createMatch(10, playable({ ...rulesConfig("redesign"), terrain: undefined, foodLayout: undefined }));
    const before = new Map(state.ants.map(a => [a.id, { x: a.x, y: a.y }]));
    const result = step(state);
    for (const a of result.state.ants) {
      const origin = before.get(a.id);
      if (origin) assert.ok((a.x - origin.x) ** 2 + (a.y - origin.y) ** 2 <= 400 ** 2);
    }
    expect(result.state.tick).toBe(state.tick + 1);
    expect(result.state.config.softSeparation).toEqual(playable(rulesConfig("redesign")).softSeparation);
  });
});
