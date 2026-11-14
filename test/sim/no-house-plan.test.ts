// No bot moves for a player: on a new match every colony's free ants follow their own local rules from the
// first tick, joined or not, and the house founds no queen. Matches recorded before that rule keep their recorded
// house planning when re-simulated, selected by their own header config (localAnts.everyColony absent).
//
// The two recordings under fixtures/house-plan were written on main 4618f6641e1256ebde148966f112aac4267866b6,
// before this rule, the way the live server logs a match (houseActive every tick): never-joined (colony 0 joins
// on tick 0 and lays one count mark, colony 1's seat never joins, abandoned at tick 600) and both-seated (both join
// on tick 0 and lay one count mark each, operator stop at tick 400). expected.json holds what that code re-simulated
// from them: the SHA-256 of the whole state JSON at ticks 1, 100 and 300 and at the end, the result, the tick-1
// roles, and the SHA-256 of every spectator stream message recordLog encodes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordLog } from "../../src/live/record.js";
import { encodePublicMessage } from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { comparisonOptions } from "../../src/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import * as houseBot from "../../src/sim/houseBot.js";
import type { HouseFoundingDecision } from "../../src/sim/houseBot.js";
import { headerLine, parseLog, replay, terminalAt, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { advance, prepareInitialPointRests, type ServerTerminal } from "../../src/sim/step.js";
import { tuningMapConfig } from "../../src/sim/tuningMap.js";
import type { ColonyId, SimInput, SimState } from "../../src/sim/types.js";

// A pass-through wrapper, only to count the house planner's calls; every call runs the real planner.
vi.mock("../../src/sim/houseBot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sim/houseBot.js")>();
  return { ...actual, houseDirection: vi.fn(actual.houseDirection) };
});
const houseDirection = vi.mocked(houseBot.houseDirection);
afterEach(() => houseDirection.mockClear());

const FIXTURES = new URL("./fixtures/house-plan/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", FIXTURES), "utf8")) as Record<string, {
  stateSha256: Record<string, string>; result: unknown; tick1Roles: Record<string, number>;
  stream: { messages: number; bytes: number; sha256: string } }>;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const logOf = (name: string) => readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8").split("\n");
const tally = (values: readonly string[]) => values.reduce<Record<string, number>>((t, v) => ({ ...t, [v]: (t[v] ?? 0) + 1 }), {});
const withoutFlag = (config: SimConfig): SimConfig => {
  const { everyColony: _flag, ...local } = config.localAnts!;
  return { ...config, localAnts: local };
};

describe("matches recorded before the rule", () => {
  for (const name of ["never-joined", "both-seated"]) {
    it(`${name} re-simulates exactly as before, on its recorded house planning`, () => {
      const lines = logOf(name);
      expect(parseLog(lines).header.config.localAnts?.everyColony).toBeUndefined();
      const want = expected[name]!;
      const hashes: Record<string, string> = {};
      let roles: Record<string, number> = {};
      const end = replay(lines, Infinity, (state) => {
        if ([1, 100, 300].includes(state.tick)) hashes[state.tick] = sha(state);
        if (state.tick === 1) roles = tally(state.ants.map((ant) => ant.role));
      });
      hashes[end.tick] = sha(end);
      expect(hashes).toEqual(want.stateSha256);
      expect(end.result).toEqual(want.result);
      // The recording still plays its house planning: house roles on tick 1, house directions every tick.
      expect(roles).toEqual(want.tick1Roles);
      expect(houseDirection).toHaveBeenCalled();
    }, 60_000);

    it(`${name} re-encodes the same spectator stream bytes`, () => {
      const messages = recordLog(logOf(name));
      const digest = createHash("sha256");
      for (const message of messages) digest.update(message);
      expect({ messages: messages.length, bytes: messages.reduce((n, m) => n + m.byteLength, 0), sha256: digest.digest("hex") })
        .toEqual(expected[name]!.stream);
    }, 60_000);
  }
});

