import { describe, expect, it } from "vitest";
import { resolveCombat } from "../../src/sim/combat.js";
import { FLYER_RULES, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { gridScaleOf } from "../../src/sim/gridScale.js";
import { activeQueens, buildGrid, tileIndex } from "../../src/sim/map.js";
import { countMarkCasteEligible } from "../../src/sim/marks.js";
import { advance, step } from "../../src/sim/step.js";
import { updateTerritory } from "../../src/sim/territory.js";
import type { Agent, Ant, Caste, ColonyId, FlyerAir, Mark, MarkCaste, QueenState, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch, setOwner } from "./fixtures.js";

/**
 * The test plan's numbers over the served configuration: worker 2 HP / 1 HP per second, soldier
 * 10 HP / 3 HP per second, queen 100 HP dealing 10 HP per second every tick, flyer 2 HP / 5 HP per
 * second, own ground x1.25 on top. The served rules-28 configuration carries them; this adds the flyer.
 */
const served = rulesConfig("redesign");
const KAIN: SimConfig = { ...served, flyers: FLYER_RULES };
/** Tick 1 of every fight: the first tick of combat after the grace period and the queen's shield. */
const T0 = Math.max(KAIN.combatGraceTicks, KAIN.queenHp!.shieldTicks);
const FLYER_HP = FLYER_RULES.hp;
const SOLDIER_HP = 10_000;

/** Open ground with no food, so every tile used below is land and every food change is a corpse. */
function match(): SimState {
  const state = emptyMatch(T0, { ...KAIN, terrain: undefined, foodLayout: undefined, foodPatches: [] });
  for (const colony of state.colonies) colony.foodStore = 0;
  return state;
}
function hover(tx: number, ty: number): FlyerAir {
  return { destX: tileCentre(tx), destY: tileCentre(ty), hovering: true, released: false };
}
function flying(tx: number, ty: number): FlyerAir {
  return { destX: tileCentre(tx), destY: tileCentre(ty), hovering: false, released: false };
}
function flyer(state: SimState, colony: ColonyId, tx: number, ty: number, air?: FlyerAir, hp = FLYER_HP): Ant {
  return addAnt(state, colony, tx, ty, { flyer: true, caste: "worker", hp, ...(air === undefined ? {} : { air }) });
}
function worker(state: SimState, colony: ColonyId, tx: number, ty: number): Ant {
  return addAnt(state, colony, tx, ty, { caste: "worker" });
}
function soldier(state: SimState, colony: ColonyId, tx: number, ty: number): Ant {
  const { antHp, castes } = state.config;
  return addAnt(state, colony, tx, ty, { caste: "soldier", hp: Math.trunc((antHp * castes!.soldierHpPermille) / 1000) });
}
function owned(state: SimState, x0: number, y0: number, x1: number, y1: number, owner: ColonyId | -1): void {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) setOwner(state, x, y, owner);
}
function queenOf(state: SimState, colony: ColonyId): QueenState {
  return activeQueens(state.colonies[colony])[0]!;
}
function queenTile(state: SimState, colony: ColonyId): { x: number; y: number } {
  const q = queenOf(state, colony);
  return { x: Math.floor(q.queenX / SUB), y: Math.floor(q.queenY / SUB) };
}

interface Fight {
  /** Fight tick (1-based) on which each dead ant died. */
  readonly died: Map<number, number>;
  /** Fight tick on which a queen was lost, by colony. */
  readonly queenLost: Map<ColonyId, number>;
  readonly events: SimEvent[];
}

/** Runs the combat step alone, on fixed positions, for fight ticks 1..ticks (combat tick T0 + n - 1). */
function fight(state: SimState, ticks: number, before?: (n: number) => void, until?: () => boolean): Fight {
  const died = new Map<number, number>(), queenLost = new Map<ColonyId, number>(), events: SimEvent[] = [];
  for (let n = 1; n <= ticks; n += 1) {
    before?.(n);
    const tickEvents: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), T0 + n - 1, tickEvents);
    for (const e of tickEvents) {
      if (e.type === "death") died.set(e.antId, n);
      if (e.type === "queen_lost") queenLost.set(e.colony, n);
    }
    events.push(...tickEvents);
    if (until?.()) break;
  }
  return { died, queenLost, events };
}
const alive = (state: SimState, ants: readonly Ant[]): Ant[] => ants.filter((a) => state.ants.includes(a));
const lastDeath = (f: Fight, ants: readonly Ant[]): number => Math.max(...ants.map((a) => f.died.get(a.id) ?? Infinity));

