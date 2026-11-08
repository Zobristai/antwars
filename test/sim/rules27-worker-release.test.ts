import { describe, expect, it } from "vitest";
import { applyInput, countMarkDirection, defaultAllocator, lapseSquads } from "../../src/sim/agents.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { foodTiles } from "../../src/sim/forage.js";
import { localDirection } from "../../src/sim/houseBot.js";
import { beginLocalGoals, readLocalGoal } from "../../src/sim/localArrival.js";
import { buildGrid, cloneState, newAnt, tileIndex } from "../../src/sim/map.js";
import { claimCountMarks, expireMarks, localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Colony 0's queen stands at reference tile (8,24). A is the closest known food to the worker
// and to the nest; B is the food nearest the FORAGE mark, so the mark chooses B.
// emptyMatch plays at grid scale 2, so every reference position below is
// doubled into fine tiles (reference tile t is fine tiles 2t and 2t+1; the queen stands at fine (16.5, 48.5)).
const A = { x: 24, y: 44 };
const B = { x: 32, y: 58 };
const MARK = { x: 32, y: 60 };
const WORKER = { x: 32, y: 48 };

const REDESIGN = rulesConfig("redesign");
function config(countMarks: Partial<NonNullable<SimConfig["countMarks"]>> = {}): SimConfig {
  return { ...REDESIGN, terrain: undefined, foodLayout: undefined,
    commandFloorTicks: 1, countMarks: { ...REDESIGN.countMarks!, ...countMarks } };
}

function tile(state: SimState, at: { x: number; y: number }): number {
  return tileIndex(state.config, at.x, at.y);
}

/** Only A and B hold food, and colony 0 already knows both. */
function stockFood(state: SimState): void {
  state.food.fill(0);
  const cap = new Array<number>(state.foodCap.length).fill(0);
  for (const at of [A, B]) {
    state.food[tile(state, at)] = 5;
    cap[tile(state, at)] = 5;
  }
  (state as { foodCap: readonly number[] }).foodCap = cap;
  state.colonies[0].seenFood = [tile(state, A), tile(state, B)].sort((a, b) => a - b);
}

function seat(state: SimState, id: string, lastCommandTick: number | null = null): Agent {
  const agent: Agent = { id, colony: 0, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return agent;
}

function layForage(state: SimState, count: number): void {
  const result = applyInput(state, { type: "count_mark", agentId: "a", verb: "FORAGE", count, tileX: MARK.x, tileY: MARK.y },
    state.tick, defaultAllocator, []);
  expect(result.error).toBeNull();
}

interface Scene {
  readonly state: SimState;
  readonly worker: Ant;
  readonly scout: Ant;
}

/**
 * A seated colony whose worker answers a FORAGE mark and works the food the
 * mark chose (B), not the closest food it knows (A). The soldier scout gives
 * sight of the mark tile; FORAGE never recruits it.
 */
function claimedWorker(options: { count?: number; nearer?: boolean; countMarks?: Partial<NonNullable<SimConfig["countMarks"]>> } = {}): Scene {
  const state = emptyMatch(100, config(options.countMarks));
  stockFood(state);
  seat(state, "a");
  state.nextAntId = 1;
  const worker = addAnt(state, 0, WORKER.x, WORKER.y);
  const scout = addAnt(state, 0, MARK.x, MARK.y, { caste: "soldier", role: "fighter" });
  // A nearer worker keeps its claim when the count shrinks; the farther one is released.
  if (options.nearer === true) addAnt(state, 0, MARK.x, MARK.y - 4);
  layForage(state, options.count ?? 1);
  const mark = state.marks[0]!;
  claimCountMarks(state, state.tick);
  expect(worker.claim).toBe(mark.id);
  countMarkDirection(state, buildGrid(state), foodTiles(state), worker, mark);
  expect(worker.foodTarget).toBe(tile(state, B));
  return { state, worker, scout };
}

/** Each count-mark release site. */
const RELEASES: readonly [string, () => Scene][] = [
  ["its mark expires", () => {
    const scene = claimedWorker();
    const { state } = scene;
    expireMarks(state, state.marks[0]!.laidTick + state.config.markLifetimeTicks);
    expect(state.marks).toEqual([]);
    claimCountMarks(state, ++state.tick);
    return scene;
  }],
  ["its mark's count shrinks", () => {
    const scene = claimedWorker({ count: 2, nearer: true });
    const { state } = scene;
    state.tick += 1;
    layForage(state, 1);
    claimCountMarks(state, state.tick);
    return scene;
  }],
  ["its seat lapses while another seat on the colony stays active", () => {
    const scene = claimedWorker();
    const { state } = scene;
    seat(state, "b", state.tick);
    state.tick += state.config.commandIdleTicks!;
    state.agents[0]!.lastCommandTick = 0;
    state.agents[1]!.lastCommandTick = state.tick;
    lapseSquads(state, state.tick, []);
    expect(state.agents.map((agent) => agent.idle)).toEqual([true, false]);
    expect(state.marks).toEqual([]);
    return scene;
  }],
];

interface Plan {
  readonly dir: { readonly x: number; readonly y: number };
  readonly foraging: boolean;
  readonly foodTarget: number;
  readonly goal: string | undefined;
}

/** The ant's next free-ant plan on a copy of the state: direction, foraging, chosen food and local goal. */
function planOf(state: SimState, antId: number): Plan {
  const copy = cloneState(state);
  const ant = copy.ants.find((a) => a.id === antId)!;
  beginLocalGoals(copy);
  const { dir, foraging } = localDirection(copy, buildGrid(copy), ant);
  return { dir: { x: dir.x, y: dir.y }, foraging, foodTarget: ant.foodTarget, goal: readLocalGoal(copy, ant)?.key };
}

/** The same state with this ant replaced by a never-claimed ant of the same id, caste and position. */
function neverClaimed(state: SimState, antId: number): SimState {
  const copy = cloneState(state);
  const index = copy.ants.findIndex((a) => a.id === antId);
  const ant = copy.ants[index]!;
  copy.ants[index] = newAnt(copy.config, ant.id, ant.colony, ant.x, ant.y, ant.caste);
  return copy;
}

describe("rules 27: a released seated worker resumes the local worker rules", () => {
  it.each(RELEASES)("when %s, it plans like a never-claimed worker and forages the closest known food", (_name, release) => {
    const { state, worker } = release();
    expect(worker.claim).toBeUndefined();
    expect(localRulesSide(state, 0)).toBe(true);
    // The mark's food choice, its hold and its cluster target are gone.
    expect(worker.foodTarget).toBe(-1);
    expect(worker.softFoodTarget).toBeUndefined();
    const released = planOf(state, worker.id);
    expect(released).toEqual(planOf(neverClaimed(state, worker.id), worker.id));
    expect(released.foraging).toBe(true);
    expect(released.foodTarget).toBe(tile(state, A));
  });


  it("only seated sides: when the colony's last seat lapses, a released worker keeps its food for the house bot", () => {
    const { state, worker } = claimedWorker();
    state.tick += state.config.commandIdleTicks!;
    state.agents[0]!.lastCommandTick = 0;
    lapseSquads(state, state.tick, []);
    expect(localRulesSide(state, 0)).toBe(false);
    expect(worker.claim).toBeUndefined();
    expect(worker.foodTarget).toBe(tile(state, B));
  });

  it("only seated sides: when every seat lapses in the same tick, the earlier seat's released worker keeps its food too", () => {
    const { state, worker } = claimedWorker();
    // Seat b joins after a, so a's marks are released first in the lapse pass.
    seat(state, "b");
    state.tick += state.config.commandIdleTicks!;
    for (const agent of state.agents) agent.lastCommandTick = 0;
    lapseSquads(state, state.tick, []);
    expect(state.agents.map((agent) => agent.idle)).toEqual([true, true]);
    expect(localRulesSide(state, 0)).toBe(false);
    expect(worker.claim).toBeUndefined();
    expect(worker.foodTarget).toBe(tile(state, B));
  });
});

describe("rules 27: count-mark recruitment, claims and release order", () => {
  /** Two marks, workers near and across the map, an equal-distance pair, then a count shrink. */
  function claims(): { first: [number, number | undefined][]; shrunk: [number, number | undefined][] } {
    const state = emptyMatch(100, config());
    stockFood(state);
    seat(state, "a");
    addAnt(state, 0, MARK.x, MARK.y, { caste: "soldier", role: "fighter" });
    const workers = [
      addAnt(state, 0, MARK.x, MARK.y - 6),
      addAnt(state, 0, MARK.x - 4, MARK.y),
      addAnt(state, 0, MARK.x + 4, MARK.y),
      // Far outside smell and recruit range of either mark: colony-wide reach still claims it.
      addAnt(state, 0, 112, 8),
      addAnt(state, 0, 80, 88),
    ];
    layForage(state, 4);
    state.tick += 1;
    const gather = applyInput(state, { type: "count_mark", agentId: "a", verb: "GATHER", count: 1, caste: "worker", tileX: MARK.x, tileY: MARK.y - 12 },
      state.tick, defaultAllocator, []);
    expect(gather.error).toBeNull();
    claimCountMarks(state, state.tick);
    const first = workers.map((ant): [number, number | undefined] => [ant.id, ant.claim]);
    state.tick += 1;
    layForage(state, 2);
    claimCountMarks(state, state.tick);
    const shrunk = workers.map((ant): [number, number | undefined] => [ant.id, ant.claim]);
    return { first, shrunk };
  }

  it("claims ants colony-wide, and releases the farthest on a shrink", () => {
    const rules27 = claims();
    // Every worker answers a mark, including the two across the map.
    expect(rules27.first.every(([, claim]) => claim !== undefined)).toBe(true);
    // The shrink releases the farthest FORAGE ants first.
    expect(rules27.shrunk.filter(([, claim]) => claim === undefined).length).toBe(2);
  });
});

describe("rules 27: the FORAGE job runs as captured until release", () => {
  interface Trace {
    readonly tick: number;
    readonly claim: number | undefined;
    readonly carrying: boolean;
    readonly foodTarget: number;
    readonly x: number;
    readonly y: number;
    readonly store: number;
  }

  /** Step a seated FORAGE worker through pickup, delivery and its next marked trip, then expire the mark. */
  function forageLoop(): { claimed: Trace[]; after: Trace[]; delivered: number } {
    let state = emptyMatch(100, config());
    stockFood(state);
    seat(state, "a");
    state.nextAntId = 1;
    const workerId = addAnt(state, 0, WORKER.x, WORKER.y).id;
    const scout = addAnt(state, 0, MARK.x, MARK.y, { caste: "soldier", role: "fighter" });
    layForage(state, 1);
    // The scout only gave sight of the mark tile.
    state.ants = state.ants.filter((ant) => ant !== scout);
    const trace = (s: SimState): Trace => {
      const ant = s.ants.find((a) => a.id === workerId)!;
      return { tick: s.tick, claim: ant.claim, carrying: ant.carrying, foodTarget: ant.foodTarget, x: ant.x, y: ant.y,
        store: s.colonies[0].foodStore };
    };
    const claimed: Trace[] = [];
    const startStore = state.colonies[0].foodStore;
    let delivered = 0;
    for (let i = 0; i < 400 && delivered === 0; i++) {
      state = step(state).state;
      claimed.push(trace(state));
      if (state.colonies[0].foodStore > startStore) delivered = state.tick;
    }
    // Back under the mark at the nest, heading for B again: then the mark expires.
    for (let i = 0; i < 3; i++) {
      state = step(state).state;
      claimed.push(trace(state));
    }
    state.marks[0] = { ...state.marks[0]!, laidTick: state.tick - state.config.markLifetimeTicks + 1 };
    const after: Trace[] = [];
    for (let i = 0; i < 3; i++) {
      state = step(state).state;
      after.push(trace(state));
    }
    return { claimed, after, delivered };
  }

  it("picks up at the mark's food, delivers home and returns to it; once released it forages the closest known food", () => {
    const rules27 = forageLoop();
    expect(rules27.delivered).toBeGreaterThan(0);
    const state = emptyMatch(100, config());
    const [a, b] = [tile(state, A), tile(state, B)];
    // Claimed throughout, it carried B's food home and is heading back to B.
    expect(rules27.claimed.every((t) => t.claim !== undefined)).toBe(true);
    expect(rules27.claimed.some((t) => t.carrying)).toBe(true);
    expect(rules27.claimed.at(-1)).toMatchObject({ carrying: false, foodTarget: b });
    // Mark gone at the end of the first tick; the next tick clears the stale claim.
    expect(rules27.after[0]!.claim).toBeDefined();
    expect(rules27.after[1]).toMatchObject({ claim: undefined, foodTarget: -1 });
    // Ordinary local routing resumes on the following house phase.
    expect(rules27.after[2]!.foodTarget).toBe(a);
  });
});
