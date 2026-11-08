import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { localDirection, localSoldierAssignments, type LocalSoldierAssignments } from "../../src/sim/houseBot.js";
import { beginLocalGoals, currentLocalGoals } from "../../src/sim/localArrival.js";
import { buildGrid } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, ColonyId } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Rules-27 free seated soldiers fight on what they sense, as captured in the local basics and control boundaries: biting,
// near-queen defence within 3 reference tiles (6 fine tiles at grid scale 2), and local push/retreat
// at own × 1000 ≥ enemy × 600. Distances and counts below are literal, not read back from the config.
// An enemy
// queen in sight with no enemy ants is not pursued; she is bitten on contact only.
type Remembered = Ant & { houseIntentHold?: { intent: { kind: string; homeId?: number; targetId?: number; x: number; y: number } } };

function scenario(scale: 2, colony: ColonyId) {
  const redesign = newMatchConfig(rulesConfig("redesign"));
  const config: SimConfig = { ...redesign, startAnts: 0, foodLayout: undefined,
    foodPatches: [{ tileX: 12 * scale, tileY: 9 * scale, radius: 2 * scale, perTile: 2 }], terrain: undefined,
    hatchIntervalTicks: Number.MAX_SAFE_INTEGER, squadSize: 0 }; // no squad drafting: every soldier here stays free
  const state = emptyMatch(0, config);
  state.food.fill(0);
  const seat: Agent = { id: "seat", colony, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] };
  state.agents.push(seat);
  const enemyColony: ColonyId = colony === 0 ? 1 : 0;
  const home = state.colonies[colony].queens![0]!;
  const opponent = state.colonies[enemyColony].queens![0]!;
  const qx = Math.floor(home.queenX / SUB), qy = Math.floor(home.queenY / SUB);
  const side = colony === 0 ? 1 : -1;
  // Fine-grid tile offsets from the own queen, measured toward the map centre.
  const own = (dx: number, dy: number, patch: Partial<Ant>) => addAnt(state, colony, qx + side * dx, qy + dy, patch);
  const soldier = (dx: number, dy = 0) => own(dx, dy, { caste: "soldier", role: "fighter" });
  const friend = (dx: number, dy: number) => own(dx, dy, { caste: "worker", role: "forager" });
  const enemy = (dx: number, dy: number, caste: Ant["caste"] = "soldier") =>
    addAnt(state, enemyColony, qx + side * dx, qy + dy, { caste, role: caste === "soldier" ? "fighter" : "forager" });
  function decide(ant: Ant, allocation?: LocalSoldierAssignments | null) {
    beginLocalGoals(state);
    expect(localRulesSide(state, colony)).toBe(true);
    const result = localDirection(state, buildGrid(state), ant, allocation === undefined ? localSoldierAssignments(state) : allocation);
    return { ...result, goal: currentLocalGoals(state).get(ant.id), intent: (ant as Remembered).houseIntentHold?.intent };
  }
  /** Keep the seat active at a later tick (command-idle expiry runs in step). */
  function at(tick: number): void {
    state.tick = tick;
    seat.lastCallTick = tick;
    seat.lastCommandTick = tick;
  }
  return { state, home, opponent, qx, qy, side, soldier, friend, enemy, decide, at };
}

/** Three friends (the soldier and two workers) against five enemies at 4 reference tiles: exactly 0.6. */
function skirmish(s: ReturnType<typeof scenario>, scale: 2, extraEnemy: boolean) {
  const x = 20 * scale;
  const ant = s.soldier(x);
  s.friend(x, 1); s.friend(x, -1);
  const nearest = s.enemy(x + 4 * scale, 0);
  for (const dy of [1, -1, 2, -2]) s.enemy(x + 4 * scale, dy);
  if (extraEnemy) s.enemy(x + 4 * scale, 3);
  return { ant, nearest };
}

/** Three intruders two reference tiles from the own queen, on her far side from the map centre. */
function intruders(s: ReturnType<typeof scenario>, scale: 2) {
  const nearest = s.enemy(1, 2 * scale);
  s.enemy(0, 2 * scale); s.enemy(-1, 2 * scale);
  return nearest;
}

