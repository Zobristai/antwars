import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SUB } from "../../src/sim/config.js";
import { UNIT } from "../../src/sim/geometry.js";
import { createMatch } from "../../src/sim/map.js";
import { markDirection, markEffect, markStrength, trailMark } from "../../src/sim/marks.js";
import type { Mark, SimState, Word } from "../../src/sim/types.js";
import { HISTORICAL_CONFIG, addAnt, emptyMatch, run, send, squadOf } from "./fixtures.js";
import { playable } from "../playable.ts";

function mark(id: number, tileX: number, tileY: number, words: Word[], laidTick = 0, colony: 0 | 1 = 0): Mark {
  return { id, agentId: "a", colony, tileX, tileY, words, laidTick, steering: 0 };
}

function joinedAt(seed = 5): SimState {
  return send(createMatch(seed, playable(HISTORICAL_CONFIG)), [{ type: "join", agentId: "a" }, { type: "join", agentId: "b" }]).state;
}

function antTile(state: SimState, agentId: string): { tileX: number; tileY: number } {
  const ant = squadOf(state, agentId)[0]!;
  return { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

describe("marks", () => {
  it("accepts one to three vocabulary words, laid on the tile of one of the agent's own ants", () => {
    const s = joinedAt();
    const at = antTile(s, "a");
    const tries: [readonly string[], { tileX: number; tileY: number }, boolean][] = [
      [[], at, false],
      [["FOOD", "N", "MANY", "HELP"], at, false],
      [["FOOD", "PIZZA"], at, false],
      [["food"], at, false],
      [["FOOD"], { tileX: 40, tileY: 40 }, false],
      [["FOOD", "N", "MANY"], at, true],
    ];
    for (const [words, tile, ok] of tries) {
      const out = send(s, [{ type: "mark", agentId: "a", ...tile, words }]);
      expect(out.results[0]?.ok).toBe(ok);
      expect(out.state.marks).toHaveLength(ok ? 1 : 0);
    }
  });

  it("keeps at most 3 live marks per agent, a fourth replacing the oldest", () => {
    let s = joinedAt();
    const ids: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = send(s, [{ type: "mark", agentId: "a", ...antTile(s, "a"), words: ["HELP"] }]);
      expect(out.results[0]?.ok).toBe(true);
      ids.push(out.state.nextMarkId - 1);
      s = run(out.state, 99).state;
    }
    expect(s.marks.filter((m) => m.agentId === "a").map((m) => m.id)).toEqual(ids.slice(1));
  });

  it("fades after its configured lifetime", () => {
    const out = send(joinedAt(), [{ type: "mark", agentId: "a", ...antTile(joinedAt(), "a"), words: ["NEST"] }]);
    const laid = out.state.marks[0]!.laidTick;
    // Steps are deterministic, so the fade tick continues the almost-faded run (one simulation, not two).
    const almost = run(out.state, DEFAULT_CONFIG.markLifetimeTicks - 2).state;
    const alive = run(almost, 1).state;
    expect(alive.tick).toBe(laid + DEFAULT_CONFIG.markLifetimeTicks);
    expect(alive.marks).toHaveLength(0);
    expect(almost.marks).toHaveLength(1);
    expect(DEFAULT_CONFIG.markLifetimeTicks).toBe(1800);
  });

  it("appears only in its own colony's agents' views, within smell range of any living colony ant", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "join", agentId: "enemy" },
      { type: "join", agentId: "mate", colony: 0 },
    ]).state;
    expect(s.agents.map((a) => a.colony)).toEqual([0, 1, 0]);
    s = send(s, [{ type: "mark", agentId: "a", ...antTile(s, "a"), words: ["ENEMY", "MANY"] }]).state;
    const id = s.marks[0]!.id;
    // Bring an enemy squad within smell range of the mark.
    for (const ant of squadOf(s, "enemy")) ant.x = s.colonies[0].queenX + 2 * SUB;
    let out = send(s, [
      { type: "observe", agentId: "a" },
      { type: "observe", agentId: "enemy" },
      { type: "observe", agentId: "mate" },
    ]);
    const [own, foe, mate] = out.results.map((r) => r.view!);
    expect(own!.marks.map((m) => m.markId)).toContain(id);
    expect(mate!.marks.map((m) => m.markId)).toContain(id);
    expect(foe!.marks).toHaveLength(0);
    expect(JSON.stringify(foe)).not.toContain('"ENEMY"');
    // Commit 692fb4785f40335cd1b97a8e82642a31b228d622: views use colony sight. The mate's squad
    // walking away does not hide the mark while other living colony ants are still within smell range.
    s = send(out.state, [{ type: "order", agentId: "mate", order: { kind: "go_to", tileX: 8, tileY: 2 } }]).state;
    s = run(s, 150).state;
    out = send(s, [{ type: "observe", agentId: "mate" }]);
    expect(out.results[0]!.view!.marks.map((m) => m.markId)).toContain(id);
    // Once no living colony ant is within smell range, the mark leaves the view.
    const laid = s.marks.find((m) => m.id === id)!;
    const farX = laid.tileX < s.config.mapWidth / 2 ? s.config.mapWidth - 2 : 1;
    expect(Math.abs(farX - laid.tileX)).toBeGreaterThan(s.config.smellTiles + 1);
    for (const ant of s.ants) if (ant.colony === 0 && ant.hp > 0) { ant.x = farX * SUB + SUB / 2; ant.y = laid.tileY * SUB + SUB / 2; }
    out = send(s, [{ type: "observe", agentId: "mate" }]);
    expect(out.state.marks.map((m) => m.id)).toContain(id);
    expect(out.results[0]!.view!.marks).toHaveLength(0);
  });
});

