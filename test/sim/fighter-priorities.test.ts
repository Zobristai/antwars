import { describe, expect, it } from "vitest";
import { rulesConfig, speedPerTick, SUB } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { houseDirection, localDirection, type LocalSoldierAssignments } from "../../src/sim/houseBot.js";
import { beginLocalGoals, currentLocalGoals } from "../../src/sim/localArrival.js";
import { buildGrid } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import { isPassable } from "../../src/sim/terrain.js";
import { step } from "../../src/sim/step.js";
import type { Agent, Ant, ColonyId } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";

// Fixed expectations derived from 59ed9a6d309b48d31b7c9d09e283d6b1a5fcbab5:
// houseBot.ts fighter/local priority branches and step.ts ownership dispatch.
// No expected result is calculated by a second call to the implementation.
// Tests pin choices/targets, not guard settling, water destinations or population counts.
type Caller = "house-worker" | "house-soldier" | "local";
type Remembered = Ant & { houseIntentHold?: { intent: {
  kind: string; homeId?: number; targetId?: number; x: number; y: number;
}; selectedTick: number } };

// Every match plays at grid scale 2; scale is that one grid scale.
function scenario(colony: ColonyId, caller: Caller, scale: 2) {
  const base = newMatchConfig(rulesConfig("redesign"));
  const state = { ...emptyMatch(0, { ...base, startAnts: 0, foodLayout: undefined,
    foodPatches: [{ tileX: 12 * scale, tileY: 9 * scale, radius: 2 * scale, perTile: 2 }], terrain: undefined, hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
    rallyStartPermille: 500, rallyEndPermille: 500 }),
    terrain: { mapId: "priority-river", mapName: "Priority river",
      water: [{ x: 30 * scale, y: 20 * scale, width: 4 * scale, height: 10 * scale }], rocks: [] } };
  state.food.fill(0);
  const x = (coarse: number) => (colony === 0 ? coarse : 64 - coarse) * SUB * scale;
  const y = (coarse: number) => coarse * SUB * scale;
  const ant = addAnt(state, colony, 0, 0, { id: 3 + colony, x: x(20.5), y: y(24.5),
    role: "fighter", caste: caller === "house-worker" ? "worker" : "soldier" });
  state.nextAntId = ant.id + 1;
  const seat: Agent = { id: "seat", colony, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] };
  if (caller === "local") state.agents.push(seat);
  const assignments: LocalSoldierAssignments = { front: new Set([ant.id]), patches: new Set() };
  function decide(allocation: LocalSoldierAssignments = assignments) {
    beginLocalGoals(state);
    expect(localRulesSide(state, colony)).toBe(caller === "local");
    const grid = buildGrid(state);
    const dir = caller === "local" ? localDirection(state, grid, ant, allocation).dir
      : houseDirection(state, grid, [], ant);
    return { dir, goal: currentLocalGoals(state).get(ant.id), intent: (ant as Remembered).houseIntentHold?.intent };
  }
  const enemy = (cx: number, cy = 24.5) => addAnt(state, colony === 0 ? 1 : 0, 0, 0,
    { x: x(cx), y: y(cy), caste: "soldier" });
  return { state, ant, seat, assignments, decide, enemy, x, y,
    home: state.colonies[colony], opponent: state.colonies[colony === 0 ? 1 : 0] };
}

