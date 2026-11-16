import { afterEach, describe, expect, it } from "vitest";
import { isPassable } from "../../src/sim/terrain.js";
import { createVisibility } from "../../src/sim/view.js";
import type { Mark, SimState } from "../../src/sim/types.js";
import { SEAT_MODES, antOf, centre, nextCommand, obstacleBeside, placeFlyer, scoutAt, seatFlyers, seenLand, sightEdge, type FlyerSeat, type Tile } from "./flyer-seat.js";

/** Moving, re-laying and removing a flyer mark through count_mark. */

let seat: FlyerSeat | undefined;
afterEach(async () => { await seat?.h.close(); seat = undefined; });

const at = (tile: Tile) => ({ tileX: tile.tileX, tileY: tile.tileY });
const markOf = (s: FlyerSeat, id: number): Mark | undefined => s.state().marks.find(m => m.id === id);
const membersOf = (s: FlyerSeat, id: number): number[] => s.state().ants.filter(a => a.claim === id).map(a => a.id).sort((a, b) => a - b);
const distance = (a: Tile, b: Tile) => Math.hypot(a.tileX - b.tileX, a.tileY - b.tileY);

/** Two land tiles the colony sees, at least `apart` tiles from each other. */
function seenPair(state: SimState, apart: number): [Tile, Tile] {
  const [first] = seenLand(state, 0, 1) as [Tile];
  const mask = createVisibility(state).range(0, state.config.sightTiles), width = state.config.mapWidth;
  for (let i = 0; i < mask.length; i++) {
    const tile = { tileX: i % width, tileY: Math.floor(i / width) };
    if (mask[i] === 1 && isPassable(state, tile.tileX, tile.tileY) && distance(tile, first) >= apart) return [first, tile];
  }
  throw new Error("no seen pair");
}

/** A land tile on the flyer's row at least `apart` tiles east or west of it. */
function farLand(state: SimState, from: Tile, apart: number): Tile {
  for (let d = apart; d < state.config.mapWidth; d++) for (const dx of [d, -d]) {
    const tile = { tileX: from.tileX + dx, tileY: from.tileY };
    if (isPassable(state, tile.tileX, tile.tileY)) return tile;
  }
  throw new Error("no far land");
}

async function step(s: FlyerSeat, until: () => boolean, limit = 400): Promise<void> {
  for (let i = 0; i < limit && !until(); i++) s.h.advance(1);
  expect(until()).toBe(true);
}

