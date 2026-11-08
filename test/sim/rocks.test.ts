import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator, fillSquads, foundQueen } from "../../src/sim/agents.js";
import { DEFAULT_CONFIG, MAPS, PUBLIC_CONFIG, ROCK_RULES, SUB, TERRAIN_RULES, rulesConfig, speedPerTick } from "../../src/sim/config.js";
import { hatch, ARRIVE } from "../../src/sim/forage.js";
import { direction, tileCentre } from "../../src/sim/geometry.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { cloneState, createMatch, nestTile, newAnt } from "../../src/sim/map.js";
import { routeToward } from "../../src/sim/navigation.js";
import { step } from "../../src/sim/step.js";
import { addRocks, createTerrain, isPassable, isRockTile, isWaterTile, landBirthPosition, moveOnLand, passableMask, segmentOnLand, terrainView } from "../../src/sim/terrain.js";
import type { SimEvent, Terrain } from "../../src/sim/types.js";
import { PRE_FRONTLINE_PUBLIC_CONFIG, HISTORICAL_PUBLIC_CONFIG } from "./fixtures.js";
import { playable } from "../playable.ts";

/** Centre of the first grid-scale-2 fine tile inside reference tile ref (2 fine tiles per reference tile). */
const at = (ref: number) => tileCentre(2 * ref);

function reachable(state: ReturnType<typeof createMatch>): Set<number> {
  const { mapWidth: w, mapHeight: h } = state.config, nest = nestTile(state.config, 0);
  // At grid scale 2 the nest centre lies on a fine-tile corner; start from the fine tile containing it.
  const queue = [Math.floor(nest.ty) * w + Math.floor(nest.tx)], seen = new Set(queue);
  for (let read = 0; read < queue.length; read++) {
    const tile = queue[read]!, x = tile % w, y = Math.floor(tile / w);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      const next = ny! * w + nx!;
      if (nx! < 0 || ny! < 0 || nx! >= w || ny! >= h || seen.has(next) || !isPassable(state, nx!, ny!)) continue;
      seen.add(next); queue.push(next);
    }
  }
  return seen;
}

// One reference rock tile (11, 10) is a 2x2 block of fine tiles at grid scale 2.
const rockTerrain: Terrain = { mapId: "rock-only", mapName: "Rock only", water: [], rocks: [{ x: 22, y: 20, width: 2, height: 2, appearance: 0 }] };

