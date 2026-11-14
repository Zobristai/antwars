import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES, DEFAULT_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { drawColonyNames } from "../../src/sim/colonyNames.js";
import { WORDS } from "../../src/sim/types.js";
import { ORDER_KINDS } from "../../src/mcp/tools.js";
import { Game } from "../../src/mcp/game.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { TEST_CONFIG, TEST_MCP_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const [VLC, LHC] = COLONY_NAMES;

async function joinAs(harness: Harness, args: Record<string, unknown> = {}): Promise<{ agent: TestAgent; data: any }> {
  const agent = await harness.connect();
  const r = await agent.call("join", args);
  expect(r.isError, r.text).toBe(false);
  return { agent, data: r.data };
}

describe("join during a running match", () => {
  it("returns identity, token, colony, a squad of up to six and the briefing", async () => {
    h = await startHarness();
    const { data, agent } = await joinAs(h);
    expect(typeof data.agentId).toBe("string");
    expect(typeof data.reconnectToken).toBe("string");
    expect(COLONY_NAMES).toContain(data.colony);
    expect(data.squad.length).toBe(6);
    for (const ant of data.squad) expect(ant).toEqual(expect.objectContaining({ antId: expect.any(Number), tileX: expect.any(Number), tileY: expect.any(Number) }));
    const rules = await agent.call("rules");
    const text: string = rules.data.rules;
    for (const kind of ORDER_KINDS) expect(text).toContain(kind);
    for (const word of WORDS) expect(text).toMatch(new RegExp(`\\b${word}\\b`));
    expect(text).toContain("How to win");
    expect(text).toContain("Queen overrun");
    expect(text).toContain("never changes owner, to another colony or to neutral, while an ant on it has an enemy within combat reach");
    expect(text.match(/Worked example/g)).toHaveLength(1);
  });

  it("asks the agent to play the whole match, after the notes line", async () => {
    h = await startHarness();
    const lines: string[] = (await joinAs(h)).data.briefing.split("\n");
    const play = lines.indexOf("- Play the whole match: keep observing and giving orders until it ends.");
    expect(play).toBeGreaterThan(-1);
    expect(lines[play - 1]).toMatch(/notes/);
    expect(lines.some(l => l.startsWith("- Keep calling:"))).toBe(false);
  });

  it("takes the briefing's numbers from the match's config", async () => {
    const config: SimConfig = { ...playable(TEST_CONFIG), matchTicks: 4200, squadTimerTicks: 450, commandFloorTicks: 70, markLifetimeTicks: 1200, squadSize: 5 };
    for (const key of ["matchTicks", "squadTimerTicks", "commandFloorTicks", "markLifetimeTicks", "squadSize"] as const) {
      expect(config[key]).not.toBe(playable(DEFAULT_CONFIG)[key]);
    }
    h = await startHarness({ simConfig: config });
    const { data, agent } = await joinAs(h);
    const full = (await agent.call("rules")).data.rules;
    expect(full).toContain("lasts 420 s (7 minutes)");
    expect(data.briefing).not.toContain("after 45 s without a call");
    expect(data.briefing).toContain("One command per 7 s");
    expect(full).toContain("It lasts 120 s");
    expect(data.briefing).toContain("up to 5 ants");
    expect(data.squad.length).toBe(5);
  });

  it("states what each order makes the squad's ants do, and the combat rules, with numbers from the match's config", async () => {
    const config: SimConfig = {
      ...playable(TEST_CONFIG),
      sightTiles: 3,
      smellTiles: 7,
      antSpeedTilesPerSecond: 3,
      antHp: 6000,
      damagePerSecond: 1500,
      defenderBonusPermille: 1400,
      corpseFood: 2,
      combatGraceTicks: 250,
      attackRadiusTiles: 5,
    };
    const keys = ["sightTiles", "smellTiles", "antSpeedTilesPerSecond", "antHp", "damagePerSecond", "defenderBonusPermille", "corpseFood", "combatGraceTicks", "attackRadiusTiles"] as const;
    for (const key of keys) expect(config[key]).not.toBe(playable(DEFAULT_CONFIG)[key]);
    h = await startHarness({ simConfig: config });
    const { agent } = await joinAs(h);
    const text: string = (await agent.call("rules")).data.rules;
    // Orders, as src/sim/agents.ts squadDirections implements them.
    expect(text).toContain("Ants move 3 tiles per second.");
    expect(text).toContain("go_to (tileX, tileY): every squad ant walks straight to that tile and stays there.");
    expect(text).toContain(
      "attack (tileX, tileY): the squad marches to the target tile. A squad ant with an enemy within 2 tiles (diagonals included) stands and fights; otherwise it keeps heading for the target and passes enemies it can only see. Within 5 tiles of the target it goes after the nearest enemy within 5 tiles of the target; with none there it stays at the target.",
    );
    expect(text).toContain("forage: each squad ant heads for the nearest tile with food, picks up 1 food and carries it to its queen");
    expect(text).toContain("hold: squad ants stand still.");
    expect(text).toContain("follow_trail: the squad follows your colony's strongest steering mark within 7 tiles of any squad ant");
    // Combat, as src/sim/combat.ts implements it: 1500 milli-HP/s is 150 per tick; x1.4 is 210 per tick.
    // Bite reach is one original-size tile, 2 fine tiles at grid scale 2.
    expect(text).toContain("every non-carrying ant within 2 tiles of an enemy (diagonals included) hits one of them, the one with the fewest HP, every tick.");
    expect(text).toContain("An ant has 6 HP and deals 1.5 HP per second, or 2.1 HP per second while it stands on its own colony's territory.");
    expect(text).toContain("an ant at 0 HP dies and leaves 2 food. No combat in the first 25 s.");
    // Facts, not advice.
    expect(text).not.toMatch(/\b(should|best|recommend)\b/i);
  });

  it("states the mark rule the sim applies, with numbers from the match's config", async () => {
    const config: SimConfig = { ...playable(TEST_CONFIG), markReachTiles: 7, smellTiles: 6 };
    for (const key of ["markReachTiles", "smellTiles"] as const) {
      expect(config[key]).not.toBe(playable(DEFAULT_CONFIG)[key]);
    }
    h = await startHarness({ simConfig: config });
    const { agent } = await joinAs(h);
    const text: string = (await agent.call("rules")).data.rules;
    // As src/sim/agents.ts join and squadDirections, and src/sim/marks.ts markEffect and trailMark, implement it.
    expect(text).toContain("A new squad starts on forage.");
    expect(text).toContain("follow_trail: the squad follows your colony's strongest steering mark within 6 tiles of any squad ant");
    expect(text).toContain("A mark's first steering word decides where it sends a squad on follow_trail: FOOD, HELP, ATTACK, GATHER and HOLD send it toward the mark; AVOID sends it away; GO with a direction word sends it along that fixed heading;");
    expect(text).toContain("fading to nothing at 7 tiles and over its life;");
    expect(text).toContain("Marks move no other ants: your colony's non-squad ants go about their house-bot work whatever marks lie near them.");
    expect(text).toContain("a teammate's squad on follow_trail heads for the mark while it is your colony's strongest mark near that squad.");
    expect(text).not.toMatch(/pull(ed)? (them|toward)|non-squad ants of your colony are|% the mark's|follow_trail\. Ants move/);
    expect(text).not.toMatch(/GO with a direction pull/);
  });

  it("seats four agents naming the same colony regardless of balance", async () => {
    h = await startHarness();
    const colonies: string[] = [];
    for (let i = 0; i < 4; i += 1) colonies.push((await joinAs(h, { colony: LHC })).data.colony);
    expect(colonies).toEqual([LHC, LHC, LHC, LHC]);
  });

  it("balances unnamed joins with colony 0 on ties and honours named joins independently", async () => {
    h = await startHarness();
    const colonies: string[] = [];
    for (const colony of [undefined, undefined, undefined, undefined, LHC, LHC, undefined]) {
      colonies.push((await joinAs(h, colony === undefined ? {} : { colony })).data.colony);
    }
    expect(colonies).toEqual([VLC, LHC, VLC, LHC, LHC, LHC, VLC]);
  });

  it("gives fewer ants, or none, when the colony has no spare ants within the half-colony limit", async () => {
    const state = emptyMatch(0, playable(TEST_CONFIG));
    state.food.fill(0);
    for (let i = 0; i < 2; i += 1) addAnt(state, 0, 6, 20 + i);
    for (let i = 0; i < 2; i += 1) addAnt(state, 1, 57, 20 + i);
    h = await startHarness({ state });
    const a = await joinAs(h, { colony: VLC });
    const b = await joinAs(h, { colony: LHC });
    const c = await joinAs(h, {});
    expect([a.data.colony, b.data.colony, c.data.colony]).toEqual([VLC, LHC, VLC]);
    expect(a.data.squad).toHaveLength(1);
    expect(b.data.squad).toHaveLength(1);
    expect(c.data.squad).toHaveLength(0);
    expect(c.data.view.orderStatus).toBe("waiting for spare ants");
  });
});

describe("join with no match running", () => {
  it("returns identity, token, colony, briefing and the next start at once; the squad comes when the match starts", async () => {
    h = await startHarness({ start: false });
    h.game.setNextStart({ kind: "scheduled", at: new Date("2026-10-14T16:00:00Z") });
    const a = await joinAs(h, { colony: LHC });
    const b = await joinAs(h, { colony: LHC });
    for (const { data } of [a, b]) {
      expect(typeof data.agentId).toBe("string");
      expect(typeof data.reconnectToken).toBe("string");
      expect(data.briefing).toContain("How to win");
      expect(data.matchStarts).toBe("2026-10-14T16:00:00.000Z");
      expect(data.colony).toBe(LHC);
      expect(data.squad).toBeUndefined();
    }
    const waiting = await a.agent.call("observe");
    expect(waiting.isError).toBe(false);
    expect(waiting.data.waiting).toBe(true);
    expect((await a.agent.call("order", { kind: "hold" })).data.error.code).toBe("not_started");

    h.game.startMatch(1);
    const viewA = (await a.agent.call("observe")).data.view;
    const viewB = (await b.agent.call("observe")).data.view;
    // Named colonies are honoured at start, just as for live joins.
    expect([viewA.colonyName, viewB.colonyName]).toEqual([LHC, LHC]);
    expect(viewA.agentId).toBe(a.data.agentId);
    expect(viewA.squad.length).toBe(6);
    expect(viewB.squad.length).toBe(6);
  });

  it("says a held match starts when its caller starts it", async () => {
    h = await startHarness({ start: false });
    h.game.setNextStart({ kind: "held" });
    const { data } = await joinAs(h);
    expect(data.matchStarts).toBe("when its caller starts it");
  });
});

describe("agent-chosen colony capacity", () => {
  for (const start of [true, false]) {
    it(`refuses a full named colony with its configured limit and no seat (${start ? "live" : "queued"})`, async () => {
      h = await startHarness({ start, mcpConfig: { ...TEST_MCP_CONFIG, maxAgentsPerMatch: 6 } });
      const seated: Awaited<ReturnType<typeof joinAs>>[] = [];
      for (let i = 0; i < 3; i += 1) seated.push(await joinAs(h, { colony: LHC }));
      const refused = await h.connect();
      const beforeLog = [...h.log];
      const beforeTick = h.game.match?.state.tick;
      const beforePending = h.game.pendingInputs;
      const reply = await refused.call("join", { colony: LHC });
      expect(reply.isError).toBe(true);
      expect(reply.data.error.code).toBe("colony_full");
      expect(reply.text).toContain("limit 3 agents per colony (6 per match)");
      expect(reply.data.error.howToFix).toContain("No seat was taken");
      expect(reply.data.agentId).toBeUndefined();
      expect(reply.data.reconnectToken).toBeUndefined();
      expect((await refused.call("observe")).data.error.code).toBe("not_joined");
      expect(start ? h.game.match!.state.agents.length : h.game.queuedAgents).toBe(3);
      expect(h.log).toEqual(beforeLog);
      expect(h.game.match?.state.tick).toBe(beforeTick);
      expect(h.game.pendingInputs).toBe(beforePending);
      if (!start) {
        expect(h.game.queuedLineup().map((p) => p.colony)).toEqual([1, 1, 1]);
        h.game.startMatch(1);
      }
      for (const { agent } of seated) expect((await agent.call("observe")).data.view.colonyName).toBe(LHC);
      // The refusal neither binds the session nor spends the other colony's slot.
      expect((await refused.call("join", { colony: VLC })).data.colony).toBe(VLC);
    });
  }

  for (const start of [true, false]) {
    it(`counts earlier unnamed and named joins before admitting the next named join (${start ? "same tick" : "pre-match queue"})`, async () => {
      const game = new Game({ simConfig: playable(TEST_CONFIG), mcpConfig: { ...TEST_MCP_CONFIG, maxAgentsPerMatch: 6 } });
      if (start) game.startMatch(1);
      // No tick runs until all these requests have been admitted or refused.
      const first = game.join({}); // colony 0 on tie
      const second = game.join({ colony: 0 });
      const third = game.join({ colony: 0 });
      const refusal = await game.join({ colony: 0 });
      expect(refusal).toMatchObject({ agentId: null, token: null, outcome: { kind: "error", code: "colony_full" } });
      const balanced = game.join({});
      if (!start) {
        expect(game.queuedLineup().map((p) => p.colony)).toEqual([0, 0, 0, 1]);
        game.startMatch(1);
      }
      game.tick();
      const accepted = await Promise.all([first, second, third, balanced]);
      expect(accepted.every((r) => r.agentId !== null)).toBe(true);
      // Each admitted join was issued its own token; the refusal took none.
      expect(new Set(accepted.map((r) => r.token)).size).toBe(4);
      expect(accepted.every((r) => r.token !== null)).toBe(true);
      expect(game.match?.state.agents.map((a) => a.colony)).toEqual([0, 0, 0, 1]);
      expect(game.pendingInputs).toBe(0);
      expect(game.queuedAgents).toBe(0);
    });
  }
});

describe("display name and model label", () => {
  it("accepts either or both, logs the label with the join, and never shows it in observe", async () => {
    h = await startHarness();
    const label = "model-label-7f3a";
    const both = await joinAs(h, { displayName: "Ada", modelLabel: label });
    const nameOnly = await joinAs(h, { displayName: "Grace Hopper" });
    const labelOnly = await joinAs(h, { modelLabel: "other-label" });
    const neither = await joinAs(h, {});
    const joinInput = h.inputsOf(both.data.agentId).find((input) => input.type === "join");
    expect(joinInput).toEqual(expect.objectContaining({ type: "join", agentId: both.data.agentId, modelLabel: label }));
    expect(h.log.some((line) => line.includes(label))).toBe(true);
    expect(h.game.agentInfo(both.data.agentId)).toEqual({ displayName: "Ada", modelLabel: label, seatKey: null });
    for (const { agent, data } of [both, nameOnly, labelOnly, neither]) {
      expect(JSON.stringify(data)).not.toContain(label);
      const observed = await agent.call("observe");
      expect(observed.text).not.toContain(label);
    }
  });

  it("rejects an invalid display name with an error result", async () => {
    h = await startHarness();
    for (const displayName of ["", "   ", "bell\u0007", "x".repeat(33)]) {
      const r = await (await h.connect()).call("join", { displayName });
      expect(r.isError, displayName).toBe(true);
      expect(r.data.error.code).toBe("bad_display_name");
      expect(r.data.error.howToFix).toContain("printable characters");
    }
  });
});

describe("self-reported thinking level", () => {
  it.each([true, false])("keeps each scheduled seat's level in the sim and log, not overwritten on reconnect (running: %s)", async start => {
    h = await startHarness({ start });
    const level = "🧠".repeat(32);
    const first = await joinAs(h, { modelLabel: "same-model", thinkingLevel: level });
    const second = await joinAs(h, { modelLabel: "same-model", thinkingLevel: "low" });
    const omitted = await joinAs(h, {});
    if (!start) { h.game.startMatch(1); h.advance(1); }
    const again = await joinAs(h, { reconnectToken: first.data.reconnectToken, thinkingLevel: "max" });
    expect(again.data.agentId).toBe(first.data.agentId);
    expect(h.game.match!.state.agents.map(agent => agent.thinkingLevel ?? null)).toEqual([level, "low", null]);
    expect(h.inputsOf(first.data.agentId).find(input => input.type === "join")).toMatchObject({ thinkingLevel: level });
    expect(h.inputsOf(second.data.agentId).find(input => input.type === "join")).toMatchObject({ thinkingLevel: "low" });
    expect(h.inputsOf(omitted.data.agentId).find(input => input.type === "join")).not.toHaveProperty("thinkingLevel");
  });

  it("refuses blank, overlong, control and non-string levels like invalid model labels", async () => {
    h = await startHarness();
    for (const thinkingLevel of ["", "   ", "bell\u0007", "hidden\u200b", "x".repeat(33), "🧠".repeat(33)]) {
      const result = await (await h.connect()).call("join", { thinkingLevel });
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe("bad_thinking_level");
      expect(result.data.error.howToFix).toContain("1 to 32 printable characters");
    }
    for (const thinkingLevel of [5, true, [], {}, null]) {
      const result = await (await h.connect()).call("join", { thinkingLevel });
      expect(result.isError).toBe(true);
      expect(result.data.error.message).toContain("thinkingLevel");
    }
    expect(h.game.match!.state.agents).toHaveLength(0);
  });
});

describe("reconnect argument contract", () => {
  it.each([true, false])("advertises reconnectToken and its alias consistently (running: %s)", async start => {
    h = await startHarness({ start });
    const a = await h.connect();
    const join = (await a.client.listTools()).tools.find(tool => tool.name === "join")!;
    expect(join.description).toContain("reconnectToken (token is an alias)");
    expect(Object.keys(join.inputSchema.properties!)).toEqual(["reconnectToken", "token", "displayName", "modelLabel", "thinkingLevel", "colony"]);
    const joined = await a.call("join");
    for (const text of [joined.data.briefing, (await a.call("rules")).data.rules]) {
      expect(text).toContain("join {reconnectToken}; token is an alias");
      expect(text).not.toContain("token reconnect");
    }
  });

  for (const start of [true, false]) {
    it.each(["reconnectToken", "token"])("%s rejoins a held seat from new and other-bound sessions even when full (running: " + start + ")", async name => {
      h = await startHarness({ start, mcpConfig: { ...TEST_MCP_CONFIG, maxAgentsPerMatch: 2 } });
      const target = await joinAs(h);
      const other = await joinAs(h);
      const extra = await h.connect();
      expect((await extra.call("join")).data.error.code).toBe("agent_cap");
      for (const caller of [extra, other.agent, target.agent]) {
        const back = await caller.call("join", { [name]: target.data.reconnectToken });
        expect(back.isError, back.text).toBe(false);
        expect(back.data.agentId).toBe(target.data.agentId);
        expect(back.data.reconnectToken).toBe(target.data.reconnectToken);
      }
      expect(start ? h.game.match!.state.agents.length : h.game.queuedAgents).toBe(2);
      if (start) expect((await other.agent.call("observe")).data.view.agentId).toBe(target.data.agentId);
    });
  }

  it("accepts matching aliases and refuses conflicting or wrong-typed aliases without creating seats", async () => {
    h = await startHarness();
    const target = await joinAs(h);
    const caller = await h.connect();
    const matching = await caller.call("join", { reconnectToken: target.data.reconnectToken, token: target.data.reconnectToken });
    expect(matching.isError, matching.text).toBe(false);
    expect(matching.data.agentId).toBe(target.data.agentId);
    const cases = [
      { reconnectToken: target.data.reconnectToken, token: "different" },
      { reconnectToken: 123 }, { token: null },
      { reconnectToken: null, token: target.data.reconnectToken },
      { reconnectToken: target.data.reconnectToken, token: 123 },
    ];
    for (const args of cases) {
      const reply = await caller.call("join", args);
      expect(reply.isError, reply.text).toBe(true);
      expect(reply.data.error.code).toBe("bad_arguments");
    }
    expect(h.game.match!.state.agents).toHaveLength(1);
    expect((await caller.call("observe")).data.view.agentId).toBe(target.data.agentId);
  });

  it.each([true, false])("refuses every ordinary unknown name in message and howToFix before fresh or token joins (running: %s)", async start => {
    h = await startHarness({ start });
    const target = await joinAs(h);
    const stranger = await h.connect();
    const names = ["reconnect_token", "extra", "constructor", "odd\"name", "nested.path", "🌱"];
    const unknown = Object.fromEntries(names.map(name => [name, { arbitrary: null }]));
    for (const caller of [stranger, target.agent]) {
      for (const args of [unknown, { ...unknown, reconnectToken: target.data.reconnectToken }]) {
        const before = start ? h.game.match!.state.agents.length : h.game.queuedAgents;
        const reply = await caller.call("join", args);
        expect(reply.isError, reply.text).toBe(true);
        expect(reply.data.error.code).toBe("bad_arguments");
        for (const field of [reply.data.error.message, reply.data.error.howToFix]) {
          for (const name of names) expect(field).toContain(JSON.stringify(name));
          expect(field).not.toContain("names omitted");
        }
        expect(start ? h.game.match!.state.agents.length : h.game.queuedAgents).toBe(before);
      }
    }
    expect((await stranger.call("observe")).data.error.code).toBe("not_joined");
    expect(h.inputsOf(target.data.agentId).filter(input => input.type === "join")).toHaveLength(start ? 1 : 0);
  });

  it("keeps rate-limit admission on malformed bound-session joins", async () => {
    h = await startHarness({ mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 1 } });
    const target = await joinAs(h);
    const refused = await target.agent.call("join", { misspelled: true });
    expect(refused.data.error.code).toBe("call_rate");
    h.clock.now += 1000;
    const admitted = await target.agent.call("join", { misspelled: true });
    expect(admitted.data.error.code).toBe("bad_arguments");
    expect(admitted.data.error.howToFix).toContain('"misspelled"');
    expect(h.inputsOf(target.data.agentId).at(-1)?.type).toBe("observe");
    expect(h.game.match!.state.agents).toHaveLength(1);
  });
});

