import { describe, expect, it } from "vitest";
import { houseOnlyLength, variantSummary } from "../tools/summary.js";
import { applyInput, countMarkDirection, defaultAllocator } from "../../src/sim/agents.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { COUNT_MARK_MAX_COUNT, LOCAL_ANT_RULES, PUBLIC_CONFIG, QUEEN_HP_RULES, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { headerLine, stateHash, tickLine } from "../../src/sim/log.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { claimCountMarks, expireMarks, localRulesSide, type ContentionRecord, type StepObservers } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import { queensKilled } from "../../src/sim/territory.js";
import type { Agent, Ant, ColonyId, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";
import { PRE_FRONTLINE_CONFIGS, PRE_FRONTLINE_PUBLIC_CONFIG, addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";

// Squads of one, so a scenario's free ants are not drafted into the seated agent's squad first.
const HISTORICAL_COUNTS = { recruitTiles: 8, defendTiles: 3 };
const COUNT: SimConfig = { ...PRE_FRONTLINE_CONFIGS["count-marks"], adjudication: undefined, controlRevision: undefined, marksPerAgent: 3, countMarks: HISTORICAL_COUNTS, terrain: { ...PUBLIC_CONFIG.terrain!, rocks: undefined }, foodLayout: undefined, squadSize: 1 };
// These recorded comparison scenarios assert the original redesign, including the
// guard-only soldier and a claim/death at a particular tick. Keep that config
// replayable; balance.test.ts exercises the new public rules separately.
const REDESIGN: SimConfig = { ...PRE_FRONTLINE_CONFIGS.redesign, adjudication: undefined, softSeparation: undefined, hatchTiming: undefined, terrain: { ...PUBLIC_CONFIG.terrain!, rocks: undefined }, foodLayout: undefined, squadSize: 1,
  controlRevision: undefined, marksPerAgent: 3, countMarks: HISTORICAL_COUNTS, localAnts: LOCAL_ANT_RULES,
  foodPatches: PRE_FRONTLINE_PUBLIC_CONFIG.foodPatches, earlyWin: undefined };
const tile = (ant: Ant): [number, number] => [Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)];
// Every match plays at grid scale 2. Converted scenarios place reference tile t at fine tile
// f(t) = 2t + 1, so tile distances double exactly. Colony 0's queen sits one subunit homeward of her
// reference tile's centre, in fine tile 16; her bite reaches two fine tiles, so "beside her" is fine 18.
const f = (t: number) => 2 * t + 1;
const QUEEN0_FINE = { x: 16, y: 49 };

/** A seated agent with a one-ant squad standing on (tx, ty). */
function seat(state: SimState, id: string, colony: ColonyId, tx: number, ty: number): Agent {
  const agent: Agent = { id, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" },
    lastCallTick: state.tick, lastCommandTick: null, idle: false, pendingEvents: [] };
  const ant = addAnt(state, colony, tx, ty, { squad: id });
  agent.squad.push(ant.id);
  state.agents.push(agent);
  return agent;
}

function lay(state: SimState, agentId: string, verb: string, count: number, tileX?: number, tileY?: number): SimEvent[] {
  const events: SimEvent[] = [];
  const out = applyInput(state, { type: "count_mark", agentId, verb, count, ...(tileX === undefined ? {} : { tileX, tileY }) }, state.tick, defaultAllocator, events);
  expect(out.error).toBeNull();
  return events;
}

/** Ants by colony 0's nest, so the house planner draws its guards from them rather than from a scenario's ants. */
function nestAnts(state: SimState, n = 12): void {
  for (let i = 0; i < n; i++) addAnt(state, 0, f(7 + (i % 3)), f(23 + Math.floor(i / 3) % 3));
}

const claimedBy = (state: SimState, markId: number): number[] => state.ants.filter((a) => a.claim === markId).map((a) => a.id).sort((a, b) => a - b);

describe("the rules switch", () => {
  it("unset is today's public config, v4 differs only by its name, and any other value refuses", () => {
    expect(rulesConfig(undefined)).toBe(PUBLIC_CONFIG);
    const { rules, ...v4 } = rulesConfig("v4");
    expect(rules).toBe("v4");
    expect(v4).toEqual(PUBLIC_CONFIG);
    for (const bad of ["", "V4", "redesign ", "full"]) expect(() => rulesConfig(bad)).toThrow(/ANTWAR_RULES/);
    expect(rulesConfig("count-marks").localAnts).toBeUndefined();
    expect(rulesConfig("count-marks").queenHp).toBeUndefined();
  });
});

describe("count marks", () => {
  it("are refused outside the variant and with a bad verb or count", () => {
    const pub = emptyMatch(700, { ...PUBLIC_CONFIG, startAnts: 0 });
    seat(pub, "a", 0, 20, 20);
    expect(applyInput(pub, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2 }, pub.tick, defaultAllocator, []).error?.code).toBe("count_marks_disabled");
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, 20, 20);
    for (const [verb, count] of [["HOLD", 2], ["ATTACK", 0], ["ATTACK", 2.5]] as const) {
      expect(applyInput(s, { type: "count_mark", agentId: "a", verb, count }, s.tick, defaultAllocator, []).error?.code).toBe("bad_count_mark");
    }
    expect(applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, tileX: 1, tileY: 1 }, s.tick, defaultAllocator, []).error?.code).toBe("no_own_ant_on_tile");
  });

  it("are claimed by the nearest free ants within smell range, never squad ants or house guards", () => {
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, 20, 20);
    const near = [addAnt(s, 0, 21, 20), addAnt(s, 0, 22, 20), addAnt(s, 0, 24, 20)];
    const far = addAnt(s, 0, 26, 20);
    const guard = addAnt(s, 0, 20, 21, { role: "guard" });
    addAnt(s, 0, 40, 20); // out of range
    const [laid] = lay(s, "a", "GATHER", 3);
    const markId = (laid as Extract<SimEvent, { type: "mark_laid" }>).markId;
    expect(s.marks.find((m) => m.id === markId)).toMatchObject({ words: [], verb: "GATHER", count: 3, revision: 0 });
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, markId)).toEqual(near.map((a) => a.id));
    expect(far.claim).toBeUndefined();
    expect(guard.claim).toBeUndefined();
    expect(s.ants.find((a) => a.squad === "a")!.claim).toBeUndefined();
  });

  it("re-laid with the same verb and tile keeps its claims and changes only n; lowering releases the farthest first", () => {
    const s = emptyMatch(700, { ...COUNT, commandFloorTicks: 1 });
    seat(s, "a", 0, 20, 20);
    const ants = [addAnt(s, 0, 21, 20), addAnt(s, 0, 23, 20), addAnt(s, 0, 25, 20)];
    lay(s, "a", "DEFEND", 3, 20, 20);
    claimCountMarks(s, s.tick);
    const mark = s.marks[0]!;
    s.tick += 1;
    expect(lay(s, "a", "DEFEND", 1, 20, 20)).toEqual([]);
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0]).toMatchObject({ id: mark.id, count: 1, revision: 1, laidTick: mark.laidTick });
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, mark.id)).toEqual([ants[0]!.id]);
  });

  it("releases its claims when a different mark takes its slot or it expires", () => {
    const s = emptyMatch(700, { ...COUNT, commandFloorTicks: 1 });
    seat(s, "a", 0, 20, 20);
    addAnt(s, 0, 21, 20);
    lay(s, "a", "GATHER", 1, 20, 20);
    claimCountMarks(s, s.tick);
    const first = s.marks[0]!.id;
    expect(claimedBy(s, first)).toHaveLength(1);
    for (const verb of ["ATTACK", "FORAGE", "DEFEND"]) {
      s.tick += 1;
      applyInput(s, { type: "mark", agentId: "a", words: [verb === "ATTACK" ? "HELP" : "FOOD"] }, s.tick, defaultAllocator, []);
    }
    expect(s.marks.some((m) => m.id === first)).toBe(false);
    claimCountMarks(s, s.tick);
    expect(s.ants.every((a) => a.claim === undefined)).toBe(true);

    const e = emptyMatch(700, COUNT);
    seat(e, "a", 0, 20, 20);
    nestAnts(e);
    addAnt(e, 0, 21, 20);
    lay(e, "a", "GATHER", 1, 20, 20);
    let state = step(e).state;
    expect(state.ants.some((a) => a.claim !== undefined)).toBe(true);
    for (let i = 0; i < COUNT.markLifetimeTicks; i++) state = step(state, i % 400 === 0 ? [{ type: "observe", agentId: "a" }] : []).state;
    expect(state.marks).toHaveLength(0);
    expect(state.ants.every((a) => a.claim === undefined)).toBe(true);
  });

  it("refills a dead ant's place with the nearest free ant, and recruits within 8 tiles of a member", () => {
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, f(20), f(20));
    nestAnts(s); // raises the 60% cap; all beyond reach of the mark and its member
    const member = addAnt(s, 0, f(27), f(20));
    const recruit = addAnt(s, 0, f(33), f(20)); // 13 reference tiles from the mark, 6 from the member
    lay(s, "a", "GATHER", 2, f(20), f(20));
    claimCountMarks(s, s.tick);
    const markId = s.marks[0]!.id;
    expect(claimedBy(s, markId)).toEqual([member.id]);
    // Recruitment reaches from the group as it stood: the next pass.
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, markId)).toEqual([member.id, recruit.id].sort((a, b) => a - b));
    s.ants = s.ants.filter((a) => a.id !== member.id);
    const spare = addAnt(s, 0, f(22), f(20));
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, markId)).toEqual([recruit.id, spare.id].sort((a, b) => a - b));
  });

  it("an empty group recruits within 8 tiles of the mark's tile", () => {
    const s = emptyMatch(700, { ...COUNT, smellTiles: 4 });
    seat(s, "a", 0, 20, 20);
    const inReach = addAnt(s, 0, 27, 20);
    addAnt(s, 0, 29, 20);
    lay(s, "a", "GATHER", 1, 20, 20);
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, s.marks[0]!.id)).toEqual([inReach.id]);
  });

  it("reports contention before allocation: an ant eligible for two teammates' unfilled marks", () => {
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, 20, 20);
    seat(s, "b", 0, 24, 20);
    const shared = addAnt(s, 0, 22, 20);
    lay(s, "a", "GATHER", 1, 20, 20);
    lay(s, "b", "ATTACK", 1, 24, 20);
    const records: ContentionRecord[] = [];
    claimCountMarks(s, s.tick, { contention: (r) => records.push(r) });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ antId: shared.id, winner: s.marks[0]!.id });
    expect(records[0]!.marks.map((m) => m.agentId)).toEqual(["a", "b"]);
  });

  it("a new FORAGE claim works the food nearest its mark even while its old target still has food; a carrier delivers first; a re-lay keeps targets", () => {
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, 20, 20);
    nestAnts(s);
    const at = (tx: number, ty: number): number => ty * s.config.mapWidth + tx;
    s.food.fill(0);
    s.food[at(21, 20)] = 5; // by the mark
    s.food[at(34, 20)] = 5; // the old target, away from the mark
    const worker = addAnt(s, 0, 26, 20, { foodTarget: at(34, 20) });
    const carrier = addAnt(s, 0, 25, 20, { carrying: true });
    lay(s, "a", "FORAGE", 2, 20, 20);
    const queen = s.colonies[0].queens?.[0] ?? s.colonies[0];
    const toQueen = (ant: Ant): number => Math.hypot(ant.x - queen.queenX, ant.y - queen.queenY);
    const next = step(s).state;
    const w = next.ants.find((a) => a.id === worker.id)!;
    const c = next.ants.find((a) => a.id === carrier.id)!;
    expect([w.claim, c.claim]).toEqual([next.marks[0]!.id, next.marks[0]!.id]);
    expect(w.foodTarget).toBe(at(21, 20));
    expect(w.x).toBeLessThan(worker.x);
    expect(c.carrying).toBe(true);
    expect(toQueen(c)).toBeLessThan(toQueen(carrier));
    // Re-laid with the same verb and tile: the claims stay, and so does each ant's own target.
    next.food[at(19, 20)] = 5;
    w.foodTarget = at(19, 20);
    next.tick += COUNT.commandFloorTicks;
    lay(next, "a", "FORAGE", 3, 20, 20);
    claimCountMarks(next, next.tick);
    expect(w.claim).toBe(next.marks[0]!.id);
    expect(w.foodTarget).toBe(at(19, 20));
  });

  it("steers claimed ants by their verb, keeps them out of squads, and leaves squads, follow_trail and word marks alone", () => {
    const s = emptyMatch(700, COUNT);
    seat(s, "a", 0, 20, 20);
    nestAnts(s);
    const ant = addAnt(s, 0, 26, 20);
    lay(s, "a", "GATHER", 1, 20, 20);
    let state = s;
    for (let i = 0; i < 40; i++) state = step(state).state;
    const moved = state.ants.find((a) => a.id === ant.id)!;
    expect(moved.claim).toBe(state.marks[0]!.id);
    expect(moved.squad).toBeNull();
    expect(tile(moved)).toEqual([20, 20]);
    const view = takeView(state, buildGrid(state), state.agents[0]!);
    expect(view.marks[0]).toMatchObject({ verb: "GATHER", count: 1, claimed: 1, words: [] });
    expect(view.myMarks[0]).toMatchObject({ verb: "GATHER", count: 1, claimed: 1, steering: 0 });
    expect(view.rules).toBe("count-marks");
  });
});

