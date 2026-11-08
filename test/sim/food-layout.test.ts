import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { balanceRuleLines } from "../../src/mcp/briefing.js";
import { MAPS, PUBLIC_CONFIG, SUB, TERRAIN_RULES, rulesConfig, type FoodPatch, type SimConfig } from "../../src/sim/config.js";
import { FoodLayoutError, generateFoodLayout, generateReferenceFoodLayout } from "../../src/sim/foodLayout.js";
import { newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { createTerrain, isWaterTile, passableMask } from "../../src/sim/terrain.js";
import { HISTORICAL_DEFAULT_CONFIG, PRE_FRONTLINE_CONFIGS, HISTORICAL_PUBLIC_CONFIG } from "./fixtures.js";
import { playable } from "../playable.ts";
import { sevenMapRotation } from "./seven-map-rotation.js";

// Named stored recipes: these scenarios exercise the historical reference-grid maps.
const recordedPublicLayout = PRE_FRONTLINE_CONFIGS.public;
const recordedRedesignLayout = PRE_FRONTLINE_CONFIGS.redesign;
const recordedCountMarksLayout = PRE_FRONTLINE_CONFIGS["count-marks"];
const variants = [recordedPublicLayout, recordedRedesignLayout, recordedCountMarksLayout];
const liveVariants = [PUBLIC_CONFIG, rulesConfig("redesign"), rulesConfig("count-marks")];
const fullPatches = (config: SimConfig, patches: readonly FoodPatch[]) => patches.flatMap((p) => [p, { ...p, tileX: config.mapWidth - 1 - p.tileX }]);

// Every match plays at grid scale 2. Food placement still runs on the reference grid, so these
// recipes stay reference-grid templates: a layout is produced at grid scale 2 and read back in reference
// units (lengths halved, centres mapped back), and food is checked per reference cell (its 2x2 fine cells).
const toReference = (p: FoodPatch): FoodPatch => ({ ...p, tileX: (p.tileX + 0.5) / 2 - 0.5, tileY: (p.tileY + 0.5) / 2 - 0.5, radius: p.radius / 2 });
/** The production layout of a reference recipe at grid scale 2, in reference units. */
const layout = (config: SimConfig, seed: number, mask?: readonly boolean[]) => generateFoodLayout(playable(config), seed, mask).map(toReference);
/** A reference-cell mask expanded to the grid-scale-2 fine cells it covers. */
const fineMask = (config: SimConfig, mask: readonly boolean[]) => Array.from({ length: 4 * config.mapWidth * config.mapHeight },
  (_, i) => mask[Math.floor(Math.floor(i / (2 * config.mapWidth)) / 2) * config.mapWidth + Math.floor((i % (2 * config.mapWidth)) / 2)]!);
/** The grid-scale-2 passable mask of a reference recipe's terrain for this seed. */
const terrainMask = (config: SimConfig, seed: number) => { const fine = playable(config); return passableMask(fine, createTerrain(seed, fine)!); };
const fineCells = (x: number, y: number) => [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]] as const;

function footprint(patch: FoodPatch): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = -patch.radius; y <= patch.radius; y++) for (let x = -patch.radius; x <= patch.radius; x++) {
    if (x * x + y * y <= patch.radius ** 2) tiles.push({ x: patch.tileX + x, y: patch.tileY + y });
  }
  return tiles;
}

function nearestFoodDistanceSquared(patch: FoodPatch, nestX: number, nestY: number): number {
  return Math.min(...footprint(patch).map(({ x, y }) => (x - nestX) ** 2 + (y - nestY) ** 2));
}

