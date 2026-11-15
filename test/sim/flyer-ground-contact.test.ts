import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { buildGrid, verifyGridSyncs } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, ColonyId, Mark, SimEvent, SimState } from "../../src/sim/types.js";
import { takeView } from "../../src/sim/view.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";

// Ground ants and airborne flyers cannot fight each other, so an enemy flyer in the air is no ground ant's
// contact, pursuit target or strength, through the whole step. Each scene runs three ways: an enemy flyer
// hovering on a GATHER mark, no flyer at all, and the same flyer landed. The ground ant does exactly what it
// does with no flyer when the flyer is in the air, and stops for it or goes for it once it has landed.
// Served rules-28 configuration, open ground with no food, combat live and no hatching.
const config: SimConfig = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0, terrain: undefined, foodLayout: undefined,
  foodPatches: [], earlyWin: undefined };
const START = Math.max(config.combatGraceTicks, config.queenHp!.shieldTicks);
const TICKS = 8;
const ROW = 30;

// The tick's grid is synced to the ground ants for planning and to every ant for combat: each sync must equal a fresh build.
beforeEach(() => verifyGridSyncs(true));
afterEach(() => verifyGridSyncs(false));

type Enemy = "hover" | "none" | "landed";

function seat(id: string, colony: ColonyId): Agent {
  return { id, colony, joinSeq: colony, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" },
    lastCallTick: START, lastCommandTick: START, idle: false, pendingEvents: [] };
}

function scene(): SimState {
  const state = emptyMatch(START, config);
  state.food.fill(0);
  for (const colony of state.colonies) colony.foodStore = 0;
  state.agents.push(seat("a", 0), seat("b", 1));
  return state;
}

function mark(state: SimState, colony: ColonyId, verb: NonNullable<Mark["verb"]>, tileX: number, tileY: number, caste?: Mark["caste"]): Mark {
  const item: Mark = { id: state.nextMarkId++, agentId: colony === 0 ? "a" : "b", colony, tileX, tileY, words: [], laidTick: START,
    steering: 0, verb, count: 1, revision: 0, ...(caste === undefined ? {} : { caste }) };
  state.marks.push(item);
  return item;
}

/**
 * Colony 1's flyer on tile (tx, ROW): hovering there on its own GATHER mark, absent (its mark still laid), or landed
 * there and locked out for the whole run, holding that tile with no mark.
 */
function enemyFlyer(state: SimState, enemy: Enemy, tx: number): Ant | undefined {
  if (enemy === "landed") {
    return addAnt(state, 1, tx, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, takeOffTick: START + 1000, holdPoint: { tileX: tx, tileY: ROW } });
  }
  const gather = mark(state, 1, "GATHER", tx, ROW, "flyer");
  if (enemy === "none") return undefined;
  return addAnt(state, 1, tx, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, claim: gather.id,
    air: { destX: tileCentre(tx), destY: tileCentre(ROW), hovering: true, released: false } });
}

interface Run { readonly state: SimState; readonly trail: { x: number; y: number }[]; readonly events: SimEvent[] }

/** TICKS steps, the ground ant's position after each. */
function run(state: SimState, ant: Ant): Run {
  const trail: { x: number; y: number }[] = [], events: SimEvent[] = [];
  let current = state;
  for (let i = 0; i < TICKS; i += 1) {
    const out = step(current);
    current = out.state;
    events.push(...out.events);
    const now = antById(current, ant.id);
    if (now === undefined) break;
    trail.push({ x: now.x, y: now.y });
  }
  return { state: current, trail, events };
}

const fightsBetween = (events: readonly SimEvent[], a: Ant, b: Ant) => events.filter((e): e is Extract<SimEvent, { type: "fight" }> =>
  e.type === "fight" && ((e.antId === a.id && e.targetId === b.id) || (e.antId === b.id && e.targetId === a.id)));

/** Plays one ground scene three ways; the scene places colony 0's ground ant and returns it. */
function threeWays(place: (state: SimState) => Ant, flyerTile: number) {
  const ways = {} as Record<Enemy, Run & { ant: Ant; flyer: Ant | undefined }>;
  for (const enemy of ["hover", "none", "landed"] as const) {
    const state = scene();
    const ant = place(state);
    const flyer = enemyFlyer(state, enemy, flyerTile);
    ways[enemy] = { ...run(state, ant), ant, flyer };
  }
  return ways;
}

/** The hover: the ground ant moves exactly as with no flyer, and neither it nor the flyer is bitten or bites. */
function expectUntouched(ways: ReturnType<typeof threeWays>): void {
  const { hover, none } = ways;
  expect(none.trail).toHaveLength(TICKS);
  expect(none.trail.at(-1)).not.toEqual({ x: none.ant.x, y: none.ant.y });
  expect(hover.trail).toEqual(none.trail);
  const flyer = antById(hover.state, hover.flyer!.id)!;
  expect(flyer.air).toEqual(hover.flyer!.air);
  expect(flyer.hp).toBe(hover.flyer!.hp);
  expect(antById(hover.state, hover.ant.id)!.hp).toBe(hover.ant.hp);
  expect(fightsBetween(hover.events, hover.ant, hover.flyer!)).toEqual([]);
}

