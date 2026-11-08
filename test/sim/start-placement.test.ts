import { describe, expect, it } from "vitest";
import { MAPS, PUBLIC_CONFIG, TERRAIN_RULES } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { MissingStartPicksError, START_PICK_WINDOW_MS, StartPlacement, startBoxes, type StartGrid, type StartSeat } from "../../src/sim/startPlacement.js";
import { playable } from "../playable.ts";
import { sevenMapRotation } from "./seven-map-rotation.js";

// Every match plays at grid scale 2: the 64x48 reference board with its nest at reference tile
// (8, 24) is 128x96 fine tiles, nest centre (16.5, 48.5). Reference tile t is fine tile L(t) = 2t on the
// left and R(t) = 2t + 1 on the right (the mirror of L(63 - t)); rows are Y(t) = 2t.
const grid: StartGrid = { mapWidth: 128, mapHeight: 96, nestTileX: 16.5, nestTileY: 48.5, gridScale: 2 };
const L = (t: number) => 2 * t, R = (t: number) => 2 * t + 1, Y = (t: number) => 2 * t;
const mirror = (x: number) => grid.mapWidth - 1 - x;
const seats: StartSeat[] = [0, 1, 2, 3].flatMap(n => [
  { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
]);
const openedAt = 1000;
const closesAt = openedAt + START_PICK_WINDOW_MS;
const empty = () => new StartPlacement(grid, seats, openedAt, () => null);

describe("lobby starting placement without simulation ticks", () => {
  it.each([2] as const)("keeps physical box dimensions and exact mirrored tiles at scale %i", scale => {
    const scaled = { mapWidth: 64 * scale, mapHeight: 48 * scale, nestTileX: 8.5 * scale - .5, nestTileY: 24.5 * scale - .5, gridScale: scale };
    const [left, right] = startBoxes(scaled);
    expect(left).toEqual({ x: 2 * scale, y: 12 * scale, width: 12 * scale, height: 24 * scale });
    expect(right).toEqual({ ...left, x: scaled.mapWidth - left.x - left.width });
    const placement = new StartPlacement(scaled, seats, openedAt, () => null);
    const final = placement.finish(closesAt);
    for (let n = 0; n < 4; n++) {
      const l = final.find(q => q.identityId === `left-${n}`)!;
      const r = final.find(q => q.identityId === `right-${n}`)!;
      expect(r.tileX).toBe(scaled.mapWidth - 1 - l.tileX);
      expect(r.tileY).toBe(l.tileY);
      expect(l.queenId).toBe(n); expect(r.queenId).toBe(n);
    }
    expect(final.find(q => q.identityId === "left-0")).toMatchObject({ tileX: Math.floor(scaled.nestTileX), tileY: Math.floor(scaled.nestTileY) });
  });

  it("keeps the production two minutes and permits only explicit positive test durations", () => {
    expect(START_PICK_WINDOW_MS).toBe(120_000);
    expect(empty().closesAt).toBe(openedAt + 120_000);
    const production = empty();
    for (const elapsed of [60_000, 119_999]) {
      expect(production.pick("left-0", L(8), Y(24), openedAt + elapsed)).toEqual({ ok: true });
      expect(() => production.finish(openedAt + elapsed)).toThrow("still open");
    }
    expect(production.pick("left-0", L(9), Y(24), openedAt + 120_000)).toEqual({ ok: false, reason: "window_closed" });
    expect(production.finish(openedAt + 120_000).find(nest => nest.identityId === "left-0")).toMatchObject({ tileX: L(8), tileY: Y(24) });
    const short = new StartPlacement(grid, seats, openedAt, () => null, 25);
    expect(short.closesAt).toBe(openedAt + 25);
    expect(short.pick("left-0", L(8), Y(24), openedAt + 24)).toEqual({ ok: true });
    expect(short.pick("left-0", L(9), Y(24), openedAt + 25)).toEqual({ ok: false, reason: "window_closed" });
    expect(short.finish(openedAt + 25).find(nest => nest.identityId === "left-0")).toMatchObject({ tileX: L(8), tileY: Y(24) });
    for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new StartPlacement(grid, seats, openedAt, () => null, invalid)).toThrow("Invalid pick window duration");
    }
  });

  it.each([1, 2, 3, 4])("requires every explicit pick before finalizing %i seats per colony", size => {
    const roster = seats.slice(0, size * 2);
    const placement = new StartPlacement(grid, roster, openedAt, () => null, undefined, true);
    for (const [index, seat] of roster.entries()) {
      expect(() => placement.finish(closesAt)).toThrow(MissingStartPicksError);
      const tileX = seat.colony === 0 ? L(8 + Math.floor(index / 2)) : R(55 - Math.floor(index / 2));
      expect(placement.pick(seat.identityId, tileX, Y(24), closesAt - 1)).toEqual({ ok: true });
    }
    expect(() => placement.finish(closesAt - 1)).toThrow("still open");
    const nests = placement.finish(closesAt);
    expect(nests).toHaveLength(roster.length);
    for (const nest of nests) {
      expect(placement.teamView(nest.identityId)!.picks).toContainEqual({ identityId: nest.identityId, tileX: nest.tileX, tileY: nest.tileY });
    }
    expect(placement.finish(closesAt + 1)).toEqual(nests);
  });

  it("does not assign defaults or accept late picks when a required seat never picks", () => {
    const placement = new StartPlacement(grid, seats, openedAt, () => null, undefined, true);
    expect(placement.pick("left-0", L(8), Y(24), openedAt)).toEqual({ ok: true });
    const before = placement.teamView("left-0");
    expect(() => placement.finish(closesAt)).toThrow(MissingStartPicksError);
    expect(() => placement.finish(closesAt + 1)).toThrow(MissingStartPicksError);
    expect(placement.teamView("left-0")).toEqual(before);
    expect(placement.teamView("right-0")!.picks).toEqual([]);
    expect(placement.pick("right-0", R(55), Y(24), closesAt)).toEqual({ ok: false, reason: "window_closed" });
  });

  it("preserves centre picks before defaults, including seats that never called", () => {
    const placement = empty();
    expect(placement.pick("left-3", L(8), Y(24), openedAt)).toEqual({ ok: true });
    expect(placement.pick("right-3", R(55), Y(24), openedAt)).toEqual({ ok: true });
    const final = placement.finish(closesAt);
    expect(final).toHaveLength(8);
    expect(new Set(final.map(q => `${q.tileX},${q.tileY}`)).size).toBe(8);
    expect(final.find(q => q.identityId === "left-3")).toMatchObject({ tileX: L(8), tileY: Y(24) });
    for (let n = 0; n < 4; n++) {
      const l = final.find(q => q.identityId === `left-${n}`)!;
      const r = final.find(q => q.identityId === `right-${n}`)!;
      expect(r.tileX).toBe(mirror(l.tileX)); expect(r.tileY).toBe(l.tileY);
    }
  });

  it("allows adjacent nests, replacement and keeping one's own tile", () => {
    const placement = empty();
    expect(placement.pick("left-0", L(8), Y(24), openedAt)).toEqual({ ok: true });
    expect(placement.pick("left-1", L(9), Y(24), openedAt)).toEqual({ ok: true });
    expect(placement.pick("left-0", L(8), Y(24), openedAt + 1)).toEqual({ ok: true });
    expect(placement.pick("left-0", L(10), Y(24), openedAt + 2)).toEqual({ ok: true });
    expect(placement.pick("left-2", L(8), Y(24), openedAt + 3)).toEqual({ ok: true });
    expect(placement.finish(closesAt).find(q => q.identityId === "left-0")).toMatchObject({ tileX: L(10), tileY: Y(24) });
  });

  it("refuses each illegal pick without changing a standing pick", () => {
    const placement = new StartPlacement(grid, seats, openedAt, (x, y) => y !== Y(20) ? null : x === L(3) ? "water" : x === L(4) ? "rock" : x === L(5) ? "food" : null);
    placement.pick("left-0", L(8), Y(24), openedAt);
    placement.pick("left-1", L(9), Y(24), openedAt);
    const before = placement.teamView("left-0");
    for (const [x, y, reason] of [[L(3), Y(20), "water"], [L(4), Y(20), "rock"], [L(5), Y(20), "food"], [L(1), Y(24), "outside_box"],
      [L(14), Y(24), "outside_box"], [L(8), Y(36), "outside_box"], [L(8) + 0.5, Y(24), "invalid_tile"], [NaN, Y(24), "invalid_tile"], [L(9), Y(24), "occupied"]] as const) {
      expect(placement.pick("left-0", x, y, openedAt)).toEqual({ ok: false, reason });
      expect(placement.teamView("left-0")).toEqual(before);
    }
    expect(placement.pick("outsider", L(8), Y(24), openedAt)).toEqual({ ok: false, reason: "not_seated" });
    expect(placement.pick("left-0", L(10), Y(24), closesAt)).toEqual({ ok: false, reason: "window_closed" });
    expect(placement.teamView("left-0")).toEqual(before);
  });

  it("closes exactly at the deadline and finalizes once with defensive copies", () => {
    const placement = empty();
    expect(() => placement.finish(closesAt - 1)).toThrow("still open");
    expect(placement.pick("left-0", L(8), Y(24), closesAt - 1)).toEqual({ ok: true });
    const first = placement.finish(closesAt), expected = structuredClone(first);
    (first[0] as { tileX: number }).tileX = -999;
    expect(placement.finish(closesAt + 10)).toEqual(expected);
    expect(placement.pick("left-0", L(9), Y(24), openedAt)).toEqual({ ok: false, reason: "window_closed" });
  });

  it("projects only the caller's team's explicit picks, never defaults or enemy picks", () => {
    const placement = empty();
    placement.pick("left-2", L(7), Y(20), openedAt);
    placement.pick("right-2", R(56), Y(20), openedAt);
    const view = placement.teamView("left-0")!;
    expect(view).toEqual({ box: startBoxes(grid)[0], closesAt, picks: [{ identityId: "left-2", tileX: L(7), tileY: Y(20) }] });
    expect(placement.teamView("outsider")).toBeNull();
    (view.picks[0] as { tileX: number }).tileX = 999;
    expect(placement.teamView("left-0")!.picks[0].tileX).toBe(L(7));
    placement.finish(closesAt);
    expect(placement.teamView("left-0")!.picks).toHaveLength(1);
  });

  it("skips occupied, water, rock and food tiles deterministically", () => {
    const obstacle = (x: number, y: number) => {
      const localX = x < 64 ? x : mirror(x);
      return localX === L(8) && y === Y(24) ? "food" as const : localX === L(8) && y === Y(23) ? "water" as const : localX === L(7) && y === Y(24) ? "rock" as const : null;
    };
    const a = new StartPlacement(grid, seats, openedAt, obstacle), b = new StartPlacement(grid, seats, openedAt, obstacle);
    const final = a.finish(closesAt);
    expect(final).toEqual(b.finish(closesAt));
    expect(final.every(q => obstacle(q.tileX, q.tileY) === null)).toBe(true);
    for (let n = 0; n < 4; n++) {
      const l = final.find(q => q.identityId === `left-${n}`)!;
      const r = final.find(q => q.identityId === `right-${n}`)!;
      expect(r.tileX).toBe(mirror(l.tileX)); expect(r.tileY).toBe(l.tileY);
    }
  });

  it("fails closed for impossible maps or invalid rosters", () => {
    expect(() => startBoxes({ ...grid, nestTileX: 2 * 2.5 - 0.5 })).toThrow("does not fit"); // reference nest tile 2
    expect(() => startBoxes({ ...grid, mapWidth: 2 * 20 })).toThrow("overlap");
    expect(() => new StartPlacement(grid, [seats[0], seats[0]], openedAt, () => null)).toThrow("roster");
    expect(() => new StartPlacement(grid, seats, openedAt, () => "rock")).toThrow("too few");
  });

  it.each(MAPS)("$name has distinct legal defaults for every roster seat on current landed terrain", map => {
    const state = createMatch(7001, playable({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId: map.id } }));
    const obstacle = (x: number, y: number) => isWaterTile(state.terrain, x, y) ? "water" as const
      : isRockTile(state.terrain, x, y) ? "rock" as const
      : state.food[y * state.config.mapWidth + x] > 0 ? "food" as const : null;
    const placement = new StartPlacement(state.config, seats, openedAt, obstacle);
    const final = placement.finish(closesAt);
    expect(final).toHaveLength(8);
    expect(final.every(q => obstacle(q.tileX, q.tileY) === null)).toBe(true);
    expect(new Set(final.map(q => `${q.tileX},${q.tileY}`)).size).toBe(8);
  });
});

