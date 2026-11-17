import { expect, it } from "vitest";
import { rulesConfig, type MapDefinition } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch } from "../../src/sim/map.ts";
import { fourColonyEnd } from "../../src/sim/elimination.ts";
import { parseFfaFinish } from "../../src/sim/ffaFinish.ts";
import { applyFfaResult, FFA_COLLECTION } from "../../src/rating/ffa.ts";
import { retentionWorld } from "../identity/retentionStore.ts";

const map: MapDefinition = { id: "fixture-quadrants", name: "Fixture", water: [], quadrant: {
  referenceWidth: 64, referenceHeight: 48, centreHalfWidth: 2, centreHalfHeight: 2, nestTileX: 29, nestTileY: 8,
  startArea: { x: 0, y: 0, width: 8, height: 8 }, foodPatches: [{ tileX: 8, tileY: 8, radius: 3, perTile: 2 }], centreFood: [{ radius: 1, perTile: 2 }],
} };
function world(territoryWinnerFirst = false, minTick = 0) {
  const base = newMatchConfig(rulesConfig("redesign"));
  const state = createMatch(404, { ...base, ffaTerritoryWinnerFirst: territoryWinnerFirst,
    earlyWin: { ...base.earlyWin!, minTick, holdTicks: 1, minHeldTiles: 1 }, terrain: { ...base.terrain!, maps: [map] } });
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

it.each(["territory", "ants_alive", "food_delivered"] as const)(
  "rates survivor and same-tick elimination finishes resolved by %s after equal queen and unit kills", async decidedBy => {
    for (const ending of ["survivors", "all_eliminated", "two_eliminated"] as const) {
      // Exercise score adjudication, not an early territory win after neutralising eliminated tiles.
      const { state, kill } = world(false, 100);
      state.colonies.forEach(c => { c.queenKills = 0; c.kills = 0; });
      // Later score steps deliberately disagree, so each fallback's precedence is exercised.
      const territory = decidedBy === "territory" ? [8, 12, 4, 0] : [4, 4, 4, 4];
      state.owner.fill(-1);
      let offset = 0;
      territory.forEach((tiles, colony) => { state.owner.fill(colony, offset, offset + tiles); offset += tiles; });
      const ants = decidedBy === "territory" ? [2, 1, 4, 5] : decidedBy === "ants_alive" ? [2, 3, 1, 0] : [1, 1, 1, 1];
      state.ants = state.colonies.flatMap(c => state.ants.filter(a => a.colony === c.id).slice(0, ants[c.id]));
      state.stats.delivered = decidedBy === "food_delivered" ? [2, 3, 1, 0] : [20, 10, 40, 50];
      if (ending !== "survivors") {
        for (const colony of ending === "all_eliminated" ? [0, 1, 2, 3] : [0, 1]) kill(colony, 10);
      }
      if (ending === "two_eliminated") expect(fourColonyEnd(state, 10, false)).toBeNull();
      const result = fourColonyEnd(state, 20, true)!;
      const order = ending === "two_eliminated" ? [2, 3, 1, 0] : [1, 0, 2, 3];
      expect(result).toMatchObject({ winner: order[0], decidedBy, ffa: { order, rateable: true } });
      if (ending !== "survivors") {
        expect(state.colonies[1]!.eliminated?.scores).toMatchObject({ queenKills: 0, kills: 0,
          territory: territory[1]! / 4, ants: ants[1], delivered: state.stats.delivered[1] });
      }
      // Use the actual finish at the offline persistence boundary, not a hand-built eligibility flag.
      const w = retentionWorld();
      const participants = state.colonies.map(c => w.played(`player${c.id}`).id);
      const applied = await applyFfaResult(w.store, { matchId: "fallback-finish", participants, reason: result.reason, finish: result.ffa! });
      expect(applied.status).toBe("applied");
      expect(w.commits).toHaveLength(1);
      expect(w.commits[0]).toHaveLength(5);
      const history = w.docs.get("ffaMatches/fallback-finish")!;
      const changes = JSON.parse(history.changes!) as { identityId: string; place: number; after: { mu: number } }[];
      expect(changes.map(c => c.place)).toEqual(participants.map((_, colony) => order.indexOf(colony) + 1));
      for (const id of participants) expect(w.docs.get(`${FFA_COLLECTION}/${id}`)?.ratedMatches).toBe("1");
      const means = order.map(colony => changes[colony]!.after.mu);
      expect(means[0]).toBeGreaterThan(means[1]!);
      expect(means[1]).toBeGreaterThan(means[2]!);
      expect(means[2]).toBeGreaterThan(means[3]!);
    }
  });

it("keeps a complete order but declines to rate abandonment", async () => {
  const abandoned = fourColonyEnd(world().state, 10, "abandoned")!;
  expect(abandoned.ffa).toMatchObject({ order: [1, 0, 2, 3], rateable: false });
  const w = retentionWorld();
  const participants = [0, 1, 2, 3].map(c => w.played(`player${c}`).id);
  expect(await applyFfaResult(w.store, { matchId: "abandoned-finish", participants,
    reason: abandoned.reason, finish: abandoned.ffa! })).toEqual({ status: "not_rateable" });
  expect(w.commits).toHaveLength(0);
});

it.each(["time_up", "queens_killed"] as const)("rates the complete all-tied %s order without changing the declared draw", async reason => {
  const { state, kill } = world(false, 100);
  state.colonies.forEach(c => { c.queenKills = 0; c.kills = 0; });
  if (reason === "queens_killed") for (const colony of [0, 1, 2, 3]) kill(colony, 10);
  const result = fourColonyEnd(state, 10, reason === "time_up")!;
  expect(result).toMatchObject({ winner: null, decidedBy: "draw", reason,
    ffa: { order: [0, 1, 2, 3], rateable: true } });
  const w = retentionWorld();
  const participants = state.colonies.map(c => w.played(`player${c.id}`).id);
  const input = { matchId: "all-tied-finish", participants, reason: result.reason, finish: result.ffa! };
  expect((await applyFfaResult(w.store, input)).status).toBe("applied");
  expect((await applyFfaResult(w.store, input)).status).toBe("already_applied");
  expect(w.commits).toHaveLength(1);
  expect(w.commits[0]).toHaveLength(5);
  const changes = JSON.parse(w.docs.get("ffaMatches/all-tied-finish")!.changes!) as { place: number; after: { mu: number } }[];
  expect(changes.map(c => c.place)).toEqual([1, 2, 3, 4]);
  for (const id of participants) expect(w.docs.get(`${FFA_COLLECTION}/${id}`)?.ratedMatches).toBe("1");
  for (let i = 0; i < 3; i++) expect(changes[i]!.after.mu).toBeGreaterThan(changes[i + 1]!.after.mu);
  expect(result).toMatchObject({ winner: null, decidedBy: "draw" });
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
