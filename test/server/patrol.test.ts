import { describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.ts";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.ts";
import { comparisonOptions } from "../../src/server.ts";
import { RULES_VERSION } from "../../src/sim/config.ts";
import { parseLog } from "../../src/sim/log.ts";

describe("new default matches opt into patrol rules", () => {
  it("records the current version and twelve-fine-tile range at the actual server default boundary", () => {
    const options = comparisonOptions({}, DEFAULT_MCP_CONFIG);
    const lines: string[] = [];
    const game = new Game({ simConfig: options.simConfig, onLogLine: line => lines.push(line) });
    game.startMatch(7001);
    expect(game.match!.state.config.patrolLinkTiles).toBe(12);
    expect(game.match!.state.config.startArea).toBe("back-quarter");
    expect(game.match!.state.config.adjudication).toBe("kills-first");
    const header = parseLog(lines).header;
    expect(header.rulesVersion).toBe(RULES_VERSION);
    expect(header.config.patrolLinkTiles).toBe(12);
  });
});
