/** Tuning map config: a match on the tuning map can be configured at any per-side ant count up to 10,000,
 * plays with that count as its colony cap at grid scale 2, and lasts 27,000 ticks.
 * Every match here starts 30 ants per side, whatever the cap, so these tests do not depend on the start population;
 * the 10,000-living-ants test starts the tuning map's own full population. */
import { describe, expect, it } from "vitest";
import { WIDE_PLAIN } from "../../src/sim/scale2Maps.js";
import { createMatch } from "../../src/sim/map.js";
import { hatch } from "../../src/sim/forage.js";
import { step } from "../../src/sim/step.js";
import { TUNING_MAP_ID, TUNING_MAP_MAX_ANTS_PER_SIDE, tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt } from "./fixtures.js";

const SEED = 7001;
const START_ANTS = 30;
const COUNTS = [1, 2, 35, 512, 768, 769, 1024, 4096, 9_999, TUNING_MAP_MAX_ANTS_PER_SIDE];
const match = (perSide: number): SimState => createMatch(SEED, { ...tuningMapConfig(perSide), startAnts: START_ANTS });

describe("tuning map configuration", () => {
  it("pins every match to the tuning map alone", () => {
    const config = tuningMapConfig(1024);
    expect(TUNING_MAP_ID).toBe("tuning-plain");
    expect(TUNING_MAP_MAX_ANTS_PER_SIDE).toBe(10_000);
    expect(config.terrain!.mapId).toBe(TUNING_MAP_ID);
    expect(config.terrain!.maps.map(map => [map.id, map.name, map.gridScale, map.colonyCap, map.matchTicks]))
      .toEqual([[TUNING_MAP_ID, "Tuning Plain", 2, 1024, 27_000]]);
    expect(config.rules).toBe("redesign");
  });

  it.each(COUNTS)("%i per side: a match on it has that colony cap, grid scale 2 and 27,000 ticks", perSide => {
    const state = match(perSide);
    expect(state.terrain!.mapId).toBe(TUNING_MAP_ID);
    const { colonyCap, gridScale, matchTicks, mapWidth, mapHeight } = state.config;
    expect({ colonyCap, gridScale, matchTicks, mapWidth, mapHeight })
      .toEqual({ colonyCap: perSide, gridScale: 2, matchTicks: 27_000, mapWidth: 256, mapHeight: 184 });
  });

  it.each([0, -1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s per side", perSide => {
    expect(() => tuningMapConfig(perSide)).toThrow(RangeError);
  });

  it("plays on Wide Plain's 128-column layout over 92 reference rows: its water, nest and food centres on doubled rows", () => {
    const [map] = tuningMapConfig(768).terrain!.maps;
    const wide = WIDE_PLAIN.board!;
    expect(map!.water).toEqual(WIDE_PLAIN.water.map(r => ({ ...r, y: 2 * r.y, height: 2 * r.height })));
    expect(map!.board).toEqual({ ...wide, referenceHeight: 92, nestTileY: 46, foodPatches: wide.foodPatches.map(p => ({ ...p, tileY: 2 * p.tileY })) });
  });
});

describe("a tuning-map match plays with the chosen count as its colony cap", () => {
  /** Colony 0 holds exactly `living` ants, with food to spare; the hatch events one hatch pass gives it. */
  function hatchedAt(state: SimState, living: number, tick: number): SimEvent[] {
    state.ants = state.ants.filter(ant => ant.colony !== 0);
    for (let i = 0; i < living; i++) addAnt(state, 0, 30, 46);
    state.colonies[0].foodStore = 1_000_000;
    state.tick = tick;
    const events: SimEvent[] = [];
    hatch(state, tick, events);
    return events.filter(event => event.type === "hatch" && event.colony === 0);
  }

  it.each([1, 35, 1024, TUNING_MAP_MAX_ANTS_PER_SIDE])("%i per side: no hatch at the cap, one hatch just below it", perSide => {
    expect(hatchedAt(match(perSide), perSide, 10_000)).toEqual([]);
    expect(hatchedAt(match(perSide), perSide - 1, 10_000)).toHaveLength(1);
  });

  it("10,000 per side: the match advances tick by tick, keeping its cap", () => {
    let state = match(TUNING_MAP_MAX_ANTS_PER_SIDE);
    for (let i = 0; i < 20; i++) state = step(state, []).state;
    expect(state.tick).toBe(20);
    expect(state.result).toBeNull();
    expect(state.config.colonyCap).toBe(TUNING_MAP_MAX_ANTS_PER_SIDE);
  });

  // On Wide Plain's 256x92 board, more than about 6,200 living ants per side exhaust the resting sites
  // (PointRestCapacityError on tick 0); the tuning map's own 256x184 board holds 10,000 per side.
  it("10,000 living ants per side: the match plays its first ticks", () => {
    let state = createMatch(SEED, tuningMapConfig(TUNING_MAP_MAX_ANTS_PER_SIDE));
    for (let i = 0; i < 3; i++) state = step(state, []).state;
    expect([state.tick, state.result, state.config.colonyCap]).toEqual([3, null, TUNING_MAP_MAX_ANTS_PER_SIDE]);
    expect([0, 1].map(colony => state.ants.filter(ant => ant.colony === colony).length))
      .toEqual([TUNING_MAP_MAX_ANTS_PER_SIDE, TUNING_MAP_MAX_ANTS_PER_SIDE]);
  }, 120_000);
});

describe("a tuning-map match lasts 27,000 ticks", () => {
  // A full match takes minutes; as the map-length tests do, the clock is moved to just before the end.
  it.each([35, TUNING_MAP_MAX_ANTS_PER_SIDE])("%i per side: still running after tick 26,998, ended by time at tick 26,999", perSide => {
    let state = match(perSide);
    state.tick = 26_998;
    state = step(state, []).state;
    expect([state.tick, state.result]).toEqual([26_999, null]);
    state = step(state, []).state;
    expect(state.tick).toBe(27_000);
    expect(state.result).toMatchObject({ reason: "time_up", tick: 26_999 });
  });
});
