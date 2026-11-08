/** Scripted peak-load diagnostic, not a balance sweep or an external match.
 * Run only while all lanes' sweeps are stopped:
 * node --import ./src/ts-resolve.mjs test/benchmark/terrain-timing.ts --head FULL_SHA [--new-match-config]
 * The optional flag measures only the shipped grid and final maps, not grid selection.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { applyInput, defaultAllocator, fillSquads } from "../../src/sim/agents.js";
import { MAPS, SUB, TERRAIN_RULES, rulesConfig } from "../../src/sim/config.js";
import { cloneState, createMatch, newAnt } from "../../src/sim/map.js";
import { claimCountMarks } from "../../src/sim/marks.js";
import { patrolChains, patrolWaypoint } from "../../src/sim/patrol.js";
import { isPassable } from "../../src/sim/terrain.js";
import { NEW_MATCH_GRID_SCALE, newMatchConfig, withGridScale } from "../../src/sim/gridScale.js";
import { peakTiming } from "../tools/colonyScale.js";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const expected = process.argv[process.argv.indexOf("--head") + 1];
if (!/^[0-9a-f]{40}$/.test(expected ?? "") || head !== expected) throw new Error("--head must match full HEAD");
execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src/sim", "test/tools/colonyScale.ts", "test/benchmark/terrain-timing.ts"]);
const patrolComparison = process.argv.includes("--patrol");
const finalMaps = process.argv.includes("--new-match-config") || patrolComparison;
function cgroup(path: string): string | null {
  try { return readFileSync(`/sys/fs/cgroup/${path}`, "utf8").trim(); } catch { return null; }
}
const machine = { node: process.version, platform: platform(), release: release(), arch: arch(),
  cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, availableParallelism: availableParallelism(),
  totalMemoryBytes: totalmem(), cpuMax: cgroup("cpu.max"), memoryMax: cgroup("memory.max"), loadAverage: loadavg() };
const scales = [NEW_MATCH_GRID_SCALE];
const candidates = scales.map(scale => ({ scale, reports: MAPS.map(map => {
  const base = { ...rulesConfig("redesign"), terrain: { ...TERRAIN_RULES, mapId: map.id } };
  const config = finalMaps ? newMatchConfig(base) : withGridScale(base);
  const state = createMatch(7001, config);
  state.tick = config.matchTicks - 1000;
  state.ants = [];
  const land = Array.from({ length: config.mapWidth * config.mapHeight }, (_, i) => i)
    .filter(i => isPassable(state, i % config.mapWidth, Math.floor(i / config.mapWidth)));
  for (const colony of [0, 1] as const) for (let i = 0; i < 512; i++) {
    // Patrol comparison keeps opponents in their own halves so travel, not contact-pausing,
    // exercises the active chains. The original diagnostic fixture is unchanged otherwise.
    const candidates = patrolComparison ? land.filter(tile => tile % config.mapWidth < config.mapWidth / 2 - 2 * scale) : land;
    const tile = candidates[Math.floor(i * candidates.length / 512)]!;
    const x = tile % config.mapWidth;
    state.ants.push(newAnt(config, state.nextAntId++, colony,
      (colony ? config.mapWidth - 1 - x : x) * SUB + SUB / 2,
      Math.floor(tile / config.mapWidth) * SUB + SUB / 2, i % 2 ? "worker" : "soldier"));
  }
  for (const colony of state.colonies) {
    colony.seenFood = state.food.flatMap((food, i) => food > 0 ? [i] : []);
    const original = colony.queens![0]!;
    // Eight founding-tick-zero queens, not the old two-queen shortcut. Use
    // fixed physical targets projected to nearest legal land on each map.
    colony.queens = [[8, 24], [8, 8], [8, 40], [24, 24]].map(([x, y], id) => {
      const targetX = (colony.id ? 64 - (x! + 0.5) : x! + 0.5) * scale;
      const targetY = (y! + 0.5) * scale;
      let best = land[0]!, distance = Infinity;
      for (const tile of land) {
        const d = (tile % config.mapWidth + 0.5 - targetX) ** 2 +
          (Math.floor(tile / config.mapWidth) + 0.5 - targetY) ** 2;
        if (d < distance) { best = tile; distance = d; }
      }
      return { ...original, id, queenX: (best % config.mapWidth + 0.5) * SUB,
        queenY: (Math.floor(best / config.mapWidth) + 0.5) * SUB, foundedTick: 0 };
    });
    state.colonies[colony.id] = { ...colony, queenX: colony.queens[0]!.queenX,
      queenY: colony.queens[0]!.queenY };
  }
  for (let seat = 0; seat < 8; seat++) {
    const agentId = `timing-${seat}`, colony = (seat % 2) as 0 | 1;
    const joined = applyInput(state, { type: "join", agentId, colony }, state.tick, defaultAllocator, []);
    if (joined.error !== null) throw new Error(JSON.stringify(joined.error));
  }
  if (state.agents.length !== 8 || state.ants.length !== 1024 ||
    state.colonies.reduce((n, c) => n + c.queens!.length, 0) !== 8) throw new Error("invalid peak fixture");
  if (patrolComparison) {
    fillSquads(state, defaultAllocator, state.tick, []);
    const active = cloneState(state);
    // Four teammates per side, eighteen marks each (180 s lifetime / 10 s command floor).
    for (const colony of [0, 1] as const) for (let i = 0; i < 72; i++) {
      const x = (8 + i % 9 * 2) * scale, y = (8 + Math.floor(i / 9) * 3) * scale;
      let nearest = land[0]!, distance = Infinity;
      for (const tile of land) {
        const dx = tile % config.mapWidth - (colony ? config.mapWidth - 1 - x : x);
        const dy = Math.floor(tile / config.mapWidth) - y, d = dx * dx + dy * dy;
        if (d < distance) { nearest = tile; distance = d; }
      }
      active.marks.push({ id: active.nextMarkId++, agentId: `timing-${colony + 2 * Math.floor(i / 18)}`,
        colony, tileX: nearest % config.mapWidth, tileY: Math.floor(nearest / config.mapWidth), words: [],
        laidTick: state.tick - (17 - i % 18) * config.commandFloorTicks, steering: 0, verb: "PATROL", count: 8, revision: 0 });
    }
    claimCountMarks(active, active.tick);
    const chains = patrolChains(active);
    for (const ant of active.ants) if (ant.claim !== undefined) patrolWaypoint(ant, chains.get(ant.claim)!, chains);
    const claimedPerColony = [0, 1].map(colony => active.ants.filter(ant => ant.colony === colony && ant.claim !== undefined).length);
    const chainSizes = [...new Set([...chains.values()].map(item => item.chain))].map(chain => chain.length);
    if (claimedPerColony.some(count => count !== 488) || chainSizes.some(size => size !== 72) || chainSizes.length !== 2) throw new Error("invalid patrol peak fixture");
    const withoutPatrol = peakTiming(state), withPatrol = peakTiming(active);
    return { mapId: map.id, mapName: map.name, seats: 8, queens: 8, antsPerColony: 512,
      width: config.mapWidth, height: config.mapHeight, tick: state.tick, patrolLinkTiles: config.patrolLinkTiles,
      marksPerColony: 72, requestedPerMark: 8, claimedPerColony, chainSizes,
      withoutPatrol, withPatrol, meanDeltaMs: withPatrol.meanMs - withoutPatrol.meanMs,
      meanRatio: withPatrol.meanMs / withoutPatrol.meanMs,
      passes: withPatrol.maxMs < withPatrol.budgetMs && withoutPatrol.maxMs < withoutPatrol.budgetMs };
  }
  const { rawMs, ...stats } = peakTiming(state);
  return { mapId: map.id, mapName: map.name, seats: 8, queens: 8, antsPerColony: 512,
    width: config.mapWidth, height: config.mapHeight, tick: state.tick,
    ...stats, passes: stats.maxMs < stats.budgetMs, rawMs };
}) }));
const selectedScale = [...candidates].reverse().find(candidate => candidate.reports.every(report => report.passes))?.scale ?? null;
console.log(JSON.stringify({ head, measuredAt: new Date().toISOString(), machine,
  mode: patrolComparison ? "patrol-comparison" : finalMaps ? "final-maps" : "grid-choice",
  method: patrolComparison
    ? "Paired identical shipped-grid fixtures, 20 warmups + 200 repeated cloned fixed-input ticks each; 512 ants/colony spread over own-half land, mixed castes, eight active in-process seats and eight starting queens. Same patrol-enabled config with no marks versus 72 connected active patrol marks/colony and 488 preclaimed ants/colony. No external matches."
    : "20 warmups + 200 repeated cloned fixed-input ticks per map and candidate grid; full colonies spread over legal land, mixed castes, eight active scripted seats and eight starting queens; no external matches",
  candidates, selectedScale }));
process.exitCode = selectedScale === null ? 1 : 0;