describe("local ant rules (redesign)", () => {
  it("apply only to a seated redesign side", () => {
    const s = emptyMatch(700, REDESIGN);
    seat(s, "a", 0, 20, 20);
    expect([localRulesSide(s, 0), localRulesSide(s, 1)]).toEqual([true, false]);
    s.agents[0]!.idle = true;
    expect(localRulesSide(s, 0)).toBe(false);
    const c = emptyMatch(700, COUNT);
    seat(c, "a", 0, 20, 20);
    expect(localRulesSide(c, 0)).toBe(false);
  });

  it("foragers go only for food the colony has seen", () => {
    const s = emptyMatch(700, REDESIGN);
    seat(s, "a", 0, 8, 30);
    s.food.fill(0);
    const far = 40 * REDESIGN.mapWidth + 30;
    s.food[far] = 5;
    s.colonies[0].seenFood = [];
    const forager = addAnt(s, 0, 10, 24);
    let state = step(s).state;
    expect(state.ants.find((a) => a.id === forager.id)!.foodTarget).toBe(-1);
    state.colonies[0].seenFood = [far];
    state = step(state).state;
    expect(state.ants.find((a) => a.id === forager.id)!.foodTarget).toBe(far);
  });

  it("remembers food its ants see and forgets it once seen empty", () => {
    const s = emptyMatch(700, REDESIGN);
    seat(s, "a", 0, 20, 20);
    s.food.fill(0);
    const here = 22 * REDESIGN.mapWidth + 20;
    s.food[here] = 3;
    let state = step(s).state;
    expect(state.colonies[0].seenFood).toContain(here);
    expect(state.colonies[1].seenFood).not.toContain(here);
    state.food[here] = 0;
    state = step(state).state;
    expect(state.colonies[0].seenFood).not.toContain(here);
  });

  it("free ants near their queen defend her, soldiers hold where they stand, and an agentless side keeps the house bot", () => {
    const s = emptyMatch(700, REDESIGN);
    seat(s, "a", 0, f(20), f(30));
    const defender = addAnt(s, 0, f(9), f(24));
    const soldier = addAnt(s, 0, f(16), f(24), { caste: "soldier", hp: 8000 });
    addAnt(s, 1, f(9), f(26)); // within 3 reference tiles of colony 0's queen at (8, 24)
    const out = step(s).state;
    const d = out.ants.find((a) => a.id === defender.id)!;
    expect(d.y).toBeGreaterThan(defender.y);
    // Rules 27: a free seated soldier holds where it stands.
    const so = out.ants.find((a) => a.id === soldier.id)!;
    expect([so.x, so.y]).toEqual([soldier.x, soldier.y]);
    // Colony 1 has no seated agent: its planner still assigns house roles.
    const h = emptyMatch(700, REDESIGN);
    seat(h, "a", 0, f(20), f(30));
    for (let i = 0; i < 20; i++) addAnt(h, 1, f(50), f(20 + i));
    const roles = step(h).state.ants.filter((a) => a.colony === 1).map((a) => a.role);
    expect(roles).toContain("guard");
  });
});