// A slot server seats only its lobby's identities, by key, with no reconnect token.
describe("slot server joins", () => {
  /** assigned: each identity's lobby holding this slot in the store, which this server may not have seated yet. */
  type Rig = { game: Game; assigned: Map<string, string>; connect(): Promise<TestAgent>; advance(n: number): void; close(): Promise<void> };
  let rig: Rig | null = null;
  afterEach(async () => {
    await rig?.close();
    rig = null;
  });

  const KEYS: Record<string, string> = { "key-ann": "ann", "key-bob": "bob", "key-cat": "cat" };
  const seats = [
    { identityId: "ann", displayName: "Ann", colony: 1 as const },
    { identityId: "bob", displayName: "Bob", colony: 0 as const },
  ];
  const ADDRESS = { slot: "public-0", mcpUrl: "http://b.test/mcp", spectatorUrl: "http://b.test/" };

  async function startSlotRig(callsPerSecond = TEST_MCP_CONFIG.callsPerSecond): Promise<Rig> {
    const { createServer } = await import("node:http");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { createMcpHandler } = await import("../../src/mcp/http.js");
    let scheduled = false;
    const assigned = new Map<string, string>();
    const game: Game = new Game({
      simConfig: playable(TEST_CONFIG),
      mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond },
      now: () => 0,
      onInputQueued: () => {
        if (scheduled) return;
        scheduled = true;
        setImmediate(() => { scheduled = false; game.tick(); });
      },
      slot: {
        identityOf: async (key) => KEYS[key],
        locate: async (lobbyId) => (lobbyId === "lobby-1" ? ADDRESS : undefined),
        assignedLobby: async (identityId) => assigned.get(identityId),
      },
    });
    const handler = createMcpHandler(game, { now: () => 0 });
    const server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    const clients: InstanceType<typeof Client>[] = [];
    return {
      game,
      assigned,
      async connect() {
        const client = new Client({ name: "slot-test", version: "0" });
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
        clients.push(client);
        return {
          client, transport,
          async call(name, args = {}) {
            const r = await client.callTool({ name, arguments: args });
            const text = (r.content as { text?: string }[])[0]?.text ?? "";
            return { isError: r.isError === true, text, data: r.structuredContent };
          },
          async end() { await client.close(); },
        };
      },
      advance(n) { for (let i = 0; i < n; i++) game.tick(); },
      async close() {
        for (const c of clients) await c.close();
        await handler.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const colonyOf = (game: Game, agentId: string) => game.match!.state.agents.find((a) => a.id === agentId)?.colony;

  it("accepts levels on queued and live lobby joins, retaining the first level on rejoin", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    const ann = await (await rig.connect()).call("join", { key: "key-ann", modelLabel: "same-model", thinkingLevel: "high" });
    expect(ann.isError, ann.text).toBe(false);
    rig.game.startMatch(1); rig.advance(1);
    const bob = await (await rig.connect()).call("join", { key: "key-bob", modelLabel: "same-model", thinkingLevel: "low" });
    expect(bob.isError, bob.text).toBe(false);
    const again = await (await rig.connect()).call("join", { key: "key-ann", thinkingLevel: "max" });
    expect(again.data.agentId).toBe(ann.data.agentId);
    expect(rig.game.match!.state.agents.map(agent => agent.thinkingLevel)).toEqual(["high", "low"]);
  });

  it("carries each lobby seat's join service tier into the sim, absent when not given, the first tier kept on rejoin", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    const ann = await (await rig.connect()).call("join", { key: "key-ann", modelLabel: "same-model", serviceTier: "fast" });
    expect(ann.isError, ann.text).toBe(false);
    rig.game.startMatch(1); rig.advance(1);
    const bob = await (await rig.connect()).call("join", { key: "key-bob", modelLabel: "same-model" });
    expect(bob.isError, bob.text).toBe(false);
    const again = await (await rig.connect()).call("join", { key: "key-ann", serviceTier: "default" });
    expect(again.data.agentId).toBe(ann.data.agentId);
    expect(rig.game.match!.state.agents.map(agent => agent.serviceTier ?? null)).toEqual(["fast", null]);
    expect(rig.game.match!.state.agents[1]).not.toHaveProperty("serviceTier");
  });

  it("validates lobby thinking levels before seating, including their type", async () => {
    rig = await startSlotRig(); rig.game.seatLobby("lobby-1", seats);
    for (const thinkingLevel of ["", " ", "x".repeat(33), "bell\u0007", 5, true, {}, [], null]) {
      const result = await (await rig.connect()).call("join", { key: "key-ann", thinkingLevel });
      expect(result.isError).toBe(true);
      expect(result.data.error.message).toContain(typeof thinkingLevel === "string" ? "thinking level" : "thinkingLevel");
    }
    expect(rig.game.queuedAgents).toBe(0);
  });

  it("seats a lobby identity by key on its lobby colony, and the same key returns it to its seat", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    const ann = await rig.connect();
    const queued = await ann.call("join", { key: "key-ann" });
    expect(queued.isError, queued.text).toBe(false);
    expect(queued.data).not.toHaveProperty("reconnectToken");
    expect(queued.data.matchStarts).toBeDefined();
    rig.game.startMatch(1);
    rig.advance(1);
    expect(colonyOf(rig.game, queued.data.agentId)).toBe(1);
    const bob = await rig.connect();
    const live = await bob.call("join", { key: "key-bob" });
    expect(live.isError, live.text).toBe(false);
    // An unrated lobby: its colonies carry the names it drew from its lobby id.
    expect(live.data.colony).toBe(drawColonyNames("lobby-1")[0]);
    expect(live.data).not.toHaveProperty("reconnectToken");
    // A new session presenting the same key is the same seat.
    const again = await rig.connect();
    const rejoined = await again.call("join", { key: "key-ann" });
    expect(rejoined.isError, rejoined.text).toBe(false);
    expect(rejoined.data.agentId).toBe(queued.data.agentId);
    expect(rejoined.data.colony).toBe(drawColonyNames("lobby-1")[1]);
    expect(rig.game.match!.state.agents).toHaveLength(2);
  });

  it("names an unrated lobby's colonies by its drawn pair in join, observe and rules, and a rated lobby's by the rated names", async () => {
    const drawn = drawColonyNames("lobby-1");
    for (const [mode, names] of [[null, drawn], ["1v1", COLONY_NAMES]] as const) {
      rig = await startSlotRig();
      rig.game.seatLobby("lobby-1", seats, mode);
      const ann = await rig.connect(), bob = await rig.connect();
      const unjoinedRules: string = (await (await rig.connect()).call("rules")).data.rules;
      for (const name of names) expect(unjoinedRules).toContain(name);
      expect((await ann.call("join", { key: "key-ann" })).isError).toBe(false);
      rig.game.startMatch(1);
      rig.advance(1);
      const joined = await bob.call("join", { key: "key-bob" });
      expect(joined.data.colony).toBe(names[0]);
      const view = (await ann.call("observe")).data.view;
      expect(view.colonyName).toBe(names[1]);
      const rules: string = (await ann.call("rules")).data.rules;
      for (const name of names) expect(rules).toContain(name);
      for (const name of drawn) if (mode !== null && !(COLONY_NAMES as readonly string[]).includes(name)) expect(rules).not.toContain(name);
      await rig.close();
      rig = null;
    }
  });

  it("refuses a keyless join, an unseated or unknown key, and token, reconnectToken or colony by name", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const agent = await rig.connect();
    expect((await agent.call("join")).data.error.code).toBe("key_required");
    expect((await agent.call("join", { displayName: "x" })).data.error.code).toBe("bad_arguments");
    for (const key of ["key-cat", "not-a-key"]) expect((await agent.call("join", { key })).data.error.code).toBe("not_seated");
    for (const field of ["token", "reconnectToken", "colony"]) {
      const refused = await agent.call("join", { key: "key-ann", [field]: field === "colony" ? VLC : "anything" });
      expect(refused.data.error.code).toBe("bad_arguments");
      expect(refused.data.error.message).toContain(field);
    }
    expect(rig.game.match!.state.agents).toHaveLength(0);
    const listed = (await agent.client.listTools()).tools;
    const join = listed.find((tool) => tool.name === "join")!;
    expect(Object.keys(join.inputSchema.properties ?? {}).sort()).toEqual(["key", "modelLabel", "seat", "serviceTier", "thinkingLevel"]);
  });

  // Slot join refusal text, pinned byte for byte, so deriving its fields from its schema changes no reply.
  it("keeps its wrong-type, unknown-field and refused-field text and its advertised schema", async () => {
    rig = await startSlotRig(); rig.game.seatLobby("lobby-1", seats);
    const agent = await rig.connect();
    const wrong = await agent.call("join", { key: 1, seat: "2", modelLabel: 3, thinkingLevel: 4, serviceTier: 5 });
    expect(wrong.data.error).toEqual({
      code: "bad_arguments",
      message: "key must be a value of the advertised type. seat must be a value of the advertised type. modelLabel must be a string. thinkingLevel must be a string. serviceTier must be a string.",
      howToFix: "Resend the call with these fields corrected.",
    });
    const unknown = await agent.call("join", { key: "key-ann", bogus: 1, displayName: "Ann" });
    expect(unknown.data.error).toEqual({
      code: "bad_arguments",
      message: 'Unknown join arguments: "bogus", "displayName".',
      howToFix: "Join with key, and optionally seat, modelLabel, thinkingLevel and serviceTier.",
    });
    const refused = await agent.call("join", { key: "key-ann", token: "x", colony: VLC });
    expect(refused.data.error).toEqual({
      code: "bad_arguments",
      message: "This server does not accept token, colony.",
      howToFix: "Join with key (and seat, when your key holds several seats): your seats and colony come from your lobby, and joining again with the same key and seat returns you to that seat.",
    });
    const join = (await agent.client.listTools()).tools.find((tool) => tool.name === "join")!;
    expect(join.inputSchema).toMatchInlineSnapshot(`
      {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": {},
        "properties": {
          "key": {
            "default": null,
            "description": "The same username or handle key used to take your lobby seat; not an invite token.",
            "type": "string",
          },
          "modelLabel": {
            "default": null,
            "description": "Optional self-reported model label, shown to spectators.",
            "type": "string",
          },
          "seat": {
            "default": null,
            "description": "Which of your key's seats this session plays, 1 to N, when the key holds N > 1 seats (ranked 2v2 to 4v4); required then, one session per seat. Leave out, or send 1, for a single seat.",
            "type": "number",
          },
          "serviceTier": {
            "default": null,
            "description": "Optional self-reported service tier, for example fast, 1 to 32 printable characters; recorded with your seat, never inferred.",
            "type": "string",
          },
          "thinkingLevel": {
            "default": null,
            "description": "Optional self-reported thinking level, 1 to 32 printable characters; recorded with your seat, never inferred.",
            "type": "string",
          },
        },
        "type": "object",
      }
    `);
  });

  it("gives one identity a fresh seat in each consecutive lobby on one slot, never its ended one", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const agent = await rig.connect();
    const first = await agent.call("join", { key: "key-ann" });
    rig.game.tick(true);
    expect(rig.game.match!.result).not.toBeNull();
    rig.game.seatLobby("lobby-2", seats);
    const fresh = await rig.connect();
    const second = await fresh.call("join", { key: "key-ann" });
    expect(second.isError, second.text).toBe(false);
    expect(second.data.agentId).not.toBe(first.data.agentId);
    expect(second.data.matchStarts).toBeDefined();
    rig.game.startMatch(2);
    rig.advance(1);
    expect(rig.game.status(second.data.agentId)).toBe("live");
  });

  it.each([false, true])("binds a rate-limited key rejoin only when its slot match has ended (ended: %s)", async ended => {
    rig = await startSlotRig(1);
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const first = await (await rig.connect()).call("join", { key: "key-ann" });
    expect(first.isError, first.text).toBe(false);
    if (ended) rig.game.tick(true);
    const tick = rig.game.match!.state.tick;
    expect(rig.game.status(first.data.agentId)).toBe(ended ? "ended" : "live");

    // The rig's clock stays at zero: the original join still occupies the one-call window.
    const again = await rig.connect();
    const rejoined = await again.call("join", { key: "key-ann" });
    expect(rejoined.isError).toBe(true);
    expect(rejoined.data.error.code).toBe("call_rate");
    const observed = await again.call("observe");
    expect(observed.data.error.code).toBe(ended ? "call_rate" : "not_joined");
    if (ended) {
      expect(observed.data.winner).toBe(rejoined.data.winner);
      expect(observed.data.winner).not.toBeUndefined();
    }
    expect(rig.game.match!.state.tick).toBe(tick);
    expect(rig.game.match!.state.agents).toHaveLength(1);
  });

  const catSeat = [{ identityId: "cat", displayName: "Cat", colony: 0 as const }];

  it("names an ended seat's result by its own match's colonies after the next lobby is seated, with or without its record", async () => {
    rig = await startSlotRig(1);
    rig.game.seatLobby("lobby-1", seats, "1v1");
    rig.game.startMatch(1);
    const first = await (await rig.connect()).call("join", { key: "key-ann" });
    rig.game.tick(true);
    rig.game.seatLobby("lobby-2", catSeat);
    expect(rig.game.colonyNames()).toEqual(drawColonyNames("lobby-2"));
    // A viewless rate-limited call by the ended rated seat names its result by the rated names.
    const refused = await rig.game.call(first.data.agentId, { type: "observe", agentId: first.data.agentId });
    expect(refused).toMatchObject({ kind: "error", code: "call_rate", colonyNames: COLONY_NAMES });
    expect(rig.game.colonyNames(first.data.agentId)).toBe(COLONY_NAMES);
    // The receipt its session keeps carries the names too, so they outlive the record.
    expect(rig.game.finalResultReceipt(first.data.agentId)!.colonyNames).toBe(COLONY_NAMES);
  });

  it("decides a lobby's names once: its handover save carries them, and an older save without them keeps what its stream began with", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const ann = await (await rig.connect()).call("join", { key: "key-ann" });
    rig.advance(1);
    const save = rig.game.saveMatch();
    if (save.phase !== "match") throw new Error("expected a match save");
    expect(save.lobby!.colonyNames).toEqual(drawColonyNames("lobby-1"));
    expect(save.records.every(record => !("colonyNames" in record.finalResult))).toBe(true);
    const resumed = (from: typeof save) => {
      const game = new Game({ simConfig: playable(TEST_CONFIG), mcpConfig: TEST_MCP_CONFIG, now: () => 0, slot: { identityOf: async () => undefined, locate: async () => undefined } });
      game.resumeMatch(from);
      return game;
    };
    expect(resumed(save).colonyNames(ann.data.agentId)).toEqual(drawColonyNames("lobby-1"));
    // An older server's save of a running match has no names: its spectator stream began on the rated names, so do its agents.
    const { colonyNames: _names, ...olderLobby } = save.lobby!;
    expect(resumed({ ...save, lobby: olderLobby }).colonyNames(ann.data.agentId)).toBe(COLONY_NAMES);
    // A rated lobby's save leaves its names implicit.
    rig.game.seatLobby("lobby-r", catSeat, "1v1");
    expect(rig.game.colonyNames()).toBe(COLONY_NAMES);
  });

  it("states an unrated lobby's drawn names in its queued and live join briefings, and nothing new in a rated one", async () => {
    for (const [mode, line] of [[null, `This match's colonies: ${drawColonyNames("lobby-1").join(" (colony 0) and ")} (colony 1).`], ["1v1", null]] as const) {
      rig = await startSlotRig();
      rig.game.seatLobby("lobby-1", seats, mode);
      const queued = await (await rig.connect()).call("join", { key: "key-ann" });
      rig.game.startMatch(1);
      rig.advance(1);
      const live = await (await rig.connect()).call("join", { key: "key-bob" });
      for (const briefing of [queued.data.briefing as string, live.data.briefing as string]) {
        if (line === null) expect(briefing).not.toContain("This match's colonies");
        else expect(briefing.split("\n")).toContain(line);
      }
      await rig.close();
      rig = null;
    }
  });

  // Slot refusals name key, seat and a new lobby, never the root server's reconnectToken.
  it("tells an unjoined or ended slot session to use its key and a new lobby, never reconnectToken", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    const early = await (await rig.connect()).call("observe");
    expect(early.data.error.code).toBe("not_joined");
    expect(early.data.error.howToFix).toContain("Call join first with your seated key");
    expect(early.data.error.howToFix).not.toContain("reconnectToken");
    rig.game.startMatch(1);
    await (await rig.connect()).call("join", { key: "key-ann" });
    rig.game.tick(true);
    const over = await (await rig.connect()).call("join", { key: "key-bob" });
    expect(over.data.error.code).toBe("match_over");
    expect(over.data.error.howToFix).toContain("Join a new lobby at the entry point (list_lobbies and join_lobby, or join_queue), then locate_match");
    expect(over.data.error.howToFix).not.toContain("reconnectToken");
  });

  it("answers a first join after its lobby's match ended with that result, and never queues it into the next lobby's match", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    await (await rig.connect()).call("join", { key: "key-ann" });
    rig.game.tick(true);
    expect(rig.game.match!.result).not.toBeNull();
    // Bob was seated in lobby-1 but never connected; its match is over.
    const bob = await rig.connect();
    expect((await bob.call("join", { key: "key-bob" })).data.error.code).toBe("match_over");
    rig.game.seatLobby("lobby-2", catSeat);
    const cat = await (await rig.connect()).call("join", { key: "key-cat" });
    rig.game.startMatch(2);
    rig.advance(1);
    expect(rig.game.match!.state.agents.map((a) => a.id)).toEqual([cat.data.agentId]);
    expect((await bob.call("join", { key: "key-bob" })).data.error.code).toBe("not_seated");
  });

  for (const how of ["failed to start", "lost its slot during the countdown"] as const) {
    it(`keeps a seat queued in a lobby whose match ${how} out of the next lobby's match, answered match_not_played`, async () => {
      rig = await startSlotRig();
      rig.game.seatLobby("lobby-1", seats);
      const ann = await rig.connect();
      const queued = await ann.call("join", { key: "key-ann" });
      expect(queued.data.matchStarts).toBeDefined();
      if (how === "failed to start") rig.game.endNotPlayed();
      rig.game.seatLobby("lobby-2", catSeat);
      const cat = await (await rig.connect()).call("join", { key: "key-cat" });
      rig.game.startMatch(1);
      rig.advance(1);
      expect(rig.game.match!.state.agents.map((a) => a.id)).toEqual([cat.data.agentId]);
        expect(rig.game.queuedLineup()).toEqual([]);
      for (const reply of [await ann.call("observe"), await ann.call("order", { kind: "hold" })]) expect(reply.data.error.code).toBe("match_not_played");
    });
  }

  it("answers every seat match_not_played with no winner once the match is not played, even after it reached a result", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const ann = await rig.connect();
    const joined = await ann.call("join", { key: "key-ann" });
    rig.game.tick(true);
    const before = await ann.call("observe");
    expect(before.data.winner).toBeDefined();
    rig.game.endNotPlayed();
    expect(rig.game.finalResultReceipt(joined.data.agentId)).toMatchObject({ notPlayed: true });
    for (const reply of [await ann.call("observe"), await ann.call("order", { kind: "hold" }), await (await rig.connect()).call("join", { key: "key-ann" })]) {
      expect(reply.data.error.code).toBe("match_not_played");
      expect(reply.data).not.toHaveProperty("winner");
      expect(reply.data).not.toHaveProperty("result");
    }
    // A seated identity that never connected learns the same.
    expect((await (await rig.connect()).call("join", { key: "key-bob" })).data.error.code).toBe("match_not_played");
  });

  it("answers a call waiting for the next tick match_not_played when its live match is abandoned", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    const ann = await rig.connect();
    const joined = await ann.call("join", { key: "key-ann" });
    const waiting = rig.game.call(joined.data.agentId, { type: "observe", agentId: joined.data.agentId });
    rig.game.endNotPlayed();
    expect(await waiting).toMatchObject({ kind: "error", code: "match_not_played" });
  });

  // A seated identity's join that arrives before this server has seated its assigned lobby.
  async function loading(agent: TestAgent, args: Record<string, unknown>): Promise<void> {
    const reply = await agent.call("join", args);
    expect(reply.isError).toBe(true);
    expect(reply.data.error.code, reply.text).toBe("lobby_loading");
    expect(reply.data.retryAfterMs).toBe(1000);
  }

  it.each(["nothing seated", "an earlier lobby without it seated"] as const)("asks an early join to retry with %s here, then seats the same key once its lobby is seated", async (before) => {
    rig = await startSlotRig();
    if (before !== "nothing seated") rig.game.seatLobby("lobby-0", catSeat);
    rig.assigned.set("ann", "lobby-1");
    const ann = await rig.connect();
    await loading(ann, { key: "key-ann" });
    expect(rig.game.queuedAgents).toBe(0);
    rig.game.seatLobby("lobby-1", seats);
    const joined = await ann.call("join", { key: "key-ann" });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.matchStarts).toBeDefined();
  });

  it.each(["still seated here", "replaced here by another lobby"] as const)("asks an identity of a not-played lobby (%s) to retry for its newly assigned lobby, never match_not_played", async (how) => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    const ann = await rig.connect();
    expect((await ann.call("join", { key: "key-ann" })).isError).toBe(false);
    rig.game.endNotPlayed();
    if (how === "replaced here by another lobby") rig.game.seatLobby("lobby-x", catSeat);
    rig.assigned.set("ann", "lobby-2");
    // Neither the session bound to its not-played seat nor a fresh one is told match_not_played.
    await loading(ann, { key: "key-ann" });
    await loading(await rig.connect(), { key: "key-ann" });
    // Bob, of the same not-played lobby but in no assigned lobby, still learns its outcome.
    expect((await (await rig.connect()).call("join", { key: "key-bob" })).data.error.code).toBe("match_not_played");
    rig.game.seatLobby("lobby-2", seats);
    const joined = await (await rig.connect()).call("join", { key: "key-ann" });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.matchStarts).toBeDefined();
  });

  it("asks identities of a played lobby to retry for their newly assigned lobby without spending the ended seat's calls", async () => {
    rig = await startSlotRig(2);
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    expect((await (await rig.connect()).call("join", { key: "key-ann" })).isError).toBe(false);
    rig.game.tick(true);
    expect(rig.game.match!.result).not.toBeNull();
    rig.assigned.set("ann", "lobby-2").set("bob", "lobby-2");
    await loading(await rig.connect(), { key: "key-ann" }); // instead of its ended seat's rejoin
    await loading(await rig.connect(), { key: "key-bob" }); // instead of a first join's match_over
    rig.assigned.clear();
    // The clock stays at zero: only the first join used Ann's two-call window, so this rejoin is admitted.
    const rejoined = await (await rig.connect()).call("join", { key: "key-ann" });
    expect(rejoined.data.error.code).toBe("match_over");
    expect(rejoined.data.winner).toBeDefined();
    expect((await (await rig.connect()).call("join", { key: "key-bob" })).data.error.code).toBe("match_over");
  });

  it("asks a key whose seat count changes in its newly assigned lobby to retry before any seat check", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.game.startMatch(1);
    expect((await (await rig.connect()).call("join", { key: "key-ann" })).isError).toBe(false);
    rig.game.tick(true);
    rig.assigned.set("ann", "lobby-2");
    // Against lobby-1's one seat, seat 2 would be no_such_seat.
    await loading(await rig.connect(), { key: "key-ann", seat: 2 });
    await loading(await rig.connect(), { key: "key-ann" });
    rig.game.seatLobby("lobby-2", [
      { identityId: "ann", displayName: "Ann", colony: 1, seat: 1 },
      { identityId: "ann", displayName: "Ann", colony: 1, seat: 2 },
      { identityId: "bob", displayName: "Bob", colony: 0 },
    ]);
    const joined = await (await rig.connect()).call("join", { key: "key-ann", seat: 2 });
    expect(joined.isError, joined.text).toBe(false);
    expect((await (await rig.connect()).call("join", { key: "key-ann" })).data.error.code).toBe("seat_required");
  });

  it("still answers not_seated to a key in no assigned lobby, and match_not_played while the slot holds that not-played lobby or nothing", async () => {
    rig = await startSlotRig();
    rig.game.seatLobby("lobby-1", seats);
    rig.assigned.set("ann", "lobby-2");
    expect((await (await rig.connect()).call("join", { key: "key-cat" })).data.error.code).toBe("not_seated");
    rig.game.endNotPlayed();
    // A failed start not yet released: the slot still holds the not-played lobby itself.
    rig.assigned.set("ann", "lobby-1");
    expect((await (await rig.connect()).call("join", { key: "key-ann" })).data.error.code).toBe("match_not_played");
    rig.assigned.clear();
    expect((await (await rig.connect()).call("join", { key: "key-ann" })).data.error.code).toBe("match_not_played");
  });

  it("locates a lobby's match with only its slot and addresses, and keeps the local join schema without locate_match", async () => {
    rig = await startSlotRig();
    const agent = await rig.connect();
    expect((await agent.call("locate_match", { lobbyId: "lobby-1" })).data).toEqual(ADDRESS);
    expect((await agent.call("locate_match", { lobbyId: "lobby-9" })).data.error.code).toBe("no_such_lobby");
    h = await startHarness();
    const local = await h.connect();
    const tools = (await local.client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).not.toContain("locate_match");
    const join = tools.find((tool) => tool.name === "join")!;
    expect(Object.keys(join.inputSchema.properties ?? {}).sort()).toEqual(["colony", "displayName", "modelLabel", "reconnectToken", "thinkingLevel", "token"]);
  });
});
