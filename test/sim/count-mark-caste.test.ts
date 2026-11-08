import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { rulesConfig } from "../../src/sim/config.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { COUNT_CASTES, COUNT_VERBS, type Agent, type CountCaste, type SimEvent, type SimInput, type SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

function fixture(colonyWide = true): SimState {
  const config = rulesConfig("redesign");
  const state = emptyMatch(0, { ...config, commandFloorTicks: 1,
    countMarks: { ...config.countMarks!, recruitColonyWide: colonyWide } });
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  agent.squad.push(addAnt(state, 0, 8, 24, { squad: "a" }).id);
  return state;
}

function lay(state: SimState, caste?: string, verb: string = "GATHER", count = 10) {
  const events: SimEvent[] = [];
  const result = applyInput(state, { type: "count_mark", agentId: "a", verb, count,
    ...(caste === undefined ? {} : { caste }) }, state.tick++, defaultAllocator, events);
  return { result, events };
}

for (const colonyWide of [false, true]) describe(`caste recruitment (colony-wide: ${colonyWide})`, () => {
  for (const verb of COUNT_VERBS) it.each(verb === "FORAGE" ? ["worker"] as const : ["worker", "soldier"] as const)(`${verb} recruits only %s, retaining nearest/id ordering`, caste => {
    const state = fixture(colonyWide);
    const excluded = addAnt(state, 0, 8, 24, { caste: caste === "worker" ? "soldier" : "worker" });
    const first = addAnt(state, 0, 9, 24, { caste });
    const second = addAnt(state, 0, 9, 24, { caste });
    const farther = addAnt(state, 0, 10, 24, { caste });
    const enemy = addAnt(state, 1, 8, 24, { caste });
    const squad = addAnt(state, 0, 8, 24, { caste, squad: "teammate" });
    const { result, events } = lay(state, caste, verb, 2);
    expect(result.error).toBeNull();
    expect(events.find(event => event.type === "mark_laid")).toMatchObject({ caste });
    expect(result.countMarkAcceptance).toMatchObject({ caste, availability: { freeAntsNow: 3 } });
    claimCountMarks(state, state.tick);
    const mark = state.marks[0]!;
    expect([first.claim, second.claim]).toEqual([mark.id, mark.id]);
    for (const ant of [excluded, farther, enemy, squad]) expect(ant.claim).toBeUndefined();
  });
});

it.each(["queen", "workers", "Worker", "", "ANY", null, 3, {}])("refuses invalid caste %j without changing the mark or command", caste => {
  const state = fixture();
  const before = JSON.stringify(state);
  const events: SimEvent[] = [];
  const input = { type: "count_mark", agentId: "a", verb: "GATHER", count: 2, caste } as unknown as SimInput;
  const result = applyInput(state, input, state.tick, defaultAllocator, events);
  expect(result.error).toMatchObject({ code: "bad_count_mark", message: expect.stringContaining("any, worker, soldier") });
  expect(JSON.stringify(state)).toBe(before);
  expect(events).toEqual([]);
});

it.each(["worker", "soldier"] as const)("a re-lay selecting %s releases only excluded claims, not retained claims or another mark's ants", caste => {
  const state = fixture();
  const matching = addAnt(state, 0, 12, 24, { caste, foodTarget: 42 });
  const excluded = addAnt(state, 0, 8, 24, { caste: caste === "worker" ? "soldier" : "worker" });
  expect(lay(state).result.error).toBeNull();
  claimCountMarks(state, state.tick);
  const original = { ...state.marks[0]! };
  const other = addAnt(state, 0, 8, 24, { caste: excluded.caste, claim: 99 });
  state.marks.push({ ...original, id: 99, agentId: "mate", caste: excluded.caste, count: 1 });
  const beforeMatching = JSON.stringify(matching);
  expect(lay(state, caste).result.error).toBeNull();
  claimCountMarks(state, state.tick);
  expect(JSON.stringify(matching)).toBe(beforeMatching);
  expect(matching.claim).toBe(original.id);
  expect(excluded.claim).toBeUndefined();
  expect(other.claim).toBe(99);
  expect(state.marks[0]).toEqual({ ...original, caste, revision: 1 });
});

it("changing back to any retains matching claims, recruits both castes and stores no any property", () => {
  const state = fixture();
  const worker = addAnt(state, 0, 9, 24, { caste: "worker" });
  const soldier = addAnt(state, 0, 8, 24, { caste: "soldier" });
  lay(state, "worker"); claimCountMarks(state, state.tick);
  const mark = state.marks[0]!;
  expect(worker.claim).toBe(mark.id); expect(soldier.claim).toBeUndefined();
  const before = JSON.stringify(worker);
  lay(state, "any"); claimCountMarks(state, state.tick);
  expect(JSON.stringify(worker)).toBe(before);
  expect(soldier.claim).toBe(mark.id);
  expect(mark).not.toHaveProperty("caste");
});

it("worker includes pre-caste workers and empty selected pools remain recruitable", () => {
  const state = fixture();
  const worker = addAnt(state, 0, 8, 24); delete worker.caste;
  lay(state, "soldier"); claimCountMarks(state, state.tick);
  expect(worker.claim).toBeUndefined();
  const soldier = addAnt(state, 0, 9, 24, { caste: "soldier" });
  claimCountMarks(state, state.tick);
  expect(soldier.claim).toBe(state.marks[0]!.id);
  lay(state, "worker"); claimCountMarks(state, state.tick);
  expect(worker.claim).toBe(state.marks[0]!.id);
  expect(soldier.claim).toBeUndefined();
});

it("omitted and explicit any preserve identical complete state bytes and absent mark metadata", () => {
  const omitted = fixture(), explicit = fixture();
  for (const state of [omitted, explicit]) {
    addAnt(state, 0, 8, 24, { caste: "soldier" });
    addAnt(state, 0, 9, 24, { caste: "worker" });
  }
  for (let tick = 0; tick < 12; tick++) {
    const a = lay(omitted), b = lay(explicit, "any");
    claimCountMarks(omitted, tick); claimCountMarks(explicit, tick);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
    expect(b.events).toEqual(a.events);
    expect(explicit.marks[0]).not.toHaveProperty("caste");
  }
});

it("offers any, worker and soldier castes", () => {
  expect(COUNT_CASTES).toEqual(["any", "worker", "soldier"] satisfies CountCaste[]);
});

// The four-tick baseline-observer smoke is retired: the harness replays baseline 2762dc3's reference-grid
// config, which no longer plays now that every match plays at grid scale 2.
it("the identity harness compares complete state bytes", async () => {
  const { assertStateBytes, identityCases } = await import("./count-mark-identity.ts");
  const cases = identityCases(["workers", "soldiers", "soldier-heavy", "mixed", "rush", "count-mark army", "strike"]);
  expect(cases).toHaveLength(200);
  expect(cases.filter(c => c.scripted)).toHaveLength(8);
  expect(new Set(cases.map(c => c.seed))).toEqual(new Set([7001, 7002, 7003, 7004]));
  const a = fixture(), b = structuredClone(a); b.rngState++;
  expect(() => assertStateBytes(a, b, "must detect every state field")).toThrow("must detect every state field");
});
