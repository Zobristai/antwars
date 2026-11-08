import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import type { QueenState, SimInput } from "../../src/sim/types.js";
import { queenBroodText, queenSpawnOwnerText } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../src/mcp/config.js";
import { MAX_REPLY_BYTES, MAX_TEXT_CHARS } from "../../src/mcp/replies.js";
import { startHarness, TEST_MCP_CONFIG, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

/**
 * The rules-27 set_brood tool. Queen owners are set
 * directly on the live match's queens. The call
 * limit is the adapter's existing per-agent sliding-second limit.
 */
const RULES_27: SimConfig = playable(rulesConfig("redesign"));

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setBrood(agent: TestAgent, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: any }> {
  const reply = await agent.client.callTool({ name: "set_brood", arguments: args }) as CallToolResult;
  const text = (reply.content[0] as { text: string }).text;
  // Every set_brood reply stays within the command reply limits: characters of its text,
  // bytes of the complete tool result (both copies).
  expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(MAX_REPLY_BYTES);
  expect(JSON.parse(text)).toEqual(reply.structuredContent);
  return { isError: reply.isError === true, text, data: reply.structuredContent };
}

async function seat(config: SimConfig, mcpConfig: McpConfig = TEST_MCP_CONFIG): Promise<{ a: TestAgent; aId: string; b: TestAgent; bId: string }> {
  h = await startHarness({ simConfig: config, mcpConfig });
  const a = await h.connect();
  const b = await h.connect();
  const ja = await a.call("join", { colony: "Very Large Colony" });
  const jb = await b.call("join", { colony: "Very Large Colony" });
  expect(ja.isError, ja.text).toBe(false);
  expect(jb.isError, jb.text).toBe(false);
  return { a, aId: ja.data.agentId as string, b, bId: jb.data.agentId as string };
}

const homeQueen = (id = 0): QueenState => h!.game.match!.state.colonies[0]!.queens!.find((q) => q.id === id)!;
const setBroodInputs = (agentId: string): SimInput[] => h!.inputsOf(agentId).filter((input) => input.type === "set_brood");

describe("rules-27 set_brood tool", () => {
  it("is listed only in rules 27, naming its choices, the call limit, queen ownership and the owner-only spawn point", async () => {
    await seat(RULES_27, { ...TEST_MCP_CONFIG, callsPerSecond: DEFAULT_MCP_CONFIG.callsPerSecond });
    const tool = (await (await h!.connect()).client.listTools()).tools.find((t) => t.name === "set_brood")!;
    expect(tool).toBeDefined();
    const brood = queenBroodText(RULES_27, DEFAULT_MCP_CONFIG.callsPerSecond);
    expect(brood).toBe(`Each agent owns its queens and sets each one's brood with set_brood: workers, soldiers or mixed (alternates per queen; unset breeds mixed), queenId only if you own more than one; there is no colony vote. A newly founded queen breeds mixed until her owner calls set_brood for her. set_brood counts toward the ${DEFAULT_MCP_CONFIG.callsPerSecond}-calls-per-second limit, not the command allowance.`);
    expect(tool.description).toContain(brood);
    expect(tool.description).toContain("set_brood counts toward the 2-calls-per-second limit, not the command allowance.");
    expect(tool.description).toContain(queenSpawnOwnerText(RULES_27));
    expect(queenSpawnOwnerText(RULES_27)).toBe("Only a queen's owner sets, moves or clears her spawn point.");
    expect(tool.description).toContain("it neither waits for nor moves nextCommandTick");
    const schema = tool.inputSchema as { properties: Record<string, { enum?: string[]; type?: string }>; required?: string[] };
    expect(schema.properties.brood?.enum).toEqual(["workers", "soldiers", "mixed"]);
    expect(schema.properties.queenId?.type).toBe("number");
    expect(schema.required).toEqual(["brood"]);
  });

  it("sets the brood of the caller's own queen and replies with tick, accepted, the queen and brood set and an unchanged nextCommandTick", async () => {
    const { a, aId } = await seat(RULES_27);
    homeQueen().owner = aId;
    const order = await a.call("order", { kind: "hold" });
    expect(order.isError, order.text).toBe(false);
    const nextCommandTick = order.data.nextCommandTick as number;
    const lastCommandTick = h!.game.match!.state.agents.find((agent) => agent.id === aId)!.lastCommandTick;
    const set = await setBrood(a, { brood: "soldiers" });
    expect(set.isError, set.text).toBe(false);
    expect(set.data).toEqual({ tick: expect.any(Number), accepted: true, nextCommandTick, queenId: 0, brood: "soldiers" });
    expect(set.data.tick).toBeLessThan(nextCommandTick);
    expect(homeQueen().brood).toBe("soldiers");
    const again = await setBrood(a, { brood: "mixed", queenId: 0 });
    expect(again.data).toMatchObject({ accepted: true, nextCommandTick, queenId: 0, brood: "mixed" });
    expect(homeQueen().brood).toBe("mixed");
    // Recorded as match inputs, exactly as sent.
    expect(setBroodInputs(aId)).toEqual([{ type: "set_brood", agentId: aId, brood: "soldiers" }, { type: "set_brood", agentId: aId, brood: "mixed", queenId: 0 }]);
    // The shared command floor is untouched: the next order is still refused until the same tick.
    expect(h!.game.match!.state.agents.find((agent) => agent.id === aId)!.lastCommandTick).toBe(lastCommandTick);
    const early = await a.call("order", { kind: "forage" });
    expect(early.data.error.code).toBe("rate_limited");
    expect(early.data.nextCommandTick).toBe(nextCommandTick);
    expect((await a.call("observe")).data.view.nextCommandTick).toBe(nextCommandTick);
  });

  it("refuses a queen the caller does not own, a caller owning none with a reply naming found_queen, a bad brood and an ambiguous call", async () => {
    const { a, aId, b } = await seat(RULES_27);
    homeQueen().owner = aId;
    const none = await setBrood(b, { brood: "workers" });
    expect(none.isError).toBe(true);
    expect(none.data.error.code).toBe("no_owned_queen");
    expect(none.data.error.message).toBe("You own no live queen, so there is no brood to set. Found one with found_queen.");
    expect(none.data.error.howToFix).toContain("found_queen");
    expect(none.data).toHaveProperty("nextCommandTick");
    const teammates = await setBrood(b, { brood: "workers", queenId: 0 });
    expect(teammates.data.error.code).toBe("no_owned_queen");
    expect(homeQueen().brood).toBeUndefined();
    const bad = await setBrood(a, { brood: "drones" });
    expect(bad.data.error).toMatchObject({ code: "bad_arguments", message: "brood must be one of workers, soldiers, mixed." });
    const missing = await setBrood(a, {});
    expect(missing.data.error).toMatchObject({ code: "bad_arguments", message: "brood must be one of workers, soldiers, mixed." });
    const state = h!.game.match!.state;
    state.colonies[0]!.queens!.push({ ...homeQueen(), id: 5 });
    const ambiguous = await setBrood(a, { brood: "soldiers" });
    expect(ambiguous.data.error).toMatchObject({ code: "bad_brood", message: "You own 2 live queens (queenId 0, 5); send queenId to choose one." });
    expect(ambiguous.data.error.howToFix).toContain("queenId when you own more than one live queen");
    expect(homeQueen().brood).toBeUndefined();
    expect((await setBrood(a, { brood: "soldiers", queenId: 5 })).data).toMatchObject({ accepted: true, queenId: 5, brood: "soldiers" });
    expect(homeQueen(5).brood).toBe("soldiers");
    expect(homeQueen().brood).toBeUndefined();
  });

  it("is refused over the existing adapter call limit, before the sim, leaving brood and the command tick unchanged", async () => {
    const { a, aId } = await seat(RULES_27, { ...TEST_MCP_CONFIG, callsPerSecond: 2 });
    homeQueen().owner = aId;
    h!.clock.now += 1000;
    expect((await setBrood(a, { brood: "workers" })).isError).toBe(false);
    expect((await setBrood(a, { brood: "soldiers" })).isError).toBe(false);
    const logged = h!.inputsOf(aId).length;
    const tick = h!.game.match!.state.tick;
    const refused = await setBrood(a, { brood: "mixed" });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe("call_rate");
    expect(refused.text).toContain("2 calls per second");
    expect(refused.data.retryAfterMs).toBe(1000);
    expect(refused.data.nextCommandTick).toBe(tick);
    expect(h!.inputsOf(aId).length).toBe(logged);
    expect(homeQueen().brood).toBe("soldiers");
    h!.clock.now += 1000;
    expect((await setBrood(a, { brood: "mixed" })).data).toMatchObject({ accepted: true, brood: "mixed" });
  });
});
