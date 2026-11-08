/** Explicit, no-agent differential probe, not part of the default test suite.
 * node --import ./src/ts-resolve.mjs test/sim/food-layout-probe.ts
 * Optional --count=N is a reduced diagnostic, never the 60,000-seed proof.
 * Baselines are read from local Git objects; this does no network Git or ref writes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLIC_CONFIG, type SimConfig } from "../../src/sim/config.js";
import { stateHash } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { SimState } from "../../src/sim/types.js";

const foodBaseline = "ff2979e629abff609b521ddd3502623dfc3c5562";
const rockBaseline = "a6ce9a27e1eccfbbd5807c90ee3896c5104a1d61";
const countArg = process.argv.slice(2);
assert(countArg.length <= 1 && (countArg.length === 0 || /^--count=\d+$/.test(countArg[0]!)), "only --count=N is supported");
const count = countArg.length === 0 ? 60_000 : Number(countArg[0]!.split("=")[1]);
assert(Number.isSafeInteger(count) && count > 0 && count <= 60_000);
const startedAt = new Date().toISOString();
const root = mkdtempSync(join(tmpdir(), "antwar-food-probe-"));

async function baseline(sha: string) {
  const directory = join(root, sha);
  // mkdir through the archive's destination parent, never checkout/reset a ref.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(directory);
  const archive = execFileSync("git", ["archive", sha, "src/sim"], { maxBuffer: 8 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  const map = await import(pathToFileURL(join(directory, "src/sim/map.ts")).href) as typeof import("../../src/sim/map.js");
  const config = await import(pathToFileURL(join(directory, "src/sim/config.ts")).href) as typeof import("../../src/sim/config.js");
  const log = await import(pathToFileURL(join(directory, "src/sim/log.ts")).href) as typeof import("../../src/sim/log.js");
  return { createMatch: map.createMatch, config: config.PUBLIC_CONFIG, hash: log.stateHash };
}

function preRockConfig(config: SimConfig): SimConfig {
  if (config.terrain === undefined) return config;
  // The approved two-baseline comparison: only the explicit rocks switch
  // is excluded here. The unmodified rock-enabled config is in full-state proof.
  const { rocks: _rocks, ...terrain } = config.terrain;
  return { ...config, terrain };
}

function foodBytes(state: SimState): string {
  return JSON.stringify({ config: preRockConfig(state.config), water: state.terrain?.water,
    foodPatches: state.config.foodPatches, food: state.food, foodCap: state.foodCap, rngState: state.rngState });
}

function valid(state: SimState): void {
  const config = state.config, rules = config.foodLayout!;
  assert.equal(config.foodPatches.length, rules.patches.length);
  const patches = config.foodPatches.flatMap(p => [p, { ...p, tileX: config.mapWidth - 1 - p.tileX }]);
  const nests = [config.nestTileX, config.mapWidth - 1 - config.nestTileX];
  let minimum = 0, maximum = 0;
  for (const [index, patch] of patches.entries()) {
    for (const nest of nests) assert((patch.tileX - nest) ** 2 + (patch.tileY - config.nestTileY) ** 2 >=
      (patch.radius + rules.nestClearanceTiles) ** 2);
    for (const other of patches.slice(index + 1)) assert((patch.tileX - other.tileX) ** 2 +
      (patch.tileY - other.tileY) ** 2 >= (patch.radius + other.radius + rules.patchClearanceTiles) ** 2);
    let area = 0;
    for (let dy = -patch.radius; dy <= patch.radius; dy++) for (let dx = -patch.radius; dx <= patch.radius; dx++) {
      if (dx * dx + dy * dy > patch.radius ** 2) continue;
      const x = patch.tileX + dx, y = patch.tileY + dy;
      assert(x >= 0 && x < config.mapWidth && y >= 0 && y < config.mapHeight);
      assert(!isBlockedTile(state.terrain, x, y));
      const at = y * config.mapWidth + x, value = state.food[at]!;
      assert(value >= Math.max(1, patch.perTile - config.foodJitter) && value <= patch.perTile + config.foodJitter);
      assert.equal(value, state.food[y * config.mapWidth + config.mapWidth - 1 - x]);
      area++;
    }
    minimum += area * Math.max(1, patch.perTile - config.foodJitter);
    maximum += area * (patch.perTile + config.foodJitter);
  }
  assert(minimum >= rules.minStartingFood && maximum <= rules.maxStartingFood);
  const total = state.food.reduce((sum, value) => sum + value, 0);
  assert(total >= minimum && total <= maximum);
  assert.deepEqual(state.foodCap, state.food);
  assert.equal(state.agents.length, 0);
}

try {
  const old = await baseline(foodBaseline), rocks = await baseline(rockBaseline);
  // Report config mismatch immediately, independently of seed/layout generation.
  assert.equal(JSON.stringify(preRockConfig(PUBLIC_CONFIG)), JSON.stringify(old.config));
  assert.equal(JSON.stringify(PUBLIC_CONFIG), JSON.stringify(rocks.config));
  const maps: Record<string, { starts: number; repaired: number; unchanged: number }> = {};
  let foodFailures = 0, rockFailures = 0, compared = 0;
  for (let i = 0; i < count; i++) {
    const seed = i * 2654435761 % 2 ** 31;
    try {
      const state = createMatch(seed, PUBLIC_CONFIG);
      valid(state);
      const row = maps[state.terrain!.mapId] ??= { starts: 0, repaired: 0, unchanged: 0 };
      row.starts++;
      let before: SimState | undefined, withRocks: SimState | undefined;
      try { before = old.createMatch(seed, old.config); }
      catch (err) {
        if (!(err instanceof Error) || err.message !== "Cannot place seeded food patches within configured clearance, passability and food bounds") throw err;
        foodFailures++;
      }
      try { withRocks = rocks.createMatch(seed, rocks.config); }
      catch (err) {
        if (!(err instanceof Error) || err.message !== "Cannot place seeded food patches within configured clearance, passability and food bounds") throw err;
        rockFailures++;
      }
      assert.equal(before === undefined, withRocks === undefined, "baseline failure sets differ");
      if (before === undefined) row.repaired++;
      else {
        assert.equal(foodBytes(state), foodBytes(before), "food/water/config/foodCap/RNG changed");
        assert.equal(stateHash(state), rocks.hash(withRocks!), "post-rock full state changed");
        row.unchanged++;
        compared++;
      }
    } catch (err) {
      console.error(JSON.stringify({ index: i, seed, error: err instanceof Error ? err.message : String(err) }));
      throw err;
    }
    if ((i + 1) % 5000 === 0) console.log(JSON.stringify({ checked: i + 1, at: new Date().toISOString() }));
  }
  assert.equal(Object.values(maps).reduce((sum, row) => sum + row.starts, 0), count);
  if (count === 60_000) {
    assert.equal(foodFailures, 51, "pre-fix probe must reproduce all 51 known failures");
    assert.equal(rockFailures, 51);
    assert.equal(compared, 59_949);
    assert.deepEqual(Object.keys(maps).sort(), ["central-lake", "open-field", "three-crossings"]);
  }
  console.log(JSON.stringify({ result: "passed", coverage: count === 60_000 ? "full 60,000-seed proof" : "reduced diagnostic only",
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
    startedAt, finishedAt: new Date().toISOString(), foodBaseline, rockBaseline, checked: count, foodFailures,
    rockFailures, compared, maps, configComparison: "Only terrain.rocks excluded from pre-rock config; full config included in post-rock stateHash" }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
