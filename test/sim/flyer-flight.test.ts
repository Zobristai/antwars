import { describe, expect, it } from "vitest";
import { FLYER_RULES, rulesConfig, speedPerTick, SUB, type SimConfig } from "../../src/sim/config.js";
import { flyerState, type FlyerState } from "../../src/sim/flyers.js";
import { flyerLineSpotOf } from "../../src/sim/lineMarks.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, Mark, SimEvent, SimInput, SimState, Terrain } from "../../src/sim/types.js";
import { createVisibility } from "../../src/sim/view.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";

// The flyer test plan's checks 3 to 6, 8 and 9 at engine level: the grid-scale-2 match map at
// 10 ticks/s, combat held off by a long grace so only motion and state are asserted. Coordinates are
// fine tiles of that map; positions are sub-tile units (1000 a tile), so a flight step is 800.
const config: SimConfig = { ...rulesConfig("redesign"), flyers: FLYER_RULES, startAnts: 0, squadSize: 0,
  terrain: undefined, foodLayout: undefined, foodPatches: [], commandFloorTicks: 0, combatGraceTicks: 99_999, earlyWin: undefined };
const START = 100;
const STEP = 800;
const LOCKOUT = FLYER_RULES.lockoutTicks;

function scene(terrain?: Terrain, rules: Partial<SimConfig> = {}): SimState {
  const state = emptyMatch(START, { ...config, ...rules });
  if (terrain !== undefined) (state as { terrain?: Terrain }).terrain = terrain;
  for (const colony of state.colonies) colony.foodStore = 0;
  for (const colony of [0, 1] as const) {
    const agent: Agent = { id: colony === 0 ? "a" : "b", colony, joinSeq: colony, modelLabel: null, parentAgentId: null,
      squad: [], order: { kind: "hold" }, lastCallTick: START, lastCommandTick: START, idle: false, pendingEvents: [] };
    state.agents.push(agent);
  }
  return state;
}
const flyer = (state: SimState, colony: 0 | 1, tx: number, ty: number, patch: Partial<Ant> = {}): number =>
  addAnt(state, colony, tx, ty, { flyer: true, ...patch }).id;
function mark(state: SimState, verb: NonNullable<Mark["verb"]>, tileX: number, tileY: number, options: Partial<Mark> = {}): Mark {
  const item: Mark = { id: state.nextMarkId++, agentId: options.colony === 1 ? "b" : "a", colony: 0, tileX, tileY, words: [],
    laidTick: START, steering: 0, verb, count: 1, revision: 0, caste: "flyer", ...options };
  state.marks.push(item);
  return item;
}
const markOf = (state: SimState, id: number): Mark => state.marks.find((m) => m.id === id)!;
const at = (tx: number, ty: number) => ({ x: tileCentre(tx), y: tileCentre(ty) });
const pos = (ant: Ant) => ({ x: ant.x, y: ant.y });
const tileOfAnt = (ant: Ant) => ({ tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) });
const stateOf = (state: SimState, id: number): FlyerState => flyerState(antById(state, id)!, state.tick - 1)!;

interface Play {
  state: SimState;
  readonly events: SimEvent[];
  /** Each flyer's position after each tick, by tick. */
  readonly trail: Map<number, { x: number; y: number }[]>;
  /** Each flyer's displayed state after each tick. */
  readonly states: Map<number, FlyerState[]>;
}
function play(state: SimState): Play {
  return { state, events: [], trail: new Map(), states: new Map() };
}
/**
 * One tick, then the displayed-state checks every scenario runs on every tick: a flying flyer moved
 * this tick; a hovering one stands on its destination; a grounded or locked-out one has no air; any
 * flyer not flying stands on land, so none ever stops, hovers or lands on water or rock.
 */
function tick(game: Play, inputs: readonly SimInput[] = []): void {
  const before = new Map(game.state.ants.filter((a) => a.flyer === true).map((a) => [a.id, pos(a)]));
  const out = step(game.state, inputs);
  // Every command a scenario sends is one the rules accept.
  for (const result of out.results) expect(result.ok ? null : result.error).toBeNull();
  game.state = out.state;
  game.events.push(...out.events);
  for (const ant of out.state.ants) {
    if (ant.flyer !== true) continue;
    const shown = flyerState(ant, out.state.tick - 1)!;
    (game.trail.get(ant.id) ?? game.trail.set(ant.id, []).get(ant.id)!).push(pos(ant));
    (game.states.get(ant.id) ?? game.states.set(ant.id, []).get(ant.id)!).push(shown);
    const moved = before.get(ant.id) === undefined || before.get(ant.id)!.x !== ant.x || before.get(ant.id)!.y !== ant.y;
    if (shown.state === "flying") expect(moved, `flyer ${ant.id} shown flying without moving at tick ${out.state.tick - 1}`).toBe(true);
    if (shown.state === "hovering") expect(pos(ant)).toEqual({ x: shown.destX, y: shown.destY });
    if (shown.state === "grounded" || shown.state === "lockedOut") expect(ant.air).toBeUndefined();
    if (shown.state === "lockedOut") expect(shown.takeOffTick).toBeGreaterThan(out.state.tick - 1);
    if (shown.state !== "flying") {
      const { tileX, tileY } = tileOfAnt(ant);
      expect(isBlockedTile(out.state.terrain, tileX, tileY), `flyer ${ant.id} stopped over water or rock`).toBe(false);
    }
  }
}
/** The agent's count_mark command: lay a flyer mark, re-lay one (same verb and tile), or move one with markId. */
const command = (verb: string, tileX: number, tileY: number, extra: Partial<Extract<SimInput, { type: "count_mark" }>> = {}): SimInput =>
  ({ type: "count_mark", agentId: "a", verb, tileX, tileY, count: 1, caste: "flyer", ...extra });
const remove = (markId: number): SimInput => ({ type: "count_mark", agentId: "a", verb: "REMOVE", count: 0, markId });
function ticks(game: Play, n: number): void {
  for (let i = 0; i < n; i++) tick(game);
}
const ofType = (events: readonly SimEvent[], type: "flyer_takeoff" | "flyer_landing", antId: number) =>
  events.filter((e) => e.type === type && "antId" in e && e.antId === antId);

