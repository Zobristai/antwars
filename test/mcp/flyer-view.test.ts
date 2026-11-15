import { afterEach, describe, expect, it } from "vitest";
import { SUB } from "../../src/sim/config.js";
import { isPassable } from "../../src/sim/terrain.js";
import { CELL_ENCODING, FLYER_CELL_ENCODING, denseCells, expandCells, type DenseCells, type ViewCell, type ViewFlyer } from "../../src/sim/view.js";
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

type ShownAnt = ViewCell["ants"][number] & Tile;

/** Every ant the reply's cells show, with its tile, decoded from the served table; the reply holds the whole snapshot. */
function shownAnts(reply: CallResult): Map<number, ShownAnt> {
  expect(reply.data.view.cellsMore, "one cell page").toBe(false);
  expect(reply.data.view.cells.encoding).toBe(FLYER_CELL_ENCODING);
  const shown = new Map<number, ShownAnt>();
  for (const cell of expandCells(reply.data.view.cells as DenseCells)) for (const ant of cell.ants) shown.set(ant.antId, { ...ant, tileX: cell.tileX, tileY: cell.tileY });
  return shown;
}

/** The ant's record in the served cell data, exactly as sent. */
function servedRecord(reply: CallResult, antId: number): string | undefined {
  const data = (reply.data.view.cells as DenseCells).data;
  for (const token of data === "" ? [] : data.split(";")) {
    const ants = token.split("*")[0]!.split(":")[1];
    for (const record of ants === undefined ? [] : ants.split("/")) if (record.split(".")[0] === antId.toString(36)) return record;
  }
  return undefined;
}

/** One observe per tick: the processed tick it describes, the flyer's reading, its cell entry, and its position after that tick. */
interface Reading { readonly tick: number; readonly flyer: ViewFlyer | undefined; readonly shown: ShownAnt | undefined; readonly x: number; readonly y: number; readonly airborne: boolean; readonly reply: CallResult }

async function readTick(s: FlyerSeat, agent: TestAgent, antId: number): Promise<Reading> {
  const reply = await agent.call("observe");
  expect(reply.isError, reply.text).toBe(false);
  const ant = antOf(s.state(), antId)!;
  return { tick: reply.data.view.tick - 1, flyer: viewFlyers(reply).find(f => f.antId === antId), shown: shownAnts(reply).get(antId),
    x: ant.x, y: ant.y, airborne: ant.air !== undefined, reply };
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

/** Every reading agrees with the motion: hovering stands still over the tile it hovers on, never flying while grounded.
 * The flyer's own cell entry marks it a flyer in the same state, a locked-out one reading grounded. */
function consistent(readings: readonly Reading[]): void {
  for (const [i, r] of readings.entries()) {
    expect(r.shown?.flyer, `tick ${r.tick}`).toBe(r.flyer?.state === "lockedOut" ? "grounded" : r.flyer?.state);
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

  it("shows a sighted enemy flyer as a flyer, flying, hovering or grounded, and nothing of its destination, marks or lockout", async () => {
    let enemyFlyer = -1, enemyHome: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => { [enemyHome] = seenLand(state, 1, 1) as [Tile]; enemyFlyer = placeFlyer(state, 1, enemyHome).id; });
    const s = seat, sight = s.state().config.sightTiles, lockout = s.state().config.flyers!.lockoutTicks;
    const distance = (a: Tile, b: Tile) => Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);
    const enemyLand = seenLand(s.state(), 1, 400);
    // A hover tile far enough for a flight of several ticks; one scout between the two ends sees the whole flight.
    const hover = enemyLand.find(t => distance(t, enemyHome) >= sight / 2 && distance(t, enemyHome) <= sight - 2)!;
    const middle = { tileX: (hover.tileX + enemyHome.tileX) / 2, tileY: (hover.tileY + enemyHome.tileY) / 2 };
    const scout = enemyLand.toSorted((a, b) => distance(a, middle) - distance(b, middle))[0]!;
    /** One observe by colony 0, with a fresh scout on the scout tile when asked (free ants walk off). */
    const sighting = async (scouted: boolean) => {
      if (scouted) scoutAt(s.state(), 0, scout);
      const reply = await s.agent.call("observe");
      expect(reply.isError, reply.text).toBe(false);
      expect(viewFlyers(reply).some(f => f.antId === enemyFlyer)).toBe(false);
      return { tick: reply.data.view.tick - 1, reply, shown: shownAnts(reply).get(enemyFlyer), record: servedRecord(reply, enemyFlyer) };
    };
    const unseenAtHome = await sighting(false);
    expect(unseenAtHome.shown).toBeUndefined();
    expect(unseenAtHome.record).toBeUndefined();

    const laid = await s.enemy.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(hover) });
    expect(laid.isError, laid.text).toBe(false);
    const aloft: Awaited<ReturnType<typeof sighting>>[] = [];
    while (aloft.filter(r => r.shown?.flyer === "hovering").length < 5) {
      expect(aloft.length, "reading limit").toBeLessThan(200);
      aloft.push(await sighting(true));
    }
    const takeOff = eventTick(s, "flyer_takeoff", enemyFlyer);
    const firstHover = aloft.find(r => r.shown?.flyer === "hovering")!.tick;
    for (const [i, r] of aloft.entries()) {
      expect(r.shown, `tick ${r.tick}`).toMatchObject({ colony: 1, caste: "worker", flyer: r.tick < takeOff ? "grounded" : r.tick < firstHover ? "flying" : "hovering" });
      // Only its id, HP, colony, caste and state letter: no destination, mark or take-off tick.
      expect(r.record, `tick ${r.tick}`).toMatch(/^[0-9a-z]+\.[0-9a-z]+\.[gfh]$/);
      if (r.shown!.flyer === "hovering") expect(at(r.shown!), `tick ${r.tick}`).toEqual(at(hover));
      if (r.shown!.flyer === "hovering" && aloft[i - 1]?.shown?.flyer === "hovering") expect(r.record).toBe(aloft[i - 1]!.record);
    }
    const flying = aloft.filter(r => r.shown!.flyer === "flying");
    expect(flying.length).toBeGreaterThan(1);
    expect(new Set(flying.map(r => `${r.shown!.tileX},${r.shown!.tileY}`)).size).toBeGreaterThan(1);

    // REMOVE lands it under itself; through its lockout and after, it is served the same, grounded on the hover tile.
    nextCommand(s);
    const removed = await s.enemy.call("count_mark", { verb: "REMOVE", markId: laid.data.mark.markId });
    expect(removed.isError, removed.text).toBe(false);
    const landing = eventTick(s, "flyer_landing", enemyFlyer);
    const landed: Awaited<ReturnType<typeof sighting>>[] = [];
    while (landed.length === 0 || landed.at(-1)!.tick < landing + lockout + 3) landed.push(await sighting(true));
    for (const r of landed) expect(r.shown, `tick ${r.tick}`).toMatchObject({ colony: 1, caste: "worker", flyer: "grounded", ...at(hover) });
    expect(landed.some(r => r.tick < landing + lockout) && landed.some(r => r.tick >= landing + lockout)).toBe(true);
    expect(new Set(landed.map(r => r.record))).toEqual(new Set([landed[0]!.record]));

    // Out of sight: no colony ant within sight of its tile, so it is not shown, landed or airborne.
    for (const ant of s.state().ants) if (ant.colony === 0 && Math.hypot(ant.x / SUB - hover.tileX, ant.y / SUB - hover.tileY) <= sight + 2) ant.hp = 0;
    s.h.advance(1);
    const unseenLanded = await sighting(false);
    expect(unseenLanded.shown).toBeUndefined();
    expect(unseenLanded.record).toBeUndefined();
    nextCommand(s);
    const away = await s.enemy.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(enemyHome) });
    expect(away.isError, away.text).toBe(false);
    s.h.advance(2);
    const unseenAloft = await sighting(false);
    expect(eventTick(s, "flyer_takeoff", enemyFlyer, landing)).toBeLessThanOrEqual(unseenAloft.tick);
    expect(s.events.some(e => e.type === "flyer_landing" && e.antId === enemyFlyer && e.tick > landing)).toBe(false);
    expect(unseenAloft.shown).toBeUndefined();
    expect(unseenAloft.record).toBeUndefined();
  }, 120_000);
});