for (const scale of [2] as const) for (const colony of [0, 1] as const) {
  describe(`rules 27, grid ${scale}, colony ${colony}: an unclaimed free seated soldier fights locally`, () => {
    it("bites an enemy in reach, even when outnumbered in its sight", () => {
      const s = scenario(scale, colony);
      const ant = s.soldier(20 * scale);
      const adjacent = s.enemy(20 * scale + 1, 0);
      s.enemy(20 * scale + 3, 1); s.enemy(20 * scale + 3, -1);
      const result = s.decide(ant);
      expect(result.dir).toEqual({ x: 0, y: 0 });
      expect(result.goal).toMatchObject({ kind: "combat", targetId: adjacent.id, nativeReached: true });
      expect(result.intent).toBeUndefined();
    });

    it("its bite lands on the enemy in reach once combat grace ends", () => {
      const s = scenario(scale, colony);
      s.at(s.state.config.combatGraceTicks);
      const ant = s.soldier(20 * scale);
      const target = s.enemy(20 * scale + 1, 0, "worker");
      const before = target.hp;
      const next = step(s.state).state;
      const biter = next.ants.find((a) => a.id === ant.id)!;
      expect(biter.squad).toBeNull();
      expect(biter.claim).toBeUndefined();
      const after = next.ants.find((a) => a.id === target.id);
      expect(after === undefined || after.hp < before).toBe(true);
    });

    it(`chases an intruder near its queen from exactly 3 tiles (${3 * scale} fine tiles) away from her`, () => {
      const s = scenario(scale, colony);
      expect(s.state.config.localAnts!.defendTiles).toBe(3 * scale);
      const ant = s.soldier(3 * scale);
      const nearest = intruders(s, scale);
      const result = s.decide(ant);
      // Outnumbered three to one, yet it goes for the intruder rather than falling back.
      expect(result.goal).toMatchObject({ kind: "combat", targetId: nearest.id, x: nearest.x, y: nearest.y, nativeReached: false });
      expect(result.intent).toBeUndefined();
      expect(result.dir.y).toBeGreaterThan(0);
    });

    it(`one fine tile beyond 3 tiles (${3 * scale + 1} fine tiles) it does not defend; outnumbered, it falls back toward its queen`, () => {
      const s = scenario(scale, colony);
      const ant = s.soldier(3 * scale + 1);
      intruders(s, scale);
      const result = s.decide(ant);
      expect(result.intent).toEqual({ kind: "retreat", homeId: s.home.id, x: s.home.queenX, y: s.home.queenY });
      expect(result.goal).toMatchObject({ kind: "point", x: s.home.queenX, y: s.home.queenY });
      expect(Math.sign(result.dir.x)).toBe(-s.side);
    });

    it("pushes on the nearest enemy in its own sight when local friends are 0.6 of the enemies (3 to 5)", () => {
      const s = scenario(scale, colony);
      const { ant, nearest } = skirmish(s, scale, false);
      const result = s.decide(ant);
      expect(result.intent).toEqual({ kind: "pursue", targetId: nearest.id, x: nearest.x, y: nearest.y });
      expect(result.goal).toMatchObject({ kind: "combat", targetId: nearest.id });
      expect(Math.sign(result.dir.x)).toBe(s.side);
    });

    it("moves toward that enemy when the tick is stepped", () => {
      const s = scenario(scale, colony);
      const { ant } = skirmish(s, scale, false);
      const after = step(s.state).state.ants.find((a) => a.id === ant.id)!;
      expect(after.squad).toBeNull();
      expect(after.claim).toBeUndefined();
      expect(Math.sign(after.x - ant.x)).toBe(s.side);
    });

    it("falls back toward its queen when local friends are below 0.6 of the enemies (3 to 6)", () => {
      const s = scenario(scale, colony);
      const { ant } = skirmish(s, scale, true);
      const result = s.decide(ant);
      expect(result.intent).toEqual({ kind: "retreat", homeId: s.home.id, x: s.home.queenX, y: s.home.queenY });
      expect(result.goal).toMatchObject({ kind: "point", x: s.home.queenX, y: s.home.queenY });
      expect(Math.sign(result.dir.x)).toBe(-s.side);
    });

    it("does not pursue an enemy queen in its sight when no enemy ant is there", () => {
      const s = scenario(scale, colony);
      const eqx = Math.floor(s.opponent.queenX / SUB);
      const ant = s.soldier(s.side * (eqx - s.qx) - 3 * scale);
      const result = s.decide(ant);
      expect(result.intent?.kind).not.toBe("queen");
      expect([result.goal?.x, result.goal?.y]).not.toEqual([s.opponent.queenX, s.opponent.queenY]);
      expect(Math.sign(result.dir.x)).not.toBe(s.side);
    });

    it("bites an enemy queen it is in contact with", () => {
      const s = scenario(scale, colony);
      s.at(Math.max(s.state.config.combatGraceTicks, s.state.config.queenHp!.shieldTicks));
      const eqx = Math.floor(s.opponent.queenX / SUB);
      const ant = s.soldier(s.side * (eqx - s.qx) - 1);
      const result = s.decide(ant);
      expect(result.dir).toEqual({ x: 0, y: 0 });
      expect(result.goal).toMatchObject({ kind: "combat", targetId: s.opponent.id, nativeReached: true });
      const before = s.opponent.hp!;
      const after = step(s.state).state.colonies[colony === 0 ? 1 : 0].queens!.find((q) => q.id === s.opponent.id)!;
      expect(after.hp!).toBeLessThan(before);
    });
  });
}
