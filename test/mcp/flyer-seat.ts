/// <reference types="node" />
import { expect } from "vitest";
import { FLYER_RULES, rulesConfig, rulesVersionOf, SUB, type SimConfig } from "../../src/sim/config.js";
import { createVisibility, expandFlyers, type DenseFlyers, type ViewFlyer } from "../../src/sim/view.js";
import { isRockTile, isWaterTile, isPassable } from "../../src/sim/terrain.js";
import type { Ant, ColonyId, SimEvent, SimState } from "../../src/sim/types.js";
import { addAnt } from "../sim/fixtures.js";
import { startHarness, type CallResult, type Harness, type TestAgent } from "./harness.js";

/** The configuration every served match plays: rules version 28, with flyers. */
export const SERVED: SimConfig = rulesConfig("redesign");

/** A rated seat (ranked 1v1 lobby) and an unrated one (a lobby with no ranked mode). */
export const SEAT_MODES = [{ mode: "1v1", label: "rated" }, { mode: null, label: "unrated" }] as const;
export type SeatMode = (typeof SEAT_MODES)[number]["mode"];

export interface Tile { readonly tileX: number; readonly tileY: number }

/** A lobby slot match on the served configuration, colony 0's and colony 1's seats joined through MCP. */
export interface FlyerSeat {
  readonly h: Harness;
  readonly agent: TestAgent;
  readonly agentId: string;
  readonly enemy: TestAgent;
  readonly enemyId: string;
  /** The seat's join reply. */
  readonly joined: CallResult;
  /** Every SimEvent each tick produced, in order. */
  readonly events: SimEvent[];
  state(): SimState;
}

export async function seatFlyers(mode: SeatMode, prepare: (state: SimState) => void = () => {}): Promise<FlyerSeat> {
  const h = await startHarness({ start: false, simConfig: SERVED, slot: {
    identityOf: async key => key === "flyer-key" ? "flyer-seat" : key === "enemy-key" ? "enemy-seat" : undefined,
    locate: async () => undefined,
  } });
  h.game.seatLobby("flyer-lobby", [
    { identityId: "flyer-seat", displayName: "Flyer", colony: 0 },
    { identityId: "enemy-seat", displayName: "Enemy", colony: 1 },
  ], mode);
  h.game.startMatch(41);
  const events: SimEvent[] = [];
  const tick = h.game.tick.bind(h.game);
  h.game.tick = (...args: Parameters<typeof tick>) => {
    const out = tick(...args);
    if (out !== null) events.push(...out.events);
    return out;
  };
  const state = () => h.game.match!.state;
  expect(rulesVersionOf(state().config)).toBe(28);
  expect(state().config.flyers).toEqual(FLYER_RULES);
  prepare(state());
  const agent = await h.connect(), enemy = await h.connect();
  const joined = await agent.call("join", { key: "flyer-key" });
  expect(joined.isError, joined.text).toBe(false);
  const joinedEnemy = await enemy.call("join", { key: "enemy-key" });
  expect(joinedEnemy.isError, joinedEnemy.text).toBe(false);
  return { h, agent, agentId: joined.data.agentId as string, enemy, enemyId: joinedEnemy.data.agentId as string, joined, events, state };
}

/** Wait out the command allowance so the next command is accepted on time. */
export function nextCommand(seat: FlyerSeat): void {
  seat.h.advance(seat.state().config.commandFloorTicks);
}

/** A flyer of the colony placed on a tile, as a hatched flyer stands: on the ground, with no lockout. */
export function placeFlyer(state: SimState, colony: ColonyId, tile: Tile): Ant {
  return addAnt(state, colony, tile.tileX, tile.tileY, { flyer: true, hp: FLYER_RULES.hp });
}

/** An ant of the colony giving sight around a tile for the next command (free ants walk, so place it just before). */
export function scoutAt(state: SimState, colony: ColonyId, tile: Tile): Ant {
  return addAnt(state, colony, tile.tileX, tile.tileY);
}

export const centre = (t: number): number => t * SUB + SUB / 2;

/** Whether the colony sees the tile now, by the same sight circle observe uses. */
export function seen(state: SimState, colony: ColonyId, tile: Tile): boolean {
  return createVisibility(state).range(colony, state.config.sightTiles)[tile.tileY * state.config.mapWidth + tile.tileX] === 1;
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** A water (or rock) tile with a land tile beside it, scanning rows from the top. */
export function obstacleBeside(state: SimState, kind: "water" | "rock"): { obstacle: Tile; land: Tile } {
  const test = kind === "water" ? isWaterTile : isRockTile;
  for (let y = 1; y < state.config.mapHeight - 1; y++) for (let x = 1; x < state.config.mapWidth - 1; x++) {
    if (!test(state.terrain, x, y)) continue;
    for (const [dx, dy] of NEIGHBOURS) if (isPassable(state, x + dx, y + dy)) return { obstacle: { tileX: x, tileY: y }, land: { tileX: x + dx, tileY: y + dy } };
  }
  throw new Error(`no ${kind} tile beside land on this map`);
}

/** Where a lone scout's sight ends along a row: the last land tile it sees (r tiles east) and the first it does not
 * (r + 1), on land no other colony ant sees now. The scout itself is placed just before the command. */
export function sightEdge(state: SimState, colony: ColonyId): { scout: Tile; lastSeen: Tile; firstUnseen: Tile } {
  const r = state.config.sightTiles, mask = createVisibility(state).range(colony, r), width = state.config.mapWidth;
  for (let y = 2; y < state.config.mapHeight - 2; y++) for (let x = 2; x + r + 1 < width - 2; x++) {
    const row = Array.from({ length: r + 2 }, (_, i) => ({ tileX: x + i, tileY: y }));
    if (!row.every(tile => isPassable(state, tile.tileX, tile.tileY) && mask[tile.tileY * width + tile.tileX] === 0)) continue;
    return { scout: row[0]!, lastSeen: row[r]!, firstUnseen: row[r + 1]! };
  }
  throw new Error("no sight edge on this map");
}

/** Land tiles the colony sees now, nearest its first queen first: deep in its nest area, so they stay in sight while
 * its free ants wander, for marks that must be accepted and sighted. */
export function seenLand(state: SimState, colony: ColonyId, count: number): Tile[] {
  const queen = state.colonies[colony].queens![0]!, qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
  const mask = createVisibility(state).range(colony, state.config.sightTiles), width = state.config.mapWidth;
  const seenTiles: Tile[] = [];
  for (let i = 0; i < mask.length; i++) {
    const tile = { tileX: i % width, tileY: Math.floor(i / width) };
    if (mask[i] === 1 && isPassable(state, tile.tileX, tile.tileY)) seenTiles.push(tile);
  }
  const d = (t: Tile) => (t.tileX - qx) ** 2 + (t.tileY - qy) ** 2;
  const tiles = seenTiles.sort((a, b) => d(a) - d(b) || a.tileY - b.tileY || a.tileX - b.tileX).slice(0, count);
  expect(tiles).toHaveLength(count);
  return tiles;
}

/** The decoded view.flyers of an observe or join reply. */
export function viewFlyers(reply: CallResult): ViewFlyer[] {
  const flyers = reply.data.view?.flyers as DenseFlyers | undefined;
  expect(flyers, reply.text).toBeDefined();
  return expandFlyers(flyers!);
}

/** One ant of the live match by id. */
export function antOf(state: SimState, id: number): Ant | undefined {
  return state.ants.find(ant => ant.id === id);
}
