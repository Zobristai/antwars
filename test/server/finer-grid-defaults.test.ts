import { describe, expect, it } from "vitest";
import { comparisonOptions } from "../../src/server.js";
import { Game } from "../../src/mcp/game.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { DEFAULT_CONFIG, rulesConfig } from "../../src/sim/config.js";
import { NEW_MATCH_GRID_SCALE, newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { parseLog } from "../../src/sim/log.js";
import { newMatchMaps } from "../../src/sim/mapShapes.js";
import { playable } from "../playable.ts";

describe("new matches use the measured finer grid", () => {
  it("resolves ordinary and comparison matches before match initialization", () => {
    for (const value of [undefined, "v4", "count-marks", "redesign"]) {
      const options = comparisonOptions({ ANTWAR_RULES: value, ANTWAR_PLAYERS: "4" }, DEFAULT_MCP_CONFIG);
      expect(options.simConfig!.gridScale).toBe(NEW_MATCH_GRID_SCALE);
      expect(options.simConfig!.mapWidth).toBe(64 * NEW_MATCH_GRID_SCALE);
      expect(options.simConfig!.mapHeight).toBe(48 * NEW_MATCH_GRID_SCALE);
      expect(options.simConfig!.terrain!.maps).toEqual(newMatchMaps());
      expect(options.simConfig!.terrain!.referenceWidth).toBe(options.simConfig!.mapWidth);
      expect(options.simConfig!.terrain!.referenceHeight).toBe(options.simConfig!.mapHeight);
      expect(newMatchConfig(options.simConfig!)).toBe(options.simConfig);
    }
  });

  it("records the retired-command rules in a server-default match", () => {
    const options = comparisonOptions({}, DEFAULT_MCP_CONFIG);
    const lines: string[] = [];
    const game = new Game({ simConfig: options.simConfig, onLogLine: line => lines.push(line) });
    game.startMatch(7001);
    expect(game.match!.state.config.wordMarksDisabled).toBe(true);
    expect(parseLog(lines).header.rulesVersion).toBe(27);
  });

  it("defaults a new Game to fine tiles but preserves every explicit config", () => {
    const game = new Game();
    game.startMatch(7001);
    expect(game.match!.state.config.gridScale).toBe(NEW_MATCH_GRID_SCALE);
    for (const config of [playable(DEFAULT_CONFIG), playable(rulesConfig("redesign")), playable({ ...DEFAULT_CONFIG, mapWidth: 256, mapHeight: 192 })]) {
      const explicit = new Game({ simConfig: config });
      explicit.startMatch(7001);
      expect(explicit.match!.state.config.gridScale).toBe(NEW_MATCH_GRID_SCALE);
      expect(explicit.match!.state.config.mapWidth).toBe(config.mapWidth);
    }
  });

  it("never rescales supplied finalized states or saved start configurations", () => {
    const game = new Game();
    const saved = createMatch(7001, playable(DEFAULT_CONFIG));
    game.startMatch(7001, { state: saved });
    // The match advances from its own copy; the supplied state is played exactly as given.
    expect(game.match!.state).toEqual(saved);
    const config = playable(DEFAULT_CONFIG);
    const explicit = new Game();
    explicit.startMatch(7002, { config });
    expect(explicit.match!.state.config.mapWidth).toBe(config.mapWidth);
    expect(explicit.match!.state.config.gridScale).toBe(NEW_MATCH_GRID_SCALE);
  });
});
