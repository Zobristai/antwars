/** Offline candidate check, no inputs, seats, inference or balance sweep.
 * node --import ./src/ts-resolve.mjs test/sim/fighter-water-rally-repro.ts --head SHA
 * It never recaptures the baseline metrics.
 */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { rulesConfig, SUB } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile, isWaterTile, segmentOnLand } from "../../src/sim/terrain.js";
import type { Ant, SimState } from "../../src/sim/types.js";
import { sevenMapRotation } from "./seven-map-rotation.js";

type Intent = { kind: string; homeId: number; targetId: number; x: number; y: number };
type HeldAnt = Ant & { houseIntentHold?: { intent: Intent } };
type Motion = Pick<Ant, "x" | "y" | "vx" | "vy">;
type Point = { tick: number; x: number; y: number };
type Crossing = { antId: number; colony: number; start: Point; rawRally: { x: number; y: number };
  goal: { x: number; y: number }; waterLeft: number; waterRight: number; allSegmentsOnLand: boolean;
  positions: Point[]; rallyTicks: number; nonRallyTicks: number; end?: Point };

function rawRally(state: SimState, ant: Ant, intent: Intent) {
  const home = state.colonies[ant.colony].queens?.find(q => q.id === intent.homeId && q.lostTick === null);
  const queen = state.colonies[ant.colony === 0 ? 1 : 0].queens?.find(q => q.id === intent.targetId && q.lostTick === null);
  if (!home || !queen) return null;
  const p = state.config.rallyStartPermille + Math.trunc((state.config.rallyEndPermille - state.config.rallyStartPermille)
    * Math.min(state.tick, state.config.matchTicks) / state.config.matchTicks);
  return { x: home.queenX + Math.trunc((queen.queenX - home.queenX) * p / 1000),
    y: (2 + ((state.config.colonyMirror ? ant.id - ant.colony : ant.id) * 37) % (state.config.mapHeight / 2 - 4) + 0.5) * 2 * SUB };
}

