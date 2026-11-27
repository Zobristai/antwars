// A Quadrants seat's observe reply, through the MCP tools of a slot server's Game under the production redesign rules:
// it names the three other colonies in colony order, shows each one's elimination (tick and reason) once it has left,
// while play continues and after the end, identifies enemy holdings, ants and queens in sight
// by their colony, and carries no enemy territory totals.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game, type LobbySeat } from "../../src/mcp/game.js";
import { unpackEnemyTiles, unpackTerritory } from "../../src/mcp/territory.js";
import { registerTools } from "../../src/mcp/tools.js";
import { rulesConfig, SUB, type MapDefinition } from "../../src/sim/config.js";
import { newMatchConfig, physicalTileArea } from "../../src/sim/gridScale.js";
import { addAnt } from "../sim/fixtures.js";
import { buildGrid } from "../../src/sim/map.js";
import { pagedView, OBSERVE_REPLY_LIMITS } from "../../src/mcp/replies.js";
import { expandCells, expandFlyers, takeView } from "../../src/sim/view.js";

/** Test-only quadrant geometry, not a production map. */
const FIXTURE: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 }, foodPatches: [], centreFood: [{ radius: 2, perTile: 4 }],
  },
};
/** The production rules every Game here runs. */
const LIVE = newMatchConfig(rulesConfig("redesign"));
const NAMES = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
const IDLE_SECONDS = 3;
const SEED = 4242;

const clients: Client[] = [];
const servers: McpServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});

/** A slot Game seating one lobby; its match advances only through tick() and the calls answer() waits for. */
function slotGame(seats: readonly LobbySeat[], mode: "quadrants" | null, map = FIXTURE) {
  let now = 1000, queued = false;
  const game = new Game({ simConfig: LIVE, quadrantMaps: [map], startPickWindowMs: 50, now: () => now,
    mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1000, houseIdleSeconds: IDLE_SECONDS },
    onInputQueued: () => { queued = true; },
    slot: { identityOf: async key => key.endsWith("-key") ? key.slice(0, -"-key".length) : undefined, locate: async () => undefined } });
  game.seatLobby("observe-lobby", seats, mode);
  const tick = () => { queued = false; game.tick(); };
  /** Waits for a call, running the one tick that answers it once its input is queued. */
  async function answer<T>(call: Promise<T>): Promise<T> {
    let done = false;
    void call.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      await new Promise(resolve => setImmediate(resolve));
      if (!done && queued) tick();
    }
    return call;
  }
  return { game, tick, answer, at: (time: number) => { now = time; } };
}
type World = ReturnType<typeof slotGame>;

