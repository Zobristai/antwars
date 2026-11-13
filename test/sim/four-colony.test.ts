import { describe, expect, it } from "vitest";
import { damagePerTick, rulesConfig, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { colonyScores, fourColonyEnd, rankColonies } from "../../src/sim/elimination.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { eliminationsAt, headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { activeQueens, buildGrid, cloneState, createMatch, matchConfigForMap, tileIndex } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { advance, step, type ServerTerminal } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Ant, ColonyId, QueenState, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { denseCells, expandCells, takeView, type ViewCell } from "../../src/sim/view.js";
import { addAnt } from "./fixtures.js";

/** Test-only quadrant geometry (as in quadrant-map.test.ts): nest, water, start area and food off both mirror axes. */
const QUADRANTS: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
    centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
  },
};

/** Test-only replay fixture: top nests 5 reference tiles apart across the vertical axis, far from the bottom ones,
 * each start area in its quadrant's far corner so a nest is not ringed by its own start ants. */
const CLOSE: MapDefinition = {
  id: "close-quadrants", name: "Close Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};

const LIVE = newMatchConfig(rulesConfig("redesign"));
const quadrantConfig = (map: MapDefinition, change: Partial<SimConfig> = {}): SimConfig =>
  ({ ...LIVE, ...change, terrain: { ...LIVE.terrain!, maps: [map] } });
const SEED = 404;
const JOINS: SimInput[] = [0, 1, 2, 3].map(c => ({ type: "join", agentId: `a${c}` }));
const tile = (v: number) => Math.floor(v / SUB);

/** After the combat grace and the queen shield, so ants and queens both fight. */
const FIGHT_TICK = Math.max(LIVE.combatGraceTicks, LIVE.queenHp!.shieldTicks) + 10;

/** A four-colony match at FIGHT_TICK with every ant removed, for scripted combat. */
function emptyMatch(): SimState {
  const state = createMatch(SEED, quadrantConfig(QUADRANTS));
  state.ants = [];
  state.tick = FIGHT_TICK;
  return state;
}

/** An open land tile with no food, at least 12 tiles from every queen. */
function openTile(state: SimState, x0: number, y0: number): { tx: number; ty: number } {
  for (let ty = y0; ty < state.config.mapHeight; ty++) for (let tx = x0; tx < state.config.mapWidth; tx++) {
    const clear = (dx: number) => !isBlockedTile(state.terrain, tx + dx, ty) && (state.food[tileIndex(state.config, tx + dx, ty)] ?? 0) === 0;
    if ([-3, -2, -1, 0, 1, 2, 3].every(clear) && state.colonies.every(c => Math.abs(tile(c.queenX) - tx) > 12 || Math.abs(tile(c.queenY) - ty) > 12)) return { tx, ty };
  }
  throw new Error("no open tile");
}

function queenOf(state: SimState, colony: ColonyId): QueenState {
  return state.colonies[colony]!.queens![0]!;
}

function moveQueen(state: SimState, colony: ColonyId, tx: number, ty: number): void {
  Object.assign(queenOf(state, colony), { queenX: tx * SUB + SUB / 2, queenY: ty * SUB + SUB / 2 });
}

function combat(state: SimState): SimEvent[] {
  const events: SimEvent[] = [];
  resolveCombat(state, buildGrid(state), state.tick, events);
  return events;
}

const kills = (state: SimState) => state.colonies.map(c => c.kills);

describe("a four-colony match on a quadrant map", () => {
  it("starts one colony in each quadrant at the board's nests, with mirrored ants and quadrant food", () => {
    const state = createMatch(SEED, quadrantConfig(QUADRANTS));
    const { mapWidth: w, mapHeight: h } = state.config;
    expect([w, h]).toEqual([128, 128]);
    expect(state.colonies.map(c => [tile(c.queenX), tile(c.queenY)])).toEqual([[14, 22], [w - 15, 22], [14, h - 23], [w - 15, h - 23]]);
    expect(state.colonies.map(c => c.queens!.map(q => q.hp))).toEqual([[40_000], [40_000], [40_000], [40_000]]);
    expect(state.stats.hatched).toHaveLength(4);
    const byColony = [0, 1, 2, 3].map(c => state.ants.filter(a => a.colony === c));
    expect(byColony.map(a => a.length)).toEqual([30, 30, 30, 30]);
    byColony[0]!.forEach((ant, i) => {
      const [x, y] = [tile(ant.x), tile(ant.y)];
      expect([1, 2, 3].map(c => [tile(byColony[c]![i]!.x), tile(byColony[c]![i]!.y)])).toEqual([[w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]]);
      expect(x < w / 2 && y < h / 2).toBe(true);
    });
    // Quadrant food is mirrored four ways; the centre region's seeded food is not.
    const food = (x: number, y: number) => state.food[tileIndex(state.config, x, y)];
    const centre = { x0: (32 - 8) * 2, x1: (32 + 8) * 2, y0: (32 - 6) * 2, y1: (32 + 6) * 2 };
    let total = 0;
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w / 2; x++) {
      if (x >= centre.x0 && x < centre.x1 && y >= centre.y0 && y < centre.y1) continue;
      total += food(x, y)!;
      expect([food(w - 1 - x, y), food(x, h - 1 - y), food(w - 1 - x, h - 1 - y)]).toEqual([food(x, y), food(x, y), food(x, y)]);
    }
    expect(total).toBeGreaterThan(0);
  });

  it("stores a config that draws itself again, so a log header replays the same match", () => {
    const state = createMatch(SEED, quadrantConfig(QUADRANTS));
    expect(matchConfigForMap(SEED, state.config)).toEqual(state.config);
    expect(stateHash(createMatch(SEED, state.config))).toBe(stateHash(state));
  });

  it("refuses a config without local ant rules, queen HP or the territory win, and two-colony nest picks", () => {
    expect(() => createMatch(SEED, quadrantConfig(QUADRANTS, { localAnts: undefined }))).toThrow("local ant rules");
    expect(() => createMatch(SEED, quadrantConfig(QUADRANTS, { queenHp: undefined }))).toThrow("queen HP");
    expect(() => createMatch(SEED, quadrantConfig(QUADRANTS, { earlyWin: undefined }))).toThrow("territory win");
    expect(() => createMatch(SEED, quadrantConfig(QUADRANTS, { initialQueens: [[{ tileX: 14, tileY: 22 }], [{ tileX: 113, tileY: 22 }]] }))).toThrow("nest picks");
  });

  it("refuses a rotation that mixes quadrant and two-colony maps", () => {
    const mixed = { ...LIVE, terrain: { ...LIVE.terrain!, maps: [...LIVE.terrain!.maps, QUADRANTS] } };
    expect(() => createMatch(SEED, mixed)).toThrow("fixture-quadrants: a quadrant map plays only in a four-colony rotation");
  });

  it("without queen founding gives each colony one queen with HP; she cannot be joined by another and her death eliminates the colony", () => {
    const { queenFounding: _rules, ...noFounding } = quadrantConfig(QUADRANTS);
    const plain = createMatch(SEED, noFounding);
    const founding = createMatch(SEED, quadrantConfig(QUADRANTS));
    expect(plain.colonies.map(c => c.queens!.map(q => [q.hp, q.lostTick]))).toEqual([0, 1, 2, 3].map(() => [[40_000, null]]));
    let a = plain, b = founding;
    for (let t = 0; t < 300; t++) {
      a = advance(a, t === 0 ? JOINS : [], undefined, undefined, undefined, false, true).state;
      b = advance(b, t === 0 ? JOINS : [], undefined, undefined, undefined, false, true).state;
      expect(a.result).toBeNull();
    }
    expect(a.stats.hatched).toEqual(b.stats.hatched);
    const own = a.colonies[0]!;
    const refused = step(a, [{ type: "found_queen", agentId: "a0", tileX: tile(own.queenX) + 2, tileY: tile(own.queenY) }]);
    expect(refused.results[0]).toMatchObject({ ok: false, error: { code: "queen_disabled" } });
    queenOf(a, 1).lostTick = a.tick;
    const out = step(a);
    expect(out.state.colonies[1]!.eliminated).toMatchObject({ tick: a.tick, reason: "queens_killed" });
    expect(out.state.result).toBeNull();
  });
});

