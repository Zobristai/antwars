import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BALANCE_STRATEGIES, balanceBroodAtCheckpoint, balanceFoundingCommand, balanceSummary, hatchExperimentSummary, playBalanceMatch } from "./balance.js";
import { parseHatchArm, selectHatchArm } from "./hatchVariants.js";
import { PUBLIC_CONFIG, RULES_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { buildGrid, createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { takeView, type AgentView } from "../../src/sim/view.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { playable } from "../playable.ts";

const rules = playable(rulesConfig("redesign"));
const short = { ...rules, terrain: undefined, foodLayout: undefined, matchTicks: 25 };

function founderView(): AgentView {
  const state = step(createMatch(7001, short), [{ type: "join", agentId: "founder", placement: 0 }]).state;
  const view = takeView(state, buildGrid(state), state.agents[0]!);
  return { ...view, tick: 3001, nextCommandTick: 3001,
    queenFounding: { ...view.queenFounding!, foodStore: view.queenFounding!.cost, nextFoundTick: 3001 },
    territoryRows: Array.from({ length: rules.mapHeight }, (_, y) => Array.from({ length: rules.mapWidth }, (_, x) =>
      y === 5 && (x >= 20 && x <= 22 || x >= rules.mapWidth - 23 && x <= rules.mapWidth - 21) ? "#" : ".").join("")),
    terrain: { mapId: "test", mapName: "test", encoding: "rectangles", water: [[20, 5, 1, 1]], rocks: [[21, 5, 1, 1]] } };
}

describe("hatch experiment selection and figures", () => {
  it("selects unchanged-main timing or the live rule without mutating defaults", () => {
    const before = JSON.stringify(rules);
    const historical = selectHatchArm(rules, "main");
    expect(historical).not.toHaveProperty("hatchTiming");
    expect(selectHatchArm(historical, "A").hatchTiming).toEqual({ soldierIntervalMultiplier: 2 });
    expect(JSON.stringify(rules)).toBe(before);
    for (const name of RULES_NAMES) expect(rulesConfig(name).hatchTiming).toEqual(name === "redesign" ? { soldierIntervalMultiplier: 2 } : undefined);
    expect(PUBLIC_CONFIG).not.toHaveProperty("hatchTiming");
    expect(parseHatchArm("main")).toBe("main");
    expect(parseHatchArm("A")).toBe("A");
    for (const rejected of ["B", "b", "live"]) expect(() => parseHatchArm(rejected)).toThrow("--hatch-arm");
  });

  it("observes live soldier share and unspent food without mutating the tick-3000 state", () => {
    const state = emptyMatch(3000, short);
    addAnt(state, 0, 5, 5);
    addAnt(state, 0, 6, 5, { caste: "soldier" });
    addAnt(state, 0, 7, 5, { caste: "soldier" });
    state.colonies[0].foodStore = 1234;
    state.colonies[1].foodStore = 99;
    const before = stateHash(state);
    expect(balanceBroodAtCheckpoint(state)).toEqual([
      { live: 3, soldiers: 2, soldierShare: 2 / 3, foodStore: 1234 },
      { live: 0, soldiers: 0, soldierShare: null, foodStore: 99 },
    ]);
    expect(stateHash(state)).toBe(before);
  });

  it("records the real five-minute checkpoint and distinguishes old, missing and eliminated observations", () => {
    const config = { ...short, ticksPerSecond: 1, matchTicks: 301 };
    const observed = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config });
    expect(observed.minuteFivePopulation).not.toBeNull();
    for (const row of observed.minuteFivePopulation!) {
      expect(row.soldierShare).toBe(row.live ? row.soldiers / row.live : null);
      expect(row.foodStore).toBeGreaterThanOrEqual(0);
    }
    const checkpoint = hatchExperimentSummary([observed], config);
    expect(checkpoint.checkpointTick).toBe(300);
    expect(checkpoint.colonies.map(row => row.status)).toEqual(["observed", "observed"]);
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: short });
    expect(record.minuteFivePopulation).toBeNull();
    expect(hatchExperimentSummary([record], rules).colonies[0]!.status).toBe("not_reached");
    expect(hatchExperimentSummary([{ ...record, minuteFivePopulation: undefined }], rules).colonies[0]!.status).toBe("unmeasured");
    const eliminated = { ...record, naturalResult: { ...record.naturalResult, reason: "queens_killed" as const } };
    expect(hatchExperimentSummary([eliminated], rules).colonies[0]!.status).toBe("not_applicable_elimination");
  });

  it("reports strategy win shares, natural and effective lengths without accepting a partial matrix", () => {
    const record = playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config: short });
    const input = { ...record, naturalEndTick: 15000, naturalResult: { ...record.naturalResult, winner: 0 as const },
      early: [{ rules: rules.earlyWin!, fireTick: 9000, winner: 1 as const, laterLeadChange: false }] };
    const summary = balanceSummary([input], rules);
    expect(summary.strategyWins.find(row => row.strategy === "soldiers")).toMatchObject({ wins: 1, played: 1, winShare: 1 });
    expect(summary.hatchExperiment.effectiveMatchTicks).toEqual({ median: 9001, min: 9001, max: 9001 });
    expect(summary.hatchExperiment.naturalMatchTicks).toEqual({ median: 15000, min: 15000, max: 15000 });
    expect(summary.complete).toBe(false);
    expect(summary.accepted).toBe(false);
    expect(summary.dominatedBy).toEqual([]);
    expect(hatchExperimentSummary([], rules).effectiveMatchTicks).toEqual({ median: null, min: null, max: null });
  });

  it("sends the selected config through the existing single-match worker path", () => {
    const config = selectHatchArm(short, "A");
    const child = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--single"], {
      encoding: "utf8", input: JSON.stringify({ seed: 7001, strategies: ["workers", "soldiers"], config }), timeout: 30000,
    });
    expect(child.status, child.stderr).toBe(0);
    const record = JSON.parse(child.stdout);
    expect(record.configDigest).toBe(playBalanceMatch({ seed: 7001, strategies: ["workers", "soldiers"], config }).configDigest);
    expect(record).toHaveProperty("minuteFivePopulation", null);
  });

  it.each(["main", "A"] as const)("uses the same affordable, dry, mirrored founding policy in %s", arm => {
    const config = selectHatchArm(rules, arm);
    const view = founderView();
    const before = JSON.stringify(view);
    expect(balanceFoundingCommand(view, config)).toEqual({ type: "found_queen", agentId: "founder", tileX: 22, tileY: 5 });
    const mirror = { ...view, colony: 1 as const,
      queens: view.queens!.map(queen => ({ ...queen, tileX: config.mapWidth - 1 - queen.tileX })),
      terrain: { ...view.terrain!, water: [[config.mapWidth - 21, 5, 1, 1] as const], rocks: [[config.mapWidth - 22, 5, 1, 1] as const] } };
    expect(balanceFoundingCommand(mirror, config)).toMatchObject({ tileX: config.mapWidth - 23, tileY: 5 });
    expect(JSON.stringify(view)).toBe(before);
  });

  it("waits for opening, quoted cost, cooldown, cap, command floor and held spaced land", () => {
    const view = founderView();
    const founding = view.queenFounding!;
    for (const candidate of [
      { ...view, queenFounding: undefined }, { ...view, queens: [] },
      { ...view, nextCommandTick: view.tick + 1 },
      { ...view, queenFounding: { ...founding, firstFoundTick: view.tick + 1 } },
      { ...view, queenFounding: { ...founding, nextFoundTick: view.tick + 1 } },
      { ...view, queenFounding: { ...founding, foodStore: founding.cost - 1 } },
      { ...view, queenFounding: { ...founding, maxLiveQueens: 1 } },
      { ...view, territoryRows: [] },
      { ...view, queenFounding: { ...founding, minDistanceTiles: 1000 } },
    ]) expect(balanceFoundingCommand(candidate, rules)).toBeNull();
    expect(balanceFoundingCommand({ ...view, queenFounding: { ...founding, foodStore: founding.cost } }, rules)).not.toBeNull(); // No extra reserve.
    const lost = { ...view.queens![0]!, queenId: 1, tileX: 22, tileY: 5, lostTick: 2000 };
    const lostNestView = { ...view, queens: [...view.queens!, lost],
      territoryRows: view.territoryRows.map(row => row.slice(0, 23) + ".".repeat(rules.mapWidth - 23)) };
    expect(balanceFoundingCommand(lostNestView, rules)).not.toBeNull();
    expect(balanceFoundingCommand(lostNestView,
      { ...rules, queenFounding: { ...rules.queenFounding!, standingNestsOnly: false } })).toBeNull();
  });

  it("leaves stale-view food, territory and command refusals to the real validator", () => {
    const config = { ...short, queenFounding: { ...rules.queenFounding!, firstFoundTick: 0, minDistanceTiles: 1 } };
    const initial = step(createMatch(7001, config), [{ type: "join", agentId: "founder", placement: 0 }]).state;
    initial.tick = 100;
    const view = takeView(initial, buildGrid(initial), initial.agents[0]!);
    const command = balanceFoundingCommand({ ...view, queenFounding: { ...view.queenFounding!, foodStore: 10000 } }, config)!;
    expect(command).not.toBeNull();
    initial.owner[command.tileY * config.mapWidth + command.tileX] = -1;
    expect(step(initial, [command]).results[0]).toMatchObject({ ok: false, error: { code: "queen_tile_not_held" } });
    initial.owner[command.tileY * config.mapWidth + command.tileX] = 0;
    initial.colonies[0].foodStore = 0;
    expect(step(initial, [command]).results[0]).toMatchObject({ ok: false, error: { code: "queen_food" } });
    initial.agents[0]!.lastCommandTick = initial.tick;
    expect(step(initial, [command]).results[0]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  // The harness sends brood with set_brood to the queens a seat owns.
  const foundingConfig: SimConfig = { ...short, ticksPerSecond: 1, matchTicks: 301, commandFloorTicks: 1,
    // Motionless ants on a food patch around each nest deliver without walking, paying for founding and hatching.
    antSpeedTilesPerSecond: 0, foodPatches: [{ tileX: short.nestTileX, tileY: short.nestTileY, radius: 2, perTile: 50 }], foodRegrowTicks: 1,
    queenFounding: { ...rules.queenFounding!, cost: 1, firstFoundTick: 10,
      cooldownTicks: 30, minDistanceTiles: 1, maxLiveQueens: 2 } };

  it.each(BALANCE_STRATEGIES)("gives %s one existing founder seat, retaining brood and tick-3000-equivalent measurements", strategy => {
    const record = playBalanceMatch({ seed: 7001, strategies: [strategy, strategy], config: foundingConfig, founding: "shared" });
    for (const row of record.founding!.colonies) {
      expect(row).toMatchObject({ attempted: 1, accepted: 1, refusals: [] });
      expect(row.queenCounts.map(point => point.live)).toEqual([1, 2]);
      expect(row.additionalQueenHatches).toBeGreaterThan(0);
    }
    expect(record.minuteFivePopulation).not.toBeNull();
    if (strategy === "workers") expect(record.minuteFivePopulation!.every(row => row.soldiers === 0)).toBe(true);
    if (strategy === "soldiers") expect(record.minuteFivePopulation!.every(row => row.soldiers > 0)).toBe(true);
    expect(hatchExperimentSummary([record], foundingConfig).founding.colonies).toHaveLength(2);
  });

  // Execution timeout only: four 301-tick matches of pure computation, no waits. Alone 2.80-3.03 s
  // on a slow shared machine (1.35 s on the deploy host); beside rolling-selection.test.ts at --maxWorkers=2, 6.49-7.00 s
  // (worst loaded 8.1 s), past the 5 s default. 30 s is about 4x the worst loaded figure.
  it("exercises second-queen hatching equally for workers in both paired arms", () => {
    const records = (["main", "A"] as const).map(arm => playBalanceMatch({ seed: 7001, strategies: ["workers", "workers"],
      config: selectHatchArm(foundingConfig, arm), founding: "shared" }));
    expect(records[0]!.founding).toEqual(records[1]!.founding);
    expect(records[1]!.founding!.colonies[0]!.additionalQueenHatches).toBeGreaterThan(0);
    const child = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--single"], {
      encoding: "utf8", input: JSON.stringify({ seed: 7001, strategies: ["workers", "workers"],
        config: selectHatchArm(foundingConfig, "A"), founding: "shared" }), timeout: 30000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).founding).toEqual(records[1]!.founding);
    const old = { ...records[0]!, founding: undefined };
    expect(hatchExperimentSummary([old], foundingConfig).founding).toEqual({ measuredMatches: 0, unmeasuredMatches: 1, colonies: [] });
    const off = playBalanceMatch({ seed: 7001, strategies: ["workers", "workers"], config: foundingConfig, founding: "off" });
    expect(off.founding!.colonies.every(row => row.attempted === 0 && row.additionalQueenHatches === 0)).toBe(true);
    expect(off.founding!.colonies.every(row => row.queenCounts.length === 1)).toBe(true);
  }, 30_000);

  it("wires both CLIs to arm selection, preserving colonyScale's original scripted observation path", () => {
    const sweep = readFileSync("test/tools/balance-sweep.mjs", "utf8");
    expect(sweep).toContain('parseHatchArm(arg("hatch-arm", "A"))');
    expect(sweep).toContain('selectHatchArm(rulesConfig("redesign"), hatchArm)');
    expect(sweep).toContain('arg("founding", "shared")');
    expect(sweep).toContain('founding = priorManifest.founding ?? "off"');
    expect(sweep).toContain('...entry, config, founding, earlyCandidates: earlyCandidates(config)');
    expect(sweep).toContain('hatchExperiment.founding.colonies');
    const scale = readFileSync("test/tools/colonyScale.ts", "utf8");
    expect(scale).toContain('selectHatchArm(rulesConfig("redesign"), hatchArm)');
    expect(scale).toContain("houseMatch(seed, candidateConfig)");
    expect(scale).toContain("observe: [await observeBytes(run.peak, 0), await observeBytes(run.peak, 1)]");
    expect(scale).toContain('client.callTool({ name: "join"');
    expect(scale).toContain("peakTiming: peakTiming(run.peak)");
  });
});