describe("an airborne enemy flyer is no ground ant's contact, pursuit target or strength, through the step", () => {
  it("an isolated non-carrying worker beneath an enemy GATHER hover goes on exploring; one beside the landed flyer stops and fights it", () => {
    const ways = threeWays((state) => addAnt(state, 0, 60, ROW, { caste: "worker" }), 60);
    expect(antById(ways.none.state, ways.none.ant.id)!.carrying).toBe(false);
    expectUntouched(ways);
    // Landed control: on the first tick it stands to bite instead of exploring, and the two fight on the ground.
    const { landed, none } = ways;
    expect(landed.trail[0]).not.toEqual(none.trail[0]);
    const fights = fightsBetween(landed.events, landed.ant, landed.flyer!);
    expect(fights.filter((e) => e.tick === START).map((e) => e.antId).sort()).toEqual([landed.ant.id, landed.flyer!.id].sort());
    expect(fights.every((e) => e.air === undefined)).toBe(true);
  });

  // PATROL: a two-mark chain, the hover over its far waypoint. ATTACK: the hover over the mark, which the ant
  // walks to within the mark's area (outside it, a claimed ant marches in whatever is in reach).
  const orders = [
    { verb: "PATROL", marks: [64, 58], from: 54, flyerAt: 58 },
    { verb: "ATTACK", marks: [60], from: 56, flyerAt: 60 },
  ] as const;
  for (const { verb, marks, from, flyerAt } of orders) {
    it(`a claimed ground ${verb} ant walks on beneath an enemy hover; it stops at the same flyer landed and fights it`, () => {
      const ways = threeWays((state) => {
        const [first] = marks.map((x) => mark(state, 0, verb, x, ROW));
        return addAnt(state, 0, from, ROW, { caste: "soldier", hp: 10_000, claim: first!.id });
      }, flyerAt);
      expectUntouched(ways);
      const { landed, none } = ways;
      // Landed control: it stops within reach of the landed flyer, short of where it gets with no flyer, and bites it.
      expect(landed.trail.at(-1)!.x).toBeLessThan(none.trail.at(-1)!.x);
      expect(Math.floor(landed.trail.at(-1)!.x / SUB)).toBeLessThan(flyerAt);
      const fights = fightsBetween(landed.events, landed.ant, landed.flyer!);
      expect(fights.some((e) => e.antId === landed.ant.id)).toBe(true);
      expect(fights.every((e) => e.air === undefined)).toBe(true);
    });
  }

  it("a free seated soldier holds its point under an enemy hover in its sight; it pursues the same flyer landed", () => {
    const ways = threeWays((state) => addAnt(state, 0, 60, ROW, { caste: "soldier", hp: 10_000, holdPoint: { tileX: 60, tileY: ROW } }), 65);
    const { hover, none, landed } = ways;
    // With no flyer, a soldier on its hold point stays put; so it does under the hover.
    expect(none.trail.every((p) => p.x === none.ant.x && p.y === none.ant.y)).toBe(true);
    expect(hover.trail).toEqual(none.trail);
    expect(antById(hover.state, hover.flyer!.id)!.hp).toBe(hover.flyer!.hp);
    // Landed control: it goes for the flyer.
    expect(landed.trail.at(-1)!.x).toBeGreaterThan(landed.ant.x);
  });

  it("an outnumbered free seated soldier counts only ground enemies: three hovering flyers do not drive it home", () => {
    const play = (enemy: Enemy) => {
      const state = scene();
      const soldier = addAnt(state, 0, 60, ROW, { caste: "soldier", hp: 10_000, holdPoint: { tileX: 60, tileY: ROW } });
      // One enemy worker in sight, which one soldier pushes on.
      addAnt(state, 1, 66, ROW + 3, { caste: "worker" });
      const gather = mark(state, 1, "GATHER", 64, ROW, "flyer");
      gather.count = 3;
      for (let i = 0; i < 3; i += 1) {
        if (enemy === "hover") addAnt(state, 1, 64, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, claim: gather.id,
          air: { destX: tileCentre(64), destY: tileCentre(ROW), hovering: true, released: false } });
        if (enemy === "landed") addAnt(state, 1, 64, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, takeOffTick: START + 1000,
          holdPoint: { tileX: 64, tileY: ROW } });
      }
      return run(state, soldier);
    };
    const hover = play("hover"), none = play("none"), landed = play("landed");
    // Pushing on the lone worker, as with no flyers.
    expect(none.trail.at(-1)!.x).toBeGreaterThan(tileCentre(60));
    expect(hover.trail).toEqual(none.trail);
    // Landed control: four ground enemies outnumber it, and it falls back toward its queen.
    expect(landed.trail.at(-1)!.x).toBeLessThan(tileCentre(60));
  });

  it("a free seated soldier pursuing a landed flyer gives it up the tick after it takes off, for the next ground enemy in its sight", () => {
    const play = (takesOff: boolean) => {
      const state = scene();
      const soldier = addAnt(state, 0, 60, ROW, { caste: "soldier", hp: 10_000, holdPoint: { tileX: 60, tileY: ROW } });
      // A second soldier, so the pair pushes on two enemies.
      addAnt(state, 0, 60, ROW + 1, { caste: "soldier", hp: 10_000, holdPoint: { tileX: 60, tileY: ROW + 1 } });
      // The nearer enemy: a flyer landed 5 tiles east, on a GATHER mark on its own tile, locked out for 3 ticks or the run.
      const gather = mark(state, 1, "GATHER", 65, ROW, "flyer");
      const flyer = addAnt(state, 1, 65, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, claim: gather.id,
        takeOffTick: START + (takesOff ? 3 : 1000), holdPoint: { tileX: 65, tileY: ROW } });
      // The farther one: an enemy worker 7 tiles north.
      addAnt(state, 1, 60, ROW - 7, { caste: "worker" });
      const out = run(state, soldier);
      const air = (out.events.find((e) => e.type === "flyer_takeoff" && e.antId === flyer.id)?.tick ?? Infinity) - START;
      return { ...out, air };
    };
    const lifted = play(true), stays = play(false);
    // Both pursue the landed flyer east until it takes off.
    expect(lifted.air).toBe(3);
    expect(lifted.trail.slice(0, 4)).toEqual(stays.trail.slice(0, 4));
    expect(lifted.trail[3]!.x).toBeGreaterThan(tileCentre(60));
    // Then the one whose flyer is in the air turns north for the worker, while the other keeps on east.
    for (let i = 4; i < TICKS; i += 1) {
      expect(lifted.trail[i]!.y).toBeLessThan(lifted.trail[i - 1]!.y);
      expect(stays.trail[i]!.x).toBeGreaterThan(stays.trail[i - 1]!.x);
    }
  });
});

