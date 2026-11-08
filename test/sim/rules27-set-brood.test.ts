import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, stateHash, terminalAt, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Agent, ColonyId, InputError, QueenState, SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

/**
 * The rules-27 set_brood input. Queen owners are
 * set directly on the queens: who owns a queen
 * is decided by the founder, draw and seat-claim code, not here. The shared
 * 10 s command floor is the existing one (lastCommandTick, commandFloorTicks).
 */

type SetBrood = Extract<SimInput, { type: "set_brood" }>;

function rules27(patch: Partial<SimConfig> = {}): SimConfig {
  const base = rulesConfig("redesign");
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  return sevenMapRotation(newMatchConfig({ ...base, rules27: true, startAnts: 0, squadSize: 0, commandFloorTicks: 100, hatchIntervalTicks: 1_000_000,
    terrain: { ...base.terrain!, mapId: "three-crossings" }, ...patch }));
}

function seat(state: SimState, id: string, colony: ColonyId): Agent {
  const agent: Agent = { id, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: null, joinedTick: state.tick, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return agent;
}

const queen = (state: SimState, colony: ColonyId = 0, id = 0): QueenState => state.colonies[colony].queens!.find((q) => q.id === id)!;
const agentOf = (state: SimState, id: string): Agent => state.agents.find((a) => a.id === id)!;
const errorOf = (out: StepOutput, i = 0): InputError | null => { const r = out.results[i]!; return r.ok ? null : r.error; };
const setBrood = (agentId: string, brood: string, queenId?: number): SetBrood =>
  ({ type: "set_brood", agentId, brood, ...(queenId === undefined ? {} : { queenId }) });

/** Seats a and b on colony 0 and c on colony 1; a owns colony 0's starting queen, c colony 1's. */
function scene(config: SimConfig = rules27()): SimState {
  const state = createMatch(4590, config);
  state.tick = 1000;
  seat(state, "a", 0);
  seat(state, "b", 0);
  seat(state, "c", 1);
  queen(state, 0).owner = "a";
  queen(state, 1).owner = "c";
  return state;
}

/** A second live queen of colony 0, owned by the given agent. */
function addQueen(state: SimState, id: number, owner?: string): QueenState {
  const { owner: _owner, brood: _brood, ...first } = queen(state, 0);
  const added: QueenState = { ...first, id, queenX: first.queenX + 20 * SUB, ...(owner === undefined ? {} : { owner }) };
  state.colonies[0].queens!.push(added);
  return added;
}

describe("rules 27 set_brood", () => {
  it("sets workers, soldiers or mixed on the one live queen the caller owns, without queenId, changing only her brood", () => {
    for (const brood of ["workers", "soldiers", "mixed"] as const) {
      const state = scene();
      const out = step(state, [setBrood("a", brood)]);
      expect(errorOf(out)).toBeNull();
      expect(out.results[0]).toMatchObject({ ok: true, broodSet: { queenId: 0, brood } });
      expect(queen(out.state, 0).brood).toBe(brood);
      expect("brood" in queen(out.state, 1)).toBe(false);
      expect(agentOf(out.state, "a").brood).toBeUndefined();
      // Nothing else of the queen or the agent's command clock changes.
      const { brood: _set, ...rest } = queen(out.state, 0);
      const { brood: _none, ...before } = queen(step(state, [{ type: "observe", agentId: "a" }]).state, 0);
      expect(rest).toEqual(before);
    }
  });

  it("needs queenId only when the caller owns more than one live queen", () => {
    const state = scene();
    addQueen(state, 7, "a");
    const ambiguous = step(state, [setBrood("a", "soldiers")]);
    expect(errorOf(ambiguous)).toMatchObject({ code: "bad_brood", message: "You own 2 live queens (queenId 0, 7); send queenId to choose one." });
    expect(ambiguous.state.colonies[0].queens!.every((q) => q.brood === undefined)).toBe(true);
    const chosen = step(state, [setBrood("a", "soldiers", 7)]);
    expect(errorOf(chosen)).toBeNull();
    expect(chosen.results[0]).toMatchObject({ broodSet: { queenId: 7, brood: "soldiers" } });
    expect(queen(chosen.state, 0, 7).brood).toBe("soldiers");
    expect(queen(chosen.state, 0, 0).brood).toBeUndefined();
    // A lost queen is not a live queen: with queen 7 lost, a owns one live queen again.
    queen(state, 0, 7).lostTick = 900;
    const single = step(state, [setBrood("a", "workers")]);
    expect(single.results[0]).toMatchObject({ ok: true, broodSet: { queenId: 0, brood: "workers" } });
    expect(errorOf(step(state, [setBrood("a", "workers", 7)]))?.code).toBe("no_owned_queen");
  });

  it("refuses a queen the caller does not own: a teammate's, an unowned one or none with that id", () => {
    const state = scene();
    addQueen(state, 7);
    addQueen(state, 8, "b");
    for (const [agentId, queenId] of [["b", 0], ["a", 8], ["a", 7], ["a", 99]] as const) {
      const refused = step(state, [setBrood(agentId, "soldiers", queenId)]);
      expect(errorOf(refused)?.code, `${agentId} ${queenId}`).toBe("no_owned_queen");
      expect(refused.state.colonies.every((colony) => colony.queens!.every((q) => q.brood === undefined))).toBe(true);
    }
    expect(errorOf(step(state, [setBrood("a", "soldiers", 8)]))?.message).toBe("Queen 8 is not a live queen you own; yours: queenId 0.");
    // Only her owner sets her brood: b sets queen 8, which a could not.
    expect(step(state, [setBrood("b", "soldiers", 8)]).results[0]).toMatchObject({ ok: true, broodSet: { queenId: 8, brood: "soldiers" } });
  });

  it("refuses a caller owning no live queen with a reply naming found_queen", () => {
    const state = scene();
    const out = step(state, [setBrood("b", "workers")]);
    expect(errorOf(out)).toEqual({ code: "no_owned_queen", message: "You own no live queen, so there is no brood to set. Found one with found_queen." });
    // Her owner losing her leaves no live queen to set.
    queen(state, 0).lostTick = 900;
    expect(errorOf(step(state, [setBrood("a", "workers")]))?.message).toContain("found_queen");
  });

  it("refuses an unknown brood without changing any queen", () => {
    const out = step(scene(), [setBrood("a", "drones")]);
    expect(errorOf(out)).toEqual({ code: "bad_brood", message: "brood is one of workers, soldiers, mixed." });
    expect(queen(out.state, 0).brood).toBeUndefined();
  });

  it("neither waits for nor resets the shared command floor: the next allowed command tick is unchanged", () => {
    const config = rules27();
    let state = scene(config);
    let out = step(state, [{ type: "order", agentId: "a", order: { kind: "hold" } }]);
    expect(errorOf(out)).toBeNull();
    state = out.state;
    expect(agentOf(state, "a").lastCommandTick).toBe(1000);
    const nextCommandTick = 1000 + config.commandFloorTicks;
    // Inside the floor, where an order is refused, set_brood is accepted and leaves the floor where it was.
    expect(errorOf(step(state, [{ type: "order", agentId: "a", order: { kind: "forage" } }]))).toMatchObject({ code: "rate_limited", nextAllowedTick: nextCommandTick });
    out = step(state, [setBrood("a", "soldiers")]);
    expect(errorOf(out)).toBeNull();
    expect(out.results[0]!.view?.nextCommandTick).toBe(nextCommandTick);
    expect(agentOf(out.state, "a").lastCommandTick).toBe(1000);
    state = out.state;
    for (let tick = state.tick; tick < nextCommandTick - 1; tick++) state = step(state, [setBrood("a", tick % 2 === 0 ? "workers" : "soldiers")]).state;
    expect(agentOf(state, "a").lastCommandTick).toBe(1000);
    expect(errorOf(step(state, [{ type: "order", agentId: "a", order: { kind: "forage" } }]))).toMatchObject({ code: "rate_limited", nextAllowedTick: nextCommandTick });
    state = step(state, [setBrood("a", "mixed")]).state;
    expect(state.tick).toBe(nextCommandTick);
    expect(errorOf(step(state, [{ type: "order", agentId: "a", order: { kind: "forage" } }]))).toBeNull();
    // A seat that never commanded stays without a command tick, so its first command is not delayed.
    const fresh = step(scene(config), [setBrood("a", "workers"), { type: "order", agentId: "a", order: { kind: "forage" } }]);
    expect(fresh.results.map((r) => r.ok)).toEqual([true, true]);
    expect(agentOf(step(scene(config), [setBrood("a", "workers")]).state, "a").lastCommandTick).toBeNull();
  });

  it("does not wake a command-idle seat, as only an accepted command does", () => {
    const config = rules27();
    expect(config.commandIdleTicks).toBeDefined();
    const state = scene(config);
    agentOf(state, "a").idle = true;
    const out = step(state, [setBrood("a", "soldiers")]);
    expect(errorOf(out)).toBeNull();
    expect(agentOf(out.state, "a")).toMatchObject({ idle: true, lastCallTick: 1000, lastCommandTick: null });
    expect(agentOf(step(state, [{ type: "order", agentId: "a", order: { kind: "hold" } }]).state, "a").idle).toBe(false);
  });

  it("is refused without castes, changing nothing an observe would not", () => {
    const state = scene(rules27({ castes: undefined }));
    const out = step(state, [setBrood("a", "soldiers")]);
    expect(errorOf(out)).toEqual({ code: "bad_brood", message: "set_brood is not available in these rules." });
    expect(stateHash(out.state)).toBe(stateHash(step(state, [{ type: "observe", agentId: "a" }]).state));
  });
});

describe("rules 27 set_brood in match logs", () => {
  const SEED = 9590;
  const config = (): SimConfig => {
    const base = rulesConfig("redesign");
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    return sevenMapRotation(newMatchConfig({ ...base, rules27: true, startAnts: 6, commandFloorTicks: 5, terrain: { ...base.terrain!, mapId: "three-crossings" } }));
  };
  /** Owners set identically before the live run and before its replay: a owns colony 0's starting queen, c colony 1's. */
  function owned(state: SimState): SimState {
    queen(state, 0).owner = "a";
    queen(state, 1).owner = "c";
    return state;
  }
  const schedule = (tick: number): SimInput[] => {
    switch (tick) {
      case 0: return [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "b", placement: 0 }, { type: "join", agentId: "c", placement: 1 }];
      case 10: return [setBrood("a", "soldiers"), setBrood("c", "workers", 0)];
      case 15: return [setBrood("b", "soldiers"), setBrood("a", "drones")];
      case 20: return [{ type: "order", agentId: "a", order: { kind: "hold" } }, setBrood("a", "mixed")];
      case 22: return [setBrood("a", "workers"), setBrood("c", "soldiers")];
      default: return [];
    }
  };
  function live(ticks: number) {
    const lines = [headerLine(SEED, config())];
    let state = owned(createMatch(SEED, config()));
    const hashes: string[] = [];
    const results: StepOutput["results"][] = [];
    while (state.tick < ticks) {
      const inputs = schedule(state.tick);
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      const out = step(state, inputs);
      results.push(out.results);
      state = out.state;
      hashes.push(stateHash(state));
    }
    return { lines, state, hashes, results };
  }
  /** The recorded inputs replayed from the logged header, as replay() steps them. */
  function replayed(lines: readonly string[], ticks: number): { state: SimState; hashes: string[] } {
    const log = parseLog(lines);
    let state = owned(createMatch(log.header.seed, log.header.config));
    const hashes: string[] = [];
    while (state.tick < ticks && state.result === null) {
      state = step(state, log.ticks.get(state.tick) ?? [], undefined, undefined, undefined, terminalAt(log, state.tick), log.houseActive.has(state.tick)).state;
      hashes.push(stateHash(state));
    }
    return { state, hashes };
  }

  it("records set_brood calls as match inputs, and a rules-27 match containing them replays exactly", () => {
    const run = live(60);
    expect(run.results[10]!.map((r) => r.ok)).toEqual([true, true]);
    expect(run.results[15]!.map((r) => r.ok ? null : r.error.code)).toEqual(["no_owned_queen", "bad_brood"]);
    expect(run.results[20]!.map((r) => r.ok)).toEqual([true, true]);
    // Two ticks after the order, inside its 5-tick floor, set_brood is still accepted.
    expect(run.results[22]!.map((r) => r.ok)).toEqual([true, true]);
    expect(queen(run.state, 0).brood).toBe("workers");
    expect(queen(run.state, 1).brood).toBe("soldiers");
    expect(agentOf(run.state, "a").lastCommandTick).toBe(20);
    const parsed = parseLog(run.lines);
    for (const tick of [10, 15, 20, 22]) expect(parsed.ticks.get(tick)).toEqual(schedule(tick));
    const again = replayed(run.lines, 60);
    expect(again.hashes).toEqual(run.hashes);
    expect(stateHash(again.state)).toBe(stateHash(run.state));
  });
});
