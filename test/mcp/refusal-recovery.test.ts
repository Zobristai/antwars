import { unpackTerritory } from "../../src/mcp/territory.js";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, IDLE_COUNTDOWN_TEXT, joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG, houseIdleSecondsOf } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { rulesConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { cloneState } from "../../src/sim/map.js";
import type { SimState } from "../../src/sim/types.js";
import { startHarness, TEST_CONFIG, TEST_MCP_CONFIG, type Harness } from "./harness.js";
import { playable } from "../playable.ts";
import { physicalTileArea } from "../../src/sim/gridScale.js";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const commandConfig = { ...playable(rulesConfig("redesign")), commandIdleTicks: 30, commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
const { wordMarksDisabled: _retired, ...legacyCommandConfig } = commandConfig;
const agentOf = (state: SimState, id: string) => state.agents.find(a => a.id === id)!;
const share = (state: SimState, colony: number) => Math.trunc([...state.owner].filter(owner => owner === colony).length * 1000 / (state.config.mapWidth * state.config.mapHeight));

// Every match counts down the accepted-call idle clock (houseIdleSeconds); any accepted call resets it.
function expectInfo(data: Record<string, any>, state: SimState, id: string): void {
  const agent = agentOf(state, id);
  const config = state.config;
  const live = h!.game.match?.state === state ? h!.game.spectatorHouseIdle(h!.game.match!.seq) : undefined;
  const since = live?.activityTick(id) ?? agent.joinedTick ?? 0;
  const left = state.result !== null ? null : Math.max(0, Math.ceil(houseIdleSecondsOf(h!.game.mcpConfig) - (state.tick - since) / config.ticksPerSecond));
  expect(data.status[0]).toBe(left);
  for (const tool of ["order", "observe", "rules", "join"]) expect(data.status[1].split(" ")).toContain(tool);
  // Rules 27 names mark only where the mark tool exists, and set_brood on this house-activity timer.
  expect(data.status[1].split(" ").includes("mark")).toBe(!(config.rules27 === true && config.wordMarksDisabled === true));
  expect(data.status[1].split(" ").includes("set_brood")).toBe(config.rules27 === true && config.castes !== undefined);
  if (config.rules === "redesign") expect(data.status[2]).toBe(share(state, 1 - agent.colony));
  else expect(data.status).toHaveLength(2);
}

describe("rate refusals explain the existing admission window without touching the sim", () => {
  it("counts join and rules, reports exact retry timing and current ticks, and admits at the advertised boundary", async () => {
    h = await startHarness({ simConfig: legacyCommandConfig, mcpConfig: DEFAULT_MCP_CONFIG });
    const a = await h.connect();
    const joined = await a.call("join");
    const id: string = joined.data.agentId;
    expect((await a.call("rules")).isError).toBe(false);
    const state = h.game.match!.state;
    const hash = stateHash(state);
    const log = [...h.log];
    const events = [...h.game.eventHistory(id)];
    const cursor = h.game.eventCursor(id);
    for (const [name, args] of [
      ["observe", {}], ["order", { kind: "hold" }], ["mark", { words: ["FOOD"] }],
      ["rules", {}], ["join", { token: joined.data.reconnectToken }],
      ["observe", { map: "wrong" }], ["order", { kind: 3 }],
    ] as const) {
      const r = await a.call(name, args);
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("call_rate");
      expect(r.data).toMatchObject({ tick: state.tick, nextCommandTick: state.tick, retryAfterMs: 1000 });
      expect(r.data.error.howToFix).toContain("1000 ms");
      expect(r.data.error.howToFix).toContain("does not reset your idle timer");
      if (name === "observe") expectInfo(r.data, state, id);
      expect(h.game.match!.state).toBe(state);
      expect(stateHash(state)).toBe(hash);
      expect(h.log).toEqual(log);
      expect(h.game.pendingInputs).toBe(0);
      expect(h.game.eventHistory(id)).toEqual(events);
      expect(h.game.eventCursor(id)).toBe(cursor);
    }
    h.clock.now = 400;
    expect((await a.call("observe")).data.retryAfterMs).toBe(600);
    h.clock.now = 999;
    expect((await a.call("observe")).data.retryAfterMs).toBe(1);
    h.clock.now = 1000;
    const order = await a.call("order", { kind: "hold" });
    expect(order.data.accepted).toBe(true);
    const next = order.data.nextCommandTick;
    await a.call("observe");
    const refused = await a.call("order", { kind: "forage" });
    expect(refused.data.nextCommandTick).toBe(Math.max(next, h.game.match!.state.tick));
    expect(refused.data.tick).toBe(h.game.match!.state.tick);
  });

  it("does not invent a view or countdown before seating", async () => {
    h = await startHarness({ start: false, simConfig: commandConfig, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1 } });
    const a = await h.connect();
    const unjoined = await a.call("observe");
    expect(unjoined.data.error.code).toBe("not_joined");
    expect(unjoined.data.status[0]).toBeNull();
    expect(unjoined.data.status[1].split(" ")).toEqual(["order", "count_mark", "found_queen"]);
    await a.call("join");
    const limited = await a.call("observe");
    expect(limited.data).toMatchObject({ tick: null, nextCommandTick: null, status: [null, "order count_mark found_queen set_brood observe rules join"], retryAfterMs: 1000 });
    h.clock.now = 1000;
    const queued = await a.call("observe");
    expect(queued.data.waiting).toBe(true);
    expect(queued.data.status[0]).toBeNull();
    expect(queued.data.status).toHaveLength(2);
  });
});

describe("empty-squad mark recovery", () => {
  // Seats no longer lapse into command idle; a squad is empty only when no free ant is available.
  it.each(["mark", "order"] as const)("a refused %s with an empty squad directs the seat to an unmarked order", async name => {
    h = await startHarness({ simConfig: { ...legacyCommandConfig, startAnts: 0 } });
    const a = await h.connect();
    const joined = await a.call("join");
    const id: string = joined.data.agentId;
    h.advance(commandConfig.commandIdleTicks + 1);
    expect(agentOf(h.game.match!.state, id).idle).toBe(false);
    expect(agentOf(h.game.match!.state, id).squad).toEqual([]);
    const mark = { words: ["FOOD"] };
    const refused = await a.call(name, name === "mark" ? mark : { kind: "hold", mark });
    expect(refused.data.error.code).toBe("no_own_ant_on_tile");
    expect(refused.data.error.howToFix).toContain("Send an order without a mark");
    expect(refused.data.error.howToFix).not.toContain("wake");
    expect(refused.text).not.toContain("observe until");
    expect(refused.data.error.message).not.toContain("Leave out tileX");
    expect((await a.call("order", { kind: "forage" })).data.accepted).toBe(true);
    const observed = await a.call("observe");
    expect(observed.data.view.idle).toBe(false);
    expectInfo(observed.data, h.game.match!.state, id);
  });
});

describe("observe seat countdown and territory legibility", () => {
  it.each(["v4", "count-marks", "redesign"] as const)("reports configured %s timing without changing its idle or map rules", async rules => {
    const config = { ...playable(rulesConfig(rules)), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
    h = await startHarness({ simConfig: config });
    const a = await h.connect();
    const joined = await a.call("join");
    const id: string = joined.data.agentId;
    h.game.match!.state.owner.fill(1);
    h.game.match!.state.owner[0] = 0;
    h.advance(12);
    for (const args of [{}, { map: true }, { map: "wrong" }, { since: Number.MAX_SAFE_INTEGER }]) {
      const observed = await a.call("observe", args);
      expectInfo(observed.data, h.game.match!.state, id);
      expect(observed.data.status).toHaveLength(rules === "redesign" ? 3 : 2);
      expect(observed.data.status[1].split(" ").includes("observe")).toBe(true);
      if (observed.data.view) {
        const view = observed.data.view;
        expect(view.territorySharePermille).toBe(share(h.game.match!.state, view.colony));
        expect(view).not.toHaveProperty("enemyTerritoryRows");
        expect(view).not.toHaveProperty("enemyTerritoryTiles");
        if (args.map === true) {
          expect(unpackTerritory(view.territory).join("")).toMatch(/^[#.]+$/);
          // territoryTiles counts original-size tile area: one fine tile is 1/physicalTileArea of it.
          expect((unpackTerritory(view.territory).join("").split("#").length - 1) / physicalTileArea(h.game.match!.state.config)).toBe(view.territoryTiles);
        } else expect(view).not.toHaveProperty("territory");
      }
    }
  });

  it("counts down from join and resets on every accepted call, commands, observe, rules and rejoin alike", async () => {
    h = await startHarness({ simConfig: { ...legacyCommandConfig, commandIdleTicks: 100 }, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 1000, houseIdleSeconds: 30 } });
    const a = await h.connect();
    const joined = await a.call("join");
    const id: string = joined.data.agentId;
    const tps = h.game.match!.state.config.ticksPerSecond;
    const left = () => h!.game.observeInfoForAgent(id).status[0];
    h.advance(10 * tps);
    expect(left()).toBe(20);
    for (const [name, args] of [
      ["observe", {}], ["rules", {}], ["join", { token: joined.data.reconnectToken }], ["order", { kind: "hold" }],
    ] as const) {
      const accepted = await a.call(name, args);
      expect(accepted.isError, accepted.text).toBe(false);
      expect(left()).toBe(30);
      h.advance(10 * tps);
      expect(left()).toBe(20);
    }
    expect(agentOf(h.game.match!.state, id).idle).toBe(false);
    h.advance(20 * tps + 1);
    expect(h.game.match!.state.result).toMatchObject({ reason: "idle" });
  });

  it("captures metadata before async consumers can see a later tick", async () => {
    const game = new Game({ simConfig: commandConfig, mcpConfig: TEST_MCP_CONFIG });
    const joined = await game.join({});
    game.startMatch(5);
    game.tick();
    const pending = game.call(joined.agentId!, { type: "observe", agentId: joined.agentId! });
    game.tick();
    // The live match advances in place, so the served tick is kept as a copy.
    const snapshot = cloneState(game.match!.state);
    const expected = share(snapshot, 1 - agentOf(snapshot, joined.agentId!).colony);
    game.match!.state.owner.fill(1);
    game.tick();
    const outcome = await pending;
    expect(outcome.kind).toBe("view");
    if (outcome.kind !== "view") throw new Error("expected view");
    expect(outcome.view.tick).toBe(snapshot.tick);
    expect(outcome.observeInfo?.status[2]).toBe(expected);
    expect(outcome.view.tick).toBeLessThan(game.match!.state.tick);
  });

  it("a held observe reports the snapshot after the hold, not before it", async () => {
    h = await startHarness({ simConfig: commandConfig });
    const a = await h.connect();
    const joined = await a.call("join");
    const before = h.game.match!.state.tick;
    const pending = a.call("observe", { waitSeconds: 0.15, map: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    h.game.match!.state.owner.fill(1);
    h.advance(5);
    const reply = await pending;
    expect(reply.data.view.tick).toBeGreaterThan(before + 5);
    expectInfo(reply.data, h.game.match!.state, joined.data.agentId);
  });
});

describe("ended-token reconnects retain access to the original result", () => {
  it.each([false, true])("binds even a rate-refused ended rejoin; next match running: %s", async nextMatch => {
    h = await startHarness({ simConfig: { ...commandConfig, matchTicks: 15 }, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1 } });
    const a = await h.connect();
    const joined = await a.call("join");
    const id: string = joined.data.agentId;
    h.advance(20);
    const final = h.game.match!.state;
    if (nextMatch) h.game.startMatch(22);
    const current = h.game.match!.state;
    const currentHash = stateHash(current);
    const again = await h.connect();
    const rejoined = await again.call("join", { token: joined.data.reconnectToken });
    expect(rejoined.data.error.code).toBe("call_rate");
    expect(rejoined.data.error.message).toBe("At most 1 calls per second per agent.");
    expect(rejoined.data.error.howToFix).toContain("1000 ms");
    expect(rejoined.data.retryAfterMs).toBe(1000);
    expect(rejoined.data.result).toEqual(final.result);
    h.clock.now += 1000;
    const observed = await again.call("observe", { map: true });
    expect(observed.isError).toBe(false);
    expect(observed.data.matchOver).toBe(true);
    expect(observed.data.view.agentId).toBe(id);
    expect(observed.data.view.tick).toBe(final.tick);
    expect(observed.data.result).toEqual(final.result);
    expectInfo(observed.data, final, id);
    if (nextMatch) {
      expect(stateHash(h.game.match!.state)).toBe(currentHash);
      expect(h.game.match!.state.agents).toEqual([]);
    }
    const stranger = await h.connect();
    expect((await stranger.call("join", { token: "unknown" })).data.error.code).toBe("unknown_token");
    expect((await stranger.call("observe")).data.error.code).toBe("not_joined");
  });
});

it.each(["v4", "count-marks", "redesign"] as const)("documents configured existing limits and observe fields for %s", async rules => {
  const config = playable(rulesConfig(rules));
  h = await startHarness({ simConfig: config, mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 7 } });
  const agent = await h.connect();
  const joined = await agent.call("join");
  const full = await agent.call("rules");
  expect(full.isError).toBe(false);
  expect(joined.data.briefing).toBe(joinBriefing(config, h.game.mcpConfig));
  expect(full.data.rules).toBe(briefing(h.game.configForAgent(joined.data.agentId), h.game.mcpConfig));
  const listed = (await agent.client.listTools()).tools.find(tool => tool.name === "observe")!;
  const countdown = IDLE_COUNTDOWN_TEXT;
  expect(listed.description).toContain("observe status: [idleSecondsLeft:");
  expect(listed.description).toContain(countdown);
  for (const [text, compact] of [
    [briefing(config, h.game.mcpConfig), false],
    [joined.data.briefing as string, true],
    [full.data.rules as string, false],
  ] as const) {
    expect(text).toContain(countdown);
    expect(text).not.toContain("idle seconds (0 idle");
    expect(text).not.toContain("starting at join until your first command");
    expect(text).not.toContain("first-command window");
    if (compact) {
      expect(text).toContain("Calls/agent/sliding 1s: 7");
      expect(text).toContain("join/reconnect/rules/observe/commands count");
      expect(text).toContain("call_rate: retry after retryAfterMs; no idle reset");
    } else if (rules !== "v4") {
      // The full rules for combat-totals configs (count-marks, redesign) carry the concise call line.
      expect(text).toContain("Calls: 7/agent/sliding 1s; join/reconnect/rules/observe/commands all count.");
      expect(text).toContain("call_rate: wait retryAfterMs; no idle reset.");
      expect(text).not.toContain("at most 7 calls per agent in any sliding one-second window");
    } else {
      expect(text).toContain("at most 7 calls per agent in any sliding one-second window");
      expect(text).toContain("join (including reconnectToken reconnect), rules and observe count");
      expect(text).toContain("Rate refusals do not reset the idle timer");
    }
    expect(text).toContain(`observe status: [${countdown}, space-separated resetting tools`);
    expect(text).toContain("Shares: whole-map permille (1000=map)");
    expect(text.includes(", enemy share]")).toBe(rules === "redesign");
    if (rules === "redesign") {
      expect(text).toContain("Enemy share: your tick/sight");
      expect(text).toContain("enemy map fogged");
    }
  }
});
