import { afterEach, describe, expect, it } from "vitest";
import { observeInfo } from "../../src/mcp/game.js";
import { ruleSections } from "../../web/rules.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { lineMarksEnabled } from "../../src/sim/patrol.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

// Under rules 27, observe's status[1] names mark only where the mark tool
// exists and names set_brood on the house-activity timer; count_mark's description and /rules state
// that a re-lay keeps the original lifetime.
const RULES_27: SimConfig = playable(rulesConfig("redesign"));
const { wordMarksDisabled: _words, ...RULES_27_WORDS } = RULES_27;
const { castes: _castes, ...RULES_27_NO_CASTES } = RULES_27;

const RELAY_LINE = "A re-lay keeps the lifetime from when the mark was first laid; for LINE the two ends must match in the same order. A different verb, tile or ends makes a new mark with its own lifetime.";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

async function seated(config: SimConfig) {
  h = await startHarness({ simConfig: config });
  const agent = await h.connect();
  const joined = await agent.call("join");
  expect(joined.isError).toBe(false);
  const tool = (await agent.client.listTools()).tools.find(t => t.name === "count_mark")!;
  return { status: h.game.observeInfoForAgent(joined.data.agentId).status, description: tool.description!, names: (await agent.client.listTools()).tools.map(t => t.name) };
}

const relayLine = (config: SimConfig) => ruleSections(config).flatMap(section => section.lines).find(line => line.startsWith("Re-lay the same verb"))!;

describe("rules-27 observe status names", () => {
  it("the command-idle list drops mark where word marks are disabled and never names set_brood", () => {
    expect(RULES_27.commandIdleTicks).toBeDefined();
    expect(observeInfo(null, "", RULES_27).status[1]).toBe("order count_mark found_queen");
    expect(observeInfo(null, "", RULES_27_WORDS).status[1]).toBe("order mark count_mark found_queen");
  });

  it("a seated rules-27 caller's house-activity list names set_brood and only registered tools", async () => {
    const r27 = await seated(RULES_27);
    expect(r27.names).toContain("set_brood");
    expect(r27.names).not.toContain("mark");
    expect(r27.status[1]).toBe("order count_mark found_queen set_brood observe rules join");
    await h!.close(); h = undefined;
    const words = await seated(RULES_27_WORDS);
    expect(words.names).toContain("mark");
    expect(words.status[1]).toBe("order mark count_mark found_queen set_brood observe rules join");
    await h!.close(); h = undefined;
    const noCastes = await seated(RULES_27_NO_CASTES);
    expect(noCastes.names).not.toContain("set_brood");
    expect(noCastes.status[1]).toBe("order count_mark found_queen observe rules join");
  });

});

describe("rules-27 re-lay lifetime text", () => {
  it("count_mark's description and /rules state that a re-lay keeps the original lifetime", async () => {
    expect(lineMarksEnabled(RULES_27)).toBe(true);
    expect(relayLine(RULES_27)).toContain(`lowering it releases the farthest ants first. ${RELAY_LINE}`);
    const { description } = await seated(RULES_27);
    expect(description).toContain(`to change the count; claimed ants stay. ${RELAY_LINE}`);
    for (const text of [description, relayLine(RULES_27)]) expect(text).not.toMatch(/\breplaces?\b/i);
  });


});
