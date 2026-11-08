/**
 * The seven-map rotation as captured at main b818fb03d53a42522306ec1470e1b3adae3197d9:
 * each captured seed draws its map at its board, ant cap and match length. The capture's rendered texts, log and
 * stream were recorded under rules 26 and were removed with that rules generation.
 *
 * New matches now draw Three Crossings v2 and Central Lake v2 in the old two's places, so every check here
 * runs on a config carrying the seven-map rotation as captured (sevenMapRotation), old two included;
 * v2-maps-rotation.test.ts shows the new-match config differs from this one only in those two maps.
 */
import { describe, expect, it } from "vitest";
import { rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createTerrain } from "../../src/sim/terrain.js";
import { createMatch } from "../../src/sim/map.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

const config = sevenMapRotation(newMatchConfig(rulesConfig("redesign")));
/** Each map's own [ant cap, match ticks]; every other map plays the config's 512 and 18,000. */
const OWN_LIMITS: Record<string, [number, number]> = { "four-lanes": [768, 27_000], "wide-plain": [1024, 36_000] };
const limitsOf = (id: string): [number, number] => OWN_LIMITS[id] ?? [512, 18_000];

/** The capture's seed for each map (createTerrain) and its drawn native board. */
const MAPS: Record<string, { seed: number; board: [number, number] }> = {
  "open-field": { seed: 0, board: [128, 96] },
  "three-crossings": { seed: 15, board: [128, 96] },
  "central-lake": { seed: 1, board: [128, 96] },
  isthmus: { seed: 2, board: [128, 96] },
  "twin-shields": { seed: 7, board: [128, 96] },
  "four-lanes": { seed: 6, board: [128, 128] },
  "wide-plain": { seed: 4, board: [256, 92] },
};

describe("the seven-map rotation matches the seven-map capture", () => {
  it("lists the captured maps in order", () => {
    expect(config.terrain!.maps.map(map => map.id)).toEqual(Object.keys(MAPS));
  });

  it.each(Object.entries(MAPS))("%s: the captured seed draws it, at its board, ant cap and match length", (id, map) => {
    expect(createTerrain(map.seed, config)!.mapId).toBe(id);
    const drawn = createMatch(map.seed, config).config;
    expect([drawn.mapWidth, drawn.mapHeight, drawn.gridScale, drawn.colonyCap, drawn.matchTicks]).toEqual([...map.board, 2, ...limitsOf(id)]);
  });
});
