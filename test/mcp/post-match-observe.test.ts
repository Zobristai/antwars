import { afterEach, describe, expect, it } from "vitest";
import { IDLE_COUNTDOWN_TEXT, POST_MATCH_OBSERVE_TEXT } from "../../src/mcp/briefing.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import type { ColonyId, MatchResult } from "../../src/sim/types.js";
import { startHarness, TEST_MCP_CONFIG, type CallResult, type Harness, type TestAgent } from "./harness.js";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const config = { ...rulesConfig("redesign"), antSpeedTilesPerSecond: 0 };

function finishEarly(winner: ColonyId): MatchResult {
  const state = h!.game.match!.state;
  for (const queen of state.colonies[winner === 0 ? 1 : 0].queens!) queen.lostTick = state.tick;
  h!.advance(1);
  const result = h!.game.match!.result!;
  expect(result).toMatchObject({ winner, reason: "queens_killed" });
  expect(h!.game.match!.state.tick).toBeLessThan(config.matchTicks);
  return result;
}

async function observe(agent: TestAgent, result: MatchResult, args: Record<string, unknown> = {}): Promise<CallResult> {
  // Check the actual SDK reply, including both copies and the independently pinned caps.
  const reply = await agent.client.callTool({ name: "observe", arguments: args });
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(40_960);
  const text = (reply.content as { type: string; text: string }[])[0]!.text;
  expect(text.length).toBeLessThanOrEqual(20_000);
  expect(JSON.parse(text)).toEqual(reply.structuredContent);
  const data = reply.structuredContent as Record<string, unknown>;
  expect(data).toMatchObject({ matchOver: true, winner: result.winner === null ? "draw" : COLONY_NAMES[result.winner], result });
  expect(text).toContain("This match has ended.");
  expect(data.status).toBeDefined();
  expect((data.status as unknown[])[0]).toBeNull();
  if (reply.isError) {
    const { howToFix } = data.error as { howToFix: string };
    expect(howToFix).toContain(POST_MATCH_OBSERVE_TEXT);
    expect(howToFix).toContain(IDLE_COUNTDOWN_TEXT);
  }
  expect(data).not.toHaveProperty("secondsLeft");
  expect(data).not.toHaveProperty("ticksLeft");
  if (data.view !== undefined) {
    expect(data.view).not.toHaveProperty("secondsLeft");
    expect(data.view).not.toHaveProperty("ticksLeft");
  }
  return { isError: reply.isError === true, text, data };
}

