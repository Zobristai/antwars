/** The tuning map never enters normal play. The new-match rotation is still the
 * same seven maps in the same order and no seed draws the tuning map. The seven maps' configuration, log and
 * rules-text pins are held by seven-map-preservation, scale2-rotation, v2-maps-rotation and map-wide-plain, unedited. */
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { comparisonOptions } from "../../src/server.js";
import { RULES_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { newMatchMaps } from "../../src/sim/mapShapes.js";
import { createTerrain } from "../../src/sim/terrain.js";
import { TUNING_MAP_ID as TUNING } from "../../src/sim/tuningMap.js";

const SEVEN = ["open-field", "three-crossings-v2", "central-lake-v2", "isthmus", "twin-shields", "four-lanes", "wide-plain"];
const SEEDS = [...Array.from({ length: 1_000 }, (_, i) => i + 1), 6006, 7001];
const ids = (config: SimConfig) => config.terrain!.maps.map(map => map.id);

/** Every config a new production match starts from: each rules template at the new-match boundary, the server's
 * start-up options (ANTWAR_RULES unset, and each comparison rules name) and the Game's own default. */
const NEW_MATCH_CONFIGS: readonly (readonly [string, SimConfig])[] = [
  ...[undefined, ...RULES_NAMES].map(name => [`newMatchConfig(rulesConfig(${name ?? ""}))`, newMatchConfig(rulesConfig(name))] as const),
  ["server, ANTWAR_RULES unset", comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!],
  ...RULES_NAMES.map(name => [`server, ANTWAR_RULES=${name}`,
    comparisonOptions({ ANTWAR_RULES: name, ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG).simConfig!] as const),
  ["Game default", new Game().simConfig],
];

describe("the tuning map is kept out of the new-match rotation", () => {
  it("newMatchMaps() is the same seven maps in the same order, without the tuning map", () => {
    expect(newMatchMaps().map(map => map.id)).toEqual(SEVEN);
  });

  it.each(NEW_MATCH_CONFIGS)("%s: the seven maps in order, seed-drawn, without the tuning map", (_, config) => {
    expect(ids(config)).toEqual(SEVEN);
    expect(config.terrain!.maps).toEqual(newMatchMaps());
    expect(config.terrain!.mapId).toBeUndefined();
  });

  it.each(NEW_MATCH_CONFIGS)("%s: seeds 1-1,000, 6006 and 7001 never draw the tuning map and draw only the seven", (_, config) => {
    const drawn = new Set(SEEDS.map(seed => createTerrain(seed, config)!.mapId));
    expect(drawn.has(TUNING)).toBe(false);
    expect([...drawn].sort()).toEqual([...SEVEN].sort());
  });
});
