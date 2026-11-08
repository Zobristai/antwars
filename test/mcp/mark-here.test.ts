import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES, SUB } from "../../src/sim/config.js";
import type { SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { TEST_CONFIG, startHarness, type Harness, type TestAgent } from "./harness.js";

/** A mark without a tile, through the MCP tools. */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function cluster(): SimState {
  const state = emptyMatch(0, TEST_CONFIG);
  state.food.fill(0);
  for (let i = 0; i < 24; i += 1) addAnt(state, 0, 10 + (i % 4), 10 + Math.floor(i / 4));
  return state;
}

async function joined(harness: Harness): Promise<{ agent: TestAgent; agentId: string; briefing: string }> {
  const agent = await harness.connect();
  const r = await agent.call("join", { colony: COLONY_NAMES[0] });
  expect(r.isError, r.text).toBe(false);
  return { agent, agentId: r.data.agentId, briefing: r.data.briefing };
}

/** The tile the sim lays a tile-less mark on: the squad ant nearest the squad's mean position, ties to the lowest id. */
function hereTile(harness: Harness, agentId: string): { tileX: number; tileY: number } {
  const squad = harness.game.match!.state.ants.filter((a) => a.squad === agentId);
  const mx = squad.reduce((n, a) => n + a.x, 0) / squad.length;
  const my = squad.reduce((n, a) => n + a.y, 0) / squad.length;
  const d = (a: { x: number; y: number }) => (a.x - mx) ** 2 + (a.y - my) ** 2;
  const ant = [...squad].sort((a, b) => d(a) - d(b) || a.id - b.id)[0]!;
  return { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

describe("mark here through MCP", () => {
  it("lays a standalone tile-less mark where the squad stands, and logs the input as sent", async () => {
    h = await startHarness({ state: cluster() });
    const a = await joined(h);
    // The sim applies the input before that tick's movement, so the tile is read from the squad as it stands now.
    const here = hereTile(h, a.agentId);
    const r = await a.agent.call("mark", { words: ["GATHER"] });
    expect(r.isError, r.text).toBe(false);
    const marks = h.game.match!.state.marks;
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ agentId: a.agentId, ...here, words: ["GATHER"] });
    expect(h.log.some((line) => line.includes(`{"type":"mark","agentId":"${a.agentId}","words":["GATHER"]}`))).toBe(true);
  });

  it("applies an order whose mark leaves out its tile", async () => {
    h = await startHarness({ state: cluster() });
    const a = await joined(h);
    const r = await a.agent.call("order", { kind: "hold", mark: { words: ["HOLD"] } });
    expect(r.isError, r.text).toBe(false);
    expect(h.game.match!.state.marks[0]).toMatchObject({ agentId: a.agentId, ...hereTile(h, a.agentId) });
    expect(h.game.match!.state.agents.find((x) => x.id === a.agentId)!.order).toEqual({ kind: "hold" });
  });

  it("answers a mark naming only one axis with a field error for the missing one", async () => {
    h = await startHarness({ state: cluster() });
    const a = await joined(h);
    const alone = await a.agent.call("mark", { tileX: 10, words: ["FOOD"] });
    expect(alone.isError).toBe(true);
    expect(alone.data.error.code).toBe("bad_arguments");
    expect(alone.data.error.message).toContain("tileY must be");
    const ordered = await a.agent.call("order", { kind: "hold", mark: { tileY: 10, words: ["FOOD"] } });
    expect(ordered.isError).toBe(true);
    expect(ordered.data.error.code).toBe("bad_arguments");
    expect(ordered.data.error.message).toContain("mark.tileX must be");
    expect(h.game.match!.state.marks).toHaveLength(0);
  });

  it("says a refused mark's order was not applied, and that leaving out the tile marks where the squad is", async () => {
    h = await startHarness({ state: cluster() });
    const a = await joined(h);
    const r = await a.agent.call("order", { kind: "hold", mark: { tileX: 40, tileY: 40, words: ["FOOD"] } });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("no_own_ant_on_tile");
    expect(r.text).toContain("an order carrying this mark was not applied either");
    expect(r.data.error.message).toContain("Leave out tileX and tileY");
    expect(r.data.error.howToFix).toContain("Leave out tileX and tileY");
    expect(h.game.match!.state.agents.find((x) => x.id === a.agentId)!.order).not.toEqual({ kind: "hold" });
  });

  it("states up front, in the mark tool, the order tool's mark field and the join briefing, the tile-less rule and that a refused mark cancels its order", async () => {
    h = await startHarness({ state: cluster() });
    const a = await joined(h);
    const { tools } = await a.agent.client.listTools();
    const mark = tools.find((t) => t.name === "mark")!;
    const order = tools.find((t) => t.name === "order")!;
    const rule = "Leave out tileX and tileY and it lands on the tile of the squad ant nearest your squad's mean position (ties to the lowest ant id)";
    expect(mark.description).toContain(rule);
    expect(mark.description).toContain("When a mark carried by an order is refused, that order is not applied either.");
    expect(mark.inputSchema.required ?? []).not.toContain("tileX");
    const markField = JSON.stringify((order.inputSchema.properties as Record<string, unknown>).mark);
    expect(markField).toContain(rule);
    expect(markField).toContain("If the mark is refused, the order is not applied either.");
    // A grid-scale-2 match carries the current (version 17) compact join briefing, which states both rules this way.
    expect(a.briefing).toContain("omit both axes for the ant nearest squad mean (lowest id breaks ties)");
    expect(a.briefing).toContain("Refused order mark refuses the order too.");
    // The worked example marks without a tile.
    const rules: string = (await a.agent.call("rules")).data.rules;
    const example = rules.slice(rules.indexOf("Worked example"));
    expect(example).toContain('"mark":{"words":["FOOD","N","MANY"]}');
    expect(example).not.toMatch(/"mark":\{"tileX"/);
  });
});