describe("flight, landing and lockout", () => {
  it("takes off on its claim tick and flies straight at 0.8 tiles a tick to an ATTACK mark, landing there with its lockout", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    mark(game.state, "ATTACK", 40, 40);
    tick(game);
    expect(ofType(game.events, "flyer_takeoff", id)).toEqual([{ type: "flyer_takeoff", tick: START, tileX: 20, tileY: 40, antId: id, colony: 0 }]);
    expect(stateOf(game.state, id)).toEqual({ state: "flying", destX: tileCentre(40), destY: tileCentre(40) });
    ticks(game, 24);
    const trail = game.trail.get(id)!;
    // 20 tiles at 0.8 tiles a tick: 25 ticks, each exactly one flight step along the row.
    trail.forEach((p, i) => expect(p).toEqual({ x: tileCentre(20) + STEP * (i + 1), y: tileCentre(40) }));
    const landed = START + 24;
    expect(ofType(game.events, "flyer_landing", id)).toEqual([{ type: "flyer_landing", tick: landed, tileX: 40, tileY: 40, antId: id, colony: 0 }]);
    const ant = antById(game.state, id)!;
    expect(ant.air).toBeUndefined();
    expect(ant).toMatchObject({ takeOffTick: landed + LOCKOUT, holdPoint: { tileX: 40, tileY: 40 } });
    expect(stateOf(game.state, id)).toEqual({ state: "lockedOut", takeOffTick: landed + LOCKOUT });
  });

  it("flies a diagonal in a straight line at exactly one flight step a tick", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    mark(game.state, "DEFEND", 36, 52);
    ticks(game, 25);
    // A 16 by 12 tile offset is 20 tiles: 640 across and 480 down every tick, landing on the 25th.
    game.trail.get(id)!.forEach((p, i) => expect(p).toEqual({ x: tileCentre(20) + 640 * (i + 1), y: tileCentre(40) + 480 * (i + 1) }));
    expect(ofType(game.events, "flyer_landing", id)).toHaveLength(1);
  });

  it("crosses water, rock and ants of both sides on exactly the path it flies over open ground", () => {
    const obstacles: Terrain = { mapId: "test", mapName: "test",
      water: [{ x: 24, y: 30, width: 4, height: 20 }], rocks: [{ x: 31, y: 30, width: 3, height: 20, appearance: 0 }] };
    const run = (terrain: Terrain | undefined, ants: boolean) => {
      const game = play(scene(terrain));
      const id = flyer(game.state, 0, 20, 40);
      if (ants) for (const x of [22, 30, 35, 38]) { addAnt(game.state, 0, x, 40); addAnt(game.state, 1, x, 41); }
      mark(game.state, "ATTACK", 40, 40);
      ticks(game, 25);
      return { trail: game.trail.get(id)!, game, id };
    };
    const open = run(undefined, false), crossing = run(obstacles, true);
    expect(crossing.trail).toEqual(open.trail);
    // Over water and rock on the way, and landed on the land tile it was sent to.
    expect(crossing.trail.some((p) => isBlockedTile(obstacles, Math.floor(p.x / SUB), Math.floor(p.y / SUB)))).toBe(true);
    expect(tileOfAnt(antById(crossing.game.state, crossing.id)!)).toEqual({ tileX: 40, tileY: 40 });
  });

  it("re-tasked at landing tick T+29 it stays down; at T+30 it takes off, by a moved mark or a new mark", () => {
    for (const retask of ["moved", "new"] as const) {
      const game = play(scene());
      const id = flyer(game.state, 0, 38, 40);
      const first = mark(game.state, "ATTACK", 40, 40);
      ticks(game, 3);
      const landed = ofType(game.events, "flyer_landing", id)[0]!.tick;
      while (game.state.tick < landed + 29) tick(game);
      tick(game, retask === "moved" ? [command("ATTACK", 40, 50, { markId: first.id })]
        : [remove(first.id), command("ATTACK", 40, 50)]);
      expect(antById(game.state, id)!.air, retask).toBeUndefined();
      expect(ofType(game.events, "flyer_takeoff", id).map((e) => e.tick), retask).toEqual([START]);
      expect(stateOf(game.state, id), retask).toEqual({ state: "lockedOut", takeOffTick: landed + LOCKOUT });
      tick(game);
      expect(ofType(game.events, "flyer_takeoff", id).map((e) => e.tick), retask).toEqual([START, landed + LOCKOUT]);
      expect(stateOf(game.state, id), retask).toMatchObject({ state: "flying", destX: tileCentre(40), destY: tileCentre(50) });
      expect(antById(game.state, id)!.takeOffTick, retask).toBe(landed + LOCKOUT);
    }
  });

  it("waits where it stands while locked out when a moved or new mark re-tasks it, never walking that order, and flies at its take-off tick", () => {
    for (const retask of ["moved ATTACK", "new ATTACK", "new DEFEND", "new GATHER", "new PATROL"] as const) {
      const game = play(scene());
      const id = flyer(game.state, 0, 38, 40);
      const first = mark(game.state, "ATTACK", 40, 40);
      ticks(game, 3);
      const landed = ofType(game.events, "flyer_landing", id)[0]!.tick;
      // Re-tasked on the tick after it landed, 10 tiles away.
      while (game.state.tick < landed + 1) tick(game);
      const waiting = pos(antById(game.state, id)!);
      const verb = retask.split(" ")[1]!;
      tick(game, retask === "moved ATTACK" ? [command("ATTACK", 40, 50, { markId: first.id })] : [remove(first.id), command(verb, 40, 50)]);
      const next = retask === "moved ATTACK" ? first.id : game.state.marks.at(-1)!.id;
      for (;;) {
        const ant = antById(game.state, id)!;
        expect(ant.claim, retask).toBe(next);
        expect(pos(ant), `${retask}: moved on the ground at tick ${game.state.tick - 1}`).toEqual(waiting);
        expect(stateOf(game.state, id), retask).toEqual({ state: "lockedOut", takeOffTick: landed + LOCKOUT });
        if (game.state.tick >= landed + LOCKOUT) break;
        tick(game);
      }
      tick(game);
      const off = ofType(game.events, "flyer_takeoff", id);
      expect(off.map((e) => e.tick), retask).toEqual([START, landed + LOCKOUT]);
      expect(off[1], retask).toMatchObject({ tileX: Math.floor(waiting.x / SUB), tileY: Math.floor(waiting.y / SUB) });
      expect(stateOf(game.state, id), retask).toMatchObject({ state: "flying", destX: tileCentre(40), destY: tileCentre(50) });
      for (let i = 0; i < 20 && stateOf(game.state, id).state === "flying"; i++) tick(game);
      expect(pos(antById(game.state, id)!), retask).toEqual(at(40, 50));
    }
  });

  it("stays down on its ATTACK mark once landed: no second take-off while the mark stands still", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 38, 40);
    mark(game.state, "ATTACK", 40, 40);
    ticks(game, 80);
    expect(ofType(game.events, "flyer_takeoff", id)).toHaveLength(1);
    expect(ofType(game.events, "flyer_landing", id)).toHaveLength(1);
    expect(stateOf(game.state, id)).toEqual({ state: "grounded" });
  });

  it("takes off again when its landed ATTACK mark is re-cast away and back: the same mark on the same tile is a new order", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 38, 40);
    const attack = mark(game.state, "ATTACK", 40, 40);
    ticks(game, 3);
    const landed = ofType(game.events, "flyer_landing", id)[0]!.tick;
    while (game.state.tick < landed + LOCKOUT + 5) tick(game);
    expect(stateOf(game.state, id)).toEqual({ state: "grounded" });
    tick(game, [command("ATTACK", 40, 40, { caste: "soldier" })]);
    expect(antById(game.state, id)!.claim).toBeUndefined();
    const recast = game.state.tick;
    tick(game, [command("ATTACK", 40, 40)]);
    expect(markOf(game.state, attack.id)).toMatchObject({ caste: "flyer", tileX: 40, tileY: 40 });
    expect(antById(game.state, id)!.claim).toBe(attack.id);
    expect(ofType(game.events, "flyer_takeoff", id).map((e) => e.tick)).toEqual([START, recast]);
    // Already over the tile, it lands on it at once, and that landing starts a new lockout.
    expect(ofType(game.events, "flyer_landing", id).map((e) => e.tick)).toEqual([landed, recast]);
    expect(stateOf(game.state, id)).toEqual({ state: "lockedOut", takeOffTick: recast + LOCKOUT });
  });

  it("turns airborne members of a moved mark toward its new tile at once without landing", () => {
    for (const verb of ["ATTACK", "GATHER"] as const) {
      const game = play(scene());
      const id = flyer(game.state, 0, 20, 40);
      const m = mark(game.state, verb, verb === "GATHER" ? 24 : 40, 40);
      ticks(game, 6);
      if (verb === "GATHER") expect(stateOf(game.state, id).state).toBe("hovering");
      const from = pos(antById(game.state, id)!);
      tick(game, [command(verb, 30, 48, { markId: m.id })]);
      expect(markOf(game.state, m.id)).toMatchObject({ tileX: 30, tileY: 48, laidTick: START, revision: 1 });
      const now = antById(game.state, id)!;
      // One flight step straight at the new tile's centre.
      const to = at(30, 48), d = Math.hypot(to.x - from.x, to.y - from.y);
      expect(Math.abs(now.x - from.x - (to.x - from.x) * STEP / d)).toBeLessThanOrEqual(1);
      expect(Math.abs(now.y - from.y - (to.y - from.y) * STEP / d)).toBeLessThanOrEqual(1);
      expect(stateOf(game.state, id)).toEqual({ state: "flying", destX: to.x, destY: to.y });
      expect(ofType(game.events, "flyer_landing", id), verb).toEqual([]);
      expect(now.takeOffTick, verb).toBeUndefined();
    }
  });

  it("turns a PATROL flyer toward its own mark's new tile at once when the move keeps the chain, under the served command floor", () => {
    const floor = rulesConfig("redesign").commandFloorTicks;
    expect(floor).toBe(100);
    const game = play(scene(undefined, { commandFloorTicks: floor }));
    // The owner's last command was 96 ticks before the scene starts: the move at START+4 is the first one the floor allows.
    game.state.agents.find((agent) => agent.id === "a")!.lastCommandTick = START + 4 - floor;
    const a = mark(game.state, "PATROL", 20, 40, { laidTick: START - 2 });
    const b = mark(game.state, "PATROL", 30, 40, { laidTick: START - 1 });
    const id = flyer(game.state, 0, 20, 40, { claim: a.id });
    ticks(game, 4);
    const from = pos(antById(game.state, id)!);
    expect(from).toEqual({ x: tileCentre(20) + 4 * STEP, y: tileCentre(40) });
    expect(antById(game.state, id)!.patrolWaypoint).toBe(b.id);
    // Its own mark moves 4 tiles south; still within linking range of b, so the chain keeps both marks.
    tick(game, [command("PATROL", 20, 44, { markId: a.id })]);
    expect(markOf(game.state, a.id)).toMatchObject({ tileX: 20, tileY: 44, laidTick: START - 2, revision: 1 });
    const now = antById(game.state, id)!;
    expect(now.patrolWaypoint).toBe(a.id);
    // One flight step straight at the moved mark's tile centre, airborne.
    const to = at(20, 44), d = Math.hypot(to.x - from.x, to.y - from.y);
    expect(Math.abs(now.x - from.x - (to.x - from.x) * STEP / d)).toBeLessThanOrEqual(1);
    expect(Math.abs(now.y - from.y - (to.y - from.y) * STEP / d)).toBeLessThanOrEqual(1);
    expect(stateOf(game.state, id)).toEqual({ state: "flying", destX: to.x, destY: to.y });
    // Then on round the same chain, airborne: the moved mark first, then b, then back, never landing or locking out.
    const visits: number[] = [];
    for (let i = 0; i < 40; i++) {
      tick(game);
      const ant = antById(game.state, id)!;
      expect(stateOf(game.state, id).state).toBe("flying");
      const on = [a, b].map((m) => markOf(game.state, m.id)).find((m) => ant.x === tileCentre(m.tileX) && ant.y === tileCentre(m.tileY));
      if (on !== undefined) visits.push(on.id);
    }
    expect(visits.slice(0, 3)).toEqual([a.id, b.id, a.id]);
    expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
    expect(antById(game.state, id)!.takeOffTick).toBeUndefined();
  });

  it("walks and chases at the ants' one speed after landing on ATTACK, and holds its mark after landing on DEFEND", () => {
    const attack = play(scene());
    const chaser = flyer(attack.state, 0, 38, 40);
    mark(attack.state, "ATTACK", 40, 40);
    const enemy = addAnt(attack.state, 1, 44, 40).id;
    ticks(attack, 3);
    const landed = pos(antById(attack.state, chaser)!);
    expect(landed).toEqual(at(40, 40));
    tick(attack);
    const ant = antById(attack.state, chaser)!, foe = antById(attack.state, enemy)!;
    expect(ant.air).toBeUndefined();
    // A ground step at the ants' speed, toward the enemy it chases.
    expect(Math.round(Math.hypot(ant.x - landed.x, ant.y - landed.y))).toBe(speedPerTick(attack.state.config));
    expect(Math.hypot(foe.x - ant.x, foe.y - ant.y)).toBeLessThan(Math.hypot(foe.x - landed.x, foe.y - landed.y));

    // With combat live, the landed flyer bites the enemy it chased, as a ground ant does.
    const live = play(scene(undefined, { combatGraceTicks: 0 }));
    const biter = flyer(live.state, 0, 38, 40);
    mark(live.state, "ATTACK", 40, 40);
    addAnt(live.state, 1, 44, 40);
    ticks(live, 20);
    const down = ofType(live.events, "flyer_landing", biter)[0]!.tick;
    expect(live.events.some((e) => e.type === "fight" && e.antId === biter && e.tick >= down)).toBe(true);

    const defend = play(scene());
    const holder = flyer(defend.state, 0, 38, 40);
    mark(defend.state, "DEFEND", 40, 40);
    ticks(defend, 20);
    expect(ofType(defend.events, "flyer_landing", holder)).toHaveLength(1);
    expect(tileOfAnt(antById(defend.state, holder)!)).toEqual({ tileX: 40, tileY: 40 });
  });
});

