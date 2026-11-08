// Characterization of which refusal wins when one call breaks several rules.
// Each layer checks its conditions strictly in order and returns the FIRST failure, so a call that breaks
// several rules is refused for the earliest one only. The suite pins that order; it changes no behaviour.
//
// pick_nest is two layers composed:
//   adapter (Game.pickNest):            not_seated → match_not_played → window_closed → call_rate, then
//   placement (StartPlacement.pick):    not_seated → window_closed → invalid_tile → outside_box → water|rock|food → occupied
// Pairs that cannot hold together are not tested: invalid_tile has no tile to classify; a teammate's pick is
// always a legal in-box tile, so occupied never coexists with outside_box or an obstacle; one tile carries one
// obstacle. The placement layer's own not_seated is unreachable through the adapter and is pinned directly.
//
// found_queen (foundQueen, src/sim/agents.ts): terrain (water, then rock) → tile_not_held → too_early → limit
// → cooldown → too_close → food. The rendered founding fix-it text, which names the checks still to come, is
// pinned byte for byte.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { registerTools } from "../../src/mcp/tools.js";
import { PUBLIC_CONFIG, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { createMatch, tileIndex } from "../../src/sim/map.js";
import { foundQueen } from "../../src/sim/agents.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { START_PICK_WINDOW_MS, StartPlacement, startBoxes, type StartBox } from "../../src/sim/startPlacement.js";
import type { SimEvent, SimState } from "../../src/sim/types.js";
import { startHarness, TEST_MCP_CONFIG, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

const clients: Client[] = [];
const servers: McpServer[] = [];
let h: Harness | undefined;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  await h?.close(); h = undefined;
});

// ---------------------------------------------------------------------------------------------- pick_nest

const seats = [0, 1].flatMap(n => [
  { identityId: `left-${n}`, displayName: `Left ${n}`, colony: 0 as const },
  { identityId: `right-${n}`, displayName: `Right ${n}`, colony: 1 as const },
]);
// The water cells (3,20) and (60,20) are drawn at grid scale 2 inside each colony's start box.
const nestConfig: SimConfig = { ...playable(PUBLIC_CONFIG), terrain: { ...PUBLIC_CONFIG.terrain!, mapId: "order-water",
  maps: [{ id: "order-water", name: "Order water", water: [{ x: 3, y: 20, width: 1, height: 1 }, { x: 60, y: 20, width: 1, height: 1 }] }] } };
const CLOSES = START_PICK_WINDOW_MS;

function setup(callsPerSecond = TEST_MCP_CONFIG.callsPerSecond) {
  const clock = { now: 0 };
  const game = new Game({ simConfig: nestConfig, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond }, now: () => clock.now,
    slot: { identityOf: async key => seats.find(seat => `${seat.identityId}-secret` === key)?.identityId,
      locate: async () => ({ slot: "test-slot", mcpUrl: "http://slot.test/mcp", spectatorUrl: "http://slot.test/" }) } });
  game.seatLobby("test-lobby", seats);
  game.beginLobbyStart(7001);
  return { game, clock };
}
async function connect(game: Game) {
  const server = new McpServer({ name: "order-test", version: "1" }); servers.push(server);
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "order-test", version: "1" }); clients.push(client);
  const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
  await server.connect(incoming); await client.connect(outgoing);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })).structuredContent as any;
    },
    async pick(tileX: unknown, tileY: unknown): Promise<string> {
      const data = await this.call("pick_nest", { tileX, tileY });
      return data.accepted === true ? "accepted" : data.error.code;
    },
  };
}

/** Legal and obstacle tiles of the frozen lobby board (seed 7001), classified the way the placement layer does. */
const board = createMatch(7001, nestConfig);
const [leftBox, rightBox] = startBoxes(nestConfig);
function obstacleIn(box: StartBox, kind: "water" | "rock" | "food" | null): { tileX: number; tileY: number } {
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    const found = isWaterTile(board.terrain, x, y) ? "water" : isRockTile(board.terrain, x, y) ? "rock"
      : board.food[y * board.config.mapWidth + x]! > 0 ? "food" : null;
    if (found === kind) return { tileX: x, tileY: y };
  }
  throw new Error(`no ${kind} tile in box`);
}
const KINDS = ["water", "rock", "food"] as const;
const legal = obstacleIn(leftBox, null);
const legal2 = { tileX: legal.tileX + 1, tileY: legal.tileY };

