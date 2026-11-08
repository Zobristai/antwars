import { describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import type { SimConfig } from "../../src/sim/config.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { ruleSections } from "../../web/rules.js";
import { startHarness } from "./harness.js";

// The production boundary selects the shipped scale/maps; reference configs stay historical.
const shipped = comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!;
const changed: SimConfig = {
  ...shipped,
  sightTiles: 13,
  smellTiles: 17,
  attackRadiusTiles: 19,
  markReachTiles: 23,
  antSpeedTilesPerSecond: 2.75,
  squadSize: 5,
  ticksPerSecond: 20,
  commandFloorTicks: 140,
  markLifetimeTicks: 2460,
  queenFounding: { ...shipped.queenFounding!, minDistanceTiles: 29, cost: 431 },
  queenHp: { ...shipped.queenHp!, regenClearTiles: 31 },
};

/** Pin semantic quantities, not a shared text helper used by implementation. */
describe("agent and human rule numbers use the match config", () => {
  it("grid scale 2 labels physical-area rules separately from fine-tile coordinates", () => {
    // Every match plays at grid scale 2; the shipped config carries the marker explicitly.
    const config = shipped, gridScale = 2;
    expect(config.gridScale).toBe(gridScale);
    const full = briefing(config), concise = joinBriefing(config);
    const sections = ruleSections(config);
    const human = sections.flatMap(section => section.lines).join("\n");
    for (const text of [full, concise]) {
      expect(text).toContain("DEFEND walks to its mark, holds and never chases.");
      expect(text).toContain("Each recruits its own count; bite in reach, then continue.");
      expect(text).not.toContain("bite only adjacent enemies");
      expect(text).not.toContain("standing and biting when adjacent");
    }
    // Current agent prose is shorter than the human rules; pin both independently.
    // Says "in reach"; the reach itself is defined once under How to win.
    expect(full).toContain(`Ant and queen bite reach is ${gridScale} tiles, including diagonals`);
    expect(human).toContain(`bite only enemies within ${gridScale} tiles (incl. diagonals), never chasing`);
    expect(sections.find(section => section.title === "Autonomous ants")!.lines.join("\n"))
      .toContain(`Every non-carrying free ant bites enemies within ${gridScale} tiles (incl. diagonals)`);
    // Combat and attack say "in reach".
    expect(full).toContain("with an enemy in reach, hit the lowest-HP enemy");
    expect(full).toContain(`aligned ${gridScale}x${gridScale} tile cell`);
    expect(human).toContain(`aligned ${gridScale}x${gridScale} tile cell`);
    for (const text of [full, human]) {
      expect(text).toContain("excluding water and rocks");
      expect(text).toContain("original-size tile areas");
      expect(text).toContain("original-size cells each");
      expect(text).toContain("food ceilings per original-size resource cell");
      expect(text).toContain(`Bites: within ${gridScale} tiles incl. diagonals`);
      expect(text).not.toContain("Bites: adjacent tiles incl. diagonals");
      expect(text).not.toContain("per-tile food ceilings");
      expect(text).not.toContain("within 1 tile of an enemy");
    }
    expect(full).toContain(`at least ${config.earlyWin!.minHeldTiles} original-size tile areas`);
    expect(human).toContain(`at least ${config.earlyWin!.minHeldTiles} original-size tile areas`);
  });

  it.each([{ label: "shipped", config: shipped }, { label: "distinct quantities", config: changed }])("$label: dimensions, movement and radii", ({ config }) => {
    const full = briefing(config), concise = joinBriefing(config);
    const human = ruleSections(config).flatMap(section => section.lines).join("\n");
    for (const text of [full, concise]) {
      expect(text).toContain(`${config.mapWidth}x${config.mapHeight}`);
      expect(text).toContain(`x 0-${config.mapWidth - 1}`);
      expect(text).toContain(`y 0-${config.mapHeight - 1}`);
      expect(text).toContain(`up to ${config.squadSize} ants`);
      expect(text).toContain(`within ${config.sightTiles} tiles of any living ant of your colony`);
      expect(text).toContain(`ATTACK marches there, then pursues the nearest enemy in the mark's ${config.attackRadiusTiles}-tile area.`);
    }
    expect(full).toContain(`Speed: ${config.antSpeedTilesPerSecond} tiles/s`);
    expect(full).toContain(`marks within ${config.smellTiles} tiles`);
    // Shipped rules disable word marks; keep their configured reach covered explicitly.
    expect(full).not.toContain("fading to zero at");
    const { wordMarksDisabled: _disabled, ...wordMarkConfig } = config;
    const wordMarks = briefing(wordMarkConfig);
    expect(wordMarks).toContain(`fading to zero at ${config.markReachTiles} tiles`);
    expect(full).toContain(`Minimum Euclidean distance: ${config.queenFounding!.minDistanceTiles} tiles`);
    expect(full).toContain(`no enemy within ${config.queenHp!.regenClearTiles} tiles`);
    expect(human).toContain(`${config.mapWidth} tiles wide and ${config.mapHeight} tiles high`);
    expect(human).toContain(`at least ${config.queenFounding!.minDistanceTiles} tiles (Euclidean distance)`);
    expect(human).toContain(`no enemy within ${config.queenHp!.regenClearTiles} tiles`);
    expect(human).toContain(`first extra queen costs ${config.queenFounding!.cost} stored food`);
  });

  it.each([{ label: "shipped", config: shipped }, { label: "distinct quantities", config: changed }])("$label: tool descriptions agree with the briefing rather than a default interval", async ({ config }) => {
    const h = await startHarness({ simConfig: config, start: false });
    try {
      const agent = await h.connect();
      const tools = (await agent.client.listTools()).tools;
      const order = tools.find(tool => tool.name === "order")!;
      const count = tools.find(tool => tool.name === "count_mark")!;
      const interval = config.commandFloorTicks / config.ticksPerSecond;
      expect(briefing(config)).toContain(`One command per ${interval} s`);
      expect(joinBriefing(config)).toContain(`One command per ${interval} s`);
      expect(order.description).toContain(`One command per ${interval} s`);
      expect(count.description).toContain(`within ${config.sightTiles} tiles of any living ant of your colony`);
      expect(count.description).toContain(`ATTACK marches there, then pursues the nearest enemy in the mark's ${config.attackRadiusTiles}-tile area.`);
      expect(count.description).toContain("DEFEND walks to its mark, holds and never chases.");
      expect(count.description).toContain("Each recruits its own count; bite in reach, then continue.");
      expect(briefing(config)).toContain(`Ant and queen bite reach is ${config.gridScale} tiles, including diagonals: one original-size tile's distance.`);
      expect(count.description).not.toContain("bite only adjacent enemies");
      expect(count.description).toContain(`marks last ${config.markLifetimeTicks / config.ticksPerSecond} seconds`);
    } finally { await h.close(); }
  });
});
