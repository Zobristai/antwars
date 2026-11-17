import { expect, it } from "vitest";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { fourColonyEnd } from "../../src/sim/elimination.ts";
import { parseFfaFinish } from "../../src/sim/ffaFinish.ts";

const map: MapDefinition = { id: "fixture-quadrants", name: "Fixture", water: [], quadrant: {
  referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
  startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }],
} };
function world(territoryWinnerFirst = false) {
  const base = newMatchConfig(rulesConfig("redesign"));
  const state = createMatch(404, { ...base, ffaTerritoryWinnerFirst: territoryWinnerFirst,
    earlyWin: { ...base.earlyWin!, minTick: 0, holdTicks: 1, minHeldTiles: 1 }, terrain: { ...base.terrain!, maps: [map] } });
  state.colonies.forEach((c, i) => { c.queenKills = [2, 3, 1, 0][i]!; c.kills = [20, 10, 40, 50][i]!; });
  const kill = (colony: number, tick: number) => state.colonies[colony]!.queens!.forEach(q => { q.lostTick = tick; });
  return { state, kill };
}

it("records queen kills before unit kills at time-up, with all four places", () => {
  const { state } = world();
  state.colonies[0]!.queenKills = 3;
  expect(fourColonyEnd(state, 20, true)).toMatchObject({ winner: 0, reason: "time_up", ffa: {
    version: 1, order: [0, 1, 2, 3], territoryWinnerFirst: false, rateable: true,
  } });
});

it("keeps every survivor above eliminations, with first eliminated last regardless of kills", () => {
  const { state, kill } = world();
  kill(1, 10); expect(fourColonyEnd(state, 10, false)).toBeNull();
  kill(0, 20); expect(fourColonyEnd(state, 20, false)).toBeNull();
  const result = fourColonyEnd(state, 25, true)!;
  expect(result.ffa?.order).toEqual([2, 3, 0, 1]);
  expect(result.ffa?.rateable).toBe(true);
  kill(2, 30);
  expect(fourColonyEnd(state, 30, false)).toMatchObject({ winner: 3, reason: "queens_killed", ffa: { order: [3, 2, 0, 1] } });
});

it("orders same-tick eliminations by queen then unit kills before removal", () => {
  const { state, kill } = world();
  state.colonies[0]!.queenKills = 3;
  kill(0, 10); kill(1, 10);
  expect(fourColonyEnd(state, 10, false)).toBeNull();
  expect(fourColonyEnd(state, 20, true)?.ffa?.order).toEqual([2, 3, 0, 1]);
  expect(state.colonies[0]!.eliminated?.scores).toMatchObject({ queenKills: 3, kills: 20 });
});

it("records simultaneous total elimination and idle endings", () => {
  const { state, kill } = world();
  for (const c of [0, 1, 2, 3]) kill(c, 10);
  expect(fourColonyEnd(state, 10, false)).toMatchObject({ reason: "queens_killed", ffa: { order: [1, 0, 2, 3], rateable: true } });
  const idle = world().state;
  expect(fourColonyEnd(idle, 10, { idle: [0, 1, 2] })).toMatchObject({ winner: 3, reason: "idle", ffa: { order: [3, 1, 0, 2] } });
});

it("both territory settings keep the winner, and only the on setting promotes it in the recorded order", () => {
  for (const enabled of [false, true]) {
    const { state } = world(enabled);
    state.owner.fill(2);
    const result = fourColonyEnd(state, 10, false)!;
    expect(result).toMatchObject({ winner: 2, reason: "sustained_territory" });
    expect(result.ffa).toEqual({ version: 1, order: enabled ? [2, 1, 0, 3] : [1, 0, 2, 3], territoryWinnerFirst: enabled, rateable: true });
  }
});

it("keeps a complete order but declines to rate abandonment and exact score ties", () => {
  const abandoned = fourColonyEnd(world().state, 10, "abandoned")!;
  expect(abandoned.ffa).toMatchObject({ order: [1, 0, 2, 3], rateable: false });
  const { state } = world();
  state.colonies.forEach(c => { c.queenKills = 0; c.kills = 0; });
  const result = fourColonyEnd(state, 10, true)!;
  expect(new Set(result.ffa?.order).size).toBe(4);
  expect(result.ffa?.rateable).toBe(false);
});

it("preserves historical result shape when the recorded config has no finishing metadata switch", () => {
  const { state } = world();
  const { ffaTerritoryWinnerFirst: _policy, ...old } = state.config;
  expect(fourColonyEnd({ ...state, config: old }, 10, true)).not.toHaveProperty("ffa");
});

it("rejects malformed persisted orders and policy flags", () => {
  for (const order of [[0, 0, 2, 3], [0, 1, 2], [0, 1, 2, 4], [0, 1, 2, 1.5]]) {
    expect(() => parseFfaFinish({ version: 1, order, territoryWinnerFirst: false, rateable: true })).toThrow();
  }
  expect(() => parseFfaFinish({ version: 1, order: [0, 1, 2, 3], territoryWinnerFirst: "false", rateable: true })).toThrow();
});
