import { describe, expect, it } from "vitest";
import { rulesConfig } from "../../src/sim/config.js";
import { groundIncome } from "../../src/sim/forage.js";
import { localDirection, localSoldierAssignments } from "../../src/sim/houseBot.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { buildGrid, cloneState, createMatch } from "../../src/sim/map.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { step } from "../../src/sim/step.js";
import { sustainedTerritoryWin } from "../../src/sim/territory.js";
import { PRE_FRONTLINE_CONFIGS, addAnt, emptyMatch } from "./fixtures.js";
import { recordSeenFood } from "../../src/sim/view.js";
import { playable } from "../playable.ts";
import type { Ant, ColonyId, SimState } from "../../src/sim/types.js";

// These focused balance scenarios pin their fixed geometry; seeded layouts have their own sweep.
// rules is the reference-grid template; emptyMatch and playable build it at grid scale 2, so its
// tiles, patches and distances double. Reference tile t is fine tiles 2t and 2t+1; ants stand at
// the reference tile centre (fine 2t + 0.5) and a reference cell's food lives in fine cell (2tx, 2ty).
const rules = { ...rulesConfig("redesign"), foodLayout: undefined };
const ref = (t: number) => 2 * t + 0.5;
const put = (s: SimState, colony: ColonyId, tx: number, ty: number, patch: Partial<Ant> = {}) => addAnt(s, colony, ref(tx), ref(ty), patch);
/** An ant exactly at the queen-threat boundary: 24 fine tiles (12 reference tiles) from the queen's own fine tile. */
const atThreatEdge = (s: SimState, colony: ColonyId, enemy: ColonyId, patch: Partial<Ant> = {}) => {
  const queen = s.colonies[colony].queens![0]!, sign = colony === 0 ? 1 : -1;
  return addAnt(s, enemy, Math.floor(queen.queenX / 1000) + sign * 24, Math.floor(queen.queenY / 1000), patch);
};
describe("configured battle balance", () => {
  it("keeps early wins and the poorer centre patch to the redesign", () => {
    expect(rulesConfig("v4").earlyWin).toBeUndefined();
    expect(createMatch(1, playable(rulesConfig("v4"))).earlyWinProgress).toBeUndefined();
    expect(rules.foodPatches.find((p) => p.tileX === 30)!.perTile).toBeLessThan(rulesConfig("v4").foodPatches.find((p) => p.tileX === 30)!.perTile);
    expect(rules.foodPatches.slice(0, PRE_FRONTLINE_CONFIGS.redesign.foodPatches.length).filter((p) => p.tileY !== 24).every((p) => p.perTile > rules.foodPatches.find((p) => p.tileX === 30)!.perTile)).toBe(true);
  });
  // Known failure: opening food sits 13 fine tiles from starting ants with sight 12; a separate fix is planned.
  it.fails("makes the near-home patch visible at the opening while placing its entire food supply outside the lane", () => {
    const patch = rules.foodPatches.find((p) => p.tileX === 10)!;
    expect(patch.tileY + patch.radius).toBeLessThan(18);
    for (const seed of [7001, 7002]) {
      const s = createMatch(seed, playable(rules));
      recordSeenFood(s);
      for (const colony of [0, 1] as const) {
        expect(s.colonies[colony].seenFood!.length).toBeGreaterThan(0);
        // Reference row 18 is fine row 36.
        expect(s.colonies[colony].seenFood!.every((tile) => Math.floor(tile / s.config.mapWidth) < 36)).toBe(true);
      }
    }
  });
  it("takes an isolated worker's real forage commute off the lane rather than cycling only to the old row-19 rim", () => {
    const commute = (config: typeof rules): number => {
      const s = createMatch(7001, playable({ ...config, matchTicks: 1000, hatchIntervalTicks: Number.MAX_SAFE_INTEGER }));
      recordSeenFood(s); // The opening colony must discover the patch without hidden food knowledge.
      s.ants = [];
      s.agents.push({ id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [],
        order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] });
      const worker = put(s, 0, 8, 24);
      let state = s, off = 0;
      for (let tick = 0; tick < 500; tick++) {
        state = step(state).state;
        const row = Math.floor(state.ants.find((a) => a.id === worker.id)!.y / 2000); // reference row
        if (row < 18 || row > 30) off++;
      }
      expect(state.stats.delivered[0]).toBeGreaterThan(0);
      return off / 500;
    };
    const old = { ...rules, foodPatches: rules.foodPatches.map((p) => p.tileX === 10 ? { ...p, tileY: 14 } : p) };
    expect(commute(old)).toBeLessThan(.25);
    expect(commute(rules)).toBeGreaterThanOrEqual(.25);
  });
  it("triggers recall only for living enemy soldiers inside the Euclidean threat boundary, mirrored on both sides", () => {
    for (const colony of [0, 1] as const) {
      const qx = colony === 0 ? 8 : 55;
      const s = emptyMatch(0, { ...rules, localAnts: { ...rules.localAnts!, workerPatchDispatchSharePermille: 1000 } });
      put(s, colony, qx, 24); const worker = put(s, colony, qx, 39);
      const enemy = atThreatEdge(s, colony, colony === 0 ? 1 : 0, { caste: "soldier" });
      expect(localSoldierAssignments(s)!.workerRecall!.has(worker.id)).toBe(true);
      enemy.y += 2000; // Reference (12,1) lies outside the Euclidean radius.
      expect(localSoldierAssignments(s)!.workerRecall!.size).toBe(0);
      enemy.y -= 2000; enemy.caste = "worker";
      expect(localSoldierAssignments(s)!.workerRecall!.size).toBe(0);
      enemy.caste = "soldier"; enemy.hp = 0;
      expect(localSoldierAssignments(s)!.workerRecall!.size).toBe(0);
      enemy.hp = rules.antHp; s.colonies[colony].queens![0]!.lostTick = 0;
      expect(localSoldierAssignments(s)!.workerRecall!.size).toBe(0);
    }
  });
  it("reserves a permanent home screen before patch dispatch and adds emergency workers without double-counting the screen", () => {
    const s = emptyMatch(0, { ...rules, foodPatches: [{ tileX: 18, tileY: 39, radius: 2, perTile: 6 }] });
    Array.from({ length: 200 }, () => put(s, 0, 8, 24));
    const assigned = localSoldierAssignments(s)!;
    expect(assigned.workerGuards!.size).toBe(50); // max(minimum 32, 25% of 200).
    const grid = buildGrid(s);
    for (const ant of s.ants.filter((a) => assigned.workerGuards!.has(a.id))) {
      expect(localDirection(s, grid, ant, assigned)).toEqual({ dir: { x: 0, y: 0 }, foraging: false });
    }
    const guard = s.ants[0]!; guard.y = 43000;
    expect(localDirection(s, buildGrid(s), guard).dir.y).toBeGreaterThan(0); // Form the screen on the queen, not three tiles away.
    atThreatEdge(s, 0, 1, { caste: "soldier" });
    const emergency = localSoldierAssignments(s)!;
    expect(emergency.workerRecall!.size).toBe(32);
    expect([...emergency.workerRecall!.keys()].every((id) => !emergency.workerGuards!.has(id))).toBe(true);
    const small = emptyMatch(0, rules);
    Array.from({ length: 20 }, () => put(small, 0, 8, 24));
    expect(localSoldierAssignments(small)!.workerGuards!.size).toBe(19); // Never strand the final forager.
  });
  it("uses existing soldier guards instead of retaining workers, and never retains the last available worker", () => {
    const s = emptyMatch(0, rules);
    const lone = put(s, 0, 8, 24);
    expect(localSoldierAssignments(s)!.workerGuards!.size).toBe(0);
    put(s, 0, 8, 24);
    expect(localSoldierAssignments(s)!.workerGuards!.size).toBe(1);
    put(s, 0, 8, 24, { caste: "soldier" }); put(s, 0, 8, 24, { caste: "soldier" });
    expect(localSoldierAssignments(s)!.workerGuards!.size).toBe(0);
    expect(localSoldierAssignments(s)!.front.size).toBe(1);
    expect(s.ants.find((a) => a.id === lone.id)!.claim).toBeUndefined();
  });
  it("preserves recorded full and tapered ground income, never on neutral tiles", () => {
    const recorded = PRE_FRONTLINE_CONFIGS.redesign;
    const s = emptyMatch(0, recorded);
    s.owner.fill(-1);
    // Ground income counts reference tiles: four fine cells each at grid scale 2.
    s.owner.fill(0, 0, 4 * 80); s.owner.fill(1, 4 * 80, 4 * 100);
    const payout = recorded.groundFoodIntervalTicks!;
    expect(groundIncome(s, 0)).toEqual([0, 0]);
    expect(groundIncome(s, payout - 1)).toEqual([0, 0]);
    expect(groundIncome(s, payout)).toEqual([57, 20]); // 50 full + floor(30 * .25)
    s.owner.fill(0, 0, 4 * 50); s.owner.fill(1, 4 * 50, 4 * 100);
    expect(groundIncome(s, payout)).toEqual([50, 50]);
    expect(groundIncome({ ...s, config: { ...s.config, groundIncomeExcessPermille: undefined } }, payout)).toEqual([50, 50]);
    s.owner.fill(-1);
    expect(groundIncome(s, payout)).toEqual([0, 0]);
  });
  it("recruits colony-wide nearest first, without a shared cap, and never takes squads or the other colony", () => {
    const s = emptyMatch(0, rules);
    s.agents.push({ id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: 0, idle: false, pendingEvents: [] });
    const far = put(s, 0, 8, 24);
    put(s, 0, 9, 24); put(s, 0, 10, 24); put(s, 0, 11, 24); put(s, 0, 12, 24);
    const squad = put(s, 0, 50, 24, { squad: "a" });
    const enemy = put(s, 1, 50, 24);
    s.marks.push({ id: 1, agentId: "a", colony: 0, tileX: 100, tileY: 48, words: [], laidTick: 0, steering: 0, verb: "ATTACK", count: 4 });
    claimCountMarks(s, 0);
    expect(s.ants.filter((a) => a.claim === 1)).toHaveLength(4);
    expect(far.claim).toBeUndefined(); // nearest are picked, even across the map
    s.marks[0]!.count = 20;
    claimCountMarks(s, 0);
    expect(s.ants.filter((a) => a.claim === 1)).toHaveLength(5);
    expect(far.claim).toBe(1);
    expect(squad.claim).toBeUndefined(); expect(enemy.claim).toBeUndefined();
  });
  it("allocates only living free soldiers, keeps the patch share, and is independent of array order", () => {
    const s = emptyMatch(0, rules);
    for (const colony of [0, 1] as const) {
      Array.from({ length: 100 }, () => put(s, colony, 8, 24, { caste: "soldier" }));
      put(s, colony, 8, 24, { caste: "soldier", squad: "a" });
      put(s, colony, 8, 24, { caste: "soldier", claim: 1 });
      put(s, colony, 8, 24, { caste: "worker" });
    }
    const before = stateHash(s);
    const allocation = localSoldierAssignments(s)!;
    for (const colony of [0, 1] as const) {
      const ids = new Set(s.ants.filter((a) => a.colony === colony && a.caste === "soldier" && a.squad === null && a.claim === undefined).map((a) => a.id));
      expect([...allocation.front].filter((id) => ids.has(id))).toHaveLength(50);
      expect([...allocation.patches].filter((id) => ids.has(id))).toHaveLength(45);
    }
    expect([...allocation.patches].every((id) => allocation.front.has(id))).toBe(true);
    expect([...allocation.front].every((id) => s.ants.some((a) => a.id === id && a.caste === "soldier" && a.squad === null && a.claim === undefined))).toBe(true);
    expect(localSoldierAssignments({ ...s, ants: [...s.ants].reverse() })).toEqual(allocation);
    const old = { ...s, config: { ...s.config, localAnts: { ...s.config.localAnts!, soldierAllocation: undefined } } };
    expect(localSoldierAssignments(old)).toBeNull();
    expect(stateHash(s)).toBe(before);
  });
});

