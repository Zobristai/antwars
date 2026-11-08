import { describe, expect, it } from "vitest";
import { MAPS, TERRAIN_RULES, rulesConfig } from "../../src/sim/config.js";
import { startHarness } from "./harness.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { createMapShapes } from "../../src/sim/mapShapes.js";
import { gridScaleOf } from "../../src/sim/gridScale.js";
import { playable } from "../playable.ts";

describe("public terrain in MCP", () => {
  it("describes every native-grid layout in full and reconnect briefings at grid scale 2", () => {
    const config = { ...playable(rulesConfig("redesign")),
      terrain: { ...TERRAIN_RULES, maps: createMapShapes(), referenceWidth: 128, referenceHeight: 96 } };
    const full = briefing(config), joined = joinBriefing(config);
    expect(full).toContain("Open Field: dry.");
    expect(full).toContain("Three Crossings: N/S river, 3 crossings.");
    expect(full).toContain("Central Lake: stepped lake; land N/S.");
    // Verbose non-accounting configurations still retain the original descriptions.
    for (const line of ["Open Field: open ground with no water.", "Three Crossings: a north-south river with three land crossings.",
      "Central Lake: one stepped central lake with land routes north and south."]) {
      expect(briefing({ ...config, countMarks: { ...config.countMarks!, combatTotals: undefined } })).toContain(line);
    }
    expect(joined).toContain("Open Field: dry.");
    expect(joined).toContain("Three Crossings: N/S river, 3 crossings.");
    expect(joined).toContain("Central Lake: stepped lake; land N/S.");
  });

  it("never describes a historical lake column as the newly shaped lake", () => {
    const config = playable({ ...rulesConfig("redesign"), terrain: TERRAIN_RULES });
    for (const text of [briefing(config), joinBriefing(config)]) {
      expect(text).not.toContain("stepped lake");
      expect(text).not.toContain("Central Lake:");
    }
  });
  it.each(MAPS)("$name: join, observe and rules explain the same compact water layout", async map => {
    const base = rulesConfig("redesign");
    const h = await startHarness({ simConfig: { ...base, terrain: { ...TERRAIN_RULES, mapId: map.id } } });
    try {
      const a = await h.connect();
      const join = await a.call("join");
      expect(join.isError).not.toBe(true);
      const joinLines = join.data.briefing.split("\n");
      expect(joinLines).toContain("No ants, marks or queens on water or rocks.");
      expect(joinLines).toContain("Ants/food/enemy nests obey sight. See view.terrain.");
      for (const name of MAPS.map(candidate => candidate.name)) expect(join.data.briefing).not.toContain(name);
      const view = (await a.call("observe")).data.view;
      expect(view.terrain.mapId).toBe(map.id);
      expect(view.terrain.mapName).toBe(map.name);
      // Reference-grid water rectangles are drawn at grid scale 2 on the 128x96 board.
      const scale = gridScaleOf(h.game.match!.state.config);
      expect(view.terrain.water).toEqual(map.water.map(r => [r.x * scale, r.y * scale, r.width * scale, r.height * scale]));
      expect(view.terrain.encoding).toContain("half-open");
      expect(view.terrain.rocks).toEqual(h.game.match!.state.terrain!.rocks!.map(r => [r.x, r.y, r.width, r.height]));
      expect(view.terrain.rocks.length).toBeGreaterThanOrEqual(base.terrain!.rocks!.minPairs * 2);
      expect(view.terrain.rocks.length).toBeLessThanOrEqual(base.terrain!.rocks!.maxPairs * 2);
      expect(view.terrain).not.toHaveProperty("seed");
      expect(join.data.briefing).not.toContain("6-8 mirrored pairs");
      const rules = (await a.call("rules")).data.rules;
      expect(rules).toContain(map.name); expect(rules).toContain("Rocks block ants, marks and queen founding");
      expect(rules).toContain("6-8 mirrored rock pairs (1-3 original-size cells each; a cell covers 2x2 fine tiles)");
      const [tileX, tileY] = view.terrain.rocks[0];
      const before = h.game.match!.state.colonies[0].foodStore;
      const refused = await a.call("found_queen", { tileX, tileY });
      expect(refused.isError).toBe(true);
      expect(refused.data.error).toMatchObject({ code: "rock_tile", howToFix: expect.stringMatching(/observe.*view\.terrain\.rocks/) });
      expect(refused.data.error.message).toContain("choose a held land tile");
      expect(h.game.match!.state.colonies[0].foodStore).toBe(before);
    } finally { await h.close(); }
  });
});