/** The 3 x 3 tiles around a tile, row by row. */
function around(x: number, y: number): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) tiles.push({ x: x + dx, y: y + dy });
  return tiles;
}

interface Raid { readonly state: SimState; readonly flyers: Ant[]; readonly defenders: Ant[]; readonly queen: QueenState }

/** Colony 1's landed flyers and colony 0's defenders in the 3 x 3 tiles around colony 0's queen, all of them colony 0's ground. */
function raid(flyers: number, defenders: number, caste: Caste): Raid {
  const state = match(), q = queenTile(state, 0), tiles = around(q.x, q.y);
  owned(state, q.x - 1, q.y - 1, q.x + 1, q.y + 1, 0);
  const placed = { flyers: [] as Ant[], defenders: [] as Ant[] };
  for (let i = 0; i < defenders; i += 1) {
    const t = tiles[i % 9]!;
    placed.defenders.push(caste === "soldier" ? soldier(state, 0, t.x, t.y) : worker(state, 0, t.x, t.y));
  }
  for (let i = 0; i < flyers; i += 1) placed.flyers.push(flyer(state, 1, tiles[i % 9]!.x, tiles[i % 9]!.y));
  return { state, ...placed, queen: queenOf(state, 0) };
}

describe("a flyer's damage", () => {
  it("deals 5 HP per second, x1.25 on its own colony's ground, landed and airborne", () => {
    for (const airborne of [false, true]) for (const own of [false, true]) {
      const state = match();
      owned(state, 60, 20, 62, 22, own ? 1 : -1);
      const biter = flyer(state, 1, 61, 21, airborne ? hover(61, 21) : undefined, 1_000_000);
      const target = airborne ? flyer(state, 0, 61, 21, hover(61, 21), 1_000_000) : worker(state, 0, 61, 21);
      target.hp = 1_000_000;
      const before = target.hp;
      expect(biter.hp).toBe(1_000_000);
      fight(state, 10);
      expect(before - target.hp).toBe(own ? 6250 : 5000);
    }
  });
  it("bites an enemy queen for 5 HP per second, landed on its own ground with no enemy ant in reach: a queen takes no own-ground bonus", () => {
    const state = match(), q = queenTile(state, 0), queen = queenOf(state, 0);
    setOwner(state, q.x + 1, q.y, 1);
    const biter = flyer(state, 1, q.x + 1, q.y, undefined, 1_000_000);
    const before = queen.hp!;
    fight(state, 10);
    expect(state.ants).toContain(biter);
    expect(before - queen.hp!).toBe(5000);
    expect(state.stats.bonusHits[1]).toBe(0);
  });
});

describe("test plan check 1: queen raid, combat step alone on fixed positions", () => {
  it("13 flyers against an undefended queen: all dead on tick 26, queen left at 9 HP", () => {
    const { state, flyers, queen } = raid(13, 0, "worker");
    const f = fight(state, 40, undefined, () => alive(state, flyers).length === 0);
    expect(lastDeath(f, flyers)).toBe(26);
    expect(f.queenLost.size).toBe(0);
    expect(queen.hp).toBe(9_000);
  });
  it("14 flyers against an undefended queen: she dies on tick 23 with 3 flyers left", () => {
    const { state, flyers } = raid(14, 0, "worker");
    const f = fight(state, 40, undefined, () => state.colonies[0].queens![0]!.lostTick !== null);
    expect(f.queenLost.get(0)).toBe(23);
    expect(alive(state, flyers)).toHaveLength(3);
  });
  it("19 flyers against a queen with 4 soldiers: all dead on tick 34, queen left at 9 HP", () => {
    const { state, flyers, queen } = raid(19, 4, "soldier");
    const f = fight(state, 60, undefined, () => alive(state, flyers).length === 0);
    expect(lastDeath(f, flyers)).toBe(34);
    expect(f.queenLost.size).toBe(0);
    expect(queen.hp).toBe(9_000);
  });
  it("20 flyers against a queen with 4 soldiers: she dies on tick 26 with 6 flyers left", () => {
    const { state, flyers } = raid(20, 4, "soldier");
    const f = fight(state, 60, undefined, () => state.colonies[0].queens![0]!.lostTick !== null);
    expect(f.queenLost.get(0)).toBe(26);
    expect(alive(state, flyers)).toHaveLength(6);
  });
  it("22 flyers against a queen with 12 workers: all dead on tick 39, queen left at 2 HP", () => {
    const { state, flyers, queen } = raid(22, 12, "worker");
    const f = fight(state, 60, undefined, () => alive(state, flyers).length === 0);
    expect(lastDeath(f, flyers)).toBe(39);
    expect(f.queenLost.size).toBe(0);
    expect(queen.hp).toBe(2_000);
  });
  it("23 flyers against a queen with 12 workers: she dies on tick 32 with 5 flyers left", () => {
    const { state, flyers } = raid(23, 12, "worker");
    const f = fight(state, 60, undefined, () => state.colonies[0].queens![0]!.lostTick !== null);
    expect(f.queenLost.get(0)).toBe(32);
    expect(alive(state, flyers)).toHaveLength(5);
  });
});

