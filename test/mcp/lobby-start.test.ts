import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { DEFAULT_CONFIG, MAPS, PUBLIC_CONFIG, TERRAIN_RULES, SUB } from "../../src/sim/config.js";
import { createMatch, queenFoundingCost } from "../../src/sim/map.js";
import { headerLine, replay, stateHash } from "../../src/sim/log.js";
import { isPassable } from "../../src/sim/terrain.js";
import { playable } from "../playable.ts";

const seats = Array.from({ length: 4 }, (_, n) => [
  { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
]).flat();
const openedAt = 1000;

describe("private lobby finalization controller", () => {
  it("loads through the production Node type-stripping runtime", () => {
    const result = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "--input-type=module", "-e",
      'import { LobbyStart } from "./src/mcp/lobbyStart.ts"; if (typeof LobbyStart !== "function") process.exit(1);'], { encoding: "utf8" });
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  });
  it.each(MAPS)("$name freezes the same board and initializes connected picks plus never-connected defaults", map => {
    const config = { ...playable(PUBLIC_CONFIG), terrain: { ...TERRAIN_RULES, mapId: map.id } };
    const original = createMatch(7001, config), lobby = new LobbyStart(7001, config, seats, openedAt);
    expect(lobby.closesAt).toBe(openedAt + 120_000);
    expect(lobby.pick("left-3", 8, 24, openedAt + 1)).toEqual({ ok: true });
    expect(lobby.pick("right-3", 119, 24, openedAt + 1)).toEqual({ ok: true });
    expect(() => lobby.finish(lobby.closesAt - 1)).toThrow("still open");
    const state = lobby.finish(lobby.closesAt);
    expect(state.tick).toBe(0);
    expect(state.terrain).toEqual(original.terrain); expect(state.food).toEqual(original.food);
    expect(state.colonies.map(c => c.queens!.length)).toEqual([4, 4]);
    expect(state.colonies[0].queens![3]).toMatchObject({ queenX: 8500, queenY: 24500, starting: true });
    expect(state.colonies[1].queens![3]).toMatchObject({ queenX: 119500, queenY: 24500, starting: true });
    expect(new Set(state.colonies.flatMap(c => c.queens!.map(q => `${q.queenX},${q.queenY}`))).size).toBe(8);
    expect(state.ants.every(a => isPassable(state, Math.floor(a.x / SUB), Math.floor(a.y / SUB)))).toBe(true);
    expect(stateHash(replay([headerLine(state.seed, state.config)], 0))).toBe(stateHash(state));
    expect(stateHash(lobby.finish(lobby.closesAt + 100))).toBe(stateHash(state));
    expect(queenFoundingCost(state.colonies[0], state.config.queenFounding!)).toBe(400);
  });

  it("uses the configured test deadline without changing the finalized simulation", () => {
    const production = new LobbyStart(7001, playable(PUBLIC_CONFIG), seats, openedAt);
    const short = new LobbyStart(7001, playable(PUBLIC_CONFIG), seats, openedAt, 25);
    expect(production.closesAt).toBe(openedAt + 120_000);
    expect(short.closesAt).toBe(openedAt + 25);
    for (const lobby of [production, short]) expect(lobby.pick("left-3", 8, 24, openedAt + 1)).toEqual({ ok: true });
    expect(() => short.finish(openedAt + 24)).toThrow("still open");
    expect(short.pick("left-3", 9, 24, openedAt + 25)).toEqual({ ok: false, reason: "window_closed" });
    expect(stateHash(short.finish(short.closesAt))).toBe(stateHash(production.finish(production.closesAt)));
  });

  it("has no public projection and returns only the authenticated team's explicit picks", () => {
    const lobby = new LobbyStart(7001, playable(PUBLIC_CONFIG), seats, openedAt);
    lobby.pick("left-3", 8, 24, openedAt + 1);
    lobby.pick("right-3", 119, 24, openedAt + 1);
    expect(lobby.teamView("stranger")).toBeNull();
    expect(lobby.teamView("left-1")!.picks).toEqual([{ identityId: "left-3", tileX: 8, tileY: 24 }]);
    expect(lobby.teamView("right-1")!.picks).toEqual([{ identityId: "right-3", tileX: 119, tileY: 24 }]);
    expect(lobby.pick("left-1", 119, 24, openedAt + 2)).toEqual({ ok: false, reason: "outside_box" });
    lobby.finish(lobby.closesAt);
    expect(lobby.pick("left-3", 9, 24, lobby.closesAt)).toEqual({ ok: false, reason: "window_closed" });
  });

  it("does not carry a prior lobby's layout into a reused slot", () => {
    const first = new LobbyStart(7001, playable(PUBLIC_CONFIG), seats, openedAt).finish(openedAt + 120_000);
    const second = new LobbyStart(7002, first.config, seats.slice(0, 2), openedAt + 120_000);
    const final = second.finish(second.closesAt);
    expect(final.colonies.map(c => c.queens!.length)).toEqual([1, 1]);
    expect(final.seed).toBe(7002);
  });

  it("leaves ordinary and local createMatch calls on their existing start path", () => {
    expect(() => new LobbyStart(7001, playable(DEFAULT_CONFIG), seats, openedAt)).toThrow("queen founding");
    const local = createMatch(7001, playable(PUBLIC_CONFIG));
    expect(local.config.initialQueens).toBeUndefined();
    expect(local.colonies.map(c => c.queens!.length)).toEqual([1, 1]);
    expect(local.config.queenFounding!.costBasis).toBe("founded-live");
    expect(local.colonies[0].queens![0].starting).toBe(true);
    expect(queenFoundingCost(local.colonies[0], local.config.queenFounding!)).toBe(400);
  });
});
