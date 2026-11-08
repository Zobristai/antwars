import { afterEach, describe, expect, it } from "vitest";
import { replay, stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { WORDS, type VisibleEvent } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { TEST_CONFIG, TEST_MCP_CONFIG, startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function agentState(harness: Harness, agentId: string) {
  const agent = harness.game.match?.state.agents.find((a) => a.id === agentId);
  if (agent === undefined) throw new Error(`agent ${agentId} not in the match`);
  return agent;
}

describe("the tool list", () => {
  it("lists the four play tools and the full rules call", async () => {
    h = await startHarness();
    const a = await h.connect();
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["join", "mark", "observe", "order", "rules"]);
  });

  for (const start of [true, false]) {
    it(`derives both seating limits from a non-default cap in join tool, join reply and rules (${start ? "live" : "queued"})`, async () => {
      h = await startHarness({ start, mcpConfig: { ...TEST_MCP_CONFIG, maxAgentsPerMatch: 6 } });
      const a = await h.connect();
      const { tools } = await a.client.listTools();
      const join = tools.find((tool) => tool.name === "join")!;
      const limitText = "Agent limits: 6 per match, 3 per colony.";
      expect(join.description).toContain(limitText);
      expect(JSON.stringify(join.inputSchema)).toContain("3-agent colony limit");
      expect(JSON.stringify(join)).not.toContain("honoured only if the sides stay within one agent");
      const unboundRules = await a.call("rules");
      expect(unboundRules.data.rules).toContain(limitText);
      const joined = await a.call("join", { colony: COLONY_NAMES[0] });
      expect(joined.isError).toBe(false);
      // A grid-scale-2 match carries the current (version 17) compact join briefing, which states both limits this way.
      expect(joined.data.briefing).toContain("Agent limits: 6/match, 3/colony.");
      expect(joined.data.briefing).toContain("if full, the join is refused, never moved");
      const rules = await a.call("rules");
      expect(rules.data.rules).toContain(limitText);
      expect(rules.data.rules).toContain("Without a colony, join chooses the colony with fewer agents (colony 0 on a tie)");
    });
  }
});

describe("wrong-typed arguments", () => {
  it("caught fields keep the match ticking: each gets a field and type error, reaches the sim as an observe, and the log replays", async () => {
    h = await startHarness();
    const a = await h.connect();
    const b = await h.connect();
    const joinedA = await a.call("join", {});
    const joinedB = await b.call("join", {});
    const idA: string = joinedA.data.agentId;
    expect(joinedB.isError).toBe(false);

    const cases: [string, Record<string, unknown>, string][] = [
      ["order", { kind: 5 }, "kind must be one of go_to"],
      ["order", { kind: "nope" }, "kind must be one of go_to"],
      ["order", { kind: "go_to", tileX: "3", tileY: 4 }, "tileX must be a number"],
      ["order", { kind: "attack" }, "tileX must be a number"],
      ["order", { kind: "hold", mark: null }, "mark must be an object"],
      ["order", { kind: "hold", mark: "FOOD" }, "mark must be an object"],
      ["order", { kind: "hold", mark: { tileX: "8", tileY: 24, words: ["FOOD"] } }, "mark.tileX must be a number"],
      ["order", { kind: "hold", mark: { tileX: 8, tileY: 24, words: null } }, "mark.words must be an array"],
      ["order", { kind: "hold", mark: { tileX: 8, tileY: 24, words: "FOOD" } }, "mark.words must be an array"],
      ["order", { kind: "hold", mark: { tileX: 8, tileY: 24, words: [1, 2] } }, "mark.words must be an array"],
      ["order", { kind: "hold", intent: 5 }, "intent must be a string"],
      ["order", { kind: "hold", intent: null }, "intent must be a string"],
      ["mark", { tileX: "8", tileY: 24, words: ["FOOD"] }, "tileX must be a number"],
      ["mark", { tileX: 8, tileY: 24, words: "FOOD" }, "words must be an array"],
      ["mark", {}, "words must be an array"],
      ["join", { displayName: 5 }, "displayName must be a string"],
    ];
    for (const [tool, args, expected] of cases) {
      const before = h.inputsOf(idA).length;
      const tickB = (await b.call("observe")).data.view.tick as number;
      const r = await a.call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text).toContain(expected);
      expect(r.data.error.howToFix).toMatch(/\S/);
      const inputs = h.inputsOf(idA);
      expect(inputs.length).toBe(before + 1);
      expect(inputs.at(-1)?.type).toBe("observe");
      // The match keeps ticking for the other agent.
      expect((await b.call("observe")).data.view.tick).toBeGreaterThan(tickB);
    }
    expect(agentState(h, idA).squad.length).toBeGreaterThan(0);
    const state = h.game.match!.state;
    expect(stateHash(replay(h.log, state.tick))).toBe(stateHash(state));
  });
});