function checkLayout(config: SimConfig, seed: number): void {
  const state = createMatch(seed, playable(config));
  const rules = config.foodLayout!;
  const patches = fullPatches(config, state.config.foodPatches.map(toReference));
  expect(state.config.foodPatches).toHaveLength(rules.patches.length);
  const total = state.food.reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThanOrEqual(rules.minStartingFood);
  expect(total).toBeLessThanOrEqual(rules.maxStartingFood);
  for (const [i, p] of patches.entries()) {
    expect(p.tileX - p.radius).toBeGreaterThanOrEqual(0);
    expect(p.tileX + p.radius).toBeLessThan(config.mapWidth);
    expect(p.tileY - p.radius).toBeGreaterThanOrEqual(0);
    expect(p.tileY + p.radius).toBeLessThan(config.mapHeight);
    for (const nest of [config.nestTileX, config.mapWidth - 1 - config.nestTileX]) {
      expect((p.tileX - nest) ** 2 + (p.tileY - config.nestTileY) ** 2).toBeGreaterThanOrEqual((p.radius + rules.nestClearanceTiles) ** 2);
    }
    for (const q of patches.slice(i + 1)) {
      expect((p.tileX - q.tileX) ** 2 + (p.tileY - q.tileY) ** 2).toBeGreaterThanOrEqual((p.radius + q.radius + rules.patchClearanceTiles) ** 2);
    }
  }
  // Every cell's checks are collected and asserted once per layout: one expect per cell (about 16,000 a layout) cost
  // seconds per map case on a shared CI core.
  const width = state.config.mapWidth;
  const unmirrored: number[] = [], foodOnWater: number[] = [];
  for (let i = 0; i < state.food.length; i++) {
    const fx = i % width, fy = Math.floor(i / width);
    if (state.food[i] !== state.food[fy * width + width - 1 - fx]) unmirrored.push(i);
    if (state.food[i]! > 0 && isWaterTile(state.terrain, fx, fy)) foodOnWater.push(i);
  }
  expect(unmirrored, "fine cells whose food differs from their mirror's").toEqual([]);
  expect(foodOnWater, "fine cells with food on water").toEqual([]);
  const wetFootprint: { x: number; y: number }[] = [];
  const wrongAmount: { x: number; y: number; amount: number; min: number; max: number }[] = [];
  for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) {
    const amount = fineCells(x, y).reduce((sum, [fx, fy]) => sum + state.food[fy * width + fx]!, 0);
    const patch = patches.find((p) => (x - p.tileX) ** 2 + (y - p.tileY) ** 2 <= p.radius ** 2);
    if (patch === undefined) {
      if (amount !== 0) wrongAmount.push({ x, y, amount, min: 0, max: 0 });
    } else {
      if (fineCells(x, y).some(([fx, fy]) => isWaterTile(state.terrain, fx, fy))) wetFootprint.push({ x, y });
      const min = Math.max(1, patch.perTile - config.foodJitter), max = patch.perTile + config.foodJitter;
      if (amount < min || amount > max) wrongAmount.push({ x, y, amount, min, max });
    }
  }
  expect(wetFootprint, "footprint cells with a fine cell on water").toEqual([]);
  expect(wrongAmount, "reference cells whose food is outside their patch's range (0 off every patch)").toEqual([]);
  expect(state.foodCap).toEqual(state.food);
}

