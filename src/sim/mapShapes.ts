import type { MapDefinition, TerrainRules, WaterRect } from "./config.js";
import { CENTRAL_LAKE_V2, SCALE2_MAPS, THREE_CROSSINGS_V2 } from "./scale2Maps.js";
import { NEW_MATCH_GRID_SCALE } from "./gridScale.js";

/** Materialize new-match water in native grid-scale-2 tile coordinates. Saved map definitions
 * are never passed through this function: their rectangles remain authoritative.
 * Callers must set terrain.referenceWidth/Height to 128/96. */
export function createMapShapes(): readonly MapDefinition[] {
  const scale = NEW_MATCH_GRID_SCALE;
  const width = 64 * scale;
  const river = [[0, 8], [12, 22], [26, 36], [40, 48]].map(([top, bottom]) => ({
    x: 30 * scale, y: top! * scale, width: 4 * scale, height: (bottom! - top!) * scale,
  }));
  const lake: WaterRect[] = [];
  const top = 12 * scale, bottom = 36 * scale;
  for (let y = top; y < bottom; y++) {
    // Each row advances a bank by one *native* tile, not one reference tile.
    // Flat middle banks join the four stair-stepped corners into one lake.
    const inset = Math.min(y - top, bottom - 1 - y, 6 * scale);
    const halfWidth = 4 * scale + inset;
    const x = width / 2 - halfWidth, rowWidth = halfWidth * 2;
    const previous = lake[lake.length - 1];
    if (previous !== undefined && previous.x === x && previous.width === rowWidth) {
      lake[lake.length - 1] = { ...previous, height: previous.height + 1 };
    } else {
      lake.push({ x, y, width: rowWidth, height: 1 });
    }
  }
  return [
    { id: "open-field", name: "Open Field", water: [] },
    { id: "three-crossings", name: "Three Crossings", water: river },
    { id: "central-lake", name: "Central Lake", water: lake },
  ];
}

/** The seven-map rotation that shipped first: the three shapes, then the four scale-2 maps. Retired:
 * no new match draws it, but saved configs that carry it keep their briefing and rules-page lines. */
export function retiredSevenMapRotation(): readonly MapDefinition[] {
  return [...createMapShapes(), ...SCALE2_MAPS];
}

/** The new-match rotation: Open Field, Three Crossings v2 and Central Lake v2 in the places of the
 * old two, then the four scale-2 maps. Each seed draws the same position as before. */
export function newMatchMaps(): readonly MapDefinition[] {
  const [openField] = createMapShapes();
  return [openField!, THREE_CROSSINGS_V2, CENTRAL_LAKE_V2, ...SCALE2_MAPS];
}

/** TEMPORARY: maps no new house-mode match
 * (house-1v1..house-4v4) draws until the sim speed-up is in production. Ranked and other modes still draw
 * them. To restore Wide Plain to house draws, empty this list; nothing else changes.
 * Emptied; house modes draw Wide Plain again. */
export const HOUSE_PAUSED_MAP_IDS: readonly string[] = [];

/** The house-mode new-match rotation: newMatchMaps() in order, without HOUSE_PAUSED_MAP_IDS. */
export function houseMatchMaps(): readonly MapDefinition[] {
  return newMatchMaps().filter(map => !HOUSE_PAUSED_MAP_IDS.includes(map.id));
}

/** The six-map house rotation that followed (the new-match rotation without Wide Plain). Retired:
 * no new match draws it, but saved house configs that carry it keep their briefing and rules-page lines. */
export function retiredSixMapHouseRotation(): readonly MapDefinition[] {
  return newMatchMaps().filter(map => map.id !== "wide-plain");
}

function sameWater(a: MapDefinition, b: MapDefinition): boolean {
  return a.id === b.id && a.water.length === b.water.length && a.water.every((rect, i) => {
    const other = b.water[i]!;
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
  });
}

/** Same water, and the same board and grid scale (both absent on the three shapes). */
function sameMap(a: MapDefinition, b: MapDefinition): boolean {
  return sameWater(a, b) && a.gridScale === b.gridScale && JSON.stringify(a.board) === JSON.stringify(b.board);
}

/** The new layout opt-in is already stored as materialized geometry. Recognize
 * that geometry without changing text contracts for saved configurations:
 * the three-map layout, the retired seven-map rotation, the new-match rotation or the house-mode
 * rotation, or the retired six-map house rotation, at grid scale 2. */
export function hasDistinctMapLayouts(rules: TerrainRules): boolean {
  if (rules.referenceWidth !== 64 * NEW_MATCH_GRID_SCALE || rules.referenceHeight !== 48 * NEW_MATCH_GRID_SCALE) return false;
  return [createMapShapes(), retiredSevenMapRotation(), newMatchMaps(), houseMatchMaps(), retiredSixMapHouseRotation()].some(expected =>
    rules.maps.length === expected.length && expected.every(map => {
      const actual = rules.maps.find(candidate => candidate.id === map.id);
      return actual !== undefined && sameMap(map, actual);
    }));
}

/** Factual layout text for the four scale-2 maps and the two v2 maps: [full, compact]. */
const SCALE2_DESCRIPTIONS: Readonly<Record<string, readonly [string, string]>> = {
  "isthmus": ["a gulf from the north edge and one from the south edge, with one land bridge between them on the middle rows", "N/S gulfs; 1 middle land bridge"],
  "twin-shields": ["a crescent lake in front of each start area, hollow facing home, with land round both ends; open centre", "crescent lake before each home; open centre"],
  "four-lanes": ["three long east-west lakes split the middle into four separate lanes", "3 E-W lakes, 4 lanes"],
  "wide-plain": ["two ponds in front of each home leave three gaps onto an open central plain", "2 ponds per home, 3 gaps; open plain"],
  "three-crossings-v2": ["a stepped north-south river with three land crossings", "stepped N/S river, 3 crossings"],
  "central-lake-v2": ["one stepped central lake with land routes north and south", "stepped lake; land N/S"],
};

/** Maps described by SCALE2_DESCRIPTIONS when their stored geometry is exactly this. */
const DESCRIBED_SCALE2_MAPS: readonly MapDefinition[] = [...SCALE2_MAPS, THREE_CROSSINGS_V2, CENTRAL_LAKE_V2];

/** Describe only recognized geometry, not a name that a saved/custom map may
 * reuse. The fallback does not mislabel historical Central Lake as a new lake. */
export function mapLayoutDescription(map: MapDefinition, referenceWidth: number, referenceHeight: number, compact = false): string {
  if (map.water.length === 0) return compact ? "dry" : "open ground with no water";
  if (referenceWidth === 64 * NEW_MATCH_GRID_SCALE && referenceHeight === 48 * NEW_MATCH_GRID_SCALE) {
    const expected = createMapShapes().find(candidate => candidate.id === map.id);
    if (expected !== undefined && sameWater(expected, map)) {
      if (map.id === "three-crossings") return compact ? "N/S river, 3 crossings" : "a north-south river with three land crossings";
      if (map.id === "central-lake") return compact ? "stepped lake; land N/S" : "one stepped central lake with land routes north and south";
    }
    const scale2 = DESCRIBED_SCALE2_MAPS.find(candidate => candidate.id === map.id);
    const text = SCALE2_DESCRIPTIONS[map.id];
    if (scale2 !== undefined && text !== undefined && sameMap(scale2, map)) return compact ? text[1] : text[0];
  }
  return compact ? "water" : "water obstacles; use the water rectangles to find land routes";
}
