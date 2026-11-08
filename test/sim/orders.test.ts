import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, MAPS, TERRAIN_RULES, SUB, speedPerTick } from "../../src/sim/config.js";
import { isPassable } from "../../src/sim/terrain.js";
import { idiv, tileCentre, UNIT } from "../../src/sim/geometry.js";
import { createMatch } from "../../src/sim/map.js";
import { markDirection } from "../../src/sim/marks.js";
import type { Ant, SimInput, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch, run, send, squadOf } from "./fixtures.js";

// Every match plays at grid scale 2: reference tile t is placed at fine tile f(t) = 2t + 1, so every
// tile distance doubles exactly (combat reach 2, attack radius 6, sight 12); subunit tolerances double too.
const f = (t: number) => 2 * t + 1;
/** Within the doubled target tile: half a reference tile (one fine tile, SUB) of the target's centre. */
const onTarget = (ant: Ant, tileX: number, tileY: number) =>
  Math.abs(ant.x - tileCentre(tileX)) < SUB && Math.abs(ant.y - tileCentre(tileY)) < SUB;

function joined(): SimState {
  return send(createMatch(5), [{ type: "join", agentId: "a" }]).state;
}

function tileOfFirst(state: SimState, agentId: string): { tileX: number; tileY: number } {
  const ant = squadOf(state, agentId)[0]!;
  return { tileX: Math.floor(ant.x / SUB), tileY: Math.floor(ant.y / SUB) };
}

function centroid(state: SimState, agentId: string): { x: number; y: number } {
  const ants = squadOf(state, agentId);
  return {
    x: ants.reduce((n, a) => n + a.x, 0) / ants.length,
    y: ants.reduce((n, a) => n + a.y, 0) / ants.length,
  };
}

describe("water-aware standing orders", () => {
  it.each(MAPS)("$name: go_to crosses via dry routes without changing its destination", map => {
    const config = { ...DEFAULT_CONFIG, terrain: { ...TERRAIN_RULES, mapId: map.id }, foodPatches: [] };
    let state = emptyMatch(0, config);
    const marcher = addAnt(state, 0, f(8), f(24), { squad: "a" });
    for (let i = 0; i < 5; i++) addAnt(state, 0, f(8), f(22));
    state.agents.push({ id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null,
      squad: [marcher.id], order: { kind: "go_to", tileX: f(44), tileY: f(24) }, lastCallTick: 0,
      lastCommandTick: null, idle: false, pendingEvents: [] });
    let ticks = 0;
    while (ticks++ < 1600) {
      state = send(state, ticks % 100 === 0 ? [{ type: "observe", agentId: "a" }] : []).state;
      for (const ant of state.ants) expect(isPassable(state, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB))).toBe(true);
      const ant = state.ants.find(a => a.id === marcher.id)!;
      if (Math.hypot(ant.x - tileCentre(f(44)), ant.y - tileCentre(f(24))) <= 600) break;
    }
    const arrived = state.ants.find(a => a.id === marcher.id)!;
    expect(Math.hypot(arrived.x - tileCentre(f(44)), arrived.y - tileCentre(f(24)))).toBeLessThanOrEqual(600);
    expect(state.agents[0]!.order).toEqual({ kind: "go_to", tileX: f(44), tileY: f(24) });
  });
});