describe("seeded mirrored rock placement", () => {
  it.each(MAPS)("$name: seeds preserve food/RNG, mirrored protected footprints and connected land", map => {
    const layouts = new Set<string>(), pairCounts = new Set<number>(), clusterSizes = new Set<number>(), appearances = new Set<number>();
    for (let seed = 0; seed < 12; seed++) {
      // Recorded reference-grid rock scenario, not the newMatchConfig boundary.
      const template = { ...PRE_FRONTLINE_PUBLIC_CONFIG, terrain: { ...PRE_FRONTLINE_PUBLIC_CONFIG.terrain!, mapId: map.id } };
      const config = playable(template);
      const state = createMatch(seed, config), again = createMatch(seed, config);
      const baseline = createMatch(seed, { ...config, terrain: { ...config.terrain!, rocks: undefined } });
      expect(state.terrain).toEqual(again.terrain);
      const rocks = state.terrain!.rocks!, pairs = rocks.length / 2;
      expect(pairs).toBeGreaterThanOrEqual(ROCK_RULES.minPairs); expect(pairs).toBeLessThanOrEqual(ROCK_RULES.maxPairs);
      pairCounts.add(pairs);
      for (let i = 0; i < rocks.length; i += 2) {
        const a = rocks[i]!, b = rocks[i + 1]!;
        // Reference tiles: each covers 2x2 fine tiles at grid scale 2.
        const tiles = a.width * a.height / 4;
        expect(tiles).toBeGreaterThanOrEqual(ROCK_RULES.minClusterTiles); expect(tiles).toBeLessThanOrEqual(ROCK_RULES.maxClusterTiles);
        expect(a.width === 2 || a.height === 2).toBe(true);
        expect(b).toEqual({ ...a, x: config.mapWidth - a.x - a.width, appearance: a.appearance | 128 });
        clusterSizes.add(tiles); appearances.add(a.appearance);
      }
      expect(state.food).toEqual(baseline.food); expect(state.foodCap).toEqual(baseline.foodCap);
      expect(state.config.foodPatches).toEqual(baseline.config.foodPatches);
      expect(state.rngState).toBe(baseline.rngState); expect(state.ants).toEqual(baseline.ants);
      expect(state.terrain!.water).toEqual(baseline.terrain!.water);
      expect(Object.isFrozen(state.terrain!.rocks)).toBe(true);
      expect(state.terrain!.rocks!.every(Object.isFrozen)).toBe(true);
      expect(cloneState(state).terrain).toBe(state.terrain);
      layouts.add(JSON.stringify(state.terrain!.rocks));
      const { mapWidth: w, mapHeight: h } = config, land = reachable(state);
      let count = 0, blocked = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        expect(isRockTile(state.terrain, x, y)).toBe(isRockTile(state.terrain, w - 1 - x, y));
        if (isPassable(state, x, y)) count++;
        if (!isRockTile(state.terrain, x, y)) continue;
        blocked++;
        expect(isWaterTile(state.terrain, x, y)).toBe(false);
        expect(state.food[y * w + x]).toBe(0); expect(state.foodCap[y * w + x]).toBe(0);
        for (const colony of [0, 1] as const) {
          const nest = nestTile(template, colony);
          expect(Math.max(Math.abs(Math.floor(x / 2) - nest.tx), Math.abs(Math.floor(y / 2) - nest.ty))).toBeGreaterThan(ROCK_RULES.nestClearanceTiles);
        }
      }
      expect(blocked).toBe(rocks.reduce((sum, r) => sum + r.width * r.height, 0)); expect(land.size).toBe(count);
      for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    }
    expect(layouts.size).toBeGreaterThan(1);
    expect(pairCounts).toEqual(new Set([6, 7, 8])); expect(clusterSizes).toEqual(new Set([1, 2, 3]));
    expect(appearances.size).toBeGreaterThan(4);
  });

  it("keeps rock-free shapes; configured count/footprint and impossible placement are explicit", () => {
    // Historical capped public controls, equal to main's water-only setup.
    const noRocks = { ...HISTORICAL_PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, rocks: undefined }, foodLayout: PRE_FRONTLINE_PUBLIC_CONFIG.foodLayout };
    const old = createMatch(17, playable(noRocks));
    expect(old.terrain).not.toHaveProperty("rocks");
    expect(createMatch(17, playable(DEFAULT_CONFIG))).not.toHaveProperty("terrain");
    const config = playable({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, rocks: { ...ROCK_RULES, minPairs: 2, maxPairs: 2, minClusterTiles: 2, maxClusterTiles: 2 } } });
    expect(createMatch(17, config).terrain!.rocks).toHaveLength(4);
    // Two reference tiles are 2 x 4 = 8 fine tiles at grid scale 2.
    expect(createMatch(17, config).terrain!.rocks!.every(r => r.width * r.height === 8)).toBe(true);
    const water = createTerrain(17, config)!;
    expect(() => addRocks(17, config, water, new Array(128 * 96).fill(1), [])).toThrow(/cannot place/);
    expect(terrainView(old.terrain!)).not.toHaveProperty("rocks");
    expect(terrainView(createMatch(17, playable(PUBLIC_CONFIG)).terrain!).encoding).toContain("water and rocks rectangles");
  });

  it("replays seeded obstacles and movement exactly from the recorded config", () => {
    let state = createMatch(7001, playable(rulesConfig("redesign")));
    const lines = [headerLine(7001, state.config)];
    for (let i = 0; i < 35; i++) {
      const out = step(state); lines.push(tickLine(state.tick, [])); state = out.state;
      for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
    }
    expect(stateHash(replay(lines, state.tick))).toBe(stateHash(state));
  });
});

