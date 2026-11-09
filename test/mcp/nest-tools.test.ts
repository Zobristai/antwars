import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { registerTools } from "../../src/mcp/tools.js";
import { fitsReply, OBSERVE_REPLY_LIMITS } from "../../src/mcp/replies.js";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { startBoxes } from "../../src/sim/startPlacement.js";
import { TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});
const seats = Array.from({ length: 4 }, (_, n) => [
  { identityId: `left-${n}`, displayName: `Left-${n}-${"名".repeat(25)}`, colony: 0 as const },
  { identityId: `right-${n}`, displayName: `Right-${n}-${"名".repeat(24)}`, colony: 1 as const },
]).flat();
function setup(callsPerSecond = TEST_MCP_CONFIG.callsPerSecond, simConfig: SimConfig = playable(PUBLIC_CONFIG)) {
  const clock = { now: 0 };
  const game = new Game({ simConfig, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond }, now: () => clock.now,
    slot: { identityOf: async key => seats.find(seat => `${seat.identityId}-secret` === key)?.identityId,
      locate: async () => ({ slot: "test-slot", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" }) } });
  game.seatLobby("test-lobby", seats);
  game.beginLobbyStart(7001);
  return { game, clock };
}
async function connect(game: Game) {
  const server = new McpServer({ name: "nest-test", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "nest-test", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      expect(JSON.parse(text)).toEqual(result.structuredContent);
      expect(fitsReply(result as any, name === "join" || name === "observe" ? OBSERVE_REPLY_LIMITS : undefined)).toBe(true);
      return { error: result.isError === true, data: result.structuredContent as any, text };
    },
  };
}

describe("authenticated lobby nest MCP tools", () => {
  it("keeps a not-played seat's true outcome after its slot seats another lobby", async () => {
    const { game, clock } = setup();
    game.seatLobby("missed-house-lobby", seats, "house-4v4");
    game.beginLobbyStart(7001);
    const oldSeat = await connect(game), outsider = await connect(game);
    await oldSeat.call("join", { key: "left-0-secret" });
    clock.now = 120_000;
    expect(() => game.finishLobbyStart()).toThrow();
    game.endNotPlayed();
    expect((await oldSeat.call("pick_nest", { tileX: 8, tileY: 24 })).data.error.code).toBe("match_not_played");
    game.seatLobby("next-lobby", seats);
    game.beginLobbyStart(7002);
    expect((await oldSeat.call("pick_nest", { tileX: 8, tileY: 24 })).data).toMatchObject({ error: { code: "match_not_played" } });
    expect((await oldSeat.call("pick_nest", { tileX: 8, tileY: 24 })).data.nestSelection).toBeUndefined();
    expect((await outsider.call("pick_nest", { tileX: 8, tileY: 24 })).data.error.code).toBe("nest_not_seated");
  });

  it("reports window closed for a played seat even when a new lobby opens its window", async () => {
    const { game, clock } = setup();
    const oldSeat = await connect(game);
    await oldSeat.call("join", { key: "left-0-secret" });
    clock.now = 120_000;
    game.finishLobbyStart();
    game.seatLobby("next-lobby", seats);
    game.beginLobbyStart(7002);
    const reply = await oldSeat.call("pick_nest", { tileX: 8, tileY: 24 });
    expect(reply.data.error.code).toBe("nest_window_closed");
    expect(reply.data.nestSelection).toBeUndefined();
    const newSeat = await connect(game);
    expect((await newSeat.call("join", { key: "left-0-secret" })).data.nestSelection.picks).toEqual([]);
    expect((await newSeat.call("pick_nest", { tileX: 8, tileY: 24 })).data.accepted).toBe(true);
  });

  it("echoes bounded, typed received coordinates without discarding a standing pick", async () => {
    const { game } = setup();
    const agent = await connect(game);
    await agent.call("join", { key: "left-0-secret" });
    await agent.call("pick_nest", { tileX: 8, tileY: 24 });
    const cases: [Record<string, unknown>, string][] = [
      [{ tileX: "8", tileY: 24 }, 'tileX="8", tileY=24'],
      [{ tileX: 8 }, 'tileX=8, tileY=missing'],
      [{ x: 8, y: 24 }, 'tileX=missing, tileY=missing'],
      [{ tileX: 8.5, tileY: 24 }, 'tileX=8.5, tileY=24'],
      [{ tileX: null, tileY: false }, 'tileX=null, tileY=false'],
      [{ tileX: { nested: "value" }, tileY: [] }, 'tileX={object}, tileY=[array]'],
      [{ tileX: "名".repeat(100_000), tileY: 24 }, 'tileY=24'],
    ];
    for (const [args, received] of cases) {
      const reply = await agent.call("pick_nest", args);
      expect(reply.error).toBe(true);
      expect(reply.data.error.code).toBe("nest_invalid_tile");
      expect(reply.data.error.message).toContain(received);
      expect(reply.data.error.message.length).toBeLessThan(250);
      expect(reply.data.nestSelection.picks[0]).toMatchObject({ tileX: 8, tileY: 24 });
    }
  });

  it("tells house seats that every pick is mandatory in join, observe, rules and tool guidance", async () => {
    const { game } = setup();
    game.seatLobby("house-lobby", seats, "house-4v4");
    game.beginLobbyStart(7001);
    const left = await connect(game);
    const tools = await left.client.listTools();
    expect(tools.tools.find(tool => tool.name === "pick_nest")!.description).toContain("120-second window");
    expect(tools.tools.find(tool => tool.name === "pick_nest")!.description).toMatch(/In index matches every seat must pick or the match is not played, with no rating change/i);
    for (const [name, args] of [["join", { key: "left-0-secret" }], ["observe", {}], ["rules", {}]] as const) {
      const reply = await left.call(name, args);
      expect(reply.data.nestSelection.required).toBe(true);
      if (name === "join") expect(reply.data.briefing).toContain("If your nest window is open, call pick_nest first, then read rules.");
      expect(reply.data.nestSelection.rules).toContain("120-second window");
      expect(reply.data.nestSelection.rules).toContain("outsiders see finalized nests on the feed or through normal ant sight after play starts");
      expect(reply.data.nestSelection.rules).not.toContain("delayed feed");
      expect(reply.data.nestSelection.rules).toMatch(/In index matches every seat must pick before closesAt/i);
      expect(reply.data.nestSelection.rules).toMatch(/any missing pick ends the match as not played, with no rating change and no default nests/i);
      expect(reply.data.nestSelection.rules).not.toContain("Unpicked seats get distinct legal defaults");
    }
  });
  it.each(["4v4", null] as const)("keeps delayed-feed wording for non-house mode %s", async mode => {
    const { game } = setup();
    game.seatLobby("non-house-lobby", seats, mode);
    game.beginLobbyStart(7001);
    const agent = await connect(game);
    for (const [name, args] of [["join", { key: "left-0-secret" }], ["observe", {}], ["rules", {}]] as const) {
      const reply = await agent.call(name, args);
      expect(reply.data.nestSelection.required).toBe(false);
      expect(reply.data.nestSelection.rules).toContain("outsiders see finalized nests on the delayed feed or through normal ant sight after play starts");
    }
    expect((await agent.client.listTools()).tools.find(tool => tool.name === "pick_nest")!.description)
      .toContain("In ranked matches a seat that has not joined the match by the idle limit, counted from match start, ends it abandoned, with no rating change.");
  });
  it("shows every teammate pick in join/rejoin/observe/rules; strangers and opponents cannot see them", async () => {
    const { game } = setup();
    const left = await connect(game), right = await connect(game), outsider = await connect(game);
    expect((await outsider.call("pick_nest", { tileX: 8, tileY: 24 })).data.error.code).toBe("nest_not_seated");
    expect((await outsider.call("rules")).data.nestSelection).toBeUndefined();
    expect((await outsider.call("join", { key: "unknown" })).error).toBe(true);
    const joined = await left.call("join", { key: "left-0-secret" });
    expect(joined.data.nestSelection).toMatchObject({ box: startBoxes(game.simConfig)[0], closesAt: "1970-01-01T00:02:00.000Z", picks: [] });
    const picked = await left.call("pick_nest", { tileX: 8, tileY: 24 });
    expect(picked.data.accepted).toBe(true);
    for (const name of ["observe", "rules"]) {
      const reply = await left.call(name);
      expect(reply.data.nestSelection.picks).toEqual([{ displayName: seats[0]!.displayName, mine: true, tileX: 8, tileY: 24 }]);
      expect(reply.text).not.toContain("secret"); expect(reply.text).not.toContain("identityId");
    }
    const teammate = await connect(game);
    expect((await teammate.call("join", { key: "left-1-secret" })).data.nestSelection.picks[0].mine).toBe(false);
    expect((await right.call("join", { key: "right-0-secret" })).data.nestSelection.picks).toEqual([]);
    for (const name of ["observe", "rules", "locate_match"]) {
      const reply = await right.call(name, name === "locate_match" ? { lobbyId: "test-lobby" } : {});
      expect(reply.text).not.toContain(seats[0]!.displayName);
      if (name !== "locate_match") expect(reply.data.nestSelection.picks).toEqual([]);
    }
    expect((await teammate.call("pick_nest", { tileX: 8, tileY: 24 })).data.error.code).toBe("nest_occupied");
    expect((await left.call("pick_nest", { tileX: 9, tileY: 24 })).error).toBe(false);
    const reconnect = await connect(game);
    const rejoined = await reconnect.call("join", { key: "left-0-secret" });
    expect(rejoined.data.agentId).toBe(joined.data.agentId);
    expect(rejoined.data.nestSelection.picks[0]).toMatchObject({ mine: true, tileX: 9, tileY: 24 });
    expect(game.match).toBeNull();
  });

  it("names every refusal and preserves a prior pick, without reserving the centre or requiring founding spacing", async () => {
    const { game, clock } = setup();
    const agent = await connect(game);
    await agent.call("join", { key: "left-0-secret" });
    expect((await agent.call("pick_nest", { tileX: 8, tileY: 24 })).error).toBe(false);
    const board = createMatch(7001, playable(PUBLIC_CONFIG));
    const box = game.nestSelection((await agent.call("join", { key: "left-0-secret" })).data.agentId)!.box;
    for (const [tileX, tileY, reason] of [[55, 24, "outside_box"], [8.5, 24, "invalid_tile"], ["8", 24, "invalid_tile"]] as const) {
      const refused = await agent.call("pick_nest", { tileX, tileY });
      expect(refused.error).toBe(true); expect(refused.data.error.code).toBe(`nest_${reason}`);
      expect(refused.data.nestSelection.picks[0]).toMatchObject({ tileX: 8, tileY: 24 });
    }
    // Classify every blocked tile on the real frozen board, not fabricated obstacles.
    const reasons = new Set<string>();
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
      const reason = isWaterTile(board.terrain, x, y) ? "water" : isRockTile(board.terrain, x, y) ? "rock"
        : board.food[y * board.config.mapWidth + x]! > 0 ? "food" : null;
      if (reason === null) continue;
      reasons.add(reason);
      const refused = await agent.call("pick_nest", { tileX: x, tileY: y });
      expect(refused.data.error.code).toBe(`nest_${reason}`);
      expect(refused.data.nestSelection.picks[0]).toMatchObject({ tileX: 8, tileY: 24 });
    }
    expect([...reasons].sort()).toEqual(["food", "rock"]);
    clock.now = 60_000;
    expect((await agent.call("pick_nest", { tileX: 8, tileY: 24 })).data.accepted).toBe(true);
    clock.now = 120_000;
    const closed = await agent.call("pick_nest", { tileX: 9, tileY: 24 });
    expect(closed.data.error.code).toBe("nest_window_closed");
    expect(closed.data.error.howToFix).toContain("120-second window");
    game.finishLobbyStart();
    expect(game.match!.state.colonies[0].queens![0]).toMatchObject({ queenX: 8500, queenY: 24500 });
    expect((await agent.call("pick_nest", { tileX: 9, tileY: 24 })).data.error.code).toBe("nest_window_closed");
  });

  it("refuses water on a real custom board without dropping a standing pick", async () => {
    const simConfig: SimConfig = { ...playable(PUBLIC_CONFIG), terrain: { ...PUBLIC_CONFIG.terrain!, mapId: "pick-water",
      maps: [{ id: "pick-water", name: "Pick water", water: [{ x: 3, y: 20, width: 1, height: 1 }, { x: 60, y: 20, width: 1, height: 1 }] }] } };
    const { game } = setup(TEST_MCP_CONFIG.callsPerSecond, simConfig), agent = await connect(game);
    await agent.call("join", { key: "left-0-secret" });
    expect((await agent.call("pick_nest", { tileX: 8, tileY: 24 })).error).toBe(false);
    // The map's water cell (3,20) is drawn at grid scale 2 over fine tiles 6-7 x 40-41, inside colony 0's box.
    const refused = await agent.call("pick_nest", { tileX: 6, tileY: 40 });
    expect(refused.data.error.code).toBe("nest_water");
    expect(refused.data.nestSelection.picks[0]).toMatchObject({ tileX: 8, tileY: 24 });
  });

  it("fits complete replies with eight maximum-length names and every seat picked", async () => {
    const { game } = setup();
    const board = createMatch(7001, playable(PUBLIC_CONFIG));
    // The live food recipe may occupy an old hardcoded pick. Keep four legal
    // distinct picks (and all maximum-length names), not a food-refusal reply.
    const box = startBoxes(board.config)[0], width = board.config.mapWidth;
    const offsets = Array.from({ length: box.width * box.height }, (_, i) => [box.x + i % box.width, box.y + Math.floor(i / box.width)] as const)
      .filter(([x, y]) => !isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * width + x] === 0)
      .slice(0, 4);
    expect(offsets).toHaveLength(4);
    for (const seat of seats) {
      expect([...seat.displayName]).toHaveLength(32);
      const agent = await connect(game);
      await agent.call("join", { key: `${seat.identityId}-secret` });
      const index = Number(seat.identityId.split("-")[1]);
      const [x, tileY] = offsets[index]!;
      expect((await agent.call("pick_nest", { tileX: seat.colony === 0 ? x : width - 1 - x, tileY })).error).toBe(false);
    }
    for (const seat of seats) {
      const agent = await connect(game);
      for (const name of ["join", "observe", "rules"]) {
        const reply = await agent.call(name, name === "join" ? { key: `${seat.identityId}-secret` } : {});
        expect(reply.error).toBe(false);
        expect(reply.data.nestSelection.picks).toHaveLength(4);
        expect(reply.data.nestSelection.picks.filter((pick: { mine: boolean }) => pick.mine)).toHaveLength(1);
        expect(reply.text).not.toContain(seat.colony === 0 ? "Right-" : "Left-");
      }
    }
  });

  it("shares the existing seat rate limit across picks, observe and reconnects", async () => {
    const { game, clock } = setup(2), agent = await connect(game);
    await agent.call("join", { key: "left-0-secret" });
    expect((await agent.call("pick_nest", { tileX: 8, tileY: 24 })).error).toBe(false);
    expect((await agent.call("pick_nest", { tileX: 9, tileY: 24 })).data).toMatchObject({ error: { code: "call_rate" }, retryAfterMs: 1000 });
    expect((await agent.call("observe")).data.error.code).toBe("call_rate");
    clock.now = 1000;
    expect((await agent.call("pick_nest", { tileX: 9, tileY: 24 })).error).toBe(false);
  });

  it("does not advertise a pick window on local games", async () => {
    const game = new Game({ simConfig: playable(PUBLIC_CONFIG) }), agent = await connect(game);
    expect((await agent.client.listTools()).tools.some(tool => tool.name === "pick_nest")).toBe(false);
    expect((await agent.call("rules")).data.nestSelection).toBeUndefined();
  });
});

it("advertises and enforces the new strip through the real nest tool while preserving reported historical bounds", async () => {
  const config = newMatchConfig(PUBLIC_CONFIG), { game } = setup(1000, config);
  const agent = await connect(game);
  const tools = (await agent.client.listTools()).tools;
  const pick = tools.find(tool => tool.name === "pick_nest")!;
  expect(pick.description).toContain("full-height back-quarter strip");
  expect(JSON.stringify(pick.inputSchema)).toContain("full map height");
  const joined = await agent.call("join", { key: "left-0-secret" });
  expect(joined.data.nestSelection.box).toEqual({ x: 0, y: 0, width: 32, height: 96 });
  expect(joined.data.nestSelection.rules).toContain("full-height strip");
  expect(joined.data.nestSelection.rules).toContain("nearest the default nest first");
  expect(joined.data.nestSelection.rules).not.toContain("nearest the box centre");
  const board = createMatch(7001, config);
  for (const tileY of [0, config.mapHeight - 1]) {
    const tileX = Array.from({ length: config.mapWidth / 4 }, (_, x) => x).find(x =>
      !isWaterTile(board.terrain, x, tileY) && !isRockTile(board.terrain, x, tileY) && board.food[tileY * config.mapWidth + x] === 0)!;
    expect(tileX).toBeDefined();
    expect((await agent.call("pick_nest", { tileX, tileY })).data.accepted).toBe(true);
  }
  const refusal = await agent.call("pick_nest", { tileX: 32, tileY: 0 });
  expect(refusal.data.error).toMatchObject({ code: "nest_outside_box" });
  expect(refusal.data.error.message).toContain("full-height back-quarter strip");
  expect(refusal.data.nestSelection.picks[0].tileY).toBe(95);
});