describe("hover, patrol and LINE flight", () => {
  it("hovers over a GATHER tile while the order stands, with no lockout and no landing", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    addAnt(game.state, 1, 24, 40);
    addAnt(game.state, 0, 24, 41);
    mark(game.state, "GATHER", 24, 40);
    ticks(game, 60);
    const ant = antById(game.state, id)!;
    expect(pos(ant)).toEqual(at(24, 40));
    expect(ant.air).toEqual({ destX: tileCentre(24), destY: tileCentre(40), hovering: true, released: false });
    expect(ant.takeOffTick).toBeUndefined();
    expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
    // Hovering from the tick it arrived (five flight steps), never before.
    const shown = game.states.get(id)!.map((s) => s.state);
    expect(shown.slice(0, 4).every((s) => s === "flying")).toBe(true);
    expect(shown.slice(4).every((s) => s === "hovering")).toBe(true);
  });

  it("sweeps a two-mark PATROL back and forth airborne without stopping, and loops a four-mark chain in laid order", () => {
    for (const tiles of [[[20, 40], [30, 40]], [[20, 40], [30, 40], [30, 50], [20, 50]]] as const) {
      const run = (enemies: boolean) => {
        const game = play(scene());
        const id = flyer(game.state, 0, 20, 40);
        const marks = tiles.map(([x, y], i) => mark(game.state, "PATROL", x, y, { laidTick: START - 10 + i }));
        if (enemies) for (const [x, y] of tiles) { addAnt(game.state, 1, x, y); addAnt(game.state, 1, x + 2, y); }
        const visits: number[] = [];
        for (let i = 0; i < 120; i++) {
          tick(game);
          const ant = antById(game.state, id)!;
          const reached = marks.find((m) => ant.x === tileCentre(m.tileX) && ant.y === tileCentre(m.tileY));
          if (reached !== undefined) visits.push(reached.id);
          expect(stateOf(game.state, id).state).toBe("flying");
        }
        expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
        expect(antById(game.state, id)!.takeOffTick).toBeUndefined();
        return { trail: game.trail.get(id)!, visits, marks };
      };
      const clear = run(false), contested = run(true);
      // Ground enemies beneath neither stop, divert nor land it.
      expect(contested.trail).toEqual(clear.trail);
      // It starts on the first mark, so it heads for the second; then on round the chain in laid order.
      const order = clear.marks.map((m) => m.id);
      const expected = clear.visits.map((_, i) => order[(i + 1) % order.length]!);
      expect(clear.visits).toEqual(expected);
      expect(clear.visits.length).toBeGreaterThan(order.length);
    }
  });

  it("hovers each LINE flyer on the spot the LINE rule gives it, over ground enemies, with no lockout and no landing", () => {
    const game = play(scene());
    addAnt(game.state, 0, 44, 36);
    for (const x of [40, 44, 48]) addAnt(game.state, 1, x, 40);
    const ids = [flyer(game.state, 0, 30, 40), flyer(game.state, 0, 30, 42), flyer(game.state, 0, 30, 44)];
    const line = mark(game.state, "LINE", 40, 40, { toTileX: 48, toTileY: 40, count: 3 });
    ticks(game, 40);
    const spots = ids.map((id) => flyerLineSpotOf(game.state, markOf(game.state, line.id), antById(game.state, id)!));
    // Evenly end to end, every spot seen land, one flyer on each.
    expect([...spots].sort((p, q) => p!.x - q!.x)).toEqual([at(40, 40), at(44, 40), at(48, 40)]);
    ids.forEach((id, i) => {
      expect(stateOf(game.state, id)).toEqual({ state: "hovering", destX: spots[i]!.x, destY: spots[i]!.y });
      expect(antById(game.state, id)!.takeOffTick).toBeUndefined();
      expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
    });
  });

  it("keeps a LINE flyer's last spot while no seen land tile passes, and lands a released one on the spot it held", () => {
    // A lake across the whole map between the flyer and its LINE, seen at first by scouts at both ends.
    const lake: Terrain = { mapId: "test", mapName: "test", water: [{ x: 30, y: 0, width: 60, height: 96 }] };
    for (const ending of ["kept", "released"] as const) {
      const game = play(scene(lake));
      // Scouts held on DEFEND marks at both ends.
      const scouts = [40, 56].map((y) => {
        mark(game.state, "DEFEND", 95, y, { caste: "worker", laidTick: START - 1 });
        return addAnt(game.state, 0, 95, y).id;
      });
      const id = flyer(game.state, 0, 25, 48);
      const line = mark(game.state, "LINE", 95, 40, { toTileX: 95, toTileY: 56 });
      tick(game);
      expect(stateOf(game.state, id)).toEqual({ state: "flying", destX: tileCentre(95), destY: tileCentre(48) });
      while (antById(game.state, id)!.x < tileCentre(60)) tick(game);
      // The scouts die: over open water the flyer itself sees no land at all.
      game.state.ants = game.state.ants.filter((a) => !scouts.includes(a.id));
      if (ending === "released") {
        tick(game, [remove(line.id)]);
        for (let i = 0; i < 60 && antById(game.state, id)!.air !== undefined; i++) tick(game);
        expect(pos(antById(game.state, id)!)).toEqual(at(95, 48));
        expect(ofType(game.events, "flyer_landing", id)).toHaveLength(1);
        continue;
      }
      let blind = 0;
      for (let i = 0; i < 60; i++) {
        const ant = antById(game.state, id)!;
        if (flyerLineSpotOf(game.state, markOf(game.state, line.id), ant) !== null) break;
        tick(game);
        blind++;
        expect(stateOf(game.state, id)).toEqual({ state: "flying", destX: tileCentre(95), destY: tileCentre(48) });
      }
      // Blind from x 60 until land at x 90 is within its 12-tile sight: about 18 tiles of flight.
      expect(blind).toBeGreaterThan(15);
    }
  });

  it("releases a re-cast chain mark's flyers by the cancel rule while the rest re-target the chain left, in the air", () => {
    const game = play(scene());
    const a = mark(game.state, "PATROL", 20, 40, { laidTick: START - 3 });
    const b = mark(game.state, "PATROL", 30, 40, { laidTick: START - 2 });
    const c = mark(game.state, "PATROL", 26, 46, { laidTick: START - 1 });
    const onA = flyer(game.state, 0, 20, 40, { claim: a.id }), onB = flyer(game.state, 0, 30, 40, { claim: b.id });
    flyer(game.state, 0, 26, 46, { claim: c.id });
    ticks(game, 5);
    expect(antById(game.state, onA)!.patrolWaypoint).toBe(b.id);
    const heading = { x: antById(game.state, onB)!.air!.destX, y: antById(game.state, onB)!.air!.destY };
    // The middle mark re-laid as caste soldier: it leaves the flyer chain on this tick's claim pass.
    tick(game, [command("PATROL", 30, 40, { caste: "soldier" })]);
    expect(antById(game.state, onB)!.claim).toBeUndefined();
    expect(antById(game.state, onA)!.patrolWaypoint).toBe(a.id);
    expect(stateOf(game.state, onA)).toMatchObject({ state: "flying", destX: tileCentre(20), destY: tileCentre(40) });
    ticks(game, 20);
    expect(ofType(game.events, "flyer_landing", onA)).toEqual([]);
    expect(antById(game.state, onA)!.takeOffTick).toBeUndefined();
    const landed = ofType(game.events, "flyer_landing", onB);
    expect(landed).toHaveLength(1);
    expect(pos(antById(game.state, onB)!)).toEqual(heading);
  });

  it("hovers over a lone PATROL mark", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    mark(game.state, "PATROL", 24, 40);
    ticks(game, 20);
    expect(stateOf(game.state, id)).toEqual({ state: "hovering", destX: tileCentre(24), destY: tileCentre(40) });
  });

  it("hovers over a PATROL chain laid all on one tile, and sweeps once a mark on another tile joins it", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    const first = mark(game.state, "PATROL", 24, 40, { laidTick: START - 2 });
    const second = mark(game.state, "PATROL", 24, 40, { laidTick: START - 1 });
    ticks(game, 20);
    expect(antById(game.state, id)!.claim).toBe(first.id);
    expect(stateOf(game.state, id)).toEqual({ state: "hovering", destX: tileCentre(24), destY: tileCentre(40) });
    tick(game, [command("PATROL", 30, 40)]);
    const third = game.state.marks.at(-1)!;
    expect([third.id === second.id, third.tileX]).toEqual([false, 30]);
    const visits: string[] = [];
    for (let i = 0; i < 60; i++) {
      tick(game);
      const ant = antById(game.state, id)!;
      expect(stateOf(game.state, id).state).toBe("flying");
      if (ant.y === tileCentre(40) && (ant.x === tileCentre(24) || ant.x === tileCentre(30))) visits.push(String(Math.floor(ant.x / SUB)));
    }
    // It sweeps between the two tiles, passing over the second mark laid on the first one's tile.
    expect(visits.length).toBeGreaterThan(4);
    expect(visits).toEqual(visits.map((_, i) => (i % 2 === 0 ? "30" : "24")));
    expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
  });

  it("re-targets the nearest mark of a changed chain in the air without landing: a removed waypoint, a lone mark and a joined mark", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    const a = mark(game.state, "PATROL", 20, 40, { laidTick: START - 3 });
    const b = mark(game.state, "PATROL", 30, 40, { laidTick: START - 2 });
    const c = mark(game.state, "PATROL", 26, 46, { laidTick: START - 1 });
    tick(game);
    expect(stateOf(game.state, id)).toMatchObject({ state: "flying", destX: tileCentre(30), destY: tileCentre(40) });
    ticks(game, 4);
    // Its waypoint b leaves the chain: it turns at once for the nearest mark left, a (4 tiles back) over c.
    game.state.marks = game.state.marks.filter((m) => m.id !== b.id);
    tick(game);
    expect(antById(game.state, id)!.patrolWaypoint).toBe(a.id);
    expect(stateOf(game.state, id)).toMatchObject({ state: "flying", destX: tileCentre(20), destY: tileCentre(40) });
    // The chain cut to one mark: it hovers over it.
    game.state.marks = game.state.marks.filter((m) => m.id !== c.id);
    ticks(game, 10);
    expect(stateOf(game.state, id)).toEqual({ state: "hovering", destX: tileCentre(20), destY: tileCentre(40) });
    // A mark joins the lone one: it sweeps again at once.
    mark(game.state, "PATROL", 26, 40, { laidTick: START + 20 });
    tick(game);
    expect(stateOf(game.state, id)).toMatchObject({ state: "flying", destX: tileCentre(26), destY: tileCentre(40) });
    expect(ofType(game.events, "flyer_landing", id)).toEqual([]);
    expect(antById(game.state, id)!.takeOffTick).toBeUndefined();
  });
});