describe("test plan check 1: queen raid through the full step", () => {
  /** The flyers landed and claimed on an ATTACK mark at the queen's tile, defenders holding on DEFEND. */
  function stepRaid(flyers: number, defenders: number, caste: Caste) {
    const { state, flyers: raiders, defenders: guards } = raid(flyers, defenders, caste);
    const q = queenTile(state, 0);
    // Flyer marks claim only flyers.
    expect(countMarkCasteEligible(state.config, raiders[0]!, { verb: "ATTACK", caste: "flyer" })).toBe(true);
    const seat = (id: string, colony: ColonyId): Agent => ({ id, colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: T0, lastCommandTick: T0, joinedTick: T0, idle: false, pendingEvents: [] });
    state.agents.push(seat("raider", 1), seat("defender", 0));
    const mark = (agentId: string, colony: ColonyId, verb: "ATTACK" | "DEFEND", count: number, markCaste?: MarkCaste): Mark => ({
      id: state.nextMarkId++, agentId, colony, tileX: q.x, tileY: q.y, words: [], laidTick: T0, steering: 0, verb, count,
      ...(markCaste === undefined ? {} : { caste: markCaste }) });
    const attack = mark("raider", 1, "ATTACK", flyers, "flyer");
    state.marks.push(attack);
    for (const a of raiders) a.claim = attack.id;
    if (defenders > 0) {
      const defend = mark("defender", 0, "DEFEND", defenders);
      state.marks.push(defend);
      for (const a of guards) a.claim = defend.id;
    }
    let current = state, queenLost: number | null = null, lowest = current.colonies[0].queens![0]!.hp!, lastBite = 0;
    for (let n = 1; n <= 300 && current.result === null; n += 1) {
      const out = step(current);
      current = out.state;
      if (out.events.some((e) => e.type === "fight" || e.type === "death" || e.type === "queen_hp" && e.hp < lowest)) lastBite = n;
      const queen = current.colonies[0].queens![0]!;
      lowest = Math.min(lowest, queen.hp!);
      if (queen.lostTick !== null) { queenLost = n; break; }
      if (!current.ants.some((a) => a.colony === 1)) break;
    }
    const left = (colony: ColonyId) => current.ants.filter((a) => a.colony === colony).length;
    return { flyers, defenders: `${defenders} ${caste}s`, queenLostOnTick: queenLost, queenLowestHp: lowest / 1000,
      flyersLeft: left(1), defendersLeft: left(0), lastFightTick: lastBite };
  }
  it("reports how far movement shifts the thresholds and times", () => {
    const rows = [stepRaid(13, 0, "worker"), stepRaid(14, 0, "worker"), stepRaid(19, 4, "soldier"),
      stepRaid(20, 4, "soldier"), stepRaid(22, 12, "worker"), stepRaid(23, 12, "worker")];
    console.info(`check 1 full-step runs (information):\n${rows.map((r) => JSON.stringify(r)).join("\n")}`);
    expect(rows).toHaveLength(6);
  });
  it("settles every soldier and worker raid without fixing balance thresholds", () => {
    const rows = [];
    for (const [defenders, caste] of [[4, "soldier"], [12, "worker"]] as const) {
      for (let flyers = 14; flyers <= 30; flyers++) rows.push(stepRaid(flyers, defenders, caste));
    }
    console.info(`check 1 full-step sweep (measured outcomes):\n${rows.map(r => JSON.stringify(r)).join("\n")}`);
    for (const row of rows) {
      expect(row.queenLostOnTick !== null || row.flyersLeft === 0, JSON.stringify(row)).toBe(true);
    }
  }, 30_000);
});