describe("the cell table's flyer field", () => {
  it("carries each flyer's state in the flyer grammar and decodes it back; other tables keep today's grammar", () => {
    const cells: ViewCell[] = [
      { tileX: 3, tileY: 1, food: 0, ants: [{ antId: 7, colony: 1, hp: 2000, caste: "worker", flyer: "hovering" }, { antId: 9, colony: 0, hp: 2000, caste: "worker" }] },
      { tileX: 5, tileY: 2, food: 2, ants: [{ antId: 11, colony: 0, hp: 1500, caste: "worker", flyer: "flying" }, { antId: 12, colony: 1, hp: 2000, caste: "worker", flyer: "grounded" }] },
    ];
    const table = denseCells(cells, 64, 48, true);
    expect(table.encoding).toBe(FLYER_CELL_ENCODING);
    expect(table.encoding.startsWith(CELL_ENCODING)).toBe(true);
    expect(table.data.split(/[:/;]/).filter(part => /\.[gfh]$/.test(part))).toEqual([`7.${(2000 * 6 + 3).toString(36)}.h`, `${(11).toString(36)}.${(1500 * 6 + 2).toString(36)}.f`, `${(12).toString(36)}.${(2000 * 6 + 3).toString(36)}.g`]);
    expect(expandCells(table)).toEqual(cells);
    const plain = cells.map(cell => ({ ...cell, ants: cell.ants.map(({ flyer: _flyer, ...ant }) => ant) }));
    expect(denseCells(plain, 64, 48)).toEqual({ ...denseCells(plain, 64, 48, true), encoding: CELL_ENCODING });
    const one = { width: 64, height: 48, encoding: FLYER_CELL_ENCODING, foodRadix: 1 };
    expect(expandCells({ ...one, data: "0:1.8.h" })).toEqual([{ tileX: 0, tileY: 0, food: 0, ants: [{ antId: 1, colony: 0, hp: 1, caste: "worker", flyer: "hovering" }] }]);
    for (const data of ["0:1.8.l", "0:1.8.h.3", "0:1.8."]) expect(() => expandCells({ ...one, data }), data).toThrow(RangeError);
  });
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