/** A new match, logged the way the live server logs one: seats join on tick 0, houseActive every tick. */
function recordNewMatch(seed: number, joiners: readonly (0 | 1)[], endTick: number, end: ServerTerminal): string[] {
  const config = newMatchConfig(rulesConfig("redesign"));
  const state = createMatch(seed, config);
  prepareInitialPointRests(state);
  const lines = [headerLine(seed, config)];
  while (state.result === null) {
    const tick = state.tick, inputs: SimInput[] = [];
    if (tick === 0) for (const colony of joiners) inputs.push({ type: "join", agentId: `seat-${colony}`, placement: colony });
    if (tick === 150) for (const colony of joiners) {
      const queen = state.colonies[colony]!;
      inputs.push({ type: "count_mark", agentId: `seat-${colony}`, verb: "GATHER", count: 4,
        tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) });
    }
    const terminal: ServerTerminal = tick === endTick ? end : false;
    advance(state, inputs, undefined, undefined, undefined, terminal, true);
    lines.push(tickLine(tick, inputs, terminal, true));
  }
  return lines;
}

describe("a match recorded after the rule", () => {
  const HOUSE_ONLY_INTENTS = new Set(["rally", "post", "chase", "queen"]);
  for (const [name, joiners, endTick, end] of [
    ["one seat never joins", [0], 600, "abandoned"],
    ["both seats join on tick 0", [0, 1], 400, true],
  ] as const) {
    it(`${name}: no ant follows a house plan, from tick 0 to the end`, () => {
      const lines = recordNewMatch(6006, joiners, endTick, end);
      expect(parseLog(lines).header.config.localAnts?.everyColony).toBe(true);
      houseDirection.mockClear();
      const start = createMatch(6006, parseLog(lines).header.config);
      const startRoles = start.ants.map((ant) => [ant.id, ant.role]);
      const founding: HouseFoundingDecision[] = [];
      let ticks = 0;
      const check = (state: SimState) => {
        ticks++;
        for (const ant of state.ants as (SimState["ants"][number] & { houseRoleHold?: unknown; houseIntentHold?: { intent: { kind: string } } })[]) {
          // No house role assignment and no house-only intent (rally, guard post, guard chase, queen run).
          expect(ant.houseRoleHold).toBeUndefined();
          expect(HOUSE_ONLY_INTENTS.has(ant.houseIntentHold?.intent.kind ?? "")).toBe(false);
        }
        if (state.tick === 1) expect(state.ants.map((ant) => [ant.id, ant.role])).toEqual(startRoles);
      };
      const endState = replay(lines, Infinity, check);
      expect(ticks).toBe(endTick + 1);
      expect(endState.result?.tick).toBe(endTick);
      // The house planner is never consulted for any ant, joined colony or not.
      expect(houseDirection).not.toHaveBeenCalled();
      // The house founds no queen for any colony, on the abandon tick included.
      const observed = createMatch(6006, parseLog(lines).header.config);
      prepareInitialPointRests(observed);
      const parsed = parseLog(lines);
      while (observed.result === null) {
        const out = advance(observed, parsed.ticks.get(observed.tick) ?? [], undefined, (d) => founding.push(d), undefined,
          parsed.abandonments.has(observed.tick) ? "abandoned" : parsed.stops.has(observed.tick), true);
        expect(out.events.filter((event) => event.type === "queen_founded")).toEqual([]);
      }
      expect(founding.length).toBeGreaterThan(0);
      expect(new Set(founding.map((d) => d.reason))).toEqual(new Set(["agent_controlled"]));
    }, 60_000);
  }
});

/**
 * A new match on the redesign rules, recorded the way a server logs one, with the given inputs per tick, the given
 * idle policy (houseActive: the live server's, where seats never lapse; off: command-idle lapse plays) and end.
 */
