import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { foodTargetHeld, forageDirection, pickupAndDeliver } from "../../src/sim/forage.js";
import { houseDirection, localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { buildGrid, cloneState } from "../../src/sim/map.js";
import { playScripted } from "../../src/live/record.js";
import { step } from "../../src/sim/step.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";
import type { SimState } from "../../src/sim/types.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Every match plays at grid scale 2: rules is the reference-grid template emptyMatch builds at
// grid scale 2. Reference tile t is fine tiles 2t and 2t+1; an ant at reference tile t stands at its centre
// (fine 2t + 0.5), a reference cell's food lives in fine cell (2tx, 2ty), and subunit positions double.
const cell = (state: SimState, tx: number, ty: number) => 2 * ty * state.config.mapWidth + 2 * tx;

const rules: SimConfig = { ...recordedHousePlan(rulesConfig("redesign")), foodLayout: undefined, foodPatches: [], squadSize: 0,
  hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  localAnts: { ...recordedHousePlan(rulesConfig("redesign")).localAnts!, workerHomeGuardCount: 0, workerHomeGuardSharePermille: 0,
    workerPatchDispatchSharePermille: 0 } };
function scenario(config = rules) {
  const state = emptyMatch(0, config);
  state.food.fill(0);
  const ant = addAnt(state, 0, 40.5, 40.5, { caste: "worker" });
  // The hold tests require east first, not an equal-distance ordering rule.
  const east = cell(state, 22, 20), west = cell(state, 17, 20);
  state.food[east] = 5; state.food[west] = 5;
  state.colonies[0].seenFood = [east, west];
  return { state, ant, east, west };
}

describe("local food-target minimum hold", () => {
  it("clears pickup history and renews the assignment", () => {
    const { state, ant, east, west } = scenario(rules);
    forageDirection(state, ant, [east, west], true);
    ant.x = 45_000;
    pickupAndDeliver(state, new Set([ant.id]));
    expect(ant.carrying).toBe(true);
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
    ant.carrying = false;
    state.tick = 21;
    forageDirection(state, ant, [east, west], true);
    expect(foodTargetHeld(state, ant)).toBe(true);
  });
  it.each([10, 20])("holds a depleted selection for at most two seconds at %i ticks/s", (ticksPerSecond) => {
    const { state, ant, east, west } = scenario({ ...rules, ticksPerSecond });
    expect(forageDirection(state, ant, [east, west], true).x).toBeGreaterThan(0);
    expect(ant.foodTarget).toBe(east);
    state.food[east] = 0;
    for (let tick = 1; tick < 2 * ticksPerSecond; tick++) {
      state.tick = tick;
      expect(forageDirection(state, ant, [west], true).x).toBeGreaterThan(0);
      expect(ant.foodTarget).toBe(east);
    }
    state.tick = 2 * ticksPerSecond;
    expect(forageDirection(state, ant, [west], true).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
  });

  it("keeps a valid selection after the minimum instead of scheduling another re-pick", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    state.tick = 100;
    ant.x = 37_000;
    forageDirection(state, ant, [west, east], true);
    expect(ant.foodTarget).toBe(east);
  });

  it("preserves a held local target when food memory drops it, then releases it at the boundary", () => {
    const { state, ant, east, west } = scenario();
    localDirection(state, buildGrid(state), ant, localSoldierAssignments(state));
    state.food[east] = 0;
    state.colonies[0].seenFood = [west];
    state.tick = 19;
    expect(localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir.x).toBeGreaterThan(0);
    expect(ant.foodTarget).toBe(east);
    state.tick = 20;
    expect(localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir.x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
  });

  it("does not let fallback scouting bypass the hold when all remembered food disappears", () => {
    const config = { ...rules, foodPatches: [{ tileX: 10, tileY: 8, radius: 1, perTile: 5 }] };
    const { state, ant, east, west } = scenario(config);
    localDirection(state, buildGrid(state), ant, localSoldierAssignments(state));
    state.food[east] = 0; state.food[west] = 0;
    state.colonies[0].seenFood = [];
    state.tick = 1;
    expect(localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir.x).toBeGreaterThan(0);
    expect(ant.foodTarget).toBe(east);
    state.tick = 20;
    expect(localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir.x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(-1);
  });

  it.each([10, 20])("re-picks an occupied empty target immediately at %i ticks/s and holds the new assignment", ticksPerSecond => {
    const { state, ant, east, west } = scenario({ ...rules, ticksPerSecond });
    forageDirection(state, ant, [east, west], true);
    state.food[east] = 0;
    ant.x = 45_000;
    state.tick = 1;
    expect(foodTargetHeld(state, ant)).toBe(false);
    expect(forageDirection(state, ant, [west], true).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
    expect(foodTargetHeld(state, ant)).toBe(true);
    pickupAndDeliver(state, new Set([ant.id]));
    expect(ant.carrying).toBe(false);
    expect(state.food[east]).toBe(0);
    // Depletion en route still respects the new assignment's original deadline.
    state.food[west] = 0;
    state.tick = 2 * ticksPerSecond;
    expect(forageDirection(state, ant, [], true).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
    state.tick++;
    forageDirection(state, ant, [], true);
    expect(ant.foodTarget).toBe(-1);
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
  });

  it("keeps waiting on a held tile that still has food until pickup", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    ant.x = 45_000;
    state.tick = 1;
    expect(foodTargetHeld(state, ant)).toBe(true);
    expect(forageDirection(state, ant, [west, east], true)).toEqual({ x: 0, y: 0 });
    expect(ant.foodTarget).toBe(east);
    pickupAndDeliver(state, new Set([ant.id]));
    expect(ant.carrying).toBe(true);
    expect(state.food[east]).toBe(4);
    expect(foodTargetHeld(state, ant)).toBe(false);
  });

  it("clears an occupied empty target and goes home if no replacement exists", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    state.food[east] = 0; state.food[west] = 0;
    ant.x = 45_000;
    state.tick = 1;
    expect(forageDirection(state, ant, [], true).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(-1);
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
    expect(ant.carrying).toBe(false);
  });

  it.each(["local", "house"] as const)("wires empty-target release through the %s worker path", control => {
    const { state, ant, east, west } = scenario();
    ant.role = "forager";
    const dir = () => control === "local"
      ? localDirection(state, buildGrid(state), ant, localSoldierAssignments(state)).dir
      : houseDirection(state, buildGrid(state), [east, west], ant);
    dir();
    expect(ant.foodTarget).toBe(east);
    state.food[east] = 0;
    state.colonies[0].seenFood = [west];
    ant.x = 45_000;
    state.tick = 1;
    expect(dir().x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
  });

  it("releases through a real step without changing the prior branch or serialized result", () => {
    const { state, ant, east, west } = scenario();
    ant.role = "forager";
    forageDirection(state, ant, [east, west], true);
    state.food[east] = 0;
    ant.x = 45_000;
    state.tick = 1;
    const hash = stateHash(state);
    const next = step(state).state;
    expect(stateHash(state)).toBe(hash);
    expect(ant.foodTarget).toBe(east);
    expect(next.ants[0]!.foodTarget).toBe(west);
    expect(next.ants[0]!.x).toBeLessThan(ant.x);
    const resumed = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(stateHash(step(resumed).state)).toBe(stateHash(next));
  });

  it("releases an occupied empty target immediately but preserves the hold en route", () => {
    const { state, ant, east, west } = scenario(rules);
    forageDirection(state, ant, [east, west], true);
    state.food[east] = 0;
    state.tick = 1;
    expect(foodTargetHeld(state, ant)).toBe(true); // En route: the existing two-second hold survives.
    ant.x = 45_000;
    expect(foodTargetHeld(state, ant)).toBe(false);
    expect(forageDirection(state, ant, [west], true).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
    expect(ant.carrying).toBe(false);
    expect(state.food[east]).toBe(0);
  });

  it("pickup ends the assignment and carrying still delivers immediately", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    ant.x = 45_000;
    pickupAndDeliver(state, new Set([ant.id]));
    expect(ant.carrying).toBe(true);
    expect(ant.foodTarget).toBe(-1);
    expect(foodTargetHeld(state, ant)).toBe(false);
    expect(forageDirection(state, ant, [west], true).x).toBeLessThan(0);
    ant.carrying = false;
    state.food[east] = 0;
    state.tick = 1;
    forageDirection(state, ant, [west], true);
    expect(ant.foodTarget).toBe(west);
    expect(foodTargetHeld(state, ant)).toBe(true);
  });

  it("same-tile reselection after pickup starts a fresh hold, even after the old deadline", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    state.tick = 100;
    ant.x = 45_000;
    pickupAndDeliver(state, new Set([ant.id]));
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
    ant.x = state.colonies[0].queenX; ant.y = state.colonies[0].queenY;
    pickupAndDeliver(state, new Set());
    expect(ant.carrying).toBe(false);
    ant.x = 41_000; ant.y = 41_000;
    state.tick = 101;
    forageDirection(state, ant, [east, west], true);
    expect(ant.foodTarget).toBe(east);
    state.food[east] = 0;
    state.tick = 120;
    expect(forageDirection(state, ant, [west], true).x).toBeGreaterThan(0);
    expect(foodTargetHeld(state, ant)).toBe(true);
    state.tick = 121;
    expect(forageDirection(state, ant, [west], true).x).toBeLessThan(0);
  });

  it("wires the same minimum into unseated house foragers, not just local workers", () => {
    const { state, ant, east, west } = scenario();
    ant.role = "forager";
    houseDirection(state, buildGrid(state), [east, west], ant);
    state.food[east] = 0;
    state.tick = 19;
    expect(houseDirection(state, buildGrid(state), [west], ant).x).toBeGreaterThan(0);
    state.tick = 20;
    expect(houseDirection(state, buildGrid(state), [west], ant).x).toBeLessThan(0);
  });

  it.each(["squad", "claim"] as const)("%s control overrides a held assignment", (owner) => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west], true);
    state.food[east] = 0;
    state.tick = 1;
    if (owner === "squad") ant.squad = "script";
    else ant.claim = 1;
    expect(foodTargetHeld(state, ant)).toBe(false);
    expect(forageDirection(state, ant, [west]).x).toBeLessThan(0);
    expect(ant.foodTarget).toBe(west);
  });

  it("leaves non-opted-in foraging unchanged and adds no history to historical states", () => {
    const { state, ant, east, west } = scenario();
    forageDirection(state, ant, [east, west]);
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
    state.food[east] = 0;
    expect(forageDirection(state, ant, [west]).x).toBeLessThan(0);
    expect((ant as { foodTargetHold?: unknown }).foodTargetHold).toBeUndefined();
  });

  it("persists the hold through real steps and serialization without mutating previous branches", () => {
    const { state, ant, east, west } = scenario();
    state.agents.push({ id: "script", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
      order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
    const initial = stateHash(state);
    const first = step(state).state;
    expect(stateHash(state)).toBe(initial);
    expect(first.ants[0]!.foodTarget).toBe(east);
    first.food[east] = 0;
    first.colonies[0].seenFood = [west];
    const branch = stateHash(first);
    const second = step(first).state;
    expect(stateHash(first)).toBe(branch);
    expect(second.ants[0]!.foodTarget).toBe(east);
    const copy = cloneState(second);
    copy.tick = 20;
    forageDirection(copy, copy.ants[0]!, [west], true);
    expect(second.ants[0]!.foodTarget).toBe(east);
    const resumed = JSON.parse(JSON.stringify(second)) as typeof state;
    expect(stateHash(step(resumed).state)).toBe(stateHash(step(second).state));
    expect(ant.foodTarget).toBe(-1);
  });

  it("replays a scripted match with guard and food history deterministically", () => {
    const run = playScripted({ seed: 6006, config: playable(recordedHousePlan(rulesConfig("redesign"))), agents: 4, ticks: 100 });
    expect(stateHash(replay(run.lines, run.state.tick))).toBe(stateHash(run.state));
  });
});