describe("enemies in a four-colony match", () => {
  it("each colony's ants fight every other colony's ants and bite their queens, never their own", () => {
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const state = emptyMatch();
      const { tx, ty } = openTile(state, 20, 50);
      const attacker = addAnt(state, a, tx, ty), other = addAnt(state, b, tx + 1, ty);
      combat(state);
      expect(attacker.lastTargetId).toBe(a === b ? -1 : other.id);
    }
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const state = emptyMatch();
      const { tx, ty } = openTile(state, 20, 50);
      moveQueen(state, b, tx + 1, ty);
      addAnt(state, a, tx, ty);
      const events = combat(state);
      expect(events.some(e => e.type === "queen_hp" && e.colony === b)).toBe(a !== b);
    }
  });
});

describe("kill credit: the hit that takes the target to zero, in damage order", () => {
  const worker = damagePerTick(LIVE), bite = LIVE.queenHp!.biteDamage;

  it("credits the later ant's colony when the earlier hit leaves the ant alive, and the earlier one's when it kills", () => {
    for (const [hp, credited] of [[worker + 1, 2], [worker, 1]] as const) {
      const state = emptyMatch();
      const { tx, ty } = openTile(state, 20, 50);
      addAnt(state, 1, tx - 2, ty);
      addAnt(state, 0, tx, ty, { hp });
      addAnt(state, 2, tx + 2, ty);
      combat(state);
      expect(kills(state)).toEqual([0, 1, 2, 3].map(c => (c === credited ? 1 : 0)));
      expect(state.stats.deaths).toEqual([1, 0, 0, 0]);
    }
  });

  it("gives an ant two queens bite to death to the lower colony's bite, and a later bite only when the first does not kill", () => {
    for (const [hp, credited] of [[bite, 1], [bite + 1, 2]] as const) {
      const state = emptyMatch();
      const { tx, ty } = openTile(state, 20, 50);
      moveQueen(state, 1, tx - 1, ty);
      moveQueen(state, 2, tx + 1, ty);
      addAnt(state, 0, tx, ty, { hp });
      combat(state);
      expect(kills(state)).toEqual([0, 1, 2, 3].map(c => (c === credited ? 1 : 0)));
    }
  });

  it("puts ant hits before queen bites", () => {
    for (const [hp, credited] of [[worker, 3], [worker + 1, 1]] as const) {
      const state = emptyMatch();
      const { tx, ty } = openTile(state, 20, 50);
      moveQueen(state, 1, tx - 1, ty);
      addAnt(state, 0, tx, ty, { hp });
      addAnt(state, 3, tx + 2, ty);
      combat(state);
      expect(kills(state)).toEqual([0, 1, 2, 3].map(c => (c === credited ? 1 : 0)));
    }
  });

  it("credits a queen's death to the colony whose bite takes her to zero, and credits simultaneous deaths separately", () => {
    const state = emptyMatch();
    const { tx, ty } = openTile(state, 20, 50);
    moveQueen(state, 1, tx, ty);
    queenOf(state, 1).hp = worker + 1;
    addAnt(state, 0, tx - 2, ty, { hp: 100 * worker });
    addAnt(state, 2, tx + 2, ty, { hp: 100 * worker });
    // Two more ants elsewhere: colony 3 kills a colony 0 ant on the same tick.
    const far = openTile(state, 20, 90);
    addAnt(state, 3, far.tx, far.ty);
    addAnt(state, 0, far.tx + 1, far.ty, { hp: worker });
    const events = combat(state);
    expect(events.filter(e => e.type === "queen_lost").map(e => e.type === "queen_lost" && e.colony)).toEqual([1]);
    expect(kills(state)).toEqual([0, 0, 1, 1]);
    expect(cloneState(state).colonies.map(c => c.kills)).toEqual([0, 0, 1, 1]);
  });

  it("leaves two-colony matches without kill credit", () => {
    const state = createMatch(SEED, LIVE);
    state.ants = []; state.tick = FIGHT_TICK;
    const { tx, ty } = openTile(state, 20, 20);
    addAnt(state, 0, tx, ty, { hp: worker });
    addAnt(state, 1, tx + 1, ty);
    combat(state);
    expect(state.stats.deaths).toEqual([1, 0]);
    expect(state.colonies.map(c => c.kills)).toEqual([undefined, undefined]);
  });
});