/** Every placement-layer tile fault seat left-0 can make, given that teammate left-1 picked `legal2`. */
const TILE_FAULTS: readonly (readonly [string, unknown, unknown])[] = [
  ["nest_invalid_tile", "8", legal.tileY],
  ["nest_outside_box", rightBox.x, rightBox.y],
  ...KINDS.map(kind => { const t = obstacleIn(leftBox, kind); return [`nest_${kind}`, t.tileX, t.tileY] as const; }),
  ["nest_occupied", legal2.tileX, legal2.tileY],
];

describe("pick_nest: first refusal wins", () => {
  it("each tile fault refuses alone with an open window and spare call rate (baseline)", async () => {
    expect(isWaterTile(board.terrain, legal2.tileX, legal2.tileY) || isRockTile(board.terrain, legal2.tileX, legal2.tileY)
      || board.food[legal2.tileY * board.config.mapWidth + legal2.tileX]! > 0).toBe(false);
    const { game } = setup();
    const mate = await connect(game), agent = await connect(game);
    await mate.call("join", { key: "left-1-secret" });
    expect(await mate.pick(legal2.tileX, legal2.tileY)).toBe("accepted");
    await agent.call("join", { key: "left-0-secret" });
    for (const [code, x, y] of TILE_FAULTS) expect(await agent.pick(x, y), code).toBe(code);
    expect(await agent.pick(legal.tileX, legal.tileY)).toBe("accepted");
  });

  it("placement: outside_box beats an obstacle on the opponent's side", async () => {
    const { game } = setup();
    const agent = await connect(game);
    await agent.call("join", { key: "left-0-secret" });
    for (const kind of KINDS) {
      const t = obstacleIn(rightBox, kind);
      expect(await agent.pick(t.tileX, t.tileY), kind).toBe("nest_outside_box");
    }
  });

  it("placement: window_closed beats every tile fault, including outside_box plus an obstacle at once", async () => {
    const { game, clock } = setup();
    const mate = await connect(game), agent = await connect(game);
    await mate.call("join", { key: "left-1-secret" });
    expect(await mate.pick(legal2.tileX, legal2.tileY)).toBe("accepted");
    await agent.call("join", { key: "left-0-secret" });
    clock.now = CLOSES;
    for (const [code, x, y] of TILE_FAULTS) expect(await agent.pick(x, y), code).toBe("nest_window_closed");
    // Three placement conditions at once: window closed, outside the box, and an obstacle tile.
    const rock = obstacleIn(rightBox, "rock");
    expect(await agent.pick(rock.tileX, rock.tileY)).toBe("nest_window_closed");
  });

  it("adapter: call_rate beats every placement fault, including the closed window", async () => {
    const { game, clock } = setup(2);
    const mate = await connect(game), agent = await connect(game);
    await mate.call("join", { key: "left-1-secret" });
    expect(await mate.pick(legal2.tileX, legal2.tileY)).toBe("accepted");
    clock.now = CLOSES - 1;
    await agent.call("join", { key: "left-0-secret" });
    expect(await agent.pick(legal.tileX, legal.tileY)).toBe("accepted"); // second admitted call this second
    for (const [code, x, y] of TILE_FAULTS) expect(await agent.pick(x, y), code).toBe("call_rate");
    clock.now = CLOSES; // window now closed too; the rate window still holds both calls
    const rock = obstacleIn(rightBox, "rock");
    expect(await agent.pick(rock.tileX, rock.tileY)).toBe("call_rate");
    clock.now = CLOSES + 1000; // control: once the rate frees, the placement layer's window refusal shows
    expect(await agent.pick(rock.tileX, rock.tileY)).toBe("nest_window_closed");
  });

  it("adapter: window_closed (seat from an earlier lobby) beats call_rate and tile faults", async () => {
    const { game, clock } = setup(2);
    const agent = await connect(game);
    clock.now = CLOSES - 1;
    await agent.call("join", { key: "left-0-secret" });
    expect(await agent.pick(legal.tileX, legal.tileY)).toBe("accepted");
    clock.now = CLOSES;
    game.finishLobbyStart();
    game.seatLobby("next-lobby", seats);
    game.beginLobbyStart(7002);
    // Window closed for this seat, call rate spent, and invalid / outside / obstacle tiles.
    for (const [, x, y] of TILE_FAULTS.slice(0, 5)) expect(await agent.pick(x, y)).toBe("nest_window_closed");
  });

  it("adapter: match_not_played beats window_closed, call_rate and tile faults", async () => {
    const { game, clock } = setup(2);
    game.seatLobby("missed-house-lobby", seats, "house-4v4");
    game.beginLobbyStart(7001);
    const agent = await connect(game);
    clock.now = CLOSES - 1;
    await agent.call("join", { key: "left-0-secret" });
    expect(await agent.pick(legal.tileX, legal.tileY)).toBe("accepted");
    clock.now = CLOSES;
    expect(() => game.finishLobbyStart()).toThrow();
    game.endNotPlayed();
    for (const [, x, y] of TILE_FAULTS.slice(0, 5)) expect(await agent.pick(x, y)).toBe("match_not_played");
    // Four adapter-and-placement conditions at once: not played, a new lobby's window is not this seat's,
    // the call rate is spent, and the tile is invalid.
    game.seatLobby("next-lobby", seats);
    game.beginLobbyStart(7002);
    expect(await agent.pick("8", legal.tileY)).toBe("match_not_played");
  });

  it("adapter: not_seated beats a closed window and every tile fault", async () => {
    const { game, clock } = setup(2);
    const outsider = await connect(game);
    for (const [, x, y] of TILE_FAULTS.slice(0, 5)) expect(await outsider.pick(x, y)).toBe("nest_not_seated");
    clock.now = CLOSES;
    expect(await outsider.pick("8", legal.tileY)).toBe("nest_not_seated");
    game.endNotPlayed();
    expect(await outsider.pick("8", legal.tileY)).toBe("nest_not_seated");
  });

  it("placement layer directly: not_seated beats window_closed and an invalid tile", () => {
    const placement = new StartPlacement(nestConfig, [{ identityId: "a", colony: 0 }, { identityId: "b", colony: 1 }], 0, () => null);
    expect(placement.pick("stranger", Number.NaN, 0, CLOSES)).toEqual({ ok: false, reason: "not_seated" });
    expect(placement.pick("a", Number.NaN, 0, CLOSES)).toEqual({ ok: false, reason: "window_closed" });
    expect(placement.pick("a", Number.NaN, 0, CLOSES - 1)).toEqual({ ok: false, reason: "invalid_tile" });
  });
});

