import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SUB } from "../../src/sim/config.js";
import { buildGrid } from "../../src/sim/map.js";
import { decideTimeUp, updateTerritory } from "../../src/sim/territory.js";
import type { SimEvent, SimState, TileOwner } from "../../src/sim/types.js";
import { addAnt, antById, emptyMatch, ownerAt, run, setOwner } from "./fixtures.js";

function claim(state: SimState, tick: number): void {
  updateTerritory(state, buildGrid(state), tick);
}

// Every match plays at grid scale 2: territory is held per reference tile, a 2x2 block of fine
// cells. An ant at reference tile t stands at its centre (fine 2t + 0.5); at() reads the block's first cell.
const put = (state: SimState, colony: 0 | 1, tx: number, ty: number, patch: Parameters<typeof addAnt>[4] = {}) =>
  addAnt(state, colony, 2 * tx + 0.5, 2 * ty + 0.5, patch);
const hold = (state: SimState, tx: number, ty: number, owner: TileOwner) => {
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) setOwner(state, 2 * tx + dx, 2 * ty + dy, owner);
};
const at = (state: SimState, tx: number, ty: number) => ownerAt(state, 2 * tx, 2 * ty);

describe("presence territory", () => {
  it("gives a tile to the colony whose ant stood on it most recently", () => {
    const state = emptyMatch(0);
    const a = put(state, 0, 20, 20);
    claim(state, 0);
    expect(at(state, 20, 20)).toBe(0);
    state.ants = state.ants.filter((ant) => ant.id !== a.id);
    put(state, 1, 20, 20);
    claim(state, 1);
    expect(at(state, 20, 20)).toBe(1);
    expect(state.stats.ownerChanges).toBe(4); // one reference tile is four fine cells
  });

  it("returns a tile to neutral 20 s after its colony's last visit", () => {
    const state = emptyMatch(0);
    put(state, 0, 20, 20);
    claim(state, 100);
    state.ants = [];
    claim(state, 299);
    expect(at(state, 20, 20)).toBe(0);
    claim(state, 300);
    expect(at(state, 20, 20)).toBe(-1);
  });

  it("never changes a tile's owner, to a colony or to neutral, while an ant on it has an enemy in combat reach", () => {
    const state = emptyMatch(0);
    hold(state, 20, 20, 1);
    put(state, 0, 20, 20);
    put(state, 1, 21, 20);
    claim(state, 0);
    // Contested: the colony-0 ant cannot take the colony-1 tile, and the neutral tile stays neutral.
    expect(at(state, 20, 20)).toBe(1);
    expect(at(state, 21, 20)).toBe(-1);
    // Held past the decay time while contested, it still does not go neutral.
    claim(state, 500);
    expect(at(state, 20, 20)).toBe(1);
  });

  it("keeps a defender's 1.25x bonus through a fight longer than 20 s; the attacker on enemy ground gets none", () => {
    const state = emptyMatch(600);
    hold(state, 30, 20, 0);
    hold(state, 31, 20, 0);
    const defender = put(state, 0, 30, 20, { hp: 40000 });
    const attacker = put(state, 1, 31, 20, { hp: 30000 });
    let current = state;
    let ticks = 0;
    while (antById(current, attacker.id) !== undefined) {
      const before = current;
      current = run(current, 1).state;
      ticks += 1;
      expect(current.stats.bonusHits[0]).toBe(before.stats.bonusHits[0] + 1);
      expect(current.stats.bonusHits[1]).toBe(0);
      expect(at(current, 30, 20)).toBe(0);
      if (antById(current, attacker.id) !== undefined) expect(at(current, 31, 20)).toBe(0);
    }
    expect(ticks).toBeGreaterThan(DEFAULT_CONFIG.territoryDecayTicks);
    expect(antById(current, defender.id)?.hp).toBe(40000 - ticks * 100);
  });

  it("returns a contested tile to neutral as soon as the fight ends when its owner has been away 20 s", () => {
    const state = emptyMatch(600);
    hold(state, 30, 20, 0);
    hold(state, 31, 20, 0);
    const defender = put(state, 0, 30, 20, { hp: 40000 });
    const attacker = put(state, 1, 31, 20, { hp: 30000 });
    let current = state;
    let ticks = 0;
    while (antById(current, attacker.id) !== undefined) {
      current = run(current, 1).state;
      ticks += 1;
      // Contested: the attacker's tile neither changes hands nor goes neutral, and its clock is not refreshed.
      if (antById(current, attacker.id) !== undefined) expect(at(current, 31, 20)).toBe(0);
    }
    expect(ticks).toBeGreaterThan(DEFAULT_CONFIG.territoryDecayTicks);
    // Colony 0 last stood on the attacker's tile more than 20 s ago, so it goes neutral on the tick the fight ends.
    expect(at(current, 31, 20)).toBe(-1);
    // The defender stood on its own tile throughout, which refreshed it.
    expect(antById(current, defender.id)).toBeDefined();
    expect(at(current, 30, 20)).toBe(0);
  });

  it("hands the ground over once the fight on it ends", () => {
    const state = emptyMatch(600);
    hold(state, 30, 20, 0);
    hold(state, 31, 20, 0);
    const defender = put(state, 0, 30, 20, { hp: 25000 });
    put(state, 1, 31, 20, { hp: 100000 });
    let current = state;
    let ticks = 0;
    while (antById(current, defender.id) !== undefined) {
      current = run(current, 1).state;
      ticks += 1;
      if (antById(current, defender.id) !== undefined) expect(at(current, 31, 20)).toBe(0);
    }
    expect(ticks).toBeGreaterThan(DEFAULT_CONFIG.territoryDecayTicks);
    // The winner's tile changes hands on the tick the fight ends.
    expect(at(current, 31, 20)).toBe(1);
    // The dead defender's tile keeps its owner: the defender's own visits refreshed it until it died.
    expect(at(current, 30, 20)).toBe(0);
  });

  it("decides time-up on tiles, then ants alive, then food delivered, else a draw", () => {
    const state = emptyMatch(7199);
    setOwner(state, 1, 1, 0);
    expect(decideTimeUp(state, 7199, "time_up")).toMatchObject({ winner: 0, decidedBy: "territory" });
    setOwner(state, 62, 1, 1);
    addAnt(state, 1, 62, 40);
    expect(decideTimeUp(state, 7199, "time_up")).toMatchObject({ winner: 1, decidedBy: "ants_alive" });
    addAnt(state, 0, 1, 40);
    state.stats.delivered = [5, 4];
    expect(decideTimeUp(state, 7199, "time_up")).toMatchObject({ winner: 0, decidedBy: "food_delivered" });
    state.stats.delivered = [4, 4];
    expect(decideTimeUp(state, 7199, "time_up")).toMatchObject({ winner: null, decidedBy: "draw" });
  });

  it("ends the match when 30 minutes of 10 Hz ticks run out", () => {
    expect(DEFAULT_CONFIG.matchTicks).toBe(30 * 60 * 10);
    const state = emptyMatch(DEFAULT_CONFIG.matchTicks - 2);
    const once = run(state, 1);
    expect(once.state.result).toBeNull();
    const { state: after, events } = run(once.state, 1);
    expect(after.result).toMatchObject({ reason: "time_up", tick: DEFAULT_CONFIG.matchTicks - 1 });
    expect(after.tick).toBe(DEFAULT_CONFIG.matchTicks);
    expect(events.some((e) => e.type === "match_end")).toBe(true);
  });
});

