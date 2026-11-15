import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { FLYER_RULES, hatchIntervalOf, PUBLIC_CONFIG, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { localSoldierAssignments } from "../../src/sim/houseBot.js";
import { createMatch } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { storesOf } from "../../src/live/model.js";
import { step } from "../../src/sim/step.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { Ant, ColonyId, QueenState, SimEvent, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, antById, emptyMatch } from "./fixtures.js";
import { recordedHousePlan } from "../house-plan.ts";

/**
 * Flyer breeding under rules 28: the flyer's figures, flyer brood and each queen's clock, the ant cap, the jobs a flyer
 * never takes and the stream's hatch forecast, scripted on the served configuration with the engine's own step.
 */

/** The configuration every served match plays, rated and unrated: ANTWAR_RULES unset (src/server.ts). */
const served = (): SimConfig => newMatchConfig(rulesConfig("redesign"));
/** The served configuration on an open board with no food, so only the scripted ants and food act. */
const open = (): SimConfig => ({ ...served(), terrain: undefined, foodLayout: undefined, foodPatches: [] });
/** Four Lanes, whose ant cap is 768 (scale2Maps.ts). */
const FOUR_LANES_SEED = 6;

const setBrood = (agentId: string, brood: string, queenId?: number): SimInput =>
  ({ type: "set_brood", agentId, brood, ...(queenId === undefined ? {} : { queenId }) });
/** A lobby seat on its colony owning that colony's starting queen, as the server joins it. */
const lobbyJoin = (agentId: string, colony: ColonyId): SimInput => ({ type: "join", agentId, placement: colony, queenId: 0 });
const queen = (state: SimState, colony: ColonyId = 0, id = 0): QueenState => state.colonies[colony].queens!.find((q) => q.id === id)!;
const tileOf = (ant: Ant) => ({ tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) });

type Hatch = Extract<SimEvent, { type: "hatch" }>;
interface Born { readonly tick: number; readonly id: number; readonly colony: ColonyId; readonly flyer: boolean; readonly caste?: string; readonly hp: number; readonly queenTile: string }

/**
 * Step from state to untilTick, applying inputs at their ticks and the given per-tick setup first; returns every
 * birth with whether the newborn is a flyer, read from the state the hatch tick ends in.
 */
function play(state: SimState, untilTick: number, inputs: ReadonlyMap<number, readonly SimInput[]> = new Map(), before?: (s: SimState) => void): { state: SimState; born: Born[]; results: Map<number, ReturnType<typeof step>["results"]> } {
  const born: Born[] = [];
  const results = new Map<number, ReturnType<typeof step>["results"]>();
  let current = state;
  while (current.tick < untilTick && current.result === null) {
    before?.(current);
    const tick = current.tick;
    const out = step(current, inputs.get(tick) ?? []);
    results.set(tick, out.results);
    for (const e of out.events.filter((e): e is Hatch => e.type === "hatch")) {
      const ant = antById(out.state, e.antId)!;
      born.push({ tick, id: e.antId, colony: e.colony, flyer: ant.flyer === true, ...(e.caste === undefined ? {} : { caste: e.caste }), hp: ant.hp, queenTile: `${e.tileX},${e.tileY}` });
    }
    current = out.state;
  }
  return { state: current, born, results };
}

/** Keep each colony's store far above any cost, so no hatch waits for food. */
const fed = (s: SimState): void => { for (const colony of s.colonies) colony.foodStore = 10_000; };
const ticksOf = (born: readonly Born[], colony: ColonyId) => born.filter((b) => b.colony === colony).map((b) => b.tick);

describe("the served rules-28 configuration carries the flyer", () => {
  it("every served match, rated and unrated, plays the configuration with FLYER_RULES: 2 HP, 12 food, a flyer every 60 ticks per queen", () => {
    const config = comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!;
    expect(config).toEqual(served());
    expect(config.flyers).toEqual(FLYER_RULES);
    expect(FLYER_RULES).toEqual({ hp: 2000, damagePerSecond: 5000, cost: 12, speedTilesPerSecond: 8, lockoutTicks: 30 });
    expect(hatchIntervalOf(config, "flyer")).toBe(60);
  });
});

