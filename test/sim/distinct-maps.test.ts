import { describe, expect, it } from "vitest";
import { MAPS, PUBLIC_CONFIG, SUB, TERRAIN_RULES, rulesConfig, speedPerTick, withDistinctMaps, type MapDefinition } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { createMapShapes, newMatchMaps } from "../../src/sim/mapShapes.js";
import { createMatch, newAnt } from "../../src/sim/map.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { routeToward } from "../../src/sim/navigation.js";
import { step } from "../../src/sim/step.js";
import { createTerrain, isPassable, isWaterTile, moveOnLand, segmentOnLand } from "../../src/sim/terrain.js";
import { playable } from "../playable.ts";
import { sevenMapRotation } from "./seven-map-rotation.js";

function waterMask(map: MapDefinition, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const rect of map.water) {
    expect([rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)).toBe(true);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) mask[y * width + x]++;
    }
  }
  expect(mask.every(value => value <= 1)).toBe(true);
  return mask;
}

function connectedCount(mask: Uint8Array, width: number, value: number): number {
  const first = mask.indexOf(value);
  if (first < 0) return 0;
  const seen = new Uint8Array(mask.length), queue = [first];
  seen[first] = 1;
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!, x = at % width;
    const neighbours = [at - width, at + width, ...(x > 0 ? [at - 1] : []),
      ...(x + 1 < width ? [at + 1] : [])];
    for (const next of neighbours) {
      if (next >= 0 && next < mask.length && !seen[next] && mask[next] === value) {
        seen[next] = 1; queue.push(next);
      }
    }
  }
  return queue.length;
}

function dryBands(mask: Uint8Array, width: number, height: number): [number, number][] {
  const bands: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    if (mask[y * width + width / 2] !== 0) continue;
    const previous = bands[bands.length - 1];
    if (previous?.[1] === y) previous[1]++;
    else bands.push([y, y + 1]);
  }
  return bands;
}

