import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG, SUB, type SimConfig } from "../../src/sim/config.js";
import { hatch, queenNextCaste } from "../../src/sim/forage.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Brood, Caste, ColonyId, QueenState, SimEvent, SimState } from "../../src/sim/types.js";
import { emptyMatch } from "./fixtures.js";

// In rules 27 each queen of a colony with an agent hatches her own
// brood, mixed alternating per queen; colonies with no registered agent keep the colony brood as captured at d332b049 (no
// separate house brood choice in the captured path).

const RULES_27: SimConfig = { ...PUBLIC_CONFIG, terrain: undefined, foodLayout: undefined, startAnts: 0 };

/** Three live queens per colony, one tile row apart, each ready to hatch at once. */
function threeQueens(config: SimConfig): SimState {
  const state = emptyMatch(0, config);
  for (const colony of state.colonies) {
    const first = colony.queens![0]!;
    first.lastHatchTick = -1_000;
    colony.queens!.push({ ...first, id: 1, queenY: first.queenY + 6 * SUB, starting: undefined },
      { ...first, id: 2, queenY: first.queenY + 12 * SUB, starting: undefined });
    colony.foodStore = 1_000;
  }
  return state;
}

function seat(state: SimState, colony: ColonyId, id = `agent-${colony}`, brood?: Brood): Agent {
  const agent: Agent = { id, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "forage" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [],
    ...(brood === undefined ? {} : { brood }) };
  state.agents.push(agent);
  return agent;
}

const queensOf = (state: SimState, colony: ColonyId): QueenState[] => state.colonies[colony].queens!;

/** The caste each queen of the colony hatched, in queen order, from hatch events at her nest tile. */
function castesBy(state: SimState, colony: ColonyId, events: readonly SimEvent[]): (Caste | null)[] {
  return queensOf(state, colony).map((q) => {
    const born = events.find((e) => e.type === "hatch" && e.colony === colony &&
      e.tileY === Math.floor(q.queenY / SUB) && Math.abs(e.tileX - Math.floor(q.queenX / SUB)) <= 1);
    return born?.type === "hatch" ? born.caste ?? null : null;
  });
}

/** One hatch round, far enough after the last that every queen's interval has passed. */
function round(state: SimState): SimEvent[] {
  state.tick += 100;
  const events: SimEvent[] = [];
  hatch(state, state.tick, events);
  return events;
}

describe("rules 27: each queen of a colony with an agent hatches her own brood", () => {
  it("workers, soldiers and an unset (mixed) queen each hatch their own caste", () => {
    const state = threeQueens(RULES_27);
    seat(state, 0, "agent-0", "soldiers");
    const [workers, soldiers, unset] = queensOf(state, 0);
    workers!.brood = "workers";
    soldiers!.brood = "soldiers";
    expect(unset!.brood).toBeUndefined();
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "soldier", "worker"]);
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "soldier", "soldier"]);
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "soldier", "worker"]);
    // The agent's own vote no longer chooses any queen's brood.
    expect(state.agents[0]!.brood).toBe("soldiers");
  });

  it("mixed alternates per queen from worker, not colony-wide, and leaves the colony's mixedNext alone", () => {
    const state = threeQueens(RULES_27);
    seat(state, 0);
    const queens = queensOf(state, 0);
    expect(queens.map((q) => queenNextCaste(state, state.colonies[0], q))).toEqual(["worker", "worker", "worker"]);
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "worker", "worker"]);
    expect(queens.map((q) => q.mixedNext)).toEqual(["soldier", "soldier", "soldier"]);
    expect(castesBy(state, 0, round(state))).toEqual(["soldier", "soldier", "soldier"]);
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "worker", "worker"]);
    expect(state.colonies[0].mixedNext).toBe("worker");
  });

  it("a queen's alternation is her own: a sister's births, a fixed sister and a blocked hatch do not move it", () => {
    const state = threeQueens(RULES_27);
    seat(state, 0);
    const [mixed, fixed, late] = queensOf(state, 0);
    fixed!.brood = "soldiers";
    late!.lastHatchTick = 10_000;
    expect(castesBy(state, 0, round(state))).toEqual(["worker", "soldier", null]);
    expect(castesBy(state, 0, round(state))).toEqual(["soldier", "soldier", null]);
    expect(late!.mixedNext).toBeUndefined();
    // Only the late queen is ready now; a hatch blocked by food does not move her alternation.
    mixed!.lastHatchTick = 1_000_000;
    fixed!.lastHatchTick = 1_000_000;
    late!.lastHatchTick = -1_000;
    state.colonies[0].foodStore = state.config.hatchCost - 1;
    expect(castesBy(state, 0, round(state))).toEqual([null, null, null]);
    expect(late!.mixedNext).toBeUndefined();
    state.colonies[0].foodStore = state.config.hatchCost;
    expect(castesBy(state, 0, round(state))).toEqual([null, null, "worker"]);
    expect([mixed!.mixedNext, late!.mixedNext]).toEqual(["worker", "soldier"]);
  });
});

