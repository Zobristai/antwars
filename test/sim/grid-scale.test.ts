import { describe, expect, it } from "vitest";
import { gridScaleOf, physicalTileArea, referenceTile, scaledTileCentre, withGridScale, newMatchConfig, NEW_MATCH_GRID_SCALE, type GridScaleMetadata } from "../../src/sim/gridScale.js";
import { DEFAULT_CONFIG, RULES_VERSION, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { headerLine, parseLog } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { PRE_FRONTLINE_PUBLIC_CONFIG } from "./fixtures.js";
import { tileCentre } from "../../src/sim/geometry.js";

describe("grid scale 2 is the only playable grid scale", () => {
  it("reads only an explicit 2", () => {
    expect(gridScaleOf({ gridScale: 2 })).toBe(2);
    expect(physicalTileArea({ gridScale: 2 })).toBe(4);
  });

  it("refuses a missing marker rather than reading it as grid scale 1, whatever the dimensions", () => {
    for (const config of [{}, { mapWidth: 256, mapHeight: 192 }, DEFAULT_CONFIG, rulesConfig("redesign")]) {
      expect(() => gridScaleOf(config as GridScaleMetadata)).toThrow("grid scale missing: every match plays at grid scale 2");
    }
  });

  it.each([1, 4])("refuses grid scale %i by name", scale => {
    expect(() => gridScaleOf({ gridScale: scale })).toThrow(`grid scale ${scale} no longer plays: every match plays at grid scale 2`);
  });

  it.each([0, 3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, "2"])(
    "refuses unsupported serialized metadata %s rather than playing a different scale", value => {
      expect(() => gridScaleOf({ gridScale: value } as unknown as GridScaleMetadata)).toThrow(RangeError);
    },
  );

  it("a playable config, a log header and a match cannot select another scale or omit it", () => {
    const fine = newMatchConfig(rulesConfig("redesign"));
    for (const [label, config] of [["missing", { ...fine, gridScale: undefined }], ["1", { ...fine, gridScale: 1 }], ["4", { ...fine, gridScale: 4 }]] as const) {
      const bad = config as unknown as SimConfig;
      expect(() => createMatch(7001, bad), label).toThrow(RangeError);
      // newMatchConfig reads an unmarked config as a reference template; a scale-2 board is no template.
      expect(() => newMatchConfig(bad), label).toThrow(label === "missing" ? "distinct maps require dimensions" : `grid scale ${label} no longer plays`);
      const header = JSON.stringify({ type: "header", rulesVersion: RULES_VERSION, seed: 7001, config: bad, holdBehaviour: "ant115" });
      expect(() => parseLog([header]), label).toThrow(/^match log header: grid scale/);
    }
    expect(parseLog([headerLine(7001, fine)]).header.config.gridScale).toBe(2);
  });

  it("preserves one original tile's area at grid scale 2", () => {
    const metadata = { gridScale: 2 };
    const covered = new Set<string>();
    for (let y = 14; y < 16; y++) {
      for (let x = 18; x < 20; x++) {
        expect(referenceTile(x, metadata)).toBe(9);
        expect(referenceTile(y, metadata)).toBe(7);
        covered.add(`${x},${y}`);
      }
    }
    expect(covered.size).toBe(physicalTileArea(metadata));
    expect(referenceTile(20, metadata)).toBe(10);
    expect(referenceTile(16, metadata)).toBe(8);
  });

  it("activates finer rules once at a new-match boundary, without mutating source configs", () => {
    const base = rulesConfig("redesign");
    const before = JSON.stringify(base);
    const config = newMatchConfig(base);
    expect(config.gridScale).toBe(NEW_MATCH_GRID_SCALE);
    expect(config.startArea).toBe("back-quarter");
    expect(config.adjudication).toBe("kills-first");
    expect(config.mapWidth).toBe(base.mapWidth * NEW_MATCH_GRID_SCALE);
    expect(newMatchConfig(config)).toBe(config);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("builds grid scale 2 from a reference template: spatial rules scale, clocks, counts and food budgets do not", () => {
    const scale = 2;
    const base = rulesConfig("redesign"), fine = withGridScale(base);
    expect(fine.gridScale).toBe(2);
    expect(fine.mapWidth).toBe(128);
    expect(fine.mapHeight).toBe(96);
    for (const key of ["nestDeliverTiles", "antSpeedTilesPerSecond", "sightTiles", "smellTiles",
      "overrunRadiusTiles", "markReachTiles", "attackRadiusTiles", "guardEngageTiles"] as const) {
      expect(fine[key]).toBe(base[key] * scale);
    }
    expect(tileCentre(fine.nestTileX) / scale).toBe(tileCentre(base.nestTileX));
    expect(tileCentre(fine.nestTileY) / scale).toBe(tileCentre(base.nestTileY));
    expect((fine.mapWidth * SUB - tileCentre(fine.nestTileX)) / scale)
      .toBe(base.mapWidth * SUB - tileCentre(base.nestTileX));
    expect(fine.foodPatches).toEqual(base.foodPatches.map(p => ({ ...p,
      tileX: scaledTileCentre(p.tileX, scale), tileY: scaledTileCentre(p.tileY, scale), radius: p.radius * scale })));
    expect(fine.foodLayout!.minStartingFood).toBe(base.foodLayout!.minStartingFood);
    expect(fine.foodLayout!.maxStartingFood).toBe(base.foodLayout!.maxStartingFood);
    expect(fine.foodLayout!.positionJitterTiles).toBe(base.foodLayout!.positionJitterTiles * scale);
    expect(fine.countMarks!.recruitTiles).toBe(base.countMarks!.recruitTiles * scale);
    expect(fine.countMarks!.defendTiles).toBe(base.countMarks!.defendTiles * scale);
    expect(fine.localAnts!.workerQueenThreatTiles).toBe(base.localAnts!.workerQueenThreatTiles! * scale);
    expect(fine.queenFounding!.minDistanceTiles).toBe(base.queenFounding!.minDistanceTiles * scale);
    expect(fine.queenHp!.regenClearTiles).toBe(base.queenHp!.regenClearTiles * scale);
    for (const key of ["radius", "strength", "maxStep", "arrivalSubunits", "epsilon", "arrivalLinkRadius"] as const) {
      expect(fine.softSeparation![key]).toBe(base.softSeparation![key] * scale);
    }
    for (const key of ["matchTicks", "startAnts", "colonyCap", "hatchCost", "hatchIntervalTicks",
      "foodRegrowTicks", "groundFoodIntervalTicks", "territoryDecayTicks", "damagePerSecond", "squadSize"] as const) {
      expect(fine[key]).toBe(base[key]);
    }
    expect(fine.earlyWin).toEqual(base.earlyWin);
    expect(fine.terrain).toEqual(base.terrain);
    expect(() => withGridScale(fine)).toThrow("reference-grid template");
  });
});

it("opts an already scaled new match into strips without converting saved rules", () => {
  const { adjudication: _newScoring, ...historical } = PRE_FRONTLINE_PUBLIC_CONFIG;
  const saved = withGridScale(historical), before = JSON.stringify(saved);
  expect(saved.startArea).toBeUndefined();
  const current = newMatchConfig(saved);
  expect(current).toEqual({ ...saved, startArea: "back-quarter" });
  expect(newMatchConfig(current)).toBe(current);
  expect(JSON.stringify(saved)).toBe(before);
});