describe("set_brood flyers", () => {
  it("is accepted for every colony from match start, on the seat's own queen", () => {
    for (const seed of [FOUR_LANES_SEED, 4]) {
      const start = createMatch(seed, served());
      expect(start.tick).toBe(0);
      const out = step(start, [lobbyJoin("a", 0), lobbyJoin("b", 1), setBrood("a", "flyers"), setBrood("b", "flyers")]);
      expect(out.results.map((r) => r.ok)).toEqual([true, true, true, true]);
      expect(out.results[2]).toMatchObject({ ok: true, broodSet: { queenId: 0, brood: "flyers" } });
      expect(out.results[3]).toMatchObject({ ok: true, broodSet: { queenId: 0, brood: "flyers" } });
      expect([queen(out.state, 0).brood, queen(out.state, 1).brood]).toEqual(["flyers", "flyers"]);
    }
  });

  it("is an unknown brood where the configuration has no flyers, as before; the served one names flyers among the choices", () => {
    const old = createMatch(4, newMatchConfig(PUBLIC_CONFIG));
    expect(old.config.flyers).toBeUndefined();
    const refused = step(old, [lobbyJoin("a", 0), setBrood("a", "flyers")]);
    expect(refused.results[1]).toMatchObject({ ok: false, error: { code: "bad_brood", message: "brood is one of workers, soldiers, mixed." } });
    expect(queen(refused.state).brood).toBeUndefined();
    const unknown = step(createMatch(4, served()), [lobbyJoin("a", 0), setBrood("a", "hoppers")]);
    expect(unknown.results[1]).toMatchObject({ ok: false, error: { code: "bad_brood", message: "brood is one of workers, soldiers, mixed, flyers." } });
  });
});