function recordMatch(seed: number, patch: Partial<SimConfig>, houseActive: boolean,
  inputsAt: (state: SimState) => SimInput[], endTick: number, end: ServerTerminal): string[] {
  const config = { ...newMatchConfig(rulesConfig("redesign")), ...patch };
  const state = createMatch(seed, config);
  prepareInitialPointRests(state);
  const lines = [headerLine(seed, config)];
  while (state.result === null) {
    const tick = state.tick, inputs = inputsAt(state);
    const terminal: ServerTerminal = tick === endTick ? end : false;
    const out = advance(state, inputs, undefined, undefined, undefined, terminal, houseActive);
    expect(out.results.filter((result) => !result.ok)).toEqual([]);
    lines.push(tickLine(tick, inputs, terminal, houseActive));
  }
  return lines;
}

const gather = (state: SimState, colony: ColonyId): SimInput => {
  const queen = state.colonies[colony]!;
  return { type: "count_mark", agentId: `seat-${colony}`, verb: "GATHER", count: 4,
    tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) };
};

/**
 * Re-simulate a recorded match and, for one colony, from the first tick after which watchFrom(state) holds (that
 * tick included), list every way the house acted for it: the house planner consulted for any of its ants, a house
 * role or a house-only intent on any of them, any ant's role changed, the colony off the local rules, or the house
 * founding step weighing or founding a queen for it. Returns the first watched tick and the problems per tick.
 */
function houseActsFor(lines: readonly string[], colony: ColonyId, watchFrom: (state: SimState) => boolean) {
  const HOUSE_ONLY_INTENTS = new Set(["rally", "post", "chase", "queen"]);
  const log = parseLog(lines);
  const state = createMatch(log.header.seed, log.header.config);
  prepareInitialPointRests(state);
  houseDirection.mockClear();
  let roles = new Map<number, string>();
  let from: number | null = null;
  const problems: string[] = [];
  let watched = 0;
  while (state.result === null) {
    const tick = state.tick, calls = houseDirection.mock.calls.length;
    const founding: HouseFoundingDecision[] = [];
    const out = advance(state, log.ticks.get(tick) ?? [], undefined, (decision) => founding.push(decision), undefined,
      terminalAt(log, tick), log.houseActive.has(tick));
    if (from === null && watchFrom(state)) from = tick;
    const ants = state.ants.filter((ant) => ant.colony === colony) as (SimState["ants"][number] & {
      houseRoleHold?: unknown; houseIntentHold?: { intent: { kind: string } } })[];
    if (from !== null) {
      watched++;
      const at = (what: string) => problems.push(`tick ${tick}: ${what}`);
      const planned = houseDirection.mock.calls.slice(calls).filter(([, , , ant]) => ant.colony === colony).length;
      if (planned > 0) at(`house planner consulted for ${planned} ants`);
      if (!localRulesSide(state, colony)) at("colony not on the local rules");
      for (const ant of ants) {
        if (ant.houseRoleHold !== undefined) at(`ant ${ant.id} holds a house role`);
        if (HOUSE_ONLY_INTENTS.has(ant.houseIntentHold?.intent.kind ?? "")) at(`ant ${ant.id} holds a house ${ant.houseIntentHold!.intent.kind} intent`);
        const before = roles.get(ant.id);
        if (before !== undefined && before !== ant.role) at(`ant ${ant.id} role ${before} -> ${ant.role}`);
      }
      for (const decision of founding) if (decision.colony === colony && decision.reason !== "agent_controlled") at(`house founding weighed: ${decision.reason}`);
      for (const event of out.events) if (event.type === "queen_founded" && event.colony === colony) at("house founded a queen");
    }
    roles = new Map(ants.map((ant) => [ant.id, ant.role]));
  }
  return { from, watched, end: state, problems };
}