describe.each(SEAT_MODES)("moving a flyer mark through MCP, $label seat", ({ mode }) => {
  it("keeps the mark's id, members, lifetime and laid order, and airborne members turn toward the new tile at once", async () => {
    let flyers: number[] = [];
    seat = await seatFlyers(mode, state => {
      const [home] = seenLand(state, 0, 1);
      flyers = [placeFlyer(state, 0, home!).id, placeFlyer(state, 0, home!).id];
    });
    const [from, to] = seenPair(seat.state(), 8);
    const laid = await seat.agent.call("count_mark", { verb: "GATHER", count: 2, caste: "flyer", ...at(from) });
    expect(laid.isError, laid.text).toBe(false);
    const markId = laid.data.mark.markId as number;
    nextCommand(seat);
    const later = await seat.agent.call("count_mark", { verb: "DEFEND", count: 1, caste: "worker", ...at(to) });
    expect(later.isError, later.text).toBe(false);
    await step(seat, () => flyers.every(id => antOf(seat!.state(), id)?.air?.hovering === true));
    nextCommand(seat);
    const before = { ...markOf(seat, markId)! }, order = seat.state().marks.map(m => m.id);
    expect(membersOf(seat, markId)).toEqual(flyers);
    const moved = await seat.agent.call("count_mark", { verb: "GATHER", count: 2, markId, ...at(to) });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.data.movedMark).toMatchObject({ markId, verb: "GATHER", count: 2, caste: "flyer", ...at(to) });
    expect(markOf(seat, markId)).toMatchObject({ id: before.id, agentId: before.agentId, laidTick: before.laidTick, ...at(to) });
    expect(seat.state().marks.map(m => m.id)).toEqual(order);
    expect(membersOf(seat, markId)).toEqual(flyers);
    // On the tick the move was accepted, every airborne member already heads for the new tile and none landed.
    for (const id of flyers) expect(antOf(seat.state(), id)!.air).toMatchObject({ destX: centre(to.tileX), destY: centre(to.tileY), hovering: false });
    const observed = await seat.agent.call("observe");
    const mine = (observed.data.view.myMarks as { markId: number }[]).find(m => m.markId === markId);
    expect(mine).toMatchObject({ ...at(to), caste: "flyer", claimed: 2 });
    expect((observed.data.view.marks as { markId: number; ticksLeft: number }[]).find(m => m.markId === markId)?.ticksLeft)
      .toBe(seat.state().config.markLifetimeTicks - (observed.data.view.tick - before.laidTick));
  }, 120_000);

  it("takes a grounded member off for the moved tile only once its lockout ends", async () => {
    let flyer = -1;
    let home: Tile = { tileX: 0, tileY: 0 };
    seat = await seatFlyers(mode, state => {
      [home] = seenLand(state, 0, 1) as [Tile];
      flyer = placeFlyer(state, 0, home).id;
    });
    // Far enough that the flight outlasts most of one command interval, so the move lands inside the lockout.
    const target = farLand(seat.state(), home, 70);
    scoutAt(seat.state(), 0, target);
    const laid = await seat.agent.call("count_mark", { verb: "ATTACK", count: 1, caste: "flyer", ...at(target) });
    expect(laid.isError, laid.text).toBe(false);
    const markId = laid.data.mark.markId as number, laidTick = laid.data.tick - 1;
    await step(seat, () => seat!.events.some(e => e.type === "flyer_landing" && e.antId === flyer));
    const landing = seat.events.find(e => e.type === "flyer_landing" && e.antId === flyer)!.tick;
    const floor = seat.state().config.commandFloorTicks, lockout = seat.state().config.flyers!.lockoutTicks;
    expect(antOf(seat.state(), flyer)!.takeOffTick).toBe(landing + lockout);
    // The move is accepted inside the lockout: the next command tick comes before the take-off tick.
    expect(laidTick + floor).toBeLessThan(landing + lockout);
    seat.h.advance(laidTick + floor - seat.state().tick);
    // Far enough that it is still in flight the tick it takes off, though it walks toward the moved mark while locked out.
    const next = farLand(seat.state(), target, 20);
    scoutAt(seat.state(), 0, next);
    const moved = await seat.agent.call("count_mark", { verb: "ATTACK", count: 1, markId, ...at(next) });
    expect(moved.isError, moved.text).toBe(false);
    for (let tick = seat.state().tick; tick < landing + lockout; tick++) {
      expect(antOf(seat.state(), flyer)!.air, `tick ${tick}`).toBeUndefined();
      expect(antOf(seat.state(), flyer)!.claim).toBe(markId);
      seat.h.advance(1);
    }
    // Processed tick landing + lockout: it took off for the moved tile.
    seat.h.advance(1);
    expect(seat.events.filter(e => e.type === "flyer_takeoff" && e.antId === flyer).map(e => e.tick).at(-1)).toBe(landing + lockout);
    expect(antOf(seat.state(), flyer)!.air).toMatchObject({ destX: centre(next.tileX), destY: centre(next.tileY) });
  }, 120_000);

  it("refuses a move onto water, rock or outside current colony sight and leaves the mark where it was", async () => {
    seat = await seatFlyers(mode);
    const [from] = seenLand(seat.state(), 0, 1) as [Tile];
    const laid = await seat.agent.call("count_mark", { verb: "GATHER", count: 1, caste: "flyer", ...at(from) });
    expect(laid.isError, laid.text).toBe(false);
    const markId = laid.data.mark.markId as number;
    nextCommand(seat);
    const water = obstacleBeside(seat.state(), "water"), rock = obstacleBeside(seat.state(), "rock"), edge = sightEdge(seat.state(), 0);
    const cases: [Tile, Tile, string][] = [[water.land, water.obstacle, "water_tile"], [rock.land, rock.obstacle, "rock_tile"], [edge.scout, edge.firstUnseen, "count_mark_not_visible"]];
    for (const [scout, tile, code] of cases) {
      scoutAt(seat.state(), 0, scout);
      const before = structuredClone(markOf(seat, markId));
      const reply = await seat.agent.call("count_mark", { verb: "GATHER", count: 1, markId, ...at(tile) });
      expect(reply.isError, reply.text).toBe(true);
      expect(reply.data.error.code).toBe(code);
      expect(reply.data.error.message.length).toBeGreaterThan(0);
      expect(markOf(seat, markId)).toEqual(before);
    }
  });

  it("re-lays the same verb on the same tile (LINE: same ends) to change count and caste in place, and REMOVE ends the mark", async () => {
    seat = await seatFlyers(mode);
    const [tile, a, b] = seenLand(seat.state(), 0, 3) as [Tile, Tile, Tile];
    const relay = async (args: Record<string, unknown>) => {
      const reply = await seat!.agent.call("count_mark", args);
      expect(reply.isError, reply.text).toBe(false);
      nextCommand(seat!);
      return reply.data.mark?.markId as number | undefined ?? reply.data.countMark?.markId as number;
    };
    const gather = await relay({ verb: "GATHER", count: 2, caste: "flyer", ...at(tile) });
    const laidTick = markOf(seat, gather)!.laidTick;
    expect(await relay({ verb: "GATHER", count: 5, caste: "flyer", ...at(tile) })).toBe(gather);
    expect(markOf(seat, gather)).toMatchObject({ id: gather, count: 5, caste: "flyer", laidTick });
    expect(await relay({ verb: "GATHER", count: 3, caste: "soldier", ...at(tile) })).toBe(gather);
    expect(markOf(seat, gather)).toMatchObject({ id: gather, count: 3, caste: "soldier", laidTick });
    const line = await relay({ verb: "LINE", count: 2, caste: "flyer", ...at(a), toTileX: b.tileX, toTileY: b.tileY });
    expect(await relay({ verb: "LINE", count: 4, caste: "worker", ...at(a), toTileX: b.tileX, toTileY: b.tileY })).toBe(line);
    expect(markOf(seat, line)).toMatchObject({ id: line, count: 4, caste: "worker" });
    expect(seat.state().marks.map(m => m.id)).toEqual([gather, line]);
    for (const markId of [gather, line]) {
      const removed = await seat.agent.call("count_mark", { verb: "REMOVE", markId });
      expect(removed.isError, removed.text).toBe(false);
      expect(removed.data.removedMark).toEqual({ markId });
      expect(markOf(seat, markId)).toBeUndefined();
      nextCommand(seat);
    }
    const observed = await seat.agent.call("observe");
    expect(observed.data.view.myMarks).toEqual([]);
  });
});