describe("a changed patrol chain whose old waypoint survives", () => {
  type Change = "REMOVE" | "re-cast" | "expiry" | "split by a move" | "joined";
  it.each([["REMOVE"], ["re-cast"], ["expiry"], ["split by a move"], ["joined"]] as const)(
    "re-targets the nearest mark of the chain it is on now, in the air without landing (%s)", (change: Change) => {
      const game = play(scene());
      // Flying from a toward b along row 40; c links the three. Laid oldest, c expires before tick START+4.
      const c = mark(game.state, "PATROL", 26, 46, { laidTick: change === "expiry" ? START + 4 - config.markLifetimeTicks : START - 1 });
      const a = mark(game.state, "PATROL", 20, 40, { laidTick: START - 3 });
      const b = mark(game.state, "PATROL", 30, 40, { laidTick: START - 2 });
      // A fourth mark linked only through c, and a scout held beside it, so c can be moved out to it.
      const d = change === "split by a move" ? mark(game.state, "PATROL", 26, 56, { laidTick: START }) : undefined;
      if (d !== undefined) {
        mark(game.state, "DEFEND", 26, 57, { caste: "worker", laidTick: START - 4 });
        addAnt(game.state, 0, 26, 57);
      }
      const id = flyer(game.state, 0, 20, 40, { claim: a.id });
      ticks(game, 4);
      const before = antById(game.state, id)!;
      expect(pos(before)).toEqual({ x: tileCentre(20) + 4 * STEP, y: tileCentre(40) });
      expect(before.patrolWaypoint).toBe(b.id);
      // From x 23.7, a is 3.2 tiles back and b 6.8 ahead; the joined mark, 2.2 tiles away, is nearer still.
      tick(game, change === "REMOVE" ? [remove(c.id)] : change === "re-cast" ? [command("PATROL", 26, 46, { caste: "soldier" })]
        : change === "split by a move" ? [command("PATROL", 26, 55, { markId: c.id })]
        : change === "joined" ? [command("PATROL", 24, 42)] : []);
      if (change === "expiry") expect(game.state.marks.some((m) => m.id === c.id)).toBe(false);
      if (change === "split by a move") expect(markOf(game.state, c.id)).toMatchObject({ tileX: 26, tileY: 55 });
      const nearest = change === "joined" ? game.state.marks.at(-1)! : a;
      expect(nearest.id === b.id).toBe(false);
      expect(antById(game.state, id)!.patrolWaypoint, change).toBe(nearest.id);
      expect(stateOf(game.state, id), change).toEqual({ state: "flying", destX: tileCentre(nearest.tileX), destY: tileCentre(nearest.tileY) });
      // Then on round its chain, airborne: it reaches that mark and flies on, never landing or locking out.
      const visits: number[] = [];
      for (let i = 0; i < 40; i++) {
        tick(game);
        const ant = antById(game.state, id)!;
        expect(stateOf(game.state, id).state, change).toBe("flying");
        const on = game.state.marks.find((m) => m.verb === "PATROL" && ant.x === tileCentre(m.tileX) && ant.y === tileCentre(m.tileY));
        if (on !== undefined) visits.push(on.id);
      }
      expect(visits[0], change).toBe(nearest.id);
      expect(visits.length, change).toBeGreaterThan(2);
      expect(visits.includes(c.id) && change !== "joined", change).toBe(false);
      expect(ofType(game.events, "flyer_landing", id), change).toEqual([]);
      expect(antById(game.state, id)!.takeOffTick, change).toBeUndefined();
    });
});