describe("rules 27: a colony with no registered agent keeps today's colony brood", () => {
  it("hatches the colony-wide mixed brood beside a colony with an agent, ignoring queen brood fields", () => {
    // Captured colony brood: unvoted is mixed, alternating across the colony's queens in hatch order.
    const fresh = threeQueens(RULES_27);
    seat(fresh, 0);
    // Queen fields are ignored in a colony with no agent.
    queensOf(fresh, 1)[1]!.brood = "soldiers";
    expect(castesBy(fresh, 1, round(fresh))).toEqual(["worker", "soldier", "worker"]);
    expect(fresh.colonies[1].mixedNext).toBe("soldier");
    expect(queensOf(fresh, 1).map((q) => q.mixedNext)).toEqual([undefined, undefined, undefined]);
    // Its queens read the colony's caste.
    expect(queensOf(fresh, 1).map((q) => queenNextCaste(fresh, fresh.colonies[1], q))).toEqual(["soldier", "soldier", "soldier"]);
  });
});


// An owner that goes idle or leaves (stops calling; the agent stays registered) keeps
// each queen's brood last set, in both idle policies (idle is source-policy dependent).
describe("rules 27: an idle or departed owner's queens keep the brood last set", () => {
  const IDLE = { ...RULES_27, commandIdleTicks: 30 };

  /** A match with the owner joined on colony 0 through the join input; its queens set workers, soldiers, unset. */
  function owned(): SimState {
    let state = emptyMatch(0, IDLE);
    state = step(state, [{ type: "join", agentId: "owner", placement: 0 }]).state;
    const colony = state.colonies[0];
    const first = colony.queens![0]!;
    colony.queens!.push({ ...first, id: 1, queenY: first.queenY + 6 * SUB, starting: undefined },
      { ...first, id: 2, queenY: first.queenY + 12 * SUB, starting: undefined });
    colony.foodStore = 100_000;
    const [a, b, c] = colony.queens!;
    for (const q of [a!, b!, c!]) q.owner = "owner";
    a!.brood = "workers";
    b!.brood = "soldiers";
    return state;
  }

  /** The castes each colony-0 queen hatched over these events, in birth order. */
  function births(state: SimState, events: readonly SimEvent[]): Caste[][] {
    return queensOf(state, 0).map((q) => events.flatMap((e) => e.type === "hatch" && e.colony === 0 &&
      e.tileY === Math.floor(q.queenY / SUB) && Math.abs(e.tileX - Math.floor(q.queenX / SUB)) <= 1 ? [e.caste!] : []));
  }

  function expectKept(state: SimState, events: readonly SimEvent[]): void {
    expect(queensOf(state, 0).map((q) => q.brood)).toEqual(["workers", "soldiers", undefined]);
    const [workers, soldiers, mixed] = births(state, events);
    expect(workers!.length).toBeGreaterThan(2);
    expect(new Set(workers)).toEqual(new Set(["worker"]));
    expect(soldiers!.length).toBeGreaterThan(1);
    expect(new Set(soldiers)).toEqual(new Set(["soldier"]));
    expect(mixed!.length).toBeGreaterThan(2);
    expect(mixed).toEqual(mixed!.map((_, i) => (i % 2 === 0 ? "worker" : "soldier")));
  }

  it("offline, where the command-idle lapse marks the owner idle", () => {
    let state = owned();
    const events: SimEvent[] = [];
    for (let t = 0; t < 200; t += 1) {
      const out = step(state);
      events.push(...out.events);
      state = out.state;
    }
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({ id: "owner", colony: 0, idle: true });
    expect(events.some((e) => e.type === "hatch" && e.colony === 0 && e.tick > IDLE.commandIdleTicks + 1)).toBe(true);
    expectKept(state, events.filter((e) => e.tick > IDLE.commandIdleTicks + 1));
  });

  it("in the live game, which suppresses the lapse and ends the idle match instead", () => {
    const game = new Game({ simConfig: IDLE, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1_000_000, houseIdleSeconds: 20 },
      now: () => 0, onLogLine: () => {} });
    game.startMatch(1, { state: owned() });
    const events: SimEvent[] = [];
    for (let out = game.tick(); out !== null; out = game.tick()) events.push(...out.events);
    const state = game.match!.state;
    expect(state.result).toMatchObject({ reason: "idle", winner: 1 });
    // Past the command-idle limit, yet never lapsed: the live path suppresses it.
    expect(state.tick).toBeGreaterThan(IDLE.commandIdleTicks * 4);
    expect(state.agents[0]).toMatchObject({ id: "owner", idle: false });
    expectKept(state, events);
  });
});