/** A four-colony match that has played some ticks with four seats, for elimination tests. */
function playedMatch(ticks = 200): SimState {
  let state = createMatch(SEED, quadrantConfig(QUADRANTS));
  for (let t = 0; t < ticks; t++) state = advance(state, t === 0 ? JOINS : [], undefined, undefined, undefined, false, true).state;
  return state;
}

describe("elimination", () => {
  it("on its last queen's death removes the colony's ants without deaths or credit, neutralises its tiles, and play continues", () => {
    const state = playedMatch();
    const before = cloneState(state);
    expect(state.owner.some(o => o === 1)).toBe(true);
    queenOf(state, 1).lostTick = state.tick;
    const tick = state.tick;
    const out = advance(state, [], undefined, undefined, undefined, false, true);
    expect(out.state.result).toBeNull();
    expect(out.state.colonies[1]!.eliminated).toEqual({ tick, reason: "queens_killed", scores: expect.any(Object) });
    expect(out.state.ants.filter(a => a.colony === 1)).toEqual([]);
    expect(out.state.owner.includes(1)).toBe(false);
    expect(out.state.stats.deaths[1]).toBe(before.stats.deaths[1]);
    expect(out.state.colonies.map(c => c.kills)).toEqual(before.colonies.map(c => c.kills));
    expect(eliminationsAt(out.state, tick)).toEqual([{ colony: 1, reason: "queens_killed" }]);
    expect(JSON.parse(tickLine(tick, [], false, true, eliminationsAt(out.state, tick))).eliminated).toEqual([{ colony: 1, reason: "queens_killed" }]);
    let later = out.state;
    for (let t = 0; t < 300; t++) later = advance(later, [], undefined, undefined, undefined, false, true).state;
    expect(later.ants.filter(a => a.colony === 1)).toEqual([]);
    expect(later.stats.hatched[1]).toBe(out.state.stats.hatched[1]);
    expect(later.owner.includes(1)).toBe(false);
    expect(later.colonies[1]!.eliminated!.tick).toBe(tick);
  });

  it("removes a colony the server ends idle the same way, with its queen retired, and records why", () => {
    const state = playedMatch();
    const tick = state.tick;
    const out = advance(state, [], undefined, undefined, undefined, { idle: [2] }, true);
    expect(out.state.result).toBeNull();
    expect(out.state.colonies[2]!.eliminated).toMatchObject({ tick, reason: "idle" });
    expect(activeQueens(out.state.colonies[2]!)).toEqual([]);
    expect(out.state.ants.some(a => a.colony === 2)).toBe(false);
    expect(eliminationsAt(out.state, tick)).toEqual([{ colony: 2, reason: "idle" }]);
  });
});