describe("when a flyer's order ends", () => {
  type Cancel = "REMOVE" | "expiry" | "lower count" | "lapsed seat" | "re-cast";
  /**
   * Two flyers on one ATTACK, GATHER or PATROL mark, cancelled while the far one is mid-flight. With
   * spare, a second flyer mark with room to spare would claim any free flyer at once.
   */
  function cancelled(cancel: Cancel, verb: "ATTACK" | "GATHER" | "PATROL", spare: boolean) {
    const game = play(scene());
    // Expiry: the mark's lifetime ends on the cancel tick.
    const target = mark(game.state, verb, 40, 40, { count: 2, ...(cancel === "expiry" ? { laidTick: START + 5 - config.markLifetimeTicks } : {}) });
    const far = flyer(game.state, 0, 20, 40, { claim: target.id }), near = flyer(game.state, 0, 39, 40, { claim: target.id });
    // A PATROL chain's other mark, filled by its own flyer, so it recruits no one.
    if (verb === "PATROL") flyer(game.state, 0, 44, 40, { claim: mark(game.state, "PATROL", 44, 40, { laidTick: START + 1 }).id });
    if (spare) mark(game.state, "GATHER", 20, 60, { count: 5, laidTick: START + 2 });
    if (cancel === "lapsed seat") game.state.agents[0]!.lastCommandTick = START + 5 - config.commandIdleTicks!;
    ticks(game, 5);
    const ant = antById(game.state, far)!;
    const heading = { x: ant.air!.destX, y: ant.air!.destY };
    // Re-laid by the same agent on the same verb and tile: a lower count, or caste soldier.
    tick(game, cancel === "REMOVE" ? [remove(target.id)] : cancel === "lower count" ? [command(verb, 40, 40)]
      : cancel === "re-cast" ? [command(verb, 40, 40, { count: 2, caste: "soldier" })] : []);
    if (cancel === "re-cast") expect(markOf(game.state, target.id)).toMatchObject({ caste: "soldier", laidTick: START, revision: 1 });
    if (cancel !== "lapsed seat") expect(antById(game.state, far)!.claim).toBeUndefined();
    for (let i = 0; i < 40 && antById(game.state, far)!.air !== undefined; i++) {
      tick(game);
      expect(antById(game.state, far)!.claim, "claimed before it landed").toBeUndefined();
    }
    return { game, far, near, heading };
  }

  it.each([
    ["REMOVE"], ["expiry"], ["lower count"], ["lapsed seat"], ["re-cast"],
  ] as const)("a flying flyer flies on to where it was heading, lands there, locks out and stays put (%s)", (cancel) => {
    for (const verb of ["ATTACK", "GATHER", "PATROL"] as const) {
      for (const spare of [true, false]) {
        const label = `${cancel} ${verb}${spare ? " beside a spare mark" : ""}`;
        const { game, far, heading } = cancelled(cancel, verb, spare);
        const ant = antById(game.state, far)!;
        expect(pos(ant), label).toEqual(heading);
        const landing = ofType(game.events, "flyer_landing", far);
        expect(landing, label).toHaveLength(1);
        const landed = landing[0]!.tick;
        expect(ant.takeOffTick, label).toBe(landed + LOCKOUT);
        expect(ant.holdPoint, label).toEqual(tileOfAnt(ant));
        // In flight it kept the destination fixed on the cancel tick.
        expect(game.states.get(far)!.slice(5, landed - START).every((s) => s.state === "flying" && s.destX === heading.x && s.destY === heading.y), label).toBe(true);
        if (spare && cancel !== "lapsed seat") {
          // Free once landed: the spare mark claims it, and it stays down through its lockout.
          while (game.state.tick < landed + LOCKOUT) tick(game);
          expect(antById(game.state, far)!.claim, label).toBeDefined();
          expect(ofType(game.events, "flyer_takeoff", far).map((e) => e.tick), label).toEqual([START]);
        } else {
          // Stays put: it holds the tile it landed on (sharing it, ground ants keep their spacing).
          ticks(game, LOCKOUT + 20);
          expect(tileOfAnt(antById(game.state, far)!), label).toEqual({ tileX: Math.floor(heading.x / SUB), tileY: Math.floor(heading.y / SUB) });
          expect(stateOf(game.state, far), label).toEqual({ state: "grounded" });
        }
      }
    }
  });

  it("lowers a count by releasing the farthest member first; the one kept flies on", () => {
    const { game, far, near } = cancelled("lower count", "GATHER", false);
    expect(antById(game.state, near)!.claim).toBeDefined();
    expect(stateOf(game.state, near).state).toBe("hovering");
    expect(ofType(game.events, "flyer_landing", far)).toHaveLength(1);
  });

  it("lands a hovering flyer on the tile under it at once, and a locked-out or grounded flyer with no mark holds its tile", () => {
    const game = play(scene());
    const hover = flyer(game.state, 0, 20, 40);
    const gather = mark(game.state, "GATHER", 22, 40);
    ticks(game, 5);
    expect(stateOf(game.state, hover).state).toBe("hovering");
    tick(game, [remove(gather.id)]);
    const removed = game.state.tick - 1;
    expect(ofType(game.events, "flyer_landing", hover).map((e) => e.tick)).toEqual([removed]);
    expect(pos(antById(game.state, hover)!)).toEqual(at(22, 40));
    expect(stateOf(game.state, hover)).toEqual({ state: "lockedOut", takeOffTick: removed + LOCKOUT });
    ticks(game, LOCKOUT + 20);
    // Finished its lockout where it landed, then grounded there with no mark.
    expect(pos(antById(game.state, hover)!)).toEqual(at(22, 40));
    expect(stateOf(game.state, hover)).toEqual({ state: "grounded" });
    expect(ofType(game.events, "flyer_takeoff", hover)).toHaveLength(1);
  });

  it("keeps a locked-out flyer's lockout when the mark that re-claimed it is removed, and it then holds its tile", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 38, 40);
    const first = mark(game.state, "ATTACK", 40, 40);
    ticks(game, 3);
    const landed = ofType(game.events, "flyer_landing", id)[0]!.tick;
    const second = mark(game.state, "ATTACK", 46, 40);
    game.state.marks = game.state.marks.filter((m) => m.id !== first.id);
    ticks(game, 5);
    expect(antById(game.state, id)!.claim).toBe(second.id);
    tick(game, [remove(second.id)]);
    const held = tileOfAnt(antById(game.state, id)!);
    expect(antById(game.state, id)!.takeOffTick).toBe(landed + LOCKOUT);
    ticks(game, 60);
    expect(tileOfAnt(antById(game.state, id)!)).toEqual(held);
    expect(antById(game.state, id)!.takeOffTick).toBe(landed + LOCKOUT);
  });

  it("never stops over water or rock when a patrol leg across them is cancelled there in contact with hovering enemy flyers", () => {
    const terrain: Terrain = { mapId: "test", mapName: "test",
      water: [{ x: 24, y: 30, width: 4, height: 20 }], rocks: [{ x: 31, y: 30, width: 3, height: 20, appearance: 0 }] };
    // Combat is live from the start; every flyer is scripted with HP enough to stay in the fight throughout.
    const tough = { hp: 1_000_000 };
    for (const cancel of ["REMOVE", "expiry", "lower count", "lapsed seat", "re-cast"] as const) {
      for (const over of ["water", "rock"] as const) {
        const game = play(scene(terrain, { combatGraceTicks: 0 }));
        // A two-mark leg 12 tiles long, across the lake (tiles 24 to 27) and the rock band (31 to 33).
        const id = flyer(game.state, 0, 22, 40, tough);
        const a = mark(game.state, "PATROL", 22, 40, { count: 2, laidTick: START - 2 });
        mark(game.state, "PATROL", 34, 40, { count: 2, laidTick: START - 1 });
        // Enemy flyers hovering on land within 2 tiles of the leg, in reach of it over the lake's last tile and on
        // into the rock band (from x 29), or over the rock band's first two tiles (from x 30).
        const ex = over === "water" ? 29 : 30;
        mark(game.state, "GATHER", ex, 42, { colony: 1, count: 2 });
        const enemies = [flyer(game.state, 1, ex, 42, tough), flyer(game.state, 1, ex, 42, tough)];
        const blocked = over === "water" ? (x: number) => x >= 24 && x < 28 : (x: number) => x >= 31 && x < 34;
        // In contact on a tick: airborne after it, it bit an enemy flyer and lost HP to the enemy flyers' bites.
        const contact: number[] = [];
        const fly = (inputs: readonly SimInput[] = []) => {
          const hp = antById(game.state, id)!.hp;
          tick(game, inputs);
          const ant = antById(game.state, id)!;
          if (ant.air !== undefined && enemies.includes(ant.lastTargetId) && ant.hp < hp) contact.push(game.state.tick - 1);
        };
        const inContact = () => contact.at(-1) === game.state.tick - 1;
        // Fly until over the obstacle and in contact there, then cancel on the next tick.
        const tileX = () => Math.floor(antById(game.state, id)!.x / SUB);
        for (let i = 0; i < 30 && !(blocked(tileX()) && inContact()); i++) fly();
        expect(blocked(tileX()) && inContact()).toBe(true);
        expect(game.events.some((e) => e.type === "fight" && e.air === true && e.antId === id && enemies.includes(e.targetId))).toBe(true);
        const heading = { x: antById(game.state, id)!.air!.destX, y: antById(game.state, id)!.air!.destY };
        expect(heading).toEqual(at(34, 40));
        const cancelTick = game.state.tick;
        for (const enemy of enemies) expect(stateOf(game.state, enemy)).toEqual({ state: "hovering", destX: tileCentre(ex), destY: tileCentre(42) });
        const target = markOf(game.state, a.id);
        if (cancel === "expiry") Object.assign(target, { laidTick: cancelTick - config.markLifetimeTicks });
        // Lowered to 1 beside a member standing on the mark: the patrol flyer is the farther, so it goes.
        if (cancel === "lower count") { flyer(game.state, 0, 22, 40, { claim: a.id }); target.count = 1; }
        if (cancel === "re-cast") Object.assign(target, { caste: "soldier", revision: 1 });
        if (cancel === "lapsed seat") game.state.agents[0]!.lastCommandTick = cancelTick - config.commandIdleTicks!;
        fly(cancel === "REMOVE" ? [remove(a.id)] : []);
        // The chain's other mark has room for it, but no mark claims it before it lands.
        for (let i = 0; i < 40 && antById(game.state, id)!.air !== undefined; i++) {
          fly();
          expect(antById(game.state, id)!.claim, cancel).toBeUndefined();
        }
        const label = `${cancel} over ${over}`;
        expect(pos(antById(game.state, id)!), label).toEqual(heading);
        expect(ofType(game.events, "flyer_landing", id), label).toHaveLength(1);
        // It never stopped while in contact: on every tick of the air fight, before and after the cancel, it moved.
        const trail = game.trail.get(id)!;
        expect(contact.some((t) => t >= cancelTick), label).toBe(true);
        for (const t of contact) {
          const was = t === START ? at(22, 40) : trail[t - START - 1]!;
          expect(trail[t - START], `${label}: stopped in contact at tick ${t}`).not.toEqual(was);
        }
      }
    }
  });
});

