import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { countMarkVerbs } from "../../src/sim/patrol.js";
import { step } from "../../src/sim/step.js";
import { type Agent, type SimEvent, type SimInput, type SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";

function fixture(colonyWide: boolean): SimState {
  const config = rulesConfig("redesign");
  const state = emptyMatch(426, { ...config,
    commandFloorTicks: 1, terrain: undefined, foodLayout: undefined,
    countMarks: { ...config.countMarks!, recruitColonyWide: colonyWide } });
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  agent.squad.push(addAnt(state, 0, 8, 24, { squad: "a" }).id);
  return state;
}
function lay(state: SimState, caste?: string, verb = "FORAGE", count = 2) {
  const events: SimEvent[] = [];
  // Rules 26 LINE needs both ends; the squad ant stands at (8,24).
  const ends = verb === "LINE" ? { tileX: 8, tileY: 24, toTileX: 10, toTileY: 24 } : {};
  const result = applyInput(state, { type: "count_mark", agentId: "a", verb, count, ...ends,
    ...(caste === undefined ? {} : { caste }) }, state.tick, defaultAllocator, events);
  return { result, events };
}

for (const colonyWide of [false, true]) describe(`worker-only FORAGE (colony-wide: ${colonyWide})`, () => {
  it.each([undefined, "any", "worker"])("%s excludes nearer soldiers, keeps distance/id ordering and recruits worker replacements", caste => {
    const state = fixture(colonyWide);
    const soldier = addAnt(state, 0, 8, 24, { caste: "soldier" });
    const first = addAnt(state, 0, 9, 24, { caste: "worker" });
    const second = addAnt(state, 0, 9, 24); delete second.caste;
    const far = addAnt(state, 0, 10, 24, { caste: "worker" });
    const enemy = addAnt(state, 1, 8, 24);
    const squad = addAnt(state, 0, 8, 24, { squad: "mate" });
    const { result } = lay(state, caste);
    expect(result.error).toBeNull();
    expect(result.countMarkAcceptance!.availability.freeAntsNow).toBe(3);
    claimCountMarks(state, state.tick);
    const mark = state.marks[0]!;
    expect([first.claim, second.claim]).toEqual([mark.id, mark.id]);
    for (const ant of [soldier, far, enemy, squad]) expect(ant.claim).toBeUndefined();
    state.ants = state.ants.filter(ant => ant !== first);
    claimCountMarks(state, ++state.tick);
    expect(far.claim).toBe(mark.id);
    expect(soldier.claim).toBeUndefined();
    const secondBefore = JSON.stringify(second);
    expect(lay(state, "any").result.error).toBeNull();
    claimCountMarks(state, state.tick);
    expect(JSON.stringify(second)).toBe(secondBefore);
    expect(soldier.claim).toBeUndefined();
  });

  it("accepts an empty worker pool without counting soldiers, then recruits a newly free worker", () => {
    const state = fixture(colonyWide);
    const soldier = addAnt(state, 0, 8, 24, { caste: "soldier" });
    const { result } = lay(state);
    expect(result.error).toBeNull();
    expect(result.countMarkAcceptance).toMatchObject({ availability: { freeAntsNow: 0 },
      message: "0 free ants now; this mark recruits as ants hatch or free up" });
    claimCountMarks(state, state.tick);
    expect(soldier.claim).toBeUndefined();
    const worker = addAnt(state, 0, 9, 24);
    claimCountMarks(state, ++state.tick);
    expect(worker.claim).toBe(state.marks[0]!.id);
  });

  it("refuses soldier FORAGE for a new mark or re-lay without altering marks, claims or command allowance", () => {
    const state = fixture(colonyWide);
    for (const existing of [false, true]) {
      if (existing) { expect(lay(state).result.error).toBeNull(); state.tick++; }
      const marks = JSON.stringify(state.marks), ants = JSON.stringify(state.ants);
      const commandTick = state.agents[0]!.lastCommandTick;
      const { result, events } = lay(state, "soldier");
      expect(result.error).toMatchObject({ code: "bad_count_mark", message: expect.stringContaining("FORAGE recruits workers only") });
      expect(JSON.stringify(state.marks)).toBe(marks);
      expect(JSON.stringify(state.ants)).toBe(ants);
      expect(state.agents[0]!.lastCommandTick).toBe(commandTick);
      expect(events).toEqual([]);
    }
  });

  it("drops an ineligible retained FORAGE claim while keeping the worker and other-verb claims", () => {
    const state = fixture(colonyWide);
    lay(state);
    const mark = state.marks[0]!;
    const soldier = addAnt(state, 0, 8, 24, { caste: "soldier", claim: mark.id });
    const worker = addAnt(state, 0, 9, 24, { claim: mark.id });
    state.marks.push({ ...mark, id: mark.id + 1, verb: "DEFEND", count: 1 });
    const defender = addAnt(state, 0, 8, 24, { caste: "soldier", claim: mark.id + 1 });
    claimCountMarks(state, state.tick);
    expect(soldier.claim).toBeUndefined();
    expect(worker.claim).toBe(mark.id);
    expect(defender.claim).toBe(mark.id + 1);
  });

  it.each(countMarkVerbs(rulesConfig("redesign")).filter(verb => verb !== "FORAGE"))("%s still accepts and recruits soldiers", verb => {
    const state = fixture(colonyWide);
    const soldier = addAnt(state, 0, 8, 24, { caste: "soldier" });
    expect(lay(state, "soldier", verb).result.error).toBeNull();
    claimCountMarks(state, state.tick);
    expect(soldier.claim).toBe(state.marks[0]!.id);
  });
});

it.each([DEFAULT_CONFIG, RULES_V4_CONFIG, PUBLIC_CONFIG, ...[undefined, "v4", "count-marks", "redesign"].map(rulesConfig),
  newMatchConfig(rulesConfig("redesign"))].map(playable))("stores shared rules25 on every new-match config (%#)", config => {
  expect(config.rules25).toBe(true);
  const header = parseLog([headerLine(426, config)]).header;
  expect(header.rulesVersion).toBe(27);
  expect(JSON.stringify(header.config)).toBe(JSON.stringify(config));
  expect(createMatch(426, header.config).config.rules25).toBe(true);
});

it("refuses and replays actual FORAGE soldier input", () => {
  const config: SimConfig = { ...rulesConfig("redesign"),
    startAnts: 20, squadSize: 1, matchTicks: 30, commandFloorTicks: 1, antSpeedTilesPerSecond: 0,
    hatchCost: 0, castes: { ...rulesConfig("redesign").castes!, soldierCost: 0 },
    hatchIntervalTicks: 1, hatchTiming: { soldierIntervalMultiplier: 1 } };
  const played = playable(config);
  let state = createMatch(426, played);
  const lines = [headerLine(426, played)];
  for (const inputs of [[{ type: "join", agentId: "a", colony: 0 }], [], [],
    [{ type: "count_mark", agentId: "a", verb: "FORAGE", count: 4, caste: "soldier" }]] as SimInput[][]) {
    lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    if (state.tick === 3) expect(out.results[0]!.ok).toBe(false);
    state = out.state;
  }
  expect(parseLog(lines).header.rulesVersion).toBe(27);
  expect(stateHash(replay(lines, state.tick))).toBe(stateHash(state));
});
