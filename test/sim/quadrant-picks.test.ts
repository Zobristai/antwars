import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { SimState } from "../../src/sim/types.js";
import type { StartBox, StartTile } from "../../src/sim/startPlacement.js";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";

/** Test-only quadrant geometry, as in four-colony.test.ts: nest, water, start area and food off both mirror axes. */
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

/** Test-only fixture whose nest (29,8) lies well outside its start area (0,0,8,8), as in four-colony.test.ts. */
const CLOSE: MapDefinition = {
  id: "close-quadrants", name: "Close Quadrants", water: [],
  quadrant: { referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
    startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }] },
};

const LIVE = newMatchConfig(rulesConfig("redesign"));
const quadrantConfig = (map: MapDefinition): SimConfig => ({ ...LIVE, terrain: { ...LIVE.terrain!, maps: [map] } });
const SEED = 404;
const COLONIES = [0, 1, 2, 3] as const;
const SEATS = COLONIES.map(colony => ({ identityId: `seat-${colony}`, colony }));
const seat = (colony: number) => `seat-${colony}`;

/** Each colony's start area in fine tiles (grid scale 2), worked out by hand from the fixture: colony 0 top-left,
 * 1 top-right, 2 bottom-left, 3 bottom-right, each the mirror image of colony 0's. */
const FIXTURES: { name: string; map: MapDefinition; width: number; height: number; boxes: StartBox[] }[] = [
  { name: "64x64 fixture", map: QUADRANTS, width: 128, height: 128, boxes: [
    { x: 4, y: 8, width: 24, height: 30 }, { x: 100, y: 8, width: 24, height: 30 },
    { x: 4, y: 90, width: 24, height: 30 }, { x: 100, y: 90, width: 24, height: 30 }] },
  { name: "close fixture", map: CLOSE, width: 128, height: 96, boxes: [
    { x: 0, y: 0, width: 16, height: 16 }, { x: 112, y: 0, width: 16, height: 16 },
    { x: 0, y: 80, width: 16, height: 16 }, { x: 112, y: 80, width: 16, height: 16 }] },
];

const lobby = (map: MapDefinition) => new LobbyStart(SEED, quadrantConfig(map), SEATS, 0);
const inBox = (box: StartBox, x: number, y: number) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
const queenTile = (state: SimState, colony: number, queen = 0): StartTile => {
  const q = state.colonies[colony]!.queens![queen]!;
  return { tileX: Math.floor(q.queenX / SUB), tileY: Math.floor(q.queenY / SUB) };
};

/** Every tile of a box marked with the given terrain character in the seat's team view. */
function tilesMarked(window: LobbyStart, colony: number, mark: string): StartTile[] {
  const view = window.teamView(seat(colony), true)!;
  return view.terrain!.rows.flatMap((row, dy) => [...row].flatMap((cell, dx) =>
    cell === mark ? [{ tileX: view.box.x + dx, tileY: view.box.y + dy }] : []));
}

/** The tiles just outside a box on every side, corners included. */
function ringOutside(box: StartBox): StartTile[] {
  const ring: StartTile[] = [];
  for (let x = box.x - 1; x <= box.x + box.width; x++) ring.push({ tileX: x, tileY: box.y - 1 }, { tileX: x, tileY: box.y + box.height });
  for (let y = box.y; y < box.y + box.height; y++) ring.push({ tileX: box.x - 1, tileY: y }, { tileX: box.x + box.width, tileY: y });
  return ring;
}

/** The tiles on a box's inside edge. */
function insideEdge(box: StartBox): StartTile[] {
  const edge: StartTile[] = [];
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    if (x === box.x || y === box.y || x === box.x + box.width - 1 || y === box.y + box.height - 1) edge.push({ tileX: x, tileY: y });
  }
  return edge;
}

