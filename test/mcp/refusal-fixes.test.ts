// Every founding refusal's fix names what the agent can see, and the checks that still follow it.
import { afterEach, describe, expect, it } from "vitest";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { rulesConfig, SUB } from "../../src/sim/config.js";
import { createMatch, tileIndex } from "../../src/sim/map.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { SimConfig } from "../../src/sim/config.js";
import type { SimState } from "../../src/sim/types.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

// Every match plays at grid scale 2: the current rules at their configured tile-2 values.
const current = playable(rulesConfig("redesign"));
const rules = current.queenFounding!;

/** A clear land tile at least minDistance from every queen, so only the check under test refuses. */
function freeTile(state: SimState): { tileX: number; tileY: number } {
  const queens = state.colonies.flatMap(c => c.queens ?? []);
  for (let y = 0; y < state.config.mapHeight; y++) for (let x = 0; x < state.config.mapWidth; x++) {
    if (isWaterTile(state.terrain, x, y) || isRockTile(state.terrain, x, y)) continue;
    if (queens.every(q => (x - Math.floor(q.queenX / SUB)) ** 2 + (y - Math.floor(q.queenY / SUB)) ** 2 >= rules.minDistanceTiles ** 2)) return { tileX: x, tileY: y };
  }
  throw new Error("no free tile");
}

/** A founding state where every check passes unless the case breaks one. */
function foundingState(config: SimConfig, breaks: string): { state: SimState; tile: { tileX: number; tileY: number } } {
  const state = createMatch(42, config);
  state.tick = (rules.firstFoundTick ?? 0) + rules.cooldownTicks + 1;
  const colony = state.colonies[0];
  let tile = freeTile(state);
  if (breaks === "queen_too_close") {
    const queen = colony.queens![0]!;
    tile = { tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) };
  }
  if (breaks !== "queen_tile_not_held") { state.owner[tileIndex(config, tile.tileX, tile.tileY)] = 0; state.lastVisit[tileIndex(config, tile.tileX, tile.tileY)] = state.tick; }
  else state.owner[tileIndex(config, tile.tileX, tile.tileY)] = -1;
  if (breaks === "queen_too_early") state.tick = (rules.firstFoundTick ?? 0) - 100;
  if (breaks === "queen_cooldown") colony.lastQueenFoundedTick = state.tick - 1;
  colony.foodStore = breaks === "queen_food" ? 0 : 1_000_000;
  return { state, tile };
}

