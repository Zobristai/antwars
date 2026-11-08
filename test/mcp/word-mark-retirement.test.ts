import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { rulesConfig } from "../../src/sim/config.js";
import { logExplainer, renderRules } from "../../web/rules.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

const current = playable(rulesConfig("redesign"));
const { wordMarksDisabled: _retired, ...legacy } = current;
const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())); });
async function harness(simConfig = current) {
  const h = await startHarness({ simConfig });
  harnesses.push(h);
  return h;
}
const removedTeaching = /word[ -]marks?|follow_trail|\border\/mark\b|^\s*-?\s*mark:/im;

function commandState(h: Harness) {
  const state = h.game.match!.state;
  const a = state.agents[0]!;
  return JSON.stringify({ order: a.order, brood: a.brood, lastCommandTick: a.lastCommandTick, idle: a.idle, marks: state.marks });
}

describe("new-match command surface", () => {
  it("removes only the retired tool, field and order kind, preserving count and queen schemas", async () => {
    const h = await harness(), old = await harness(legacy);
    const a = await h.connect(), b = await old.connect();
    const { tools } = await a.client.listTools();
    const previous = (await b.client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(previous.filter(t => t.name !== "mark").map(t => t.name));
    const order = tools.find(t => t.name === "order")!;
    expect(order.inputSchema.properties).not.toHaveProperty("mark");
    expect(order.inputSchema.properties!.kind).toMatchObject({ enum: ["go_to", "forage", "hold", "attack"] });
    for (const name of ["count_mark", "found_queen"]) {
      expect(tools.find(t => t.name === name)!.inputSchema).toEqual(previous.find(t => t.name === name)!.inputSchema);
    }
    for (const name of ["intent", "brood", "tileX", "tileY"]) {
      expect(order.inputSchema.properties![name]).toEqual(previous.find(t => t.name === "order")!.inputSchema.properties![name]);
    }
    expect(JSON.stringify(tools)).not.toMatch(removedTeaching);
    expect(previous.find(t => t.name === "order")!.inputSchema.properties).toHaveProperty("mark");
  });

  it("refuses removed order fields and kinds instead of stripping or aliasing them", async () => {
    const h = await harness();
    const a = await h.connect();
    expect((await a.call("join")).isError).toBe(false);
    for (const args of [
      { kind: "hold", mark: { words: ["FOOD"] }, brood: "soldiers", intent: "must not apply" },
      { kind: "hold", mark: null },
      { kind: "hold", mark: "FOOD" },
      { kind: "follow_trail", brood: "soldiers", intent: "must not apply" },
    ]) {
      const before = commandState(h);
      const refused = await a.call("order", args);
      expect(refused.isError).toBe(true);
      expect(commandState(h)).toBe(before);
      expect(refused.data.error.howToFix).not.toMatch(removedTeaching);
      expect(refused.data.error.message).not.toMatch(removedTeaching);
    }
    // Unknown tools use the SDK's protocol error, not our structured reply helper.
    expect((await a.client.callTool({ name: "mark", arguments: { words: ["FOOD"] } })).isError).toBe(true);
    // Rules-27 orders carry no brood (set_brood sets it), so the accepted order has none.
    const accepted = await a.call("order", { kind: "hold", intent: "guard here" });
    expect(accepted.isError).toBe(false);
    expect(accepted.data).toMatchObject({ accepted: true, order: { kind: "hold" } });
    expect(accepted.data).not.toHaveProperty("myBrood");
    h.advance(current.commandFloorTicks);
    expect((await a.call("count_mark", { verb: "GATHER", count: 1 })).isError).toBe(false);
    h.advance(current.commandFloorTicks);
    const refused = await a.call("count_mark", { verb: "GATHER", count: 1, tileX: 63, tileY: 0 });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.howToFix).not.toMatch(removedTeaching);
  });

  it("teaches only offered commands and executes the worked examples", async () => {
    const h = await harness();
    const a = await h.connect();
    const joined = await a.call("join");
    const rules = await a.call("rules");
    for (const text of [joined.data.briefing, rules.data.rules, briefing(current), joinBriefing(current), renderRules(current), logExplainer(current)]) {
      expect(text).not.toMatch(removedTeaching);
    }
    const examples = [...String(rules.data.rules).matchAll(/\d+\. (?:After the command interval, )?(order|count_mark) (\{[^\n]+?\}) ->/g)];
    expect(examples).toHaveLength(2);
    for (const [, command, json] of examples) {
      h.advance(current.commandFloorTicks);
      expect((await a.call(command!, JSON.parse(json!))).isError).toBe(false);
    }
    expect(briefing(legacy)).toContain("follow_trail");
    expect(joinBriefing(legacy)).toContain("Word marks");
    expect(renderRules(legacy)).toContain("Word marks");
  });
});