describe("accepted-command flyer queen raids", () => {
  function scene(count: number, fromHome: boolean, attackTileX = 16): SimState {
    const state = match();
    for (const colony of [0, 1] as const) state.agents.push({
      id: colony === 1 ? "raider" : "defender", colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: T0 - 100, lastCommandTick: T0 - 100,
      joinedTick: T0 - 100, idle: false, pendingEvents: [],
    });
    for (let i = 0; i < count; i++) {
      const ant = flyer(state, 1, attackTileX + 6, 49);
      if (fromHome) { ant.x = queenOf(state, 1).queenX; ant.y = queenOf(state, 1).queenY; }
    }
    return state;
  }
  const liveAdvance: typeof step = (state, inputs = []) => advance(state, inputs, undefined, undefined, undefined, false, true);
  function attack(state: SimState, count: number, tick: typeof step, tileX = 16): void {
    let current = state, takeoffs = 0, landings = 0;
    for (let n = 0; n < 300; n++) {
      const out = tick(current, n === 0 ? [{ type: "count_mark", agentId: "raider", verb: "ATTACK",
        tileX, tileY: 49, count, caste: "flyer" }] : []);
      if (n === 0) expect(out.results[0]?.ok).toBe(true);
      current = out.state;
      takeoffs += out.events.filter(e => e.type === "flyer_takeoff").length;
      landings += out.events.filter(e => e.type === "flyer_landing").length;
      if (current.colonies[0].queens![0]!.lostTick !== null || !current.ants.some(a => a.colony === 1)) break;
    }
    expect(takeoffs).toBe(count);
    expect(landings).toBe(count);
    expect(current.colonies[0].queens![0]!.lostTick !== null || !current.ants.some(a => a.colony === 1)).toBe(true);
  }
  for (const tileX of [16, 18]) {
    it.each(["step", "advance"] as const)(`ten flyers finish the unguarded raid through %s with the mark at (${tileX},49)`, mode => {
      attack(scene(10, false, tileX), 10, mode === "step" ? step : liveAdvance, tileX);
    });
  }
  it("thirteen flyers flown from home by accepted commands finish the raid", () => {
    let state = scene(13, true), markId: number | undefined;
    for (const tileX of [101, 91, 81, 71, 61, 51, 41, 31, 21]) {
      for (let n = 0; n < 100; n++) {
        const out = liveAdvance(state, n === 0 ? [{ type: "count_mark", agentId: "raider", verb: "GATHER",
          tileX, tileY: 49, count: 13, caste: "flyer", ...(markId === undefined ? {} : { markId }) }] : []);
        if (n === 0) expect(out.results[0]?.ok).toBe(true);
        state = out.state;
        markId = state.marks[0]!.id;
      }
    }
    const out = liveAdvance(state, [{ type: "count_mark", agentId: "raider", verb: "REMOVE", count: 0, markId }]);
    expect(out.results[0]?.ok).toBe(true);
    state = out.state;
    for (let n = 1; n < 100; n++) state = liveAdvance(state).state;
    attack(state, 13, liveAdvance);
  }, 30_000);
});

