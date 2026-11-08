import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game, seatKeyOf, type LobbySeat } from "../../src/mcp/game.js";
import { registerTools } from "../../src/mcp/tools.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

// One identity holding every seat of its colony joins,
// picks a nest and rejoins per seat; a single-seat identity still joins by key alone.
const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

/** The stored shape a team-mode pairing writes: each identity repeated `size` times on its own colony, numbered as seatsOf numbers it. */
function teamSeats(size: number): LobbySeat[] {
  return [
    ...Array.from({ length: size }, (_, n) => ({ identityId: "ann", displayName: "Ann", colony: 0 as const, seat: n + 1 })),
    ...Array.from({ length: size }, (_, n) => ({ identityId: "bob", displayName: "Bob", colony: 1 as const, seat: n + 1 })),
  ];
}

/** Legal starting tiles in a colony box of the board seed 7001 freezes: no water, rock or food. */
function legalTiles(box: { x: number; y: number; width: number; height: number }, count: number): { tileX: number; tileY: number }[] {
  const board = createMatch(7001, playable(PUBLIC_CONFIG));
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let y = box.y; y < box.y + box.height && tiles.length < count; y += 2) for (let x = box.x; x < box.x + box.width && tiles.length < count; x += 2) {
    if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * board.config.mapWidth + x] === 0) tiles.push({ tileX: x, tileY: y });
  }
  return tiles;
}

