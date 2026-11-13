import { describe, expect, it } from "vitest";
import { rulesConfig, PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { cloneState, createMatch } from "../../src/sim/map.ts";
import { localRulesSide } from "../../src/sim/marks.ts";
import { step } from "../../src/sim/step.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";
import { playable } from "../playable.ts";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

const rules = playable({ ...recordedHousePlan(rulesConfig("redesign")), commandIdleTicks: 5, commandFloorTicks: 1 });
// This accepted word-mark case exercises the rules-22 command surface.
const wordMarkRules = { ...rules, wordMarksDisabled: undefined };
const join = { type: "join", agentId: "a", placement: 0 } as const;
const order = { type: "order", agentId: "a", order: { kind: "hold" } } as const;
const until = (state: SimState, tick: number): SimState => {
  while (state.tick < tick) state = step(state).state;
  return state;
};

function world(state: SimState) {
  const { agents: _agents, ...rest } = state;
  return rest;
}

describe("accepted-command idle-seat floor", () => {
  it("preserves every active-seat world, agent, event, result and RNG state tick for tick", () => {
    const config = playable({ ...recordedHousePlan(rulesConfig("redesign")), foodLayout: undefined, mapWidth: 32, mapHeight: 16,
      nestTileX: 4, nestTileY: 8, startAnts: 12, matchTicks: 320, commandFloorTicks: 20,
      foodPatches: [{ tileX: 10, tileY: 8, radius: 2, perTile: 10 }] });
    let current = createMatch(6006, config);
    let historical = createMatch(6006, { ...config, commandIdleTicks: undefined });
    const comparable = (state: SimState) => {
      const { commandIdleTicks: _timeout, ...config } = state.config;
      return { ...state, config, agents: state.agents.map(({ joinedTick: _joined, ...agent }) => agent) };
    };
    for (let tick = 0; tick < 300; tick++) {
      const inputs: SimInput[] = [];
      if (tick === 0) inputs.push(join, { type: "join", agentId: "b", placement: 1 });
      if (tick % 80 === 1) inputs.push(order, { ...order, agentId: "b" });
      if (tick % 80 === 21) inputs.push({ type: "count_mark", agentId: "a", verb: "ATTACK", count: 4 });
      if (tick % 80 === 22) inputs.push(order); // refusal still leaves the original planner untouched
      if (tick % 80 === 41) inputs.push({ type: "mark", agentId: "a", words: ["FOOD"] });
      if (tick % 80 === 61) inputs.push({ type: "observe", agentId: "a" }, { type: "rejoin", agentId: "b" });
      const now = step(current, inputs);
      const before = step(historical, inputs);
      expect(comparable(now.state)).toEqual(comparable(before.state));
      expect(now.events).toEqual(before.events);
      expect(now.results).toEqual(before.results);
      expect(now.state.agents.every((agent) => !agent.idle)).toBe(true);
      current = now.state;
      historical = before.state;
    }
  }, 30_000);

  it("configures 180 seconds (1800 ticks) only for the redesign rules", () => {
    const config = recordedHousePlan(rulesConfig("redesign"));
    expect(config.commandIdleTicks).toBe(180 * config.ticksPerSecond);
    expect(config.commandIdleTicks).toBe(1800);
    expect(PUBLIC_CONFIG.commandIdleTicks).toBeUndefined();
    expect(rulesConfig("count-marks").commandIdleTicks).toBeUndefined();
  });

  it.each([false, true])("restores unseated planner parity at expiry, including previously accepted count marks: %s", (withCountMark) => {
    let state = step(createMatch(12, rules), [join]).state;
    if (withCountMark) {
      const out = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 20 }]);
      expect(out.results[0]!.ok).toBe(true);
      state = out.state;
      expect(state.ants.some((ant) => ant.claim !== undefined)).toBe(true);
    }
    state = until(state, (state.agents[0]!.lastCommandTick ?? 0) + rules.commandIdleTicks!);
    expect(state.agents[0]!.idle).toBe(false);
    expect(state.agents[0]!.squad.length).toBeGreaterThan(0);
    const unseated = cloneState(state);
    unseated.agents = [];
    unseated.marks = [];
    for (const ant of unseated.ants) {
      ant.squad = null;
      delete ant.claim;
    }
    let reference = step(unseated).state;
    state = step(state).state;
    expect(state.agents[0]!.idle).toBe(true);
    expect(state.agents[0]!.squad).toEqual([]);
    expect(localRulesSide(state, 0)).toBe(false);
    expect(state.marks).toEqual([]);
    expect(state.ants.every((ant) => ant.claim === undefined)).toBe(true);
    expect(world(state)).toEqual(world(reference));
    for (let i = 0; i < 20; i++) {
      state = step(state, [{ type: "observe", agentId: "a" }]).state;
      reference = step(reference).state;
      expect(world(state)).toEqual(world(reference));
    }
  });

  it.each<SimInput>([
    { type: "observe", agentId: "a" },
    { type: "rejoin", agentId: "a" },
    { type: "order", agentId: "a", order: { kind: "go_to", tileX: -1, tileY: -1 } },
    { type: "mark", agentId: "a", words: ["INVALID"] },
    { type: "count_mark", agentId: "a", verb: "INVALID", count: 1 },
    { type: "found_queen", agentId: "a", tileX: -1, tileY: -1 },
    join,
  ])("does not extend or wake the seat for $type without an accepted command", (input) => {
    let state = step(createMatch(13, rules), [join]).state;
    state = until(state, 4);
    state = step(state, [input]).state;
    expect(state.agents[0]!.lastCommandTick).toBeNull();
    state = step(state, [input]).state;
    expect(state.agents[0]!.idle).toBe(true);
    state = step(state, [input]).state;
    expect(state.agents[0]!.idle).toBe(true);
    expect(state.agents[0]!.squad).toEqual([]);
  });

  it("resets at an accepted command and wakes only when another command is accepted", () => {
    let state = step(createMatch(14, rules), [join]).state;
    state = until(state, 4);
    state = step(state, [order]).state;
    expect(state.agents[0]!.lastCommandTick).toBe(4);
    state = until(state, 9);
    expect(state.agents[0]!.idle).toBe(false);
    state = step(state).state;
    expect(state.agents[0]!.idle).toBe(true);
    const observed = step(state, [{ type: "observe", agentId: "a" }]);
    expect(observed.results[0]!.view!.orderStatus).toBe("idle: no squad until your next accepted command");
    const out = step(state, [order]);
    expect(out.results[0]!.ok).toBe(true);
    expect(out.state.agents[0]!.idle).toBe(false);
    expect(out.state.agents[0]!.squad.length).toBeGreaterThan(0);
    expect(localRulesSide(out.state, 0)).toBe(true);
    expect(out.state.agents[0]!.lastCommandTick).toBe(10);
  });

  it.each<SimInput>([
    { type: "mark", agentId: "a", words: ["FOOD"] },
    { type: "count_mark", agentId: "a", verb: "DEFEND", count: 1 },
  ])("resets the timer for accepted $type commands", (input) => {
    let state = step(createMatch(16, input.type === "mark" ? wordMarkRules : rules), [join]).state;
    state = until(state, 4);
    const out = step(state, [input]);
    expect(out.results[0]!.ok).toBe(true);
    expect(out.state.agents[0]!.lastCommandTick).toBe(4);
    expect(step(out.state).state.agents[0]!.idle).toBe(false);
  });

  it("accepts founding as a command and wakes an idle seat", () => {
    const config = { ...rules, queenFounding: { ...rules.queenFounding!, firstFoundTick: 0, cooldownTicks: 0, minDistanceTiles: 2, cost: 0 } };
    let state = step(createMatch(19, config), [join]).state;
    state = step(until(state, 5)).state;
    expect(state.agents[0]!.idle).toBe(true);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) state.owner[(20 + dy) * config.mapWidth + 20 + dx] = 0;
    const out = step(state, [{ type: "found_queen", agentId: "a", tileX: 20, tileY: 20 }]);
    expect(out.results[0]!.ok).toBe(true);
    expect(out.state.agents[0]!.idle).toBe(false);
    expect(out.state.agents[0]!.lastCommandTick).toBe(6);
    expect(localRulesSide(out.state, 0)).toBe(true);
  });

  it("does not reset the clock for rate-limited commands", () => {
    let state = step(createMatch(14, { ...rules, commandFloorTicks: 10 }), [join, order]).state;
    state = until(state, 4);
    const out = step(state, [order]);
    expect(out.results[0]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(out.state.agents[0]!.lastCommandTick).toBe(0);
    expect(step(out.state).state.agents[0]!.idle).toBe(true);
  });

  it("keeps agent control while any other seat on that colony is active", () => {
    let state = step(createMatch(15, rules), [join, { type: "join", agentId: "b", placement: 0 }]).state;
    state = until(state, 4);
    state = step(state, [{ ...order, agentId: "b" }]).state;
    state = step(state).state;
    expect(state.agents.map((agent) => agent.idle)).toEqual([true, false]);
    expect(localRulesSide(state, 0)).toBe(true);
    state = step(until(state, 9)).state;
    expect(state.agents.map((agent) => agent.idle)).toEqual([true, true]);
    expect(localRulesSide(state, 0)).toBe(false);
  });

  it("expires only the idle seat's count marks, preserving a teammate's claims and word marks", () => {
    // The redesign with word marks, so the idle seat holds both kinds of mark.
    const recorded = { ...rules, wordMarksDisabled: undefined };
    let state = step(createMatch(21, recorded), [join, { type: "join", agentId: "b", placement: 0 }]).state;
    state = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 4 }]).state;
    const stale = state.marks[0]!.id;
    state = step(state, [{ type: "mark", agentId: "a", words: ["FOOD"] }]).state;
    state = until(state, 4);
    const teammate = step(state, [{ type: "count_mark", agentId: "b", verb: "DEFEND", count: 4 }]);
    expect(teammate.results[0]!.ok).toBe(true);
    state = teammate.state;
    const retained = state.marks.find((mark) => mark.agentId === "b")!.id;
    state = step(until(state, 7)).state;
    expect(state.agents.map((agent) => agent.idle)).toEqual([true, false]);
    expect(localRulesSide(state, 0)).toBe(true);
    expect(state.marks.some((mark) => mark.id === stale)).toBe(false);
    expect(state.ants.some((ant) => ant.claim === stale)).toBe(false);
    expect(state.marks.some((mark) => mark.id === retained)).toBe(true);
    expect(state.ants.some((ant) => ant.claim === retained)).toBe(true);
    expect(state.marks.some((mark) => mark.agentId === "a" && mark.count === undefined)).toBe(true);
    state = step(state, [order]).state;
    expect(state.agents[0]!.idle).toBe(false);
    expect(state.marks.some((mark) => mark.id === stale)).toBe(false);
  });

  it("leaves historical count-mark lifetime unchanged when a call-based seat lapses", () => {
    const config = { ...rules, commandIdleTicks: undefined, squadTimerTicks: 5 };
    let state = step(createMatch(22, config), [join]).state;
    state = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 4 }]).state;
    const mark = state.marks[0]!.id;
    state = step(until(state, 6)).state;
    expect(state.agents[0]!.idle).toBe(true);
    expect(state.marks.some((entry) => entry.id === mark)).toBe(true);
    expect(state.ants.some((ant) => ant.claim === mark)).toBe(true);
  });

  it("preserves call-based expiry for historical configs", () => {
    let state = step(createMatch(17, { ...rules, commandIdleTicks: undefined, squadTimerTicks: 5 }), [join]).state;
    state = until(state, 5);
    state = step(state, [{ type: "observe", agentId: "a" }]).state;
    expect(state.agents[0]!.idle).toBe(false);
    state = step(until(state, 10)).state;
    expect(state.agents[0]!.idle).toBe(true);
    expect(step(state, [{ type: "rejoin", agentId: "a" }]).state.agents[0]!.idle).toBe(false);
  });
});