describe("lockouts survive every change to the claim", () => {
  it("never takes off before 30 ticks after landing while re-claimed by PATROL, LINE and GATHER marks that are re-counted, re-cast and moved", () => {
    for (const change of ["count", "caste", "move"] as const) {
      for (const verb of ["PATROL", "LINE", "GATHER"] as const) {
        const game = play(scene());
        const id = flyer(game.state, 0, 38, 40);
        const attack = mark(game.state, "ATTACK", 40, 40);
        ticks(game, 3);
        const landed = ofType(game.events, "flyer_landing", id)[0]!.tick;
        while (game.state.tick < landed + 10) tick(game);
        const line = (x: number, y: number) => (verb === "LINE" ? { toTileX: x + 4, toTileY: y } : {});
        tick(game, [remove(attack.id), command(verb, 44, 44, line(44, 44))]);
        const next = game.state.marks.at(-1)!;
        tick(game);
        expect(antById(game.state, id)!.claim).toBe(next.id);
        while (game.state.tick < landed + 20) tick(game);
        const label = `${verb} ${change}`;
        // Claimed, it waits where it stands until it can fly.
        const waiting = pos(antById(game.state, id)!);
        tick(game, [change === "count" ? command(verb, 44, 44, { count: 3, ...line(44, 44) })
          : change === "caste" ? command(verb, 44, 44, { caste: "soldier", ...line(44, 44) })
          : command(verb, 46, 46, { markId: next.id, ...line(46, 46) })]);
        expect(markOf(game.state, next.id), label).toMatchObject({ revision: 1, laidTick: landed + 10 });
        while (game.state.tick < landed + LOCKOUT) {
          tick(game);
          expect(antById(game.state, id)!.air, label).toBeUndefined();
          expect(antById(game.state, id)!.takeOffTick, label).toBe(landed + LOCKOUT);
          if (change !== "caste") expect(pos(antById(game.state, id)!), label).toEqual(waiting);
        }
        tick(game);
        const takeOffs = ofType(game.events, "flyer_takeoff", id).map((e) => e.tick);
        // Re-cast released it: it finishes its lockout on the ground and stays there.
        expect(takeOffs, label).toEqual(change === "caste" ? [START] : [START, landed + LOCKOUT]);
        if (change === "caste") expect(stateOf(game.state, id), label).toEqual({ state: "grounded" });
        else expect(antById(game.state, id)!.air, label).toBeDefined();
      }
    }
  });
});

