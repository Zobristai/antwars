import { afterEach, describe, expect, it } from "vitest";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS } from "../../src/mcp/replies.js";
import { COLONY_NAMES, SUB, rulesConfig } from "../../src/sim/config.js";
import { newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { activeQueens, createMatch, newAnt } from "../../src/sim/map.js";
import { isPassable } from "../../src/sim/terrain.js";
import { expandCells, type DenseCells } from "../../src/sim/view.js";
import { ENEMY_QUEENS_TEXT, briefing, colonyVisibilityText, usesCompactAgentText } from "../../src/mcp/briefing.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { startHarness, type CallResult, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

/** The reference answer: enemy-queen cells decoded from the same reply's own cell table. */
function decodedEnemyQueens(view: { cells: DenseCells; colony: number }) {
  return expandCells(view.cells).filter(cell => cell.queen !== undefined && cell.queen !== view.colony)
    .map(cell => ({ tileX: cell.tileX, tileY: cell.tileY, ...(cell.queenHp === undefined ? {} : { hp: cell.queenHp }) }));
}

function within(reply: CallResult) {
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.text.length).toBeLessThanOrEqual(MAX_OBSERVE_TEXT_CHARS);
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: reply.text }], structuredContent: reply.data }))).toBeLessThanOrEqual(MAX_OBSERVE_REPLY_BYTES);
}

describe("observe enemyQueens restates the reply's own cells", () => {
  it("is empty while the enemy queen is fogged, then lists it with the cell's tile and HP once in sight", async () => {
    const config = { ...newMatchConfig(rulesConfig("redesign")), antSpeedTilesPerSecond: 0, combatGraceTicks: 1_000_000 };
    expect(usesCompactAgentText(config)).toBe(true);
    const state = createMatch(42, config);
    h = await startHarness({ simConfig: config, state });
    const a = await h.connect();
    const joined = await a.call("join", { colony: COLONY_NAMES[0] });
    expect(joined.isError, joined.text).toBe(false);
    const live = h.game.match!.state;
    const enemy = activeQueens(live.colonies[1])[0]!;
    const enemyTile = { tileX: Math.floor(enemy.queenX / SUB), tileY: Math.floor(enemy.queenY / SUB) };

    let reply = await a.call("observe");
    within(reply);
    expect(reply.data.view.colony).toBe(0);
    expect(reply.data.view.enemyQueens).toEqual([]);
    expect(decodedEnemyQueens(reply.data.view)).toEqual([]);
    expect(reply.data.view.enemyQueens).not.toContainEqual(expect.objectContaining(enemyTile)); // fogged: never listed
    // Own queens stay in view.queens, never in enemyQueens.
    expect(reply.data.view.queens.length).toBeGreaterThan(0);

    // Bring one own ant beside the enemy queen: the cells now encode it, and so does the list.
    const scout = h.game.match!.state.ants.find(ant => ant.colony === 0)!; // the match state is replaced as ticks advance
    scout.x = tileCentre(enemyTile.tileX + 1); scout.y = tileCentre(enemyTile.tileY);
    reply = await a.call("observe");
    within(reply);
    const decoded = decodedEnemyQueens(reply.data.view);
    expect(decoded).toContainEqual({ ...enemyTile, hp: enemy.hp });
    expect(reply.data.view.enemyQueens).toEqual(decoded);
    for (const queen of reply.data.view.enemyQueens) expect(Object.keys(queen).toSorted()).toEqual(["hp", "tileX", "tileY"]);
  });

  it("lists on each cell page exactly the enemy queens that page encodes", async () => {
    const config = { ...withGridScale(rulesConfig("redesign")), antSpeedTilesPerSecond: 0, combatGraceTicks: 1_000_000 };
    expect(usesCompactAgentText(config)).toBe(true);
    h = await startHarness({ simConfig: config });
    const agents = [];
    for (let i = 0; i < 8; i++) {
      const agent = await h.connect(), join = await agent.call("join", { colony: COLONY_NAMES[i % 2] });
      expect(join.isError, join.text).toBe(false);
      agents.push(agent);
    }
    prepareLargestView(h, true);
    const state = h.game.match!.state, tiles: [number, number][] = [];
    for (let y = 0; y < config.mapHeight; y++) for (let x = 0; x < config.mapWidth; x++) if (isPassable(state, x, y)) tiles.push([x, y]);
    // Extra ants keep the colony's cells larger than one observe page at the raised limit; the
    // 128x96 board has a quarter of the former 256x192 board's tiles, so it needs more ants per tile.
    for (const colony of [0, 1] as const) for (let i = 0; i < 2_048; i++) state.ants.push(newAnt(config, state.nextAntId++, colony, 0, 0));
    for (const colony of [0, 1]) {
      const ants = state.ants.filter(ant => ant.colony === colony);
      for (const [i, ant] of ants.entries()) {
        const [x, y] = tiles[Math.floor(i * tiles.length / ants.length)]!;
        ant.x = tileCentre(x); ant.y = tileCentre(y);
      }
    }
    const caller = agents[0]!;
    let reply = await caller.call("observe", { map: true });
    within(reply);
    expect(reply.data.view.cellsMore).toBe(true);
    const listed = [...reply.data.view.enemyQueens];
    expect(reply.data.view.enemyQueens).toEqual(decodedEnemyQueens(reply.data.view));
    for (let pages = 1; reply.data.view.cellsMore; pages++) {
      expect(pages).toBeLessThan(20);
      reply = await caller.call("observe", { cellsCursor: reply.data.view.cellsCursor, map: true });
      within(reply);
      expect(reply.data.view.enemyQueens).toEqual(decodedEnemyQueens(reply.data.view));
      listed.push(...reply.data.view.enemyQueens);
    }
    // Across the frozen snapshot every sighted enemy queen appears exactly once, with its live HP.
    const enemies = activeQueens(state.colonies[1]).map(q => ({ tileX: Math.floor(q.queenX / SUB), tileY: Math.floor(q.queenY / SUB), hp: q.hp }));
    expect(listed.toSorted((p, q) => p.tileY - q.tileY || p.tileX - q.tileX)).toEqual(enemies.toSorted((p, q) => p.tileY - q.tileY || p.tileX - q.tileX));
  }, 60_000);

  it("names the field in the current observe description and briefing; older rules copies are unchanged", async () => {
    const config = newMatchConfig(rulesConfig("redesign"));
    h = await startHarness({ simConfig: config });
    const a = await h.connect();
    const tools = await a.client.listTools();
    expect(tools.tools.find(t => t.name === "observe")!.description).toContain(ENEMY_QUEENS_TEXT);
    expect(briefing(config)).toContain("enemyQueens: in-sight only (tile, hp).");
    // The same rules reply still states that enemies outside sight are fogged.
    expect(briefing(config)).toContain("enemy map fogged.");
    expect(briefing(config)).toContain(colonyVisibilityText(config));
    const older = playable(rulesConfig("v4"));
    expect(usesCompactAgentText(older)).toBe(false);
    expect(briefing(older)).not.toContain("enemyQueens");
  });

  it("omits the field for older rules copies", async () => {
    const config = { ...playable(rulesConfig("v4")) };
    h = await startHarness({ simConfig: config });
    const a = await h.connect();
    const joined = await a.call("join", { colony: COLONY_NAMES[0] });
    expect(joined.isError, joined.text).toBe(false);
    const reply = await a.call("observe");
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data.view).not.toHaveProperty("enemyQueens");
  });
});