describe("standing orders", () => {
  it("keeps go to, hold and attack running across ticks until replaced", () => {
    let s = send(joined(), [{ type: "order", agentId: "a", order: { kind: "go_to", tileX: f(20), tileY: f(10) } }]).state;
    for (let i = 0; i < 3; i += 1) {
      const before = centroid(s, "a");
      s = run(s, 20).state;
      const after = centroid(s, "a");
      expect(Math.hypot(tileCentre(f(20)) - after.x, tileCentre(f(10)) - after.y)).toBeLessThan(
        Math.hypot(tileCentre(f(20)) - before.x, tileCentre(f(10)) - before.y),
      );
      expect(s.agents[0]?.order).toEqual({ kind: "go_to", tileX: f(20), tileY: f(10) });
    }
    s = run(s, 200).state;
    for (const ant of squadOf(s, "a")) expect(onTarget(ant, f(20), f(10))).toBe(true);

    s = send(s, [{ type: "order", agentId: "a", order: { kind: "hold" } }]).state;
    const held = squadOf(s, "a").map((a) => [a.id, a.x, a.y]);
    s = run(s, 150).state;
    expect(squadOf(s, "a").map((a) => [a.id, a.x, a.y])).toEqual(held);

    // Attack: heads for its target tile (enemies on the way: the attack tests below).
    s = send(s, [{ type: "order", agentId: "a", order: { kind: "attack", tileX: f(20), tileY: f(30) } }]).state;
    const startY = centroid(s, "a").y;
    s = run(s, 30).state;
    expect(centroid(s, "a").y).toBeGreaterThan(startY);
    expect(s.agents[0]?.order).toEqual({ kind: "attack", tileX: f(20), tileY: f(30) });
  });

  it("keeps a forage order foraging: squad ants pick up food and deliver it", () => {
    let s = send(joined(), [{ type: "order", agentId: "a", order: { kind: "forage" } }]).state;
    const ids = new Set(squadOf(s, "a").map((a) => a.id));
    let carried = false;
    const delivered = s.stats.delivered[0];
    for (let i = 0; i < 300; i += 1) {
      s = send(s, []).state;
      if (s.ants.some((a) => ids.has(a.id) && a.carrying)) carried = true;
    }
    expect(carried).toBe(true);
    expect(s.stats.delivered[0]).toBeGreaterThan(delivered);
    expect(s.agents[0]?.order).toEqual({ kind: "forage" });
  });

  it("on follow trail moves the squad as the strongest mark in smell range directs, at full strength; else forages", () => {
    // A new squad starts on forage; follow trail is the player's explicit order.
    let s = joined();
    expect(s.agents[0]?.order).toEqual({ kind: "forage" });
    s = send(s, [{ type: "order", agentId: "a", order: { kind: "follow_trail" } }]).state;
    expect(s.agents[0]?.order).toEqual({ kind: "follow_trail" });
    const view = send(s, [{ type: "observe", agentId: "a" }]).results[0]!.view!;
    expect(view.orderStatus).toBe("no mark in smell range: foraging");

    // Two marks of the colony in smell range: the squad obeys the stronger (fresher) one.
    s = run(s, 99).state;
    const at = tileOfFirst(s, "a");
    s = send(s, [{ type: "mark", agentId: "a", ...at, words: ["GO", "N"] }]).state;
    s = run(s, 99).state;
    const at2 = tileOfFirst(s, "a");
    const out = send(s, [{ type: "mark", agentId: "a", ...at2, words: ["GO", "S"] }]);
    expect(out.results[0]?.ok).toBe(true);
    s = send(out.state, []).state;
    const speed = 2 * speedPerTick(DEFAULT_CONFIG); // a speed is a length per tick: doubled
    for (const ant of squadOf(s, "a")) {
      expect(ant.vx).toBe(0);
      expect(ant.vy).toBe(idiv(speed * UNIT, UNIT));
    }
    const fresh = s.marks.find((m) => m.words[1] === "S")!;
    const ant = squadOf(s, "a")[0]!;
    expect(markDirection(fresh, ant)).toEqual({ x: 0, y: UNIT });
  });

  it("rejects a command within 10 s of the previous one, saying when the next is allowed; an order and its mark are one command", () => {
    let s = joined();
    const at = tileOfFirst(s, "a");
    let out = send(s, [
      { type: "order", agentId: "a", order: { kind: "hold" }, mark: { ...at, words: ["HOLD"] }, intent: "hold the nest" },
    ]);
    expect(out.results[0]?.ok).toBe(true);
    expect(out.state.marks).toHaveLength(1);
    const commandTick = s.tick;
    s = run(out.state, 49).state;
    for (const input of [
      { type: "order", agentId: "a", order: { kind: "forage" } },
      { type: "mark", agentId: "a", ...at, words: ["FOOD"] },
    ] satisfies SimInput[]) {
      out = send(s, [input]);
      const result = out.results[0]!;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("rate_limited");
        expect(result.error.nextAllowedTick).toBe(commandTick + 100);
        expect(result.error.message).toContain(`tick ${commandTick + 100}`);
      }
    }
    s = run(s, 100 - 50).state;
    expect(s.tick).toBe(commandTick + 100);
    out = send(s, [{ type: "order", agentId: "a", order: { kind: "forage" } }]);
    expect(out.results[0]?.ok).toBe(true);
  });

  it("accepts an intent line of up to 80 characters, shows it in step events and never in a view", () => {
    let s = joined();
    let out = send(s, [{ type: "order", agentId: "a", order: { kind: "hold" }, intent: "x".repeat(81) }]);
    expect(out.results[0]?.ok).toBe(false);
    if (!out.results[0]!.ok) expect(out.results[0]!.error.code).toBe("intent_too_long");
    const intent = `flank-the-centre-${"y".repeat(63)}`;
    expect(intent).toHaveLength(80);
    out = send(out.state, [{ type: "order", agentId: "a", order: { kind: "hold" }, intent }]);
    expect(out.results[0]?.ok).toBe(true);
    expect(out.events).toContainEqual(expect.objectContaining({ type: "order", agentId: "a", intent }));
    expect(JSON.stringify(out.results[0]!.view)).not.toContain("flank-the-centre");
    s = send(out.state, [{ type: "observe", agentId: "a" }]).state;
    out = send(s, [{ type: "observe", agentId: "a" }]);
    expect(JSON.stringify(out.results[0]!.view)).not.toContain("flank-the-centre");
  });
});

