// A running match keeps one neighbour grid and syncs it at each phase instead
// of rebuilding it five times per tick. Every sync must equal a fresh buildGrid exactly:
// the same ants on every tile, in the same per-tile order.
import { afterEach, describe, expect, it } from "vitest";
import { playScripted } from "../../src/live/record.js";
import { PUBLIC_CONFIG, SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { parseLog, stateHash, terminalAt } from "../../src/sim/log.js";
import { buildGrid, createMatch, forEachNear, GridTracker, newAnt, verifyGridSyncs, type TrackedGrid } from "../../src/sim/map.js";
import { advance, liveGridTracker, prepareInitialPointRests, step } from "../../src/sim/step.js";
import type { SimState } from "../../src/sim/types.js";
import { playable } from "../playable.js";
import { emptyMatch } from "./fixtures.js";

/** Deterministic LCG: no Math.random, so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function expectSameAsBuild(state: SimState, grid: TrackedGrid): void {
  const fresh = buildGrid(state), want: [number, number[]][] = [], got: [number, number[]][] = [];
  let sameObjects = true;
  for (let tile = 0; tile < state.config.mapWidth * state.config.mapHeight; tile++) {
    const a = fresh.get(tile), b = grid.get(tile);
    if (a !== undefined) want.push([tile, a.map(ant => ant.id)]);
    if (b !== undefined) got.push([tile, b.map(ant => ant.id)]);
    if (a !== undefined && b !== undefined && a.some((ant, k) => ant !== b[k])) sameObjects = false;
  }
  expect(got).toEqual(want);
  expect(sameObjects).toBe(true);
}

const config: SimConfig = { ...newMatchConfig(rulesConfig("redesign")), startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [] };

afterEach(() => verifyGridSyncs(false));

describe("GridTracker sync equals buildGrid", () => {
  it("after seeded moves, deaths, hatch appends and replaced ant objects, with one full build", () => {
    const state = emptyMatch(643, config), random = lcg(643);
    const maxX = config.mapWidth * SUB - 1, maxY = config.mapHeight * SUB - 1;
    // Crowd a small area so tiles hold several ants and per-tile order matters.
    const near = () => Math.floor(random() * 12 * SUB);
    for (let i = 0; i < 400; i++) state.ants.push(newAnt(config, state.nextAntId++, i % 2 === 0 ? 0 : 1, near(), near()));
    const tracker = new GridTracker();
    expectSameAsBuild(state, tracker.sync(state));
    for (let round = 0; round < 300; round++) {
      const op = round % 5;
      if (op === 0) for (const ant of state.ants) {
        if (random() < 0.3) { ant.x = Math.max(0, Math.min(maxX, ant.x + Math.floor((random() * 2 - 1) * SUB))); ant.y = Math.max(0, Math.min(maxY, ant.y + Math.floor((random() * 2 - 1) * SUB))); }
      }
      if (op === 1) state.ants = state.ants.filter(() => random() > 0.05);
      if (op === 2) for (let k = Math.floor(random() * 8); k > 0; k--) state.ants.push(newAnt(config, state.nextAntId++, k % 2 === 0 ? 0 : 1, near(), near()));
      if (op === 3) state.ants = state.ants.map(ant => random() < 0.1 ? { ...ant, x: random() < 0.5 ? ant.x : near() } : ant);
      // op 4: nothing changes, as between the end of one tick and the start of the next.
      expectSameAsBuild(state, tracker.sync(state));
    }
    expect(state.ants.length).toBeGreaterThan(50);
    expect(tracker.fullBuilds).toBe(1);
  }, 60_000);

  it("falls back to a full build when ants are not in ascending id order, or the board changes", () => {
    const state = emptyMatch(644, config);
    for (let i = 0; i < 50; i++) state.ants.push(newAnt(config, state.nextAntId++, i % 2 === 0 ? 0 : 1, (i % 5) * SUB, (i % 7) * SUB));
    const tracker = new GridTracker();
    tracker.sync(state);
    state.ants.reverse();
    expectSameAsBuild(state, tracker.sync(state));
    expect(tracker.fullBuilds).toBe(2);
    state.ants.reverse();
    expectSameAsBuild(state, tracker.sync(state));
    expect(tracker.fullBuilds).toBe(3);
    const wider: SimState = { ...state, config: { ...state.config, mapWidth: state.config.mapWidth + 1 } };
    expectSameAsBuild(wider, tracker.sync(wider));
    expect(tracker.fullBuilds).toBe(4);
  });

  it("refuses reads through a handle from an earlier sync", () => {
    const state = emptyMatch(645, config);
    state.ants.push(newAnt(config, state.nextAntId++, 0, 0, 0));
    const tracker = new GridTracker();
    const old = tracker.sync(state), current = tracker.sync(state);
    expect(() => old.get(0)).toThrow(/stale grid/);
    expect(() => forEachNear(state, old, 0, 0, 1, () => {})).toThrow(/stale grid/);
    expect(current.get(0)?.length).toBe(1);
  });
});

const CONFIGS: readonly [string, SimConfig][] = [
  ["public rules", playable(PUBLIC_CONFIG)],
  ["redesign rules (soft separation, point arrival, local ants)", playable(rulesConfig("redesign"))],
];

describe("the live tick syncs one grid", () => {
  it.each(CONFIGS)("%s: every phase's grid equals buildGrid; advance does one full build per match, step one per tick", (_name, config) => {
    const log = parseLog(playScripted({ seed: 643, config, agents: 2, ticks: 400, attack: true }).lines);
    verifyGridSyncs(true); // each sync inside step/advance throws if it differs from buildGrid
    let pure = createMatch(log.header.seed, log.header.config);
    const live = createMatch(log.header.seed, log.header.config);
    prepareInitialPointRests(pure);
    prepareInitialPointRests(live);
    let deaths = 0, hatched = 0;
    while (pure.result === null && pure.tick < 400) {
      const tick = pure.tick, inputs = log.ticks.get(tick) ?? [];
      const expected = step(pure, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      expect(liveGridTracker(expected.state)?.fullBuilds).toBe(1);
      const actual = advance(live, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      expect(actual.results).toEqual(expected.results);
      for (const event of actual.events) { if (event.type === "death") deaths++; if (event.type === "hatch") hatched++; }
      pure = expected.state;
    }
    expect(pure.tick).toBeGreaterThan(100);
    expect(liveGridTracker(live)?.fullBuilds).toBe(1);
    expect(deaths + hatched).toBeGreaterThan(0);
  }, 120_000);

  it.each(CONFIGS)("%s: step's copy takes over the previous grid; stepping that previous state again plays the same tick", (_name, config) => {
    // Post-match analysis steps one state several times (each alternative input set); the moved grid is only a cache.
    const log = parseLog(playScripted({ seed: 643, config, agents: 2, ticks: 300, attack: true }).lines);
    verifyGridSyncs(true);
    let state = createMatch(log.header.seed, log.header.config);
    prepareInitialPointRests(state);
    while (state.result === null && state.tick < 300) {
      const tick = state.tick, inputs = log.ticks.get(tick) ?? [], before = stateHash(state), held = liveGridTracker(state);
      const first = step(state, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      if (held !== undefined) expect(liveGridTracker(first.state)).toBe(held);
      expect(liveGridTracker(state)).toBeUndefined();
      const again = step(state, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      expect(stateHash(state)).toBe(before);
      expect(stateHash(again.state)).toBe(stateHash(first.state));
      expect(again.results).toEqual(first.results);
      expect(again.events).toEqual(first.events);
      state = first.state;
    }
    expect(state.tick).toBeGreaterThan(100);
  }, 120_000);
});
