import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_CONFIG, RULES_NAMES, SUB, rulesConfig, type MapDefinition, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { MAX_BOARD_SIDE_TILES, assertSupportedBoard, boardSizeProblem, undrawnBoardSize, undrawnBoardSizes } from "../../src/sim/mapBoard.js";
import { createMatch, matchConfigForMap } from "../../src/sim/map.js";
import { threeMapRotation } from "./three-map-rotation.js";
import { headerLine, replay, stateHash, type LogHeader } from "../../src/sim/log.js";
import { playScripted } from "../../src/live/record.js";
import { nextUint32 } from "../../src/sim/rng.js";
import { startBoxes } from "../../src/sim/startPlacement.js";
import { createTerrain, isPassable, isWaterTile } from "../../src/sim/terrain.js";
import { HISTORICAL_DEFAULT_CONFIG, PRE_FRONTLINE_CONFIGS, addAnt } from "./fixtures.js";
import { BOARD_CASES, CAP_ONLY_MAP, LANES_BOARD, LENGTH_ONLY_MAP, OWN_VALUES_WIDE, WIDE_BOARD, boardRotation } from "./map-board-fixtures.js";
import { playable } from "../playable.ts";
import { step } from "../../src/sim/step.js";
import { hatch } from "../../src/sim/forage.js";
import type { SimEvent } from "../../src/sim/types.js";

describe("supported board sizes", () => {
  // Every match plays at grid scale 2: board sizes are checked at grid scale 2 only.
  it.each([
    [64, 48, 2], [64, 64, 2], [128, 46, 2], [128, 128, 2], [2, 1, 2],
  ])("supports %ix%i at grid scale %i", (width, height, scale) => {
    expect(boardSizeProblem(width, height, scale)).toBeNull();
    expect(() => assertSupportedBoard(width, height, scale)).not.toThrow();
  });

  it.each([
    [64, 129, 2, /at most 256 tiles/], [130, 46, 2, /at most 256 tiles/], [64, 48, 3, /grid scale/],
    [65, 48, 2, /even/], [0, 48, 2, /positive/], [64, 47.5, 2, /positive/],
  ])("refuses %ix%i at grid scale %i", (width, height, scale, reason) => {
    expect(boardSizeProblem(width, height, scale)).toMatch(reason);
    expect(() => assertSupportedBoard(width, height, scale)).toThrow(RangeError);
  });

  it("derives its side limit from the formats", () => {
    expect(MAX_BOARD_SIDE_TILES).toBe(256);
    // 16-bit ant positions at 256 sub-units per tile, and single-byte tile coordinates.
    expect(2 ** 16 / 256).toBe(MAX_BOARD_SIDE_TILES);
    expect(2 ** 8).toBe(MAX_BOARD_SIDE_TILES);
  });

  it.each([
    ["a 129-tile side", { referenceWidth: 128, referenceHeight: 129 }, /^fixture-wide: unsupported board 128x129 at grid scale 2: board sides must be at most 256 tiles/],
    ["a 130-tile side", { referenceWidth: 130, referenceHeight: 46 }, /^fixture-wide: unsupported board 130x46 at grid scale 2: board sides must be at most 256 tiles/],
    ["an odd width", { referenceWidth: 65, referenceHeight: 46 }, /^fixture-wide: unsupported board 65x46 at grid scale 2: reference width must be even/],
  ])("config validation refuses %s, naming the map and the value, never clamping it", (_label, size, reason) => {
    const config = boardRotation(2, [{ ...WIDE_BOARD, board: { ...WIDE_BOARD.board!, ...size } }], { mapId: WIDE_BOARD.id });
    expect(() => newMatchConfig(config)).toThrow(reason);
    // createMatch asserts the same combination where it derives the board config.
    expect(() => createMatch(7001, config)).toThrow(reason);
    expect(config.mapWidth).toBe(128);
  });

  it.each([
    ["nest outside its left half", { ...LANES_BOARD, board: { ...LANES_BOARD.board!, nestTileX: 32 } }, /default nest/],
    ["water outside the board", { ...LANES_BOARD, water: [{ x: 18, y: 60, width: 28, height: 8 }] }, /water rectangles/],
    ["food outside its left half", { ...LANES_BOARD, board: { ...LANES_BOARD.board!, foodPatches: [{ tileX: 40, tileY: 5, radius: 1, perTile: 1 }] } }, /food templates/],
  ])("refuses a board map with %s", (_label, map, reason) => {
    expect(() => newMatchConfig(boardRotation(2, [map as MapDefinition]))).toThrow(reason);
  });
});