describe("sight in the air", () => {
  it("gives the same 12-tile sight airborne as on the ground, so a flight between two seen areas reveals the ground between", () => {
    const grounded = scene(), airborne = scene();
    flyer(grounded, 0, 60, 40);
    flyer(airborne, 0, 60, 40, { air: { destX: tileCentre(70), destY: tileCentre(40), hovering: false, released: false } });
    const seen = (state: SimState) => Array.from(createVisibility(state).range(0, state.config.sightTiles));
    expect(seen(airborne)).toEqual(seen(grounded));
    expect(airborne.config.sightTiles).toBe(12);

    // Two scouts held on DEFEND marks 100 tiles apart, and a flyer sent from one to the other.
    const game = play(scene());
    for (const x of [10, 110]) {
      addAnt(game.state, 0, x, 40);
      mark(game.state, "DEFEND", x, 40, { caste: "worker" });
    }
    const id = flyer(game.state, 0, 12, 40);
    mark(game.state, "GATHER", 108, 40, { laidTick: START + 1 });
    const tile = (x: number, y: number) => y * game.state.config.mapWidth + x;
    const before = createVisibility(game.state).range(0, 12);
    for (let x = 30; x <= 90; x++) expect(before[tile(x, 40)], `tile ${x} seen before the flight`).toBe(0);
    const revealed = new Set<number>();
    for (let i = 0; i < 130 && stateOf(game.state, id).state !== "hovering"; i++) {
      tick(game);
      const mask = createVisibility(game.state).range(0, 12), { tileX, tileY } = tileOfAnt(antById(game.state, id)!);
      expect(mask[tile(tileX, tileY)]).toBe(1);
      for (let x = 30; x <= 90; x++) if (mask[tile(x, 40)] === 1) revealed.add(x);
    }
    // Every tile of the row between the two scouts' sight was seen on the way.
    for (let x = 30; x <= 90; x++) expect(revealed.has(x), `tile ${x}`).toBe(true);
  });
});

