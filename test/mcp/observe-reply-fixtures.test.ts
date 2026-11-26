import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { captureCells } from "../../src/mcp/cellPages.js";
import { Game, type ObserveEvent } from "../../src/mcp/game.js";
import { registerTools } from "../../src/mcp/tools.js";
import { rulesConfig } from "../../src/sim/config.js";
import type { AgentView } from "../../src/sim/view.js";

// Fixed inputs at the game boundary; observe itself builds both copies of the reply.
const view: AgentView = {
  tick: 12, agentId: "seat-1", colony: 0, idle: false, ticksLeft: 600, secondsLeft: 60,
  squad: [], order: { kind: "hold" }, orderStatus: "holding", nextCommandTick: 20,
  cells: [{ tileX: 2, tileY: 3, food: 4, ants: [] }], marks: [], myMarks: [],
  territoryRows: [], territoryTiles: 0, territorySharePermille: 0, events: [], result: null,
};
const history: ObserveEvent[] = [
  { type: "fight", tick: 10, antId: 1, targetId: 2, colony: 0, tileX: 2, tileY: 3 },
  { type: "count_mark_accepted", tick: 11, agentId: view.agentId, colony: 0, markId: 1, tileX: 2, tileY: 3,
    verb: "GATHER", count: 2, availability: { claimedAnts: 2, freeAntsNow: 0 }, message: "0 free ants now" },
];

it.each(["current", "history"] as const)("preserves the unfiltered %s observe reply bytes", async mode => {
  const game = new Game({ simConfig: rulesConfig("redesign") });
  vi.spyOn(game, "call").mockResolvedValue({ kind: "view", view, observeInfo: { status: [60, "order mark count_mark"] } });
  vi.spyOn(game, "eventHistory").mockReturnValue(history);
  vi.spyOn(game, "pendingPriorityEvents").mockReturnValue([1]);
  vi.spyOn(game, "cellsFor").mockImplementation((v, config) => ({ snapshot: captureCells(v, config), offset: 0 }));

  const server = new McpServer({ name: "observe", version: "1" });
  registerTools(server, game, { agentId: view.agentId });
  const client = new Client({ name: "observe", version: "1" });
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(incoming);
    await client.connect(outgoing);
    // Preserve the server's key order rather than rebuilding the result with the client's tool schema.
    const result = await client.request({ method: "tools/call", params: {
      name: "observe", arguments: mode === "current" ? {} : { since: 0 },
    } }, z.record(z.string(), z.unknown()));
    expect(result).toMatchObject({ structuredContent: { view: { eventsMode: mode } } });
    const fixture = new URL(`./fixtures/observe-${mode}.json`, import.meta.url);
    expect(Buffer.from(JSON.stringify(result), "utf8")).toEqual(readFileSync(fixture));
  } finally {
    await client.close();
    await server.close();
  }
});