describe("ended-seat observe reports a result instead of a running clock", () => {
  it.each([0, 1] as const)("reports early winner %s for default, repeated, map, history and refused observes", async winner => {
    h = await startHarness({ simConfig: config });
    const agent = await h.connect();
    await agent.call("join");
    expect((await agent.call("count_mark", { verb: "GATHER", count: 1 })).isError).toBe(false);
    const result = finishEarly(winner);
    const first = await observe(agent, result);
    expect(first.isError).toBe(false);
    expect(first.data.view.events.some((event: { type: string }) => event.type === "mark_laid")).toBe(true);
    const hash = stateHash(h.game.match!.state);
    expect((await observe(agent, result)).data.view.events).toEqual([]);
    expect((await observe(agent, result, { map: true })).data.view).toHaveProperty("territory");
    expect((await observe(agent, result, { since: 0 })).data.view.events.length).toBeGreaterThan(0);
    const badCursor = await observe(agent, result, { since: Number.MAX_SAFE_INTEGER });
    expect(badCursor.data.error.code).toBe("bad_event_cursor");
    for (const args of [{ since: -1 }, { map: "wrong" }, { waitSeconds: "wrong" }]) {
      expect((await observe(agent, result, args)).data.error.code).toBe("match_over");
    }
    expect(stateHash(h.game.match!.state)).toBe(hash);
  });

  it("reports a draw when time expires, with no zero-valued running clocks", async () => {
    h = await startHarness({ simConfig: config });
    const agent = await h.connect();
    await agent.call("join");
    const state = h.game.match!.state;
    state.ants = [];
    state.owner.fill(-1);
    state.stats.delivered = [0, 0];
    // No hatch or previous territory can decide the tie on this final tick.
    for (const colony of state.colonies) colony.foodStore = 0;
    state.tick = config.matchTicks - 1;
    h.advance(1);
    const result = h.game.match!.result!;
    expect(result).toMatchObject({ winner: null, reason: "time_up", decidedBy: "draw" });
    expect((await observe(agent, result)).isError).toBe(false);
  });

  it("rate-refused observe still gives the original result, including after reconnect and the next match starts", async () => {
    h = await startHarness({ simConfig: config, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 1 } });
    const agent = await h.connect();
    const joined = await agent.call("join");
    h.clock.now += 1000;
    expect((await agent.call("count_mark", { verb: "GATHER", count: 1 })).isError).toBe(false);
    const result = finishEarly(0);
    const limited = await agent.call("observe", { since: 0 });
    expect(limited.data).toMatchObject({ error: { code: "call_rate" }, retryAfterMs: 1000, result });
    expect(limited.data).not.toHaveProperty("view");
    h.game.startMatch(22);
    const hash = stateHash(h.game.match!.state);
    const reconnected = await h.connect();
    const rebound = await reconnected.call("join", { token: joined.data.reconnectToken });
    expect(rebound.data).toMatchObject({ error: { code: "call_rate" }, retryAfterMs: 1000, result });
    expect((await reconnected.call("observe", { map: "wrong" })).data.error.code).toBe("call_rate");
    h.clock.now += 1000;
    const history = await observe(reconnected, result, { since: 0 });
    expect(history.isError).toBe(false);
    expect(history.data.view.eventsMode).toBe("history");
    expect(history.data.view.events.length).toBeGreaterThan(0);
    expect(stateHash(h.game.match!.state)).toBe(hash);
  });

  it("keeps only a compact receipt in existing sessions after cleanup, even if the seat never read its result", async () => {
    h = await startHarness({ simConfig: config });
    const agent = await h.connect();
    const joined = await agent.call("join");
    const receipt = h.game.finalResultReceipt(joined.data.agentId)!;
    // The receipt keeps its match's result and the colony names that match used, nothing else.
    expect(receipt).toEqual({ result: null, colonyNames: COLONY_NAMES });
    const result = finishEarly(0);
    expect(receipt).toEqual({ result, colonyNames: COLONY_NAMES });
    expect(Object.keys(receipt)).toEqual(["result", "colonyNames"]);
    h.game.startMatch(22);
    // A different winner in the newer match must never replace this seat's result.
    finishEarly(1);
    h.game.startMatch(33);
    expect(h.game.status(joined.data.agentId)).toBe("unknown");
    expect(h.game.finalResultReceipt(joined.data.agentId)).toBeUndefined();
    expect(h.game.eventHistory(joined.data.agentId)).toEqual([]);
    const hash = stateHash(h.game.match!.state);
    for (const args of [{}, { map: true }, { since: 0 }, { map: "wrong" }]) {
      expect((await observe(agent, result, args)).data.error.code).toBe("match_over");
    }
    expect(stateHash(h.game.match!.state)).toBe(hash);
    const stranger = await h.connect();
    expect((await stranger.call("join", { token: joined.data.reconnectToken })).data.error.code).toBe("unknown_token");
    const unjoined = await stranger.call("observe");
    expect(unjoined.data.error.code).toBe("not_joined");
    expect(unjoined.data).not.toHaveProperty("result");
    // Rebinding the old session replaces the receipt, not its retention policy.
    expect((await agent.call("join")).isError).toBe(false);
    const live = await agent.call("observe");
    expect(live.isError).toBe(false);
    expect(live.data.view.result).toBeNull();
    expect(live.data).not.toHaveProperty("matchOver");
    expect(live.data.view.secondsLeft).toBeGreaterThan(0);
    expect(live.data.status[0]).toBeGreaterThan(0);
  });

  it("keeps a held observe bound to its original receipt when the session joins a newer match during the hold", async () => {
    h = await startHarness({ simConfig: config });
    const agent = await h.connect();
    await agent.call("join");
    const result = finishEarly(0);
    h.game.startMatch(22);
    finishEarly(1);
    h.game.startMatch(33);
    const held = observe(agent, result, { waitSeconds: 0.15 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await agent.call("join")).isError).toBe(false);
    const hash = stateHash(h.game.match!.state);
    expect((await held).data.error.code).toBe("match_over");
    expect(stateHash(h.game.match!.state)).toBe(hash);
    expect((await agent.call("observe")).data.view.result).toBeNull();
  });

  it.each(["v4", "count-marks", "redesign"] as const)("preserves live clocks and shares post-match wording in %s", async rules => {
    const liveConfig = { ...rulesConfig(rules), antSpeedTilesPerSecond: 0 };
    h = await startHarness({ simConfig: liveConfig, start: false });
    const agent = await h.connect();
    const joined = await agent.call("join");
    const queued = await agent.call("observe");
    expect(queued.data.waiting).toBe(true);
    expect(queued.data.status[0]).toBeNull();
    h.game.startMatch(7);
    const full = await agent.call("rules");
    const listed = (await agent.client.listTools()).tools.find(tool => tool.name === "observe")!;
    for (const text of [joined.data.briefing, full.data.rules, listed.description]) {
      expect(text).toContain(POST_MATCH_OBSERVE_TEXT);
      expect(text).toContain(IDLE_COUNTDOWN_TEXT);
      expect(text).toContain("null unseated or match ended");
    }
    const live = await agent.call("observe");
    const ticksLeft = liveConfig.matchTicks - live.data.view.tick;
    expect(live.data.view.ticksLeft).toBe(ticksLeft);
    expect(live.data.view.secondsLeft).toBe(Math.ceil(ticksLeft / liveConfig.ticksPerSecond));
    expect(live.data.status[0]).toBeGreaterThan(0);
    expect(live.data).not.toHaveProperty("matchOver");
    expect(live.data).not.toHaveProperty("message");
  });
});