export function measureWaterRallies(mapId: string, seed = 6006) {
  // Pinned to the seven-map rotation this was written for, which holds the old two.
  const config = sevenMapRotation(newMatchConfig(rulesConfig("redesign")));
  let state = createMatch(seed, { ...config, terrain: { ...config.terrain!, mapId } });
  assert.equal(state.config.gridScale, 2);
  const histories = new Map<number, Motion[]>(), active = new Map<number, Crossing>();
  const completed = new Map<number, Crossing>();
  const samples: { tick: number; waterRally: number[]; waterStationary: number[]; waterShaking: number[]; blockedShaking: number[] }[] = [];
  let interrupted = 0;
  for (let tick = 1; tick <= 7200 && state.result === null; tick++) {
    const before = state, prior = new Map(before.ants.map(ant => [ant.id, ant]));
    state = step(before).state;
    assert.equal(state.tick, tick);
    assert.equal(state.agents.length, 0);
    const living = new Set(state.ants.map(a => a.id));
    for (const id of histories.keys()) if (!living.has(id)) histories.delete(id);
    for (const id of active.keys()) if (!living.has(id)) { active.delete(id); interrupted++; }
    for (const ant of state.ants) {
      const history = histories.get(ant.id) ?? [];
      history.push({ x: ant.x, y: ant.y, vx: ant.vx, vy: ant.vy });
      if (history.length > 51) history.shift();
      histories.set(ant.id, history);
      const intent = (ant as HeldAnt).houseIntentHold?.intent;
      const old = prior.get(ant.id);
      if (!old) continue;
      if (ant.role === "fighter" && intent?.kind === "rally" && !active.has(ant.id) && !completed.has(ant.id)) {
        const raw = rawRally(before, old, intent);
        const water = raw && before.terrain?.water.find(r => raw.x >= r.x * SUB && raw.x < (r.x + r.width) * SUB
          && raw.y >= r.y * SUB && raw.y < (r.y + r.height) * SUB);
        if (raw && water) {
          const left = water.x * SUB, right = (water.x + water.width) * SUB;
          const fromOwnBank = ant.colony === 0 ? old.x < left && intent.x >= right : old.x >= right && intent.x < left;
          if (fromOwnBank) active.set(ant.id, { antId: ant.id, colony: ant.colony,
            start: { tick: before.tick, x: old.x, y: old.y }, rawRally: raw,
            goal: { x: intent.x, y: intent.y }, waterLeft: left, waterRight: right,
            allSegmentsOnLand: true, rallyTicks: 0, nonRallyTicks: 0,
            positions: [{ tick: before.tick, x: old.x, y: old.y }] });
        }
      }
      const episode = active.get(ant.id);
      if (!episode) continue;
      // Normal combat/role decisions may intervene; retain the same ant's actual
      // trajectory and disclose those intervals rather than claim uninterrupted rallying.
      if (ant.role === "fighter" && intent?.kind === "rally") episode.rallyTicks++;
      else episode.nonRallyTicks++;
      episode.allSegmentsOnLand &&= segmentOnLand(state.config, state.terrain, old.x, old.y, ant.x, ant.y);
      if (tick % 50 === 0) episode.positions.push({ tick, x: ant.x, y: ant.y });
      const across = ant.colony === 0 ? ant.x >= episode.waterRight : ant.x < episode.waterLeft;
      if (across && ant.role === "fighter") {
        assert.ok(episode.allSegmentsOnLand, `ant ${ant.id} crossing left the land route`);
        assert.ok(!isBlockedTile(state.terrain, Math.floor(ant.x / SUB), Math.floor(ant.y / SUB)));
        episode.end = { tick, x: ant.x, y: ant.y };
        episode.positions.push(episode.end);
        completed.set(ant.id, episode); active.delete(ant.id);
      }
    }
    if (tick % 600 !== 0) continue;
    const sample = { tick, waterRally: [0, 0], waterStationary: [0, 0], waterShaking: [0, 0], blockedShaking: [0, 0] };
    for (const ant of state.ants) {
      const intent = (ant as HeldAnt).houseIntentHold?.intent;
      if (ant.role !== "fighter" || intent?.kind !== "rally") continue;
      const water = isWaterTile(state.terrain, Math.floor(intent.x / SUB), Math.floor(intent.y / SUB));
      if (water) sample.waterRally[ant.colony]!++;
      if (!isBlockedTile(state.terrain, Math.floor(intent.x / SUB), Math.floor(intent.y / SUB))) continue;
      const history = histories.get(ant.id)!;
      if (history.length !== 51 || Math.hypot(ant.x - history[0]!.x, ant.y - history[0]!.y) > 1000) continue;
      if (water) sample.waterStationary[ant.colony]!++;
      let reversals = 0;
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1]!, b = history[i]!;
        if (a.vx * b.vx + a.vy * b.vy < 0) reversals++;
      }
      if (reversals >= 10) {
        sample.blockedShaking[ant.colony]!++;
        if (water) sample.waterShaking[ant.colony]!++;
      }
    }
    samples.push(sample);
  }
  const crossings = [...completed.values()];
  const uniqueCrossings = [0, 1].map(colony => crossings.filter(c => c.colony === colony).length);
  return { mapId, seed, steps: state.tick, terminal: state.result, agents: state.agents.length, samples, uniqueCrossings,
    interruptedEpisodes: interrupted, unfinishedEpisodes: active.size,
    // Keep a bounded, complete first witness in each direction. Counts are unique IDs,
    // not midline events or enemy-half presence. Every completed path checked each step.
    witnesses: [0, 1].map(colony => crossings.find(c => c.colony === colony) ?? null) };
}

export function assertWaterRallies(result: ReturnType<typeof measureWaterRallies>, coverage: "both-colonies" | "any-colony" = "both-colonies"): void {
  for (const sample of result.samples) {
    assert.deepEqual(sample.waterStationary, [0, 0], `${result.mapId} water-rally stationary at ${sample.tick}`);
    assert.deepEqual(sample.waterShaking, [0, 0]);
    assert.deepEqual(sample.blockedShaking, [0, 0]);
  }
  // Routing needs a completed trajectory, not a balance outcome. Keep the
  // stronger two-direction check available for scenarios that exercise it.
  const crossed = coverage === "both-colonies" ? result.uniqueCrossings.every(count => count > 0)
    : result.uniqueCrossings.some(count => count > 0);
  assert.ok(crossed, `${result.mapId}: no completed land-route witness${coverage === "both-colonies" ? " in one direction" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { head: { type: "string" }, map: { type: "string" } } });
  assert.ok(values.head, "--head must identify the candidate commit/tree");
  for (const mapId of values.map ? [values.map] : ["central-lake", "three-crossings"]) {
    const result = measureWaterRallies(mapId);
    console.log(JSON.stringify({ head: values.head, ...result }));
    assertWaterRallies(result);
  }
}