describe("a player's colony on a new recorded match: the house never acts for it", () => {
  it("whose player never joins: no house allocation, roles or founding for the whole match", () => {
    // Colony 0 joins on tick 0 and lays count marks; colony 1's seat never joins; the live server marks it abandoned.
    const lines = recordMatch(6006, {}, true, (state) => [
      ...(state.tick === 0 ? [{ type: "join", agentId: "seat-0", placement: 0 } as const] : []),
      ...(state.tick > 0 && state.tick % 150 === 0 ? [gather(state, 0)] : []),
    ], 600, "abandoned");
    const { from, watched, end, problems } = houseActsFor(lines, 1, () => true);
    expect(end.agents.some((agent) => agent.colony === 1)).toBe(false);
    expect(end.result).toMatchObject({ reason: "abandoned", tick: 600 });
    expect([from, watched]).toEqual([0, 601]);
    expect(problems).toEqual([]);
  }, 60_000);

  it("whose player commands and then goes idle: no house allocation, roles or founding from the tick it goes idle", () => {
    // Off the live idle policy, so the seat lapses into command-idle: colony 1 lays count marks at ticks 100 and 200
    // and then stops, so it goes idle at tick 400; colony 0 keeps commanding and stays active to the operator stop.
    const lines = recordMatch(6006, { commandIdleTicks: 200 }, false, (state) => [
      ...(state.tick === 0 ? ([0, 1] as const).map((colony): SimInput => ({ type: "join", agentId: `seat-${colony}`, placement: colony })) : []),
      ...(state.tick > 0 && state.tick % 100 === 0 ? [gather(state, 0)] : []),
      ...(state.tick === 100 || state.tick === 200 ? [gather(state, 1)] : []),
    ], 700, true);
    const seat = (state: SimState, colony: ColonyId) => state.agents.find((agent) => agent.colony === colony)!;
    const { from, watched, end, problems } = houseActsFor(lines, 1, (state) => seat(state, 1).idle);
    expect([from, watched]).toEqual([400, 301]);
    expect(seat(end, 1)).toMatchObject({ idle: true, lastCommandTick: 200 });
    expect(seat(end, 0).idle).toBe(false);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("every new redesign match carries the rule", () => {
  it("on every path that builds a new redesign match config", () => {
    expect(rulesConfig("redesign").localAnts?.everyColony).toBe(true);
    expect(newMatchConfig(rulesConfig("redesign")).localAnts?.everyColony).toBe(true);
    // Ordinary scheduled public matches (ANTWAR_RULES unset) and a redesign comparison run.
    expect(comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig?.localAnts?.everyColony).toBe(true);
    expect(comparisonOptions({ ANTWAR_RULES: "redesign", ANTWAR_PLAYERS: "2" }, DEFAULT_MCP_CONFIG).simConfig?.localAnts?.everyColony).toBe(true);
    expect(tuningMapConfig(64).localAnts?.everyColony).toBe(true);
  });
});

describe("the rule changes no agent text and no stream bytes", () => {
  const config = newMatchConfig(rulesConfig("redesign"));
  const old = withoutFlag(config);

  it("leaves the rated and house-mode briefings unchanged", () => {
    for (const context of [{ house: false }, { house: true }, { house: false, undrawn: true }, { house: true, undrawn: true }]) {
      for (const nestWindow of [false, true]) {
        expect(joinBriefing(config, DEFAULT_MCP_CONFIG, nestWindow, context)).toBe(joinBriefing(old, DEFAULT_MCP_CONFIG, nestWindow, context));
      }
      expect(briefing(config, DEFAULT_MCP_CONFIG, context)).toBe(briefing(old, DEFAULT_MCP_CONFIG, context));
    }
  });

  it("is not carried in the spectator stream, rated or not", () => {
    for (const rated of [false, true]) {
      const encode = (c: SimConfig) => {
        const recorder = new SpectatorRecorder(createMatch(6006, c));
        const full = recorder.initialFull();
        return encodePublicMessage({ ...recorder.initial(), full: rated ? { ...full, setup: { ...full.setup, rated: true } } : full });
      };
      expect(Buffer.from(encode(config)).equals(Buffer.from(encode(old)))).toBe(true);
    }
  });
});
