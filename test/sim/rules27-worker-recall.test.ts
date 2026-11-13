import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { tileCentre } from "../../src/sim/geometry.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { activeQueens, buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { Ant, ColonyId, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "./fixtures.js";
// House-bot planning for a colony with no active seat now plays only when re-simulating a match recorded before the
// no-bot-moves rule (localAnts.everyColony absent), so these house-path tests pin that recorded config.
import { recordedHousePlan } from "../house-plan.ts";

// In a rules-27 match no free worker of an agent-seated colony is pulled by
// queen-threat recall.
// Fixed geometry as in the captured recall scenarios; seeded layouts are not needed here.
const base = { ...recordedHousePlan(rulesConfig("redesign")), foodLayout: undefined };
const rules27: SimConfig = base;
// Every free noncarrying worker passes the captured candidate test (dispatch threshold, no held guard excluded),
// so a house-bot colony recalls every worker the threat reaches.
const allCandidates = (config: SimConfig): SimConfig => ({ ...config, squadSize: 0, hatchIntervalTicks: Number.MAX_SAFE_INTEGER,
  localAnts: { ...config.localAnts!, workerPatchDispatchSharePermille: 1000, workerHomeGuardCount: 1,
    workerHomeGuardSharePermille: undefined, workerHomeGuardHold: undefined } });

function seat(state: SimState, colony: ColonyId): void {
  state.agents.push({ id: `agent-${colony}`, colony, joinSeq: colony, modelLabel: null, parentAgentId: null, squad: [],
    order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
}

/** One colony's workers away from its queen and a living enemy soldier 12 tiles (the captured range) from that queen.
 * emptyMatch plays at grid scale 2, so reference tile t is placed at fine 2t + 0.5,
 * the reference tile's centre, and the captured 12-tile range is 24 fine tiles. */
const ref = (t: number) => 2 * t + 0.5;
function threatened(config: SimConfig, colony: ColonyId, seated: readonly ColonyId[]) {
  const s = emptyMatch(0, allCandidates(config));
  for (const c of seated) seat(s, c);
  const qx = colony === 0 ? 8 : 55, sign = colony === 0 ? 1 : -1;
  const workers = [addAnt(s, colony, ref(qx), ref(24)), addAnt(s, colony, ref(qx), ref(32)), addAnt(s, colony, ref(qx), ref(39)), addAnt(s, colony, ref(qx - sign * 4), ref(16))];
  // Exactly at the captured range from the queen's own fine tile, as main's balance.test.ts atThreatEdge places it.
  const queen = s.colonies[colony].queens![0]!;
  const enemy = addAnt(s, colony === 0 ? 1 : 0, Math.floor(queen.queenX / SUB) + sign * 24, Math.floor(queen.queenY / SUB), { caste: "soldier" });
  return { s, workers, enemy };
}

const recalled = (state: SimState, ants: readonly Ant[]): number[] => {
  const recall = localSoldierAssignments(state)!.workerRecall!;
  return ants.filter((ant) => recall.has(ant.id)).map((ant) => ant.id);
};

describe("rules 27: no queen-threat recall for agent-seated colonies", () => {
  it("recalls no free worker of a seated colony", () => {
    for (const colony of [0, 1] as const) {
      const now = threatened(rules27, colony, [colony]);
      const assigned = localSoldierAssignments(now.s)!;
      expect(assigned.workerRecall).toBeDefined(); // Allocation shape unchanged; only its contents.
      expect(assigned.workerRecall!.size).toBe(0);
    }
  });

  it("plans every seated worker exactly as it would with no threat at all", () => {
    for (const colony of [0, 1] as const) {
      const { s, workers, enemy } = threatened(rules27, colony, [colony]);
      const calm: SimState = { ...s, ants: s.ants.filter((ant) => ant.id !== enemy.id) };
      const grid = buildGrid(s), calmGrid = buildGrid(calm);
      for (const worker of workers) {
        expect(localDirection(s, grid, worker)).toEqual(localDirection(calm, calmGrid, worker));
      }
    }
  });

  it("keeps the captured recall for a house-bot colony in the same rules-27 match", () => {
    for (const colony of [0, 1] as const) {
      const other: ColonyId = colony === 0 ? 1 : 0;
      const now = threatened(rules27, colony, [other]);
      expect(recalled(now.s, now.workers)).toEqual(now.workers.map((ant) => ant.id));
    }
  });

  it("recalls no seated worker through a played rules-27 match at the new-match grid scale", () => {
    const config = allCandidates(newMatchConfig(recordedHousePlan(rulesConfig("redesign"))));
    let state = createMatch(7001, config);
    seat(state, 0);
    const queen = activeQueens(state.colonies[0])[0]!;
    const range = config.localAnts!.workerQueenThreatTiles!;
    const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
    const enemy = addAnt(state, 1, qx + Math.sign(config.mapWidth / 2 - qx) * (range - 1), qy, { caste: "soldier" });
    const workers = (s: SimState) => s.ants.filter((ant) => ant.colony === 0 && ant.caste !== "soldier");
    expect(workers(state).length).toBeGreaterThan(0);
    for (let tick = 0; tick < 40; tick++) {
      // Hold the threat in place so it stays inside the captured range for every planned tick.
      const threat = state.ants.find((ant) => ant.id === enemy.id)!;
      threat.x = tileCentre(qx + Math.sign(config.mapWidth / 2 - qx) * (range - 1)); threat.y = tileCentre(qy);
      expect(recalled(state, workers(state))).toEqual([]);
      state = step(state).state;
    }
  });
});
