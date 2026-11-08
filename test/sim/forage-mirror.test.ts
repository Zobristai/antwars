import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { foodTiles, forageDirection } from "../../src/sim/forage.js";
import { newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { headerLine, parseLog } from "../../src/sim/log.js";
import { buildGrid } from "../../src/sim/map.js";
import { houseDirection, localDirection } from "../../src/sim/houseBot.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";

type Tile = readonly [number, number];
const scenarioConfig: SimConfig = { ...PUBLIC_CONFIG, terrain: undefined, foodLayout: undefined, foodPatches: [] };
// Every match plays at grid scale 2: reference tile (x, y) is placed at fine tile (2x, 2y) and its
// mirror at fine 127 - 2x, so every distance doubles and the board mirror stays exact. at() and atMirror()
// name the fine food index of a reference tile and of its mirror.
function scenario(config = scenarioConfig, positions: readonly Tile[] = [[14, 20], [18, 20]]) {
  const state = emptyMatch(0, config);
  state.food.fill(0);
  const width = state.config.mapWidth;
  const mirror = (x: number) => width - 1 - x;
  for (const [x, y] of positions) {
    state.food[2 * y * width + 2 * x] = 5;
    state.food[2 * y * width + mirror(2 * x)] = 5;
  }
  const ants = [addAnt(state, 0, 2 * 16, 2 * 20), addAnt(state, 1, mirror(2 * 16), 2 * 20)] as const;
  const at = (x: number, y: number) => 2 * y * width + 2 * x, atMirror = (x: number, y: number) => 2 * y * width + mirror(2 * x);
  return { state, ants, mirror, at, atMirror };
}

describe("new-match mirrored food ties", () => {
  it.each([false, true])("chooses the exact mirrored targets, reversed candidates=%s", reverse => {
    const { state, ants, at, atMirror } = scenario();
    const tiles = foodTiles(state);
    if (reverse) tiles.reverse();
    const directions = ants.map(ant => forageDirection(state, ant, tiles));
    expect(ants.map(ant => ant.foodTarget)).toEqual([at(14, 20), atMirror(14, 20)]);
    expect(directions[0]!.x).toBeLessThan(0);
    expect(directions[1]).toEqual({ x: -directions[0]!.x, y: directions[0]!.y });
  });

  it.each([
    { positions: [[16, 18], [16, 22]] as const, expected: [16, 18] as const },
    { positions: [[14, 18], [18, 18], [14, 22], [18, 22]] as const, expected: [14, 18] as const },
  ])("keeps row priority while mirroring horizontal choices: $positions", ({ positions, expected }) => {
    const { state, ants, at, atMirror } = scenario(scenarioConfig, positions);
    for (const ant of ants) forageDirection(state, ant, foodTiles(state).reverse());
    expect(ants.map(ant => ant.foodTarget)).toEqual([at(expected[0], expected[1]), atMirror(expected[0], expected[1])]);
  });

  it("does not let mirrored ordering override a uniquely nearer food tile", () => {
    const { state, ants, at, atMirror } = scenario(scenarioConfig, [[15, 20], [18, 20]]);
    for (const ant of ants) forageDirection(state, ant, foodTiles(state).reverse());
    expect(ants.map(ant => ant.foodTarget)).toEqual([at(15, 20), atMirror(15, 20)]);
  });

  it("retains a valid target and only reselects on depletion", () => {
    const { state, ants, atMirror } = scenario();
    ants[1].foodTarget = atMirror(18, 20);
    forageDirection(state, ants[1], foodTiles(state));
    expect(ants[1].foodTarget).toBe(atMirror(18, 20));
    state.food[ants[1].foodTarget] = 0;
    forageDirection(state, ants[1], foodTiles(state));
    expect(ants[1].foodTarget).toBe(atMirror(14, 20));
  });

  it.each([2] as const)("mirrors equal-distance targeting on grid scale %i", scale => {
    const config = withGridScale(scenarioConfig);
    const state = emptyMatch(0, config), width = config.mapWidth;
    state.food.fill(0);
    const x = 16 * scale, y = 20 * scale;
    const candidates = [x - 2 * scale, x + 2 * scale];
    for (const tx of candidates) {
      state.food[y * width + tx] = 5;
      state.food[y * width + width - 1 - tx] = 5;
    }
    const ants = [addAnt(state, 0, x, y), addAnt(state, 1, width - 1 - x, y)];
    for (const ant of ants) forageDirection(state, ant, foodTiles(state).reverse());
    expect(ants.map(ant => ant.foodTarget)).toEqual([
      y * width + candidates[0]!, y * width + width - 1 - candidates[0]!,
    ]);
  });

  it.each([false, true])("wires the shared choice into house/local forage, local=%s", local => {
    const config = { ...scenarioConfig, localAnts: { defendTiles: 3 } };
    const { state, ants, at, atMirror } = scenario(config), tiles = foodTiles(state), grid = buildGrid(state);
    state.colonies.forEach(colony => { colony.seenFood = tiles; });
    for (const ant of ants) {
      ant.role = "forager";
      if (local) localDirection(state, grid, ant);
      else houseDirection(state, grid, tiles, ant);
    }
    expect(ants.map(ant => ant.foodTarget)).toEqual([at(14, 20), atMirror(14, 20)]);
  });
});

describe("stored forage marker", () => {
  it.each([DEFAULT_CONFIG, RULES_V4_CONFIG, PUBLIC_CONFIG, rulesConfig("v4"), rulesConfig("count-marks"),
    rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))].map(playable))("stores the marker on new configs and headers (%#)", config => {
    expect(config.forageTieBreak).toBe("mirrored");
    const { header } = parseLog([headerLine(329, config)]);
    expect(header.rulesVersion).toBe(27);
    expect(JSON.stringify(header.config)).toBe(JSON.stringify(config));
  });
});
