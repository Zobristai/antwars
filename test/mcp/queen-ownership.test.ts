import { describe, expect, it } from "vitest";
import { COLONY_NAMES, SUB, rulesConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { denseCells, expandCells, type AgentView, type DenseCells } from "../../src/sim/view.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness } from "./harness.js";
import { playable } from "../playable.ts";

// Scripted HTTP clients only: no external match or LLM player is involved.
describe.each(["v4", "count-marks", "redesign"] as const)("observe queen ownership under %s", rules => {
  it.each([0, 1] as const)("identifies both colonies' visible queens for colony %s without confusing queen ids or revealing fogged nests", async colony => {
    const config = playable({ ...rulesConfig(rules), startAnts: 0 });
    const h = await startHarness({ simConfig: config, state: emptyMatch(0, config) });
    try {
      const client = await h.connect();
      const joined = await client.call("join", { colony: COLONY_NAMES[colony] });
      expect(joined.isError, joined.text).toBe(false);
      const state = h.game.match!.state;
      const agent = state.agents.find(a => a.id === joined.data.agentId)!;
      agent.order = { kind: "hold" };
      const own = state.colonies[colony], enemy = state.colonies[colony === 0 ? 1 : 0];
      const enemyX = Math.floor(enemy.queenX / SUB), enemyY = Math.floor(enemy.queenY / SUB);
      // Reproduce the reported own queens 1/2 versus packed colony 0, and mirror for colony 1.
      for (const [i, y] of [11, 37].entries()) {
        own.queens!.push({ ...own.queens![0]!, id: i + 1, queenX: tileCentre(19), queenY: tileCentre(y) });
      }
      enemy.queens!.push({ ...enemy.queens![0]!, id: 1, queenX: tileCentre(45), queenY: tileCentre(5) });
      for (const [x, y] of [[19, 11], [19, 37], [enemyX, enemyY]] as const) {
        const scout = addAnt(state, colony, x, y, { squad: agent.id });
        agent.squad.push(scout.id);
        // Keep the scouts within the unchanged half-colony squad-supply limit.
        addAnt(state, colony, Math.floor(own.queenX / SUB), Math.floor(own.queenY / SUB));
      }
      const observed = await client.call("observe");
      expect(observed.isError, observed.text).toBe(false);
      const view = observed.data.view as Omit<AgentView, "cells"> & { readonly cells: DenseCells };
      expect(view.colony).toBe(colony);
      expect(view.cells.encoding).toContain("p[,queenColony[,queenHp]][:ants]");
      expect(view.cells.encoding).toContain("queenColony=colony0/1 (own=view.colony), not queenId");
      const decoded = expandCells(view.cells);
      const queens = decoded.filter(cell => cell.queen !== undefined);
      expect(queens).toHaveLength(4);
      // Free ants at the original nest now contribute colony sight too.
      expect(queens).toContainEqual(expect.objectContaining({ queen: view.colony, tileX: Math.floor(own.queenX / SUB), tileY: Math.floor(own.queenY / SUB) }));
      for (const [id, y] of [[1, 11], [2, 37]] as const) {
        const cell = queens.find(c => c.tileX === 19 && c.tileY === y)!;
        expect(cell).toBeDefined();
        expect(cell.queen).toBe(view.colony);
        expect(view.queens).toContainEqual(expect.objectContaining({ queenId: id, tileX: cell.tileX, tileY: cell.tileY }));
        if (rules === "redesign") expect(cell.queenHp).toBe(config.queenHp!.hp);
        else expect(cell).not.toHaveProperty("queenHp");
      }
      expect(queens.find(c => c.tileX === enemyX && c.tileY === enemyY)).toMatchObject({ queen: enemy.id });
      expect(queens.find(c => c.tileX === enemyX && c.tileY === enemyY)!.queen).not.toBe(view.colony);
      expect(decoded.some(c => c.tileX === 45 && c.tileY === 5)).toBe(false);
      expect(view.queens).toHaveLength(3);
      expect(view.queens!.some(q => q.tileX === 45 && q.tileY === 5)).toBe(false);
      expect(denseCells(decoded, config.mapWidth, config.mapHeight).data).toBe(view.cells.data);
    } finally {
      await h.close();
    }
  });
});
