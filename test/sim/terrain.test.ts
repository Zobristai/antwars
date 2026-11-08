import { describe, expect, it } from "vitest";
import { COUNT_MARK_RULES, DEFAULT_CONFIG, MAPS, PUBLIC_CONFIG, TERRAIN_RULES, SUB, speedPerTick } from "../../src/sim/config.js";
import { forageDirection, hatch, ARRIVE } from "../../src/sim/forage.js";
import { countMarkDirection } from "../../src/sim/agents.js";
import { markDirection } from "../../src/sim/marks.js";
import { routeToward } from "../../src/sim/navigation.js";
import { direction, tileCentre } from "../../src/sim/geometry.js";
import type { Terrain } from "../../src/sim/types.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { buildGrid, cloneState, createMatch, nestTile, newAnt } from "../../src/sim/map.js";
import { createTerrain, isBlockedTile, isPassable, isRockTile, isWaterTile, landBirthPosition, moveOnLand, segmentOnLand } from "../../src/sim/terrain.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: reference tile t is fine tiles 2t and 2t+1, and every length doubles.
/** Centre of the first fine tile inside reference tile ref. */
const at = (ref: number) => tileCentre(2 * ref);

export function mapConfig(mapId: string) {
  return playable({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, rocks: undefined, mapId } });
}

function reachable(state: ReturnType<typeof createMatch>, x: number, y: number): Set<number> {
  const width = state.config.mapWidth;
  const visited = new Set<number>([y * width + x]);
  const queue = [...visited];
  for (let i = 0; i < queue.length; i++) {
    const tile = queue[i]!, tx = tile % width, ty = Math.floor(tile / width);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = tx + dx!, ny = ty + dy!, next = ny * width + nx;
      if (isPassable(state, nx, ny) && !visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return visited;
}

describe("seed-selected mirrored maps", () => {
  it("chooses all three maps deterministically without consuming food/gameplay random draws", () => {
    const choices = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      // Keep this landed water-only invariant separate from rocks.test.ts.
      const config = playable({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, rocks: undefined } });
      const state = createMatch(seed, config);
      expect(state.terrain).toEqual(createTerrain(seed, config));
      choices.add(state.terrain!.mapId);
      // Isolate map choice from food-layout changes: masked seeded layouts may
      // legitimately place different patch footprints and consume different jitter draws.
      const withTerrain = createMatch(seed, playable({ ...DEFAULT_CONFIG, terrain: TERRAIN_RULES }));
      expect(withTerrain.rngState).toBe(createMatch(seed, playable(DEFAULT_CONFIG)).rngState);
    }
    expect(choices).toEqual(new Set(MAPS.map(m => m.id)));
    expect(() => createMatch(1, mapConfig("missing"))).toThrow("unknown terrain map");
  });

  it.each(MAPS)("$name: mirrored, connected land, reachable nests and contestable central flanks; food and starts dry", map => {
    const state = createMatch(7001, mapConfig(map.id));
    const { mapWidth: w, mapHeight: h } = state.config;
    const nest = nestTile(state.config, 0), enemy = nestTile(state.config, 1);
    // At grid scale 2 a nest centre lies on a fine-tile corner; use the fine tile containing it.
    const land = reachable(state, Math.floor(nest.tx), Math.floor(nest.ty));
    expect(land.has(Math.floor(enemy.ty) * w + Math.floor(enemy.tx))).toBe(true);
    let passable = 0, centre = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const water = isWaterTile(state.terrain, x, y);
      expect(water).toBe(isWaterTile(state.terrain, w - 1 - x, y));
      if (water) { expect(state.food[y * w + x]).toBe(0); expect(state.foodCap[y * w + x]).toBe(0); }
      else { passable++; if (x === w / 2 && land.has(y * w + x)) centre++; }
      expect(state.food[y * w + x]).toBe(state.food[y * w + w - 1 - x]);
    }
    expect(land.size).toBe(passable);
    expect(centre).toBeGreaterThan(0);
    for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    expect(cloneState(state).terrain).toBe(state.terrain);
    expect(Object.isFrozen(state.terrain!.water)).toBe(true);
  });

  it("Three Crossings has three four-tile bridges; Central Lake has two three-tile flanking pinch points", () => {
    const river = createMatch(0, mapConfig("three-crossings"));
    const lake = createMatch(0, mapConfig("central-lake"));
    // Reference column 31 is fine column 62; each reference row y is fine rows 2y and 2y + 1.
    const fine = (rows: number[]) => rows.flatMap(y => [2 * y, 2 * y + 1]);
    const rows = (s: typeof river) => Array.from({ length: 96 }, (_, y) => y).filter(y => isPassable(s, 62, y));
    expect(rows(river)).toEqual(fine([8,9,10,11,22,23,24,25,36,37,38,39]));
    expect(rows(lake)).toEqual(fine([12,13,14,33,34,35]));
    expect(isPassable(lake, 62, 48)).toBe(false);
  });

  it("historical configs contain no terrain or extra fields and replay without changing their hashes", () => {
    const initial = createMatch(11, playable(DEFAULT_CONFIG));
    expect(initial).not.toHaveProperty("terrain");
    expect(stateHash(initial)).toBe(stateHash(replay([headerLine(11, playable(DEFAULT_CONFIG))], 0)));
  });
});

