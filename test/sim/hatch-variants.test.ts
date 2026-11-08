import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { hatch } from "../../src/sim/forage.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Brood, SimEvent, SimState } from "../../src/sim/types.js";
import { selectHatchArm, type HatchArm } from "../tools/hatchVariants.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";

const base: SimConfig = { ...PUBLIC_CONFIG, terrain: undefined, foodLayout: undefined, startAnts: 0 };
function prepared(arm: HatchArm, brood: Brood = "soldiers") {
  const state = emptyMatch(0, selectHatchArm(base, arm));
  state.colonies[0].foodStore = 1000;
  state.colonies[0].queens![0]!.lastHatchTick = 0;
  // Rules 27: a seated colony's queen hatches her own brood.
  state.colonies[0].queens![0]!.brood = brood;
  const agent: Agent = { id: "script", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "forage" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return state;
}
function at(state: SimState, tick: number) {
  state.tick = tick;
  const events: SimEvent[] = [];
  hatch(state, tick, events);
  return events.filter(event => event.type === "hatch").filter(event => event.colony === 0);
}

describe("chosen soldier hatch timing", () => {
  it("takes the live timing in the redesign and removes only timing in the main arm", () => {
    const live = rulesConfig("redesign");
    expect(live.hatchTiming).toEqual({ soldierIntervalMultiplier: 2 });
    expect(selectHatchArm(live, "main")).not.toHaveProperty("hatchTiming");
  });
  it.each(["main", "A"] as const)("keeps workers at 10 ticks at the first queen in %s", arm => {
    const state = prepared(arm, "workers");
    expect(at(state, 9)).toEqual([]);
    expect(at(state, 10)).toMatchObject([{ caste: "worker" }]);
    expect(at(state, 19)).toEqual([]);
    expect(at(state, 20)).toHaveLength(1);
  });

  it.each(["A"] as const)("charges each soldier two full intervals in %s, not two food payments", arm => {
    const state = prepared(arm);
    expect(at(state, 19)).toEqual([]);
    expect(at(state, 20)).toMatchObject([{ caste: "soldier" }]);
    expect(state.colonies[0].foodStore).toBe(994);
    expect(at(state, 39)).toEqual([]);
    expect(at(state, 40)).toHaveLength(1);
    expect(state.colonies[0].foodStore).toBe(988);
  });

  it("leaves main's soldiers at one interval and preserves worker/soldier alternation", () => {
    const main = prepared("main");
    expect(at(main, 10)).toMatchObject([{ caste: "soldier" }]);
    const mixed = prepared("A", "mixed");
    const events = Array.from({ length: 61 }, (_, tick) => at(mixed, tick)).flat();
    expect(events.map(event => [event.tick, event.caste])).toEqual([[10, "worker"], [30, "soldier"], [40, "worker"], [60, "soldier"]]);
    expect(mixed.colonies[0].foodStore).toBe(982);
  });

  it("takes the current brood's full price even when brood changes near readiness", () => {
    const state = prepared("A", "workers");
    expect(at(state, 9)).toEqual([]);
    state.colonies[0].queens![0]!.brood = "soldiers";
    expect(at(state, 10)).toEqual([]);
    expect(at(state, 20)).toHaveLength(1);
    state.colonies[0].queens![0]!.brood = "workers";
    expect(at(state, 29)).toEqual([]);
    expect(at(state, 30)).toHaveLength(1);
  });

  it.each(["workers", "soldiers"] as const)("keeps every queen's %s interval independent and births at her nest", brood => {
    const state = prepared("A", brood);
    const colony = state.colonies[0];
    const first = colony.queens![0]!;
    colony.queens!.push({ ...first, id: 1, queenX: 20500, queenY: 5500 }, { ...first, id: 2, queenX: 35500, queenY: 5500 });
    const interval = brood === "workers" ? 10 : 20;
    expect(at(state, interval - 1)).toEqual([]);
    const births = at(state, interval);
    expect(births).toHaveLength(3);
    expect(births.map(event => event.tileX)).toEqual([Math.floor(first.queenX / 1000), 20, 35]);
    expect(births.map(event => event.tileY)).toEqual([Math.floor(first.queenY / 1000), 5, 5]);
    first.lostTick = interval + 1;
    expect(at(state, interval * 2)).toMatchObject([{ tileX: 20 }, { tileX: 35 }]);
  });

  it("never charges food, advances the timer or alternates while food/cap blocks a hatch", () => {
    const state = prepared("A", "mixed");
    at(state, 10);
    const colony = state.colonies[0];
    colony.foodStore = 5;
    expect(at(state, 30)).toEqual([]);
    expect(colony.queens![0]!.mixedNext).toBe("soldier");
    expect(colony.queens![0]!.lastHatchTick).toBe(10);
    colony.foodStore = 6;
    state.ants = [];
    for (let i = 0; i < state.config.colonyCap; i++) addAnt(state, 0, 5, 5);
    expect(at(state, 31)).toEqual([]);
    expect(colony.foodStore).toBe(6);
    state.ants.pop();
    expect(at(state, 32)).toHaveLength(1);
    expect(colony.foodStore).toBe(0);
    expect(colony.queens![0]!.mixedNext).toBe("worker");
    expect(colony.queens![0]!.lastHatchTick).toBe(32);
  });

  it("reports food shortfall only once the selected caste/queen interval is ready", () => {
    const state = prepared("A");
    state.colonies[0].foodStore = 5;
    const blocked: { colony: number; tick: number }[] = [];
    const observe = (record: { colony: number; tick: number }) => blocked.push({ colony: record.colony, tick: record.tick });
    hatch(state, 10, [], observe);
    // Colony 1 has mixed brood and an unfed worker ready at the old interval.
    expect(blocked).toEqual([{ colony: 1, tick: 10 }]);
    hatch(state, 20, [], observe);
    expect(blocked).toEqual([{ colony: 1, tick: 10 }, { colony: 0, tick: 20 }, { colony: 1, tick: 20 }]);
  });

  it.each([RULES_V4_CONFIG, base, selectHatchArm(base, "A")])("replays stored configs with identical state and results", config => {
    const short = playable({ ...config, matchTicks: 60 });
    let state = createMatch(7001, short);
    const lines = [headerLine(7001, short)];
    while (state.result === null) {
      lines.push(tickLine(state.tick, []));
      state = step(state).state;
    }
    expect(stateHash(replay(lines, 60))).toBe(stateHash(state));
    expect(replay(lines, 60).result).toEqual(state.result);
  });
});
