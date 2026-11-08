import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Agent, ColonyId, InputError, QueenState, SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { addAnt } from "./fixtures.js";
import { sevenMapRotation } from "./seven-map-rotation.js";
import { startHarness, type Harness } from "../mcp/harness.js";
import { DEFAULT_REPLY_LIMITS } from "../../src/mcp/replies.js";

/**
 * The rules-27 SPAWN command. Count-mark
 * placement and seat transitions are compared with the capture at 1ef77182:
 * the claims' "Placement and missing
 * rally controls" and "Seat transitions". The command-idle and no-active-seat
 * cases run on step()'s houseActive=false lapse path; since commit
 * 32ab6dbf live matches end on idle instead.
 *
 * Only a queen's owner sets,
 * moves or clears her spawn point, replacing the any-seat admission
 * (own colony, not own queen). Tests set the owner directly.
 */

type CountMarkInput = Extract<SimInput, { type: "count_mark" }>;

function rules27(patch: Partial<SimConfig> = {}): SimConfig {
  const base = rulesConfig("redesign");
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  return sevenMapRotation(newMatchConfig({ ...base, rules27: true, startAnts: 0, squadSize: 0, commandFloorTicks: 1, hatchIntervalTicks: 1_000_000,
    terrain: { ...base.terrain!, mapId: "three-crossings" }, ...patch }));
}

function seat(state: SimState, id: string, colony: ColonyId): Agent {
  const agent: Agent = { id, colony, joinSeq: state.agents.length, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: state.tick, lastCommandTick: null, joinedTick: state.tick, idle: false, pendingEvents: [] };
  state.agents.push(agent);
  return agent;
}

/** One seat on colony 0, owning its queen 0, with a single free ant beside her, so colony sight covers only the home area. */
function scene(config: SimConfig = rules27()): SimState {
  const state = createMatch(4530, config);
  state.ants = [];
  state.tick = 1000;
  seat(state, "a", 0);
  state.colonies[0].queens!.find((q) => q.id === 0)!.owner = "a";
  addAnt(state, 0, 16, 49);
  return state;
}

const spawn = (agentId: string, fields: Partial<CountMarkInput> = {}): SimInput =>
  ({ type: "count_mark", agentId, verb: "SPAWN", count: 0, queenId: 0, ...fields } as SimInput);
const errorOf = (out: StepOutput, i = 0): InputError | null => { const r = out.results[i]!; return r.ok ? null : r.error; };
const queen = (state: SimState, colony: ColonyId = 0, id = 0): QueenState => state.colonies[colony].queens!.find((q) => q.id === id)!;
const agentOf = (state: SimState, id: string): Agent => state.agents.find((a) => a.id === id)!;
const run = (state: SimState, ticks: number): SimState => { for (let t = 0; t < ticks; t++) state = step(state).state; return state; };

// Far from colony 0's only ant (tile 16,49; sight 12) and clear of water on this map.
const FAR = { tileX: 100, tileY: 10 };
const NEAR = { tileX: 18, tileY: 49 };
const OTHER = { tileX: 96, tileY: 88 };

