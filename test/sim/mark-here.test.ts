import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SUB } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimInput, SimState } from "../../src/sim/types.js";
import { emptyMatch, run, send, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

/** A mark that leaves out its tile is laid where one of the agent's squad ants stands. */

function tileOf(ant: { x: number; y: number }): { tileX: number; tileY: number } {
  return { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

/** The squad ant a tile-less mark goes on: nearest the squad's mean position, ties to the lowest id. */
function nearestMeanAnt(state: SimState, agentId: string) {
  const squad = squadOf(state, agentId);
  const mx = squad.reduce((n, a) => n + a.x, 0) / squad.length;
  const my = squad.reduce((n, a) => n + a.y, 0) / squad.length;
  const d = (a: { x: number; y: number }) => (a.x - mx) ** 2 + (a.y - my) ** 2;
  return [...squad].sort((a, b) => d(a) - d(b) || a.id - b.id)[0]!;
}

/** Agent a's squad, by ascending ant id, put on the given tiles before the call is processed. */
function placed(tiles: readonly (readonly [number, number])[]): { state: SimState; ids: number[] } {
  const { now } = moving();
  const squad = [...squadOf(now, "a")].sort((a, b) => a.id - b.id);
  expect(squad).toHaveLength(tiles.length);
  squad.forEach((ant, i) => {
    ant.x = tileCentre(tiles[i]![0]);
    ant.y = tileCentre(tiles[i]![1]);
  });
  return { state: now, ids: squad.map((ant) => ant.id) };
}

/** Two agents joined, agent a's squad sent marching across the map, then the command floor waited out. */
function moving(): { before: SimState; now: SimState } {
  let s = send(createMatch(5), [{ type: "join", agentId: "a" }, { type: "join", agentId: "b" }]).state;
  s = run(s, 10).state;
  const target = s.colonies[0].queenX < (s.config.mapWidth * SUB) / 2 ? s.config.mapWidth - 2 : 1;
  s = send(s, [{ type: "order", agentId: "a", order: { kind: "go_to", tileX: target, tileY: 20 } }]).state;
  const before = run(s, DEFAULT_CONFIG.commandFloorTicks - 30).state;
  const now = run(before, 30).state;
  return { before, now };
}

describe("mark here: a mark without a tile", () => {
  it("is laid standalone on the tile of the squad ant nearest the squad's mean position at the processing tick, though the squad has moved", () => {
    const { before, now } = moving();
    const expected = tileOf(nearestMeanAnt(now, "a"));
    expect(expected).not.toEqual(tileOf(nearestMeanAnt(before, "a")));
    const out = send(now, [{ type: "mark", agentId: "a", words: ["FOOD", "N"] }]);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.state.marks).toHaveLength(1);
    expect(out.state.marks[0]).toMatchObject({ agentId: "a", ...expected, words: ["FOOD", "N"] });
    expect(out.events.filter((e) => e.type === "mark_laid")).toEqual([expect.objectContaining(expected)]);
  });

  it("is laid when carried by an order, and the order is applied", () => {
    const { now } = moving();
    const expected = tileOf(nearestMeanAnt(now, "a"));
    const out = send(now, [{ type: "order", agentId: "a", order: { kind: "hold" }, mark: { words: ["HOLD"] } }]);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.state.marks[0]).toMatchObject({ agentId: "a", ...expected });
    expect(out.state.agents.find((a) => a.id === "a")!.order).toEqual({ kind: "hold" });
  });

  it("with a spread-out squad, lands under the ant nearest the mean, not the lowest id", () => {
    // Mean column (2 + 4*30 + 24) / 6 = 24.33: the highest-id ant at column 24 is nearest; the lowest id is farthest.
    const { state, ids } = placed([[2, 24], [30, 24], [30, 24], [30, 24], [30, 24], [24, 24]]);
    expect(nearestMeanAnt(state, "a").id).toBe(ids[5]);
    const out = send(state, [{ type: "mark", agentId: "a", words: ["GATHER"] }]);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.state.marks[0]).toMatchObject({ tileX: 24, tileY: 24 });
    const ordered = send(state, [{ type: "order", agentId: "a", order: { kind: "hold" }, mark: { words: ["GATHER"] } }]);
    expect(ordered.state.marks[0]).toMatchObject({ tileX: 24, tileY: 24 });
  });

  it("breaks a tie for nearest the mean by the lowest ant id", () => {
    // Mean (12,24): the second and fourth ants are both 4 tiles from it; the others 20. The lower id of the pair wins.
    const { state } = placed([[12, 4], [8, 24], [12, 44], [16, 24], [12, 4], [12, 44]]);
    const out = send(state, [{ type: "mark", agentId: "a", words: ["HOLD"] }]);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.state.marks[0]).toMatchObject({ tileX: 8, tileY: 24 });
  });

  it("chooses the same ant every time the same state is stepped", () => {
    const { now } = moving();
    const once = send(now, [{ type: "mark", agentId: "a", words: ["HELP"] }]);
    const again = send(now, [{ type: "mark", agentId: "a", words: ["HELP"] }]);
    expect(stateHash(again.state)).toBe(stateHash(once.state));
  });

  it("is refused with no_own_ant_on_tile when the squad has no ant, standalone and on an order, which is not applied", () => {
    const s = send(emptyMatch(), [{ type: "join", agentId: "a" }]).state;
    expect(squadOf(s, "a")).toHaveLength(0);
    const standalone = send(s, [{ type: "mark", agentId: "a", words: ["HELP"] }]);
    expect(standalone.results[0]).toMatchObject({ ok: false, error: { code: "no_own_ant_on_tile" } });
    expect(standalone.state.marks).toHaveLength(0);

    const ordered = send(s, [{ type: "order", agentId: "a", order: { kind: "hold" }, mark: { words: ["HELP"] } }]);
    const result = ordered.results[0]!;
    expect(result).toMatchObject({ ok: false, error: { code: "no_own_ant_on_tile" } });
    expect(ordered.state.marks).toHaveLength(0);
    expect(ordered.state.agents.find((a) => a.id === "a")!.order).toEqual({ kind: "forage" });
    expect(ordered.events.some((e) => e.type === "order")).toBe(false);
  });

  it("refusal says the carrying order was not applied and that leaving out the tile marks where the squad is", () => {
    const { now } = moving();
    const far = { tileX: 0, tileY: 0 };
    const out = send(now, [{ type: "order", agentId: "a", order: { kind: "hold" }, mark: { ...far, words: ["HELP"] } }]);
    const message = (out.results[0] as { error: { message: string } }).error.message;
    expect(message).toContain("an order carrying this mark was not applied either");
    expect(message).toContain("Leave out tileX and tileY");
  });
});