function setup(seats: readonly LobbySeat[]) {
  const clock = { now: 1000 };
  const recorded: string[] = [];
  const game = new Game({ simConfig: playable(PUBLIC_CONFIG), mcpConfig: TEST_MCP_CONFIG, now: () => clock.now, startPickWindowMs: 5000,
    slot: { identityOf: async key => key.endsWith("-key") ? key.slice(0, -"-key".length) : undefined,
      locate: async () => ({ slot: "public-0", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" }),
      recordJoin: async identityId => { recorded.push(identityId); } } });
  game.seatLobby("team-lobby", seats);
  return { game, clock, recorded };
}

async function connect(game: Game) {
  const server = new McpServer({ name: "team-seats", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "team-seats", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { error: result.isError === true, data: result.structuredContent as any };
    },
  };
}

describe("per-seat slot join for an identity holding every seat of its colony", () => {
  it("seatKeyOf is the identity id for seat 1 or an absent seat, and identity#n otherwise", () => {
    expect(seatKeyOf({ identityId: "ann", seat: 1 })).toBe("ann");
    expect(seatKeyOf({ identityId: "ann" })).toBe("ann");
    expect(seatKeyOf({ identityId: "ann", seat: 3 })).toBe("ann#3");
  });

  it.each([2, 3, 4])("%i seats per colony: each seat joins from its own session, picks its own nest, rejoins the same seat and plays as its own agent", async (size) => {
    const { game, clock, recorded } = setup(teamSeats(size));
    const probe = await connect(game);
    const required = await probe.call("join", { key: "ann-key" });
    expect(required.data.error.code).toBe("seat_required");
    expect(required.data.error.howToFix).toContain(`1 to ${size}`);
    for (const seat of [0, size + 1, 1.5]) expect((await probe.call("join", { key: "ann-key", seat })).data.error.code).toBe("no_such_seat");
    expect(game.queuedAgents).toBe(0);

    const sessions = [];
    for (const identity of ["ann", "bob"]) {
      for (let seat = 1; seat <= size; seat++) {
        const session = await connect(game);
        const joined = await session.call("join", { key: `${identity}-key`, seat, modelLabel: "same-model", thinkingLevel: `${identity}-${seat}` });
        expect(joined.error, JSON.stringify(joined.data)).toBe(false);
        sessions.push({ identity, seat, session, agentId: joined.data.agentId as string });
      }
    }
    // Every seat is its own agent, keyed by its own seat key.
    expect(new Set(sessions.map(s => s.agentId)).size).toBe(2 * size);
    for (const s of sessions) expect(game.agentInfo(s.agentId)?.seatKey).toBe(seatKeyOf({ identityId: s.identity, seat: s.seat }));

    game.beginLobbyStart(7001);
    const anns = sessions.filter(s => s.identity === "ann");
    const tiles = legalTiles(game.nestSelection(anns[0]!.agentId)!.box, size);
    for (const [n, s] of anns.entries()) {
      const picked = await s.session.call("pick_nest", tiles[n]!);
      expect(picked.error, JSON.stringify(picked.data)).toBe(false);
    }
    // A teammate seat of the same identity may not take another seat's tile.
    expect((await anns[0]!.session.call("pick_nest", tiles[1]!)).data.error.code).toBe("nest_occupied");
    for (const [n, s] of anns.entries()) {
      const picks = (await s.session.call("observe")).data.nestSelection.picks;
      expect(picks).toEqual(anns.map((_, m) => ({ displayName: `Ann #${m + 1}`, mine: m === n, ...tiles[m]! })));
    }
    expect((await sessions.find(s => s.identity === "bob")!.session.call("observe")).data.nestSelection.picks).toEqual([]);

    // Rejoining with the same key and seat, from a new session, returns that seat.
    const last = anns.at(-1)!;
    const again = await connect(game);
    const rejoined = await again.call("join", { key: "ann-key", seat: last.seat, thinkingLevel: "replacement" });
    expect(rejoined.data.agentId).toBe(last.agentId);
    expect(rejoined.data.nestSelection.picks.filter((pick: { mine: boolean }) => pick.mine)).toEqual([{ displayName: `Ann #${size}`, mine: true, ...tiles[size - 1]! }]);
    expect(game.queuedAgents).toBe(2 * size);

    clock.now += 5000;
    game.finishLobbyStart();
    game.tick();
    const state = game.match!.state;
    expect(state.agents.map(agent => agent.id).sort()).toEqual(sessions.map(s => s.agentId).sort());
    for (const s of sessions) {
      const agent = state.agents.find(agent => agent.id === s.agentId)!;
      expect(agent.colony).toBe(s.identity === "ann" ? 0 : 1);
      expect(agent.thinkingLevel).toBe(`${s.identity}-${s.seat}`);
    }
    expect(state.config.initialQueens![0]).toEqual(expect.arrayContaining(tiles));
    expect(state.config.initialQueens![0]).toHaveLength(size);
    expect(state.config.initialQueens![1]).toHaveLength(size);
    // Join activity is the seat's identity, never its seat key.
    await new Promise(resolve => setImmediate(resolve));
    expect(new Set(recorded)).toEqual(new Set(["ann", "bob"]));

    const live = await connect(game);
    const pending = live.call("join", { key: "bob-key", seat: 2 });
    while (game.pendingInputs === 0) await new Promise(resolve => setImmediate(resolve));
    game.tick();
    const liveRejoin = await pending;
    expect(liveRejoin.data.agentId).toBe(sessions.find(s => s.identity === "bob" && s.seat === 2)!.agentId);
  });

  it("a single-seat identity joins with only its key, or with seat 1, and has no other seat", async () => {
    const seats: LobbySeat[] = [
      { identityId: "ann", displayName: "Ann", colony: 0, seat: 1 }, { identityId: "cat", displayName: "Cat", colony: 0, seat: 1 },
      { identityId: "bob", displayName: "Bob", colony: 1, seat: 1 }, { identityId: "dan", displayName: "Dan", colony: 1, seat: 1 },
    ];
    const { game } = setup(seats);
    const ann = await connect(game);
    const joined = await ann.call("join", { key: "ann-key" });
    expect(joined.error, JSON.stringify(joined.data)).toBe(false);
    const again = await connect(game);
    expect((await again.call("join", { key: "ann-key", seat: 1 })).data.agentId).toBe(joined.data.agentId);
    expect((await again.call("join", { key: "ann-key", seat: 2 })).data.error.code).toBe("no_such_seat");
    expect((await (await connect(game)).call("join", { key: "cat-key" })).error).toBe(false);
    expect(game.agentInfo(joined.data.agentId)?.seatKey).toBe("ann");
    game.beginLobbyStart(7001);
    const [tile] = legalTiles(game.nestSelection(joined.data.agentId)!.box, 1);
    expect((await ann.call("pick_nest", tile!)).error).toBe(false);
    expect((await ann.call("observe")).data.nestSelection.picks).toEqual([{ displayName: "Ann", mine: true, ...tile! }]);
  });

  it("treats an absent seat number as seat 1", async () => {
    const { game } = setup([{ identityId: "ann", displayName: "Ann", colony: 0 }, { identityId: "bob", displayName: "Bob", colony: 1 }]);
    expect(seatKeyOf({ identityId: "ann" })).toBe(seatKeyOf({ identityId: "ann", seat: 1 }));
    const keyOnly = await (await connect(game)).call("join", { key: "ann-key" });
    expect(game.agentInfo(keyOnly.data.agentId)?.seatKey).toBe("ann");
    const seatOne = await (await connect(game)).call("join", { key: "bob-key", seat: 1 });
    expect(game.agentInfo(seatOne.data.agentId)?.seatKey).toBe("bob");
  });
});
