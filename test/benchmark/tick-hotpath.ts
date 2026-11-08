/** Tick hot-path benchmark: simulation plus built-in planner at large ant counts.
 * Not part of the repository test suite. Board and seeding are the probe's
 * (web/capture/probe.ts at 69c56b2e0e6eaf239c966bde35adf2ac4ead4dda): an open 128x128
 * reference board at grid scale 2 on the redesign rules, with no agents.
 *
 *   node --import ./src/ts-resolve.mjs test/benchmark/tick-hotpath.ts [--ants 4096] [--ticks 100] [--seed 1] [--warmup 5]
 *   node --cpu-prof --cpu-prof-dir=/tmp/prof --import ./src/ts-resolve.mjs test/benchmark/tick-hotpath.ts
 *
 * Prints the per-tick median and p90 of step(), the machine, and a digest over every
 * tick's stateHash so two commits can be compared for identical results.
 */
import { createHash } from "node:crypto";
import { arch, cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { MAPS, TERRAIN_RULES, rulesConfig, type FoodPatch, type SimConfig } from "../../src/sim/config.ts";
import { tileCentre } from "../../src/sim/geometry.ts";
import { withGridScale } from "../../src/sim/gridScale.ts";
import { stateHash } from "../../src/sim/log.ts";
import { createMatch, mirrorX, newAnt } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import { isBlockedTile } from "../../src/sim/terrain.ts";
import type { SimState } from "../../src/sim/types.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const ANTS = arg("ants", 4096);
const TICKS = arg("ticks", 100);
const SEED = arg("seed", 1);
const WARMUP = arg("warmup", 5);

const FOOD: readonly FoodPatch[] = [
  { tileX: 20, tileY: 27, radius: 5, perTile: 2 },
  { tileX: 36, tileY: 24, radius: 2, perTile: 6 },
  { tileX: 36, tileY: 104, radius: 2, perTile: 6 },
  { tileX: 60, tileY: 64, radius: 1, perTile: 1 },
  { tileX: 56, tileY: 27, radius: 1, perTile: 1 },
  { tileX: 56, tileY: 101, radius: 1, perTile: 1 },
];

function probeConfig(ants: number): SimConfig {
  const live = rulesConfig("redesign");
  const reference: SimConfig = {
    ...live,
    mapWidth: 128,
    mapHeight: 128,
    nestTileX: 16,
    nestTileY: 64,
    colonyCap: ants,
    startAnts: 0,
    foodPatches: FOOD,
    foodLayout: { ...live.foodLayout!, patches: FOOD },
    terrain: { ...TERRAIN_RULES, maps: MAPS.filter((map) => map.id === "open-field"), referenceWidth: 128, referenceHeight: 128 },
  };
  const fine = withGridScale(reference);
  return { ...fine, startArea: "back-quarter", terrain: { ...fine.terrain!, referenceWidth: fine.mapWidth, referenceHeight: fine.mapHeight } };
}

function nearestLand(state: SimState, band: number, x: number, y: number, taken: ReadonlySet<number>): { x: number; y: number } {
  const { mapWidth, mapHeight } = state.config;
  for (let r = 0; r < mapHeight; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || tx >= band || ty < 0 || ty >= mapHeight || taken.has(ty * mapWidth + tx)) continue;
        if (isBlockedTile(state.terrain, tx, ty) || isBlockedTile(state.terrain, mapWidth - 1 - tx, ty)) continue;
        return { x: tx, y: ty };
      }
    }
  }
  throw new Error("no land left in the start band");
}

function probeMatch(seed: number, ants: number): SimState {
  const config = probeConfig(ants);
  const state = createMatch(seed, config);
  const band = Math.floor(config.mapWidth * 0.4);
  const cols = Math.round(Math.sqrt((ants * band) / config.mapHeight));
  const rows = Math.ceil(ants / cols);
  const taken = new Set<number>();
  for (let i = 0; i < ants; i++) {
    const want = { x: Math.floor(((i % cols) + 0.5) * band / cols), y: Math.floor((Math.floor(i / cols) + 0.5) * config.mapHeight / rows) };
    const tile = nearestLand(state, band, want.x, want.y, taken);
    taken.add(tile.y * config.mapWidth + tile.x);
    const x = tileCentre(tile.x), y = tileCentre(tile.y);
    const caste = i % 2 === 0 ? "worker" : "soldier";
    state.ants.push(newAnt(config, state.nextAntId++, 0, x, y, caste));
    state.ants.push(newAnt(config, state.nextAntId++, 1, mirrorX(config, x), y, caste));
  }
  return state;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

let state = probeMatch(SEED, ANTS);
const digest = createHash("sha256");
const times: number[] = [];
for (let t = 0; t < WARMUP + TICKS && state.result === null; t++) {
  const start = performance.now();
  state = step(state).state;
  const ms = performance.now() - start;
  if (t >= WARMUP) times.push(ms);
  digest.update(stateHash(state));
}
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({
  machine: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, platform: platform(), release: release(), arch: arch(), node: process.version },
  antsPerSide: ANTS, seed: SEED, warmupTicks: WARMUP, measuredTicks: times.length, livingAnts: state.ants.length, result: state.result,
  medianMs: Number(quantile(sorted, 0.5).toFixed(2)),
  p90Ms: Number(quantile(sorted, 0.9).toFixed(2)),
  resultDigest: digest.digest("hex"),
}, null, 2));