// ---------------------------------------------------------------------------------------------- found_queen

const current = playable(rulesConfig("redesign"));
const rules = current.queenFounding!;
const FOUNDING = ["queen_tile_not_held", "queen_too_early", "queen_limit", "queen_cooldown", "queen_too_close", "queen_food"] as const;
type Condition = "water_tile" | "rock_tile" | (typeof FOUNDING)[number];

/** A tile of the wanted kind at least the spacing distance from every queen, so spacing passes unless broken. */
function spacedTile(state: SimState, kind: "land" | "water" | "rock"): { tileX: number; tileY: number } {
  const queens = state.colonies.flatMap(c => c.queens ?? []);
  for (let y = 0; y < state.config.mapHeight; y++) for (let x = 0; x < state.config.mapWidth; x++) {
    const found = isWaterTile(state.terrain, x, y) ? "water" : isRockTile(state.terrain, x, y) ? "rock" : "land";
    if (found !== kind) continue;
    if (queens.every(q => (x - Math.floor(q.queenX / SUB)) ** 2 + (y - Math.floor(q.queenY / SUB)) ** 2 >= rules.minDistanceTiles ** 2)) return { tileX: x, tileY: y };
  }
  throw new Error(`no spaced ${kind} tile`);
}

/** A founding attempt by colony 0 in which exactly the named conditions fail. */
function foundWith(broken: ReadonlySet<Condition>): string | null {
  const config: SimConfig = { ...current, queenFounding: { ...rules,
    ...(broken.has("queen_limit") ? { maxLiveQueens: 1 } : {}),
    ...(broken.has("queen_too_close") ? { minDistanceTiles: 10_000 } : {}) } };
  const state = createMatch(42, config);
  const colony = state.colonies[0];
  const tile = spacedTile(state, broken.has("water_tile") ? "water" : broken.has("rock_tile") ? "rock" : "land");
  state.owner[tileIndex(config, tile.tileX, tile.tileY)] = broken.has("queen_tile_not_held") ? -1 : 0;
  state.tick = broken.has("queen_too_early") ? (rules.firstFoundTick ?? 0) - 100 : (rules.firstFoundTick ?? 0) + rules.cooldownTicks + 1;
  if (broken.has("queen_cooldown")) colony.lastQueenFoundedTick = state.tick - 1;
  colony.foodStore = broken.has("queen_food") ? 0 : 1_000_000;
  const events: SimEvent[] = [];
  return foundQueen(state, 0, tile.tileX, tile.tileY, state.tick, events)?.code ?? null;
}