describe("rules 27 spawn-point command", () => {
  it("sets a live queen's spawn point on any passable in-map tile, seen or not, spending the command allowance", () => {
    const state = scene();
    expect(isBlockedTile(state.terrain, FAR.tileX, FAR.tileY)).toBe(false);
    // No ant of colony 0 can see FAR: a count mark there is refused as captured.
    const mark = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 1, ...FAR }]);
    expect(errorOf(mark)?.code).toBe("count_mark_not_visible");
    for (const tile of [FAR, NEAR]) {
      const out = step(state, [spawn("a", tile)]);
      expect(errorOf(out)).toBeNull();
      expect(queen(out.state).spawnPoint).toEqual(tile);
      expect(agentOf(out.state, "a").lastCommandTick).toBe(state.tick);
      expect(out.state.marks).toEqual(state.marks); // no Mark is laid
      expect(out.events.filter((e) => e.type === "mark_laid" || e.type === "count_mark_accepted")).toEqual([]);
    }
    // Map corners are inside the bounds.
    const { mapWidth: w, mapHeight: h } = state.config;
    for (const tile of [{ tileX: 0, tileY: 0 }, { tileX: w - 1, tileY: h - 1 }]) {
      if (isBlockedTile(state.terrain, tile.tileX, tile.tileY)) continue;
      expect(queen(step(state, [spawn("a", tile)]).state).spawnPoint).toEqual(tile);
    }
  });

  it("refuses any other tile or queen with bad_spawn_point and spends no allowance", () => {
    const state = scene(rules27({ commandFloorTicks: 10 }));
    queen(state).spawnPoint = { ...NEAR };
    state.colonies[0].queens!.push({ id: 1, queenX: 40_500, queenY: 20_500, foundedTick: 5, lastHatchTick: 5, overrunTicks: 0, lostTick: 900 });
    const water = state.terrain!.water[0]!;
    const rock = state.terrain!.rocks![0]!;
    const { mapWidth: w, mapHeight: h } = state.config;
    const refused: SimInput[] = [
      spawn("a", { tileX: water.x, tileY: water.y }),
      spawn("a", { tileX: rock.x, tileY: rock.y }),
      spawn("a", { tileX: -1, tileY: 10 }),
      spawn("a", { tileX: w, tileY: 10 }),
      spawn("a", { tileX: 10, tileY: h }),
      spawn("a", { tileX: 10.5, tileY: 10 }),
      spawn("a", { tileX: 10 }),
      spawn("a", { tileY: 10 }),
      spawn("a", { ...FAR, queenId: 7 }), // no such queen
      spawn("a", { ...FAR, queenId: 1 }), // a lost queen
      spawn("a", { ...FAR, queenId: undefined }),
    ];
    for (const input of refused) {
      const out = step(state, [input, spawn("a", FAR)]);
      expect(errorOf(out, 0)?.code).toBe("bad_spawn_point");
      // The refusal spent nothing: the next command in the same tick is accepted.
      expect(errorOf(out, 1)).toBeNull();
      const only = step(state, [input]).state;
      expect(queen(only).spawnPoint).toEqual(NEAR);
      expect(agentOf(only, "a").lastCommandTick).toBeNull();
    }
  });


  it("keeps at most one spawn point per queen: a move replaces it, a clear removes it, and other queens keep theirs", () => {
    let state = scene();
    state.colonies[0].queens!.push({ id: 1, queenX: 20_500, queenY: 30_500, foundedTick: 5, lastHatchTick: 5, overrunTicks: 0, lostTick: null, owner: "a" });
    state = step(state, [spawn("a", FAR)]).state;
    state = step(state, [spawn("a", { ...OTHER, queenId: 1 })]).state;
    state = step(state, [spawn("a", NEAR)]).state;
    expect(queen(state, 0, 0).spawnPoint).toEqual(NEAR);
    expect(queen(state, 0, 1).spawnPoint).toEqual(OTHER);
    const cleared = step(state, [spawn("a")]);
    expect(errorOf(cleared)).toBeNull();
    expect("spawnPoint" in queen(cleared.state, 0, 0)).toBe(false);
    expect(queen(cleared.state, 0, 1).spawnPoint).toEqual(OTHER);
    // Clearing an unset spawn point is accepted and spends the allowance.
    const again = step(cleared.state, [spawn("a")]);
    expect(errorOf(again)).toBeNull();
    expect(agentOf(again.state, "a").lastCommandTick).toBe(cleared.state.tick);
    // queenId names a queen of the agent's own colony: colony 1's seat sets only colony 1's queen 0, which it owns.
    seat(again.state, "b", 1);
    queen(again.state, 1, 0).owner = "b";
    const enemy = step(again.state, [spawn("b", FAR)]).state;
    expect(queen(enemy, 1, 0).spawnPoint).toEqual(FAR);
    expect("spawnPoint" in queen(enemy, 0, 0)).toBe(false);
  });

  // Replaces the earlier "lets any seat of a colony set, move or clear a queen's spawn point; the latest change wins".
  it("lets only a queen's owner set, move or clear her spawn point; a teammate is refused with queen_not_owned and spends no allowance", () => {
    let state = scene();
    seat(state, "b", 0);
    state.colonies[0].queens!.push({ id: 1, queenX: 20_500, queenY: 30_500, foundedTick: 5, lastHatchTick: 5, overrunTicks: 0, lostTick: null, owner: "b" });
    /** b, a teammate of queen 0's owner a, tries to set or move (a tile) and to clear (none). */
    const teammateRefused = (s: SimState) => {
      const before = queen(s).spawnPoint;
      for (const input of [spawn("b", OTHER), spawn("b")]) {
        const out = step(s, [input, spawn("b", { ...OTHER, queenId: 1 })]);
        expect(errorOf(out, 0)).toEqual({ code: "queen_not_owned",
          message: "Queen 0 belongs to a teammate: only her owner sets, moves or clears her spawn point." });
        expect(queen(out.state).spawnPoint).toEqual(before);
        // The refusal spent nothing: b's next command in the same tick, on the queen b owns, is accepted.
        expect(errorOf(out, 1)).toBeNull();
        expect(queen(out.state, 0, 1).spawnPoint).toEqual(OTHER);
        expect(agentOf(step(s, [input]).state, "b").lastCommandTick).toBeNull();
      }
    };
    teammateRefused(state); // unset: b cannot set it
    state = step(state, [spawn("a", FAR)]).state;
    expect(queen(state).spawnPoint).toEqual(FAR);
    teammateRefused(state); // set: b cannot move or clear it
    state = step(state, [spawn("a", NEAR)]).state;
    expect(queen(state).spawnPoint).toEqual(NEAR);
    // Within one tick a teammate's later input does not override the owner's.
    expect(queen(step(state, [spawn("a", FAR), spawn("b", OTHER)]).state).spawnPoint).toEqual(FAR);
    expect(queen(step(state, [spawn("a", FAR), spawn("b")]).state).spawnPoint).toEqual(FAR);
    state = step(state, [spawn("a")]).state;
    expect("spawnPoint" in queen(state)).toBe(false);
    // The owner of queen 0 is in turn a teammate on b's queen 1.
    const refused = step(state, [spawn("a", { ...FAR, queenId: 1 })]);
    expect(errorOf(refused)?.code).toBe("queen_not_owned");
    expect(queen(refused.state, 0, 1).spawnPoint).toBeUndefined();
    expect(agentOf(refused.state, "a").lastCommandTick).toBe(state.tick - 1);
  });

  it("refuses every agent while a queen has no owner, spending no allowance", () => {
    const state = scene();
    seat(state, "b", 0);
    delete queen(state).owner;
    queen(state).spawnPoint = { ...NEAR };
    for (const agentId of ["a", "b"]) {
      for (const input of [spawn(agentId, FAR), spawn(agentId)]) {
        const out = step(state, [input]);
        expect(errorOf(out)).toEqual({ code: "queen_not_owned",
          message: "Queen 0 has no owner yet: only a queen's owner sets, moves or clears her spawn point." });
        expect(queen(out.state).spawnPoint).toEqual(NEAR);
        expect(agentOf(out.state, agentId).lastCommandTick).toBeNull();
      }
    }
  });

  it("shares the command allowance with every other command", () => {
    const state = scene(rules27({ commandFloorTicks: 10 }));
    const set = step(state, [spawn("a", FAR)]);
    expect(errorOf(set)).toBeNull();
    for (const input of [spawn("a", NEAR), spawn("a"), { type: "count_mark", agentId: "a", verb: "ATTACK", count: 1, ...NEAR } as SimInput,
      { type: "order", agentId: "a", order: { kind: "hold" } } as SimInput]) {
      const out = step(set.state, [input]);
      expect(errorOf(out)).toMatchObject({ code: "rate_limited", nextAllowedTick: state.tick + 10 });
    }
    expect(queen(step(set.state, [spawn("a", NEAR)]).state).spawnPoint).toEqual(FAR);
    // A count mark spends the allowance a SPAWN then waits on.
    const marked = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 1, ...NEAR }]);
    expect(errorOf(step(marked.state, [spawn("a", FAR)]))?.code).toBe("rate_limited");
  });

  it("never expires on its own, while a count mark laid with it does", () => {
    let state = scene(rules27({ markLifetimeTicks: 30, commandIdleTicks: 10_000 }));
    state = step(state, [spawn("a", FAR)]).state;
    state = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 1, ...NEAR }]).state;
    expect(state.marks).toHaveLength(1);
    state = run(state, 120);
    expect(state.marks).toHaveLength(0);
    expect(queen(state).spawnPoint).toEqual(FAR);
  });

  it("stays stored when the seat that set it goes command-idle, while that seat's count marks and claims are removed", () => {
    let state = scene(rules27({ commandIdleTicks: 20 }));
    for (let i = 0; i < 3; i++) addAnt(state, 0, 17 + i, 50);
    state = step(state, [spawn("a", FAR)]).state;
    state = step(state, [{ type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, ...NEAR }]).state;
    expect(state.marks.filter((m) => m.agentId === "a")).toHaveLength(1);
    expect(state.ants.some((ant) => ant.claim !== undefined)).toBe(true);
    // Run past the threshold on the lapse path (houseActive=false, the step() default).
    while (!agentOf(state, "a").idle) state = step(state).state;
    expect(state.marks.filter((m) => m.agentId === "a")).toEqual([]);
    expect(state.ants.every((ant) => ant.claim === undefined)).toBe(true);
    expect(queen(state).spawnPoint).toEqual(FAR);
    // The colony now has no active seat; its queen's spawn point stays stored.
    expect(localRulesSide(state, 0)).toBe(false);
    state = run(state, 60);
    expect(localRulesSide(state, 0)).toBe(false);
    expect(queen(state).spawnPoint).toEqual(FAR);
  });

  it("stays stored when one of several seats goes command-idle", () => {
    let state = scene(rules27({ commandIdleTicks: 20 }));
    seat(state, "b", 0);
    state = step(state, [spawn("a", FAR)]).state;
    for (let t = 0; t < 40; t++) state = step(state, t % 10 === 0 ? [{ type: "order", agentId: "b", order: { kind: "hold" } }] : []).state;
    expect(agentOf(state, "a").idle).toBe(true);
    expect(agentOf(state, "b").idle).toBe(false);
    expect(queen(state).spawnPoint).toEqual(FAR);
  });
});

