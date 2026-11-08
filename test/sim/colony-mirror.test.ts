import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_V4_CONFIG, rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { withGridScale, newMatchConfig } from "../../src/sim/gridScale.js";
import { forageDirection } from "../../src/sim/forage.js";
import { houseDirection } from "../../src/sim/houseBot.js";
import { beginLocalGoals, currentLocalGoals } from "../../src/sim/localArrival.js";
import { headerLine, parseLog } from "../../src/sim/log.js";
import { buildGrid, createMatch, mirrorTileX, newAnt } from "../../src/sim/map.js";
import type { Ant } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

// Every match plays at grid scale 2: scale is that one grid scale; grid scales 1 and 4 are retired.
const scene = (_scale: 2) => createMatch(340, {
  ...withGridScale(rulesConfig("redesign")),
  startAnts: 0, terrain: undefined, foodLayout: undefined, foodPatches: [],
});
type IntentAnt = Ant & { houseIntentHold?: { intent: { kind: string; x: number; y: number } } };

describe("stored colony mirror marker", () => {
  it.each([DEFAULT_CONFIG, RULES_V4_CONFIG, PUBLIC_CONFIG, rulesConfig("v4"), rulesConfig("count-marks"),
    rulesConfig("redesign"), newMatchConfig(rulesConfig("redesign"))].map(playable))("records rules 25 on new configs and headers (%#)", config => {
    expect(config.colonyMirror).toBe(true);
    const { header } = parseLog([headerLine(340, config)]);
    expect(header.rulesVersion).toBe(27);
    expect(JSON.stringify(header.config)).toBe(JSON.stringify(config));
  });
});

for (const scale of [2] as const) {
  describe(`mirrored planner goals at grid scale ${scale}`, () => {
    it.each(["fighter", "guard"] as const)("pairs %s lanes/posts across opposite-colony birth ids", role => {
      for (let id = 1; id < 60; id += 2) {
        const state = scene(scale);
        const ants = ([0, 1] as const).map(colony => {
          const home = state.colonies[colony];
          const ant = newAnt(state.config, id + colony, colony, home.queenX, home.queenY);
          ant.role = role; ant.guardQueenId = 0;
          return ant;
        });
        state.ants = ants.slice().reverse();
        beginLocalGoals(state);
        const grid = buildGrid(state);
        for (const ant of ants) houseDirection(state, grid, [], ant);
        const [left, right] = ants.map(ant => (ant as IntentAnt).houseIntentHold!.intent);
        expect(left.kind).toBe(role === "fighter" ? "rally" : "post");
        expect(right.kind).toBe(left.kind);
        expect(right.x).toBe(state.config.mapWidth * SUB - left.x);
        expect(right.y).toBe(left.y);
        // Fixed prototype formula, not a second call to the planner implementation.
        expect(left.y).toBe(role === "fighter" ? (2 + (id * 37) % 44 + .5) * SUB * scale
          : state.colonies[0].queenY + ((Math.trunc(id / 3) % 3) - 1) * SUB * scale);
        if (role === "guard") expect(left.x).toBe(state.colonies[0].queenX + ((id % 3) - 1) * SUB * scale);
      }
    });

    it("starts queens and ants in mirrored half-open tiles", () => {
      const config = withGridScale(rulesConfig("redesign"));
      const state = createMatch(340, config);
      for (const colony of [0, 1] as const) {
        const queen = state.colonies[colony];
        // A queen on a tile boundary moves one subunit into its own half-open tile.
        expect(queen.queenX % SUB).not.toBe(0);
        expect(queen.queens![0].queenX).toBe(queen.queenX);
      }
      expect(state.colonies[1].queenX).toBe(config.mapWidth * SUB - state.colonies[0].queenX);
      expect(state.colonies[1].queenY).toBe(state.colonies[0].queenY);
      const tile = (x: number) => Math.floor(x / SUB);
      expect(tile(state.colonies[1].queenX)).toBe(mirrorTileX(config, tile(state.colonies[0].queenX)));
      for (let i = 0; i < state.ants.length; i += 2) {
        const left = state.ants[i], right = state.ants[i + 1];
        expect(right.x).toBe(config.mapWidth * SUB - left.x);
        expect(tile(right.x)).toBe(mirrorTileX(config, tile(left.x)));
        expect(right.y).toBe(left.y);
        expect(right.id).toBe(left.id + 1);
      }
    });

    it("keeps finalized whole-tile queen picks and their ant offsets unchanged", () => {
      const base = scene(scale).config, left = { tileX: 5 * scale, tileY: 20 * scale };
      const right = { tileX: mirrorTileX(base, left.tileX), tileY: left.tileY };
      const config: SimConfig = { ...base, startArea: "back-quarter", startAnts: 10, initialQueens: [[left], [right]] };
      const state = createMatch(340, config);
      expect(state.colonies.map(c => [c.queenX, c.queenY])).toEqual([
        [(left.tileX + .5) * SUB, (left.tileY + .5) * SUB],
        [(right.tileX + .5) * SUB, (right.tileY + .5) * SUB],
      ]);
    });

    it.each([0, 1])("uses mirrored delivery reach, extra distance=%i", extra => {
      const state = scene(scale), reach = state.config.nestDeliverTiles;
      const tx = Math.floor(state.colonies[0].queenX / SUB) + reach + extra;
      const ty = Math.floor(state.colonies[0].queenY / SUB);
      state.ants = ([0, 1] as const).map(colony => {
        const x = colony === 0 ? tx : mirrorTileX(state.config, tx);
        const ant = newAnt(state.config, colony + 1, colony, (x + .5) * SUB, (ty + .5) * SUB);
        ant.carrying = true; return ant;
      });
      beginLocalGoals(state);
      for (const ant of state.ants) forageDirection(state, ant, []);
      for (const ant of state.ants) expect(currentLocalGoals(state).get(ant.id)).toMatchObject({ kind: "home", nativeReached: extra === 0 });
    });
  });
}