type Tile = readonly [number, number];

function tileOf(ant: Ant): Tile {
  return [Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)];
}

/** Fine tiles apart, diagonals counting as 1: within 2 is combat reach at grid scale 2. */
function chebyshev(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/**
 * Agent "a" (colony 0) with a six-ant squad on tiles x 10-11, y 22-24, ordered
 * to attack the target; enemies of colony 1 placed on the given tiles and kept
 * still in agent "b"'s squad on hold. No food, and combat starts at tick 600.
 */
function attackScene(target: Tile, enemyTiles: readonly Tile[]): { s: SimState; enemyIds: number[] } {
  const state = emptyMatch(0);
  state.food.fill(0);
  for (const [x, y] of [[10, 22], [11, 22], [10, 23], [11, 23], [10, 24], [11, 24]] as const) addAnt(state, 0, f(x), f(y));
  for (let i = 0; i < 6; i += 1) addAnt(state, 0, f(2 + i), f(34));
  for (let i = 0; i < 6; i += 1) addAnt(state, 1, f(55), f(21 + i));
  const enemies = enemyTiles.map(([x, y]) => addAnt(state, 1, x, y));
  for (let i = enemies.length; i < 6; i += 1) addAnt(state, 1, f(60), f(40 + i));
  let s = send(state, [
    { type: "join", agentId: "a", colony: 0 },
    { type: "join", agentId: "b", colony: 1 },
  ]).state;
  s = send(s, [
    { type: "order", agentId: "a", order: { kind: "attack", tileX: target[0], tileY: target[1] } },
    { type: "order", agentId: "b", order: { kind: "hold" } },
  ]).state;
  // Hold the placed enemies where they stand: they become b's squad.
  const enemyIds = enemies.map((e) => e.id);
  const b = s.agents.find((agent) => agent.id === "b")!;
  for (const ant of s.ants) if (ant.squad === "b") ant.squad = null;
  b.squad = [...enemyIds];
  for (const ant of s.ants) {
    if (enemyIds.includes(ant.id)) {
      const [x, y] = enemyTiles[enemyIds.indexOf(ant.id)]!;
      ant.x = tileCentre(x);
      ant.y = tileCentre(y);
      ant.squad = "b";
    }
  }
  expect(squadOf(s, "a").map(tileOf).sort()).toEqual(
    [[10, 22], [10, 23], [10, 24], [11, 22], [11, 23], [11, 24]].map(([x, y]) => [f(x!), f(y!)]).sort(),
  );
  return { s, enemyIds };
}

describe("attack order: the squad keeps together", () => {
  it("marches past enemies it can see but never touches, and arrives at the target together", () => {
    const target: Tile = [f(10), f(4)];
    const enemyTiles: Tile[] = ([[14, 18], [14, 14], [14, 10], [7, 16], [7, 12], [7, 8]] as const).map(([x, y]) => [f(x), f(y)] as const);
    let { s } = attackScene(target, enemyTiles);
    let seen = false;
    for (let t = 0; t < 150; t += 1) {
      s = send(s, []).state;
      for (const ant of squadOf(s, "a")) {
        // Never turns aside: stays on its march column toward the target.
        expect(ant.x).toBeGreaterThanOrEqual(f(10) * SUB);
        expect(ant.x).toBeLessThan(f(12) * SUB);
        for (const e of enemyTiles) {
          expect(chebyshev(tileOf(ant), e)).toBeGreaterThan(2);
          const [x, y] = tileOf(ant);
          if ((x - e[0]) ** 2 + (y - e[1]) ** 2 <= (2 * DEFAULT_CONFIG.sightTiles) ** 2) seen = true;
        }
      }
    }
    expect(seen).toBe(true);
    const squad = squadOf(s, "a");
    expect(squad).toHaveLength(6);
    for (const ant of squad) expect(onTarget(ant, ...target)).toBe(true);
  });

  it("stands and fights with an enemy within combat reach (diagonals included)", () => {
    const { s } = attackScene([f(10), f(4)], [[f(12), f(21)]]);
    const engaged = squadOf(s, "a").find((a) => tileOf(a)[0] === f(11) && tileOf(a)[1] === f(22))!;
    const free = squadOf(s, "a").find((a) => tileOf(a)[0] === f(10) && tileOf(a)[1] === f(24))!;
    const next = send(s, []).state;
    const after = next.ants.find((a) => a.id === engaged.id)!;
    expect([after.x, after.y, after.vx, after.vy]).toEqual([engaged.x, engaged.y, 0, 0]);
    expect(next.ants.find((a) => a.id === free.id)!.y).toBeLessThan(free.y);
  });

  it("at the target, goes after the nearest enemy within the radius of the target, not one outside it", () => {
    expect(DEFAULT_CONFIG.attackRadiusTiles).toBe(3);
    // Target (12, 22): every squad ant starts within 3 tiles of it. The enemy at (12, 19)
    // is 3 tiles from the target; the one at (8, 26) is nearer some ants but 5.7 tiles from it.
    const inside: Tile = [f(12), f(19)];
    const outside: Tile = [f(8), f(26)];
    let { s } = attackScene([f(12), f(22)], [inside, outside]);
    s = run(s, 40).state;
    for (const ant of squadOf(s, "a")) {
      expect(chebyshev(tileOf(ant), inside)).toBeLessThanOrEqual(2);
      expect(chebyshev(tileOf(ant), outside)).toBeGreaterThan(2);
    }
  });

  it("at the target with no enemy within the radius, holds at the target", () => {
    const target: Tile = [f(12), f(22)];
    let { s } = attackScene(target, [[f(8), f(26)]]);
    s = run(s, 40).state;
    const held = squadOf(s, "a").map((a) => [a.id, a.x, a.y]);
    for (const ant of squadOf(s, "a")) expect(onTarget(ant, ...target)).toBe(true);
    s = run(s, 40).state;
    expect(squadOf(s, "a").map((a) => [a.id, a.x, a.y])).toEqual(held);
  });
});