describe("seeded mirrored food layout on recorded older recipes", () => {
  it.each(variants)("is repeatable and changes centres, sizes and richness without mutating the source (%#)", (config) => {
    const before = JSON.stringify(config);
    const positions = new Set<string>(), sizes = new Set<string>(), richness = new Set<string>();
    for (let seed = 0; seed < 48; seed++) {
      const patches = layout(config, seed);
      expect(layout(config, seed)).toEqual(patches);
      positions.add(JSON.stringify(patches.map((p) => [p.tileX, p.tileY])));
      sizes.add(JSON.stringify(patches.map((p) => p.radius)));
      richness.add(JSON.stringify(patches.map((p) => p.perTile)));
    }
    expect(positions.size).toBeGreaterThan(1);
    expect(sizes.size).toBeGreaterThan(1);
    expect(richness.size).toBeGreaterThan(1);
    expect(JSON.stringify(config)).toBe(before);
    expect(layout(config, 7001)).not.toEqual(layout(config, 7002));
  });

  it.each(variants)("keeps every footprint clear, mirrored and within the food budget (%#)", (config) => {
    for (const seed of [0, 1, 11, 7001, 7002, 7003, 7004, 0xffffffff]) checkLayout(config, seed);
  });

  it.each(MAPS)("$name: generates complete dry mirrored footprints and the full food budget for every rules variant", (map) => {
    for (const variant of variants) {
      const config = { ...variant, terrain: { ...TERRAIN_RULES, mapId: map.id } };
      for (const seed of [0, 1, 11, 7001, 7002, 7003, 7004, 0xffffffff]) checkLayout(config, seed);
    }
  });

  it.each(variants)("splits Central Lake's blocked centre into equal mirrored bank halves without changing size, richness or food total (%#)", (variant) => {
    for (const seed of [0, 1, 11, 7001, 7002, 7003, 7004]) {
      const dry = createMatch(seed, playable({ ...variant, terrain: undefined }));
      const state = createMatch(seed, playable({ ...variant, terrain: { ...TERRAIN_RULES, mapId: "central-lake" } }));
      const index = variant.foodLayout!.patches.findIndex(p => p.tileY === variant.nestTileY && p.tileX > variant.mapWidth / 3);
      const before = toReference(dry.config.foodPatches[index]!), bank = toReference(state.config.foodPatches[index]!);
      const other = { ...bank, tileX: variant.mapWidth - 1 - bank.tileX };
      const middle = variant.mapWidth / 2;
      // The lane row must remain the nest row; its two mirror-line cells are
      // underwater, so moving a central patch on the line cannot be legal.
      for (const [fx, fy] of [...fineCells(middle - 1, variant.nestTileY), ...fineCells(middle, variant.nestTileY)]) {
        expect(isWaterTile(state.terrain, fx, fy)).toBe(true);
      }
      expect(bank.tileY).toBe(variant.nestTileY);
      expect(bank.radius).toBe(before.radius);
      expect(bank.perTile).toBe(before.perTile);
      expect(bank.tileX + bank.radius).toBe(26); // Nearest legal left bank; its mirror is equally close on the right.
      expect((bank.tileX + other.tileX) / 2).toBe((variant.mapWidth - 1) / 2);
      expect(footprint(bank).length + footprint(other).length).toBe(2 * footprint(before).length);
      for (const p of [bank, other]) for (const tile of footprint(p)) for (const [fx, fy] of fineCells(tile.x, tile.y)) {
        expect(isWaterTile(state.terrain, fx, fy)).toBe(false);
      }
      expect(state.config.foodPatches.filter((_, i) => i !== index)).toEqual(dry.config.foodPatches.filter((_, i) => i !== index));
      expect(state.food.reduce((sum, food) => sum + food, 0)).toBe(dry.food.reduce((sum, food) => sum + food, 0));
    }
  });

  it.each(variants)("leaves Open Field and every already-dry seeded layout unchanged (%#)", (variant) => {
    for (const seed of [0, 1, 11, 7001, 7002, 7003, 7004]) {
      const original = layout(variant, seed);
      for (const map of MAPS) {
        const config = { ...variant, terrain: { ...TERRAIN_RULES, mapId: map.id } };
        // Food generation precedes rocks; finalized obstacles must not feed back into its draw schedule.
        const mask = terrainMask(config, seed), width = 2 * config.mapWidth;
        if (fullPatches(config, original).every(p => footprint(p).every(t => fineCells(t.x, t.y).every(([fx, fy]) => mask[fy * width + fx])))) {
          expect(layout(config, seed, mask)).toEqual(original);
        }
      }
    }
  });

  it.each(variants)("preserves lane/flank roles and does not move flank food farther from home (%#)", (config) => {
    for (const seed of [...Array.from({ length: 64 }, (_, i) => i), 7001, 7002, 7003, 7004]) {
      const patches = layout(config, seed);
      for (const [index, template] of config.foodLayout!.patches.entries()) {
        const patch = patches[index]!;
        expect(Math.sign(patch.tileY - config.nestTileY)).toBe(Math.sign(template.tileY - config.nestTileY));
        if (template.tileY === config.nestTileY) continue;
        for (const colony of [0, 1] as const) {
          const homeX = colony === 0 ? config.nestTileX : config.mapWidth - 1 - config.nestTileX;
          const own = (p: FoodPatch) => colony === 0 ? p : { ...p, tileX: config.mapWidth - 1 - p.tileX };
          expect(nearestFoodDistanceSquared(own(patch), homeX, config.nestTileY))
            .toBeLessThanOrEqual(nearestFoodDistanceSquared(own(template), homeX, config.nestTileY));
        }
      }
    }
  });

  // Known failure: opening food sits 13 fine tiles from starting ants with sight 12; a separate fix is planned.
  it.fails("keeps bootstrap flank food within opening sight on both sides, including the failed sweep seeds", () => {
    const config = recordedRedesignLayout;
    for (const seed of [...Array.from({ length: 64 }, (_, i) => i), 7001, 7002, 7003, 7004]) {
      const state = createMatch(seed, playable(config)), width = state.config.mapWidth;
      const bootstrap = toReference(state.config.foodPatches[0]!);
      expect(bootstrap.tileY).not.toBe(config.nestTileY);
      for (const colony of [0, 1] as const) {
        const patch = colony === 0 ? bootstrap : { ...bootstrap, tileX: config.mapWidth - 1 - bootstrap.tileX };
        // Sight is a length: twice the reference sight, in fine tiles.
        expect(state.ants.filter((ant) => ant.colony === colony).some((ant) => footprint(patch).some(({ x, y }) =>
          fineCells(x, y).some(([fx, fy]) => state.food[fy * width + fx]! > 0 &&
          (Math.floor(ant.x / SUB) - fx) ** 2 + (Math.floor(ant.y / SUB) - fy) ** 2 <= (2 * config.sightTiles) ** 2)))).toBe(true);
      }
    }
  });

  it("validates masks on both sides and on every footprint tile, not just the centre", () => {
    const config = recordedRedesignLayout;
    const initial = layout(config, 7001);
    const patch = initial[0]!;
    const mask = new Array<boolean>(config.mapWidth * config.mapHeight).fill(true);
    const blocked = patch.tileY * config.mapWidth + config.mapWidth - 1 - (patch.tileX + patch.radius);
    mask[blocked] = false; // Only the mirror's outer edge, not a centre.
    const generated = layout(config, 7001, fineMask(config, mask));
    expect(generated).not.toEqual(initial);
    for (const p of fullPatches(config, generated)) {
      const x = blocked % config.mapWidth, y = Math.floor(blocked / config.mapWidth);
      expect((x - p.tileX) ** 2 + (y - p.tileY) ** 2).toBeGreaterThan(p.radius ** 2);
    }
    // Mask length is validated on the reference grid, where placement runs.
    expect(() => generateReferenceFoodLayout(config, 7001, [])).toThrow(/one cell/);
    const bounded = { ...config, foodLayout: { ...config.foodLayout!, layoutAttempts: 2, placementAttempts: 2 } };
    expect(() => layout(bounded, 1, fineMask(config, mask.map(() => false)))).toThrow(/Cannot place/);
  });

  it("rejects genuinely impossible spacing, budgets, seam and boundary conditions", () => {
    for (const overrides of [
      { nestClearanceTiles: 1000 }, { patchClearanceTiles: 1000 },
      { minStartingFood: 100000, maxStartingFood: 100001 },
      { patches: [{ tileX: 31, tileY: 0, radius: 4, perTile: 2 }], positionJitterTiles: 0 },
    ]) {
      const config = { ...PUBLIC_CONFIG, foodLayout: { ...recordedPublicLayout.foodLayout!, layoutAttempts: 2, placementAttempts: 2, ...overrides } };
      expect(() => layout(config, 11)).toThrow(/Cannot place/);
    }
    // An odd reference width cannot be built at grid scale 2; the reference grid still refuses it.
    expect(() => generateReferenceFoodLayout({ ...PUBLIC_CONFIG, mapWidth: 63 }, 1)).toThrow(/Invalid/);
    expect(() => layout({ ...PUBLIC_CONFIG, foodLayout: { ...PUBLIC_CONFIG.foodLayout!, placementAttempts: NaN } }, 1)).toThrow(/Invalid/);
  });

  it.each([504997660, 1939145559, 1551485998])("starts public seed %i, which exhausted placement on the pre-fix baseline", (seed) => {
    checkLayout(recordedPublicLayout, seed);
    const state = createMatch(seed, playable(recordedPublicLayout));
    expect(state.terrain?.mapId).toBe("three-crossings");
    expect(stateHash(createMatch(seed, playable(recordedPublicLayout)))).toBe(stateHash(state));
    for (const config of [playable(recordedPublicLayout), state.config]) {
      expect(stateHash(replay([headerLine(seed, config)], 0))).toBe(stateHash(state));
    }
  });

  it("starts forced Three Crossings seed 301 with a complete legal layout", () => {
    checkLayout({ ...recordedPublicLayout, terrain: { ...recordedPublicLayout.terrain!, mapId: "three-crossings" } }, 301);
  });

  it("backtracks after an early legal patch blocks the only complete layout, without relaxing any bounds", () => {
    const config: SimConfig = { ...PUBLIC_CONFIG, terrain: undefined, mapWidth: 40, mapHeight: 20,
      nestTileX: 0, nestTileY: 10, foodJitter: 0, startAnts: 0,
      foodLayout: { patches: [
        { tileX: 7, tileY: 10, radius: 1, perTile: 1 },
        { tileX: 4, tileY: 10, radius: 1, perTile: 1 },
      ], positionJitterTiles: 1, radiusJitterTiles: 0, richnessJitter: 0,
      nestClearanceTiles: 0, patchClearanceTiles: 2, minStartingFood: 20, maxStartingFood: 20,
      layoutAttempts: 1, placementAttempts: 1 } };
    const before = JSON.stringify(config);
    // Seeds 5 and 6 both draw x=6 then x=3 in their only random attempt:
    // the gap is 3, below the required 4. Exhaustive search first tries x=6
    // (no second candidate fits), then backtracks to x=7 and x=3.
    const patches = layout(config, 5);
    expect(patches.map(p => p.tileX)).toEqual([7, 3]);
    expect(layout(config, 6)).toEqual(patches);
    expect(JSON.stringify(config)).toBe(before);
    checkLayout(config, 5);
  });

  it("exhaustive fallback preserves roles, reach, budgets and dry mirrored footprints on all public maps", () => {
    for (const variant of variants) for (const map of MAPS) {
      const config = { ...variant, terrain: { ...TERRAIN_RULES, mapId: map.id },
        foodLayout: { ...variant.foodLayout!, placementAttempts: 1, layoutAttempts: 1 } };
      checkLayout(config, 504997660);
      const state = createMatch(504997660, playable(config));
      for (const [index, template] of config.foodLayout.patches.entries()) {
        const patch = toReference(state.config.foodPatches[index]!);
        expect(Math.sign(patch.tileY - config.nestTileY)).toBe(Math.sign(template.tileY - config.nestTileY));
        if (template.tileY !== config.nestTileY) {
          expect(nearestFoodDistanceSquared(patch, config.nestTileX, config.nestTileY))
            .toBeLessThanOrEqual(nearestFoodDistanceSquared(template, config.nestTileX, config.nestTileY));
        }
      }
    }
  });

  it("refuses invalid layout inputs with FoodLayoutError", () => {
    expect(() => generateReferenceFoodLayout({ ...PUBLIC_CONFIG, mapWidth: 63 }, 1)).toThrow(FoodLayoutError);
    expect(() => generateReferenceFoodLayout(PUBLIC_CONFIG, 1, [])).toThrow(FoodLayoutError);
  });

  it("resolves one immutable match config for steering, briefing and replay from either kind of header", () => {
    const config = newMatchConfig({ ...rulesConfig("redesign"), matchTicks: 20 });
    const initial = createMatch(7001, config);
    expect(initial.config).not.toBe(config);
    expect(initial.config.foodPatches).toEqual(generateFoodLayout(config, 7001,
      initial.terrain === undefined ? undefined : passableMask(initial.config, createTerrain(7001, config)!)));
    const text = balanceRuleLines(initial.config).join("\n");
    for (const p of initial.config.foodPatches) expect(text).toContain(`(${p.tileX},${p.tileY}), radius ${p.radius}, ${p.perTile} food`);
    expect(text).not.toContain("centre patch is smaller");
    let state = initial;
    for (let i = 0; i < 20; i++) state = step(state).state;
    for (const headerConfig of [config, initial.config]) {
      expect(stateHash(replay([headerLine(7001, headerConfig)], 20))).toBe(stateHash(state));
    }
  });

  it("leaves configs without a seeded layout, their state shape and RNG consumption untouched", () => {
    expect(generateFoodLayout(HISTORICAL_DEFAULT_CONFIG, 11)).toBe(HISTORICAL_DEFAULT_CONFIG.foodPatches);
    const playedDefault = playable(HISTORICAL_DEFAULT_CONFIG);
    expect(createMatch(11, playedDefault).config).toBe(playedDefault);
    // Preserve the pre-layout/terrain/uncapped header, not a stripped live config.
    const historical = HISTORICAL_PUBLIC_CONFIG;
    const playedHistorical = playable(historical);
    expect(createMatch(11, playedHistorical).config).toBe(playedHistorical);
    expect(createMatch(11, playedHistorical)).not.toHaveProperty("foodLayout");
  });
});

