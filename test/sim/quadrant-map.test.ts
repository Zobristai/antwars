import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG, rulesConfig, withoutHousePausedMaps, type MapDefinition, type QuadrantLayout, type SimConfig, type WaterRect } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch, matchConfigForMap } from "../../src/sim/map.js";
import { generateQuadrantBoard, validateQuadrantMap, type QuadrantBoard } from "../../src/sim/quadrantMap.js";
import { tuningMapConfig } from "../../src/sim/tuningMap.js";

/** Test-only quadrant geometry, not a production map. Nest, water, start area and food all sit off both
 * mirror axes and off the diagonal, so a dropped, swapped or transposed mirror shows. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
    centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
  },
};
const layout = FIXTURE.quadrant!;
const withLayout = (change: Partial<QuadrantLayout>, water: readonly WaterRect[] = FIXTURE.water): MapDefinition =>
  ({ ...FIXTURE, water, quadrant: { ...layout, ...change } });

/** 20x20 with a 4x4 centre: water leaves one corridor from the top-left nest to the centre, and one tile beside
 * it, (7, 9), is the only spot outside the nest clearance whose rocks cut nothing off. */
const ONE_ROCK_SPOT: MapDefinition = {
  id: "fixture-one-rock", name: "Fixture One Rock",
  water: [{ x: 8, y: 0, width: 2, height: 8 }, { x: 7, y: 0, width: 1, height: 6 }, { x: 0, y: 7, width: 7, height: 3 }],
  quadrant: { referenceWidth: 20, referenceHeight: 20, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 3, nestTileY: 3,
    startArea: { x: 0, y: 0, width: 5, height: 5 }, foodPatches: [], centreFood: [{ radius: 1, perTile: 3 }] },
};

const SEEDS = Array.from({ length: 100 }, (_, seed) => seed);
const GUARD = "fixture-quadrants: a quadrant map plays only in a four-colony rotation";

const mirrorX = (b: QuadrantBoard, r: WaterRect) => ({ ...r, x: b.width - r.x - r.width });
const mirrorY = (b: QuadrantBoard, r: WaterRect) => ({ ...r, y: b.height - r.y - r.height });
/** The four images of each top-left element: the list as a template's copies in quadrant order. */
function expectFourWay<T>(list: readonly T[], images: (item: T) => readonly T[]): void {
  expect(list.length % 4).toBe(0);
  for (let i = 0; i < list.length; i += 4) expect(list.slice(i, i + 4)).toEqual(images(list[i]!));
}
const rectImages = (b: QuadrantBoard) => (r: WaterRect) => [r, mirrorX(b, r), mirrorY(b, r), mirrorX(b, mirrorY(b, r))];

/** Raster of everything but the centre food, built only from the board's lists: 1 water, 2 rock, 10 + amount food. */
function raster(b: QuadrantBoard): number[][] {
  const grid = Array.from({ length: b.height }, () => Array.from({ length: b.width }, () => 0));
  const fill = (rects: readonly WaterRect[], value: number) => {
    for (const r of rects) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) grid[y]![x] = value;
  };
  fill(b.water, 1); fill(b.rocks, 2);
  for (const p of b.quadrantFood) for (let y = p.tileY - p.radius; y <= p.tileY + p.radius; y++) {
    for (let x = p.tileX - p.radius; x <= p.tileX + p.radius; x++) {
      if ((x - p.tileX) ** 2 + (y - p.tileY) ** 2 <= p.radius ** 2) grid[y]![x] = Math.max(grid[y]![x]!, 10 + p.perTile);
    }
  }
  return grid;
}

/** Centre food per tile as it is laid today: overlapping disks take the larger amount. */
function centreRaster(b: QuadrantBoard): string {
  const tiles = new Map<string, number>();
  for (const p of b.centreFood) for (let y = p.tileY - p.radius; y <= p.tileY + p.radius; y++) {
    for (let x = p.tileX - p.radius; x <= p.tileX + p.radius; x++) {
      if ((x - p.tileX) ** 2 + (y - p.tileY) ** 2 <= p.radius ** 2) tiles.set(`${x},${y}`, Math.max(tiles.get(`${x},${y}`) ?? 0, p.perTile));
    }
  }
  return JSON.stringify([...tiles].sort());
}