// Every match plays at grid scale 2: scale is that one grid scale; grid scales 1 and 4 are retired.
describe.each([2] as const)("native map geometry at scale %i", scale => {
  const width = 64 * scale, height = 48 * scale;
  const maps = createMapShapes();

  it("keeps exactly the named three maps, bounded non-overlapping water and connected mirrored land", () => {
    expect(maps.map(map => [map.id, map.name])).toEqual(MAPS.map(map => [map.id, map.name]));
    for (const map of maps) {
      const mask = waterMask(map, width, height);
      const dry = mask.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
      expect(connectedCount(mask, width, 0)).toBe(dry);
      let mirrored = true;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (mask[y * width + x] !== mask[y * width + width - 1 - x]) mirrored = false;
      }
      expect(mirrored).toBe(true);
    }
  });

  it("leaves Open Field dry and Three Crossings with exactly three cross-river gaps", () => {
    expect(maps[0]!.water).toEqual([]);
    const river = waterMask(maps[1]!, width, height);
    expect(dryBands(river, width, height)).toEqual([[8, 12], [22, 26], [36, 40]]
      .map(([top, bottom]) => [top! * scale, bottom! * scale]));
    expect(river[width / 2]).toBe(1);
    expect(river[(height - 1) * width + width / 2]).toBe(1);
    // Every wet row has one river interval, and every crossing is a full land row.
    for (let y = 0; y < height; y++) {
      const row = river.subarray(y * width, (y + 1) * width);
      expect(row.reduce((sum, value) => sum + value, 0)).toBe(row[width / 2] ? 4 * scale : 0);
    }
  });

  it("makes Central Lake one central body with northern and southern land routes", () => {
    const lake = waterMask(maps[2]!, width, height);
    expect(connectedCount(lake, width, 1)).toBe(lake.reduce((sum, value) => sum + value, 0));
    expect(lake[(height / 2) * width + width / 2]).toBe(1);
    expect(dryBands(lake, width, height)).toEqual([[0, 12 * scale], [36 * scale, height]]);
    for (const y of [12 * scale - 1, 36 * scale]) {
      expect(lake.subarray(y * width, (y + 1) * width).every(value => value === 0)).toBe(true);
    }
    // Banks connect both complete horizontal routes, not merely isolated dry centre cells.
    for (let y = 0; y < height; y++) {
      expect(lake[y * width + 20 * scale]).toBe(0);
      expect(lake[y * width + 44 * scale]).toBe(0);
    }
  });

  it("steps the shoreline by single native tiles, never scaled-up coarse blocks", () => {
    const lake = waterMask(maps[2]!, width, height);
    const leftBanks: number[] = [];
    for (let y = 12 * scale; y < 36 * scale; y++) {
      leftBanks.push(lake.subarray(y * width, (y + 1) * width).indexOf(1));
    }
    const steps = leftBanks.slice(1).map((x, i) => Math.abs(x - leftBanks[i]!));
    expect(steps.every(step => step <= 1)).toBe(true);
    expect(steps.filter(step => step === 1).length).toBe(12 * scale);
    expect(new Set(leftBanks).size).toBeGreaterThan(2);
  });

  it("routes a straight-across traveller around a shore without crossing water", () => {
    // A geometry/navigation fixture, not a claim about the selected live rules.
    const config = { ...PUBLIC_CONFIG, gridScale: scale, mapWidth: width, mapHeight: height,
      startAnts: 0, foodPatches: [], foodLayout: undefined,
      terrain: { ...TERRAIN_RULES, maps, mapId: "central-lake", rocks: undefined,
        referenceWidth: width, referenceHeight: height } };
    const state = createMatch(7001, config);
    const ant = newAnt(config, 1, 0, tileCentre(20 * scale), tileCentre(24 * scale));
    const targetX = tileCentre(44 * scale), targetY = tileCentre(24 * scale);
    const speed = speedPerTick(PUBLIC_CONFIG) * scale;
    const shoreRows: number[] = [];
    expect(segmentOnLand(config, state.terrain, ant.x, ant.y, targetX, targetY)).toBe(false);
    for (let ticks = 0; ticks < 2000 && Math.hypot(ant.x - targetX, ant.y - targetY) > speed; ticks++) {
      const before = { x: ant.x, y: ant.y };
      moveOnLand(config, state.terrain!, ant, routeToward(state, ant, targetX, targetY), speed);
      expect(segmentOnLand(config, state.terrain, before.x, before.y, ant.x, ant.y)).toBe(true);
      if (Math.abs(ant.x / SUB - width / 2) < scale) shoreRows.push(Math.floor(ant.y / SUB));
    }
    expect(Math.hypot(ant.x - targetX, ant.y - targetY)).toBeLessThanOrEqual(speed);
    expect(shoreRows.length).toBeGreaterThan(0);
    expect(shoreRows.every(y => y < 12 * scale || y >= 36 * scale)).toBe(true);
  });

  it("materialized rectangles survive JSON and the existing terrain decoder exactly", () => {
    for (const map of maps) {
      const config = { ...PUBLIC_CONFIG, gridScale: scale, mapWidth: width, mapHeight: height,
        terrain: { ...TERRAIN_RULES, referenceWidth: width, referenceHeight: height,
          maps: JSON.parse(JSON.stringify(maps)) as MapDefinition[], mapId: map.id } };
      const terrain = createTerrain(7001, config)!;
      expect(terrain.water).toEqual(map.water);
      const decoded = Uint8Array.from({ length: width * height }, (_, i) =>
        Number(isWaterTile(terrain, i % width, Math.floor(i / width))));
      expect(decoded).toEqual(waterMask(map, width, height));
    }
  });
});

