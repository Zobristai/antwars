import { afterEach, describe, expect, it } from "vitest";
import { SUB } from "../../src/sim/config.js";
import { isPassable } from "../../src/sim/terrain.js";
import { expandCells, type DenseCells, type ViewFlyer } from "../../src/sim/view.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { startHarness, type CallResult, type TestAgent } from "./harness.js";
import { COLONY_NAMES } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { addAnt } from "../sim/fixtures.js";
import { SEAT_MODES, SERVED, antOf, centre, nextCommand, placeFlyer, seatFlyers, scoutAt, seenLand, viewFlyers, type FlyerSeat, type Tile } from "./flyer-seat.js";

/** What observe shows of flyers, read every tick. */

let seat: FlyerSeat | undefined;
afterEach(async () => { await seat?.h.close(); seat = undefined; });

const at = (tile: Tile) => ({ tileX: tile.tileX, tileY: tile.tileY });
const tileOf = (ant: Ant): Tile => ({ tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) });

/** A land tile on the row at least `apart` tiles from the start, east or west. */
function landAway(state: SimState, from: Tile, apart: number): Tile {
  for (let d = apart; d < state.config.mapWidth; d++) for (const dx of [d, -d]) {
    const tile = { tileX: from.tileX + dx, tileY: from.tileY };
    if (isPassable(state, tile.tileX, tile.tileY)) return tile;
  }
  throw new Error("no land away");
}

/** One observe per tick: the processed tick it describes, the flyer's reading, and its position after that tick. */
interface Reading { readonly tick: number; readonly flyer: ViewFlyer | undefined; readonly x: number; readonly y: number; readonly airborne: boolean; readonly reply: CallResult }

async function readTick(s: FlyerSeat, agent: TestAgent, antId: number): Promise<Reading> {
  const reply = await agent.call("observe");
  expect(reply.isError, reply.text).toBe(false);
  const ant = antOf(s.state(), antId)!;
  return { tick: reply.data.view.tick - 1, flyer: viewFlyers(reply).find(f => f.antId === antId), x: ant.x, y: ant.y, airborne: ant.air !== undefined, reply };
}

async function readUntil(s: FlyerSeat, antId: number, done: (r: Reading) => boolean, limit = 400): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (let i = 0; i < limit; i++) {
    const reading = await readTick(s, s.agent, antId);
    readings.push(reading);
    if (done(reading)) return readings;
  }
  throw new Error("reading limit reached");
}

const eventTick = (s: FlyerSeat, type: "flyer_takeoff" | "flyer_landing", antId: number, after = -1): number =>
  s.events.find(e => e.type === type && e.antId === antId && e.tick > after)!.tick;

/** Every reading agrees with the motion: hovering stands still over the tile it hovers on, never flying while grounded. */
function consistent(readings: readonly Reading[]): void {
  for (const [i, r] of readings.entries()) {
    if (r.flyer?.state === "hovering") expect([r.x, r.y], `tick ${r.tick}`).toEqual([centre(r.flyer.destTileX!), centre(r.flyer.destTileY!)]);
    if (r.flyer?.state === "hovering" && readings[i - 1]?.flyer?.state === "hovering") expect([r.x, r.y], `tick ${r.tick}`).toEqual([readings[i - 1]!.x, readings[i - 1]!.y]);
    if (r.flyer?.state === "flying" || r.flyer?.state === "hovering") expect(r.airborne, `tick ${r.tick}`).toBe(true);
    if (r.flyer?.state === "grounded" || r.flyer?.state === "lockedOut") expect(r.airborne, `tick ${r.tick}`).toBe(false);
  }
}

/** Every tick in [from, to) reads as expected; a tick the agent spent on a command has no observe of its own. */
function expectState(readings: readonly Reading[], from: number, to: number, expected: Partial<ViewFlyer>, commandTicks: readonly number[] = []): void {
  const span = readings.filter(r => r.tick >= from && r.tick < to);
  const ticks = Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i).filter(t => !commandTicks.includes(t));
  expect(span.map(r => r.tick), `${expected.state} ${from}..${to}`).toEqual(ticks);
  for (const r of span) expect(r.flyer, `tick ${r.tick}`).toMatchObject(expected);
}