/** Colony-1 fighters standing around colony 0's queen, with no defenders. */
function besiege(tick: number, both = false): SimState {
  const config = { ...DEFAULT_CONFIG, guardCount: 0, fighterShareStartPermille: 1000, fighterShareEndPermille: 1000 };
  const state = emptyMatch(tick, config);
  for (const colony of both ? ([0, 1] as const) : ([0] as const)) {
    const queen = state.colonies[colony];
    const qx = Math.floor(queen.queenX / SUB);
    const qy = Math.floor(queen.queenY / SUB);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0]] as const) {
      addAnt(state, colony === 0 ? 1 : 0, qx + dx, qy + dy, { role: "fighter" });
    }
  }
  return state;
}

function progress(events: SimEvent[], colony: 0 | 1): number[] {
  return events.flatMap((e) => (e.type === "overrun_progress" && e.colony === colony ? [e.progressTicks] : []));
}

const GRACE = DEFAULT_CONFIG.overrunGraceTicks;
const REQUIRED = DEFAULT_CONFIG.overrunTicks;

describe("queen overrun", () => {
  it("builds no overrun progress before the match-global protection boundary", () => {
    expect(GRACE).toBe(12 * 60 * DEFAULT_CONFIG.ticksPerSecond);
    const { state, events } = run(besiege(GRACE - 1), 1);
    expect(state.colonies[0].overrunTicks).toBe(0);
    expect(progress(events, 0)).toEqual([]);
  });

  it("ends the match after the configured sustained majority, reporting every tick", () => {
    const { state, events } = run(besiege(GRACE), REQUIRED + 100);
    expect(state.result).toMatchObject({ winner: 1, reason: "overrun", tick: GRACE + REQUIRED - 1 });
    const reported = progress(events, 0);
    expect(reported).toHaveLength(REQUIRED);
    expect(reported[0]).toBe(1);
    expect(reported[REQUIRED - 1]).toBe(REQUIRED);
  });

  it("resets progress when the majority is broken", () => {
    const half = run(besiege(GRACE), 50).state;
    expect(half.colonies[0].overrunTicks).toBe(50);
    const queen = half.colonies[0];
    for (let i = 0; i < 4; i += 1) {
      addAnt(half, 0, Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB), { hp: 100000 });
    }
    const { state, events } = run(half, 1);
    expect(state.colonies[0].overrunTicks).toBe(0);
    expect(progress(events, 0)).toEqual([0]);
  });

  it("counts a defender hatched on the deciding tick", () => {
    const config = { ...DEFAULT_CONFIG, guardCount: 0, fighterShareStartPermille: 1000, fighterShareEndPermille: 1000 };
    const state = emptyMatch(GRACE + REQUIRED - 1, config);
    const queen = state.colonies[0];
    addAnt(state, 1, Math.floor(queen.queenX / SUB) + 1, Math.floor(queen.queenY / SUB), { role: "fighter" });
    queen.overrunTicks = REQUIRED - 1;
    queen.foodStore = DEFAULT_CONFIG.hatchCost;
    queen.lastHatchTick = -DEFAULT_CONFIG.hatchIntervalTicks;
    const out = run(state, 1);
    expect(out.events.some((e) => e.type === "hatch" && e.colony === 0)).toBe(true);
    expect(out.state.result).toBeNull();
    expect(out.state.colonies[0].overrunTicks).toBe(0);
  });

  it("decides a double overrun on the same tick as at time-up", () => {
    const { state } = run(besiege(GRACE, true), REQUIRED + 100);
    expect(state.result).toMatchObject({ reason: "double_overrun", tick: GRACE + REQUIRED - 1 });
    expect(state.result).toEqual(decideTimeUp(state, GRACE + REQUIRED - 1, "double_overrun"));
  });
});

