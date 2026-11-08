/** Three Crossings v2 and Central Lake v2 take the old two's places in the new-match
 * rotation, and nothing else in the new-match config changes against the seven-map capture. */
import { describe, expect, it } from "vitest";
import { rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { createMapShapes, newMatchMaps } from "../../src/sim/mapShapes.js";
import { CENTRAL_LAKE_V2, SCALE2_MAPS, THREE_CROSSINGS_V2 } from "../../src/sim/scale2Maps.js";
import { createTerrain } from "../../src/sim/terrain.js";
import { SEEDS } from "./new-maps-checks.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

const config = newMatchConfig(rulesConfig("redesign"));
const captured = sevenMapRotation(config);
const V2_OF: Record<string, string> = { "three-crossings": "three-crossings-v2", "central-lake": "central-lake-v2" };

describe("the new-match rotation after the swap", () => {
  it("lists Open Field, the two v2 maps and the four scale-2 maps; the old two are not in it", () => {
    expect(config.terrain!.maps.map(map => map.id)).toEqual([
      "open-field", "three-crossings-v2", "central-lake-v2", "isthmus", "twin-shields", "four-lanes", "wide-plain",
    ]);
    expect(newMatchMaps()).toEqual(config.terrain!.maps);
  });

  it("differs from the captured seven-map config only in the two swapped entries", () => {
    const [, oldCrossings, oldLake] = createMapShapes();
    expect(config.terrain!.maps[1]).toEqual(THREE_CROSSINGS_V2);
    expect(config.terrain!.maps[2]).toEqual(CENTRAL_LAKE_V2);
    // Putting the old two back gives the captured seven-map config.
    const swappedBack = { ...config, terrain: { ...config.terrain!, maps: config.terrain!.maps.map((map, i) => i === 1 ? oldCrossings! : i === 2 ? oldLake! : map) } };
    expect(swappedBack).toEqual(captured);
    // Open Field and the four scale-2 maps are the same entries as in the capture.
    for (const i of [0, 3, 4, 5, 6]) expect(config.terrain!.maps[i]).toEqual(captured.terrain!.maps[i]);
    expect(config.terrain!.maps.slice(3)).toEqual(SCALE2_MAPS);
  });

  it("seeds 1-100, 6006 and 7001: a seed that drew an old map draws its v2, every other seed the same map", () => {
    const draws = SEEDS.map(seed => [createTerrain(seed, captured)!.mapId, createTerrain(seed, config)!.mapId] as const);
    for (const [before, after] of draws) expect(after).toBe(V2_OF[before] ?? before);
    expect(draws.some(([before]) => before === "three-crossings")).toBe(true);
    expect(draws.some(([before]) => before === "central-lake")).toBe(true);
    expect(draws.some(([, after]) => after === "three-crossings" || after === "central-lake")).toBe(false);
  });

  it.each([THREE_CROSSINGS_V2, CENTRAL_LAKE_V2])("$name plays at the old map's 128x96 board, grid scale 2, 512 ants and 30 minutes", map => {
    const seed = SEEDS.find(candidate => createTerrain(candidate, config)!.mapId === map.id)!;
    const drawn = createMatch(seed, config).config;
    expect([drawn.mapWidth, drawn.mapHeight, drawn.gridScale, drawn.colonyCap, drawn.matchTicks]).toEqual([128, 96, 2, 512, 18_000]);
    expect([map.board, map.colonyCap, map.matchTicks]).toEqual([undefined, undefined, undefined]);
  });

});