describe("every error says how to fix the call, never forfeits, never leaks", () => {
  it("answers each invalid call with a fix, keeps the agent and its squad, and names nothing outside its view", async () => {
    const state = createMatch(1, playable(TEST_CONFIG));
    // A colony-1 ant and mark far outside colony 0's sight, with ids and tiles no error may name.
    addAnt(state, 1, 61, 3, { id: 987654 });
    state.marks.push({ id: 876543, agentId: "hidden", colony: 1, tileX: 61, tileY: 3, words: ["ENEMY"], laidTick: 0, steering: 0 });
    h = await startHarness({ state });
    const stranger = await h.connect();
    const a = await h.connect();
    const errors = [await stranger.call("observe"), await stranger.call("join", { token: "not-a-token" })];
    const joined = await a.call("join", { colony: "Very Large Colony" });
    const id: string = joined.data.agentId;
    const own = joined.data.squad[0] as { tileX: number; tileY: number };
    errors.push(
      await a.call("join", {}),
      await a.call("join", { displayName: "" }),
      await a.call("order", { kind: "go_to", tileX: 999, tileY: 2 }),
      await a.call("order", { kind: "hold", intent: "x".repeat(81) }),
      await a.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD", "BANANA"] }),
      await a.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD", "N", "MANY", "GO"] }),
      await a.call("mark", { tileX: 61, tileY: 3, words: ["ATTACK"] }),
      await a.call("order", { kind: "hold" }),
      await a.call("order", { kind: "forage" }),
      await a.call("mark", { tileX: own.tileX, tileY: own.tileY, words: ["FOOD"] }),
    );
    expect(errors.filter((r) => !r.isError)).toHaveLength(1); // only the first hold is accepted
    for (const r of errors.filter((e) => e.isError)) {
      expect(r.data.error.howToFix, r.text).toMatch(/\S/);
      expect(r.text).toContain(r.data.error.howToFix);
      expect(r.text).not.toContain("987654");
      expect(r.text).not.toContain("876543");
      expect(r.text).not.toMatch(/\b61\b.{0,12}\b3\b/);
    }
    const codes = errors.filter((e) => e.isError).map((e) => e.data.error.code);
    expect(codes).toEqual([
      "not_joined",
      "unknown_token",
      "already_joined",
      "bad_display_name",
      "bad_order",
      "intent_too_long",
      "bad_mark_words",
      "bad_mark_words",
      "no_own_ant_on_tile",
      "rate_limited",
      "rate_limited",
    ]);
    const after = await a.call("observe");
    expect(after.isError).toBe(false);
    expect(after.data.view.agentId).toBe(id);
    expect(after.data.view.squad.length).toBeGreaterThan(0);
  });
});