describe("rules 27 spawn-point command in match logs", () => {
  const SEED = 9027;
  function match(config: SimConfig, schedule: (tick: number) => SimInput[], ticks: number) {
    const lines = [headerLine(SEED, config)];
    let state = createMatch(SEED, config);
    const hashes: string[] = [];
    const results: StepOutput["results"][] = [];
    /** Per tick, before its inputs apply: the owner of each colony's queen 0. */
    const owners: (string | undefined)[][] = [];
    while (state.tick < ticks) {
      const inputs = schedule(state.tick);
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      owners.push(state.colonies.map((c) => c.queens?.find((q) => q.id === 0)?.owner));
      const out = step(state, inputs);
      results.push(out.results);
      state = out.state;
      hashes.push(stateHash(state));
    }
    return { lines, state, hashes, results, owners };
  }
  const joins: SimInput[] = [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "b", placement: 0 }, { type: "join", agentId: "c", placement: 1 }];
  function commands(verb: string) {
    const s = (agentId: string, fields: Partial<CountMarkInput> = {}) => ({ ...spawn(agentId, fields), verb } as SimInput);
    return (tick: number): SimInput[] => {
      switch (tick) {
        case 0: return joins;
        case 10: return [s("a", FAR), s("c", OTHER)];
        case 20: return [s("b", NEAR), { type: "count_mark", agentId: "a", verb: "ATTACK", count: 2, ...NEAR }];
        case 30: return [s("a", { tileX: -1, tileY: 3 }), s("a", { ...FAR, queenId: 4 }), s("b")];
        case 40: return [s("a"), s("b", OTHER)];
        case 50: return [s("c"), s("b", FAR), s("a", NEAR)];
        default: return [];
      }
    };
  }
  const config = (patch: Partial<SimConfig> = {}): SimConfig => {
    const base = rulesConfig("redesign");
    // Pinned to the seven-map rotation this was written for, which holds the old two.
    return sevenMapRotation(newMatchConfig({ ...base, rules27: true, startAnts: 6, commandFloorTicks: 5, terrain: { ...base.terrain!, mapId: "three-crossings" }, ...patch }));
  };

  it("records setting, moving and clearing as match inputs, and a rules-27 match containing them replays exactly", () => {
    const live = match(config(), commands("SPAWN"), 80);
    // A logged match's owners come from the ownership rules (seat claim, seed draw), not from this
    // test, so each outcome is checked against whoever owned the named queen when the input applied.
    const colonyOf = (agentId: string): ColonyId => (agentId === "c" ? 1 : 0);
    const point = new Map<ColonyId, { tileX: number; tileY: number }>();
    for (const tick of [10, 20, 30, 40, 50]) {
      commands("SPAWN")(tick).forEach((input, i) => {
        if (input.type !== "count_mark" || input.verb !== "SPAWN") return;
        const result = live.results[tick]![i]!;
        const colony = colonyOf(input.agentId);
        const owned = live.owners[tick]![colony] === input.agentId;
        const expected = input.queenId !== 0 ? "bad_spawn_point" : !owned ? "queen_not_owned" : input.tileX === -1 ? "bad_spawn_point" : null;
        expect(result.ok ? null : result.error.code, `${input.agentId} at tick ${tick}`).toBe(expected);
        if (!result.ok) return;
        if (input.tileX === undefined) point.delete(colony);
        else point.set(colony, { tileX: input.tileX, tileY: input.tileY! });
      });
    }
    for (const colony of [0, 1] as const) expect(queen(live.state, colony).spawnPoint).toEqual(point.get(colony));
    const parsed = parseLog(live.lines);
    expect(parsed.ticks.get(10)).toEqual(commands("SPAWN")(10));
    expect(parsed.ticks.get(30)).toEqual(commands("SPAWN")(30));
    const replayed: string[] = [];
    const end = replay(live.lines, 80, (state) => replayed.push(stateHash(state)));
    expect(replayed).toEqual(live.hashes);
    expect(stateHash(end)).toBe(stateHash(live.state));
  });

  // A rules-27 log recorded before
  // ownership carries no queenBrood marker and keeps the any-colony-agent admission.

});

