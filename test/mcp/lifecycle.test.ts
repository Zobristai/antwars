import { afterEach, describe, expect, it } from "vitest";
import { stateHash } from "../../src/sim/log.js";
import { TEST_CONFIG, TEST_MCP_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function joinAs(harness: Harness, args: Record<string, unknown> = {}): Promise<{ agent: TestAgent; data: any }> {
  const agent = await harness.connect();
  const r = await agent.call("join", args);
  expect(r.isError, r.text).toBe(false);
  return { agent, data: r.data };
}

function simAgent(harness: Harness, agentId: string) {
  const agent = harness.game.match?.state.agents.find((a) => a.id === agentId);
  if (agent === undefined) throw new Error(`agent ${agentId} not in the match`);
  return agent;
}

const ids = (squad: { antId: number }[]): number[] => squad.map((a) => a.antId).sort((x, y) => x - y);

describe("no squad timer; the one idle clock ends the match", () => {
  it("an agent silent past the retired 90 s squad timer keeps its seat and squad; the idle limit ends the match", async () => {
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, houseIdleSeconds: 120 } });
    const a = await joinAs(h);
    const joinedTick = h.game.match!.state.tick;
    h.advance(TEST_CONFIG.squadTimerTicks + 10);
    expect(simAgent(h, a.data.agentId).idle).toBe(false);
    expect([...simAgent(h, a.data.agentId).squad].sort((x, y) => x - y)).toEqual(ids(a.data.squad));
    const back = await a.agent.call("observe");
    expect(back.data.view.agentId).toBe(a.data.agentId);
    expect(back.data.view.squad.length).toBe(6);
    h.advance(120 * TEST_CONFIG.ticksPerSecond + 1);
    expect(h.game.match!.state.result).toMatchObject({ reason: "idle" });
    expect(h.game.match!.state.result!.tick).toBeGreaterThan(joinedTick + TEST_CONFIG.squadTimerTicks);
  });

  it.each(["reconnectToken", "token"])("a rejoin with %s after 90 s returns the same agent with its squad intact", async name => {
    h = await startHarness();
    const a = await joinAs(h);
    await a.agent.end();
    h.advance(TEST_CONFIG.squadTimerTicks + 10);
    expect(simAgent(h, a.data.agentId).idle).toBe(false);
    const again = await joinAs(h, { [name]: a.data.reconnectToken });
    expect(again.data.agentId).toBe(a.data.agentId);
    expect(ids(again.data.squad)).toEqual(ids(a.data.squad));
  });

  it.each(["reconnectToken", "token"])("%s rejoins after a closed or expired session within 90 s and keeps its squad", async name => {
    h = await startHarness();
    const closed = await joinAs(h);
    const expired = await joinAs(h);
    const closedId = closed.agent.transport.sessionId!;
    const expiredId = expired.agent.transport.sessionId!;
    expect(h.handler.hasSession(closedId)).toBe(true);

    await closed.agent.transport.terminateSession();
    expect(h.handler.hasSession(closedId)).toBe(false);

    h.clock.now += TEST_MCP_CONFIG.sessionIdleMs + 1;
    await h.handler.sweep();
    expect(h.handler.hasSession(expiredId)).toBe(false);
    expect(h.handler.sessionCount).toBe(0);

    h.advance(TEST_CONFIG.squadTimerTicks - 100);
    for (const before of [closed, expired]) {
      const again = await joinAs(h, { [name]: before.data.reconnectToken });
      expect(again.data.agentId).toBe(before.data.agentId);
      expect(ids(again.data.squad)).toEqual(ids(before.data.squad));
    }
  });

  it("neither admitted malformed calls nor rate-refused calls reset the idle clock; squads never lapse", async () => {
    // Idle limit 16 s (160 ticks). One call per second is allowed. In the admitted phase the clock moves a second
    // before each call; in the refused phase it stays frozen after one admitted call, so every later call is over the limit.
    h = await startHarness({ simConfig: { ...TEST_CONFIG, squadTimerTicks: 50 }, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 1, houseIdleSeconds: 16 } });
    const caller = await joinAs(h);
    const control = await joinAs(h);
    const malformed: [string, Record<string, unknown>, string][] = [
      ["order", { kind: 5 }, "bad_arguments"],
      ["order", { kind: "go_to", tileX: "a", tileY: 1 }, "bad_arguments"],
      ["join", { token: "invalid" }, "unknown_token"],
      ["order", { kind: "hold", mark: { tileX: 1, tileY: 1, words: 7 } }, "bad_arguments"],
      ["mark", { tileX: "x", tileY: 1, words: ["FOOD"] }, "bad_arguments"],
      ["join", { displayName: "" }, "bad_display_name"],
      ["order", { kind: "hold", intent: 1 }, "bad_arguments"],
    ];
    const left = (id: string) => h!.game.observeInfoForAgent(id).status[0];
    const phase = async (ticks: number, before: () => void, refused: boolean): Promise<void> => {
      const from = h!.game.match!.state.tick;
      for (let i = 0; h!.game.match!.state.tick - from < ticks && h!.game.match!.state.result === null; i += 1) {
        h!.advance(20);
        before();
        const [name, args, code] = malformed[i % malformed.length]!;
        const r = await caller.agent.call(name, args);
        expect(r.isError).toBe(true);
        expect(r.data.error.code).toBe(refused ? "call_rate" : code);
        expect(r.data.error.howToFix).toMatch(/\S/);
      }
    };
    // Admitted wrong-typed and invalid join calls reach the sim as observe inputs but never reset the idle clock.
    // The control seat keeps its own clock alive with accepted observes.
    await phase(80, () => {
      h!.clock.now += 1000;
      void control.agent.call("observe");
    }, false);
    expect(h.game.match!.state.result).toBeNull();
    const agent = simAgent(h, caller.data.agentId);
    expect(agent.idle).toBe(false);
    expect(agent.squad.length).toBe(6);
    expect(h.inputsOf(caller.data.agentId).every((input) => input.type === "join" || input.type === "observe")).toBe(true);
    expect(left(caller.data.agentId)).toBeLessThanOrEqual(8);
    // Refused calls keep nothing either: the caller's colony loses at its limit.
    const logged = h.inputsOf(caller.data.agentId).length;
    await phase(100, () => {}, true);
    expect(h.game.match!.state.result).toMatchObject({ reason: "idle", winner: simAgent(h, control.data.agentId).colony });
    expect(h.inputsOf(caller.data.agentId).length).toBe(logged);
  });
});