describe("test plan check 2: air and ground separation", () => {
  /** n against m airborne flyers, all on one tile. */
  function airFight(n: number, m: number, owner: ColonyId | -1) {
    const state = match();
    owned(state, 70, 20, 70, 20, owner);
    const a = Array.from({ length: n }, () => flyer(state, 0, 70, 20, hover(70, 20)));
    const b = Array.from({ length: m }, () => flyer(state, 1, 70, 20, hover(70, 20)));
    const f = fight(state, 30, undefined, () => alive(state, a).length === 0 || alive(state, b).length === 0);
    return { state, a, b, f };
  }
  it("one against one in the air: both die on tick 4, on neutral ground or with one on its own ground", () => {
    for (const owner of [-1, 0] as const) {
      const { a, b, f } = airFight(1, 1, owner);
      expect(f.died.get(a[0]!.id)).toBe(4);
      expect(f.died.get(b[0]!.id)).toBe(4);
    }
  });
  it("4 against 4 in the air: both flocks destroyed, the last on tick 9", () => {
    const { state, a, b, f } = airFight(4, 4, -1);
    expect(state.ants).toHaveLength(0);
    expect(Math.max(lastDeath(f, a), lastDeath(f, b))).toBe(9);
  });
  it("5 against 4 in the air: the 4 are dead on tick 5; 3 survive, one at 1 HP", () => {
    const { state, a, b, f } = airFight(5, 4, -1);
    expect(lastDeath(f, b)).toBe(5);
    const survivors = alive(state, a);
    expect(survivors).toHaveLength(3);
    expect(survivors.map((s) => s.hp).sort((x, y) => x - y)).toEqual([1000, 2000, 2000]);
  });
  it("a landed flyer against a worker on the worker's ground: the flyer kills it on tick 4; the worker alone would need 16 ticks", () => {
    const state = match();
    owned(state, 60, 30, 61, 30, 0);
    const w = worker(state, 0, 60, 30), f1 = flyer(state, 1, 61, 30);
    const f = fight(state, 4);
    expect(f.died.get(w.id)).toBe(4);
    expect(FLYER_HP - f1.hp).toBe(4 * 125);
    expect(Math.ceil(FLYER_HP / 125)).toBe(16);
  });
  it("a landed flyer against a soldier on the soldier's ground: the soldier kills it on tick 6; the flyer alone would need 20 ticks", () => {
    const state = match();
    owned(state, 60, 30, 61, 30, 0);
    const s = soldier(state, 0, 60, 30), f1 = flyer(state, 1, 61, 30);
    expect(s.hp).toBe(SOLDIER_HP);
    const f = fight(state, 6);
    expect(f.died.get(f1.id)).toBe(6);
    expect(SOLDIER_HP - s.hp).toBe(6 * 500);
    expect(Math.ceil(SOLDIER_HP / 500)).toBe(20);
  });
  it("landed flyers beside a queen with no other ant: one flyer dies every 2nd tick", () => {
    const state = match(), q = queenTile(state, 0);
    owned(state, q.x - 1, q.y - 1, q.x + 1, q.y + 1, 0);
    const flyers = around(q.x, q.y).slice(0, 4).map((t) => flyer(state, 1, t.x, t.y));
    const f = fight(state, 8);
    expect(flyers.map((a) => f.died.get(a.id))).toEqual([2, 4, 6, 8]);
  });
  it("an airborne enemy flyer over a worker and beside its queen deals and takes no damage; landed on the same tile it dies on tick 2", () => {
    for (const airborne of [true, false]) {
      const state = match(), q = queenTile(state, 0);
      owned(state, q.x - 2, q.y - 2, q.x + 2, q.y + 2, 0);
      const w = worker(state, 0, q.x + 1, q.y);
      const f1 = flyer(state, 1, q.x + 1, q.y, airborne ? hover(q.x + 1, q.y) : undefined);
      const queen = queenOf(state, 0), queenBefore = queen.hp;
      const f = fight(state, airborne ? 20 : 2);
      if (airborne) {
        expect([f1.hp, w.hp, queen.hp]).toEqual([FLYER_HP, 2000, queenBefore]);
        expect(f.events.filter((e) => e.type === "fight")).toEqual([]);
      } else {
        // Positive control: the queen and the worker hit the flyer for 1.125 HP a tick while it bites the worker.
        expect(f.died.get(f1.id)).toBe(2);
        expect(w.hp).toBe(1000);
        expect(queen.hp).toBe(queenBefore);
      }
    }
  });
});