describe.each(FIXTURES)("nest picks for four colonies on the $name", ({ map, width, height, boxes }) => {
  it("gives each colony its own quadrant's start area as its pick box", () => {
    const window = lobby(map);
    expect([window.config.mapWidth, window.config.mapHeight]).toEqual([width, height]);
    for (const colony of COLONIES) expect(window.teamView(seat(colony))!.box).toEqual(boxes[colony]);
  });

  it("accepts a pick from every colony at once and starts each queen on its picked tile", () => {
    const window = lobby(map);
    const picks = COLONIES.map(colony => tilesMarked(window, colony, ".")[0]!);
    for (const colony of COLONIES) {
      expect(inBox(boxes[colony]!, picks[colony]!.tileX, picks[colony]!.tileY)).toBe(true);
      expect(window.pick(seat(colony), picks[colony]!.tileX, picks[colony]!.tileY, 0)).toEqual({ ok: true });
    }
    const state = window.finish(window.closesAt);
    expect(state.config.initialQueens).toEqual(picks.map(pick => [pick]));
    for (const colony of COLONIES) {
      expect(state.colonies[colony]!.queens).toHaveLength(1);
      expect(queenTile(state, colony)).toEqual(picks[colony]);
      expect(window.queenIdOf(seat(colony))).toBe(0);
    }
  });

  it("refuses every colony's picks just outside its box and in the old back-quarter strip, and none on its inside edge", () => {
    const window = lobby(map);
    for (const colony of COLONIES) {
      const box = boxes[colony]!;
      const edge = insideEdge(box).map(tile => window.pick(seat(colony), tile.tileX, tile.tileY, 0));
      expect(edge.filter(result => !result.ok && result.reason === "outside_box")).toEqual([]);
      expect(edge.some(result => result.ok)).toBe(true);
      for (const tile of ringOutside(box)) expect(window.pick(seat(colony), tile.tileX, tile.tileY, 0)).toEqual({ ok: false, reason: "outside_box" });
      // Inside today's two-colony strip (the outer quarter of the board's width), outside this colony's start area.
      const strip = { tileX: colony & 1 ? width - 1 - 20 : 20, tileY: 40 };
      expect(inBox(box, strip.tileX, strip.tileY)).toBe(false);
      expect(window.pick(seat(colony), strip.tileX, strip.tileY, 0)).toEqual({ ok: false, reason: "outside_box" });
    }
  });

  it("gives every colony that does not pick a free default inside its own box, each the mirror of colony 0's", () => {
    const window = lobby(map);
    const state = window.finish(window.closesAt);
    const tiles = COLONIES.map(colony => queenTile(state, colony));
    for (const colony of COLONIES) {
      const { tileX, tileY } = tiles[colony]!;
      expect(inBox(boxes[colony]!, tileX, tileY)).toBe(true);
      expect(isBlockedTile(state.terrain, tileX, tileY)).toBe(false);
      expect(state.food[tileY * width + tileX]).toBe(0);
    }
    const { tileX, tileY } = tiles[0]!;
    expect(tiles.slice(1)).toEqual([
      { tileX: width - 1 - tileX, tileY }, { tileX, tileY: height - 1 - tileY }, { tileX: width - 1 - tileX, tileY: height - 1 - tileY }]);
  });

  it("replays the picked start from its stored config and keeps colony 2 and 3 picks over a handover", () => {
    const window = lobby(map);
    const two = tilesMarked(window, 2, ".")[3]!, three = tilesMarked(window, 3, ".")[5]!;
    expect(window.pick(seat(2), two.tileX, two.tileY, 0)).toEqual({ ok: true });
    expect(window.pick(seat(3), three.tileX, three.tileY, 0)).toEqual({ ok: true });
    const reopened = LobbyStart.reopen(SEED, window.save(0), 0);
    expect(reopened.teamView(seat(2))!.picks).toEqual([{ identityId: seat(2), ...two }]);
    expect(reopened.teamView(seat(3))!.picks).toEqual([{ identityId: seat(3), ...three }]);
    const state = reopened.finish(reopened.closesAt);
    expect(queenTile(state, 2)).toEqual(two);
    expect(queenTile(state, 3)).toEqual(three);
    expect(stateHash(createMatch(SEED, state.config))).toBe(stateHash(state));
  });

  it("refuses a stored layout with a nest outside its colony's start area", () => {
    const window = lobby(map);
    const state = window.finish(window.closesAt);
    const layout = state.config.initialQueens!.map(team => [...team]);
    layout[2] = [{ tileX: boxes[2]!.x - 1, tileY: boxes[2]!.y }];
    expect(() => createMatch(SEED, { ...state.config, initialQueens: layout })).toThrow("Invalid initial queen tile");
  });
});

describe("nest picks for four colonies, refusals that do not depend on the start area", () => {
  it("refuses colony 2 and 3 picks on food, after the window closes and from an unseated key", () => {
    const window = lobby(QUADRANTS);
    for (const colony of [2, 3]) {
      const food = tilesMarked(window, colony, "f")[0]!;
      expect(window.pick(seat(colony), food.tileX, food.tileY, 0)).toEqual({ ok: false, reason: "food" });
      const free = tilesMarked(window, colony, ".")[0]!;
      expect(window.pick(seat(colony), free.tileX, free.tileY, window.closesAt)).toEqual({ ok: false, reason: "window_closed" });
    }
    expect(window.pick("seat-9", 4, 90, 0)).toEqual({ ok: false, reason: "not_seated" });
  });
});

describe("start ants on the close fixture, picks far from the nests", () => {
  it("starts each colony's ants on its own start area's land tiles nearest its picked queen", () => {
    const { width, height, boxes } = FIXTURES[1]!;
    const window = lobby(CLOSE);
    // The box corners farthest from the nests, which sit well outside the start areas.
    const picks = [{ tileX: 0, tileY: 0 }, { tileX: width - 1, tileY: 0 }, { tileX: 0, tileY: height - 1 }, { tileX: width - 1, tileY: height - 1 }];
    for (const colony of COLONIES) expect(window.pick(seat(colony), picks[colony]!.tileX, picks[colony]!.tileY, 0)).toEqual({ ok: true });
    const state = window.finish(window.closesAt);
    for (const colony of COLONIES) {
      const box = boxes[colony]!, queen = picks[colony]!;
      const distance = (x: number, y: number) => (x - queen.tileX) ** 2 + (y - queen.tileY) ** 2;
      const ants = state.ants.filter(ant => ant.colony === colony).map(ant => ({ x: Math.floor(ant.x / SUB), y: Math.floor(ant.y / SUB) }));
      expect(ants).toHaveLength(state.config.startAnts);
      for (const { x, y } of ants) {
        expect(inBox(box, x, y)).toBe(true);
        expect(isBlockedTile(state.terrain, x, y)).toBe(false);
      }
      const occupied = new Set(ants.map(({ x, y }) => `${x},${y}`));
      const farthest = Math.max(...ants.map(({ x, y }) => distance(x, y)));
      for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
        if (!occupied.has(`${x},${y}`) && !isBlockedTile(state.terrain, x, y)) expect(distance(x, y)).toBeGreaterThanOrEqual(farthest);
      }
    }
  });
});

describe("a four-colony start without picks", () => {
  it("is unchanged: the same tick-zero state as before nest picks reached four colonies", () => {
    expect(stateHash(createMatch(SEED, quadrantConfig(QUADRANTS)))).toBe("4b781fa20511119d");
    expect(stateHash(createMatch(SEED, quadrantConfig(CLOSE)))).toBe("4436dee1f06f80b0");
  });
});