describe("displayed states", () => {
  it("shows flying from take-off at A, hovering from arrival at B, locked out from landing at C with take-off C+30, grounded from C+30", () => {
    const game = play(scene());
    const id = flyer(game.state, 0, 20, 40);
    const gather = mark(game.state, "GATHER", 24, 40);
    const A = START;
    ticks(game, 10);
    const B = A + 4;
    // The hover order ends and an ATTACK mark takes it on: down where it hovered, then off again once its lockout ends.
    const attack = mark(game.state, "ATTACK", 24, 70);
    tick(game, [remove(gather.id)]);
    const R = game.state.tick - 1;
    while (game.state.tick < R + LOCKOUT + 100) tick(game);
    const C = ofType(game.events, "flyer_landing", id)[1]!.tick;
    expect(antById(game.state, id)!.claim).toBe(attack.id);
    const shown = game.states.get(id)!;
    const at = (t: number) => shown[t - START]!;
    for (let t = A; t < B; t++) expect(at(t).state, `tick ${t}`).toBe("flying");
    for (let t = B; t < R; t++) expect(at(t), `tick ${t}`).toEqual({ state: "hovering", destX: tileCentre(24), destY: tileCentre(40) });
    for (let t = R; t < R + LOCKOUT; t++) expect(at(t), `tick ${t}`).toEqual({ state: "lockedOut", takeOffTick: R + LOCKOUT });
    expect(C).toBeGreaterThan(R + LOCKOUT);
    for (let t = R + LOCKOUT; t < C; t++) expect(at(t), `tick ${t}`).toEqual({ state: "flying", destX: tileCentre(24), destY: tileCentre(70) });
    for (let t = C; t < C + LOCKOUT; t++) expect(at(t), `tick ${t}`).toEqual({ state: "lockedOut", takeOffTick: C + LOCKOUT });
    for (let t = C + LOCKOUT; t < game.state.tick; t++) expect(at(t), `tick ${t}`).toEqual({ state: "grounded" });
    expect(ofType(game.events, "flyer_takeoff", id).map((e) => e.tick)).toEqual([A, R + LOCKOUT]);
  });

  it("is null for an ant that is not a flyer", () => {
    const state = scene();
    expect(flyerState(addAnt(state, 0, 10, 10), state.tick - 1)).toBeNull();
  });
});