describe("an agent's squad beneath an enemy hover is not fighting", () => {
  it("its order status counts no ant fighting under the hover, and one beside the same flyer landed", () => {
    const status = (enemy: Enemy) => {
      const state = scene();
      const agent = state.agents[0]!;
      const ant = addAnt(state, 0, 60, ROW, { caste: "worker", squad: agent.id });
      agent.squad = [ant.id];
      enemyFlyer(state, enemy, 60);
      return takeView(state, buildGrid(state), agent).orderStatus;
    };
    expect(status("none")).toBe("holding");
    expect(status("hover")).toBe("holding");
    expect(status("landed")).toBe("holding; 1 fighting");
  });
});

describe("on the tick a flyer lands or takes off, a claimed ground ant reads the ground as the flight left it", () => {
  // A PATROL soldier at the east edge of tile 62, walking east along its chain, two tiles from an enemy flyer on tile 60.
  type Flyer = "none" | "landed" | "landing" | "taking off";
  const play = (flyer: Flyer) => {
    const state = scene();
    const [first] = [66, 58].map((x) => mark(state, 0, "PATROL", x, ROW));
    const soldier = addAnt(state, 0, 62, ROW, { x: 62 * SUB + 990, caste: "soldier", hp: 10_000, claim: first!.id });
    let enemy: Ant | undefined;
    // Landing: a hoverer whose order has ended, which lands on its tile in the first tick's flight pass.
    if (flyer === "landing") enemy = addAnt(state, 1, 60, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp,
      air: { destX: tileCentre(60), destY: tileCentre(ROW), hovering: true, released: true } });
    if (flyer === "landed") enemy = enemyFlyer(state, "landed", 60);
    // Taking off: landed, its lockout over, on a GATHER mark over its own tile, so it rises to hover there in the first tick.
    if (flyer === "taking off") {
      const gather = mark(state, 1, "GATHER", 60, ROW, "flyer");
      enemy = addAnt(state, 1, 60, ROW, { flyer: true, caste: "worker", hp: config.flyers!.hp, claim: gather.id, takeOffTick: START,
        holdPoint: { tileX: 60, tileY: ROW } });
    }
    return { ...run(state, soldier), soldier, enemy };
  };

  it("a flyer landing beside it is a ground enemy that tick: it stays in reach and bites it, as beside a flyer already landed", () => {
    const none = play("none"), landed = play("landed"), landing = play("landing");
    expect(landing.events.some((e) => e.type === "flyer_landing" && e.antId === landing.enemy!.id && e.tick === START)).toBe(true);
    expect(landed.trail[0]).not.toEqual(none.trail[0]);
    expect(landing.trail).toEqual(landed.trail);
    const bites = fightsBetween(landing.events, landing.soldier, landing.enemy!).filter((e) => e.antId === landing.soldier.id);
    expect(bites.map((e) => e.tick)).toContain(START);
    expect(bites.every((e) => e.air === undefined)).toBe(true);
  });

  it("a flyer taking off beside it is out of its reach that tick: it walks on as with no flyer, and neither bites", () => {
    const none = play("none"), rising = play("taking off");
    expect(rising.events.some((e) => e.type === "flyer_takeoff" && e.antId === rising.enemy!.id && e.tick === START)).toBe(true);
    expect(rising.trail).toEqual(none.trail);
    expect(fightsBetween(rising.events, rising.soldier, rising.enemy!)).toEqual([]);
  });
});