describe("found_queen: first refusal wins", () => {
  const ORDER: readonly Condition[] = ["water_tile", ...FOUNDING];

  it("each condition refuses alone, and none founds the queen", () => {
    expect(foundWith(new Set())).toBeNull();
    for (const condition of [...ORDER, "rock_tile"] as const) expect(foundWith(new Set([condition])), condition).toBe(condition);
  });

  it("for every pair, terrain then founding, the earlier check wins", () => {
    for (const terrain of ["water_tile", "rock_tile"] as const) for (const check of FOUNDING) {
      expect(foundWith(new Set([terrain, check])), `${terrain}+${check}`).toBe(terrain);
    }
    for (let a = 0; a < FOUNDING.length; a++) for (let b = a + 1; b < FOUNDING.length; b++) {
      expect(foundWith(new Set([FOUNDING[a]!, FOUNDING[b]!])), `${FOUNDING[a]}+${FOUNDING[b]}`).toBe(FOUNDING[a]);
    }
  });

  it("with every condition failing, fixing the reported one reveals the next in order", () => {
    const broken = new Set<Condition>(ORDER);
    const seen: (string | null)[] = [];
    while (broken.size > 0) {
      const code = foundWith(broken);
      seen.push(code);
      broken.delete(code as Condition);
    }
    expect(seen).toEqual(ORDER);
  });

  it.each([
    ["queen_tile_not_held", false, "Choose a tile whose bit is 1 in observe map:true territory (base64-bitset-lsb0, index y*width+x; observe's description decodes it). Checked next, in order: opening (tick 3000); colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing: at least 32 tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_tile_not_held", true, "Choose a tile whose bit is 1 in observe map:true territory (base64-bitset-lsb0, index y*width+x; observe's description decodes it). Checked next, in order: opening (tick 3000); live-queen limit 1 (queenFounding.slotsRemaining); colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing: at least 32 tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_too_early", false, "Founding opens at tick 3000; wait until queenFounding.nextFoundTick. Checked next, in order: colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing: at least 32 tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_limit", true, "Live queen limit: 1; observe shows queenFounding.slotsRemaining. No food was spent. A lost queen frees a live slot. Checked next, in order: colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing: at least 32 tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_cooldown", false, "Colony founding cooldown: 1800 ticks; wait until tick 6600 (queenFounding.nextFoundTick). Checked next, in order: spacing: at least 32 tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_too_close", false, "Choose a tile at least 32 tiles from each nest covered by this match's spacing rule. Checked next, in order: stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_food", false, "Required stored food: 400; available: 0. Forage and deliver food. Stored food is the last founding check."],
  ] as const)("renders %s's fix-it text exactly (live-queen limit configured: %s)", async (code, limited, howToFix) => {
    const config: SimConfig = limited ? { ...current, queenFounding: { ...rules, maxLiveQueens: 1 } } : current;
    const state = createMatch(42, config);
    state.tick = (rules.firstFoundTick ?? 0) + rules.cooldownTicks + 1;
    const colony = state.colonies[0];
    const queen = colony.queens![0]!;
    const tile = code === "queen_too_close" ? { tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) } : spacedTile(state, "land");
    state.owner[tileIndex(config, tile.tileX, tile.tileY)] = code === "queen_tile_not_held" ? -1 : 0;
    state.lastVisit[tileIndex(config, tile.tileX, tile.tileY)] = state.tick;
    if (code === "queen_too_early") state.tick = (rules.firstFoundTick ?? 0) - 100;
    if (code === "queen_cooldown") colony.lastQueenFoundedTick = state.tick - 1;
    colony.foodStore = code === "queen_food" ? 0 : 1_000_000;
    h = await startHarness({ simConfig: { ...config, commandFloorTicks: 1 }, state });
    const agent = await h.connect();
    await agent.call("join", { colony: "Very Large Colony" });
    const refused = await agent.call("found_queen", tile);
    expect(refused.data.error.code, refused.text).toBe(code);
    expect(refused.data.error.howToFix).toBe(howToFix);
  });
});