describe("queens with HP (redesign)", () => {
  const hpConfig: SimConfig = { ...REDESIGN, startAnts: 0 };
  const queen = (s: SimState, colony: ColonyId) => s.colonies[colony].queens![0]!;

  it("starts at 40 HP; she bites an adjacent enemy for 4 HP every 2 s from the 600-tick combat grace", () => {
    const s = emptyMatch(599, hpConfig);
    expect(queen(s, 0)).toMatchObject({ hp: 40_000 });
    const rusher = addAnt(s, 1, QUEEN0_FINE.x + 2, QUEEN0_FINE.y, { hp: 20_000 });
    resolveCombat(s, buildGrid(s), 599, []);
    expect(rusher.hp).toBe(20_000);
    for (let t = 600; t < 640; t++) resolveCombat(s, buildGrid(s), t, []);
    expect(rusher.hp).toBe(20_000 - 2 * QUEEN_HP_RULES.biteDamage);
  });

  it("takes no damage before tick 3000, then today's per-tick bite with no territory bonus; an ant bites an enemy ant first", () => {
    const s = emptyMatch(2999, hpConfig);
    const biter = addAnt(s, 1, QUEEN0_FINE.x + 2, QUEEN0_FINE.y, { hp: 1_000_000 });
    s.owner.fill(1); // the biter stands on its own territory: no bonus on the queen either way
    resolveCombat(s, buildGrid(s), 2999, []);
    expect(queen(s, 0).hp).toBe(40_000);
    const events: SimEvent[] = [];
    resolveCombat(s, buildGrid(s), 3000, events);
    expect(queen(s, 0).hp).toBe(40_000 - 100);
    expect(events).toContainEqual(expect.objectContaining({ type: "queen_hp", colony: 0, queenId: 0, hp: 39_900 }));
    addAnt(s, 0, QUEEN0_FINE.x + 2, QUEEN0_FINE.y + 1, { hp: 1_000_000 });
    resolveCombat(s, buildGrid(s), 3001, []);
    expect(queen(s, 0).hp).toBe(39_900);
    void biter;
  });

  it("regains 1 HP every 10 s only with no enemy within 3 tiles", () => {
    const s = emptyMatch(3000, hpConfig);
    queen(s, 0).hp = 30_000;
    queen(s, 0).regenFromTick = 3000;
    const enemy = addAnt(s, 1, QUEEN0_FINE.x + 6, QUEEN0_FINE.y, { hp: 1_000_000 }); // 3 reference tiles
    for (let t = 3000; t <= 3100; t++) resolveCombat(s, buildGrid(s), t, []);
    expect(queen(s, 0).hp).toBe(30_000);
    s.ants = s.ants.filter((a) => a !== enemy);
    for (let t = 3101; t <= 3201; t++) resolveCombat(s, buildGrid(s), t, []);
    expect(queen(s, 0).hp).toBe(31_000);
  });

  it("a colony loses when all its queens are dead (queens killed); both at once is decided on territory; no overrun timer", () => {
    const s = emptyMatch(5000, hpConfig);
    expect(queensKilled(s, 5000)).toBeNull();
    queen(s, 0).lostTick = 5000;
    expect(queensKilled(s, 5000)).toMatchObject({ winner: 1, reason: "queens_killed", decidedBy: "queens_killed" });
    queen(s, 1).lostTick = 5000;
    s.owner.fill(-1);
    s.owner[0] = 1;
    expect(queensKilled(s, 5000)).toMatchObject({ winner: 1, reason: "queens_killed", decidedBy: "territory" });

    const o = emptyMatch(REDESIGN.overrunGraceTicks + 10, hpConfig);
    for (let i = 0; i < 6; i++) addAnt(o, 1, 7 + (i % 3), 23 + Math.floor(i / 3), { hp: 1_000_000 });
    let state = o;
    for (let i = 0; i < REDESIGN.overrunTicks + 5; i++) state = step(state).state;
    expect(state.result?.reason).not.toBe("overrun");
    expect(queen(state, 0).overrunTicks).toBe(0);
  });

  it("her bite stops a rush: four plain ants at her side die one per bite, before the shield ends", () => {
    const s = emptyMatch(600, hpConfig);
    for (let i = 0; i < 4; i++) addAnt(s, 1, QUEEN0_FINE.x + 2, QUEEN0_FINE.y - 1 + (i % 3));
    for (let t = 600; t < 680; t++) resolveCombat(s, buildGrid(s), t, []);
    expect(s.ants.filter((a) => a.colony === 1)).toHaveLength(0);
    expect(queen(s, 0).hp).toBe(40_000);
  });

  it("founded queens also have HP", () => {
    const s = emptyMatch(3001, hpConfig);
    s.colonies[0].foodStore = 10_000;
    // Reference tile (26, 30) is the 2x2 block of fine cells 52-53 x 60-61.
    for (const [x, y] of [[52, 60], [53, 60], [52, 61], [53, 61]]) s.owner[y! * s.config.mapWidth + x!] = 0;
    seat(s, "a", 0, f(26), f(30));
    const out = step(s, [{ type: "found_queen", agentId: "a", tileX: f(26), tileY: f(30) }]);
    expect(out.results[0]!.ok).toBe(true);
    expect(out.state.colonies[0].queens![1]).toMatchObject({ hp: 40_000 });
    const view = takeView(out.state, buildGrid(out.state), out.state.agents[0]!);
    expect(view.queens![1]).toMatchObject({ hp: 40_000, maxHp: 40_000 });
  });
});

