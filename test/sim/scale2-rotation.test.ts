/** Isthmus, Twin Shields, Four Lanes and Wide Plain join the new-match rotation at grid scale 2 only.
 * Three Crossings v2 and Central Lake v2 then take the old two's places; the rotation stays readable. */
import { describe, expect, it } from "vitest";
import { briefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { RULES_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { hasDistinctMapLayouts, mapLayoutDescription } from "../../src/sim/mapShapes.js";
import { SCALE2_MAPS } from "../../src/sim/scale2Maps.js";
import { ruleSections } from "../../web/rules.js";
import { threeMapRotation } from "./three-map-rotation.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

const THREE = ["open-field", "three-crossings", "central-lake"];
const FIRST_THREE = ["open-field", "three-crossings-v2", "central-lake-v2"];
const NEW = ["isthmus", "twin-shields", "four-lanes", "wide-plain"];
const ids = (config: SimConfig) => config.terrain!.maps.map(map => map.id);
const mapLines = (config: SimConfig) => briefing(config, DEFAULT_MCP_CONFIG, { house: false }).split("\n")
  .filter(line => /^(Open Field|Three Crossings|Central Lake|Three Crossings v2|Central Lake v2|Isthmus|Twin Shields|Four Lanes|Wide Plain): /.test(line));

describe("the new-match rotation", () => {
  it.each([undefined, ...RULES_NAMES])("rules %s: seven maps at grid scale 2, rules version 27 unchanged", name => {
    const config = newMatchConfig(rulesConfig(name));
    expect(config.gridScale).toBe(2);
    expect(ids(config)).toEqual([...FIRST_THREE, ...NEW]);
    expect(hasDistinctMapLayouts(config.terrain!)).toBe(true);
  });

  it("the seed draws every one of the seven maps among seeds 1-100", () => {
    const config = newMatchConfig(rulesConfig("redesign"));
    const drawn = new Set(Array.from({ length: 100 }, (_, i) => createMatch(i + 1, config).terrain!.mapId));
    expect([...drawn].sort()).toEqual([...FIRST_THREE, ...NEW].sort());
  });
});

describe("agent and rules-page text", () => {
  it("a saved three-map config keeps its briefing lines exactly", () => {
    const three = threeMapRotation(newMatchConfig(rulesConfig("redesign")));
    expect(mapLines(three)).toEqual([
      "Open Field: dry.", "Three Crossings: N/S river, 3 crossings.", "Central Lake: stepped lake; land N/S.",
    ]);
  });

  it("a saved config carrying the seven-map rotation keeps its briefing lines exactly", () => {
    const seven = sevenMapRotation(newMatchConfig(rulesConfig("redesign")));
    expect(ids(seven)).toEqual([...THREE, ...NEW]);
    expect(hasDistinctMapLayouts(seven.terrain!)).toBe(true);
    expect(mapLines(seven)).toEqual([
      "Open Field: dry.", "Three Crossings: N/S river, 3 crossings.", "Central Lake: stepped lake; land N/S.",
      "Isthmus: N/S gulfs; 1 middle land bridge.",
      "Twin Shields: crescent lake before each home; open centre.",
      "Four Lanes: 3 E-W lakes, 4 lanes.",
      "Wide Plain: 2 ponds per home, 3 gaps; open plain.",
    ]);
    const maps = ruleSections(seven).find(section => section.title === "Maps")!.lines;
    for (const text of ["Three Crossings: a north-south river with three land crossings.", "Central Lake: one stepped central lake with land routes north and south."]) {
      expect(maps.some(line => line.startsWith(`${text} `))).toBe(true);
    }
  });

  it("the seven-map rotation describes each new map factually", () => {
    const config = newMatchConfig(rulesConfig("redesign"));
    expect(mapLines(config)).toEqual([
      "Open Field: dry.", "Three Crossings v2: stepped N/S river, 3 crossings.", "Central Lake v2: stepped lake; land N/S.",
      "Isthmus: N/S gulfs; 1 middle land bridge.",
      "Twin Shields: crescent lake before each home; open centre.",
      "Four Lanes: 3 E-W lakes, 4 lanes.",
      "Wide Plain: 2 ponds per home, 3 gaps; open plain.",
    ]);
    const maps = ruleSections(config).find(section => section.title === "Maps")!.lines;
    for (const text of [
      "Three Crossings v2: a stepped north-south river with three land crossings.",
      "Central Lake v2: one stepped central lake with land routes north and south.",
      "Isthmus: a gulf from the north edge and one from the south edge, with one land bridge between them on the middle rows.",
      "Twin Shields: a crescent lake in front of each start area, hollow facing home, with land round both ends; open centre.",
      "Four Lanes: three long east-west lakes split the middle into four separate lanes.",
      "Wide Plain: two ponds in front of each home leave three gaps onto an open central plain.",
    ]) expect(maps.some(line => line.startsWith(`${text} `))).toBe(true);
    expect(ruleSections(config, { undrawn: true }).find(section => section.title === "Maps")!.lines)
      .toContain("The map the seed selects sets the playable board: 128x96 or 128x128 or 256x92 tiles, width by height.");
  });

  it("describes only the exact geometry: changed water or another grid scale gets the generic text", () => {
    const [isthmus] = SCALE2_MAPS;
    expect(mapLayoutDescription(isthmus!, 128, 96)).toMatch(/^a gulf from the north edge/);
    const changed = { ...isthmus!, water: isthmus!.water.slice(1) };
    expect(mapLayoutDescription(changed, 128, 96)).toBe("water obstacles; use the water rectangles to find land routes");
    expect(mapLayoutDescription(isthmus!, 64, 48, true)).toBe("water");
    expect(mapLayoutDescription({ ...isthmus!, gridScale: undefined }, 128, 96, true)).toBe("water");
  });
});