it.each([2] as const)("a real squad go_to crosses around a shore at scale %i", scale => {
  // Isolate the squad from spawning/guards; movement and physical scaling use
  // the actual redesign rules and the shipped new-match factory.
  const base = { ...rulesConfig("redesign"), startAnts: 6, colonyCap: 6,
    guardCount: 0, guardSharePermille: 0,
    terrain: { ...TERRAIN_RULES, mapId: "central-lake", rocks: undefined } };
  // Pinned to the seven-map rotation this was written for, which holds the old Central Lake.
  const config = sevenMapRotation(newMatchConfig(base));
  let state = createMatch(7001, config);
  state.ants = state.ants.filter(ant => ant.colony === 0);
  for (const [index, ant] of state.ants.entries()) {
    ant.x = tileCentre(20 * scale); ant.y = tileCentre((22 + index % 3) * scale);
    ant.role = "forager";
  }
  for (const colony of state.colonies) colony.foodStore = 0;
  const joined = step(state, [{ type: "join", agentId: "lake-squad", colony: 0 }]);
  expect(joined.results[0]!.ok).toBe(true);
  const ordered = step(joined.state, [{ type: "order", agentId: "lake-squad",
    order: { kind: "go_to", tileX: 44 * scale, tileY: 24 * scale } }]);
  expect(ordered.results[0]!.ok).toBe(true);
  state = ordered.state;
  const ids = state.agents.find(agent => agent.id === "lake-squad")!.squad;
  expect(ids).toHaveLength(3); // The normal 50% squad-supply limit still applies.
  const crossed = new Set<number>();
  const arrived = () => ids.every(id => {
    const ant = state.ants.find(candidate => candidate.id === id)!;
    return Math.hypot(ant.x - tileCentre(44 * scale), ant.y - tileCentre(24 * scale)) < SUB * scale;
  });
  for (let tick = 0; tick < 1800 && !arrived(); tick++) {
    const previous = new Map(state.ants.map(ant => [ant.id, { x: ant.x, y: ant.y }]));
    state = step(state).state;
    for (const id of ids) {
      const ant = state.ants.find(candidate => candidate.id === id)!;
      expect(ant).toBeDefined();
      const before = previous.get(id)!;
      expect(segmentOnLand(config, state.terrain, before.x, before.y, ant.x, ant.y)).toBe(true);
      if (Math.abs(ant.x / SUB - 32 * scale) < scale) {
        expect(ant.y < 12 * SUB * scale || ant.y >= 36 * SUB * scale).toBe(true);
        crossed.add(id);
      }
    }
  }
  expect(arrived()).toBe(true);
  expect(crossed.size).toBe(ids.length);
}, 30_000);

describe.each([2] as const)("generated map placements at scale %i", () => {
  for (const map of createMapShapes()) it.each([7001, 7002, 7003, 7004])(`${map.name} starts dry for seed %i`, seed => {
    const base = { ...rulesConfig("redesign"), terrain: { ...TERRAIN_RULES, mapId: map.id } };
    // Pinned to the seven-map rotation this was written for, which holds the three shapes.
    const config = sevenMapRotation(newMatchConfig(base));
    const state = createMatch(seed, config);
    const width = config.mapWidth, height = config.mapHeight;
    const blocked = Uint8Array.from({ length: width * height }, (_, i) =>
      Number(!isPassable(state, i % width, Math.floor(i / width))));
    expect(connectedCount(blocked, width, 0)).toBe(blocked.reduce((n, value) => n + Number(value === 0), 0));
    for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    for (const colony of state.colonies) {
      expect(isPassable(state, Math.floor(colony.queenX / SUB), Math.floor(colony.queenY / SUB))).toBe(true);
    }
    expect(state.food.every((food, i) => food === 0 || blocked[i] === 0)).toBe(true);
    expect(state.terrain!.rocks!.length).toBeGreaterThan(0);
    for (const rock of state.terrain!.rocks!) {
      for (let y = rock.y; y < rock.y + rock.height; y++) for (let x = rock.x; x < rock.x + rock.width; x++) {
        expect(isWaterTile(state.terrain, x, y)).toBe(false);
      }
    }
  });
});

