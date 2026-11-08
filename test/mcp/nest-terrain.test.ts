import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS, MAX_RULES_REPLY_BYTES, MAX_RULES_TEXT_CHARS } from "../../src/mcp/replies.js";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { startBoxes, type StartBox, type StartTerrain, type StartTile } from "../../src/sim/startPlacement.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { RankedMode } from "../../src/rating/ratings.js";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { startHarness, type Harness, type TestAgent } from "./harness.js";
import { replyFixtureConfig } from "./response-size-fixture.js";

interface WindowView {
  box: StartBox;
  closesAt: string;
  required: boolean;
  terrain?: StartTerrain;
  picks: (StartTile & { displayName: string; mine: boolean })[];
  rules: string;
}
const modes: (RankedMode | null)[] = [null, "1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"];
const roster = (size = 4) => Array.from({ length: size * 2 }, (_, i) => ({
  identityId: `private-identity-${i}`, displayName: `${i}${"名".repeat(31)}`, colony: (i % 2) as 0 | 1,
}));
const seed = 7001;
// Real generated rock/food plus asymmetric water inside both historical boxes.
// Asymmetry catches accidentally mirroring a row instead of using global x order.
const waterConfig: SimConfig = { ...PUBLIC_CONFIG, terrain: { ...PUBLIC_CONFIG.terrain!, mapId: "nest-water", maps: [{
  id: "nest-water", name: "Nest water", water: [{ x: 3, y: 20, width: 1, height: 1 }, { x: 59, y: 21, width: 1, height: 1 }],
}] } };

async function fixture(config = newMatchConfig(PUBLIC_CONFIG), mode: RankedMode | null = "4v4", size = 4) {
  const seats = roster(size);
  const h = await startHarness({ simConfig: config, start: false, slot: {
    identityOf: async key => seats.find(seat => `key-${seat.identityId}` === key)?.identityId,
    locate: async () => undefined,
  } });
  h.game.seatLobby("terrain-lobby", seats, mode);
  return { h, seats };
}
const windowOf = (data: { nestSelection: WindowView }): WindowView => data.nestSelection;
function tiles(window: WindowView, symbol: string): StartTile[] {
  return window.terrain!.rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === symbol
    ? [{ tileX: window.box.x + x, tileY: window.box.y + y }] : []));
}
function expectBoard(window: WindowView, config: SimConfig, colony: 0 | 1) {
  // The drawn match's own config: a board map plays at its own size.
  const board = createMatch(seed, config);
  expect(window.box).toEqual(startBoxes(board.config)[colony]);
  expect(Object.keys(window.terrain!).sort()).toEqual(["legend", "rows"]);
  expect(window.terrain!.legend).toContain("rows[tileY-box.y][tileX-box.x]");
  expect(window.terrain!.legend).toContain(".=free,w=water,r=rock,f=food");
  expect(window.terrain!.legend).toContain("teammates' picks");
  expect(window.terrain!.rows).toHaveLength(window.box.height);
  for (const [rowIndex, row] of window.terrain!.rows.entries()) {
    expect(row).toHaveLength(window.box.width);
    for (const [column, symbol] of [...row].entries()) {
      const x = window.box.x + column, y = window.box.y + rowIndex;
      const expected = isWaterTile(board.terrain, x, y) ? "w" : isRockTile(board.terrain, x, y) ? "r"
        : board.food[y * board.config.mapWidth + x]! > 0 ? "f" : ".";
      expect(symbol, `${x},${y}`).toBe(expected);
    }
  }
}
async function join(h: Harness, identityId: string) {
  const agent = await h.connect();
  const reply = await agent.call("join", { key: `key-${identityId}` });
  expect(reply.isError).toBe(false);
  return { agent, reply };
}