describe("stored back-quarter start areas", () => {
  it.each([2] as const)("uses every row and exactly mirrored quarter-width columns at scale %i", scale => {
    const config = { mapWidth: 64 * scale, mapHeight: 48 * scale, nestTileX: 8.5 * scale - .5,
      nestTileY: 24.5 * scale - .5, gridScale: scale, startArea: "back-quarter" as const };
    const boxes = startBoxes(config);
    expect(boxes).toEqual([{ x: 0, y: 0, width: 16 * scale, height: 48 * scale },
      { x: 48 * scale, y: 0, width: 16 * scale, height: 48 * scale }]);
    const placement = new StartPlacement(config, seats, openedAt, () => null);
    for (const colony of [0, 1] as const) {
      const box = boxes[colony], identity = colony === 0 ? "left-0" : "right-0";
      for (const x of [box.x, box.x + box.width - 1]) for (const y of [0, config.mapHeight - 1]) {
        expect(placement.pick(identity, x, y, openedAt)).toEqual({ ok: true });
      }
      for (const [x, y] of [[box.x - 1, 0], [box.x + box.width, 0], [box.x, -1], [box.x, config.mapHeight]]) {
        expect(placement.pick(identity, x!, y!, openedAt)).toEqual({ ok: false, reason: "outside_box" });
      }
    }
    expect(() => startBoxes({ ...config, mapWidth: 65 })).toThrow("does not fit");
  });

  it.each(MAPS)("$name has no water in either strip, legal nest defaults, and refuses blocked tiles", map => {
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    const config = sevenMapRotation(newMatchConfig({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId: map.id } }));
    const state = createMatch(7001, config);
    const obstacle = (x: number, y: number) => isWaterTile(state.terrain, x, y) ? "water" as const
      : isRockTile(state.terrain, x, y) ? "rock" as const
      : state.food[y * config.mapWidth + x]! > 0 ? "food" as const : null;
    const placement = new StartPlacement(config, seats, openedAt, obstacle);
    for (const colony of [0, 1] as const) {
      const box = startBoxes(config)[colony], identity = colony === 0 ? "left-0" : "right-0";
      const blocked = new Set<string>();
      for (let y = 0; y < config.mapHeight; y++) for (let x = box.x; x < box.x + box.width; x++) {
        expect(isWaterTile(state.terrain, x, y)).toBe(false);
        const reason = obstacle(x, y);
        if (reason === null || blocked.has(reason)) continue;
        blocked.add(reason);
        expect(placement.pick(identity, x, y, openedAt)).toEqual({ ok: false, reason });
      }
      expect(blocked).toEqual(new Set(["rock", "food"]));
    }
    const defaults = placement.finish(closesAt);
    expect(defaults.every(nest => obstacle(nest.tileX, nest.tileY) === null)).toBe(true);
    const left = defaults.find(nest => nest.identityId === "left-0")!;
    expect(left).toMatchObject({ tileX: Math.floor(config.nestTileX), tileY: Math.floor(config.nestTileY) });
    const right = defaults.find(nest => nest.identityId === "right-0")!;
    expect(right).toMatchObject({ tileX: config.mapWidth - 1 - left.tileX, tileY: left.tileY });
    // Shipped strips contain no water; inject it at both preferred defaults to prove refusal/fallback.
    const wet = (x: number, y: number) => y === left.tileY && (x === left.tileX || x === right.tileX) ? "water" as const : obstacle(x, y);
    const flooded = new StartPlacement(config, seats, openedAt, wet);
    expect(flooded.pick("left-0", left.tileX, left.tileY, openedAt)).toEqual({ ok: false, reason: "water" });
    expect(flooded.pick("right-0", right.tileX, right.tileY, openedAt)).toEqual({ ok: false, reason: "water" });
    expect(flooded.finish(closesAt).every(nest => wet(nest.tileX, nest.tileY) === null)).toBe(true);
  });

  it("stores the marker with edge picks for replay re-validation; marker-less replays retain the old box", () => {
    const config = newMatchConfig(PUBLIC_CONFIG), state = createMatch(7001, config);
    const boxes = startBoxes(config);
    const picks = boxes.map(box => {
      for (let y = 0; y < 10; y++) for (let x = box.x; x < box.x + box.width; x++) {
        if (!isWaterTile(state.terrain, x, y) && !isRockTile(state.terrain, x, y) && state.food[y * config.mapWidth + x] === 0) {
          return [{ tileX: x, tileY: y }];
        }
      }
      throw new Error("No legal edge pick");
    }) as [{ tileX: number; tileY: number }[], { tileX: number; tileY: number }[]];
    const finalized = { ...config, initialQueens: picks };
    expect(stateHash(replay([headerLine(7001, finalized)], 0))).toBe(stateHash(createMatch(7001, finalized)));
    const { startArea: _marker, ...historical } = finalized;
    expect(() => createMatch(7001, historical)).toThrow("Invalid initial queen tile");
    expect(startBoxes(historical)[0]).toEqual({ x: 4, y: 24, width: 24, height: 48 });
  });
});