describe("rocks reuse land routing and legality", () => {
  it("Open Field routes both sides around a rock through existing mask and supercover, without corner cutting", () => {
    const state = { ...createMatch(1, playable(DEFAULT_CONFIG)), terrain: rockTerrain };
    expect(passableMask(state.config, rockTerrain)[20 * 128 + 22]).toBe(false);
    for (const colony of [0, 1] as const) {
      const origin = colony === 0 ? 10 : 12, goal = colony === 0 ? 12 : 10;
      const ant = newAnt(state.config, 1, colony, at(origin), at(10));
      expect(segmentOnLand(state.config, rockTerrain, ant.x, ant.y, at(goal), at(10))).toBe(false);
      let ticks = 0;
      while (Math.hypot(ant.x - at(goal), ant.y - at(10)) > ARRIVE && ticks++ < 100) {
        const old = { ...ant };
        moveOnLand(state.config, rockTerrain, ant, routeToward(state, ant, at(goal), at(10)), speedPerTick(state.config));
        expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
        expect(segmentOnLand(state.config, rockTerrain, old.x, old.y, ant.x, ant.y)).toBe(true);
      }
      expect(ticks).toBeLessThan(100);
    }
    const ant = newAnt(state.config, 1, 0, at(10), at(10));
    expect(segmentOnLand(state.config, rockTerrain, ant.x, ant.y, at(11), at(11))).toBe(false);
    moveOnLand(state.config, rockTerrain, ant, direction(1, 0), 4 * SUB);
    expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([at(10), at(10), 0, 0]);
  });

  it("rejects word/count marks and founding atomically, including implicit own-ant tiles", () => {
    const base = createMatch(1, playable({ ...rulesConfig("redesign"), wordMarksDisabled: undefined, terrain: undefined }));
    const state = { ...base, terrain: rockTerrain };
    expect(applyInput(state, { type: "join", agentId: "a", colony: 0 }, 0, defaultAllocator, []).error).toBeNull();
    fillSquads(state, defaultAllocator, 0, []);
    const agent = state.agents[0]!;
    agent.lastCallTick = 1; // Calls update the heartbeat even when the command is refused.
    expect(agent.squad.length).toBeGreaterThan(0);
    for (const ant of state.ants.filter(a => agent.squad.includes(a.id))) { ant.x = at(11); ant.y = at(10); }
    for (const type of ["mark", "count_mark"] as const) for (const explicit of [false, true]) {
      agent.lastCommandTick = null;
      const before = stateHash(state), events: SimEvent[] = [];
      const input = type === "mark" ? { type, agentId: "a", words: ["GATHER"] }
        : { type, agentId: "a", verb: "GATHER", count: 1 };
      const result = applyInput(state, { ...input, ...(explicit ? { tileX: 22, tileY: 20 } : {}) }, 1, defaultAllocator, events);
      expect(result.error?.code).toBe("rock_tile"); expect(events).toEqual([]); expect(stateHash(state)).toBe(before);
    }
    const before = stateHash(state), events: SimEvent[] = [];
    expect(foundQueen(state, 0, 22, 20, 3000, events)?.code).toBe("rock_tile");
    expect(events).toEqual([]); expect(stateHash(state)).toBe(before);
  });

  it("birth fallback avoids rocks, or waits without food/id consumption", () => {
    // The reference nest tile (8, 24) is fine tiles 16-17 x 48-49 at grid scale 2.
    const terrain: Terrain = { ...rockTerrain, rocks: [{ x: 16, y: 48, width: 2, height: 2, appearance: 0 }] };
    const position = landBirthPosition(playable(DEFAULT_CONFIG), terrain, at(8), at(24), 0)!;
    expect(isRockTile(terrain, Math.floor(position.x / SUB), Math.floor(position.y / SUB))).toBe(false);
    const config = playable({ ...DEFAULT_CONFIG, nestDeliverTiles: 0 });
    const state = { ...createMatch(1, config), terrain };
    state.ants = []; state.colonies[0].foodStore = config.hatchCost;
    const before = { food: state.colonies[0].foodStore, id: state.nextAntId, hatch: state.colonies[0].lastHatchTick };
    hatch(state, 0, []);
    expect(state.ants).toHaveLength(0);
    expect({ food: state.colonies[0].foodStore, id: state.nextAntId, hatch: state.colonies[0].lastHatchTick }).toEqual(before);
  });
});
