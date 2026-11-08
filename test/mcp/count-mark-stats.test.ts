import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { COUNT_MARK_MAX_COUNT, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { undrawnColonyCaps } from "../../src/sim/mapBoard.js";
import { TUNING_MAP_MAX_ANTS_PER_SIDE } from "../../src/sim/tuningMap.js";
import type { AgentView } from "../../src/sim/view.js";
import { addAnt } from "../sim/fixtures.js";
import { startHarness } from "./harness.js";
import { playable } from "../playable.ts";

const base = playable(rulesConfig("redesign"));
const config = { ...base, antSpeedTilesPerSecond: 0, combatGraceTicks: 0,
  defenderBonusPermille: 1000, hatchIntervalTicks: 1_000_000, groundFoodIntervalTicks: undefined };

describe("observe count-mark combat feedback", () => {
  it("carries real combat totals and existing unspent food through command/current/history/reconnect replies", async () => {
    const h = await startHarness({ simConfig: config });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join");
      const id = joined.data.agentId as string;
      const state = h.game.match!.state;
      state.ants = state.ants.filter(a => a.squad === id);
      // Bite reach is two tiles at grid scale 2: the squad stands outside it, so only the claimed
      // ant is adjacent to this enemy and squad ants cannot take the kill credit.
      for (const ant of state.ants) { ant.x = 30_500; ant.y = 16_500; }
      addAnt(state, 0, 30, 21, { hp: 100, caste: "worker" });
      addAnt(state, 1, 31, 22, { hp: 100, caste: "worker" });
      state.colonies[0].foodStore = 123; state.colonies[1].foodStore = 999;
      const accepted = await agent.call("count_mark", { verb: "GATHER", count: 1 });
      expect(accepted.isError).toBe(false);
      const markId = accepted.data.mark.markId as number;
      expect(h.game.match!.state.stats.deaths).toEqual([1, 1]);
      h.game.match!.state.marks.push({ id: 9999, agentId: "enemy", colony: 1, tileX: 30, tileY: 20,
        laidTick: h.game.match!.state.tick, steering: 0, words: [], verb: "ATTACK", count: 1,
        antsLost: 987, enemiesKilled: 654 });
      expect(h.game.match!.state.colonies[0].foodStore).toBe(123 - config.hatchCost);
      const assertView = (data: { view: Pick<AgentView, "queenFounding" | "marks" | "myMarks"> }) => {
        expect(data.view.queenFounding!.foodStore).toBe(h.game.match!.state.colonies[0].foodStore);
        expect(data.view).not.toHaveProperty("foodStore");
        expect(data.view.marks.find((m: {markId: number}) => m.markId === markId)).toMatchObject({ lost: 1, kills: 1 });
        expect(data.view.myMarks.find((m: {markId: number}) => m.markId === markId)).toMatchObject({ lost: 1, kills: 1 });
        expect(data.view.marks.some((m: {markId: number}) => m.markId === 9999)).toBe(false);
        expect(data.view.myMarks.some((m: {markId: number}) => m.markId === 9999)).toBe(false);
      };
      for (const args of [{}, { since: 0 }, { map: true }, {}]) assertView((await agent.call("observe", args)).data);
      await agent.end();
      const reconnect = await h.connect();
      const rejoined = await reconnect.call("join", { reconnectToken: joined.data.reconnectToken });
      expect(rejoined.isError).toBe(false);
      assertView(rejoined.data);
      assertView((await reconnect.call("observe", { since: 0 })).data);
      h.game.match!.state.colonies[0].foodStore = 456;
      const updated = await reconnect.call("observe");
      assertView(updated.data);
      expect(updated.data.view.queenFounding.foodStore).toBe(456);
      // The harness checks every text block's JSON against structuredContent verbatim.
    } finally { await h.close(); }
  });

  it("explains the existing food field, one-ant credit and lifetime in both briefings and tools/list", async () => {
    const h = await startHarness({ simConfig: config });
    try {
      const agent = await h.connect();
      const tools = await agent.client.listTools();
      const observe = tools.tools.find(t => t.name === "observe")!.description!;
      for (const text of [briefing(config), joinBriefing(config), observe]) {
        expect(text).toContain("view.queenFounding.foodStore");
        expect(text).toContain("lost (ants that died while claimed)");
        expect(text).toContain("kills (enemy ants killed by its claimed ants)");
        expect(text).toContain("A kill is credited to one ant, never shared");
        expect(text).toContain("biggest hit on the death tick");
        expect(text).toContain("lowest ant id on ties");
        expect(text).toContain("queen's bigger or equal hit wins");
        expect(text).toContain("Only that ant's current mark gets the kill");
        expect(text).toContain("Released ants no longer add to that mark");
        expect(text).toContain("Totals survive count/caste changes and observes");
        expect(text).toContain("expiry or replacement");
      }
    } finally { await h.close(); }
  });

  it("keeps accounting-off copy and word marks free of the new fields", async () => {
    // The redesign with word marks, on the reference-grid template.
    const wordConfig = { ...rulesConfig("redesign"), wordMarksDisabled: undefined, antSpeedTilesPerSecond: 0, combatGraceTicks: 0,
      defenderBonusPermille: 1000, hatchIntervalTicks: 1_000_000, groundFoodIntervalTicks: undefined };
    const { combatTotals: _newFlag, ...countMarks } = wordConfig.countMarks!;
    const old = playable({ ...wordConfig, countMarks });
    for (const text of [briefing(old), joinBriefing(old)]) {
      expect(text).not.toContain("lost (ants that died while claimed)");
      expect(text).not.toContain("kills (enemy ants killed by its claimed ants)");
    }
    const h = await startHarness({ simConfig: old });
    try {
      const agent = await h.connect(); await agent.call("join");
      const count = await agent.call("count_mark", { verb: "GATHER", count: 1 });
      expect(count.isError).toBe(false);
      const view = (await agent.call("observe")).data.view;
      expect(view.myMarks[0]).not.toHaveProperty("lost");
      expect(view.marks[0]).not.toHaveProperty("kills");
      const observe = (await agent.client.listTools()).tools.find(t => t.name === "observe")!.description!;
      expect(observe).not.toContain("lost (ants that died while claimed)");
    } finally { await h.close(); }
    const current = await startHarness({ simConfig: wordConfig });
    try {
      const agent = await current.connect(); await agent.call("join");
      expect((await agent.call("mark", { words: ["FOOD"] })).isError).toBe(false);
      const view = (await agent.call("observe")).data.view;
      expect(view.myMarks[0]).not.toHaveProperty("lost");
      expect(view.marks[0]).not.toHaveProperty("kills");
    } finally { await current.close(); }
  });

  it("states the count maximum before the map is drawn and refuses a larger count with a tool error, not a clamp", async () => {
    // No colony can ever have more ants to claim than the maximum, so no fillable count is refused.
    for (const name of ["count-marks", "redesign"] as const) {
      for (const cap of undrawnColonyCaps(newMatchConfig(rulesConfig(name)))) expect(cap).toBeLessThanOrEqual(COUNT_MARK_MAX_COUNT);
    }
    expect(TUNING_MAP_MAX_ANTS_PER_SIDE).toBeLessThanOrEqual(COUNT_MARK_MAX_COUNT);
    expect(COUNT_MARK_MAX_COUNT).toBe(10_000);
    expect(briefing(config)).toContain("whole count 1-10,000");
    expect(joinBriefing(config)).toContain("count a whole number of 1 or more, at most 10,000");
    const h = await startHarness({ simConfig: config });
    try {
      const agent = await h.connect();
      const tool = (await agent.client.listTools()).tools.find(t => t.name === "count_mark")!;
      expect(tool.description).toContain("whole count of 1 or more, at most 10,000, of free ants");
      expect(tool.description).toContain("a larger count is refused, not reduced");
      expect(JSON.stringify(tool.inputSchema)).toContain("1 or more, at most 10,000");
      await agent.call("join");
      for (const count of [COUNT_MARK_MAX_COUNT + 1, 1_000_000_000, Number.MAX_SAFE_INTEGER]) {
        const refused = await agent.call("count_mark", { verb: "GATHER", count });
        expect(refused.isError).toBe(true);
        expect(refused.data.error.code).toBe("bad_count_mark");
        expect(refused.data.error.message).toContain("at most 10,000");
        expect(refused.data.error.howToFix).toContain("at most 10,000");
        expect(h.game.match!.state.marks).toHaveLength(0);
      }
      // The refusals spent no command allowance: the maximum itself is accepted at once, unclamped.
      const accepted = await agent.call("count_mark", { verb: "GATHER", count: COUNT_MARK_MAX_COUNT });
      expect(accepted.isError).toBe(false);
      expect(h.game.match!.state.marks.map(mark => mark.count)).toEqual([COUNT_MARK_MAX_COUNT]);
    } finally { await h.close(); }
  });
});