describe("founding refusals", () => {
  const limited = { ...current, queenFounding: { ...rules, maxLiveQueens: 1 } };
  it.each([
    ["queen_tile_not_held", current, `Checked next, in order: opening (tick 3000); colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing: at least ${rules.minDistanceTiles} tiles (Euclidean) from every standing nest of either colony; stored food: queenFounding.foodStore at least queenFounding.cost.`],
    ["queen_too_early", current, "Checked next, in order: colony cooldown 1800 ticks"],
    ["queen_limit", limited, "Checked next, in order: colony cooldown 1800 ticks"],
    ["queen_cooldown", current, `Checked next, in order: spacing: at least ${rules.minDistanceTiles} tiles (Euclidean)`],
    ["queen_too_close", current, "Checked next, in order: stored food: queenFounding.foodStore at least queenFounding.cost."],
    ["queen_food", current, "Stored food is the last founding check."],
  ] as const)("%s names the checks that follow it", async (code, config, next) => {
    const { state, tile } = foundingState(config, code);
    h = await startHarness({ simConfig: { ...config, commandFloorTicks: 1 }, state });
    const agent = await h.connect();
    await agent.call("join", { colony: "Very Large Colony" });
    const refused = await agent.call("found_queen", tile);
    expect(refused.data.error.code, refused.text).toBe(code);
    expect(refused.data.error.howToFix).toContain(next);
    expect(refused.data.error.howToFix).not.toContain("#");
    if (code === "queen_tile_not_held") expect(refused.data.error.howToFix).toContain("bit is 1 in observe map:true territory");
    if (code === "queen_limit") expect(refused.data.error.howToFix).toContain("Checked next, in order: colony cooldown 1800 ticks (wait for queenFounding.nextFoundTick); spacing");
  });

  it("omits checks this match's rules do not have", async () => {
    const open = { ...current, queenFounding: { ...rules, firstFoundTick: 0 } };
    const { state, tile } = foundingState(open, "queen_tile_not_held");
    h = await startHarness({ simConfig: { ...open, commandFloorTicks: 1 }, state });
    const agent = await h.connect();
    await agent.call("join", { colony: "Very Large Colony" });
    const fix = (await agent.call("found_queen", tile)).data.error.howToFix as string;
    expect(fix).toContain("Checked next, in order: colony cooldown");
    expect(fix).not.toMatch(/opening|live-queen limit/);
  });

  it("answers an out-of-map founding tile with found_queen, not go_to or attack", async () => {
    const { state } = foundingState(current, "none");
    h = await startHarness({ simConfig: { ...current, commandFloorTicks: 1 }, state });
    const agent = await h.connect();
    await agent.call("join");
    const refused = await agent.call("found_queen", { tileX: current.mapWidth, tileY: 0 });
    expect(refused.data.error.code).toBe("bad_order");
    expect(refused.data.error.howToFix).toBe(`Send found_queen with whole-number tileX 0-${current.mapWidth - 1} and tileY 0-${current.mapHeight - 1} on a tile your colony holds.`);
    const order = await agent.call("order", { kind: "go_to", tileX: current.mapWidth, tileY: 0 });
    expect(order.data.error.howToFix).toContain("Send go_to or attack");
  });

  it("teaches held ground as the territory bit in the current briefing", () => {
    for (const text of [briefing(current), joinBriefing(current)]) {
      expect(text).not.toContain("# in observe map:true");
    }
    expect(briefing(current)).toContain("found_queen {tileX,tileY}: held tile (bit 1 in observe map:true territory).");
  });
});