describe("check 7: broods and queen clocks", () => {
  /** Colony 0 seated with its starting queen on the brood, from tick 0, food kept above cost. */
  function bred(brood: string, untilTick: number) {
    const state = emptyMatch(0, open());
    return play(state, untilTick, new Map([[0, [lobbyJoin("a", 0), setBrood("a", brood)]]]), fed);
  }

  it("one worker, soldier or flyer per 10, 30 or 60 ticks per queen; the starting queen's first comes one worker interval early", () => {
    const workers = bred("workers", 100), soldiers = bred("soldiers", 200), flyers = bred("flyers", 300);
    expect(ticksOf(workers.born, 0)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(workers.born.filter((b) => b.colony === 0).every((b) => b.caste === "worker" && !b.flyer)).toBe(true);
    expect(ticksOf(soldiers.born, 0)).toEqual([20, 50, 80, 110, 140, 170]);
    expect(soldiers.born.filter((b) => b.colony === 0).every((b) => b.caste === "soldier" && !b.flyer)).toBe(true);
    expect(ticksOf(flyers.born, 0)).toEqual([50, 110, 170, 230, 290]);
    // A flyer is worker caste with the flyer mark and the flyer's 2 HP.
    expect(flyers.born.filter((b) => b.colony === 0).every((b) => b.flyer && b.caste === "worker" && b.hp === 2000)).toBe(true);
    // The unseated colony keeps its mixed brood: no flyer.
    expect(flyers.born.some((b) => b.colony === 1 && b.flyer)).toBe(false);
  });

  it("a mixed brood never makes flyers", () => {
    const mixed = bred("mixed", 600);
    expect(mixed.born.filter((b) => b.colony === 0).map((b) => b.caste).slice(0, 6)).toEqual(["worker", "soldier", "worker", "soldier", "worker", "soldier"]);
    expect(mixed.born.some((b) => b.flyer)).toBe(false);
    expect(mixed.state.ants.some((ant) => ant.flyer === true)).toBe(false);
  });

  it("each flyer costs 12 food, and a due flyer waits until the store covers it", () => {
    const state = emptyMatch(0, open());
    const joined = step(state, [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;
    joined.colonies[0].foodStore = 11;
    // Due at tick 50; with 11 food nothing hatches until the store reaches 12 at tick 80.
    const { state: after, born } = play(joined, 120, new Map(), (s) => { if (s.tick === 80) s.colonies[0].foodStore = 12; });
    expect(born.filter((b) => b.colony === 0)).toEqual([expect.objectContaining({ tick: 80, flyer: true })]);
    expect(after.colonies[0].foodStore).toBe(0);
    // Her clock restarts at the hatch: the next flyer is due at tick 140.
    after.colonies[0].foodStore = 12;
    expect(ticksOf(play(after, 260).born, 0)).toEqual([140]);
  });

  it("two queens on flyer brood make two flyers per 60 ticks, each on her own clock", () => {
    const state = step(emptyMatch(0, open()), [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;
    const first = queen(state);
    const { owner: _owner, brood: _brood, starting: _starting, ...rest } = first;
    state.colonies[0].queens!.push({ ...rest, id: 1, queenY: first.queenY + 12 * SUB, lastHatchTick: 20, owner: "a" });
    const { born } = play(state, 361, new Map([[1, [setBrood("a", "flyers", 1)]]]), fed);
    const own = born.filter((b) => b.colony === 0);
    expect(own.every((b) => b.flyer)).toBe(true);
    const byQueen = (q: QueenState) => own.filter((b) => b.queenTile.endsWith(`,${Math.floor(q.queenY / SUB)}`)).map((b) => b.tick);
    expect(byQueen(queen(state, 0, 0))).toEqual([50, 110, 170, 230, 290, 350]);
    expect(byQueen(queen(state, 0, 1))).toEqual([80, 140, 200, 260, 320]);
    for (let from = 60; from + 60 <= 361; from += 60) expect(own.filter((b) => b.tick >= from && b.tick < from + 60)).toHaveLength(2);
  });

  it("a queen founded mid-match starts her clock at her founding", () => {
    const state = step(emptyMatch(0, open()), [lobbyJoin("a", 0), setBrood("a", "workers")]).state;
    state.tick = state.config.queenFounding!.firstFoundTick!;
    const home = queen(state);
    const tx = Math.floor(home.queenX / SUB) + state.config.queenFounding!.minDistanceTiles + 4, ty = Math.floor(home.queenY / SUB);
    expect(isWaterTile(state.terrain, tx, ty) || isRockTile(state.terrain, tx, ty)).toBe(false);
    state.owner[ty * state.config.mapWidth + tx] = 0;
    state.colonies[0].foodStore = 10_000;
    const founded = state.tick;
    const { born, results } = play(state, founded + 200, new Map([[founded, [
      { type: "found_queen", agentId: "a", tileX: tx, tileY: ty }, setBrood("a", "flyers", 1),
    ]]]), (s) => { if (s.tick > founded) fed(s); });
    expect(results.get(founded)!.map((r) => r.ok)).toEqual([true, true]);
    const flyers = born.filter((b) => b.colony === 0 && b.flyer);
    expect(flyers.every((b) => b.queenTile === `${tx},${ty}`)).toBe(true);
    expect(flyers.map((b) => b.tick)).toEqual([founded + 60, founded + 120, founded + 180]);
  });
});

describe("a newborn flyer", () => {
  it("takes no spawn walk, holds the tile it hatched on, and has no lifetime", () => {
    const state = step(emptyMatch(0, open()), [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;
    // Her spawn point is far away: a worker she hatched would walk there.
    const home = queen(state);
    home.spawnPoint = { tileX: Math.floor(home.queenX / SUB) + 20, tileY: Math.floor(home.queenY / SUB) };
    const { state: hatched, born } = play(state, 51, new Map(), fed);
    const flyer = antById(hatched, born.find((b) => b.flyer)!.id)!;
    expect(flyer.spawnWalk).toBeUndefined();
    const hatchTile = tileOf(flyer);
    expect(flyer.holdPoint).toEqual(hatchTile);
    // Alone, it stays on that tile for far longer than any lifetime the trial had.
    hatched.colonies[0].foodStore = 0;
    let current = hatched;
    for (let t = 0; t < 1500; t += 1) {
      current = step(current).state;
      const now = antById(current, flyer.id);
      expect(now, `alive at tick ${current.tick}`).toBeDefined();
      expect([tileOf(now!), now!.spawnWalk]).toEqual([hatchTile, undefined]);
    }
    expect(antById(current, flyer.id)!.hp).toBe(2000);
    // Hatched beside earlier flyers, each stays on the tile it hatched on after every tick, however crowded.
    const crowded = new Map<number, { readonly tileX: number; readonly tileY: number }>([[flyer.id, hatchTile]]);
    let crowd = current;
    for (let t = 0; t < 600; t += 1) {
      fed(crowd);
      const out = step(crowd);
      crowd = out.state;
      for (const e of out.events) if (e.type === "hatch" && antById(crowd, e.antId)?.flyer === true) crowded.set(e.antId, tileOf(antById(crowd, e.antId)!));
      for (const [id, tile] of crowded) expect(tileOf(antById(crowd, id)!), `flyer ${id} at tick ${crowd.tick}`).toEqual(tile);
    }
    expect(crowded.size).toBe(11);
    // Positive control: a worker from the same queen walks to her spawn point.
    home.brood = "workers";
    const control = play(state, state.tick + 1, new Map(), fed);
    const worker = antById(control.state, control.born.find((b) => b.colony === 0)!.id)!;
    expect(worker.spawnWalk).toEqual({ queenId: 0, tileX: home.spawnPoint.tileX, tileY: home.spawnPoint.tileY });
  });
});

describe("check 7: the ant cap", () => {
  it("one ant below the map's cap, a colony hatches exactly one more flyer and then none, and exactly one more after one of its ants dies", () => {
    const state = createMatch(FOUR_LANES_SEED, served());
    expect(state.config.colonyCap).toBe(768);
    const joined = step(state, [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;
    // Past the combat grace period, so the scripted kill below can land.
    joined.tick = joined.config.combatGraceTicks + 10;
    const home = queen(joined);
    home.lastHatchTick = joined.tick - 60;
    const own = () => joined.ants.filter((ant) => ant.colony === 0);
    // Fill to one below the cap on the land around the queen, one ant per tile.
    const qx = Math.floor(home.queenX / SUB), qy = Math.floor(home.queenY / SUB);
    for (let r = 1; own().length < 767; r += 1) for (let y = qy - r; y <= qy + r; y += 1) for (let x = qx - r; x <= qx + r; x += 1) {
      if (own().length >= 767 || Math.max(Math.abs(x - qx), Math.abs(y - qy)) !== r || x < 0 || y < 0 || x >= joined.config.mapWidth || y >= joined.config.mapHeight) continue;
      if (!isWaterTile(joined.terrain, x, y) && !isRockTile(joined.terrain, x, y)) addAnt(joined, 0, x, y);
    }
    const start = joined.tick;
    const capped = play(joined, start + 125, new Map(), fed);
    expect(capped.born.filter((b) => b.colony === 0)).toEqual([expect.objectContaining({ tick: start, flyer: true })]);
    expect(capped.state.ants.filter((ant) => ant.colony === 0)).toHaveLength(768);
    // Kill one of the colony's ants: an enemy beside a 1-HP ant of it, between hatch dues.
    const victim = capped.state.ants.find((ant) => ant.colony === 0 && ant.flyer !== true)!;
    victim.hp = 1;
    addAnt(capped.state, 1, Math.floor(victim.x / SUB), Math.floor(victim.y / SUB));
    // The flyer due since start + 60 hatches on the tick the death frees a place, and no other follows.
    const died = capped.state.tick;
    const after = play(capped.state, died + 125, new Map(), fed);
    expect(antById(play(capped.state, died + 1).state, victim.id)).toBeUndefined();
    expect(after.born.filter((b) => b.colony === 0)).toEqual([expect.objectContaining({ tick: died, flyer: true })]);
    expect(after.state.ants.filter((ant) => ant.colony === 0)).toHaveLength(768);
  }, 60_000);
});

describe("a flyer never forages, carries, heals, or takes a house role or guard duty", () => {
  /** Colony 0 seated, flyers bred from its queen; colony 1 unseated. Returns the state once n flyers stand. */
  function withFlyers(config: SimConfig, n: number): SimState {
    let state = step(emptyMatch(0, config), [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;
    while (state.ants.filter((ant) => ant.flyer === true).length < n) { fed(state); state = step(state).state; }
    state.colonies[0].foodStore = 0;
    queen(state).brood = "mixed";
    return state;
  }

  it("never picks up food under it or beside it, never joins a squad or a FORAGE mark, while a worker does", () => {
    const state = withFlyers(open(), 3);
    const flyers = state.ants.filter((ant) => ant.flyer === true);
    const width = state.config.mapWidth;
    for (const f of flyers) for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) state.food[(tileOf(f).tileY + dy) * width + tileOf(f).tileX + dx] = 5;
    const foodBefore = [...state.food];
    // A FORAGE count mark of any caste beside them, and a seat whose squad forages.
    const { tileX, tileY } = tileOf(flyers[0]!);
    const marked = step(state, [{ type: "count_mark", agentId: "a", tileX, tileY, verb: "FORAGE", count: 10 }]);
    expect(marked.results[0]!.ok).toBe(true);
    let current = marked.state;
    for (let t = 0; t < 300; t += 1) {
      current = step(current).state;
      for (const f of current.ants.filter((ant) => ant.flyer === true)) {
        expect([f.carrying, f.claim, f.squad]).toEqual([false, undefined, null]);
      }
    }
    expect(current.stats.delivered[0]).toBe(0);
    expect(current.food).toEqual(foodBefore);
    // Positive control: a worker put on the same food picks it up within a tick or two.
    const worker = addAnt(current, 0, tileX, tileY);
    let next = current;
    for (let t = 0; t < 3 && !antById(next, worker.id)!.carrying; t += 1) next = step(next).state;
    expect(antById(next, worker.id)!.carrying).toBe(true);
  });

  it("never heals", () => {
    const state = withFlyers(open(), 1);
    const flyer = state.ants.find((ant) => ant.flyer === true)!;
    flyer.hp = 500;
    let current = state;
    for (let t = 0; t < 600; t += 1) {
      current = step(current).state;
      expect(antById(current, flyer.id)!.hp).toBe(500);
    }
  });

  it("holds its tile instead of going for an intruder at its queen, while a worker of its colony goes for it", () => {
    // No squads, so the control worker is a free ant under local rules too.
    const state = withFlyers({ ...open(), squadSize: 0 }, 1);
    expect(localRulesSide(state, 0)).toBe(true);
    const flyer = state.ants.find((ant) => ant.flyer === true)!;
    const home = queen(state);
    const hold = tileOf(flyer);
    const worker = addAnt(state, 0, hold.tileX, hold.tileY + 1);
    // An enemy within defendTiles of the queen, beyond combat reach of both.
    const enemy = addAnt(state, 1, Math.floor(home.queenX / SUB) + 4, Math.floor(home.queenY / SUB) + 4);
    const out = step(state).state;
    expect(tileOf(antById(out, flyer.id)!)).toEqual(hold);
    const d = (a: Ant) => (a.x - enemy.x) ** 2 + (a.y - enemy.y) ** 2;
    expect(d(antById(out, worker.id)!)).toBeLessThan(d(worker));
  });

  it("takes no house role, queen guard or worker guard where the house planner runs, while workers do", () => {
    // A colony with no active seat under the recorded house plan: its planner assigns roles and guards.
    const config = recordedHousePlan(open());
    const state = emptyMatch(0, config);
    expect(localRulesSide(state, 0)).toBe(false);
    const home = queen(state);
    const at = { tileX: Math.floor(home.queenX / SUB), tileY: Math.floor(home.queenY / SUB) };
    const flyers = [0, 1, 2].map((i) => addAnt(state, 0, at.tileX + i, at.tileY, { flyer: true, hp: 2000, holdPoint: { tileX: at.tileX + i, tileY: at.tileY } }));
    for (let i = 0; i < 40; i += 1) addAnt(state, 0, at.tileX + (i % 5), at.tileY + 1 + Math.floor(i / 5));
    let current = state;
    for (let t = 0; t < 60; t += 1) {
      const allocation = localSoldierAssignments(current);
      for (const f of flyers) {
        expect(allocation?.workerGuards?.has(f.id) ?? false).toBe(false);
        expect(allocation?.workerRecall?.has(f.id) ?? false).toBe(false);
      }
      current = step(current).state;
      for (const f of flyers) {
        const now = antById(current, f.id)!;
        expect([now.role, now.guardQueenId, now.squad, now.claim, now.carrying]).toEqual(["forager", undefined, null, undefined, false]);
        expect(Math.max(Math.abs(tileOf(now).tileX - f.holdPoint!.tileX), Math.abs(tileOf(now).tileY - f.holdPoint!.tileY))).toBeLessThanOrEqual(1);
      }
    }
    // Positive control: the planner gave its workers guard and fighter roles and filled its worker screen.
    const workers = current.ants.filter((ant) => ant.colony === 0 && ant.flyer !== true);
    expect(workers.some((ant) => ant.role === "guard" && ant.guardQueenId === 0)).toBe(true);
    expect(localSoldierAssignments(current)?.workerGuards?.size ?? 0).toBeGreaterThan(0);
  });
});

describe("the spectator stream's hatch forecast follows the queen's actual next hatch", () => {
  /**
   * Step to untilTick with the store kept covered, reading colony 0's streamed store before every step: each of its
   * births comes on the forecast tick and takes the forecast cost from the store. Returns what each birth was.
   */
  function forecastsAgree(state: SimState, untilTick: number): { tick: number; cost: number; flyer: boolean }[] {
    const seen: { tick: number; cost: number; flyer: boolean }[] = [];
    let current = state;
    while (current.tick < untilTick) {
      fed(current);
      const forecast = storesOf(current)[0], store = current.colonies[0].foodStore, tick = current.tick;
      const out = step(current);
      const births = out.events.filter((e): e is Hatch => e.type === "hatch" && e.colony === 0);
      if (births.length > 0) {
        expect(births, `one birth at tick ${tick}`).toHaveLength(1);
        expect([tick, store - out.state.colonies[0].foodStore], `forecast before tick ${tick}`).toEqual([forecast.nextHatchTick, forecast.nextCost]);
        seen.push({ tick, cost: forecast.nextCost, flyer: antById(out.state, births[0]!.antId)!.flyer === true });
      }
      current = out.state;
    }
    return seen;
  }
  const seated = (): SimState => step(emptyMatch(0, open()), [lobbyJoin("a", 0), setBrood("a", "flyers")]).state;

  it("a starting queen on flyer brood is forecast at 12 food for tick 50, then every 60 ticks", () => {
    const state = seated();
    expect(storesOf(state)[0]).toMatchObject({ nextHatchTick: 50, nextCost: 12 });
    // The unseated colony keeps its mixed brood's worker figures.
    expect(storesOf(state)[1]).toMatchObject({ nextHatchTick: 0, nextCost: state.config.hatchCost });
    expect(forecastsAgree(state, 300)).toEqual([50, 110, 170, 230, 290].map((tick) => ({ tick, cost: 12, flyer: true })));
  });

  it("a due flyer waiting for food keeps its forecast, and a brood change moves the forecast with the hatch", () => {
    let current = seated();
    current.colonies[0].foodStore = 11;
    // Due on her clock at tick 50; the store covers the flyer at tick 80.
    while (current.tick < 80) {
      expect(storesOf(current)[0], `tick ${current.tick}`).toMatchObject({ nextHatchTick: 50, nextCost: 12 });
      current = step(current).state;
    }
    current.colonies[0].foodStore = 12;
    const hatched = step(current);
    expect(hatched.events.filter((e) => e.type === "hatch" && e.colony === 0)).toHaveLength(1);
    expect(hatched.state.colonies[0].foodStore).toBe(0);
    // Her clock restarts at the hatch.
    expect(storesOf(hatched.state)[0]).toMatchObject({ nextHatchTick: 140, nextCost: 12 });
    // Back to workers: a worker's forecast, on her own clock.
    const workers = step(hatched.state, [setBrood("a", "workers")]).state;
    expect(storesOf(workers)[0]).toMatchObject({ nextHatchTick: 90, nextCost: workers.config.hatchCost });
    expect(forecastsAgree(workers, 121)).toEqual([90, 100, 110, 120].map((tick) => ({ tick, cost: workers.config.hatchCost, flyer: false })));
  });

  it("with two queens the earlier one's next hatch is forecast, a flyer or a worker as each queen's brood gives it", () => {
    const state = seated();
    const first = queen(state);
    const { owner: _owner, brood: _brood, starting: _starting, ...rest } = first;
    state.colonies[0].queens!.push({ ...rest, id: 1, queenY: first.queenY + 12 * SUB, lastHatchTick: 25, owner: "a" });
    const workers = step(state, [setBrood("a", "workers", 1)]).state;
    // The worker queen is due at tick 35, before the flyer queen's tick 50.
    expect(storesOf(workers)[0]).toMatchObject({ nextHatchTick: 35, nextCost: workers.config.hatchCost });
    const seen = forecastsAgree(workers, 200);
    expect(seen.filter((s) => s.flyer).map((s) => [s.tick, s.cost])).toEqual([[50, 12], [110, 12], [170, 12]]);
    expect(seen.filter((s) => !s.flyer).map((s) => [s.tick, s.cost])).toEqual([35, 45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175, 185, 195]
      .map((tick) => [tick, workers.config.hatchCost]));
  });
});
