import { afterEach, describe, expect, it } from "vitest";
import { queenBroodText, queenSpawnOwnerText } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { DEFAULT_REPLY_LIMITS } from "../../src/mcp/replies.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

// In rules 27 the order tool carries no brood. Each queen's owner sets her
// brood with set_brood, so an order carrying brood or kind "brood" is refused with bad_arguments naming
// set_brood and its choices, and the order description states ownership, set_brood and the owner-only spawn point.
// The colony-vote wording replaced is the order brood field's.
const current = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1 };
// The redesign parses order passthrough (word marks retired); without that, the order schema is otherwise strict.
const { wordMarksDisabled: _passthrough, ...strict } = current;
const MODES: readonly [string, SimConfig][] = [["passthrough", current], ["strict", strict]];

const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())); });

async function joined(simConfig: SimConfig): Promise<{ h: Harness; agent: TestAgent; agentId: string }> {
  const h = await startHarness({ start: true, simConfig });
  harnesses.push(h);
  const agent = await h.connect();
  const join = await agent.call("join");
  expect(join.isError, join.text).toBe(false);
  return { h, agent, agentId: join.data.agentId };
}

async function orderTool(agent: TestAgent) {
  return (await agent.client.listTools()).tools.find(tool => tool.name === "order")!;
}

/** Characters are the reply's text; bytes the complete tool result with both copies. */
function size(reply: CallResult): { chars: number; bytes: number } {
  const result = { content: [{ type: "text", text: reply.text }], structuredContent: reply.data, ...(reply.isError ? { isError: true } : {}) };
  return { chars: reply.text.length, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

describe.each(MODES)("rules 27, %s order schema", (_mode, config) => {
  it("advertises no brood field and describes set_brood, ownership and the owner-only spawn point", async () => {
    const { h, agent } = await joined(config);
    const order = await orderTool(agent);
    expect(order.inputSchema.properties).not.toHaveProperty("brood");
    expect(order.inputSchema.properties!.kind).not.toMatchObject({ enum: expect.arrayContaining(["brood"]) });
    const brood = queenBroodText(config, DEFAULT_MCP_CONFIG.callsPerSecond);
    expect(brood).toContain("set_brood: workers, soldiers or mixed");
    expect(brood).toContain(`${DEFAULT_MCP_CONFIG.callsPerSecond}-calls-per-second limit`);
    expect(brood).toContain("Each agent owns its queens");
    expect(brood).toContain("there is no colony vote");
    // The description names the live adapter limit (the test harness raises it).
    expect(order.description).toContain(queenBroodText(config, h.game.mcpConfig.callsPerSecond));
    expect(order.description).toContain(queenSpawnOwnerText(config));
    expect(queenSpawnOwnerText(config)).toBe("Only a queen's owner sets, moves or clears her spawn point.");
    // The captured colony-vote wording (the order brood field's description) is gone.
    for (const captured of ["Your vote", "most of its seated agents voted", "keep your vote", "myBrood"]) expect(JSON.stringify(order)).not.toContain(captured);
  });

  it.each([
    { kind: "hold", brood: "soldiers" },
    { kind: "forage", brood: "workers", intent: "must not apply" },
    { kind: "hold", brood: "mixed" },
    { kind: "hold", brood: null },
    { kind: "hold", brood: "queens" },
    { kind: "brood" },
    { kind: "brood", brood: "soldiers" },
  ])("refuses %j with bad_arguments naming set_brood and its choices, changing nothing", async args => {
    const { h, agent, agentId } = await joined(config);
    const agentState = () => h.game.match!.state.agents.find(a => a.id === agentId)!;
    const before = JSON.stringify({ order: agentState().order, brood: agentState().brood, lastCommandTick: agentState().lastCommandTick });
    const reply = await agent.call("order", args);
    expect(reply.isError).toBe(true);
    expect(reply.data.error.code).toBe("bad_arguments");
    const text = `${reply.data.error.message} ${reply.data.error.howToFix}`;
    expect(text).toContain("set_brood");
    expect(text).toContain("workers, soldiers or mixed");
    expect(reply.data).toHaveProperty("nextCommandTick");
    expect(h.inputsOf(agentId).filter(input => input.type === "order")).toEqual([]);
    expect(JSON.stringify({ order: agentState().order, brood: agentState().brood, lastCommandTick: agentState().lastCommandTick })).toBe(before);
    const { chars, bytes } = size(reply);
    expect(chars).toBeLessThanOrEqual(DEFAULT_REPLY_LIMITS.textChars);
    expect(bytes).toBeLessThanOrEqual(DEFAULT_REPLY_LIMITS.bytes);
  });

  it("still accepts an order without brood, and refuses any other unknown kind as before", async () => {
    const { agent } = await joined(config);
    const accepted = await agent.call("order", { kind: "hold" });
    expect(accepted.isError, accepted.text).toBe(false);
    expect(accepted.data).toMatchObject({ accepted: true, order: { kind: "hold" } });
    expect(accepted.data).not.toHaveProperty("myBrood");
    const unknown = await agent.call("order", { kind: "queens" });
    expect(unknown.data.error.code).toBe("bad_arguments");
    expect(unknown.data.error.message).toMatch(/^kind must be one of /);
  });
});

it("rules 27 with an otherwise strict order schema still drops other unadvertised fields", async () => {
  const { agent } = await joined(strict);
  const reply = await agent.call("order", { kind: "hold", extra: null, nested: { field: null } });
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.data).toMatchObject({ accepted: true, order: { kind: "hold" } });
});