describe("the end of a four-colony match", () => {
  /** End the given colonies' queens on the current tick and advance one tick. */
  function lose(state: SimState, colonies: readonly number[], terminal: ServerTerminal = false): SimState {
    for (const c of colonies) queenOf(state, c).lostTick = state.tick;
    return advance(state, [], undefined, undefined, undefined, terminal, true).state;
  }

  it("is won by the last colony with a queen", () => {
    let state = lose(playedMatch(), [1]);
    state = lose(state, [2]);
    expect(state.result).toBeNull();
    const tick = state.tick;
    state = lose(state, [3]);
    expect(state.result).toEqual({ winner: 0, reason: "queens_killed", decidedBy: "queens_killed", tick });
  });

  it("reports idle when the last colonies to leave went idle", () => {
    let state = lose(playedMatch(), [1]);
    const tick = state.tick;
    state = advance(state, [], undefined, undefined, undefined, { idle: [2, 3] }, true).state;
    expect(state.result).toEqual({ winner: 0, reason: "idle", decidedBy: "idle", tick });
  });

  it("decides among colonies that all leave on one tick by the time-up order on their scores before that tick's removal", () => {
    let state = lose(playedMatch(), [1]);
    state = lose(state, [2]);
    // Colony 3 holds more territory than colony 0 before the removal; after it neither holds any.
    // No ants, so nothing moves, fights or changes the held tiles during the tick.
    state.ants = [];
    state.colonies[0]!.kills = 5; state.colonies[3]!.kills = 5;
    state.owner.fill(-1);
    for (let i = 0; i < 400; i++) { state.owner[i] = 3; state.lastVisit[i] = state.tick; }
    for (let i = 400; i < 600; i++) { state.owner[i] = 0; state.lastVisit[i] = state.tick; }
    const scores = colonyScores(state);
    const tick = state.tick;
    state = lose(state, [0, 3]);
    expect(state.colonies[3]!.eliminated!.scores).toEqual(scores[3]);
    expect(state.result).toEqual({ winner: 3, reason: "queens_killed", decidedBy: "territory", tick });
    expect(state.owner.every(o => o === -1)).toBe(true);
  });

  it("decides an all-idle tick the same way", () => {
    let state = lose(playedMatch(), [1]);
    state = lose(state, [2]);
    state.ants = [];
    state.colonies[0]!.kills = 7; state.colonies[3]!.kills = 2;
    const tick = state.tick;
    state = advance(state, [], undefined, undefined, undefined, { idle: [0, 3] }, true).state;
    expect(state.result).toEqual({ winner: 0, reason: "idle", decidedBy: "kills", tick });
  });

  it("is won by a colony holding more than half of all owned territory through the hold, from minute 10 and at least 100 tiles", () => {
    const rules = LIVE.earlyWin!;
    const state = playedMatch(1);
    const own = (counts: readonly number[]) => {
      state.owner.fill(-1);
      let i = 0;
      counts.forEach((n, colony) => { for (let k = 0; k < n * 4; k++) state.owner[i++] = colony; });
    };
    const almost = (tick: number) => { state.earlyWinProgress = { leader: 0, ticks: rules.holdTicks - 1 }; return fourColonyEnd(state, tick, false); };
    own([151, 50, 50, 50]);
    expect(almost(rules.minTick)).toEqual({ winner: 0, reason: "sustained_territory", decidedBy: "territory", tick: rules.minTick });
    own([150, 50, 50, 50]);
    expect(almost(rules.minTick)).toBeNull();
    own([151, 50, 50, 50]);
    expect(almost(rules.minTick - 1)).toBeNull();
    own([99, 30, 30, 30]);
    expect(almost(rules.minTick)).toBeNull();
    // Eliminated colonies' former tiles are neutral: colony 0's 151 tiles are then a majority.
    own([151, 0, 0, 200]);
    expect(almost(rules.minTick)).toBeNull();
    state.colonies[3]!.eliminated = { tick: 0, reason: "idle", scores: { kills: 0, territory: 0, ants: 0, delivered: 0 } };
    for (let i = 0; i < state.owner.length; i++) if (state.owner[i] === 3) state.owner[i] = -1;
    expect(almost(rules.minTick)).toMatchObject({ winner: 0, reason: "sustained_territory" });
  });

  it("at time-up ranks survivors by kills, territory, living ants and food, then eliminated colonies latest first", () => {
    const state = playedMatch(1);
    state.ants = [];
    state.owner.fill(-1);
    state.stats.delivered = [5, 9, 9, 0];
    state.colonies.forEach(c => { c.kills = 3; });
    const out = (c: number, tick: number, kills: number) => { state.colonies[c]!.eliminated = { tick, reason: "queens_killed", scores: { kills, territory: 0, ants: 0, delivered: 0 } }; };
    out(3, 50, 9);
    expect(rankColonies(state).map(r => r.colony)).toEqual([1, 2, 0, 3]);
    expect(fourColonyEnd(state, state.config.matchTicks - 1, false)).toEqual({ winner: null, reason: "time_up", decidedBy: "draw", tick: state.config.matchTicks - 1 });
    state.colonies[2]!.kills = 4;
    expect(fourColonyEnd(state, state.config.matchTicks - 1, false)).toEqual({ winner: 2, reason: "time_up", decidedBy: "kills", tick: state.config.matchTicks - 1 });
    out(1, 60, 0);
    out(0, 50, 1);
    // Latest eliminated highest; same-tick eliminations by their own scores.
    expect(rankColonies(state).map(r => r.colony)).toEqual([2, 1, 3, 0]);
  });

  it("ranks kills first in an accepted config without kills-first adjudication, at time-up and among same-tick eliminations", () => {
    const state = createMatch(SEED, quadrantConfig(QUADRANTS, { adjudication: undefined }));
    expect(state.config.adjudication).toBeUndefined();
    state.ants = [];
    state.owner.fill(-1);
    // Colony 1 leads on territory, colony 2 on kills.
    for (let i = 0; i < 400; i++) state.owner[i] = 1;
    for (let i = 400; i < 500; i++) state.owner[i] = 2;
    state.colonies.forEach((c, id) => { c.kills = id === 2 ? 4 : 1; });
    const tick = state.config.matchTicks - 1;
    expect(rankColonies(state).map(r => r.colony)).toEqual([2, 1, 0, 3]);
    expect(fourColonyEnd(state, tick, false)).toEqual({ winner: 2, reason: "time_up", decidedBy: "kills", tick });
    const scores = colonyScores(state);
    const out = (c: number) => { state.colonies[c]!.eliminated = { tick: 50, reason: "queens_killed", scores: scores[c]! }; };
    out(1); out(2);
    expect(rankColonies(state).map(r => r.colony).slice(2)).toEqual([2, 1]);
  });
});

