import { expandCells } from "../../src/sim/view.js";
import { afterEach, describe, expect, it } from "vitest";
import { briefing, CASTES_LEAD, FOOD_RADIX_TEXT, SEAT_NOTICE_TEXT } from "../../src/mcp/briefing.js";
import { CASTE_RULES, COLONY_NAMES, type SimConfig } from "../../src/sim/config.js";
import type { Ant } from "../../src/sim/types.js";
import { TEST_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";
import { playable } from "../playable.ts";

/** The view's castes; brood is set per queen with set_brood (rules 27). */

const CASTES_CONFIG: SimConfig = playable({ ...TEST_CONFIG, castes: CASTE_RULES });
const [VLC] = COLONY_NAMES;

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function joinAs(harness: Harness): Promise<{ agent: TestAgent; agentId: string }> {
  const agent = await harness.connect();
  const r = await agent.call("join", { colony: VLC });
  expect(r.isError, r.text).toBe(false);
  return { agent, agentId: r.data.agentId };
}

async function orderTool(agent: TestAgent): Promise<{ inputSchema: { properties: Record<string, any> }; description?: string }> {
  const { tools } = await agent.client.listTools();
  return tools.find((t) => t.name === "order") as any;
}

async function observe(agent: TestAgent): Promise<any> {
  const r = await agent.call("observe");
  expect(r.isError, r.text).toBe(false);
  return r.data.view;
}

describe("switch off: no brood and no caste", () => {
  it("the order tool has no brood field and the view has no brood or caste", async () => {
    h = await startHarness();
    const { agent } = await joinAs(h);
    expect((await orderTool(agent)).inputSchema.properties).not.toHaveProperty("brood");
    const view = await observe(agent);
    expect(view).not.toHaveProperty("brood");
    expect(view).not.toHaveProperty("myBrood");
    expect(view.squad.length).toBeGreaterThan(0);
    for (const ant of view.squad) expect(ant).not.toHaveProperty("caste");
    for (const cell of expandCells(view.cells)) for (const ant of cell.ants) expect(ant).not.toHaveProperty("caste");
  });
});

describe("switch on: castes", () => {

  it("the view shows each ant's caste and no colony brood vote", async () => {
    h = await startHarness({ simConfig: CASTES_CONFIG });
    const { agent, agentId } = await joinAs(h);
    const before = await observe(agent);
    expect(before).not.toHaveProperty("brood");
    expect(before).not.toHaveProperty("myBrood");
    for (const ant of before.squad) expect(ant.caste).toBe("worker");
    expect(expandCells(before.cells).flatMap((c: any) => c.ants).every((a: any) => a.caste === "worker")).toBe(true);

    // Make one squad ant a soldier: the view reports it as such, in the squad and on its tile.
    const ants = h.game.match!.state.ants as Ant[];
    const soldier = ants.find((a) => a.squad === agentId)!;
    soldier.caste = "soldier";
    const after = await observe(agent);
    expect(after.squad.find((a: any) => a.antId === soldier.id).caste).toBe("soldier");
    expect(expandCells(after.cells).flatMap((c: any) => c.ants).find((a: any) => a.antId === soldier.id).caste).toBe("soldier");
  });


});

describe("the join briefing explains castes in at most three sentences", () => {
  const casteLine = (config: SimConfig): string | undefined => briefing(config).split("\n").find((l) => l.startsWith(CASTES_LEAD));

  it("switch on: one caste line of at most three sentences, naming set_brood", () => {
    const line = casteLine(CASTES_CONFIG)!;
    expect(line).toBeDefined();
    const sentences = line.slice(CASTES_LEAD.length).split(/[.!?](?=\s|$)/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences.length).toBeLessThanOrEqual(3);
    expect(line).toContain("set_brood");
    expect(line).toContain(`${CASTE_RULES.soldierCost} food`);
    // The generic decoding legend names optional wire kinds; gameplay teaching stays in this line.
    // One occurrence of the seat-notice legend (brood_vote_lost) is stripped;
    // any other brood/caste/soldier wording still fails.
    expect(briefing(CASTES_CONFIG).replace(line, "").replace(FOOD_RADIX_TEXT, "").replace(SEAT_NOTICE_TEXT, "")).not.toMatch(/caste|soldier|brood/i);
  });

  it("switch off: no caste line", () => {
    expect(casteLine(playable(TEST_CONFIG))).toBeUndefined();
    // Exactly one seat-notice legend occurrence is stripped, as above.
    expect(briefing(playable(TEST_CONFIG)).replace(FOOD_RADIX_TEXT, "").replace(SEAT_NOTICE_TEXT, "")).not.toMatch(/caste|soldier|brood/i);
  });
});