/** Recorded/legacy draw, written out independently of selectMap. */
function legacyMapIndex(seed: number, count: number): number {
  return nextUint32((seed ^ 0x74657272) >>> 0).value % count;
}
const SEEDS = [...Array.from({ length: 100 }, (_, i) => i + 1), 6006, 7001];

describe("existing configs are untouched", () => {
  const logHeaders = ["../replays/agents-source.match.jsonl", "../replays/historical-counts.jsonl", "../replays/marked-holds.jsonl",
    "./fixtures/pre-pick-default.jsonl", "./fixtures/pre-pick-public.jsonl"].map(path =>
    [path, (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8").split("\n")[0]!) as LogHeader).config] as const);
  const mirrorCases = (JSON.parse(readFileSync(new URL("./fixtures/colony-mirror-rules23.json", import.meta.url), "utf8")) as
    { cases: { name: string; config: SimConfig }[] }).cases.map(c => [`colony-mirror ${c.name}`, c.config] as const);
  const templates: (readonly [string, SimConfig])[] = [
    ["PUBLIC_CONFIG", PUBLIC_CONFIG], ["HISTORICAL_DEFAULT_CONFIG", HISTORICAL_DEFAULT_CONFIG],
    ...[undefined, ...RULES_NAMES].flatMap(name => [[`rules ${name}`, rulesConfig(name)], [`new match ${name}, three-map rotation`, threeMapRotation(newMatchConfig(rulesConfig(name)))]] as const),
    ...Object.entries(PRE_FRONTLINE_CONFIGS), ...logHeaders, ...mirrorCases,
  ];
  // Each as a match plays it, at grid scale 2.
  const configs = templates.map(([name, config]) => [name, playable(config)] as const);

  it.each(configs)("%s: the same config object and map for seeds 1-100, 6006 and 7001", (_name, config) => {
    for (const seed of SEEDS) {
      expect(matchConfigForMap(seed, config)).toBe(config);
      const terrain = createTerrain(seed, config);
      if (config.terrain === undefined) { expect(terrain).toBeUndefined(); continue; }
      const maps = config.terrain.maps;
      expect(terrain!.mapId).toBe(config.terrain.mapId ?? maps[legacyMapIndex(seed, maps.length)]!.id);
    }
    expect(config).not.toHaveProperty("rotationSize");
    expect(undrawnBoardSize(config)).toEqual({ width: config.mapWidth, height: config.mapHeight });
  });

  it("a rotation with a board map draws each seed's map by the same rule", () => {
    const config = boardRotation(2, [LANES_BOARD, WIDE_BOARD]);
    for (const seed of SEEDS) {
      const expected = config.terrain!.maps[legacyMapIndex(seed, 5)]!;
      const derived = matchConfigForMap(seed, config);
      expect(createTerrain(seed, derived)!.mapId).toBe(expected.id);
      if (expected.board === undefined) expect(derived).toBe(config);
      else expect([derived.mapWidth, derived.mapHeight]).toEqual([expected.board.referenceWidth * 2, expected.board.referenceHeight * 2]);
    }
    expect(undrawnBoardSizes(config)).toEqual([{ width: 128, height: 96 }, { width: 128, height: 128 }, { width: 256, height: 92 }]);
    expect(undrawnBoardSize(config)).toBeNull();
    expect(undrawnBoardSize(boardRotation(2, [LANES_BOARD], { only: true }))).toEqual({ width: 128, height: 128 });
    expect(undrawnBoardSize({ ...config, terrain: { ...config.terrain!, mapId: "open-field" } })).toEqual({ width: 128, height: 96 });
  });
});

describe.each(BOARD_CASES)("$map.name at grid scale $scale", ({ map, scale }) => {
  const board = map.board!;
  const width = board.referenceWidth * scale, height = board.referenceHeight * scale;
  const base = boardRotation(scale, [map], { mapId: map.id });

  it("validates, then derives size, nest, food, start boxes, rocks and water from the map", () => {
    expect(newMatchConfig(base)).toEqual(base);
    for (const seed of [6006, 7001]) {
      const state = createMatch(seed, base);
      const c = state.config;
      expect([c.mapWidth, c.mapHeight, c.gridScale]).toEqual([width, height, scale]);
      expect(c.rotationSize).toEqual({ width: 64 * scale, height: 48 * scale });
      expect([c.nestTileX, c.nestTileY]).toEqual([(board.nestTileX + 0.5) * scale - 0.5, (board.nestTileY + 0.5) * scale - 0.5]);
      expect(c.foodLayout!.patches.map(p => p.radius)).toEqual(board.foodPatches.map(p => p.radius * scale));
      expect(startBoxes(c)).toEqual([{ x: 0, y: 0, width: width / 4, height }, { x: width - width / 4, y: 0, width: width / 4, height }]);
      expect(state.terrain!.water).toEqual(map.water.map(r => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale })));
      expect(state.food).toHaveLength(width * height);
      let total = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const amount = state.food[y * width + x]!;
        expect(amount).toBe(state.food[y * width + width - 1 - x]);
        if (amount > 0) expect(isPassable(state, x, y)).toBe(true);
        total += amount;
      }
      expect(total).toBeGreaterThan(0);
      const rocks = state.terrain!.rocks!;
      expect(rocks.length).toBeGreaterThan(0);
      for (const rock of rocks) {
        expect(rock.x >= 0 && rock.y >= 0 && rock.x + rock.width <= width && rock.y + rock.height <= height).toBe(true);
        expect(rocks.some(other => other.x === width - rock.x - rock.width && other.y === rock.y)).toBe(true);
        for (let y = rock.y; y < rock.y + rock.height; y++) for (let x = rock.x; x < rock.x + rock.width; x++) {
          expect(isWaterTile(state.terrain, x, y)).toBe(false);
        }
      }
      for (const colony of state.colonies) expect(isPassable(state, Math.floor(colony.queenX / SUB), Math.floor(colony.queenY / SUB))).toBe(true);
    }
  });

  it("finalizes an eight-seat lobby start inside the board's start strips", () => {
    const seats = Array.from({ length: 8 }, (_, n) => ({ identityId: `seat-${n}`, colony: (n % 2) as 0 | 1 }));
    const lobby = new LobbyStart(7001, newMatchConfig(base), seats, 0);
    expect([lobby.config.mapWidth, lobby.config.mapHeight]).toEqual([width, height]);
    const state = lobby.finish(lobby.closesAt);
    const boxes = startBoxes(state.config);
    for (const [colony, team] of state.colonies.entries()) {
      expect(team.queens).toHaveLength(4);
      for (const queen of team.queens!) {
        const x = Math.floor(queen.queenX / SUB), y = Math.floor(queen.queenY / SUB), box = boxes[colony]!;
        expect(x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height).toBe(true);
        expect(isPassable(state, x, y)).toBe(true);
      }
    }
  });

  it("round-trips its log header and replays to identical hashes", () => {
    const seed = 7001, ticks = 40;
    const { lines, state } = playScripted({ seed, config: base, agents: 2, ticks });
    const derived = createMatch(seed, base).config;
    // The server writes the derived config; JSON keeps it exactly.
    const header = headerLine(seed, derived);
    expect((JSON.parse(header) as LogHeader).config).toEqual(derived);
    expect(stateHash(createMatch(seed, (JSON.parse(header) as LogHeader).config))).toBe(stateHash(createMatch(seed, base)));
    const serverLines = [header, ...lines.slice(1)];
    expect(state.tick).toBe(ticks);
    expect(stateHash(replay(serverLines, ticks))).toBe(stateHash(state));
    expect(stateHash(replay(lines, ticks))).toBe(stateHash(state));
  }, 30_000);
});

