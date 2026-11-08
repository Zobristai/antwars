// One injected loop agent for store-concurrency.test.ts: it uses the shared store exactly as a
// tuning agent does, with measurement and the keep decision injected (no simulation runs).
//
//   node --import ./src/ts-resolve.mjs test/tuning/store-worker.ts \
//     --store <dir> --agent <id> --lane <lane> --agents <count> --tries <count>
//
// It binds to its lane, races for the shared checkpoint, arrives for the noise check (the first
// four arrivals write runs and settle the verdict), waits for the verdict, then makes its tries:
// each reads its lane's shared baseline, takes an injected time relative to it, and keeps
// (advancing the lane by compare-and-swap, re-trying on the new version when stale) or drops.
// It prints one JSON summary line.

import { setTimeout as sleep } from "node:timers/promises";
import { median } from "../../src/tickStats.ts";
import type { LaneId } from "./lanes.ts";
import { openStore, type NoiseVerdict } from "./store.ts";

export const CHECKPOINT = "wide-plain-768";
export const BASE_COMMIT = "injected-base";
export const NOISE_LIMIT = 0.1;

export interface WorkerSummary {
  readonly agentId: string;
  readonly lane: LaneId;
  readonly position: number;
  readonly checkpointStored: boolean;
  readonly checkpoint: string | null;
  readonly verdict: NoiseVerdict;
  readonly tries: number;
  readonly keeps: number;
  readonly stale: number;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

/** Deterministic value in [0, 1) for a key (FNV-1a). */
function unit(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return hash / 2 ** 32;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function main(args: readonly string[]): Promise<WorkerSummary> {
  const store = openStore(option(args, "store"));
  const agentId = option(args, "agent");
  const agents = Number(option(args, "agents"));
  const tries = Number(option(args, "tries"));
  const lane = store.bindAgent(agentId, option(args, "lane") as LaneId);

  const checkpointStored = store.putCheckpoint(CHECKPOINT, `checkpoint stored by ${agentId}`);
  const checkpoint = store.checkpoint(CHECKPOINT);

  const position = store.arriveForNoise(agentId);
  await until(() => store.noiseArrivals().length >= agents, "every agent to arrive");
  if (position <= 4) {
    // Injected noise-check run: the unchanged loop's median, within 2% of 100 ms.
    store.writeNoiseRun(agentId, 100 * (0.99 + 0.02 * unit(`noise:${agentId}`)));
    await until(() => store.noiseRuns().length >= 4, "four noise runs");
    const runs = store.noiseRuns();
    const times = runs.map((run) => run.medianTickMs).sort((a, b) => a - b);
    const spread = (times.at(-1)! - times[0]!) / median(times);
    store.settleNoise({ runs, spread, limit: NOISE_LIMIT, pass: spread <= NOISE_LIMIT, at: new Date().toISOString() }, BASE_COMMIT);
  }
  await until(() => store.noise() !== null, "the noise verdict");
  const verdict = store.noise()!;
  if (!verdict.pass) throw new Error(`noise check failed: ${JSON.stringify(verdict)}`);

  let keeps = 0;
  let stale = 0;
  for (let index = 0; index < tries; index++) {
    for (let attempt = 0; ; attempt++) {
      const base = store.baseline(lane.id)!;
      // Injected measurement: 15% faster to 5% slower than the lane's shared baseline, never re-timing it.
      const relative = 0.85 + 0.2 * unit(`${agentId}:${index}:${attempt}`);
      const medianTickMs = base.medianTickMs * relative;
      const common = {
        agentId, lane: lane.id, baselineVersion: base.version, medianTickMs, baselineMedianTickMs: base.medianTickMs,
        relative, noise: verdict.spread,
      };
      if (1 - relative <= verdict.spread) {
        store.recordTry({ ...common, decision: "drop", reasons: ["injected: gain within the noise"], at: new Date().toISOString() });
        break;
      }
      const patch = `edit by ${agentId}, try ${index}, attempt ${attempt}`;
      const kept = store.advanceLane(lane.id, base.version, { patch, medianTickMs, agentId });
      if (kept === "stale") {
        stale++;
        continue; // re-applied and re-tried against the lane's new version
      }
      store.recordTry({ ...common, decision: "keep", reasons: [], patch, at: kept.at });
      keeps++;
      break;
    }
  }
  return { agentId, lane: lane.id, position, checkpointStored, checkpoint, verdict, tries, keeps, stale };
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