// An agent that acts only on each founding reply gets past that code on its next try.
describe("following a founding reply gets past its code", () => {
  type Tile = { tileX: number; tileY: number };
  type View = { tick: number; queens: Tile[]; enemyQueens?: Tile[]; queenFounding: { nextFoundTick: number; cost: number; foodStore: number } };

  /** The agent's own decode, written from observe's territory description only (no repository decoder). */
  function heldTiles(territory: { encoding: string; width: number; height: number; data: string }): Tile[] {
    expect(territory.encoding).toBe("base64-bitset-lsb0");
    const bytes = Buffer.from(territory.data, "base64"), held: Tile[] = [];
    for (let index = 0; index < territory.width * territory.height; index++) {
      if ((bytes[Math.floor(index / 8)]! >> (index % 8)) & 1) held.push({ tileX: index % territory.width, tileY: Math.floor(index / territory.width) });
    }
    return held;
  }

  /** What the reply asks for together: a held tile, spaced from every nest the agent can see. Terrain is the earlier, separate check. */
  function pick(state: SimState, view: View, territory: Parameters<typeof heldTiles>[0]): Tile {
    const nests = [...view.queens, ...(view.enemyQueens ?? [])];
    const tile = heldTiles(territory).find(t => !isWaterTile(state.terrain, t.tileX, t.tileY) && !isRockTile(state.terrain, t.tileX, t.tileY) &&
      nests.every(q => (t.tileX - q.tileX) ** 2 + (t.tileY - q.tileY) ** 2 >= rules.minDistanceTiles ** 2));
    if (tile === undefined) throw new Error("no held, spaced tile in the decoded territory");
    return tile;
  }

  /** Held ground away from the nests exists (world setup, not agent knowledge); the agent finds it only by decoding. */
  function world(change: (state: SimState) => void, config: SimConfig = current): SimState {
    const state = createMatch(42, config);
    state.tick = (config.queenFounding!.firstFoundTick ?? 0) + config.queenFounding!.cooldownTicks + 1;
    const far = freeTile(state);
    state.colonies[0].foodStore = 1_000_000;
    change(state);
    state.owner[tileIndex(config, far.tileX, far.tileY)] = 0; state.lastVisit[tileIndex(config, far.tileX, far.tileY)] = state.tick;
    return state;
  }

  async function seat(state: SimState, config: SimConfig = current) {
    h = await startHarness({ simConfig: { ...config, commandFloorTicks: 1 }, state });
    const agent = await h.connect();
    await agent.call("join", { colony: "Very Large Colony" });
    return agent;
  }

  it("queen_tile_not_held and queen_too_close: decoding the named territory bit and keeping the named spacing founds the queen", async () => {
    for (const first of ["unheld", "close"] as const) {
      const state = world(() => {});
      const queen = state.colonies[0].queens![0]!, nest = { tileX: Math.floor(queen.queenX / SUB), tileY: Math.floor(queen.queenY / SUB) };
      if (first === "close") { state.owner[tileIndex(current, nest.tileX, nest.tileY)] = 0; state.lastVisit[tileIndex(current, nest.tileX, nest.tileY)] = state.tick; }
      const unheld = freeTile(state);
      const agent = await seat(state);
      const target = first === "unheld" ? { tileX: (unheld.tileX + 1) % current.mapWidth, tileY: unheld.tileY } : nest;
      if (first === "unheld") h!.game.match!.state.owner[tileIndex(current, target.tileX, target.tileY)] = -1;
      const refused = await agent.call("found_queen", target);
      expect(refused.data.error.code, refused.text).toBe(first === "unheld" ? "queen_tile_not_held" : "queen_too_close");
      expect(refused.data.error.howToFix).toContain(first === "unheld" ? `spacing: at least ${rules.minDistanceTiles} tiles (Euclidean)` : `at least ${rules.minDistanceTiles} tiles from each nest`);
      const observed = await agent.call("observe", { map: true });
      const retry = await agent.call("found_queen", pick(h!.game.match!.state, observed.data.view, observed.data.view.territory));
      expect(retry.isError, retry.text).toBe(false);
      await h!.close(); h = undefined;
    }
  });

  it.each(["queen_too_early", "queen_cooldown"] as const)("%s: waiting until queenFounding.nextFoundTick founds the queen", async code => {
    const config = { ...current, queenFounding: { ...rules, firstFoundTick: 100, cooldownTicks: 40 } };
    const state = world(s => {
      if (code === "queen_too_early") s.tick = 60;
      else s.colonies[0].lastQueenFoundedTick = s.tick - 1;
    }, config);
    const agent = await seat(state, config);
    const first = await agent.call("observe", { map: true });
    const tile = pick(h!.game.match!.state, first.data.view, first.data.view.territory);
    const refused = await agent.call("found_queen", tile);
    expect(refused.data.error.code, refused.text).toBe(code);
    expect(refused.data.error.howToFix).toContain("queenFounding.nextFoundTick");
    const wait = (await agent.call("observe")).data.view.queenFounding.nextFoundTick as number;
    h!.advance(Math.max(0, wait - h!.game.match!.state.tick));
    const index = tileIndex(current, tile.tileX, tile.tileY);
    h!.game.match!.state.owner[index] = 0; h!.game.match!.state.lastVisit[index] = h!.game.match!.state.tick; // the held tile stays held
    const retry = await agent.call("found_queen", tile);
    expect(retry.isError, retry.text).toBe(false);
  });

  it("queen_food: delivering the named cost founds the queen, the last check", async () => {
    const state = world(s => { s.colonies[0].foodStore = 0; });
    const agent = await seat(state);
    const observed = await agent.call("observe", { map: true });
    const tile = pick(h!.game.match!.state, observed.data.view, observed.data.view.territory);
    const refused = await agent.call("found_queen", tile);
    expect(refused.data.error.code, refused.text).toBe("queen_food");
    const cost = Number(/Required stored food: (\d+)/.exec(refused.data.error.howToFix)![1]);
    h!.game.match!.state.colonies[0].foodStore = cost; // stands in for the agent's foragers delivering food
    const retry = await agent.call("found_queen", tile);
    expect(retry.isError, retry.text).toBe(false);
  });
});
