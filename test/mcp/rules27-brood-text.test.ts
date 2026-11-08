import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing, NEW_QUEEN_BROOD_TEXT, queenBroodText, queenSpawnOwnerText, SEAT_NOTICE_BRIEF, SEAT_NOTICE_TEXT } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { OBSERVE_REPLY_LIMITS, RULES_REPLY_LIMITS, type ReplyLimits } from "../../src/mcp/replies.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { renderRules, ruleSections } from "../../web/rules.js";
import { startHarness, type Harness, type TestAgent } from "./harness.js";

// In rules 27 the join and rules briefings, the found_queen and count_mark
// descriptions and the /rules page name set_brood, its choices and call limit, and state that each agent owns its
// queen and sets her brood with no colony vote; the found_queen description also states the owner-only spawn point.
// Rules 26 is the same grid-scale-2 redesign config without the rules27 flag.
const RULES_27: SimConfig = { ...newMatchConfig(rulesConfig("redesign")), rules27: true };
// The earlier colony-vote wording.
const COLONY_VOTE = /majority|One teammate sets the brood|order's brood|order brood|myBrood|brood_vote_lost|set vote|colony's brood/;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function tool(agent: TestAgent, name: string): Promise<string> {
  return (await agent.client.listTools()).tools.find(t => t.name === name)!.description!;
}