/** This test's own flood fill over land (not water, not rock), from the first nest. */
function reachable(b: QuadrantBoard): Set<string> {
  const blocked = new Set<string>();
  for (const r of [...b.water, ...b.rocks]) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) blocked.add(`${x},${y}`);
  const start = b.nests[0]!, seen = new Set([`${start.tx},${start.ty}`]), queue = [[start.tx, start.ty]];
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    for (const [nx, ny] of [[x! - 1, y!], [x! + 1, y!], [x!, y! - 1], [x!, y! + 1]]) {
      const key = `${nx},${ny}`;
      if (nx! < 0 || ny! < 0 || nx! >= b.width || ny! >= b.height || blocked.has(key) || seen.has(key)) continue;
      seen.add(key); queue.push([nx!, ny!]);
    }
  }
  return seen;
}

describe("quadrant map definitions", () => {
  it("the fixture is off both mirror axes and off the diagonal", () => {
    expect(layout.nestTileX).not.toBe(layout.nestTileY);
    const grid = raster(generateQuadrantBoard(FIXTURE, 0));
    // Square board: a transposed layout would differ from this one.
    expect(grid).not.toEqual(grid[0]!.map((_, x) => grid.map(row => row[x]!)));
  });

  it("accepts a quadrant layout of water, nest, start area, food templates and a centre region", () => {
    expect(() => validateQuadrantMap(FIXTURE)).not.toThrow();
    expect(() => validateQuadrantMap(ONE_ROCK_SPOT)).not.toThrow();
  });

  it.each([
    ["water rectangles", withLayout({}, [{ x: 30, y: 2, width: 4, height: 2 }]), withLayout({}, [{ x: 22, y: 24, width: 4, height: 4 }])],
    ["the nest", withLayout({ nestTileX: 33 }), withLayout({ nestTileX: 25, nestTileY: 27 })],
    ["the start area", withLayout({ startArea: { x: 2, y: 4, width: 12, height: 30 } }), withLayout({ startArea: { x: 20, y: 20, width: 8, height: 8 } })],
    ["food templates", withLayout({ foodPatches: [{ tileX: 31, tileY: 5, radius: 2, perTile: 1 }] }),
      withLayout({ foodPatches: [{ tileX: 23, tileY: 25, radius: 2, perTile: 1 }] })],
  ])("refuses %s that leave the quadrant or overlap the centre region", (kind, leaving, overlapping) => {
    expect(() => validateQuadrantMap(leaving)).toThrow(`fixture-quadrants: ${kind} must lie inside the top-left quadrant`);
    expect(() => validateQuadrantMap(overlapping)).toThrow(`fixture-quadrants: ${kind} must not overlap the centre region`);
  });

  it("refuses a centre with no food disk, or a disk that does not fit it", () => {
    expect(() => validateQuadrantMap(withLayout({ centreFood: [] }))).toThrow("fixture-quadrants: the centre needs at least one food disk");
    // The centre is 16 x 12: a radius-6 disk spans 13 rows.
    expect(() => validateQuadrantMap(withLayout({ centreFood: [{ radius: 6, perTile: 1 }] })))
      .toThrow("fixture-quadrants: centre food disks must fit inside the centre region");
  });

  it("refuses a nest that water cuts off from the other nests and the centre", () => {
    const walled = [...FIXTURE.water, { x: 5, y: 9, width: 5, height: 1 }, { x: 5, y: 13, width: 5, height: 1 },
      { x: 5, y: 10, width: 1, height: 3 }, { x: 9, y: 10, width: 1, height: 3 }];
    expect(() => validateQuadrantMap(withLayout({}, walled))).toThrow("fixture-quadrants: the four nests and the centre must share one land region");
  });

  it("refuses a map with no room for a rock", () => {
    const full = { ...ONE_ROCK_SPOT, water: [...ONE_ROCK_SPOT.water, { x: 7, y: 9, width: 1, height: 1 }] };
    expect(() => validateQuadrantMap(full)).toThrow(/^fixture-one-rock: no room for a rock/);
  });
});