describe("approved frontline patches", () => {
  it("preserves sampled Open Field and Three Crossings layouts from main 4528429bdd26efecbe21c8814265fb4e78fe290a", () => {
    // Captured with that head's actual generateFoodLayout, not this implementation.
    const pins = [
      [undefined, "2f78c620527a2b6cde673ac746a655629e9990ee8fb9983f68e817d84066dad5", "98a28885c8a5fad5de9955cdbaa663b6c21fa07168cd6524cbe32f5ce432e82b"],
      ["count-marks", "2f78c620527a2b6cde673ac746a655629e9990ee8fb9983f68e817d84066dad5", "98a28885c8a5fad5de9955cdbaa663b6c21fa07168cd6524cbe32f5ce432e82b"],
      ["redesign", "d261152ad73fe454c1d3a74012d9a848765c3f4c430b9edf4fc5b421c88ad9e7", "cdd1dfdfb32da2de6fa27e9f9dea6ad7aba7f26c4c15758f97361ab6b12514c4"],
    ] as const;
    for (const [name, open, crossings] of pins) for (const [mapId, pin] of [["open-field", open], ["three-crossings", crossings]]) {
      const variant = rulesConfig(name);
      const config = { ...variant, wordMarksDisabled: undefined, terrain: { ...variant.terrain!, mapId } };
      const layouts = [0, 1, 6, 11, 7001, 7002, 504997660, 0xffffffff].map(seed => layout(config, seed, terrainMask(config, seed)));
      expect(createHash("sha256").update(JSON.stringify(layouts)).digest("hex")).toBe(pin);
    }
  });

  it.each(liveVariants)("keeps seeded Central Lake centre, radius and richness variation after omitting the impossible pair (%#)", variant => {
    const config = { ...variant, terrain: { ...variant.terrain!, mapId: "central-lake" } };
    const mask = terrainMask(config, 0);
    const centres = new Set<string>(), radii = new Set<string>(), richness = new Set<string>();
    const before = JSON.stringify(config);
    for (let seed = 0; seed < 40; seed++) {
      const patches = layout(config, seed, mask);
      expect(layout(config, seed, mask)).toEqual(patches);
      centres.add(JSON.stringify(patches.map(p => [p.tileX, p.tileY])));
      radii.add(JSON.stringify(patches.map(p => p.radius)));
      richness.add(JSON.stringify(patches.map(p => p.perTile)));
    }
    expect(centres.size).toBeGreaterThan(1);
    expect(radii.size).toBeGreaterThan(1);
    expect(richness.size).toBeGreaterThan(1);
    expect(JSON.stringify(config)).toBe(before);
  });

  it.each(liveVariants)("omits Central Lake's unplaceable southern frontline on both sides, preserving dry mirrored food and bounds (%#)", variant => {
    for (const scale of [2] as const) {
      const base = withGridScale(variant);
      const config = { ...base, terrain: { ...base.terrain!, mapId: "central-lake" } };
      const state = createMatch(6, config);
      expect(state.config.foodPatches.length).toBeGreaterThanOrEqual(4);
      expect(state.config.foodPatches.length).toBeLessThan(6);
      for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) {
        const food = state.food[y * config.mapWidth + x]!;
        expect(food).toBe(state.food[y * config.mapWidth + config.mapWidth - 1 - x]);
        if (food > 0) expect(isBlockedTile(state.terrain, x, y)).toBe(false);
        // All possible southern frontline footprints, left AND right, are empty.
        if (x >= 25 * scale && x < 39 * scale && y >= 35 * scale && y < 42 * scale) expect(food).toBe(0);
      }
      expect(state.foodCap).toEqual(state.food);
      expect(state.food.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(452);
      expect(state.food.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1026);
      expect(stateHash(replay([headerLine(6, state.config)], 0))).toBe(stateHash(state));
    }
  });

  it("does not omit mandatory pairs or unmarked stored recipes", () => {
    const config = { ...PUBLIC_CONFIG, terrain: { ...PUBLIC_CONFIG.terrain!, mapId: "central-lake" } };
    const { optionalPatchIndices: _optional, ...strict } = config.foodLayout!;
    expect(() => createMatch(6, playable({ ...config, foodLayout: strict }))).toThrow(FoodLayoutError);
    expect(() => layout(config, 6, Array(4 * config.mapWidth * config.mapHeight).fill(false))).toThrow(FoodLayoutError);
  });

  it.each(liveVariants)("adds only the two approved templates before implicit mirroring (%#)", config => {
    expect(config.foodPatches.slice(-2)).toEqual([
      { tileX: 28, tileY: 10, radius: 1, perTile: 1 },
      { tileX: 28, tileY: 38, radius: 1, perTile: 1 },
    ]);
    expect(config.foodLayout!.patches).toEqual(config.foodPatches);
    expect(config.foodLayout).toMatchObject({ minStartingFood: 452, maxStartingFood: 1026,
      positionJitterTiles: 2, radiusJitterTiles: 1, richnessJitter: 1,
      nestClearanceTiles: 2, patchClearanceTiles: 1 });
  });

  it.each(MAPS)("$id: mirrors the actual new-match food and caps on passable ground", map => {
    for (const variant of liveVariants) for (const seed of [7919, 23757, 1045308]) {
      // Pinned to the seven-map rotation this was written for, which holds the old two.
      const base = sevenMapRotation(newMatchConfig(variant));
      const state = createMatch(seed, { ...base, terrain: { ...base.terrain!, mapId: map.id } });
      const reflected = state.food.map((_, tile) => {
        const x = tile % base.mapWidth, y = Math.floor(tile / base.mapWidth);
        return state.food[y * base.mapWidth + base.mapWidth - 1 - x]!;
      });
      expect(state.config.foodPatches).toHaveLength(6);
      expect(state.food).toEqual(reflected);
      expect(state.foodCap).toEqual(state.food);
      for (let tile = 0; tile < state.food.length; tile++) {
        if (state.food[tile]! > 0) expect(isBlockedTile(state.terrain,
          tile % base.mapWidth, Math.floor(tile / base.mapWidth))).toBe(false);
      }
      const total = state.food.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(452);
      expect(total).toBeLessThanOrEqual(1026);
    }
  });
});