describe("private nest-window terrain", () => {
  it.each(modes.map(mode => ({ mode })))("join/observe agree with pick_nest in $mode", async ({ mode }) => {
    const config = { ...newMatchConfig(waterConfig), terrain: waterConfig.terrain };
    const size = mode === null ? 4 : Number(mode.replace("house-", "")[0]);
    const { h, seats } = await fixture(config, mode, size);
    try {
      h.game.beginLobbyStart(seed);
      for (const colony of [0, 1] as const) {
        const seat = seats[colony]!;
        const { agent, reply } = await join(h, seat.identityId);
        const window = windowOf(reply.data);
        expectBoard(window, config, colony);
        expect(window.closesAt).toBe("1970-01-01T00:02:00.000Z");
        expect(window.required).toBe(mode?.startsWith("house-") === true);
        expect(reply.data.briefing).toContain("join/observe nestSelection.terrain");
        expect(window.rules).toContain("join/observe nestSelection.terrain");
        const free = tiles(window, ".")[0]!;
        expect((await agent.call("pick_nest", { ...free })).data.accepted).toBe(true);
        for (const [symbol, reason] of [["w", "water"], ["r", "rock"], ["f", "food"]] as const) {
          const blocked = tiles(window, symbol)[0];
          expect(blocked, reason).toBeDefined();
          const refusal = await agent.call("pick_nest", { ...blocked! });
          expect(refusal.isError).toBe(true);
          expect(refusal.data.error.code).toBe(`nest_${reason}`);
          expect(refusal.data.nestSelection.picks.find((pick: { mine: boolean }) => pick.mine)).toMatchObject(free);
          expect(refusal.data.nestSelection).not.toHaveProperty("terrain");
        }
        const observed = await agent.call("observe");
        expect(windowOf(observed.data).terrain).toEqual(window.terrain);
        expect(windowOf((await agent.call("observe", { map: true })).data).terrain).toEqual(window.terrain);
        const rejoined = await join(h, seat.identityId);
        expect(windowOf(rejoined.reply.data).terrain).toEqual(window.terrain);
        const rules = await agent.call("rules");
        expect(rules.isError).toBe(false);
        expect(rules.data.nestSelection).not.toHaveProperty("terrain");
        expect(rules.data.nestSelection.rules).not.toContain("nestSelection.terrain");
        expect(observed.text).not.toContain("identityId");
        expect(observed.text).not.toContain("private-identity");
        for (const opponent of seats.filter(other => other.colony !== colony)) expect(observed.text).not.toContain(opponent.displayName);
      }
      expect(h.game.match).toBeNull();
    } finally { await h.close(); }
  });

  it("uses existing teammate picks for occupancy without changing the frozen terrain or exposing opponent picks", async () => {
    const { h, seats } = await fixture();
    try {
      h.game.beginLobbyStart(seed);
      const left = await join(h, seats[0]!.identityId), right = await join(h, seats[1]!.identityId);
      const window = windowOf(left.reply.data), free = tiles(window, ".");
      expect((await left.agent.call("pick_nest", { ...free[0]! })).data.accepted).toBe(true);
      expect((await right.agent.call("pick_nest", { ...tiles(windowOf(right.reply.data), ".")[0]! })).data.accepted).toBe(true);
      const teammate = await join(h, seats[2]!.identityId);
      const shared = windowOf(teammate.reply.data);
      expect(shared.picks).toEqual([{ displayName: seats[0]!.displayName, mine: false, ...free[0]! }]);
      expect(shared.terrain).toEqual(window.terrain);
      expect((await teammate.agent.call("pick_nest", { ...free[0]! })).data.error.code).toBe("nest_occupied");
      const available = tiles(shared, ".").find(tile => !shared.picks.some(pick => pick.tileX === tile.tileX && pick.tileY === tile.tileY))!;
      expect((await teammate.agent.call("pick_nest", { ...available })).data.accepted).toBe(true);
      expect((await left.agent.call("pick_nest", { ...free[0]! })).data.accepted).toBe(true);
      const outsider = await h.connect();
      for (const name of ["rules", "observe", "pick_nest"]) expect((await outsider.call(name)).data).not.toHaveProperty("nestSelection");
      expect((await outsider.call("join", { key: "not-seated" })).data).not.toHaveProperty("nestSelection");
      for (const queued of h.game.queuedLineup()) expect(queued).not.toHaveProperty("terrain");
    } finally { await h.close(); }
  });

  it("omits terrain before the window, at its deadline, after finalization and after lobby replacement", async () => {
    const { h, seats } = await fixture();
    try {
      const { agent, reply } = await join(h, seats[0]!.identityId);
      expect(reply.data).not.toHaveProperty("nestSelection");
      h.game.beginLobbyStart(seed);
      const opened = await agent.call("observe");
      expect(opened.data.nestSelection).toHaveProperty("terrain");
      h.clock.now = 119_999;
      expect((await agent.call("observe")).data.nestSelection).toHaveProperty("terrain");
      h.clock.now = 120_000;
      expect((await agent.call("observe")).data.nestSelection).not.toHaveProperty("terrain");
      expect((await agent.call("join", { key: `key-${seats[0]!.identityId}` })).data.nestSelection).not.toHaveProperty("terrain");
      h.game.finishLobbyStart();
      expect((await agent.call("observe")).data).not.toHaveProperty("nestSelection");
      h.game.seatLobby("next-lobby", seats);
      h.game.beginLobbyStart(seed + 1);
      expect((await agent.call("observe")).data).not.toHaveProperty("nestSelection");
      const next = await join(h, seats[0]!.identityId);
      expect(next.reply.data.nestSelection).toHaveProperty("terrain");
      h.game.endNotPlayed();
      for (const name of ["join", "observe", "rules"]) {
        const reply = await next.agent.call(name, name === "join" ? { key: `key-${seats[0]!.identityId}` } : {});
        expect(reply.data).not.toHaveProperty("nestSelection");
        expect(reply.data.error.code).toBe("match_not_played");
      }
    } finally { await h.close(); }
  });

  it("preserves default controller projections and returns defensive terrain rows", () => {
    const seats = roster();
    const config = newMatchConfig(PUBLIC_CONFIG);
    const lobby = new LobbyStart(seed, config, seats, 0);
    const view = lobby.teamView(seats[0]!.identityId)!;
    expect(view).toEqual({ box: startBoxes(config)[0], closesAt: 120_000, picks: [] });
    expect(lobby.teamView("outsider", true)).toBeNull();
    const terrain = lobby.teamView(seats[0]!.identityId, true)!.terrain!;
    const expected = structuredClone(terrain);
    (terrain.rows as string[])[0] = "mutated";
    expect(lobby.teamView(seats[0]!.identityId, true)!.terrain).toEqual(expected);
  });
});

