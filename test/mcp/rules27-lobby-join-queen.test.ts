import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game, type LobbySeat } from "../../src/mcp/game.js";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { registerTools } from "../../src/mcp/tools.js";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { createMatch } from "../../src/sim/map.js";
import { StartPlacement } from "../../src/sim/startPlacement.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { SimInput } from "../../src/sim/types.js";
import { TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

// In rules 27 each lobby seat's join, queued for the first tick
// or sent live, carries the queenId StartPlacement.finish gave that seat.
const RULES_27: SimConfig = playable(rulesConfig("redesign"));
const SEED = 7001;

// Seat order is not pick order: each colony's queenIds follow seat order (StartPlacement.finish).
const SEATS: LobbySeat[] = [
  { identityId: "ann", displayName: "Ann", colony: 0 }, { identityId: "bob", displayName: "Bob", colony: 1 },
  { identityId: "cat", displayName: "Cat", colony: 0 }, { identityId: "dan", displayName: "Dan", colony: 1 },
  { identityId: "eve", displayName: "Eve", colony: 0 },
];

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

function setup(simConfig: SimConfig) {
  const clock = { now: 1000 };
  const lines: string[] = [];
  const game = new Game({ simConfig, mcpConfig: TEST_MCP_CONFIG, now: () => clock.now, startPickWindowMs: 5000, onLogLine: line => lines.push(line),
    slot: { identityOf: async key => key.endsWith("-key") ? key.slice(0, -"-key".length) : undefined,
      locate: async () => ({ slot: "public-0", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" }) } });
  game.seatLobby("queen-lobby", SEATS);
  return { game, clock, lines };
}

async function connect(game: Game) {
  const server = new McpServer({ name: "lobby-join-queen", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "lobby-join-queen", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    return result.structuredContent as any;
  };
}

/** Legal starting tiles in a colony box of the board the lobby freezes: no water, rock or food. */
function legalTiles(config: SimConfig, box: { x: number; y: number; width: number; height: number }, count: number): { tileX: number; tileY: number }[] {
  const board = createMatch(SEED, config);
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let y = box.y; y < box.y + box.height && tiles.length < count; y += 2) for (let x = box.x; x < box.x + box.width && tiles.length < count; x += 2) {
    if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * board.config.mapWidth + x] === 0) tiles.push({ tileX: x, tileY: y });
  }
  return tiles;
}

/** Every logged join input, by agentId, from the tick lines the game wrote. */
function loggedJoins(lines: readonly string[]): Map<string, Extract<SimInput, { type: "join" }>> {
  const joins = new Map<string, Extract<SimInput, { type: "join" }>>();
  for (const line of lines.slice(1)) {
    for (const input of (JSON.parse(line) as { inputs: SimInput[] }).inputs) if (input.type === "join") joins.set(input.agentId, input);
  }
  return joins;
}

/**
 * The lobby: Ann, Bob, Cat and Dan join before the pick window closes and are queued for the
 * first tick; Eve joins live after the match starts. Cat, Bob and Ann pick in that order
 * (not seat order); Dan and Eve take default tiles.
 */
async function playLobby(config: SimConfig) {
  const { game, clock, lines } = setup(config);
  const agents = new Map<string, string>();
  const calls = new Map<string, Awaited<ReturnType<typeof connect>>>();
  for (const id of ["ann", "bob", "cat", "dan"]) {
    const call = await connect(game);
    const joined = await call("join", { key: `${id}-key`, modelLabel: `${id}-model` });
    agents.set(id, joined.agentId as string);
    calls.set(id, call);
  }
  game.beginLobbyStart(SEED);
  const picks = new Map<string, { tileX: number; tileY: number }>();
  const [cat, ann] = legalTiles(config, game.nestSelection(agents.get("ann")!)!.box, 2);
  const [bob] = legalTiles(config, game.nestSelection(agents.get("bob")!)!.box, 1);
  for (const [id, tile] of [["cat", cat!], ["bob", bob!], ["ann", ann!]] as const) {
    await calls.get(id)!("pick_nest", tile);
    picks.set(id, tile);
  }
  clock.now += 5000;
  game.finishLobbyStart();
  game.tick();
  const eve = await connect(game);
  const pending = eve("join", { key: "eve-key", modelLabel: "eve-model" });
  while (game.pendingInputs === 0) await new Promise(resolve => setImmediate(resolve));
  game.tick();
  agents.set("eve", (await pending).agentId as string);
  return { game, lines, agents, picks };
}

describe("rules-27 lobby seats join with their starting queen", () => {
  it("LobbyStart keeps each seat key's queenId as StartPlacement.finish assigned it", () => {
    const roster = SEATS.map(seat => ({ identityId: seat.identityId, colony: seat.colony }));
    const lobby = new LobbyStart(SEED, RULES_27, roster, 0, 10);
    const placement = new StartPlacement(lobby.config, roster, 0, () => null, 10);
    expect(lobby.queenIdOf("ann")).toBeUndefined();
    lobby.finish(10);
    for (const nest of placement.finish(10)) expect(lobby.queenIdOf(nest.identityId)).toBe(nest.queenId);
    expect(SEATS.map(seat => lobby.queenIdOf(seat.identityId))).toEqual([0, 0, 1, 1, 2]);
    expect(lobby.queenIdOf("stranger")).toBeUndefined();
  });

  it("each seat's logged join, queued for the first tick or sent live, carries the queenId of the starting queen on its tile", async () => {
    const { game, lines, agents, picks } = await playLobby(RULES_27);
    const state = game.match!.state;
    expect(JSON.parse(lines[0]!).rulesVersion).toBe(27);
    const joins = loggedJoins(lines);
    // Queued seats join on the first tick's line; the late seat's live join is on a later line.
    const firstTick = JSON.parse(lines[1]!) as { tick: number; inputs: SimInput[] };
    expect(firstTick.tick).toBe(0);
    expect(firstTick.inputs.map(input => input.agentId)).toEqual(["ann", "bob", "cat", "dan"].map(id => agents.get(id)));
    expect(firstTick.inputs.some(input => input.agentId === agents.get("eve"))).toBe(false);
    expect([...joins.keys()].sort()).toEqual([...agents.values()].sort());

    const expected: Record<string, number> = { ann: 0, bob: 0, cat: 1, dan: 1, eve: 2 };
    for (const seat of SEATS) {
      const join = joins.get(agents.get(seat.identityId)!)!;
      expect(join, seat.identityId).toEqual({ type: "join", agentId: agents.get(seat.identityId), placement: seat.colony, modelLabel: `${seat.identityId}-model`, queenId: expected[seat.identityId] });
      const queen = state.colonies[seat.colony].queens![join.queenId!]!;
      expect(queen.starting).toBe(true);
      const pick = picks.get(seat.identityId);
      if (pick !== undefined) expect({ x: queen.queenX, y: queen.queenY }).toEqual({ x: tileCentre(pick.tileX), y: tileCentre(pick.tileY) });
    }
    // Every starting queen of each colony is carried by exactly one seat's join.
    for (const colony of [0, 1] as const) {
      const carried = SEATS.filter(seat => seat.colony === colony).map(seat => joins.get(agents.get(seat.identityId)!)!.queenId).sort();
      expect(carried).toEqual(state.colonies[colony].queens!.map(queen => queen.id).sort());
    }
  });

});
