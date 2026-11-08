import { describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { MissingStartPicksError, startBoxes } from "../../src/sim/startPlacement.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import type { RankedMode } from "../../src/rating/ratings.js";
import { playable } from "../playable.ts";

const seats = Array.from({ length: 4 }, (_, n) => [
  { identityId: `left-${n}`, displayName: `Left ${n}`, colony: 0 as const },
  { identityId: `right-${n}`, displayName: `Right ${n}`, colony: 1 as const },
]).flat();
function setup(startPickWindowMs?: number) {
  let now = 1000;
  const logs: string[] = [];
  const game = new Game({ simConfig: playable(PUBLIC_CONFIG), startPickWindowMs, now: () => now, onLogLine: line => logs.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  game.seatLobby("lobby", seats);
  return { game, logs, at: (time: number) => { now = time; } };
}

function modeSetup(size: number, mode: RankedMode | null) {
  let now = 1000;
  const logs: string[] = [];
  const game = new Game({ simConfig: playable(PUBLIC_CONFIG), now: () => now, onLogLine: line => logs.push(line),
    slot: { identityOf: async () => undefined, locate: async () => undefined } });
  const roster = ([0, 1] as const).flatMap(colony => Array.from({ length: size }, (_, n) => ({
    identityId: `team-${colony}`, displayName: `Team ${colony}`, colony, seat: n + 1,
  })));
  game.seatLobby("mode-lobby", roster, mode);
  const deadline = game.beginLobbyStart(7001);
  expect(deadline).toBe(1000 + 120_000);
  // Every mode stays pickable in the second minute, with no match or ticks yet.
  now = 1000 + 60_000;
  expect(() => game.finishLobbyStart()).toThrow("still open");
  expect(game.match).toBeNull(); expect(game.tick()).toBeNull();
  const board = createMatch(7001, game.simConfig);
  const tiles = ([0, 1] as const).map(colony => {
    const box = startBoxes(game.simConfig)[colony];
    const result: { tileX: number; tileY: number }[] = [];
    for (let y = box.y; y < box.y + box.height && result.length < size; y++) {
      for (let x = box.x; x < box.x + box.width && result.length < size; x++) {
        if (!isWaterTile(board.terrain, x, y) && !isRockTile(board.terrain, x, y) && board.food[y * board.config.mapWidth + x] === 0) {
          result.push({ tileX: x, tileY: y });
        }
      }
    }
    expect(result).toHaveLength(size);
    return result;
  });
  return { game, logs, roster, deadline, tiles, at: (time: number) => { now = time; } };
}

describe("house-mode required picks", () => {
  it.each([[1, "house-1v1"], [2, "house-2v2"], [3, "house-3v3"], [4, "house-4v4"]] as const)("starts %i seats in %s only with every seat's explicit pick", async (size, mode) => {
    const { game, logs, roster, deadline, tiles, at } = modeSetup(size, mode);
    for (const seat of roster) {
      const joined = (await game.joinSeated(seat.identityId, undefined, seat.seat))!;
      expect(game.nestSelection(joined.agentId!)!.required).toBe(true);
      const tile = tiles[seat.colony]![seat.seat - 1]!;
      expect(game.pickNest(joined.agentId!, tile.tileX, tile.tileY)).toEqual({ ok: true });
    }
    expect(game.match).toBeNull(); expect(logs).toEqual([]);
    at(deadline - 1);
    expect(() => game.finishLobbyStart()).toThrow("still open");
    at(deadline);
    game.finishLobbyStart();
    expect(game.match!.state.config.initialQueens).toEqual(tiles);
    expect(game.match!.state.tick).toBe(0);
    expect(logs).toHaveLength(1);
  });

  it.each([1, 2, 3, 4].flatMap(size => [false, true].map(connectMissing => ({ size, connectMissing }))))(
    "aborts house $size when the missing seat connected=$connectMissing, without defaults or logs", async ({ size, connectMissing }) => {
      const { game, logs, roster, deadline, tiles, at } = modeSetup(size, `house-${size}v${size}` as RankedMode);
      const joinedIds: string[] = [];
      for (const [index, seat] of roster.entries()) {
        const missing = index === roster.length - 1;
        if (missing && !connectMissing) continue;
        const joined = (await game.joinSeated(seat.identityId, undefined, seat.seat))!;
        joinedIds.push(joined.agentId!);
        if (missing) continue;
        const tile = tiles[seat.colony]![seat.seat - 1]!;
        expect(game.pickNest(joined.agentId!, tile.tileX, tile.tileY)).toEqual({ ok: true });
      }
      at(deadline);
      expect(() => game.finishLobbyStart()).toThrow(MissingStartPicksError);
      expect(game.match).toBeNull(); expect(game.tick()).toBeNull(); expect(logs).toEqual([]);
      game.endNotPlayed();
      for (const agentId of joinedIds) {
        expect(game.pickNest(agentId, 8, 24)).toEqual({ ok: false, reason: "match_not_played" });
        expect(game.nestSelection(agentId)).toBeNull();
      }
      const missing = roster.at(-1)!;
      expect((await game.joinSeated(missing.identityId, undefined, missing.seat))!.outcome).toMatchObject({ kind: "error", code: "match_not_played" });
      // Slot reuse must not retain the previous house's required-pick policy.
      game.seatLobby("unrated-next", roster);
      const nextDeadline = game.beginLobbyStart(7002);
      at(nextDeadline);
      game.finishLobbyStart();
      expect(game.match!.state.config.initialQueens!.map(team => team.length)).toEqual([size, size]);
    });

  it.each([1, 2, 3, 4].flatMap(size => [false, true].map(ranked => ({ size, ranked }))))(
    "keeps defaults for every seat of non-house size $size, ranked=$ranked", async ({ size, ranked }) => {
      const { game, roster, deadline, at } = modeSetup(size, ranked ? `${size}v${size}` as RankedMode : null);
      const joined = (await game.joinSeated(roster[0]!.identityId, undefined, 1))!;
      expect(game.nestSelection(joined.agentId!)!.required).toBe(false);
      at(deadline);
      game.finishLobbyStart();
      expect(game.match!.state.config.initialQueens!.map(team => team.length)).toEqual([size, size]);
      expect(game.match!.state.tick).toBe(0);
    });
});

describe("Game's private seated starting window", () => {
  it.each([undefined, 2_000])("withholds state, ticks and log until the deadline; includes never-connected seats (duration %s)", async (windowMs) => {
    const { game, logs, at } = setup(windowMs);
    const left = (await game.joinSeated("left-0"))!;
    const right = (await game.joinSeated("right-0"))!;
    expect(game.nestSelection(left.agentId!)).toBeNull();
    const deadline = game.beginLobbyStart(7001);
    expect(deadline).toBe(1000 + (windowMs ?? 120_000));
    expect(game.nextStart).toEqual({ kind: "scheduled", at: new Date(deadline) });
    expect(game.pickNest(left.agentId!, 8, 24)).toEqual({ ok: true });
    // Inside colony 1's start box (x 100-123 on the 128x96 board).
    expect(game.pickNest(right.agentId!, 119, 24)).toEqual({ ok: true });
    expect(game.match).toBeNull(); expect(game.tick()).toBeNull(); expect(logs).toEqual([]);
    at(deadline - 1);
    expect(() => game.finishLobbyStart()).toThrow("still open");
    expect(game.match).toBeNull(); expect(logs).toEqual([]);
    at(deadline);
    expect(game.pickNest(left.agentId!, 9, 24)).toEqual({ ok: false, reason: "window_closed" });
    game.finishLobbyStart();
    expect(game.match!.state.tick).toBe(0);
    expect(game.match!.state.colonies.map(c => c.queens!.length)).toEqual([4, 4]);
    expect(game.match!.state.colonies[0].queens![0]).toMatchObject({ queenX: 8500, queenY: 24500 });
    expect(game.match!.state.colonies[1].queens![0]).toMatchObject({ queenX: 119500, queenY: 24500 });
    expect(logs).toHaveLength(1);
    expect(game.nestSelection(left.agentId!)).toBeNull();
    expect(game.tick()!.state.tick).toBe(1);
  });

  it("returns only the bound team's names and picks, including reconnects; enforces shared call admission", async () => {
    const { game, at } = setup();
    game.beginLobbyStart(7001);
    const left = (await game.joinSeated("left-0"))!;
    const other = (await game.joinSeated("left-1"))!;
    const right = (await game.joinSeated("right-0"))!;
    expect(await game.joinSeated("outsider")).toBeNull();
    expect(game.nestSelection("outsider")).toBeNull();
    expect(game.pickNest("outsider", 8, 24)).toEqual({ ok: false, reason: "not_seated" });
    expect(game.pickNest(left.agentId!, 8, 24)).toEqual({ ok: true });
    expect(game.pickNest(left.agentId!, 9, 24)).toEqual({ ok: false, reason: "call_rate", retryAfterMs: 1000 });
    expect(game.nestSelection(right.agentId!)!.picks).toEqual([]);
    expect(game.nestSelection(other.agentId!)!.picks).toEqual([{ displayName: "Left 0", mine: false, tileX: 8, tileY: 24 }]);
    at(2000);
    expect(game.pickNest(other.agentId!, 8, 24)).toEqual({ ok: false, reason: "occupied" });
    expect(game.pickNest(left.agentId!, 9, 24)).toEqual({ ok: true });
    expect((await game.joinSeated("left-0"))!.agentId).toBe(left.agentId);
    expect(game.nestSelection(left.agentId!)!.picks).toEqual([{ displayName: "Left 0", mine: true, tileX: 9, tileY: 24 }]);
    expect(game.match).toBeNull();
  });

  it.each([undefined, 2_000])("abandons provisional picks and refuses retired identities after slot replacement (duration %s)", async (windowMs) => {
    const { game, at } = setup(windowMs);
    const deadline = game.beginLobbyStart(7001);
    const left = (await game.joinSeated("left-0"))!;
    game.pickNest(left.agentId!, 8, 24);
    game.endNotPlayed();
    at(deadline);
    expect(() => game.finishLobbyStart()).toThrow("No lobby pick window");
    expect(game.pickNest(left.agentId!, 9, 24)).toEqual({ ok: false, reason: "match_not_played" });
    expect(game.nestSelection(left.agentId!)).toBeNull();
    game.seatLobby("replacement", seats);
    game.beginLobbyStart(7002);
    expect(game.nestSelection(left.agentId!)).toBeNull();
    expect(game.pickNest(left.agentId!, 9, 24)).toEqual({ ok: false, reason: "match_not_played" });
    expect(game.nestSelection((await game.joinSeated("left-0"))!.agentId!)!.picks).toEqual([]);
  });

  it("leaves non-slot local games on their immediate start path", () => {
    const game = new Game({ simConfig: playable(PUBLIC_CONFIG) });
    expect(() => game.beginLobbyStart(7001)).toThrow("No seated lobby");
    game.startMatch(7001);
    expect(game.match!.state.config.initialQueens).toBeUndefined();
    expect(game.match!.state.colonies.map(c => c.queens!.length)).toEqual([1, 1]);
  });
});