/** A short scripted match log: two teammates on colony 0, one on colony 1, count marks near the nest. */
function scriptedLog(config: SimConfig, ticks: number): string[] {
  const inputs = new Map<number, SimInput[]>([
    [0, [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "b", placement: 0 }, { type: "join", agentId: "c", placement: 1 }]],
    [1, [{ type: "order", agentId: "a", order: { kind: "hold" } }, { type: "order", agentId: "b", order: { kind: "hold" } }]],
    [150, [{ type: "count_mark", agentId: "a", verb: "GATHER", count: 4 }, { type: "count_mark", agentId: "b", verb: "DEFEND", count: 4 }]],
    [400, [{ type: "count_mark", agentId: "a", verb: "GATHER", count: 2 }]],
  ]);
  for (let t = 600; t < ticks; t += 300) inputs.set(t, [{ type: "observe", agentId: "a" }, { type: "observe", agentId: "b" }, { type: "observe", agentId: "c" }]);
  const lines = [headerLine(6006, playable({ ...config, matchTicks: ticks }))];
  for (const [tick, list] of [...inputs].sort((x, y) => x[0] - y[0])) lines.push(tickLine(tick, list));
  return lines;
}

describe("comparison measures", () => {
  it("reports per-mark asks, claims, arrivals, contention and food shortfall from a replayed log", () => {
    const s = variantSummary(scriptedLog(COUNT, 900));
    expect(s.rules).toBe("count-marks");
    expect(s.ticks).toBe(900);
    expect(s.result?.reason).toBe("time_up");
    const gather = s.marks!.find((m) => m.verb === "GATHER")!;
    expect(gather.asked.map((a) => a.count)).toEqual([4, 2]);
    expect(gather.assignedUnique).toBeGreaterThanOrEqual(2);
    expect(gather.assignedPeak).toBe(4);
    expect(gather.releases.lowered).toBe(2);
    expect(gather.arrivedUnique).toBe(gather.arrivedAlreadyNear + gather.arrivedEntered);
    expect(gather.arrivedUnique).toBeGreaterThan(0);
    expect(s.contention![0].antTicks).toBeGreaterThan(0);
    expect(s.contention![0].antTicks).toBe(s.contention![0].won + s.contention![0].refused);
    expect(s.foodShortfall[0].blockedNestTicks).toBeGreaterThan(0);
    expect(s.foodShortfall[0].episodes.reduce((n, e) => n + e.ticks, 0)).toBe(s.foodShortfall[0].blockedNestTicks);
    expect(s.queenDamageTaken).toBeNull();
  }, 60_000);

  it("counts an ant claimed and killed in the same tick as an assignment and a death, once each", () => {
    // Both sides advance and re-lay ATTACK count marks of 10 at their squads.
    // The edge is forced, not found by seed: marks may be laid anywhere in colony sight, so the side's
    // second agent ("b" or "d") lays a count-1 ATTACK mark on the tile of a free ant that dies,
    // on the tick it dies. Claims settle before combat, so the claim pass takes that ant and the same
    // tick's combat kills it.
    const config: SimConfig = playable({ ...REDESIGN, matchTicks: 2400, countMarks: { ...REDESIGN.countMarks!, placement: "colony_sight" } });
    const script = (force?: { tick: number; agentId: string; tileX: number; tileY: number }) => {
      const inputs = new Map<number, SimInput[]>([
        [0, [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "c", placement: 1 }, { type: "join", agentId: "b", placement: 0 }, { type: "join", agentId: "d", placement: 1 }]],
        [1, [{ type: "order", agentId: "a", order: { kind: "go_to", tileX: f(40), tileY: f(24) } }, { type: "order", agentId: "c", order: { kind: "go_to", tileX: f(25), tileY: f(24) } }]],
      ]);
      for (let t = 0; t < config.matchTicks; t++) {
        const list = inputs.get(t) ?? [];
        if (t >= 600 && t % 50 === 0) list.push({ type: "count_mark", agentId: "a", verb: "ATTACK", count: 10 }, { type: "count_mark", agentId: "c", verb: "ATTACK", count: 10 });
        if (force?.tick === t) list.push({ type: "count_mark", agentId: force.agentId, verb: "ATTACK", count: 1, tileX: force.tileX, tileY: force.tileY });
        if (t % 300 === 0) list.push({ type: "observe", agentId: "a" }, { type: "observe", agentId: "c" });
        if (list.length > 0) inputs.set(t, list);
      }
      return inputs;
    };
    // The unforced play is identical up to a forced tick: collect the free ants that die, in order. A forced
    // count-1 mark on a dying ant's tile claims it only when no other free ant ties it for nearest, so take
    // the first candidate whose forced play shows the same-tick claim and death.
    const unforced = script();
    const candidates: { tick: number; agentId: string; tileX: number; tileY: number }[] = [];
    for (let s = createMatch(6006, config); s.result === null && candidates.length < 8;) {
      const next = step(s, unforced.get(s.tick) ?? []).state;
      const dead = s.ants.find((a) => a.squad === null && a.claim === undefined && !next.ants.some((b) => b.id === a.id));
      if (dead !== undefined) candidates.push({ tick: s.tick, agentId: dead.colony === 0 ? "b" : "d", tileX: Math.floor(dead.x / SUB), tileY: Math.floor(dead.y / SUB) });
      s = next;
    }
    expect(candidates.length).toBeGreaterThan(0);

    // Independent tally from the claim pass and each tick's survivors.
    const tally = (inputs: Map<number, SimInput[]>) => {
      const assigned = new Map<number, Set<number>>();
      const died = new Map<number, number>();
      let sameTick = 0;
      let state = createMatch(6006, config);
      let pass: { antId: number; markId: number }[] = [];
      let claimedBefore = new Set<number>();
      while (state.result === null) {
        const out = step(state, inputs.get(state.tick) ?? [], undefined, undefined, { claims: (r) => { pass = [...r.claims]; } });
        const alive = new Set(out.state.ants.map((a) => a.id));
        for (const { antId, markId } of pass) {
          (assigned.get(markId) ?? assigned.set(markId, new Set()).get(markId)!).add(antId);
          if (alive.has(antId)) continue;
          died.set(markId, (died.get(markId) ?? 0) + 1);
          if (!claimedBefore.has(antId)) sameTick += 1;
        }
        claimedBefore = new Set(out.state.ants.filter((a) => a.claim !== undefined).map((a) => a.id));
        pass = [];
        state = out.state;
      }
      return { assigned, died, sameTick };
    };
    let inputs = script(candidates[0]), counted = tally(inputs);
    for (const force of candidates.slice(1)) {
      if (counted.sameTick > 0) break;
      inputs = script(force);
      counted = tally(inputs);
    }
    const { assigned, died, sameTick } = counted;
    const lines = [headerLine(6006, config), ...[...inputs].sort((x, y) => x[0] - y[0]).map(([t, list]) => tickLine(t, list))];
    expect(sameTick).toBeGreaterThan(0);

    const s = variantSummary(lines);
    for (const m of s.marks!) {
      expect(m.assignedUnique).toBe(assigned.get(m.markId)?.size ?? 0);
      expect(m.deaths).toBe(died.get(m.markId) ?? 0);
      expect(m.releases.died).toBe(m.deaths);
    }
    expect([...assigned.keys()].every((id) => s.marks!.some((m) => m.markId === id))).toBe(true);
  }, 120_000);

  it("reports N/A, not zero, for count-mark measures without count marks", () => {
    const lines = [headerLine(6006, playable({ ...rulesConfig("v4"), players: 2, matchTicks: 300 })), tickLine(0, [{ type: "join", agentId: "a" }, { type: "join", agentId: "c" }])];
    const s = variantSummary(lines);
    expect(s.marks).toBeNull();
    expect(s.contention).toBeNull();
    expect(s.players).toBe(2);
  });

  it("the observers change nothing: hashes match with and without them", () => {
    const lines = scriptedLog(REDESIGN, 600);
    const run = (observers?: StepObservers): string[] => {
      let state = createMatch(6006, playable({ ...REDESIGN, matchTicks: 600 }));
      const ticks = new Map(lines.slice(1).map((l) => JSON.parse(l) as { tick: number; inputs: SimInput[] }).map((t) => [t.tick, t.inputs]));
      const hashes: string[] = [];
      while (state.result === null) {
        state = step(state, ticks.get(state.tick) ?? [], undefined, undefined, observers).state;
        if (state.tick % 100 === 0) hashes.push(stateHash(state));
      }
      return hashes;
    };
    let seen = 0;
    expect(run({ contention: () => seen++, hatchBlocked: () => seen++, claims: () => seen++ })).toEqual(run());
    expect(seen).toBeGreaterThan(0);
  }, 60_000);

  it("measures house-bot-only match length on a variant offline", () => {
    expect(houseOnlyLength(playable({ ...REDESIGN, matchTicks: 300 }))).toMatchObject({ ticks: 300, reason: "time_up" });
  }, 60_000);
});

