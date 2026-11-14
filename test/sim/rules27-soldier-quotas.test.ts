import { describe, expect, it } from "vitest";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { localDirection, localSoldierAssignments, type LocalSoldierAssignments } from "../../src/sim/houseBot.js";
import { beginLocalGoals, readLocalGoal } from "../../src/sim/localArrival.js";
import { buildGrid } from "../../src/sim/map.js";
import { localRulesSide } from "../../src/sim/marks.js";
import type { Ant, ColonyId, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch, run } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

/**
 * In rules 27, an agent-seated colony's free soldiers get no front share,
 * patch detail or template-patch fallback; house-bot colonies keep their allocation.
 */
type IntentAnt = Ant & { houseIntentHold?: { intent: { kind: string } } };
const SOLDIERS = 12;

function rulesOf(scale: 2, local: Partial<NonNullable<SimConfig["localAnts"]>> = {}): SimConfig {
  const base = withGridScale(recordedHousePlan(rulesConfig("redesign")));
  return { ...base,
    startAnts: 0, terrain: undefined, foodLayout: undefined,
    foodPatches: [{ tileX: 12 * scale, tileY: 9 * scale, radius: 2 * scale, perTile: 2 }],
    hatchIntervalTicks: Number.MAX_SAFE_INTEGER, localAnts: { ...base.localAnts!, ...local } };
}

function seat(state: SimState, colony: ColonyId): void {
  // Synthetic seat only: no join command, network connection or live match.
  state.agents.push({ id: `seat-${colony}`, colony, joinSeq: 0, modelLabel: null, parentAgentId: null,
    squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] });
}

const queenTile = (state: SimState, colony: ColonyId) => ({
  x: Math.floor(state.colonies[colony].queenX / SUB), y: Math.floor(state.colonies[colony].queenY / SUB) });

/** Both colonies get free soldiers within two reference tiles of their queen; only `seated` has an agent. */
function scene(scale: 2, seated: ColonyId, local: Partial<NonNullable<SimConfig["localAnts"]>> = {}): SimState {
  const state = emptyMatch(0, rulesOf(scale, local));
  for (const colony of [0, 1] as const) {
    const q = queenTile(state, colony);
    for (let i = 0; i < SOLDIERS; i++) {
      addAnt(state, colony, q.x + ((i % 5) - 2) * scale, q.y + (Math.trunc(i / 5) - 1) * scale, { caste: "soldier", role: "fighter" });
    }
  }
  seat(state, seated);
  expect(localRulesSide(state, seated)).toBe(true);
  expect(localRulesSide(state, seated === 0 ? 1 : 0)).toBe(false);
  return state;
}

const idsOf = (state: SimState, colony: ColonyId): number[] =>
  state.ants.filter((ant) => ant.colony === colony && ant.caste === "soldier").map((ant) => ant.id);
const pick = (set: ReadonlySet<number>, ids: readonly number[]): number[] => ids.filter((id) => set.has(id));

for (const scale of [2] as const) for (const seated of [0, 1] as const) {
  const house: ColonyId = seated === 0 ? 1 : 0;
  describe(`rules-27 soldier quotas, seated colony ${seated}, scale ${scale}`, () => {
    it("allocates no front share or patch detail to the seated colony; the house-bot colony keeps the captured shares", () => {
      const after = scene(scale, seated);
      const r27 = localSoldierAssignments(after);
      expect(r27).not.toBeNull();
      const seatedIds = idsOf(after, seated), houseIds = idsOf(after, house);
      expect(pick(r27!.front, seatedIds)).toEqual([]);
      expect(pick(r27!.patches, seatedIds)).toEqual([]);
      // The house-bot colony keeps the captured shares: floor(free x front share), then floor(front x patch share).
      const rules = after.config.localAnts!;
      const front = Math.floor(SOLDIERS * rules.soldierFrontSharePermille! / 1000);
      expect(pick(r27!.front, houseIds)).toHaveLength(front);
      expect(pick(r27!.patches, houseIds)).toHaveLength(Math.floor(front * rules.soldierPatchSharePermille! / 1000));
      expect(pick(r27!.patches, houseIds).every((id) => r27!.front.has(id))).toBe(true);
    });

    it("gives a seated soldier the no-quota decision even when an allocation or the stable-share fallback would select it", () => {
      const quotaAll = { soldierFrontSharePermille: 1000, soldierPatchSharePermille: 1000 };
      const decide = (allocation: (s: SimState, ant: Ant) => LocalSoldierAssignments | null) => {
        const state = scene(scale, seated, quotaAll);
        const q = queenTile(state, seated);
        // Five reference tiles toward the map centre: outside queen defence, no enemy in sight.
        const ant = addAnt(state, seated, q.x + (seated === 0 ? 5 : -5) * scale, q.y, { caste: "soldier", role: "fighter" }) as IntentAnt;
        beginLocalGoals(state);
        const decision = localDirection(state, buildGrid(state), ant, allocation(state, ant));
        return { ...decision, goal: readLocalGoal(state, ant), intent: ant.houseIntentHold?.intent };
      };
      const none = (): LocalSoldierAssignments => ({ front: new Set(), patches: new Set() });
      const forced = (_s: SimState, ant: Ant): LocalSoldierAssignments => ({ front: new Set([ant.id]), patches: new Set([ant.id]) });
      const fallback = (): null => null;
      const free27 = decide(none);
      expect(decide(forced)).toEqual(free27);
      expect(decide(fallback)).toEqual(free27);
      expect(decide((s) => localSoldierAssignments(s))).toEqual(free27);
    });

    it("keeps seated soldiers off the patch flank and rally line over play", () => {
      const quotaAll = { soldierFrontSharePermille: 1000, soldierPatchSharePermille: 1000 };
      const ticks = 60;
      const after = run(scene(scale, seated, quotaAll), ticks).state;
      const reach = (state: SimState) => Math.max(...state.ants.filter((ant) => ant.colony === seated).map((ant) => {
        const q = queenTile(state, seated);
        return Math.hypot(Math.floor(ant.x / SUB) - q.x, Math.floor(ant.y / SUB) - q.y) / scale;
      }));
      // Every seated soldier stays by home.
      expect(reach(after)).toBeLessThanOrEqual(6);
      expect(after.ants.filter((ant) => ant.colony === seated).map((ant) => (ant as IntentAnt).houseIntentHold?.intent.kind)
        .filter((kind) => kind === "explore" || kind === "rally")).toEqual([]);
    });
  });
}