describe.each(SEAT_MODES)("observe shows the agent's flyers, $label seat", ({ mode }) => {
  it("reads flying from take-off A, hovering from B, locked out from landing C with take-off C+30, grounded from C+30", async () => {
    let flyer = -1, home: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => { [home] = seenLand(state, 0, 1) as [Tile]; flyer = placeFlyer(state, 0, home).id; });
    const gather = seenLand(seat.state(), 0, 400).find(t => Math.hypot(t.tileX - home.tileX, t.tileY - home.tileY) >= 6)!;
    const laid = await seat.agent.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(gather) });
    expect(laid.isError, laid.text).toBe(false);
    const gatherId = laid.data.mark.markId as number;
    const lockout = seat.state().config.flyers!.lockoutTicks;
    const commands = [laid.data.tick - 1];
    // Hover until the next command, then REMOVE: it lands under itself and sits out a lockout.
    const readings = await readUntil(seat, flyer, r => r.tick >= laid.data.tick - 1 + seat!.state().config.commandFloorTicks);
    const a = eventTick(seat, "flyer_takeoff", flyer);
    const b = readings.find(r => r.airborne && r.x === gather.tileX * SUB + SUB / 2 && r.y === gather.tileY * SUB + SUB / 2)!.tick;
    const mine = readings[0]!.reply.data.view.myMarks as { markId: number; caste?: string }[];
    expect(mine.find(m => m.markId === gatherId)?.caste).toBe("flyer");
    const removed = await seat.agent.call("count_mark", { verb: "REMOVE", markId: gatherId });
    expect(removed.isError, removed.text).toBe(false);
    commands.push(removed.data.tick - 1);
    const r = eventTick(seat, "flyer_landing", flyer);
    expect(r).toBe(removed.data.tick - 1);
    readings.push(...await readUntil(seat, flyer, x => x.tick >= r + lockout + 5));
    nextCommand(seat);
    const attack = landAway(seat.state(), tileOf(antOf(seat.state(), flyer)!), 10);
    scoutAt(seat.state(), 0, attack);
    const ordered = await seat.agent.call("count_mark", { verb: "ATTACK", count: 1, caste: "flyer", ...at(attack) });
    expect(ordered.isError, ordered.text).toBe(false);
    commands.push(ordered.data.tick - 1);
    const a2 = eventTick(seat, "flyer_takeoff", flyer, r);
    readings.push(...await readUntil(seat, flyer, x => seat!.events.some(e => e.type === "flyer_landing" && e.antId === flyer && e.tick > r) && x.tick >= eventTick(seat!, "flyer_landing", flyer, r) + lockout + 5));
    const c = eventTick(seat, "flyer_landing", flyer, r);
    expect(a).toBeLessThan(b);
    expectState(readings, a, b, { state: "flying", destTileX: gather.tileX, destTileY: gather.tileY }, commands);
    expectState(readings, b, r, { state: "hovering", destTileX: gather.tileX, destTileY: gather.tileY }, commands);
    expectState(readings, r, r + lockout, { state: "lockedOut", takeOffTick: r + lockout }, commands);
    expectState(readings, a2, c, { state: "flying", destTileX: attack.tileX, destTileY: attack.tileY }, commands);
    expectState(readings, c, c + lockout, { state: "lockedOut", takeOffTick: c + lockout }, commands);
    expectState(readings, c + lockout, c + lockout + 5, { state: "grounded" }, commands);
    consistent(readings);
  }, 120_000);

  it("reads a patrol flyer flying along a chain and hovering on a lone mark", async () => {
    let flyer = -1, home: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => { [home] = seenLand(state, 0, 1) as [Tile]; flyer = placeFlyer(state, 0, home).id; });
    const tiles = seenLand(seat.state(), 0, 400);
    const first = tiles.find(t => Math.hypot(t.tileX - home.tileX, t.tileY - home.tileY) >= 4)!;
    const second = tiles.find(t => { const d = Math.hypot(t.tileX - first.tileX, t.tileY - first.tileY); return d >= 6 && d <= seat!.state().config.patrolLinkTiles!; })!;
    const laid = await seat.agent.call("count_mark", { verb: "PATROL", count: 1, caste: "flyer", ...at(first) });
    expect(laid.isError, laid.text).toBe(false);
    // A lone patrol mark: flying there, then hovering over it.
    const lone = await readUntil(seat, flyer, r => r.tick >= laid.data.tick - 1 + seat!.state().config.commandFloorTicks);
    const hovering = lone.filter(r => r.flyer?.state === "hovering");
    expect(hovering.length).toBeGreaterThan(0);
    for (const r of hovering) expect(r.flyer).toMatchObject({ destTileX: first.tileX, destTileY: first.tileY });
    expect(lone.at(-1)!.flyer?.state).toBe("hovering");
    const chained = await seat.agent.call("count_mark", { verb: "PATROL", count: 1, caste: "flyer", ...at(second) });
    expect(chained.isError, chained.text).toBe(false);
    // A chain of two: it flies back and forth and never reads hovering.
    const sweep = await readUntil(seat, flyer, r => r.tick >= chained.data.tick - 1 + 150);
    for (const r of sweep) expect(r.flyer?.state, `tick ${r.tick}`).toBe("flying");
    expect(new Set(sweep.map(r => `${r.flyer!.destTileX},${r.flyer!.destTileY}`))).toEqual(new Set([`${first.tileX},${first.tileY}`, `${second.tileX},${second.tileY}`]));
    consistent([...lone, ...sweep]);
  }, 120_000);

  it("reads a released flyer flying to its fixed destination, then locked out", async () => {
    let flyer = -1, home: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => { [home] = seenLand(state, 0, 1) as [Tile]; flyer = placeFlyer(state, 0, home).id; });
    // Far enough that the flight outlasts one command interval, so REMOVE comes mid-flight.
    const floor = seat.state().config.commandFloorTicks;
    const target = landAway(seat.state(), home, Math.ceil(0.8 * floor) + 12);
    scoutAt(seat.state(), 0, target);
    const laid = await seat.agent.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(target) });
    expect(laid.isError, laid.text).toBe(false);
    seat.h.advance(laid.data.tick - 1 + floor - seat.state().tick);
    expect(antOf(seat.state(), flyer)!.air?.hovering).toBe(false);
    const removed = await seat.agent.call("count_mark", { verb: "REMOVE", markId: laid.data.mark.markId });
    expect(removed.isError, removed.text).toBe(false);
    const release = removed.data.tick - 1, lockout = seat.state().config.flyers!.lockoutTicks;
    const readings = await readUntil(seat, flyer, r => seat!.events.some(e => e.type === "flyer_landing" && e.antId === flyer) && r.tick >= eventTick(seat!, "flyer_landing", flyer) + lockout);
    const landing = eventTick(seat, "flyer_landing", flyer);
    expect(tileOf(antOf(seat.state(), flyer)!)).toEqual(at(target));
    expectState(readings, release + 1, landing, { state: "flying", destTileX: target.tileX, destTileY: target.tileY });
    expectState(readings, landing, landing + lockout, { state: "lockedOut", takeOffTick: landing + lockout });
    consistent(readings);
  }, 120_000);

  it("shows an enemy flyer, airborne or landed, whenever its tile is in the colony's sight", async () => {
    let enemyFlyer = -1, enemyHome: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => { [enemyHome] = seenLand(state, 1, 1) as [Tile]; enemyFlyer = placeFlyer(state, 1, enemyHome).id; });
    const hover = seenLand(seat.state(), 1, 400).find(t => Math.hypot(t.tileX - enemyHome.tileX, t.tileY - enemyHome.tileY) >= 4)!;
    const laid = await seat.enemy.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(hover) });
    expect(laid.isError, laid.text).toBe(false);
    const cellAnts = async (scout: Tile | null): Promise<{ ids: Set<number>; airborne: boolean }> => {
      const state = seat!.state();
      if (scout !== null) scoutAt(state, 0, scout);
      let reply: CallResult = await seat!.agent.call("observe");
      const ids = new Set<number>();
      for (;;) {
        expect(reply.isError, reply.text).toBe(false);
        for (const cell of expandCells(reply.data.view.cells as DenseCells)) for (const ant of cell.ants) ids.add(ant.antId);
        if (reply.data.view.cellsMore !== true) break;
        reply = await seat!.agent.call("observe", { cellsCursor: reply.data.view.cellsCursor });
      }
      return { ids, airborne: antOf(seat!.state(), enemyFlyer)!.air !== undefined };
    };
    seat.h.advance(5);
    const nearLand = seenLand(seat.state(), 1, 400).find(t => { const d = Math.hypot(t.tileX - hover.tileX, t.tileY - hover.tileY); return d >= 2 && d <= 4; })!;
    const airborne = await cellAnts(nearLand);
    expect(airborne.airborne).toBe(true);
    expect(airborne.ids.has(enemyFlyer)).toBe(true);
    nextCommand(seat);
    const removed = await seat.enemy.call("count_mark", { verb: "REMOVE", markId: laid.data.mark.markId });
    expect(removed.isError, removed.text).toBe(false);
    for (let i = 0; i < 100 && antOf(seat.state(), enemyFlyer)!.air !== undefined; i++) seat.h.advance(1);
    const landed = await cellAnts(nearLand);
    expect(landed.airborne).toBe(false);
    expect(landed.ids.has(enemyFlyer)).toBe(true);
    // Out of sight: no colony ant within sight of its tile, so it is not shown.
    for (const ant of seat.state().ants) if (ant.colony === 0 && Math.hypot(ant.x / SUB - hover.tileX, ant.y / SUB - hover.tileY) <= seat.state().config.sightTiles + 2) ant.hp = 0;
    seat.h.advance(1);
    const unseen = await cellAnts(null);
    expect(unseen.ids.has(enemyFlyer)).toBe(false);
  }, 120_000);
});