describe("live agent control rules", () => {
  it.each(["count-marks", "redesign"] as const)("accepts counts above 20, claims above 60%% and retains claims after casualties in %s", (name) => {
    const config = { ...rulesConfig(name), squadSize: 1 };
    const s = emptyMatch(700, config);
    seat(s, "a", 0, 20, 20);
    const free = Array.from({ length: 30 }, () => addAnt(s, 0, 20, 20));
    lay(s, "a", "GATHER", 30);
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, s.marks[0]!.id)).toHaveLength(30);
    s.ants = s.ants.filter(a => a !== free[0]);
    claimCountMarks(s, s.tick);
    expect(claimedBy(s, s.marks[0]!.id)).toHaveLength(29);
    s.tick += config.commandFloorTicks;
    expect(applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count: COUNT_MARK_MAX_COUNT }, s.tick, defaultAllocator, []).error).toBeNull();
    for (const count of [0, -1, 1.5, Infinity, NaN, COUNT_MARK_MAX_COUNT + 1, 1000000, Number.MAX_SAFE_INTEGER, 2 ** 60]) {
      s.agents[0]!.lastCommandTick = null;
      const error = applyInput(s, { type: "count_mark", agentId: "a", verb: "ATTACK", count }, s.tick, defaultAllocator, []).error;
      expect(error?.code).toBe("bad_count_mark");
      if (Number.isInteger(count) && count > COUNT_MARK_MAX_COUNT) expect(error?.message).toContain("at most 10,000");
      // Refused, never clamped, and no command allowance spent.
      expect(s.agents[0]!.lastCommandTick).toBeNull();
      expect(s.marks.find(mark => mark.count !== undefined && mark.count > COUNT_MARK_MAX_COUNT)).toBeUndefined();
    }
  });

  it.each(["v4", "count-marks", "redesign"] as const)("keeps a fourth mark with the unchanged command floor and expiry in %s", name => {
    const { wordMarksDisabled: _retired, ...config } = rulesConfig(name);
    const s = emptyMatch(700, config);
    seat(s, "a", 0, 20, 20);
    expect(config.marksPerAgent).toBeUndefined();
    expect(config.commandFloorTicks).toBe(100);
    expect(config.markLifetimeTicks).toBe(1800);
    for (let i = 0; i < 4; i++) {
      s.tick = 700 + i * 100;
      expect(applyInput(s, { type: "mark", agentId: "a", words: ["HELP"] }, s.tick, defaultAllocator, []).error).toBeNull();
    }
    expect(s.marks).toHaveLength(4);
    expect(s.marks[0]!.laidTick).toBe(700);
    expect(applyInput(s, { type: "mark", agentId: "a", words: ["FOOD"] }, 1099, defaultAllocator, []).error?.code).toBe("rate_limited");
    expireMarks(s, 2499); expect(s.marks).toHaveLength(4);
    expireMarks(s, 2500); expect(s.marks).toHaveLength(3);
  });

  it.each(["count-marks", "redesign"] as const)("DEFEND holds without pursuing, bites adjacent enemies and walks back to its mark in %s", name => {
    const s = emptyMatch(700, { ...rulesConfig(name), squadSize: 1 });
    seat(s, "a", 0, f(20), f(20));
    const ant = addAnt(s, 0, f(20), f(20));
    const enemy = addAnt(s, 1, f(22), f(20), { hp: 1_000_000 });
    lay(s, "a", "DEFEND", 1);
    claimCountMarks(s, s.tick);
    const mark = s.marks[0]!;
    expect(countMarkDirection(s, buildGrid(s), [], ant, mark).dir).toEqual({ x: 0, y: 0 });
    const held = step(s).state.ants.find(a => a.id === ant.id)!;
    if (s.config.softSeparation === undefined) {
      expect([held.x, held.y]).toEqual([ant.x, ant.y]);
    } else {
      // Native DEFEND has no pursuit heading, but neighbouring bodies may push it.
      expect(Math.hypot(held.x - ant.x, held.y - ant.y)).toBeLessThanOrEqual(s.config.softSeparation.maxStep);
      expect(Math.hypot(Math.floor(held.x / SUB) - mark.tileX, Math.floor(held.y / SUB) - mark.tileY))
        .toBeLessThanOrEqual(s.config.countMarks!.defendTiles);
    }
    // ATTACK still pursues the same non-adjacent enemy within the mark's 3-tile radius.
    expect(countMarkDirection(s, buildGrid(s), [], ant, { ...mark, verb: "ATTACK" }).dir.x).toBeGreaterThan(0);
    const old = { ...s, config: { ...s.config, countMarks: { ...s.config.countMarks!, defendHolds: undefined } } };
    expect(countMarkDirection(old, buildGrid(old), [], ant, mark).dir.x).toBeGreaterThan(0);
    enemy.x = ant.x + 2 * SUB;
    const events: SimEvent[] = [];
    resolveCombat(s, buildGrid(s), s.tick, events);
    expect(enemy.hp).toBeLessThan(1_000_000);
    expect(events.some(e => e.type === "fight" && e.antId === ant.id)).toBe(true);
    ant.x -= 2 * SUB;
    expect(countMarkDirection(s, buildGrid(s), [], ant, mark).dir.x).toBeGreaterThan(0);
  });
});