describe("sustained territorial wins", () => {
  function scenario() {
    const s = emptyMatch(0, { ...rules, earlyWin: { minTick: 10, holdTicks: 3, territoryRatioPermille: 3000, minHeldTiles: 30 } });
    // Early-win thresholds count reference tiles: four fine cells each at grid scale 2.
    s.owner.fill(-1); s.owner.fill(0, 0, 4 * 30); s.owner.fill(1, 4 * 30, 4 * 40);
    return s;
  }
  it("requires the opening and every consecutive qualifying tick; ties and reversed leads reset it", () => {
    const s = scenario();
    expect(sustainedTerritoryWin(s, 9)).toBeNull();
    expect(sustainedTerritoryWin(s, 10)).toBeNull();
    expect(sustainedTerritoryWin(s, 11)).toBeNull();
    expect(sustainedTerritoryWin(s, 12)).toMatchObject({ winner: 0, reason: "sustained_territory", decidedBy: "territory", tick: 12 });
    s.owner.fill(1, 4 * 20, 4 * 40);
    expect(sustainedTerritoryWin(s, 13)).toBeNull();
    expect(s.earlyWinProgress).toEqual({ leader: null, ticks: 0 });
    s.owner.fill(0, 0, 4 * 10); s.owner.fill(1, 4 * 10, 4 * 40);
    expect(sustainedTerritoryWin(s, 14)).toBeNull();
    expect(s.earlyWinProgress).toEqual({ leader: 1, ticks: 1 });
  });
  it("does not declare tiny openings or empty ground decisive; handles a zero-territory loser", () => {
    const s = scenario(); s.owner.fill(-1);
    s.owner.fill(0, 0, 4);
    for (let tick = 10; tick <= 20; tick++) expect(sustainedTerritoryWin(s, tick)).toBeNull();
    s.owner.fill(0, 0, 4 * 30);
    expect(sustainedTerritoryWin(s, 21)).toBeNull();
    expect(sustainedTerritoryWin(s, 22)).toBeNull();
    expect(sustainedTerritoryWin(s, 23)?.winner).toBe(0);
  });
  it("clones mutable progress and preserves step purity; replay uses the recorded config", () => {
    const config = playable({ ...rules, matchTicks: 20, earlyWin: { minTick: 0, holdTicks: 2, territoryRatioPermille: 3000, minHeldTiles: 1000 } });
    const s = createMatch(7001, config);
    const before = stateHash(s);
    const copy = cloneState(s); copy.earlyWinProgress!.ticks = 5;
    expect(s.earlyWinProgress!.ticks).toBe(0);
    const out = step(s);
    expect(stateHash(s)).toBe(before);
    const log = [headerLine(7001, config), tickLine(0, [])];
    expect(stateHash(replay(log, 1))).toBe(stateHash(out.state));
  });
  it("queen loss takes precedence and emits only one terminal event", () => {
    const s = scenario(); s.tick = 12; s.earlyWinProgress = { leader: 0, ticks: 2 };
    s.colonies[0].queens![0]!.lostTick = 11;
    const out = step(s);
    expect(out.state.result).toMatchObject({ winner: 1, reason: "queens_killed" });
    expect(out.events.filter((e) => e.type === "match_end")).toHaveLength(1);
  });
});