describe("finished maps with the real eight-seat start", () => {
  for (const map of MAPS) it.each([7001, 7002, 7003, 7004])(`${map.name} finalizes eight dry nests for seed %i`, seed => {
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    const config = sevenMapRotation(newMatchConfig({ ...rulesConfig("redesign"), terrain: { ...TERRAIN_RULES, mapId: map.id } }));
    expect([config.mapWidth, config.mapHeight, config.gridScale]).toEqual([128, 96, 2]);
    const seats = Array.from({ length: 4 }, (_, n) => [
      { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
    ]).flat();
    const lobby = new LobbyStart(seed, config, seats, 0);
    const state = lobby.finish(lobby.closesAt);
    const nests = state.colonies.flatMap(colony => colony.queens!);
    expect(nests).toHaveLength(8);
    for (const queen of nests) expect(isPassable(state, Math.floor(queen.queenX / SUB), Math.floor(queen.queenY / SUB))).toBe(true);
    for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    expect(state.food.every((food, tile) => food === 0 || isPassable(state, tile % config.mapWidth, Math.floor(tile / config.mapWidth)))).toBe(true);
    for (const rock of state.terrain!.rocks!) for (let y = rock.y; y < rock.y + rock.height; y++) {
      for (let x = rock.x; x < rock.x + rock.width; x++) expect(isWaterTile(state.terrain, x, y)).toBe(false);
    }
    const width = config.mapWidth, height = config.mapHeight;
    const tileOf = (queen: typeof nests[number]) => Math.floor(queen.queenY / SUB) * width + Math.floor(queen.queenX / SUB);
    // Block one shore at a time: both real nest banks must still connect by the
    // other, with the generated rocks included rather than removed for the proof.
    for (const shore of map.id === "central-lake" ? ["north", "south"] : ["either"]) {
      const allowed = (tile: number) => {
        const y = Math.floor(tile / width);
        return isPassable(state, tile % width, y) && (shore !== "north" || y < 72) && (shore !== "south" || y >= 24);
      };
      const seen = new Set<number>(), queue = [tileOf(nests[0]!)];
      seen.add(queue[0]!);
      for (let i = 0; i < queue.length; i++) {
        const at = queue[i]!, x = at % width;
        for (const next of [at - width, at + width, ...(x > 0 ? [at - 1] : []), ...(x < width - 1 ? [at + 1] : [])]) {
          if (next < 0 || next >= width * height || seen.has(next) || !allowed(next)) continue;
          seen.add(next); queue.push(next);
        }
      }
      for (const nest of nests) expect(seen.has(tileOf(nest))).toBe(true);
    }
  });
});

it.each([2] as const)("explicit map opt-in preserves all non-map configuration at scale %i", scale => {
  const config = { ...PUBLIC_CONFIG, gridScale: scale, mapWidth: 64 * scale, mapHeight: 48 * scale,
    terrain: { ...TERRAIN_RULES, mapId: "central-lake" } };
  const before = JSON.stringify(config);
  const changed = withDistinctMaps(config);
  expect(changed).toEqual({ ...config, terrain: { ...config.terrain,
    maps: newMatchMaps(), referenceWidth: 64 * scale, referenceHeight: 48 * scale } });
  expect(changed.terrain!.rocks).toBe(config.terrain.rocks);
  expect(JSON.stringify(config)).toBe(before);
  // Drawn from the seven-map rotation this was written for, which holds the old Central Lake.
  expect(createTerrain(7001, sevenMapRotation(changed))!.water).toEqual(createMapShapes()[2]!.water);
});

it("refuses an inconsistent map opt-in instead of inferring scale from dimensions", () => {
  expect(() => withDistinctMaps({ ...PUBLIC_CONFIG, gridScale: 2 })).toThrow("explicit scale");
  // Without an explicit grid scale the dimensions are never read: the missing marker is refused.
  expect(() => withDistinctMaps({ ...PUBLIC_CONFIG, mapWidth: 128, mapHeight: 96 })).toThrow("grid scale missing");
  expect(() => withDistinctMaps({ ...playable(PUBLIC_CONFIG), terrain: undefined })).toThrow("terrain rules");
  expect(withDistinctMaps(playable(PUBLIC_CONFIG)).terrain!.maps).toEqual(newMatchMaps());
});

it("constructing new shapes never rewrites historical definitions or aliases mutable arrays", () => {
  const before = JSON.stringify(MAPS);
  const a = createMapShapes(), b = createMapShapes();
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
  expect(a[2]!.water).not.toBe(b[2]!.water);
  expect(JSON.stringify(MAPS)).toBe(before);
});