describe("airborne flyers fight only airborne flyers", () => {
  it("bite the lowest-health airborne enemy flyer in reach, lowest id on ties, and none out of reach", () => {
    const state = match();
    const biter = flyer(state, 0, 40, 20, flying(50, 20), 1_000_000);
    const far = flyer(state, 1, 43, 20, hover(43, 20), 500);
    const tiedLow = flyer(state, 1, 38, 18, hover(38, 18), 1500);
    const tiedHigh = flyer(state, 1, 42, 22, hover(42, 22), 1500);
    const strong = flyer(state, 1, 41, 21, hover(41, 21), 1800);
    expect(tiedLow.id).toBeLessThan(tiedHigh.id);
    const ground = worker(state, 1, 40, 20);
    ground.hp = 100;
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), T0, events);
    expect(tiedLow.hp).toBe(1000);
    expect([far.hp, tiedHigh.hp, strong.hp, ground.hp]).toEqual([500, 1500, 1800, 100]);
    expect(events.find((e) => e.type === "fight" && e.antId === biter.id)).toMatchObject({ targetId: tiedLow.id, air: true });
  });
  it("keep to their flight or hover: combat changes neither position nor flight", () => {
    const state = match();
    const a = flyer(state, 0, 40, 20, flying(50, 20)), b = flyer(state, 1, 41, 20, hover(41, 20));
    const before = [a, b].map((x) => ({ x: x.x, y: x.y, air: x.air }));
    fight(state, 2);
    expect([a, b].map((x) => ({ x: x.x, y: x.y, air: x.air }))).toEqual(before);
    expect(a.air).toBe(before[0]!.air);
  });
  it("a landed flyer bites the lowest-health enemy ground ant, not an airborne flyer, and a ground fight has no air flag", () => {
    const state = match();
    const landed = flyer(state, 0, 40, 20, undefined, 1_000_000);
    const above = flyer(state, 1, 40, 20, hover(40, 20), 100);
    const w = worker(state, 1, 41, 20);
    const events: SimEvent[] = [];
    resolveCombat(state, buildGrid(state), T0, events);
    expect(above.hp).toBe(100);
    expect(w.hp).toBe(2000 - 500);
    const bite = events.find((e) => e.type === "fight" && e.antId === landed.id);
    expect(bite).toMatchObject({ targetId: w.id });
    expect(bite).not.toHaveProperty("air");
  });
  it("leaves the air fight on the tick it lands and joins it on the tick it takes off", () => {
    const state = match();
    const lander = flyer(state, 0, 40, 20, hover(40, 20), 1_000_000);
    const enemyAir = flyer(state, 1, 40, 20, hover(40, 20), 1_000_000);
    const enemyGround = worker(state, 1, 41, 20);
    enemyGround.hp = 1_000_000;
    const hp = () => [lander.hp, enemyAir.hp, enemyGround.hp];
    fight(state, 1);
    expect(hp()).toEqual([1_000_000 - 500, 1_000_000 - 500, 1_000_000]);
    // Lands before combat on fight tick 2: from that tick it is a ground ant.
    delete lander.air;
    fight(state, 1);
    expect(hp()).toEqual([1_000_000 - 500 - 100, 1_000_000 - 500, 1_000_000 - 500]);
    // Takes off before combat on fight tick 3: from that tick it is in the air fight again.
    lander.air = flying(60, 20);
    fight(state, 1);
    expect(hp()).toEqual([1_000_000 - 1000 - 100, 1_000_000 - 1000, 1_000_000 - 500]);
  });
  it("a dead flyer leaves 1 corpse food on its tile, in the air and landed", () => {
    for (const airborne of [true, false]) {
      const state = match();
      const victim = flyer(state, 1, 50, 30, airborne ? hover(50, 30) : undefined, 400);
      flyer(state, 0, 51, 30, airborne ? hover(51, 30) : undefined, 1_000_000);
      const i = tileIndex(state.config, 50, 30), food = state.food[i]!;
      const f = fight(state, 1);
      expect(f.died.get(victim.id)).toBe(1);
      expect(state.config.corpseFood).toBe(1);
      expect(state.food[i]! - food).toBe(1);
    }
  });
  it("credits an air kill to the killer's mark and the loss to the victim's", () => {
    const state = match();
    const mark = (colony: ColonyId): Mark => ({ id: state.nextMarkId++, agentId: `seat${colony}`, colony, tileX: 50, tileY: 30,
      words: [], laidTick: T0, steering: 0, verb: "GATHER", count: 1 });
    const own = mark(0), theirs = mark(1);
    state.marks.push(own, theirs);
    flyer(state, 0, 51, 30, hover(51, 30), 1_000_000).claim = own.id;
    flyer(state, 1, 50, 30, hover(50, 30), 400).claim = theirs.id;
    fight(state, 1);
    expect(own.enemiesKilled).toBe(1);
    expect(theirs.antsLost).toBe(1);
  });
  it("do not stop a queen recovering health, while a landed flyer in the same place does", () => {
    for (const airborne of [true, false]) {
      const state = match(), q = queenTile(state, 0), queen = queenOf(state, 0), rules = state.config.queenHp!;
      queen.hp = 50_000;
      queen.regenFromTick = T0;
      // Within her recovery range but beyond combat reach, so no bite either way.
      const f1 = flyer(state, 1, q.x + 4, q.y, airborne ? hover(q.x + 4, q.y) : undefined);
      expect(rules.regenClearTiles).toBeGreaterThanOrEqual(4);
      fight(state, rules.regenIntervalTicks + 1);
      expect(f1.hp).toBe(FLYER_HP);
      expect(queen.hp).toBe(airborne ? 50_000 + rules.regenHp : 50_000);
    }
  });
});