describe("water-only routing and legality", () => {
  it.each(MAPS)("$name: both colonies route around water to the opposing nest deterministically", map => {
    const state = createMatch(7001, mapConfig(map.id));
    for (const colony of [0, 1] as const) {
      const own = nestTile(state.config, colony), target = nestTile(state.config, colony === 0 ? 1 : 0);
      const initial = newAnt(state.config, 1, colony, tileCentre(own.tx), tileCentre(own.ty));
      const a = { ...initial }, b = { ...initial }, speed = speedPerTick(state.config);
      let ticks = 0;
      const remaining = () => Math.hypot(a.x - tileCentre(target.tx), a.y - tileCentre(target.ty));
      while (remaining() > ARRIVE && ticks++ < 2000) {
        const old = { x: a.x, y: a.y };
        moveOnLand(state.config, state.terrain!, a, routeToward(state, a, tileCentre(target.tx), tileCentre(target.ty)), speed);
        moveOnLand(state.config, state.terrain!, b, routeToward(state, b, tileCentre(target.tx), tileCentre(target.ty)), speed);
        expect(a).toEqual(b);
        expect(isPassable(state, Math.floor(a.x / SUB), Math.floor(a.y / SUB))).toBe(true);
        expect(segmentOnLand(state.config, state.terrain, old.x, old.y, a.x, a.y)).toBe(true);
        expect(Math.hypot(a.x - old.x, a.y - old.y)).toBeLessThanOrEqual(speed + 1);
      }
      expect(remaining()).toBeLessThanOrEqual(ARRIVE);
    }
  });

  it.each(MAPS)("$name: forage, carrying home and both point-mark paths use water-aware goals", map => {
    const state = createMatch(7001, mapConfig(map.id)), config = state.config;
    state.food.fill(0);
    // Reference food tile (44, 24) is fine tiles 88-89 x 48-49; its food lives in the first fine tile.
    const foodTile = 48 * config.mapWidth + 88;
    state.food[foodTile] = 10;
    const speed = speedPerTick(config), home = nestTile(config, 0);
    const mark = { id: 1, agentId: "a", colony: 0 as const, tileX: 88, tileY: 48,
      words: ["GATHER" as const], laidTick: 0, steering: 0 };
    for (const mode of ["forage", "word", "count"] as const) {
      const ant = newAnt(config, 1, 0, tileCentre(home.tx), tileCentre(home.ty));
      state.ants = [ant];
      let ticks = 0;
      while (Math.floor(ant.x / SUB / 2) !== 44 || Math.floor(ant.y / SUB / 2) !== 24) {
        const dir = mode === "forage" ? forageDirection(state, ant, [foodTile]) : mode === "word" ? markDirection(mark, ant, state)
          : countMarkDirection({ ...state, config: { ...config, countMarks: COUNT_MARK_RULES } },
            buildGrid(state), [foodTile], ant, { ...mark, verb: "GATHER", count: 1 }).dir;
        moveOnLand(config, state.terrain!, ant, dir, speed);
        expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
        if (++ticks > 2000) break;
      }
      expect([Math.floor(ant.x / SUB / 2), Math.floor(ant.y / SUB / 2)]).toEqual([44, 24]);
      if (mode !== "forage") continue;
      ant.carrying = true; ticks = 0;
      // The arrival radius is a length: 2 x ARRIVE at grid scale 2.
      while (Math.hypot(ant.x - tileCentre(home.tx), ant.y - tileCentre(home.ty)) > 2 * ARRIVE && ticks++ < 2000) {
        moveOnLand(config, state.terrain!, ant, forageDirection(state, ant, [foodTile]), speed);
        expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
      }
      expect(Math.hypot(ant.x - tileCentre(home.tx), ant.y - tileCentre(home.ty))).toBeLessThanOrEqual(2 * ARRIVE);
    }
  });

  it("rejects a swept water crossing even when the destination is land, and refuses diagonal corner cutting", () => {
    const config = playable(DEFAULT_CONFIG);
    const terrain: Terrain = { mapId: "corner", mapName: "Corner", water: [{ x: 22, y: 20, width: 2, height: 2 }] };
    // Reference tile centres are fine-tile corners at grid scale 2: centre(t) = (2t + 1) x SUB.
    const centre = (ref: number) => (2 * ref + 1) * SUB;
    const ant = newAnt(config, 1, 0, centre(10), centre(10));
    expect(segmentOnLand(config, terrain, ant.x, ant.y, centre(12), centre(10))).toBe(false);
    expect(segmentOnLand(config, terrain, ant.x, ant.y, centre(11), centre(11))).toBe(false);
    moveOnLand(config, terrain, ant, direction(1, 0), 4 * SUB);
    expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([centre(10), centre(10), 0, 0]);
    // 2827 is the two-tile diagonal speed whose step is exactly diagonal (1999, 1999), so the swept
    // segment passes through the water tile's corner, as the reference one-tile step (1000, 1000) did.
    moveOnLand(config, terrain, ant, direction(1, 1), 2827);
    expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([centre(10), centre(10), 0, 0]);
  });

  it("holds an unreachable land goal instead of entering water", () => {
    const state = { ...createMatch(1, playable(DEFAULT_CONFIG)),
      terrain: { mapId: "wall", mapName: "Wall", water: [{ x: 20, y: 0, width: 2, height: 96 }] } };
    const ant = newAnt(state.config, 1, 0, at(8), at(24));
    expect(routeToward(state, ant, at(20), at(24))).toEqual({ x: 0, y: 0 });
  });

  it("births use dry land inside nest reach, or wait without debiting food or consuming an id", () => {
    // The reference nest tile (8, 24) is fine tiles 16-17 x 48-49; its centre is the fine corner (17, 49).
    const terrain: Terrain = { mapId: "wet-nest", mapName: "Wet nest", water: [{ x: 16, y: 48, width: 2, height: 2 }] };
    const config = playable({ ...DEFAULT_CONFIG, nestDeliverTiles: 1 });
    const position = landBirthPosition(config, terrain, 17 * SUB, 49 * SUB, 0)!;
    expect(isWaterTile(terrain, Math.floor(position.x / SUB), Math.floor(position.y / SUB))).toBe(false);
    expect(Math.max(Math.abs(Math.floor(position.x / SUB / 2) - 8), Math.abs(Math.floor(position.y / SUB / 2) - 24))).toBeLessThanOrEqual(1);
    const state = { ...createMatch(1, { ...config, nestDeliverTiles: 0 }), terrain };
    state.ants = []; state.colonies[0].foodStore = config.hatchCost;
    const before = { store: state.colonies[0].foodStore, id: state.nextAntId, tick: state.colonies[0].lastHatchTick };
    hatch(state, 0, []);
    expect(state.ants).toHaveLength(0);
    expect({ store: state.colonies[0].foodStore, id: state.nextAntId, tick: state.colonies[0].lastHatchTick }).toEqual(before);
  });
});