// The same comparator must serve every adjudicated ending, never an elimination.
describe.each(["time_up", "double_overrun", "queens_killed"] as const)("kills-first %s adjudication", reason => {
  it("orders enemy ant kills, territory, living ants, delivered food, then draw", () => {
    const state = emptyMatch(0, { ...DEFAULT_CONFIG, adjudication: "kills-first" });
    setOwner(state, 1, 1, 0);
    state.stats.deaths = [4, 1]; // Colony 1 killed four; colony 0 killed one.
    expect(decideTimeUp(state, 10, reason)).toEqual({ winner: 1, reason, decidedBy: "kills", tick: 10 });
    state.stats.deaths = [1, 4];
    setOwner(state, 2, 1, 1); setOwner(state, 3, 1, 1);
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: 0, decidedBy: "kills" });
    state.stats.deaths = [4, 4];
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: 1, decidedBy: "territory" });
    state.owner.fill(-1);
    addAnt(state, 0, 10, 10);
    state.stats.delivered = [0, 5];
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: 0, decidedBy: "ants_alive" });
    addAnt(state, 1, 50, 10);
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: 1, decidedBy: "food_delivered" });
    state.stats.delivered = [5, 5];
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: null, decidedBy: "draw" });
    expect(state.stats.deaths).toEqual([4, 4]);
  });

  it("retains territory-first scoring when the recorded config has no marker", () => {
    const state = emptyMatch();
    setOwner(state, 1, 1, 0);
    state.stats.deaths = [40, 1];
    expect(decideTimeUp(state, 10, reason)).toMatchObject({ winner: 0, reason, decidedBy: "territory" });
  });
});

it("resolves the natural time limit using kills on the terminal tick", () => {
  const config = { ...DEFAULT_CONFIG, adjudication: "kills-first" as const, matchTicks: 1 };
  const state = emptyMatch(0, config);
  state.stats.deaths = [4, 1];
  const out = run(state, 1);
  expect(out.state.result).toEqual({ winner: 1, reason: "time_up", decidedBy: "kills", tick: 0 });
  expect(out.events).toContainEqual({ type: "match_end", tick: 0, result: out.state.result });
});
