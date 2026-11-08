import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { packMarks, unpackMarks } from "../../src/mcp/markTable.js";
import { rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { startHarness } from "./harness.js";

const config = { ...newMatchConfig(rulesConfig("redesign")), antSpeedTilesPerSecond: 0,
  commandFloorTicks: 0, hatchIntervalTicks: 1_000_000 };

describe("patrol agent surface", () => {
  it("advertises the configured range, loop order, singleton rule and a worked chain example", async () => {
    const harness = await startHarness({ simConfig: config });
    try {
      const client = await harness.connect();
      const tools = (await client.client.listTools()).tools;
      const tool = tools.find(item => item.name === "count_mark")!;
      for (const text of [briefing(config), joinBriefing(config), tool.description!]) {
        expect(text).toContain("PATROL");
        expect(text).toContain("within 12 tiles (Euclidean)");
        expect(text).toContain("ants loop oldest to newest (laidTick, then id) and back");
        expect(text).toContain("A lone patrol mark holds exactly like DEFEND");
        expect(text).toContain("bridging mark");
      }
      expect(briefing(config)).toContain('Patrol example: count_mark {"verb":"PATROL"');
      expect(JSON.stringify(tool.inputSchema)).toContain("PATROL");
      expect(tools.find(item => item.name === "observe")!.description).toContain("zero-based laid-order loop index");
    } finally { await harness.close(); }
  });

  it("round-trips accepted patrols, observe chain metadata and lossless compact tables", async () => {
    const harness = await startHarness({ simConfig: config });
    try {
      const client = await harness.connect();
      const joined = await client.call("join"); // Private in-process fixture only, never a public match.
      expect(joined.isError).toBe(false);
      const a = await client.call("count_mark", { verb: "PATROL", count: 2 });
      expect(a.isError).toBe(false);
      const first = harness.game.match!.state.marks[0]!;
      const b = await client.call("count_mark", { verb: "PATROL", count: 2, tileX: first.tileX + 4, tileY: first.tileY });
      expect(b.isError).toBe(false);
      const response = await client.call("observe");
      expect(response.isError).toBe(false);
      const marks = unpackMarks(response.data.view.marks);
      const own = unpackMarks(response.data.view.myMarks);
      expect(marks).toHaveLength(2);
      expect(marks.map(item => [item.chain, item.position])).toEqual([[first.id, 0], [first.id, 1]]);
      expect(own.map(item => [item.chain, item.position])).toEqual([[first.id, 0], [first.id, 1]]);
      expect(unpackMarks(packMarks(marks))).toEqual(marks);
      const bad = await client.call("count_mark", { verb: "NOT_A_JOB", count: 1 });
      expect(bad.data.error.howToFix).toContain("PATROL");
    } finally { await harness.close(); }
  });

  it("neither offers nor accepts PATROL for a saved config without the field", async () => {
    const { patrolLinkTiles: _patrol, ...old } = config;
    const harness = await startHarness({ simConfig: old });
    try {
      const client = await harness.connect();
      const tool = (await client.client.listTools()).tools.find(item => item.name === "count_mark")!;
      for (const text of [briefing(old), joinBriefing(old), tool.description!, JSON.stringify(tool.inputSchema)]) expect(text).not.toContain("PATROL");
      expect((await client.call("join")).isError).toBe(false);
      const refused = await client.call("count_mark", { verb: "PATROL", count: 1 });
      expect(refused.isError).toBe(true);
      expect(refused.data.error.code).toBe("bad_count_mark");
      expect(refused.data.error.howToFix).not.toContain("PATROL");
      expect(harness.game.match!.state.marks).toEqual([]);
      expect(harness.game.match!.state.ants.every(ant => !("patrolWaypoint" in ant))).toBe(true);
    } finally { await harness.close(); }
  });
});