describe("no house player in a four-colony match", () => {
  for (const joins of [[], JOINS] as const) {
    it(`every colony follows its own rules from the first tick (${joins.length} seats joined at tick 0)`, () => {
      let state = createMatch(SEED, quadrantConfig(QUADRANTS));
      const start = new Map(state.ants.map(a => [a.id, [a.x, a.y]]));
      let founding = 0;
      for (let t = 0; t < 400; t++) {
        state = advance(state, t === 0 ? [...joins] : [], undefined, () => { founding += 1; }, undefined, false, true).state;
        expect(state.colonies.every(c => localRulesSide(state, c.id))).toBe(true);
        for (const ant of state.ants as (Ant & { houseRoleHold?: unknown; houseIntentHold?: unknown })[]) {
          expect(ant.houseRoleHold).toBeUndefined();
          expect(ant.houseIntentHold).toBeUndefined();
          expect(ant.role).toBe(ant.caste === "soldier" ? "fighter" : "forager");
        }
        if (t === 0) for (const c of [0, 1, 2, 3]) {
          expect(state.ants.some(a => a.colony === c && (a.x !== start.get(a.id)![0] || a.y !== start.get(a.id)![1]))).toBe(true);
        }
      }
      expect(founding).toBe(0);
      expect(state.stats.delivered.every(d => d > 0)).toBe(true);
    });
  }
});

