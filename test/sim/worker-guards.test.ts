import { describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { localDirection, localSoldierAssignments, rememberWorkerGuards } from "../../src/sim/houseBot.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { buildGrid, cloneState } from "../../src/sim/map.js";
import { playScripted } from "../../src/live/record.js";
import { step } from "../../src/sim/step.js";
import type { SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// Worker home guards of a house-bot colony: a seated colony holds none (rules 27).
const redesign = recordedHousePlan(rulesConfig("redesign"));
const rules: SimConfig = { ...redesign, foodLayout: undefined, squadSize: 0,
  hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  localAnts: { ...redesign.localAnts!, workerHomeGuardCount: 1, workerHomeGuardSharePermille: 0 } };
const guards = (s: SimState) => [...localSoldierAssignments(s)!.workerGuards!];
const record = (s: SimState) => rememberWorkerGuards(s, localSoldierAssignments(s));
const configCount = (s: SimState, count: number): SimState => ({ ...s,
  config: { ...s.config, localAnts: { ...s.config.localAnts!, workerHomeGuardCount: count } },
});

function scenario(config = rules): SimState {
  const s = emptyMatch(0, config);
  // Grid scale 2: reference tile (9, 24), one tile east of the queen's, is centred at fine (18.5, 48.5).
  for (let i = 0; i < 6; i++) addAnt(s, 0, 18.5, 48.5, { caste: "worker" });
  return s;
}

describe("home-guard role holds", () => {
  it.each([10, 20])("holds a new eligible incumbent for two seconds at %i ticks/s", (ticksPerSecond) => {
    const s = scenario({ ...rules, ticksPerSecond });
    s.ants[0]!.carrying = true;
    expect(guards(s)).toEqual([s.ants[1]!.id]);
    record(s);
    s.ants[0]!.carrying = false;
    for (let tick = 1; tick < 2 * ticksPerSecond; tick++) {
      s.tick = tick;
      expect(guards(s)).toEqual([s.ants[1]!.id]);
      record(s); // An unchanged role must not restart its clock.
    }
    for (const tick of [2 * ticksPerSecond, 10 * ticksPerSecond]) {
      s.tick = tick;
      expect(guards(s)).toEqual([s.ants[1]!.id]); // The minimum is not a scheduled rotation.
      record(s);
    }
  });

  it("holds a released worker out even when the remaining incumbent is no longer held", () => {
    let s = configCount(scenario(), 2);
    record(s); // Both initial guards' holds end at tick 20.
    s.tick = 20;
    s.ants[0]!.carrying = true;
    s = configCount(s, 1);
    record(s); // First worker released at tick 20; second retains its original clock.
    s.ants[0]!.carrying = false;
    const lostIncumbent = cloneState(s);
    lostIncumbent.tick = 21;
    lostIncumbent.ants.splice(1, 1);
    expect(guards(lostIncumbent)).toEqual([s.ants[2]!.id]); // Prefer a non-held release for the required slot.
    for (let tick = 21; tick < 40; tick++) {
      s.tick = tick;
      expect(guards(s)).toEqual([s.ants[1]!.id]);
      record(s);
    }
    s.tick = 40;
    s.ants.splice(1, 1); // Once a slot opens after the release hold, the original worker is eligible again.
    expect(guards(s)).toEqual([s.ants[0]!.id]);
  });

  it.each(["carrying", "squad", "claim", "death"] as const)("%s overrides an incumbent's hold", (reason) => {
    const s = scenario();
    record(s);
    const first = s.ants[0]!;
    s.tick++;
    if (reason === "carrying") first.carrying = true;
    if (reason === "squad") first.squad = "script";
    if (reason === "claim") first.claim = 123;
    if (reason === "death") s.ants.shift();
    expect(guards(s)).toEqual([s.ants.find(a => a.id !== first.id)!.id]);
    record(s);
    if (reason !== "death") {
      first.carrying = false; first.squad = null; delete first.claim;
      s.tick++;
      expect(guards(s)).not.toContain(first.id);
    }
  });

  it("keeps exact count/share targets and one non-carrier free as staffing changes", () => {
    const s = scenario({ ...rules, localAnts: { ...rules.localAnts!, workerHomeGuardCount: 2, workerHomeGuardSharePermille: 500 } });
    expect(guards(s)).toHaveLength(3);
    record(s);
    s.tick++;
    s.ants[0]!.carrying = true;
    expect(guards(s)).toHaveLength(3);
    record(s);
    s.tick++;
    s.ants[1]!.squad = "script";
    s.ants[2]!.claim = 1;
    expect(guards(s)).toHaveLength(2); // Four free workers, three non-carriers.
    record(s);
    s.tick++;
    s.ants[3]!.carrying = true;
    s.ants[4]!.carrying = true;
    expect(guards(s)).toEqual([]); // The last available worker still forages.
  });

  it("allows count changes to override both entry and release holds", () => {
    let s = configCount(scenario(), 5);
    record(s);
    s.tick++;
    s = configCount(s, 0);
    expect(guards(s)).toEqual([]);
    record(s);
    s.tick++;
    s = configCount(s, 5);
    expect(guards(s)).toHaveLength(5);
    expect(guards(s)).toContain(s.ants[0]!.id); // Even the held-out release fills a required slot.
    record(s);
    s.tick++;
    s = configCount(s, 1);
    expect(guards(s)).toHaveLength(1);
  });

  it("releases workers when a free home soldier screen is available", () => {
    const s = scenario({ ...rules, localAnts: { ...rules.localAnts!, soldierFrontSharePermille: 0 } });
    record(s);
    s.tick++;
    addAnt(s, 0, 16.5, 48.5, { caste: "soldier" });
    expect(guards(s)).toEqual([]);
    record(s);
    s.ants.pop();
    s.tick++;
    expect(guards(s)).toHaveLength(1); // Exact staffing can override a recent release.
  });

  it("is read-only during selection, stable across array order, and isolated across cloned branches", () => {
    const s = scenario();
    record(s);
    const before = stateHash(s);
    expect(guards(s)).toEqual(guards(s));
    expect(stateHash(s)).toBe(before);
    const copy = cloneState(s);
    copy.ants.reverse();
    expect(guards(copy)).toEqual(guards(s));
    copy.tick++;
    copy.ants.find(a => a.id === s.ants[0]!.id)!.carrying = true;
    record(copy);
    expect(stateHash(s)).toBe(before);
    expect(guards(s)).toContain(s.ants[0]!.id);
    const resumed = JSON.parse(JSON.stringify(copy)) as SimState;
    expect(guards(resumed)).toEqual(guards(copy));
  });

  it("wires history into real steps without changing the input state or forgetting the hold", () => {
    const initial = scenario();
    // Step plans the worker guard of house-bot colony 0 while colony 1 is seated.
    initial.agents.push({ id: "seat", colony: 1, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
      order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
    initial.ants[0]!.carrying = true;
    const before = stateHash(initial);
    const first = step(initial).state;
    expect(stateHash(initial)).toBe(before);
    first.ants[0]!.carrying = false;
    const second = step(first).state;
    const assigned = localSoldierAssignments(second)!;
    expect([...assigned.workerGuards!]).toEqual([second.ants[1]!.id]);
    const own = localDirection(second, buildGrid(second), second.ants[1]!, assigned);
    expect(own.foraging).toBe(false);
    expect(own.dir.x).toBeLessThan(0); // The retained worker still heads toward its queen.
    expect(stateHash(step(first).state)).toBe(stateHash(second));
  });

  it("replays scripted inputs deterministically with serialized role history", () => {
    const run = playScripted({ seed: 6006, config: playable(rules), agents: 4, ticks: 80 });
    expect(stateHash(replay(run.lines, run.state.tick))).toBe(stateHash(run.state));
  });
});