async function completeReply(agent: TestAgent, name: string, args: Record<string, unknown> = {}) {
  const result = await agent.client.callTool({ name, arguments: args }) as CallToolResult;
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("");
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  expect(result.isError).not.toBe(true);
  return { result, size: { chars: text.length, bytes: Buffer.byteLength(JSON.stringify(result)) } };
}

it.each(replyFixtureConfig("redesign").terrain!.maps)("$name: its whole back-quarter box (32x96 on today's board) fits join/observe and keeps rules within 49,000 characters / 102,380 bytes", async map => {
  const config = replyFixtureConfig("redesign", map.id);
  const drawn = createMatch(seed, config).config;
  const { h, seats } = await fixture(config);
  try {
    h.game.beginLobbyStart(seed);
    const agents = [];
    for (const seat of seats) {
      expect([...seat.displayName]).toHaveLength(32);
      const joined = await join(h, seat.identityId);
      const window = windowOf(joined.reply.data);
      expect(window.box).toMatchObject({ width: drawn.mapWidth / 4, height: drawn.mapHeight });
      const free = tiles(window, ".").find(tile => !window.picks.some(pick => pick.tileX === tile.tileX && pick.tileY === tile.tileY))!;
      expect((await joined.agent.call("pick_nest", { ...free })).data.accepted).toBe(true);
      agents.push(joined.agent);
    }
    for (const [index, agent] of agents.entries()) {
      for (const name of ["join", "observe", "rules"]) {
        const { result, size } = await completeReply(agent, name, name === "join" ? { key: `key-${seats[index]!.identityId}` } : {});
        const window = windowOf(result.structuredContent as unknown as { nestSelection: WindowView });
        expect(window.picks).toHaveLength(4);
        if (name === "rules") expect(window).not.toHaveProperty("terrain");
        else expectBoard(window, config, seats[index]!.colony);
        // The founding-price rule is stated once in the rules reply (by its briefing) and kept in join/observe.
        if (name === "rules") {
          expect((result.structuredContent as { rules: string }).rules).toContain("starting queens do not count");
          expect(window.rules).not.toContain("Starting queens never raise founding prices.");
        } else expect(window.rules).toContain("Starting queens never raise founding prices.");
        const full = name !== "rules";
        const measured = `${map.id} ${name}: ${JSON.stringify(size)}`;
        expect(size.chars, measured).toBeLessThanOrEqual(full ? MAX_OBSERVE_TEXT_CHARS : MAX_RULES_TEXT_CHARS);
        expect(size.bytes, measured).toBeLessThanOrEqual(full ? MAX_OBSERVE_REPLY_BYTES : MAX_RULES_REPLY_BYTES);
        if (index === 0) console.log(`Largest terrain box ${measured}`);
      }
    }
  } finally { await h.close(); }
}, 30_000);