/** One MCP session on the slot's tools. */
async function connect(w: World) {
  const server = new McpServer({ name: "quadrants-observe", version: "1" }); servers.push(server);
  registerTools(server, w.game, { agentId: null });
  const client = new Client({ name: "quadrants-observe", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await w.answer(client.callTool({ name, arguments: args }));
      const text = (result.content as { type: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text).join("");
      return { error: result.isError === true, text, data: result.structuredContent as any };
    },
  };
}

/** Four seats, one per colony, joined through MCP in the pick window; the window closes and tick 0 runs. */
async function quadrants(map = FIXTURE) {
  const seats = [0, 1, 2, 3].map(colony => ({ identityId: `id-${colony}`, displayName: `Seat ${colony}`, colony }));
  const w = slotGame(seats, "quadrants", map);
  const closesAt = w.game.beginLobbyStart(SEED);
  const sessions = [];
  const agents = new Map<number, string>();
  for (const colony of [0, 1, 2, 3]) {
    const session = await connect(w);
    const joined = await session.call("join", { key: `id-${colony}-key` });
    expect(joined.error, joined.text).toBe(false);
    agents.set(colony, joined.data.agentId);
    sessions.push(session);
  }
  w.at(closesAt);
  w.game.finishLobbyStart();
  w.tick();
  expect(w.game.match!.state.colonies).toHaveLength(4);
  return { ...w, sessions, agents };
}
type Quadrants = Awaited<ReturnType<typeof quadrants>>;

/** Ticks until the match ends or `until` holds; `calling` colonies observe every 10 ticks, so their seats stay active. */
async function play(q: Quadrants, calling: (tick: number) => readonly number[], until: () => boolean = () => false) {
  while (q.game.match!.state.result === null && !until()) {
    const tick = q.game.match!.state.tick;
    const calls = tick % 10 === 0 ? calling(tick).map(colony => q.game.call(q.agents.get(colony)!, { type: "observe", agentId: q.agents.get(colony)! })) : [];
    q.tick();
    await Promise.all(calls);
  }
}

/** Ends every live queen of these colonies on the current tick; the next tick removes the colonies. */
function loseQueens(q: Quadrants, colonies: readonly number[]): void {
  const state = q.game.match!.state;
  for (const colony of colonies) for (const queen of state.colonies[colony]!.queens!) if (queen.lostTick === null) queen.lostTick = state.tick;
}

/** The opponents list colony `colony` should read: every other colony by its name, eliminated ones with tick and reason. */
function expectedOpponents(q: Quadrants, colony: number) {
  return q.game.match!.state.colonies.filter(other => other.id !== colony).map(other => ({ colony: other.id, name: NAMES[other.id],
    ...(other.eliminated === undefined ? {} : { eliminated: { tick: other.eliminated.tick, reason: other.eliminated.reason } }) }));
}

/** Every key path in a JSON value, dotted, array indexes left out. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap(item => keyPaths(item, prefix));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [`${prefix}${key}`, ...keyPaths(item, `${prefix}${key}.`)]);
}

describe("a Quadrants seat's observe reply", { timeout: 60_000 }, () => {
  it("fits the complete 256×256 territory map alongside 300 hovering flyers", async () => {
    const q = await quadrants({ ...FIXTURE, quadrant: { ...FIXTURE.quadrant!, referenceWidth: 128, referenceHeight: 128 } });
    const state = q.game.match!.state, { config } = state;
    expect([config.mapWidth, config.mapHeight, state.colonies.length]).toEqual([256, 256, 4]);
    // Freeze a tick: the production reply builder measures mandatory metadata before paging cells.
    state.nextAntId = 20_000;
    for (let i = 0; i < 300; i++) {
      const x = 200 + i % 20, y = 200 + Math.floor(i / 20);
      addAnt(state, 0, x, y, { flyer: true, air: { destX: x * SUB + SUB / 2, destY: y * SUB + SUB / 2, hovering: true, released: false } });
    }
    state.owner.fill(-1);
    const anchor = 200 * 256 + 200;
    for (let colony = 0; colony < 4; colony++) state.owner[anchor + colony] = colony;
    const id = q.agents.get(0)!;
    const snapshot = takeView(state, buildGrid(state), state.agents.find(a => a.id === id)!);
    const result = pagedView(q.game, config, snapshot, true, {}, undefined, OBSERVE_REPLY_LIMITS);
    expect(result.isError, JSON.stringify(result.structuredContent?.error)).not.toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(49_000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(102_380);
    const { view } = JSON.parse(text);
    expect(expandFlyers(view.flyers).filter(f => f.state === "hovering")).toHaveLength(300);
    expect(unpackTerritory(view.territory).join("")).toBe(".".repeat(anchor) + "#" + ".".repeat(256 ** 2 - anchor - 1));
    expect(Object.keys(view.territory.enemies)).toEqual(["1", "2", "3"]);
    for (const colony of [1, 2, 3]) expect(unpackEnemyTiles(view.territory, colony)).toEqual([anchor + colony]);
  });

  it("names the three other colonies by name, in colony order, as colony 0 and colony 3 see them", async () => {
    const q = await quadrants();
    const fromFirst = await q.sessions[0]!.call("observe");
    const fromLast = await q.sessions[3]!.call("observe");
    expect(fromFirst.error, fromFirst.text).toBe(false);
    expect(fromFirst.data.opponents).toEqual([
      { colony: 1, name: "Lake Hodges Colony" }, { colony: 2, name: "Sweetwater Colony" }, { colony: 3, name: "Lake Skinner Colony" }]);
    expect(fromLast.data.opponents).toEqual([
      { colony: 0, name: "Very Large Colony" }, { colony: 1, name: "Lake Hodges Colony" }, { colony: 2, name: "Sweetwater Colony" }]);
    expect(fromFirst.data.view.colony).toBe(0);
    expect(fromLast.data.view.colony).toBe(3);
  });

  it("shows one opponent eliminated for idling and one for its last queen, with tick and reason, while play continues, and still lists them after the end", async () => {
    const q = await quadrants();
    // Colony 3 never calls again and leaves for idling.
    await play(q, () => [0, 1, 2], () => q.game.match!.state.colonies[3]!.eliminated !== undefined);
    const idleTick = q.game.match!.state.colonies[3]!.eliminated!.tick;
    const afterIdle = await q.sessions[0]!.call("observe");
    expect(afterIdle.data.opponents).toEqual([
      { colony: 1, name: NAMES[1] }, { colony: 2, name: NAMES[2] }, { colony: 3, name: NAMES[3], eliminated: { tick: idleTick, reason: "idle" } }]);
    expect(afterIdle.data).not.toHaveProperty("matchOver");
    expect(q.game.match!.state.result).toBeNull();

    // Colony 1's last queen dies; the other two play on.
    loseQueens(q, [1]);
    const queenTick = q.game.match!.state.tick;
    await play(q, () => [0, 1, 2], () => q.game.match!.state.colonies[1]!.eliminated !== undefined);
    expect(q.game.match!.state.colonies[1]!.eliminated).toMatchObject({ tick: queenTick, reason: "queens_killed" });
    for (const colony of [0, 2]) {
      const reply = await q.sessions[colony]!.call("observe");
      expect(reply.data.opponents).toEqual(expectedOpponents(q, colony));
      expect(reply.data.opponents.find((o: { colony: number }) => o.colony === 1)).toEqual({ colony: 1, name: NAMES[1], eliminated: { tick: queenTick, reason: "queens_killed" } });
      expect(reply.data).not.toHaveProperty("matchOver");
    }
    // An eliminated seat still reads its opponents: colony 3 sees colony 1 gone and colonies 0 and 2 still playing.
    const fromIdle = await q.sessions[3]!.call("observe");
    expect(fromIdle.data.opponents).toEqual([
      { colony: 0, name: NAMES[0] }, { colony: 1, name: NAMES[1], eliminated: { tick: queenTick, reason: "queens_killed" } }, { colony: 2, name: NAMES[2] }]);
    expect(q.game.match!.state.result).toBeNull();

    // Colony 2's last queen dies: colony 0 is the last standing and the match ends.
    loseQueens(q, [2]);
    const endTick = q.game.match!.state.tick;
    await play(q, () => [0, 1, 2]);
    expect(q.game.match!.state.result).toMatchObject({ winner: 0, reason: "queens_killed", tick: endTick });
    const winner = await q.sessions[0]!.call("observe");
    expect(winner.data).toMatchObject({ matchOver: true, winner: NAMES[0] });
    expect(winner.data.opponents).toEqual([
      { colony: 1, name: NAMES[1], eliminated: { tick: queenTick, reason: "queens_killed" } },
      { colony: 2, name: NAMES[2], eliminated: { tick: endTick, reason: "queens_killed" } },
      { colony: 3, name: NAMES[3], eliminated: { tick: idleTick, reason: "idle" } }]);
    const loser = await q.sessions[3]!.call("observe");
    expect(loser.data).toMatchObject({ matchOver: true, winner: NAMES[0] });
    expect(loser.data.opponents).toEqual(expectedOpponents(q, 3));
    expect(loser.data.opponents[0]).toEqual({ colony: 0, name: NAMES[0] });
  });

  it("keeps the time-up winner's elimination tick in its entry when every colony goes idle on one tick", async () => {
    const q = await quadrants();
    await play(q, tick => tick <= 200 ? [0, 1, 2, 3] : []);
    const { result, colonies } = q.game.match!.state;
    expect(result).toMatchObject({ reason: "idle" });
    const winner = result!.winner!;
    for (const colony of [0, 1, 2, 3]) {
      const reply = await q.sessions[colony]!.call("observe");
      expect(reply.data).toMatchObject({ matchOver: true, winner: NAMES[winner] });
      expect(reply.data.opponents).toEqual(expectedOpponents(q, colony));
      if (colony !== winner) {
        expect(reply.data.opponents.find((o: { colony: number }) => o.colony === winner))
          .toEqual({ colony: winner, name: NAMES[winner], eliminated: { tick: result!.tick, reason: "idle" } });
      }
    }
    expect(colonies.every(colony => colony.eliminated?.tick === result!.tick)).toBe(true);
  });

  it("identifies enemy territory, ants and queens in sight by colony, without enemy totals", async () => {
    const q = await quadrants();
    await play(q, () => [0, 1, 2, 3], () => q.game.match!.state.tick >= 60);
    // Every colony holds ground, so an enemy figure in the reply would show.
    for (const colony of [0, 1, 2, 3]) expect(q.game.match!.state.owner.filter(owner => owner === colony).length).toBeGreaterThan(0);
    // One of colony 0's ants walks into sight of colony 2's nest, where a colony-1 and a colony-2 ant stand.
    const before = q.game.match!.state;
    const queen = before.colonies[2]!.queens!.find(nest => nest.lostTick === null)!;
    const place = (colony: number, tiles: number) => {
      const ant = before.ants.find(candidate => candidate.colony === colony)!;
      ant.x = queen.queenX + tiles * SUB; ant.y = queen.queenY;
    };
    place(0, 2); place(1, 1); place(2, 1);
    // Empty tiles remain held after their visitors leave.
    for (let i = 0; i < before.owner.length; i++) {
      before.owner[i] = i % 5 - 1;
      before.lastVisit[i] = before.tick;
    }

    const reply = await q.sessions[0]!.call("observe", { map: true });
    expect(reply.error, reply.text).toBe(false);
    const state = q.game.match!.state, { config } = state;
    const view = reply.data.view;
    expect(view.tick).toBe(state.tick);

    // Own territory only: the map, the tile count and the share are colony 0's.
    const own = Array.from({ length: config.mapHeight }, (_, y) => Array.from({ length: config.mapWidth }, (_, x) =>
      state.owner[y * config.mapWidth + x] === 0 ? "#" : ".").join(""));
    expect(unpackTerritory(view.territory)).toEqual(own);
    const ownTiles = state.owner.filter(owner => owner === 0).length;
    expect(view.territoryTiles).toBe(ownTiles / physicalTileArea(config));
    expect(view.territorySharePermille).toBe(Math.trunc(ownTiles * 1000 / (config.mapWidth * config.mapHeight)));
    // Local masks are the only enemy territory fields: no global totals or share.
    expect(reply.data.status).toHaveLength(2);
    expect(keyPaths(reply.data).filter(path => /territor/i.test(path)).sort())
      .toEqual(["view.territory", "view.territory.data", "view.territory.encoding", "view.territory.enemies", "view.territory.enemies.1",
        "view.territory.enemies.2", "view.territory.enemies.3", "view.territory.height", "view.territory.width",
        "view.territorySharePermille", "view.territoryTiles"]);
    expect(reply.data.opponents.every((o: object) => Object.keys(o).every(key => ["colony", "name", "eliminated"].includes(key)))).toBe(true);

    // Every cell is within today's sight of a living colony-0 ant, and every ant and queen carries its own colony.
    expect(view.cells).toMatchObject({ colonies: 4 });
    const cells = expandCells(view.cells);
    const sight = config.sightTiles ** 2;
    const eyes = state.ants.filter(ant => ant.colony === 0 && ant.hp > 0).map(ant => [Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)] as const);
    for (const colony of [1, 2, 3]) {
      const expected = state.owner.map((owner, i) => owner === colony && eyes.some(([x, y]) =>
        (x - i % config.mapWidth) ** 2 + (y - Math.floor(i / config.mapWidth)) ** 2 <= sight) ? "#" : ".").join("");
      expect(expected).toContain("#");
      expect(unpackEnemyTiles(view.territory, colony)).toEqual([...expected.matchAll(/#/g)].map(m => m.index));
    }
    for (const cell of cells) expect(eyes.some(([x, y]) => (cell.tileX - x) ** 2 + (cell.tileY - y) ** 2 <= sight)).toBe(true);
    const byId = new Map(state.ants.map(ant => [ant.id, ant]));
    const enemies = cells.flatMap(cell => cell.ants).filter(ant => ant.colony !== 0);
    expect(view.cellsMore).toBe(false);
    expect(enemies.map(ant => ant.colony)).toEqual(expect.arrayContaining([1, 2]));
    for (const ant of cells.flatMap(cell => cell.ants)) expect(ant.colony).toBe(byId.get(ant.antId)!.colony);
    const nestTile = { tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) };
    expect(cells.find(cell => cell.tileX === nestTile.tileX && cell.tileY === nestTile.tileY)).toMatchObject({ queen: 2 });
    expect(view.enemyQueens).toContainEqual(expect.objectContaining({ ...nestTile, colony: 2 }));
    for (const enemy of view.enemyQueens) expect(enemy.colony).not.toBe(0);
  });
});

describe("a two-colony seat's observe reply", () => {
  it("carries no opponents list and keeps its enemy territory share and top-level fields", async () => {
    const w = slotGame([0, 1].map(colony => ({ identityId: `id-${colony}`, displayName: `Seat ${colony}`, colony })), null);
    const sessions = [];
    for (const colony of [0, 1]) {
      const session = await connect(w);
      expect((await session.call("join", { key: `id-${colony}-key` })).error).toBe(false);
      sessions.push(session);
    }
    w.game.startMatch(SEED);
    w.tick();
    expect(w.game.match!.state.colonies).toHaveLength(2);
    for (const session of sessions) {
      const reply = await session.call("observe");
      expect(reply.error, reply.text).toBe(false);
      expect(reply.data).not.toHaveProperty("opponents");
      expect(Object.keys(reply.data)).toEqual(["houseIdleSeconds", "status", "freeAntsByCaste", "view"]);
      expect(reply.data.status).toHaveLength(3);
    }
  });
});