describe("mark here: calls that name a tile", () => {
  it("still refuse a tile no squad ant stands on, discarding the carrying order", () => {
    const { now } = moving();
    const at = tileOf(nearestMeanAnt(now, "a"));
    const off = { tileX: at.tileX === 0 ? 1 : at.tileX - 1, tileY: 0 };
    expect(squadOf(now, "a").some((ant) => tileOf(ant).tileX === off.tileX && tileOf(ant).tileY === off.tileY)).toBe(false);
    const out = send(now, [{ type: "order", agentId: "a", order: { kind: "hold" }, mark: { ...off, words: ["HELP"] } }]);
    expect(out.results[0]).toMatchObject({ ok: false, error: { code: "no_own_ant_on_tile" } });
    expect(out.state.marks).toHaveLength(0);
    expect(out.state.agents.find((a) => a.id === "a")!.order).not.toEqual({ kind: "hold" });
  });

  it("still lay the mark on the named tile when a squad ant stands there", () => {
    const { now } = moving();
    const ants = [...squadOf(now, "a")].sort((a, b) => b.id - a.id);
    const at = tileOf(ants[0]!);
    const out = send(now, [{ type: "mark", agentId: "a", ...at, words: ["NEST"] }]);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect(out.state.marks[0]).toMatchObject(at);
  });

  it("refuse a mark that names only one axis", () => {
    const { now } = moving();
    const at = tileOf(nearestMeanAnt(now, "a"));
    const out = send(now, [{ type: "mark", agentId: "a", tileX: at.tileX, words: ["NEST"] } as SimInput]);
    expect(out.results[0]).toMatchObject({ ok: false, error: { code: "no_own_ant_on_tile" } });
  });
});

describe("mark here: replay", () => {
  it("a log with tile-less marks replays to the same final state hash", () => {
    const seed = 12;
    const until = 1200;
    let state = createMatch(seed, playable(DEFAULT_CONFIG));
    const lines = [headerLine(seed, playable(DEFAULT_CONFIG))];
    let laid = 0;
    const script = (tick: number): SimInput[] => {
      if (tick === 0) return [{ type: "join", agentId: "a" }, { type: "join", agentId: "b" }];
      if (tick === 20) return [{ type: "order", agentId: "a", order: { kind: "go_to", tileX: 60, tileY: 40 }, mark: { words: ["GO", "E"] } }];
      if (tick === 300) return [{ type: "mark", agentId: "a", words: ["FOOD", "MANY"] }, { type: "mark", agentId: "b", words: ["HELP"] }];
      if (tick === 700) return [{ type: "order", agentId: "b", order: { kind: "forage" }, mark: { words: ["NEST"] } }];
      return [];
    };
    while (state.tick < until && state.result === null) {
      const inputs = script(state.tick);
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      const out = step(state, inputs);
      laid += out.events.filter((e) => e.type === "mark_laid").length;
      state = out.state;
    }
    expect(laid).toBe(4);
    expect(lines.some((line) => line.includes('"mark":{"words"'))).toBe(true);
    const end = replay(lines, until);
    expect(stateHash(end)).toBe(stateHash(state));
  });
});