/** A real MCP reply measured as the plan's Reply sizes table does: characters of its text, bytes of the whole tool result. */
async function measured(agent: TestAgent, name: string, args: Record<string, unknown> = {}) {
  const result = await agent.client.callTool({ name, arguments: args }) as CallToolResult;
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
  return { data: result.structuredContent as Record<string, unknown>, isError: result.isError === true, chars: text.length, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

function within(sample: { chars: number; bytes: number }, limits: ReplyLimits, label: string): void {
  expect(sample.chars, label).toBeLessThanOrEqual(limits.textChars);
  expect(sample.bytes, label).toBeLessThanOrEqual(limits.bytes);
}

describe("rules-27 statement texts", () => {
  it("name set_brood, its choices and the call limit, ownership with no colony vote, and the owner-only spawn point", () => {
    const brood = queenBroodText(RULES_27, DEFAULT_MCP_CONFIG.callsPerSecond);
    expect(brood).toBe("Each agent owns its queens and sets each one's brood with set_brood: workers, soldiers or mixed (alternates per queen; unset breeds mixed), queenId only if you own more than one; there is no colony vote. A newly founded queen breeds mixed until her owner calls set_brood for her. set_brood counts toward the 2-calls-per-second limit, not the command allowance.");
    expect(brood).toHaveLength(360);
    expect(queenSpawnOwnerText(RULES_27)).toBe("Only a queen's owner sets, moves or clears her spawn point.");
    expect(queenSpawnOwnerText(RULES_27)).toHaveLength(59);
  });

  it("say a newly founded queen breeds mixed until her owner sets her brood on the join and rules briefings and the /rules page", () => {
    for (const context of [{ house: false }, { house: false, undrawn: true }, { house: true }]) {
      expect(briefing(RULES_27, DEFAULT_MCP_CONFIG, context)).toContain(NEW_QUEEN_BROOD_TEXT);
      for (const nestWindow of [false, true]) expect(joinBriefing(RULES_27, DEFAULT_MCP_CONFIG, nestWindow, context)).toContain(NEW_QUEEN_BROOD_TEXT);
    }
    for (const undrawn of [false, true]) {
      expect(ruleSections(RULES_27, { undrawn }).find(section => section.title === "Food and hatching")!.lines.join("\n")).toContain(NEW_QUEEN_BROOD_TEXT);
    }
  });

  it("drop brood_vote_lost from the seat notices", () => {
    for (const text of [SEAT_NOTICE_TEXT, SEAT_NOTICE_BRIEF]) {
      expect(text).toContain("squad_replaced");
      expect(text).not.toMatch(COLONY_VOTE);
    }
  });
});

describe("rules 27: each surface carries its statements in place of the colony vote", () => {
  it("the rules and join briefings and the /rules page", () => {
    const brood = queenBroodText(RULES_27, DEFAULT_MCP_CONFIG.callsPerSecond);
    for (const context of [{ house: false }, { house: false, undrawn: true }, { house: true }]) {
      const rules = briefing(RULES_27, DEFAULT_MCP_CONFIG, context);
      // The caste line states costs and timing, then set_brood in place of the colony-vote sentences.
      expect(rules.split("\n").find(line => line.startsWith("- Castes:"))!.endsWith(` ${brood}`)).toBe(true);
      expect(rules).toContain(SEAT_NOTICE_TEXT);
      for (const nestWindow of [false, true]) {
        const join = joinBriefing(RULES_27, DEFAULT_MCP_CONFIG, nestWindow, context);
        expect(join.split("\n")).toContain(brood);
        expect(join).toContain(SEAT_NOTICE_BRIEF);
        expect(join).not.toMatch(COLONY_VOTE);
      }
      expect(rules).not.toMatch(COLONY_VOTE);
    }
    for (const undrawn of [false, true]) {
      const hatching = ruleSections(RULES_27, { undrawn }).find(section => section.title === "Food and hatching")!.lines.join("\n");
      expect(hatching).toContain(` ${brood}`);
      expect(hatching).not.toMatch(COLONY_VOTE);
    }
    expect(renderRules(RULES_27)).not.toMatch(COLONY_VOTE);
  });

  it("the found_queen, count_mark and observe descriptions and the real rules and join replies", async () => {
    h = await startHarness({ simConfig: RULES_27 });
    const agent = await h.connect();
    const brood = queenBroodText(RULES_27, h.game.mcpConfig.callsPerSecond);
    const foundQueen = await tool(agent, "found_queen");
    expect(foundQueen).toContain(brood);
    expect(foundQueen).toContain(queenSpawnOwnerText(RULES_27));
    expect(await tool(agent, "count_mark")).toContain(brood);
    const observe = await tool(agent, "observe");
    expect(observe).toContain(SEAT_NOTICE_TEXT);
    expect(observe).not.toMatch(COLONY_VOTE);
    const joined = await agent.call("join", { colony: "Very Large Colony" });
    expect(joined.isError, joined.text).toBe(false);
    expect((joined.data.briefing as string).split("\n")).toContain(brood);
    const rules = (await agent.call("rules")).data.rules as string;
    expect(rules).toContain(brood);
    expect(rules).not.toMatch(COLONY_VOTE);
  });
});


describe("rules 27: the rules and join replies stay within their limits", () => {
  it("rules before a map is drawn and join at match start (queued)", async () => {
    h = await startHarness({ simConfig: RULES_27, start: false });
    const unseated = await measured(await h.connect(), "rules");
    const agent = await h.connect();
    const join = await measured(agent, "join", { colony: "Very Large Colony" });
    expect(join.isError).toBe(false);
    expect(join.data).toHaveProperty("matchStarts");
    expect(join.data.briefing).toContain(queenBroodText(RULES_27, h.game.mcpConfig.callsPerSecond));
    const queued = await measured(agent, "rules");
    for (const [label, sample] of [["rules, unseated", unseated], ["rules, queued", queued]] as const) {
      expect(sample.isError).toBe(false);
      expect(sample.data.rules).toContain(queenBroodText(RULES_27, h.game.mcpConfig.callsPerSecond));
      within(sample, RULES_REPLY_LIMITS, label);
    }
    within(join, OBSERVE_REPLY_LIMITS, "join, queued");
    console.log(`rules-27 sizes: rules undrawn ${JSON.stringify([unseated.chars, unseated.bytes])} / queued ${JSON.stringify([queued.chars, queued.bytes])}; join at match start ${JSON.stringify([join.chars, join.bytes])}`);
  }, 30_000);

  it("rules with each drawn map", async () => {
    const drawn = new Map<string, number>();
    for (let seed = 1; seed <= 200 && drawn.size < RULES_27.terrain!.maps.length; seed++) {
      const mapId = createMatch(seed, RULES_27).terrain!.mapId;
      if (!drawn.has(mapId)) drawn.set(mapId, seed);
    }
    // The seed draws the grid-scale-2 boards, including both maps with their own board.
    expect([...drawn.keys()]).toEqual(expect.arrayContaining(["isthmus", "four-lanes", "wide-plain"]));
    const sizes: Record<string, [number, number]> = {};
    for (const [mapId, seed] of drawn) {
      h = await startHarness({ simConfig: RULES_27, seed });
      const agent = await h.connect();
      expect((await agent.call("join", { colony: "Very Large Colony" })).isError).toBe(false);
      const rules = await measured(agent, "rules");
      expect(rules.isError).toBe(false);
      expect(rules.data.rules).toContain(queenBroodText(RULES_27, h.game.mcpConfig.callsPerSecond));
      within(rules, RULES_REPLY_LIMITS, `rules, ${mapId}`);
      sizes[mapId] = [rules.chars, rules.bytes];
      await h.close();
      h = undefined;
    }
    console.log(`rules-27 drawn rules sizes: ${JSON.stringify(sizes)}`);
  }, 60_000);
});