describe("steering by marks", () => {
  const config = DEFAULT_CONFIG;

  it("gives each word its effect; other words steer no ant", () => {
    for (const word of ["FOOD", "HELP", "ATTACK", "GATHER", "HOLD"] as const) expect(markEffect([word])).toEqual({ kind: "toward" });
    expect(markEffect(["AVOID"])).toEqual({ kind: "away" });
    expect(markEffect(["GO", "E"])).toEqual({ kind: "go", heading: { x: UNIT, y: 0 } });
    expect(markEffect(["N", "GO"])).toEqual({ kind: "go", heading: { x: 0, y: -UNIT } });
    for (const words of [["GO"], ["ENEMY"], ["QUEEN", "NEST"], ["FEW", "MANY", "W"]] as Word[][]) {
      expect(markEffect(words)).toBeNull();
    }
    const state = emptyMatch(0);
    const ant = addAnt(state, 0, 20, 20);
    expect(markDirection(mark(1, 25, 20, ["FOOD"]), ant).x).toBeGreaterThan(0);
    expect(markDirection(mark(1, 25, 20, ["AVOID"]), ant).x).toBeLessThan(0);
    expect(markDirection(mark(1, 25, 20, ["GO", "S"]), ant)).toEqual({ x: 0, y: UNIT });
  });

  it("is 0.7 at the mark, falling to zero at 10 tiles and at the end of its life", () => {
    const m = mark(1, 20, 20, ["FOOD"], 0);
    expect(markStrength(config, m, 20, 20, 0)).toBe(700);
    expect(markStrength(config, m, 25, 20, 0)).toBe(350);
    expect(markStrength(config, m, 30, 20, 0)).toBe(0);
    expect(markStrength(config, m, 20, 20, 900)).toBe(350);
    expect(markStrength(config, m, 20, 20, 1800)).toBe(0);
  });

  it("picks the strongest mark in smell range for follow trail", () => {
    const state = emptyMatch(0);
    // Grid scale 2: every reference tile distance doubles.
    const ant = addAnt(state, 0, 40, 40);
    state.marks = [mark(1, 52, 40, ["GO", "N"]), mark(2, 44, 40, ["GO", "S"]), mark(3, 42, 40, ["ENEMY"]), mark(4, 40, 40, ["FOOD"], 0, 1)];
    expect(trailMark(state, [ant], 0)?.id).toBe(2);
    state.marks = [mark(1, 58, 40, ["GO", "N"])];
    expect(trailMark(state, [ant], 0)).toBeNull();
  });

  it("moves no non-squad ant in a running match: free ants take their house direction whatever marks lie near", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "order", agentId: "a", order: { kind: "hold" } },
    ]).state;
    s = run(s, 99).state;
    const at = antTile(s, "a");
    const withMark = send(s, [{ type: "mark", agentId: "a", ...at, words: ["GO", "S"] }]);
    const without = send(s, [{ type: "observe", agentId: "a" }]);
    expect(withMark.state.marks).toHaveLength(1);
    expect(withMark.state.marks[0]!.steering).toBe(0);
    expect(withMark.results[0]!.view!.myMarks).toEqual([{ markId: withMark.state.marks[0]!.id, steering: 0, ...at }]);
    let free = 0;
    for (const ant of withMark.state.ants) {
      const other = without.state.ants.find((a) => a.id === ant.id)!;
      expect([ant.x, ant.y, ant.vx, ant.vy]).toEqual([other.x, other.y, other.vx, other.vy]);
      if (ant.squad === null) free += 1;
    }
    expect(free).toBeGreaterThan(0);
  });

  it("counts as steering the squad ants following the mark under follow trail, and no others", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "join", agentId: "b" },
      { type: "order", agentId: "a", order: { kind: "follow_trail" } },
    ]).state;
    s = run(s, 99).state;
    const at = antTile(s, "a");
    const laid = send(s, [{ type: "mark", agentId: "a", ...at, words: ["GO", "S"] }]);
    const squad = squadOf(laid.state, "a");
    expect(squad.length).toBeGreaterThan(0);
    expect(laid.state.marks[0]!.steering).toBe(squad.length);
    expect(laid.results[0]!.view!.myMarks).toEqual([{ markId: laid.state.marks[0]!.id, steering: squad.length, ...at }]);
    for (const ant of squad) {
      expect(ant.vx).toBe(0);
      expect(ant.vy).toBeGreaterThan(0);
    }
  });
});