describe("an agent and its token belong to one match", () => {
  it.each(["reconnectToken", "token"])("after the match ends, observe reports the winner; a %s rejoin gets the match-ended error and changes nothing", async name => {
    // Two calls per second; the clock moves a second before each call that should be admitted.
    h = await startHarness({ simConfig: { ...TEST_CONFIG, matchTicks: 60 }, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
    const a = await joinAs(h);
    const own = a.data.squad[0];
    h.advance(70);
    expect(h.game.match!.result).not.toBeNull();

    h.clock.now += 1000;
    const observed = await a.agent.call("observe");
    expect(observed.isError).toBe(false);
    expect(observed.data.matchOver).toBe(true);
    const winner = observed.data.winner;
    expect(observed.data.view.events.length).toBeGreaterThan(0);
    // The first observe marks the agent's events delivered; nothing after it changes the ended match.
    const endHash = stateHash(h.game.match!.state);

    const endedError = (r: { isError: boolean; text: string; data: any }): void => {
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("match_over");
      expect(r.text).toMatch(/match has ended/);
      expect(r.text).toMatch(/call join/i);
      expect(r.data.winner).toBe(winner);
    };
    const stale = await h.connect();
    for (const [agent, tool, args] of [
      [a.agent, "order", { kind: "hold" }],
      [a.agent, "mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD"] }],
      [a.agent, "order", { kind: 7 }],
      [stale, "join", { [name]: a.data.reconnectToken }],
    ] as const) {
      h.clock.now += 1000;
      endedError(await agent.call(tool, args));
    }

    // A second observe does not repeat delivered events.
    h.clock.now += 1000;
    const again = await a.agent.call("observe");
    expect(again.data.matchOver).toBe(true);
    expect(again.data.view.events).toEqual([]);

    // With the window full, calls report the rate refusal and retry timing, retaining the winner.
    expect((await a.agent.call("observe")).isError).toBe(false);
    for (const r of [
      await a.agent.call("order", { kind: "hold" }),
      await a.agent.call("observe"),
      await stale.call("join", { [name]: a.data.reconnectToken }),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("call_rate");
      expect(r.data.retryAfterMs).toBe(1000);
      expect(r.data.winner).toBe(winner);
      expect(r.data.tick).toBe(h.game.match!.state.tick);
      expect(r.data.nextCommandTick).toBeNull();
    }
    expect(stateHash(h.game.match!.state)).toBe(endHash);

    // The next match carries none of it: the old agent is not in it and its calls still get the ended error.
    h.game.startMatch(2);
    expect(h.game.match!.state.agents).toEqual([]);
    h.clock.now += 1000;
    const late = await a.agent.call("order", { kind: "forage" });
    expect(late.data.error.code).toBe("match_over");
    h.advance(TEST_CONFIG.squadTimerTicks + 1);
    expect(h.game.match!.state.agents).toEqual([]);
    // The same session may join the next match as a new agent.
    h.clock.now += 1000;
    const fresh = await a.agent.call("join", {});
    expect(fresh.isError, fresh.text).toBe(false);
    expect(fresh.data.agentId).not.toBe(a.data.agentId);
  });
});