describe("rules 27 spawn-point command through the public count_mark tool", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  /** A started match with colony 0's single free ant beside its queen and no seat yet; the agent joins through the tool. */
  function unseated(config: SimConfig): SimState {
    const state = createMatch(4530, config);
    state.ants = [];
    addAnt(state, 0, 16, 49);
    return state;
  }
  const loggedSpawns = (lines: readonly string[]): SimInput[] => lines
    .map((line) => JSON.parse(line) as { type?: string; inputs?: SimInput[] })
    .flatMap((entry) => (entry.type === "header" ? [] : (entry.inputs ?? [])))
    .filter((input) => input.type === "count_mark" && input.verb === "SPAWN");

  it("sets, moves and clears a queen's spawn point, forwarding queenId into the logged input", async () => {
    h = await startHarness({ simConfig: rules27(), state: unseated(rules27()) });
    const agent = await h.connect();
    const joined = await agent.call("join", { colony: COLONY_NAMES[0] });
    expect(joined.isError).toBe(false);
    const live = () => queen(h!.game.match!.state);
    live().owner = joined.data.agentId as string;
    const set = await agent.call("count_mark", { verb: "SPAWN", count: 0, queenId: 0, ...FAR });
    expect(set.isError, set.text).toBe(false);
    expect(live().spawnPoint).toEqual(FAR);
    h.advance(1);
    const moved = await agent.call("count_mark", { verb: "SPAWN", count: 0, queenId: 0, ...NEAR });
    expect(moved.isError, moved.text).toBe(false);
    expect(live().spawnPoint).toEqual(NEAR);
    h.advance(1);
    const cleared = await agent.call("count_mark", { verb: "SPAWN", count: 0, queenId: 0 });
    expect(cleared.isError, cleared.text).toBe(false);
    expect("spawnPoint" in live()).toBe(false);
    h.advance(1);
    const refused = await agent.call("count_mark", { verb: "SPAWN", count: 0, queenId: 7, ...FAR });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("bad_spawn_point");
    expect(loggedSpawns(h.log).map((input) => input.type === "count_mark" ? input.queenId : null)).toEqual([0, 0, 0, 7]);
  });

  it("refuses a teammate's set, move or clear with a reply saying the queen belongs to a teammate, within the command-reply limit and spending no allowance", async () => {
    const config = rules27({ commandFloorTicks: 100 });
    h = await startHarness({ simConfig: config, state: unseated(config) });
    const owner = await h.connect();
    const teammate = await h.connect();
    const ownerJoin = await owner.call("join", { colony: COLONY_NAMES[0] });
    expect((await teammate.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
    const live = () => queen(h!.game.match!.state);
    live().owner = ownerJoin.data.agentId as string;
    for (const fields of [FAR, {}]) {
      if (fields === FAR) delete live().spawnPoint; else live().spawnPoint = { ...NEAR };
      const before = live().spawnPoint;
      const refused = await teammate.call("count_mark", { verb: "SPAWN", count: 0, queenId: 0, ...fields });
      expect(refused.isError).toBe(true);
      expect(refused.data.error).toEqual({ code: "queen_not_owned",
        message: "Queen 0 belongs to a teammate: only her owner sets, moves or clears her spawn point.",
        howToFix: "Only a queen's owner sets, moves or clears her spawn point: send SPAWN with the queenId of a live queen you own. Refused commands do not spend the command allowance." });
      expect(live().spawnPoint).toEqual(before);
      // A command reply stays within 20,000 characters and 40,960 bytes (both MCP copies).
      expect(refused.text.length).toBeLessThanOrEqual(DEFAULT_REPLY_LIMITS.textChars);
      expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: refused.text }], structuredContent: refused.data, isError: true })))
        .toBeLessThanOrEqual(DEFAULT_REPLY_LIMITS.bytes);
      h.advance(1);
    }
    // Neither refusal spent the allowance: the teammate's next command, inside the 100-tick floor, is accepted.
    const order = await teammate.call("order", { kind: "hold" });
    expect(order.isError, order.text).toBe(false);
    // The owner's own SPAWN on the same queen is accepted.
    const set = await owner.call("count_mark", { verb: "SPAWN", count: 0, queenId: 0, ...FAR });
    expect(set.isError, set.text).toBe(false);
    expect(live().spawnPoint).toEqual(FAR);
  });

});