describe("water and rock tile lookup", () => {
  // The earlier rectangle scans, kept here as the reference every answer must match.
  type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  const inside = (rects: readonly Rect[] | undefined, x: number, y: number) =>
    rects?.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) ?? false;
  function expectScanAnswers(terrain: Terrain, xs: readonly number[], ys: readonly number[]) {
    const mismatches: string[] = [];
    for (const y of ys) for (const x of xs) {
      const water = inside(terrain.water, x, y), rock = inside(terrain.rocks, x, y);
      if (isWaterTile(terrain, x, y) !== water || isRockTile(terrain, x, y) !== rock ||
        isBlockedTile(terrain, x, y) !== (water || rock)) mismatches.push(`${x},${y}`);
    }
    expect(mismatches).toEqual([]);
  }
  const span = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  const odd = [NaN, Infinity, -Infinity, -0, -0.5, 1e300];

  it.each(newMatchConfig(PUBLIC_CONFIG).terrain!.maps.map(m => m.id))("%s with its placed rocks: every tile, beyond the map edge and between tiles", mapId => {
    const base = newMatchConfig(PUBLIC_CONFIG);
    const state = createMatch(7, { ...base, terrain: { ...base.terrain!, mapId } });
    const terrain = state.terrain!, { mapWidth: w, mapHeight: h } = state.config;
    expect(terrain.rocks!.length).toBeGreaterThan(0);
    expectScanAnswers(terrain, [...span(-3, w + 3), ...odd], [...span(-3, h + 3), ...odd]);
    const fractions = span(-2, w + 2).flatMap(x => [x + 0.25, x + 0.999999, x - 1e-9]);
    expectScanAnswers(terrain, fractions, span(-2, h + 2).flatMap(y => [y + 0.5, y - 1e-9]));
    // cloneState shares the terrain object, so the lookup built for it serves every tick.
    expect(cloneState(state).terrain).toBe(terrain);
  });

  it("overlapping, empty, negative and out-of-map rectangles answer as the scan did", () => {
    const terrain: Terrain = { mapId: "odd", mapName: "Odd", water: [{ x: -4, y: 2, width: 6, height: 3 },
      { x: 1, y: 1, width: 0, height: 5 }, { x: 3, y: 3, width: -2, height: 2 }, { x: 40, y: -6, width: 3, height: 4 }],
    rocks: [{ x: 0, y: 3, width: 2, height: 2, appearance: 0 }, { x: 41, y: -5, width: 1, height: 1, appearance: 1 }] };
    expectScanAnswers(terrain, [...span(-8, 48), ...odd], [...span(-9, 12), ...odd]);
    expectScanAnswers({ mapId: "dry", mapName: "Dry", water: [] }, [-1, 0, 5], [-1, 0, 5]);
  });

  it("rectangles a grid cannot hold exactly keep the scan's answers", () => {
    const fractional: Terrain = { mapId: "half", mapName: "Half", water: [{ x: 1.5, y: 0, width: 2, height: 2.5 }] };
    expectScanAnswers(fractional, span(-2, 8).flatMap(x => [x, x + 0.5]), span(-2, 6).flatMap(y => [y, y + 0.5]));
    const unbounded: Terrain = { mapId: "sea", mapName: "Sea", water: [{ x: 0, y: 0, width: Infinity, height: 2 }],
      rocks: [{ x: 0, y: 4, width: 1e9, height: 1e9, appearance: 0 }] };
    expectScanAnswers(unbounded, [-1, 0, 7, 1e12, ...odd], [-1, 0, 1, 2, 4, 5, ...odd]);
  });
});