for (const scale of [2] as const) for (const colony of [0, 1] as const) {
  for (const caller of ["house-worker", "house-soldier", "local"] as const) {
    describe(`${caller}, colony ${colony}, grid ${scale}: priorities before a wet rally`, () => {
      it("adjacent contact overrides even a retained competing pursuit", () => {
        const s = scenario(colony, caller, scale), target = s.enemy(23.5);
        expect(s.decide().intent?.kind).toBe("pursue");
        target.x = s.x(21.5); s.state.tick = 1;
        const result = s.decide();
        expect(result.dir).toEqual({ x: 0, y: 0 });
        expect(result.goal).toMatchObject({ kind: "combat", targetId: target.id, nativeReached: true });
        expect((s.ant as Remembered).houseIntentHold?.selectedTick).toBe(0);
      });
      it("pursues a visible enemy with the selected target identity", () => {
        const s = scenario(colony, caller, scale), target = s.enemy(23.5);
        const result = s.decide();
        expect(result.intent).toEqual({ kind: "pursue", targetId: target.id, x: s.x(23.5), y: s.y(24.5) });
        expect(result.goal).toMatchObject({ kind: "combat", targetId: target.id, x: s.x(23.5), y: s.y(24.5) });
        expect(result.dir).toEqual({ x: colony === 0 ? 1000 : -1000, y: 0 });
      });
      it("retreats to its own queen when outnumbered", () => {
        const s = scenario(colony, caller, scale);
        s.enemy(23.5); s.enemy(23.5, 25.5); s.enemy(23.5, 23.5);
        const result = s.decide();
        expect(result.intent).toEqual({ kind: "retreat", homeId: 0, x: s.home.queenX, y: s.home.queenY });
        expect(result.goal).toMatchObject({ kind: "point", x: s.home.queenX, y: s.home.queenY });
        expect(result.dir).toEqual({ x: colony === 0 ? -1000 : 1000, y: 0 });
      });
      // The house caller's priorities before a rally; a seated colony's local soldier holds instead (rules 27).
      if (caller !== "local") {
        it("pursues a visible enemy queen before the rally", () => {
          const s = scenario(colony, caller, scale);
          s.ant.x = s.x(52.5);
          const result = s.decide();
          expect(result.intent).toEqual({ kind: "queen", targetId: 0, x: s.opponent.queenX, y: s.opponent.queenY });
          expect(result.goal).toMatchObject({ kind: "point", x: s.opponent.queenX, y: s.opponent.queenY });
          expect(result.dir).toEqual({ x: colony === 0 ? 1000 : -1000, y: 0 });
        });
        it("returns zero with no living enemy queen rather than choosing a rally", () => {
          const s = scenario(colony, caller, scale);
          s.state.colonies[colony === 0 ? 1 : 0].queens![0]!.lostTick = 0;
          expect(s.decide()).toMatchObject({ dir: { x: 0, y: 0 }, intent: undefined, goal: undefined });
        });
        it("retains a competing pursuit for exactly two seconds, then allows its free fallback", () => {
          const s = scenario(colony, caller, scale), target = s.enemy(23.5);
          s.decide(); target.x = s.x(10.5);
          s.state.tick = 2 * s.state.config.ticksPerSecond - 1;
          expect(s.decide().intent).toEqual({ kind: "pursue", targetId: target.id, x: s.x(10.5), y: s.y(24.5) });
          expect((s.ant as Remembered).houseIntentHold?.selectedTick).toBe(0);
          s.state.tick++;
          expect(s.decide().intent?.kind).toBe("rally");
        });
        it("releases a dead competing target without waiting for the hold", () => {
          const s = scenario(colony, caller, scale), target = s.enemy(23.5);
          s.decide(); s.state.ants = s.state.ants.filter(a => a.id !== target.id); s.state.tick = 1;
          expect(s.decide().intent?.kind).toBe("rally");
        });
      }
    });
  }

  describe(`caller-specific controls, colony ${colony}, grid ${scale}`, () => {
    it.each(["house-worker", "house-soldier"] as const)("%s returns zero without a home queen", caller => {
      const s = scenario(colony, caller, scale);
      s.state.colonies[colony].queens![0]!.lostTick = 0;
      expect(s.decide()).toMatchObject({ dir: { x: 0, y: 0 }, intent: undefined, goal: undefined });
    });
    it("a local soldier without a home falls through to the zero forage control, not rally", () => {
      const s = scenario(colony, "local", scale);
      s.state.colonies[colony].queens![0]!.lostTick = 0;
      beginLocalGoals(s.state);
      expect(localDirection(s.state, buildGrid(s.state), s.ant, s.assignments)).toEqual({ dir: { x: 0, y: 0 }, foraging: true });
      expect(currentLocalGoals(s.state).get(s.ant.id)).toBeUndefined();
      expect((s.ant as Remembered).houseIntentHold).toBeUndefined();
    });
    it("local worker home guard wins over nearby queen defence", () => {
      const s = scenario(colony, "local", scale);
      s.ant.caste = "worker"; s.ant.x = s.x(10.5); s.enemy(7.5);
      const held = s.decide({ front: new Set(), patches: new Set(), workerGuards: new Set([s.ant.id]) });
      expect(held.goal).toMatchObject({ kind: "guard", targetId: 0, x: s.home.queenX, y: s.home.queenY });
      expect(held.intent).toBeUndefined();
      // Removing the explicit worker-guard choice exposes the next priority.
      expect(s.decide().goal).toMatchObject({ kind: "combat", x: s.x(7.5), y: s.y(24.5) });
    });
    it("local nearby-queen defence precedes the front/patch branch", () => {
      const s = scenario(colony, "local", scale);
      s.ant.x = s.x(10.5); const target = s.enemy(7.5);
      const result = s.decide({ front: new Set([s.ant.id]), patches: new Set([s.ant.id]) });
      expect(result.goal).toMatchObject({ kind: "combat", targetId: target.id, x: s.x(7.5), y: s.y(24.5) });
      expect(result.intent).toBeUndefined();
    });
  });

  for (const caller of ["house-worker", "house-soldier", "local"] as const) for (const ownership of ["squad", "claim"] as const) {
    it(`${caller}, colony ${colony}, grid ${scale}: ${ownership} wins at ordinary step dispatch`, () => {
      const s = scenario(colony, caller, scale);
      // An inactive seat deliberately retains seeded ownership in the house fixture:
      // localRulesSide is false, but step must still honour the ant's owner first.
      if (caller !== "local") { s.seat.idle = true; s.state.agents.push(s.seat); }
      const markX = Math.floor(s.x(16.5) / SUB), markY = Math.floor(s.y(24.5) / SUB);
      // A mark targets the fine tile centre, not the scaled coarse centre.
      // Align with the mark centre; point resting then steers to its own jittered site.
      s.ant.y = (markY + 0.5) * SUB;
      s.state.marks.push({ id: 7, agentId: s.seat.id, colony, tileX: markX, tileY: markY,
        words: [], verb: "GATHER", count: 1, laidTick: 0, steering: 0 });
      if (ownership === "claim") s.ant.claim = 7;
      else { s.ant.squad = s.seat.id; s.seat.squad = [s.ant.id]; s.state.marks[0]!.count = 0; }
      // Enough population for ordinary squad supply; no nearby soft contacts.
      for (let i = 0; i < 8; i++) addAnt(s.state, colony, (5 + i) * scale, 5 * scale, { caste: "worker" });
      expect(localRulesSide(s.state, colony)).toBe(caller === "local");
      const next = step(s.state).state.ants.find(a => a.id === s.ant.id)!;
      expect(next.role).toBe("fighter");
      expect((next as Remembered).houseIntentHold).toBeUndefined();
      if (ownership === "squad") {
        expect(next.squad).toBe(s.seat.id);
        expect([next.x, next.y, next.vx, next.vy]).toEqual([s.ant.x, s.ant.y, 0, 0]);
      } else {
        expect(next.claim).toBe(7);
        expect(Math.sign(next.x - s.ant.x)).toBe(colony === 0 ? -1 : 1);
        const rest = next.pointRest!;
        expect(rest).toBeDefined();
        expect(Math.abs(rest.x - (markX + 0.5) * SUB)).toBeLessThanOrEqual(s.state.config.pointArrival!.jitter);
        expect(Math.abs(rest.y - (markY + 0.5) * SUB)).toBeLessThanOrEqual(s.state.config.pointArrival!.jitter);
        expect(isPassable(s.state, Math.floor(rest.x / SUB), Math.floor(rest.y / SUB))).toBe(true);
        // This fixture is nearly horizontal. The nearest speed-safe integer step
        // reserves one x subunit when the rounded y step is nonzero.
        const speed = speedPerTick(s.state.config), dx = rest.x - s.ant.x, dy = rest.y - s.ant.y;
        const vy = Math.round(speed * dy / Math.hypot(dx, dy)) || 0;
        const vx = Math.sign(dx) * (speed - (vy === 0 ? 0 : 1));
        expect([next.x, next.y, next.vx, next.vy]).toEqual([s.ant.x + vx, s.ant.y + vy, vx, vy]);
        // Bound: never above native speed, and strictly nearer its assigned rest.
        expect(vx ** 2 + vy ** 2).toBeLessThanOrEqual(speed ** 2);
        expect((rest.x - next.x) ** 2 + (rest.y - next.y) ** 2).toBeLessThan(dx ** 2 + dy ** 2);
      }
    });
  }
}
