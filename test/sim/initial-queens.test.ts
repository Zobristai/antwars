import { describe, expect, it } from "vitest";
import { MAPS, PUBLIC_CONFIG, TERRAIN_RULES, SUB, type SimConfig } from "../../src/sim/config.js";
import { foundQueen } from "../../src/sim/agents.js";
import { createMatch, queenFoundingCost } from "../../src/sim/map.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile, isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { StartPlacement } from "../../src/sim/startPlacement.js";
import type { SimEvent } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

function finalized(mapId = "open-field", count = 4) {
  // Every match plays at grid scale 2: tiles below are fine tiles, reference tiles doubled.
  const config: SimConfig = playable({ ...PUBLIC_CONFIG, terrain: { ...TERRAIN_RULES, mapId } });
  const base = createMatch(7001, config);
  const seats = Array.from({ length: count }, (_, n) => [
    { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
  ]).flat();
  const window = new StartPlacement(config, seats, 1000, (x, y) => isWaterTile(base.terrain, x, y) ? "water"
    : isRockTile(base.terrain, x, y) ? "rock" : base.food[y * config.mapWidth + x] > 0 ? "food" : null);
  // A pick and never-connected defaults use the same real generated board.
  expect(window.pick("left-0", 16, 48, 1001)).toEqual({ ok: true });
  const nests = window.finish(window.closesAt);
  const layout = (colony: 0 | 1) => nests.filter(n => n.colony === colony).map(n => ({ tileX: n.tileX, tileY: n.tileY }));
  const selected: SimConfig = { ...config, initialQueens: [layout(0), layout(1)],
    queenFounding: { ...config.queenFounding!, costBasis: "founded-live" } };
  return { base, nests, config: selected, state: createMatch(7001, selected) };
}

describe("explicit finalized starting layouts", () => {
  it.each(MAPS)("$name installs every starting queen without changing the picked board", map => {
    const { base, state, nests } = finalized(map.id);
    expect(state.terrain).toEqual(base.terrain);
    expect(state.food).toEqual(base.food); expect(state.foodCap).toEqual(base.foodCap);
    expect(state.rngState).toBe(base.rngState);
    expect(state.ants.map(a => [a.id, a.colony])).toEqual(base.ants.map(a => [a.id, a.colony]));
    for (const nest of nests) {
      expect(state.colonies[nest.colony].queens![nest.queenId]).toMatchObject({ id: nest.queenId,
        queenX: (nest.tileX + .5) * SUB, queenY: (nest.tileY + .5) * SUB, starting: true, foundedTick: 0 });
    }
    for (const ant of state.ants) {
      expect(ant.x).toBeGreaterThanOrEqual(0); expect(ant.x).toBeLessThan(state.config.mapWidth * SUB);
      expect(ant.y).toBeGreaterThanOrEqual(0); expect(ant.y).toBeLessThan(state.config.mapHeight * SUB);
      expect(isBlockedTile(state.terrain, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(false);
    }
    for (const colony of state.colonies) {
      expect(colony.queens).toHaveLength(4);
      expect(colony.queenX).toBe(colony.queens![0].queenX);
      expect(colony.queenY).toBe(colony.queens![0].queenY);
    }
  });

  it("serializes actual finalized positions and replays them, including starting identities", () => {
    const { config } = finalized();
    const lines = [headerLine(7001, config)];
    let state = createMatch(7001, config);
    for (let i = 0; i < 30; i++) state = step(state, []).state;
    expect(stateHash(replay(lines, 30))).toBe(stateHash(state));
    expect(replay(lines, 0).colonies[0].queens).toHaveLength(4);
  });

  it.each([1, 2, 4])("counts only live founded queens with %i starting queens", count => {
    const { state } = finalized("open-field", count), rules = state.config.queenFounding!, colony = state.colonies[0];
    expect(queenFoundingCost(colony, rules)).toBe(400);
    const created = { ...colony.queens![0], id: count, starting: undefined, foundedTick: 3000 };
    colony.queens!.push(created);
    expect(queenFoundingCost(colony, rules)).toBe(800);
    colony.queens!.push({ ...created, id: count + 1 });
    expect(queenFoundingCost(colony, rules)).toBe(1600);
    colony.queens![0].lostTick = 4000;
    expect(queenFoundingCost(colony, rules)).toBe(1600);
    created.lostTick = 4000;
    expect(queenFoundingCost(colony, rules)).toBe(800);
    colony.queens![count + 1].lostTick = 4000;
    expect(queenFoundingCost(colony, rules)).toBe(400);
  });

  it("real founding spends 400 and has a new non-starting identity", () => {
    const { state } = finalized();
    state.tick = state.config.queenFounding!.firstFoundTick!;
    state.colonies[0].foodStore = 10000;
    const rules = state.config.queenFounding!;
    let target: { x: number; y: number } | undefined;
    for (let y = 0; y < state.config.mapHeight && !target; y++) for (let x = 0; x < state.config.mapWidth && !target; x++) {
      if (isBlockedTile(state.terrain, x, y)) continue;
      if (state.colonies.some(c => c.queens!.some(q => (x - Math.floor(q.queenX / SUB)) ** 2
        + (y - Math.floor(q.queenY / SUB)) ** 2 < rules.minDistanceTiles ** 2))) continue;
      target = { x, y };
    }
    expect(target).toBeDefined();
    state.owner[target!.y * state.config.mapWidth + target!.x] = 0;
    const events: SimEvent[] = [];
    expect(foundQueen(state, 0, target!.x, target!.y, state.tick, events)).toBeNull();
    expect(state.colonies[0].foodStore).toBe(9600);
    expect(state.colonies[0].queens!.at(-1)!.starting).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: "queen_founded", queenId: 4, foodCost: 400 }));
  });

  it("rejects invalid explicit layouts instead of silently moving a chosen nest", () => {
    const { config } = finalized();
    expect(() => createMatch(7001, { ...config, initialQueens: [[{ tileX: 0, tileY: 0 }], [{ tileX: 111, tileY: 48 }]] })).toThrow("Invalid initial queen tile");
    expect(() => createMatch(7001, { ...config, initialQueens: [[{ tileX: 16, tileY: 48 }, { tileX: 16, tileY: 48 }], [{ tileX: 111, tileY: 48 }]] })).toThrow("Invalid initial queen tile");
    expect(() => createMatch(7001, { ...config, initialQueens: [[], []] })).toThrow("nonempty");
  });

});