it("a stored derived config keeps its recorded rotation size when derived again", () => {
  const derived = createMatch(7001, boardRotation(2, [LANES_BOARD], { mapId: LANES_BOARD.id })).config;
  const again = matchConfigForMap(7001, derived);
  expect(again.rotationSize).toEqual({ width: 128, height: 96 });
  expect(Object.keys(again)).toEqual(Object.keys(derived));
  expect(createMatch(7001, derived).config).toEqual(derived);
});

describe("a map's own board, ant cap and match length play only at grid scale 2", () => {
  it.each([
    ["ant cap", { colonyCap: 0 }, /^fixture-cap-only: ant cap 0 must be a positive whole number/],
    ["ant cap", { colonyCap: 1.5 }, /^fixture-cap-only: ant cap 1\.5 must be a positive whole number/],
    ["ant cap", { colonyCap: -1 }, /^fixture-cap-only: ant cap -1 must be a positive whole number/],
    ["ant cap", { colonyCap: 2 ** 53 }, /^fixture-cap-only: ant cap 9007199254740992 must be a positive whole number of at most 9007199254740991/],
    ["match length", { matchTicks: 0 }, /^fixture-cap-only: match length 0 ticks must be a positive whole number/],
    ["match length", { matchTicks: 1.5 }, /^fixture-cap-only: match length 1\.5 ticks/],
    ["match length", { matchTicks: -1 }, /^fixture-cap-only: match length -1 ticks/],
    ["match length", { matchTicks: 10_000_001 }, /^fixture-cap-only: match length 10000001 ticks must be a positive whole number of at most 10000000 ticks/],
    ["match length", { matchTicks: Number.MAX_SAFE_INTEGER }, /^fixture-cap-only: match length 9007199254740991 ticks/],
  ])("rotation validation refuses an %s of %o, naming the map and the value", (_label, values, reason) => {
    const config = boardRotation(2, [{ ...CAP_ONLY_MAP, ...values }], { mapId: CAP_ONLY_MAP.id });
    expect(() => newMatchConfig(config)).toThrow(reason);
    expect(() => createMatch(7001, config)).toThrow(reason);
  });

  it("accepts the largest values the formats hold, unclamped", () => {
    const map = { ...CAP_ONLY_MAP, colonyCap: Number.MAX_SAFE_INTEGER, matchTicks: 10_000_000 };
    const config = boardRotation(2, [map], { mapId: map.id });
    expect(newMatchConfig(config)).toEqual(config);
    const derived = matchConfigForMap(7001, config);
    expect([derived.colonyCap, derived.matchTicks]).toEqual([Number.MAX_SAFE_INTEGER, 10_000_000]);
  });

  it.each([[CAP_ONLY_MAP, { colonyCap: 33 }], [LENGTH_ONLY_MAP, { matchTicks: 72_000 }]] as const)("%s.name at grid scale 2 materializes only its own value", (map, own) => {
    const config = boardRotation(2, [map], { mapId: map.id });
    expect(newMatchConfig(config)).toEqual(config);
    const derived = matchConfigForMap(7001, config);
    expect(derived).toEqual({ ...config, ...own });
    expect(derived).not.toHaveProperty("rotationSize");
    expect([derived.mapWidth, derived.mapHeight]).toEqual([128, 96]);
    expect(matchConfigForMap(7001, derived)).toBe(derived);
    expect(createMatch(7001, config).config).toMatchObject({ ...own, mapWidth: 128, mapHeight: 96 });
  });

  it("keeps the early win, overrun grace and combat grace on a 72,000-tick map", () => {
    const derived = createMatch(7001, boardRotation(2, [LENGTH_ONLY_MAP], { mapId: LENGTH_ONLY_MAP.id })).config;
    expect(derived.matchTicks).toBe(72_000);
    expect([derived.earlyWin!.minTick, derived.earlyWin!.holdTicks, derived.overrunGraceTicks, derived.combatGraceTicks]).toEqual([6000, 3000, 7200, 600]);
  });

  describe("a board map with its own ant cap and match length", () => {
    const config = boardRotation(2, [OWN_VALUES_WIDE], { mapId: OWN_VALUES_WIDE.id });

    it("is built with its board, cap and length; re-deriving and its log header keep them", () => {
      expect(newMatchConfig(config)).toEqual(config);
      const derived = createMatch(7001, config).config;
      expect([derived.mapWidth, derived.mapHeight, derived.gridScale, derived.colonyCap, derived.matchTicks]).toEqual([256, 92, 2, 33, 40]);
      expect(createMatch(7001, derived).config).toEqual(derived);
      expect((JSON.parse(headerLine(7001, derived)) as LogHeader).config).toEqual(derived);
    });

    it("stops hatching at the map's cap", () => {
      const state = createMatch(7001, config);
      const hatched = (tick: number) => { state.tick = tick; const events: SimEvent[] = []; hatch(state, tick, events); return events.filter(e => e.type === "hatch" && e.colony === 0); };
      state.colonies[0].foodStore = 1000;
      state.ants = state.ants.filter(ant => ant.colony !== 0);
      for (let i = 0; i < 33; i++) addAnt(state, 0, 5, 5);
      expect(hatched(1000)).toEqual([]);
      state.ants.splice(state.ants.findIndex(ant => ant.colony === 0), 1);
      expect(hatched(2000)).toHaveLength(1);
    });

    it("ends at the map's length", () => {
      let state = createMatch(7001, config);
      while (state.result === null && state.tick < 100) state = step(state, []).state;
      expect(state.tick).toBe(40);
      expect(state.result).not.toBeNull();
    });
  });
});
