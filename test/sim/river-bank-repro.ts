/** Private correctness repro, never a server or agent seat.
 * node --import ./src/ts-resolve.mjs test/sim/river-bank-repro.ts --head SHA [--expect-zero]
 * Run unchanged against main and a fix validation tree. The fix tree's
 * new-match boundary supplies its fine grid; historical/main configs stay as-is.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { rulesConfig, SUB, type SimConfig } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { isBlockedTile } from "../../src/sim/terrain.js";
import type { Ant, ColonyId } from "../../src/sim/types.js";

type Motion = Pick<Ant, "x" | "y" | "vx" | "vy">;
// Read the private serialized intent, not a recomputed rally line: holds may
// legitimately retain an earlier point. This diagnostic never writes it.
type IntentAnt = Ant & { readonly houseIntentHold?: { readonly intent: {
  readonly kind: string; readonly x: number; readonly y: number;
} } };
const ticks = 7200, window = 50, sampleEvery = 600;
const gridModule = new URL("../../src/sim/gridScale.ts", import.meta.url);

async function configFor(mapId: string): Promise<SimConfig> {
  const reference = rulesConfig("redesign");
  const boundary: { newMatchConfig(config: SimConfig): SimConfig } | undefined = existsSync(gridModule)
    ? await import(gridModule.href) : undefined;
  const config = boundary === undefined ? reference : boundary.newMatchConfig(reference);
  return { ...config, terrain: { ...config.terrain!, mapId } };
}

async function measure(mapId: string) {
  let state = createMatch(6006, await configFor(mapId));
  const scale = "gridScale" in state.config && typeof state.config.gridScale === "number" ? state.config.gridScale : 1;
  const histories = new Map<number, Motion[]>();
  const peakStuck = [0, 0], peakShaking = [0, 0];
  const samples: { tick: number; stuck: number[]; shaking: number[]; wetRally: number[] }[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    state = step(state).state;
    assert.equal(state.tick, tick, "repro must reach every requested tick");
    assert.equal(state.agents.length, 0, "repro must never seat an agent");
    const live = new Set(state.ants.map(ant => ant.id));
    for (const id of histories.keys()) if (!live.has(id)) histories.delete(id);
    for (const ant of state.ants) {
      const history = histories.get(ant.id) ?? [];
      history.push({ x: ant.x, y: ant.y, vx: ant.vx, vy: ant.vy });
      if (history.length > window + 1) history.shift();
      histories.set(ant.id, history);
    }
    if (tick % sampleEvery !== 0) continue;
    const stuck = [0, 0], shaking = [0, 0], wetRally = [0, 0];
    for (const ant of state.ants) {
      const intent = (ant as IntentAnt).houseIntentHold?.intent;
      if (ant.role !== "fighter" || intent?.kind !== "rally" ||
        !isBlockedTile(state.terrain, Math.floor(intent.x / SUB), Math.floor(intent.y / SUB))) continue;
      const colony: ColonyId = ant.colony;
      wetRally[colony]++;
      const history = histories.get(ant.id)!;
      if (history.length !== window + 1) continue;
      const first = history[0]!;
      if (Math.hypot(ant.x - first.x, ant.y - first.y) > 0.5 * SUB * scale) continue;
      stuck[colony]++;
      let reversals = 0;
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1]!, b = history[i]!;
        if (a.vx * b.vx + a.vy * b.vy < 0) reversals++;
      }
      if (reversals >= 10) shaking[colony]++;
    }
    for (const colony of [0, 1]) {
      peakStuck[colony] = Math.max(peakStuck[colony]!, stuck[colony]!);
      peakShaking[colony] = Math.max(peakShaking[colony]!, shaking[colony]!);
    }
    samples.push({ tick, wetRally, stuck, shaking });
  }
  return { mapId, seed: 6006, ticks: state.tick, gridScale: scale, agents: state.agents.length,
    peakStuck, peakShaking, samples };
}

const { values } = parseArgs({ options: { head: { type: "string" }, "expect-zero": { type: "boolean" } } });
assert.ok(values.head, "--head identifies the tested source commit or combined tree");
for (const mapId of ["central-lake", "three-crossings"]) {
  const result = await measure(mapId);
  console.log(JSON.stringify({ head: values.head, ...result }));
  if (values["expect-zero"]) assert.deepEqual(result.peakShaking, [0, 0], `${mapId}: shaking fighters remain`);
}