describe("view.flyers at the largest ant cap", () => {
  it("lists every one of a full colony's flyers in one observe within the reply limits", async () => {
    // Wide Plain's 1024-ant cap is the largest any map sets; give every ant a long record (airborne, four-digit ids).
    const base = createMatch(41, newMatchConfig(SERVED));
    const state = { ...base, config: { ...base.config, colonyCap: 1024 } };
    state.ants = state.ants.filter(ant => ant.colony !== 0);
    state.nextAntId = 1000;
    for (let i = 0; state.ants.filter(a => a.colony === 0).length < 1024; i++) {
      const tileX = i % state.config.mapWidth, tileY = Math.floor(i / state.config.mapWidth) % state.config.mapHeight;
      if (!isPassable(state, tileX, tileY)) continue;
      addAnt(state, 0, tileX, tileY, { flyer: true, hp: state.config.flyers!.hp,
        air: { destX: (state.config.mapWidth - 1) * SUB, destY: (state.config.mapHeight - 1) * SUB, hovering: true, released: false } });
    }
    const h = await startHarness({ simConfig: state.config, state });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join", { colony: COLONY_NAMES[0] });
      expect(joined.isError, joined.text).toBe(false);
      const observed = await agent.call("observe");
      expect(observed.isError, observed.text).toBe(false);
      expect(viewFlyers(observed)).toHaveLength(1024);
    } finally {
      await h.close();
    }
  }, 120_000);
});