// Every colony's food store stays a number and colonies 2 and 3 hatch, as colonies 0 and 1 do.
it("keeps every colony's food store a finite number and hatches ants in colonies 2 and 3", () => {
  let state = createMatch(SEED, quadrantConfig(QUADRANTS));
  for (let t = 0; t < 400; t++) {
    state = advance(state, t === 0 ? JOINS : [], undefined, undefined, undefined, false, true).state;
    expect(state.colonies.map(c => Number.isFinite(c.foodStore))).toEqual([true, true, true, true]);
  }
  expect(state.stats.hatched[2]).toBeGreaterThan(0);
  expect(state.stats.hatched[3]).toBeGreaterThan(0);
});

describe("an agent's view in a four-colony match", () => {
  it("shows its own territory only, names enemies by colony, and gives colonies 2 and 3 no name", () => {
    const state = playedMatch(300);
    const grid = buildGrid(state);
    for (const agent of state.agents) {
      const view = takeView(state, grid, agent);
      expect("colonyName" in view).toBe(agent.colony < 2);
      const own = view.territoryRows.join("").split("").filter(c => c === "#").length;
      expect(own).toBe(state.owner.filter(o => o === agent.colony).length);
      for (const cell of view.cells) for (const ant of cell.ants) expect(ant.colony).toBe(state.ants.find(a => a.id === ant.antId)!.colony);
      expect(JSON.stringify(view)).not.toMatch(/enemyTerritory|enemyTiles/);
    }
  });

  it("encodes all four colonies in dense cells, with two-colony bytes unchanged", () => {
    const cells: ViewCell[] = [{ tileX: 3, tileY: 1, food: 2, ants: [0, 1, 2, 3].map(c => ({ antId: 10 + c, colony: c, hp: 4000, caste: c % 2 === 0 ? "worker" as const : "soldier" as const })), queen: 3, queenHp: 900 },
      { tileX: 7, tileY: 2, food: 0, ants: [{ antId: 20, colony: 2, hp: 1 }] }];
    const four = denseCells(cells, 64, 48, 4);
    expect(four.colonies).toBe(4);
    expect(expandCells(four)).toEqual(cells);
    const two = cells.map(c => ({ ...c, ants: c.ants.map(a => ({ ...a, colony: a.colony % 2 })), queen: c.queen === undefined ? undefined : 1 }))
      .map(({ queen, ...c }) => (queen === undefined ? c : { ...c, queen }));
    expect(denseCells(two, 64, 48, 2)).toEqual(denseCells(two, 64, 48));
    expect(denseCells(two, 64, 48)).not.toHaveProperty("colonies");
    expect(expandCells(denseCells(two, 64, 48))).toEqual(two);
  });
});