describe("per-agent rate limit and agent cap", () => {
  it("refused calls are not sim inputs: absent from the log, sim state unchanged, events held for the next admitted call", async () => {
    // Two clusters in combat reach with no grace, so fights happen in A's sight.
    const state = emptyMatch(0, { ...playable(TEST_CONFIG), combatGraceTicks: 0 });
    state.food.fill(0);
    for (let i = 0; i < 24; i += 1) addAnt(state, 0, 10 + (i % 4), 10 + Math.floor(i / 4));
    for (let i = 0; i < 24; i += 1) addAnt(state, 1, 15 + (i % 4), 10 + Math.floor(i / 4));
    h = await startHarness({ state, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
    const a = await h.connect();
    const b = await h.connect();
    const joined = (await a.call("join", { colony: COLONY_NAMES[0] })).data;
    const id: string = joined.agentId;
    await b.call("join", {});
    // The join and this order fill A's window; the clock stays frozen from here.
    const attack = await a.call("order", { kind: "attack", tileX: 16, tileY: 11 });
    expect(attack.isError, attack.text).toBe(false);
    h.advance(20);
    const pending = (): VisibleEvent[] => structuredClone(agentState(h!, id).pendingEvents);
    const held = pending();
    expect(held.some((e) => e.type === "fight")).toBe(true);
    const burstTick = h.game.match!.state.tick;
    const logLines = h.log.length;
    const logged = h.inputsOf(id).length;
    const hash = stateHash(h.game.match!.state);

    const rejoin = await h.connect();
    const burst: [{ call: (n: string, x?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; data: any }> }, string, Record<string, unknown>][] = [
      [a, "observe", {}],
      [a, "order", { kind: "forage" }],
      [a, "order", { kind: "go_to", tileX: -5, tileY: -5 }],
      [a, "order", { kind: 7 }],
      [a, "mark", { tileX: 10, tileY: 10, words: [WORDS[0]] }],
      [a, "join", { displayName: "" }],
      [rejoin, "join", { token: joined.reconnectToken }],
    ];
    for (const [agent, name, args] of burst) {
      const r = await agent.call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.data.error.code).toBe("call_rate");
      expect(r.text).toContain("2 calls per second");
      expect(r.data.retryAfterMs).toBe(1000);
      expect(r.data.error.howToFix).toContain("1000 ms");
    }
    expect(h.log.length).toBe(logLines);
    expect(h.inputsOf(id).length).toBe(logged);
    expect(h.game.match!.state.tick).toBe(burstTick);
    expect(stateHash(h.game.match!.state)).toBe(hash);
    expect(pending()).toEqual(held);

    // Other agents are still served.
    expect((await b.call("observe")).isError).toBe(false);

    // Only admitted calls fill the window: refused calls late in it do not push back the next admission.
    h.clock.now += 600;
    for (let i = 0; i < 2; i += 1) expect((await a.call("observe")).data.error.code).toBe("call_rate");
    h.clock.now += 500;

    // A's next admitted call delivers the events held back since its last admitted call.
    const next = await a.call("observe");
    expect(next.isError).toBe(false);
    const events = [...next.data.view.events] as VisibleEvent[];
    let page = next;
    while (page.data.view.eventsMore) {
      h.clock.now += 1000; // Paged reads obey the same per-agent call rate.
      page = await a.call("observe", { since: page.data.view.eventCursor });
      events.push(...page.data.view.events);
    }
    // Events are stamped with the tick they happened in; every held one happened before the burst, and only
    // ticks stepped since (B's call, A's observe) can add fresh ones.
    for (const e of held) expect(e.tick).toBeLessThan(burstTick);
    expect(events.some((e) => e.type === "fight" && e.tick <= burstTick)).toBe(true);
    for (const event of held) expect(events).toContainEqual(event); // commands no longer consume earlier events
  });

  it("rejects joins beyond the per-match cap and keeps serving the joined agents", async () => {
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, maxAgentsPerMatch: 2 } });
    const [a, b, c] = [await h.connect(), await h.connect(), await h.connect()];
    expect((await a.call("join", {})).isError).toBe(false);
    expect((await b.call("join", {})).isError).toBe(false);
    const third = await c.call("join", {});
    expect(third.isError).toBe(true);
    expect(third.data.error.code).toBe("agent_cap");
    expect(third.data.error.howToFix).toMatch(/\S/);
    expect((await a.call("observe")).isError).toBe(false);
    expect((await b.call("order", { kind: "forage" })).isError).toBe(false);
  });

  it("at the default cap of 8, refuses the 9th join with agent_cap", async () => {
    expect(TEST_MCP_CONFIG.maxAgentsPerMatch).toBe(8);
    h = await startHarness();
    const agents = [];
    for (let i = 0; i < 9; i += 1) agents.push(await h.connect());
    for (const agent of agents.slice(0, 8)) expect((await agent.call("join", {})).isError).toBe(false);
    const ninth = await agents[8]!.call("join", {});
    expect(ninth.isError).toBe(true);
    expect(ninth.data.error.code).toBe("agent_cap");
    expect(ninth.text).toContain("already has its 8 agents");
    expect((await agents[0]!.call("observe")).isError).toBe(false);
  });
});

// Exercise the advertised contract and the real MCP refusal, not just the sim seam.
it("advertises worker-only FORAGE", async () => {
  const config = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
  h = await startHarness({ simConfig: config });
  const agent = await h.connect();
  const tool = (await agent.client.listTools()).tools.find(tool => tool.name === "count_mark")!;
  expect(tool.description).toContain("FORAGE recruits workers only");
  expect(tool.description).toContain("caste soldier is refused");
  expect(JSON.stringify(tool.inputSchema)).toContain("FORAGE recruits workers only; soldier is refused");
  await agent.call("join", {});
  const result = await agent.call("count_mark", { verb: "FORAGE", caste: "soldier", count: 1 });
  expect(result.isError).toBe(true);
  expect(result.data.error.code).toBe("bad_count_mark");
  expect(result.data.error.message).toContain("FORAGE recruits workers only");
  expect(result.data.error.howToFix).toContain("leave caste out or use worker");
  expect(h.game.match!.state.marks).toHaveLength(0);
});