describe("airborne flyers take no part in territory", () => {
  it("hold no tile they fly over, while a landed flyer takes it", () => {
    for (const airborne of [true, false]) {
      const state = match();
      owned(state, 80, 30, 80, 30, -1);
      flyer(state, 1, 80, 30, airborne ? hover(80, 30) : undefined);
      updateTerritory(state, undefined, T0);
      expect(state.owner[tileIndex(state.config, 80, 30)]).toBe(airborne ? -1 : 1);
    }
  });
  it("refresh no tile of their own colony, which decays beneath them, while a landed flyer keeps it", () => {
    for (const airborne of [true, false]) {
      const state = match(), i = tileIndex(state.config, 80, 30);
      setOwner(state, 80, 30, 1);
      state.lastVisit[i] = T0 - state.config.territoryDecayTicks;
      flyer(state, 1, 80, 30, airborne ? hover(80, 30) : undefined);
      updateTerritory(state, undefined, T0);
      expect([state.owner[i], state.lastVisit[i]]).toEqual(airborne ? [-1, T0 - state.config.territoryDecayTicks] : [1, T0]);
    }
  });
  it("lock no tile beside them, while a landed flyer there locks it", () => {
    for (const airborne of [true, false]) {
      const state = match(), i = tileIndex(state.config, 80, 30);
      setOwner(state, 80, 30, 1);
      state.lastVisit[i] = T0;
      worker(state, 0, 80, 30);
      flyer(state, 1, 81, 30, airborne ? hover(81, 30) : undefined);
      updateTerritory(state, undefined, T0 + 1);
      expect(state.owner[i]).toBe(airborne ? 0 : 1);
    }
  });
});

describe("test plan check 8: patrol, line and hover flyers fight only in the air", () => {
  /**
   * Colony 0's patrol flyer sweeping a leg, GATHER hoverer and LINE of 3, and colony 1's flyers crossing the
   * other way, scripted at the combat step; optionally over ground ants of both sides beneath the whole path.
   */
  function scene(withFlyers: boolean, withGround: boolean) {
    const state = match(), row = 40, speed = (FLYER_RULES.speedTilesPerSecond * SUB) / state.config.ticksPerSecond;
    owned(state, 30, row - 4, 70, row + 4, 0);
    const ours: Ant[] = [], crossing: Ant[] = [], ground: Ant[] = [];
    if (withFlyers) {
      ours.push(flyer(state, 0, 30, row, flying(70, row), 1_000_000), flyer(state, 0, 50, row, hover(50, row), 1_000_000),
        ...[44, 46, 48].map((x) => flyer(state, 0, x, row + 2, hover(x, row + 2), 1_000_000)));
      crossing.push(flyer(state, 1, 70, row, flying(30, row), 1_000_000), flyer(state, 1, 70, row + 1, flying(30, row + 1), 1_000_000));
    }
    if (withGround) {
      for (let x = 30; x <= 70; x += 4) ground.push(addAnt(state, 0, x, row + 1, { hp: 1_000_000 }), addAnt(state, 1, x, row - 1, { hp: 1_000_000 }));
    }
    const patrol = ours[0];
    const f = fight(state, 50, () => {
      if (patrol !== undefined) patrol.x = Math.min(tileCentre(70), patrol.x + speed);
      for (const c of crossing) c.x = Math.max(tileCentre(30), c.x - speed);
    });
    const fights = f.events.filter((e): e is Extract<SimEvent, { type: "fight" }> => e.type === "fight");
    return { ours, crossing, ground, fights };
  }
  it("bite airborne enemies in passing, and nothing on the ground hits or is hit by them", () => {
    const both = scene(true, true), airOnly = scene(true, false), groundOnly = scene(false, true);
    const airIds = new Set([...both.ours, ...both.crossing].map((a) => a.id));
    // Patrol, hover and line flyers each bit a crossing enemy flyer in passing, with the air flag.
    for (const a of both.ours) expect(both.fights.some((e) => e.antId === a.id && e.air === true && both.crossing.some((c) => c.id === e.targetId))).toBe(true);
    // Every fight is air to air with the air flag, or ground to ground without it.
    for (const e of both.fights) expect([airIds.has(e.antId), airIds.has(e.targetId), e.air ?? false]).toEqual(airIds.has(e.antId) ? [true, true, true] : [false, false, false]);
    // The flyers' fight is exactly what it is with no ground beneath, and the ground's exactly what it is with no flyers above.
    expect([...both.ours, ...both.crossing].map((a) => a.hp)).toEqual([...airOnly.ours, ...airOnly.crossing].map((a) => a.hp));
    expect(both.ground.map((a) => a.hp)).toEqual(groundOnly.ground.map((a) => a.hp));
    // Combat was live on the ground too.
    expect(groundOnly.ground.some((a) => a.hp < 1_000_000)).toBe(true);
  });
});