describe("generated quadrant boards", () => {
  it.each(SEEDS)("seed %i: nests, start areas, water, rocks and quadrant food map onto one another under both mirrors", seed => {
    const b = generateQuadrantBoard(FIXTURE, seed);
    expect(b.nests).toEqual([{ tx: 7, ty: 11 }, { tx: 56, ty: 11 }, { tx: 7, ty: 52 }, { tx: 56, ty: 52 }]);
    expectFourWay(b.startAreas, rectImages(b));
    expectFourWay(b.water, rectImages(b));
    expect(b.water.length).toBe(4 * FIXTURE.water.length);
    expect(b.rocks.length).toBeGreaterThanOrEqual(4);
    expectFourWay(b.rocks, r => rectImages(b)(r).map((image, i) => ({ ...image, appearance: i % 2 === 1 ? r.appearance | 128 : r.appearance })));
    expectFourWay(b.quadrantFood, p => [p, { ...p, tileX: b.width - 1 - p.tileX }, { ...p, tileY: b.height - 1 - p.tileY },
      { ...p, tileX: b.width - 1 - p.tileX, tileY: b.height - 1 - p.tileY }]);
    // Independently of list order: every tile equals its left/right and up/down mirror.
    const grid = raster(b);
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
      expect([grid[y]![b.width - 1 - x], grid[b.height - 1 - y]![x]]).toEqual([grid[y]![x], grid[y]![x]]);
    }
  });

  it("places centre food from the seed inside the centre region: same seed, same layout; the layout varies with the seed", () => {
    const layouts = new Set<string>();
    for (const seed of SEEDS) {
      const b = generateQuadrantBoard(FIXTURE, seed);
      expect(generateQuadrantBoard(FIXTURE, seed)).toEqual(b);
      for (const p of b.centreFood) {
        expect(p.tileX - p.radius).toBeGreaterThanOrEqual(b.centre.x); expect(p.tileX + p.radius).toBeLessThan(b.centre.x + b.centre.width);
        expect(p.tileY - p.radius).toBeGreaterThanOrEqual(b.centre.y); expect(p.tileY + p.radius).toBeLessThan(b.centre.y + b.centre.height);
      }
      layouts.add(centreRaster(b));
    }
    expect(layouts.size).toBeGreaterThan(50);
  });

  it("keeps the centre food varying when a large rich disk can cover a small one", () => {
    // An 11-tile disk in the 16 x 12 centre with the larger amount, over a 3-tile disk.
    const covered = withLayout({ centreFood: [{ radius: 5, perTile: 9 }, { radius: 1, perTile: 1 }] });
    const layouts = new Set(SEEDS.map(seed => centreRaster(generateQuadrantBoard(covered, seed))));
    expect(layouts.size).toBeGreaterThan(5);
  });

  it.each(SEEDS)("seed %i: all four nests stay connected by land", seed => {
    const b = generateQuadrantBoard(FIXTURE, seed), land = reachable(b);
    for (const n of b.nests) expect(land.has(`${n.tx},${n.ty}`)).toBe(true);
  });

  it("accepts land that water cuts off from the nests, and still connects the nests and places rocks", () => {
    const pocket = withLayout({}, [...FIXTURE.water, { x: 1, y: 25, width: 5, height: 1 }, { x: 1, y: 29, width: 5, height: 1 },
      { x: 1, y: 26, width: 1, height: 3 }, { x: 5, y: 26, width: 1, height: 3 }]);
    expect(() => validateQuadrantMap(pocket)).not.toThrow();
    for (const seed of SEEDS.slice(0, 20)) {
      const b = generateQuadrantBoard(pocket, seed), land = reachable(b);
      expect(b.rocks.length).toBeGreaterThanOrEqual(4);
      for (const n of b.nests) expect(land.has(`${n.tx},${n.ty}`)).toBe(true);
      expect(land.has("3,27")).toBe(false);
    }
  });

  it("puts a rock on the one legal spot for every seed", () => {
    for (const seed of SEEDS) {
      const b = generateQuadrantBoard(ONE_ROCK_SPOT, seed);
      expect(b.rocks.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))).toEqual([
        { x: 7, y: 9, width: 1, height: 1 }, { x: 12, y: 9, width: 1, height: 1 },
        { x: 7, y: 10, width: 1, height: 1 }, { x: 12, y: 10, width: 1, height: 1 }]);
      const land = reachable(b);
      for (const n of b.nests) expect(land.has(`${n.tx},${n.ty}`)).toBe(true);
    }
  });
});

describe("existing modes never draw a quadrant map", () => {
  const live = newMatchConfig(rulesConfig("redesign"));
  const withQuadrant = (config: SimConfig): SimConfig => ({ ...config, terrain: { ...config.terrain!, maps: [...config.terrain!.maps, FIXTURE] } });

  it("no existing rotation holds one", () => {
    for (const config of [live, newMatchConfig(PUBLIC_CONFIG), withoutHousePausedMaps(live), tuningMapConfig(10)]) {
      expect(config.terrain!.maps.filter(map => map.quadrant !== undefined)).toEqual([]);
    }
  });

  it("refuses a valid quadrant map appended to the live rotation, at config, map draw and match", () => {
    expect(() => validateQuadrantMap(FIXTURE)).not.toThrow();
    const config = withQuadrant(live);
    expect(() => newMatchConfig(config)).toThrow(GUARD);
    expect(() => matchConfigForMap(1, config)).toThrow(GUARD);
    expect(() => createMatch(1, { ...config, terrain: { ...config.terrain!, mapId: FIXTURE.id } })).toThrow(GUARD);
  });
});