describe("a four-colony match replayed from its log", () => {
  /** Seat a0 lays an ATTACK count mark on colony 1's queen tile every 20 ticks (refused while out of sight);
   * the writer ends colony 3 idle at tick 300, as the server does for a silent seat. */
  function play(attack: boolean) {
    const config = quadrantConfig(CLOSE, { combatGraceTicks: 0, matchTicks: 1500, queenHp: { ...LIVE.queenHp!, shieldTicks: 0 } });
    const state = createMatch(SEED, config);
    const lines = [headerLine(SEED, state.config)], hashes: string[] = [];
    const marks: { tick: number; ok: boolean }[] = [], losses: { tick: number; colony: number }[] = [];
    while (state.result === null) {
      const tick = state.tick, inputs: SimInput[] = tick === 0 ? [...JOINS] : [];
      const queen = activeQueens(state.colonies[1]!)[0];
      if (attack && tick % 20 === 0 && tick > 0 && queen !== undefined) {
        inputs.push({ type: "count_mark", agentId: "a0", tileX: tile(queen.queenX), tileY: tile(queen.queenY), verb: "ATTACK", count: 200 });
      }
      const terminal: ServerTerminal = tick === 300 ? { idle: [3] } : false;
      const out = advance(state, inputs, undefined, undefined, undefined, terminal, true);
      out.results.forEach((r, i) => { if (inputs[i]!.type === "count_mark") marks.push({ tick, ok: r.ok }); });
      for (const e of out.events) if (e.type === "queen_lost") losses.push({ tick, colony: e.colony });
      lines.push(tickLine(tick, inputs, terminal, true, eliminationsAt(state, tick)));
      hashes.push(stateHash(state));
    }
    return { state, lines, hashes, marks, losses };
  }

  it("reaches the same state hashes, eliminations and result, after a logged attack, a queen loss and an idle end", () => {
    const run = play(true);
    const accepted = run.marks.find(m => m.ok);
    expect(accepted).toBeDefined();
    const logged = run.lines.slice(1).map(l => JSON.parse(l)).filter(l => l.eliminated !== undefined).map(l => ({ tick: l.tick, eliminated: l.eliminated }));
    const queenLoss = logged.find(l => l.eliminated.some((e: { reason: string }) => e.reason === "queens_killed"));
    const idleEnd = logged.find(l => l.eliminated.some((e: { reason: string }) => e.reason === "idle"));
    expect(queenLoss).toBeDefined();
    expect(idleEnd).toEqual({ tick: 300, eliminated: [{ colony: 3, reason: "idle" }] });
    // Event order: the logged attack is accepted, then a queen falls; play goes on past both eliminations to a result.
    expect(accepted!.tick).toBeLessThan(queenLoss!.tick);
    expect(run.state.result).not.toBeNull();
    expect(run.state.result!.tick).toBeGreaterThan(Math.max(queenLoss!.tick, idleEnd!.tick));
    expect(run.state.colonies.filter(c => c.eliminated === undefined).length).toBeGreaterThanOrEqual(2);
    // Without the attack, no queen falls by that tick.
    expect(play(false).losses.filter(l => l.tick <= queenLoss!.tick)).toEqual([]);

    expect(parseLog(run.lines).idle.get(300)).toEqual([3]);
    const replayed: string[] = [];
    const end = replay(run.lines, Infinity, s => replayed.push(stateHash(s)));
    expect(replayed).toEqual(run.hashes);
    expect(end.result).toEqual(run.state.result);
    const replayedEliminations = end.colonies.flatMap(c => c.eliminated === undefined ? [] : [{ tick: c.eliminated.tick, colony: c.id, reason: c.eliminated.reason }]);
    expect(replayedEliminations.toSorted((a, b) => a.tick - b.tick || a.colony - b.colony))
      .toEqual(logged.flatMap(l => l.eliminated.map((e: { colony: number; reason: string }) => ({ tick: l.tick, ...e }))));
  }, 120_000);
});