describe("test plan check 8: cover, pinned geometry", () => {
  /**
   * Colony A (0) owns every tile within 2 rows of the path, from 6 tiles before the hoverers' tile to 12 past it.
   * Colony B's (1) 14 airborne raiders start on one tile at the centre of the tile 6 before the hoverers' tile and
   * fly straight along that row at 8 tiles a second toward the tile 12 past it; colony A's hoverers are airborne
   * over their tiles. Flight tick k moves the raid, then runs combat.
   */
  function cover(hoverTiles: readonly number[]) {
    const state = match(), H = 60, row = 30, speed = (FLYER_RULES.speedTilesPerSecond * SUB) / state.config.ticksPerSecond;
    owned(state, H - 6, row - 2, H + 12, row + 2, 0);
    const hoverers = hoverTiles.map((dx) => flyer(state, 0, H + dx, row, hover(H + dx, row)));
    const raiders = Array.from({ length: 14 }, () => flyer(state, 1, H - 6, row, flying(H + 12, row)));
    const start = tileCentre(H - 6), end = tileCentre(H + 12);
    const inReach: number[] = [];
    const f = fight(state, 22, (k) => {
      for (const r of raiders) r.x = Math.min(end, start + speed * k);
      if (Math.abs(Math.floor((start + speed * k) / SUB) - H) <= gridScaleOf(state.config)) inReach.push(k);
    });
    const deathTicks = (ants: readonly Ant[]) => ants.map((a) => f.died.get(a.id)).filter((k): k is number => k !== undefined).sort((x, y) => x - y);
    return { state, hoverers, raiders, f, inReach, deathTicks };
  }
  it("the raid is in reach of the hoverers' tile on its 5th to 10th ticks of flight", () => {
    expect(cover([0, 0]).inReach).toEqual([5, 6, 7, 8, 9, 10]);
  });
  it("2 on one tile: the raid loses none, its lead flyer left at 0.125 HP; hoverers die on the 5th and 6th ticks", () => {
    const { raiders, hoverers, deathTicks } = cover([0, 0]);
    expect(deathTicks(raiders)).toEqual([]);
    expect(raiders[0]!.hp).toBe(125);
    expect(raiders.slice(1).every((r) => r.hp === FLYER_HP)).toBe(true);
    expect(deathTicks(hoverers)).toEqual([5, 6]);
  });
  it("2 apart, one there and one 4 tiles further: the raid loses none, lead flyer at 0.75 HP; hoverers die on the 5th and 10th ticks", () => {
    const { raiders, hoverers, deathTicks } = cover([0, 4]);
    expect(deathTicks(raiders)).toEqual([]);
    expect(raiders[0]!.hp).toBe(750);
    expect(deathTicks(hoverers)).toEqual([5, 10]);
  });
  it("3 on one tile: the raid loses 1 on the 6th tick, next flyer at 1.375 HP; all 3 hoverers dead by the 7th tick", () => {
    const { raiders, hoverers, deathTicks } = cover([0, 0, 0]);
    expect(deathTicks(raiders)).toEqual([6]);
    expect(raiders[1]!.hp).toBe(1375);
    expect(deathTicks(hoverers)).toEqual([5, 6, 7]);
  });
  it("8 on one tile: the raid loses one a tick on the 5th to 9th ticks, a 6th left at 0.125 HP; hoverers die one a tick on the 5th to 10th, 2 survive", () => {
    const { state, raiders, hoverers, deathTicks } = cover([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(deathTicks(raiders)).toEqual([5, 6, 7, 8, 9]);
    expect(raiders[5]!.hp).toBe(125);
    expect(deathTicks(hoverers)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(hoverers.filter((h) => state.ants.includes(h))).toHaveLength(2);
  });
});
