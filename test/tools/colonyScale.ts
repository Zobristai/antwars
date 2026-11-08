/// <reference types="node" />
/** Private in-process house match and peak-load evidence. No URL or listener.
 * node --import ./src/ts-resolve.mjs test/tools/colonyScale.ts --head <commit>
 * Outputs out/colony-scale/report.json and short recordings for the capture command.
 * --head is a label supplied by the operator, not a Git observation.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeMessage } from "../../src/live/format.js";
import { SpectatorRecorder } from "../../src/live/model.js";
import { packMessages } from "../../src/live/snapshot.js";
import { Game } from "../../src/mcp/game.js";
import { registerTools } from "../../src/mcp/tools.js";
import { COLONY_NAMES, PUBLIC_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { withGridScale } from "../../src/sim/gridScale.js";
import { parseHatchArm, selectHatchArm } from "./hatchVariants.js";
import { groundIncome } from "../../src/sim/forage.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { SimState, WinReason } from "../../src/sim/types.js";

export const BASELINE_HEAD = "271809a567bf2896de04baa29bba55658e9af536";
/** Today's public economy, pinned before the colony-scale change, as a reference-grid template. Other rules are unchanged here. */
export const BASELINE_CONFIG: SimConfig = {
  ...PUBLIC_CONFIG,
  foodLayout: undefined,
  matchTicks: 12 * 60 * 10,
  colonyCap: 150,
  hatchCost: 3,
  hatchIntervalTicks: 18,
  foodRegrowTicks: 150,
  groundFoodIntervalTicks: undefined,
  foodPatches: [
    { tileX: 12, tileY: 24, radius: 2, perTile: 2 },
    { tileX: 18, tileY: 9, radius: 2, perTile: 3 },
    { tileX: 18, tileY: 39, radius: 2, perTile: 3 },
    { tileX: 30, tileY: 24, radius: 3, perTile: 8 },
  ],
  overrunGraceTicks: 600,
  overrunTicks: 100,
  guardCount: 2,
  guardSharePermille: undefined,
  guardEngageTiles: 3,
  ...(PUBLIC_CONFIG.castes === undefined ? {} : { castes: { ...PUBLIC_CONFIG.castes, soldierCost: 6 } }),
};

export function counts(state: SimState): [number, number] {
  const result: [number, number] = [0, 0];
  for (const ant of state.ants) result[ant.colony] += 1;
  return result;
}

export function timing(samples: readonly number[]) {
  if (samples.length === 0) throw new Error("no timing samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    meanMs: samples.reduce((sum, ms) => sum + ms, 0) / samples.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    medianMs: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    maxMs: sorted.at(-1)!,
  };
}

export const DURATION_SEEDS = [6006, 6007, 10, 11] as const;

/** Duration acceptance is a property of the complete fixed-seed set, not one run. */
export function durationChecks(runs: readonly { seed: number; endTick: number; reason: WinReason | null }[], config: SimConfig) {
  const sorted = runs.map((run) => run.endTick).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianEndTick = sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    medianEndTick,
    checks: {
      completeSeedSet: runs.length === DURATION_SEEDS.length && DURATION_SEEDS.every((seed) => runs.filter((run) => run.seed === seed).length === 1),
      noneBeforeTwelveMinutes: runs.length > 0 && runs.every((run) => run.endTick >= 12 * 60 * config.ticksPerSecond),
      medianAtLeastTwentyMinutes: medianEndTick !== null && medianEndTick >= 20 * 60 * config.ticksPerSecond,
      includesTimeUp: runs.some((run) => run.reason === "time_up" && run.endTick === config.matchTicks),
    },
  };
}

/** No agents: both colonies use the house bot, with the supplied config. */
export function houseMatch(seed: number, config: SimConfig) {
  const initial = createMatch(seed, config);
  let state = initial;
  let peak = initial;
  const peaks = counts(initial);
  const peakTicks: [number, number] = [0, 0];
  const samples: number[] = [];
  const ground: [number, number] = [0, 0];
  const spent: [number, number] = [0, 0];
  const foundingSpent: [number, number] = [0, 0];
  while (state.result === null) {
    const tick = state.tick;
    const before = performance.now();
    const out = step(state);
    state = out.state;
    samples.push(performance.now() - before);
    const award = groundIncome(state, tick);
    for (const colony of [0, 1] as const) ground[colony] += award[colony];
    for (const event of out.events) {
      if (event.type === "hatch") spent[event.colony] += event.caste === "soldier" ? config.castes!.soldierCost : config.hatchCost;
      if (event.type === "queen_founded") foundingSpent[event.colony] += event.foodCost ?? config.queenFounding!.cost;
    }
    const live = counts(state);
    for (const colony of [0, 1] as const) {
      if (live[colony] > peaks[colony]) {
        peaks[colony] = live[colony];
        peakTicks[colony] = state.tick;
      }
    }
    // Keep the first maximum, while it is still a playable state.
    if (state.result === null && live[0] + live[1] > peak.ants.length) peak = state;
  }
  const income = state.colonies.map((colony) => {
    const forage = state.stats.delivered[colony.id];
    const fromGround = ground[colony.id];
    const total = forage + fromGround;
    return { colony: colony.id, ground: fromGround, foraging: forage, total,
      groundShare: total === 0 ? 0 : fromGround / total,
      hatchSpending: spent[colony.id], queenFoundingSpending: foundingSpent[colony.id], finalStore: colony.foodStore,
      reconciled: total === spent[colony.id] + foundingSpent[colony.id] + colony.foodStore,
    };
  });
  return { initial, final: state, peak, peaks, peakTicks, income, allTicks: timing(samples) };
}

/** Repeat the exact same real peak input; step clones it internally as in a live tick. */
export function peakTiming(peak: SimState) {
  for (let i = 0; i < 20; i++) step(peak);
  const samples = Array.from({ length: 200 }, () => {
    const start = performance.now();
    step(peak);
    return performance.now() - start;
  });
  const stats = timing(samples);
  return { ...stats, budgetMs: 100, maxHeadroomMs: 100 - stats.maxMs, rawMs: samples };
}

/** Real tool serialization over linked in-memory MCP transports, not a copied view shape.
 * A fresh six-ant squad drafts near its nest at the real match peak, then observes
 * once with and without map. No long-idle event backlog is claimed by this sample.
 */
export async function observeBytes(peak: SimState, colony: 0 | 1) {
  let scheduled = false;
  let now = 0;
  const game: Game = new Game({
    simConfig: peak.config,
    now: () => now,
    onInputQueued: () => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => { scheduled = false; game.tick(); });
    },
  });
  game.startMatch(peak.seed, { state: structuredClone(peak) });
  const server = new McpServer({ name: "private-colony-scale", version: "1" });
  registerTools(server, game, { agentId: null });
  const client = new Client({ name: "private-colony-scale", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const joined = await client.callTool({ name: "join", arguments: { colony: COLONY_NAMES[colony] } });
    if (joined.isError) throw new Error(`private join failed: ${JSON.stringify(joined)}`);
    const results = [];
    for (const map of [false, true]) {
      // Advance the private adapter's wall clock, not the simulation or a real timer.
      now += 1000;
      const reply = await client.callTool({ name: "observe", arguments: { map } });
      if (reply.isError) throw new Error(`private observe failed: ${JSON.stringify(reply)}`);
      const content = reply.content as { type: string; text?: string }[];
      const data = reply.structuredContent;
      const view = typeof data === "object" && data !== null && "view" in data ? data.view : undefined;
      const territory = typeof view === "object" && view !== null && "territory" in view ? view.territory : undefined;
      const mapRows = typeof territory === "object" && territory !== null && "height" in territory ? territory.height : 0;
      results.push({
        map,
        mapRows,
        tick: game.match!.state.tick,
        textUtf8Bytes: content.reduce((n, c) => n + Buffer.byteLength(c.text ?? ""), 0),
        toolResultUtf8Bytes: Buffer.byteLength(JSON.stringify(reply)),
      });
    }
    return { colony, method: "fresh nest-drafted squad; real MCP observe; text and complete tool result measured separately", results };
  } finally {
    await client.close();
    await server.close();
  }
}

/** A short real continuation, not 30 minutes of stored video. All messages retain their real ticks. */
function recording(state: SimState, path: string, ticks: number): void {
  let current = state;
  const recorder = new SpectatorRecorder(current);
  const messages = [encodeMessage({ ...recorder.initial(), full: recorder.initialFull() })];
  for (let i = 0; i < ticks && current.result === null; i++) {
    const out = step(current);
    current = out.state;
    const record = recorder.record(out);
    messages.push(encodeMessage({ tick: record.tick, ants: record.ants, full: null, events: record.events }));
  }
  writeFileSync(path, packMessages(messages));
}

async function main() {
  const { values } = parseArgs({ options: {
    head: { type: "string" },
    seeds: { type: "string", default: "6006,6007,10,11" },
    out: { type: "string", default: "out/colony-scale" },
    "hatch-arm": { type: "string", default: "A" },
  } });
  if (!values.head || !/^[a-f0-9]{40}$/.test(values.head)) throw new Error("--head requires the full committed SHA");
  const hatchArm = parseHatchArm(values["hatch-arm"]);
  const candidateConfig = withGridScale(selectHatchArm(rulesConfig("redesign"), hatchArm));
  const seeds = values.seeds.split(",").map(Number);
  if (seeds.length === 0 || seeds.length > 8 || new Set(seeds).size !== seeds.length || seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)) throw new Error("--seeds requires 1–8 distinct uint32 integers");
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  mkdirSync("out/recordings", { recursive: true });
  const describe = async (run: ReturnType<typeof houseMatch>) => ({
    config: run.initial.config,
    endTick: run.final.tick,
    minutes: run.final.tick / run.final.config.ticksPerSecond / 60,
    result: run.final.result,
    peaks: run.peaks,
    peakTicks: run.peakTicks,
    income: run.income,
    totalPeak: { tick: run.peak.tick, counts: counts(run.peak) },
    delivered: run.final.stats.delivered,
    hatched: run.final.stats.hatched,
    allTicks: run.allTicks,
    peakTiming: peakTiming(run.peak),
    observe: [await observeBytes(run.peak, 0), await observeBytes(run.peak, 1)],
  });
  const runs = [];
  let selected: ReturnType<typeof houseMatch> | undefined;
  for (const seed of seeds) {
    const baseline = houseMatch(seed, withGridScale(BASELINE_CONFIG));
    const candidate = houseMatch(seed, candidateConfig);
    const disabled = houseMatch(seed, { ...candidateConfig, groundFoodIntervalTicks: undefined });
    const before = await describe(baseline);
    const after = await describe(candidate);
    const checks = {
      duration: candidate.final.tick >= 12 * 60 * PUBLIC_CONFIG.ticksPerSecond,
      cap: candidate.peaks.every((n) => n <= 512),
      tickBudget: after.peakTiming.maxMs < 100,
      incomeReconciles: candidate.income.every((c) => c.reconciled) && disabled.income.every((c) => c.reconciled),
    };
    runs.push({ seed, checks, baseline: before, candidate: after,
      groundDisabled: { peaks: disabled.peaks, income: disabled.income, endTick: disabled.final.tick, result: disabled.final.result },
    });
    if (selected === undefined || candidate.peak.ants.length > selected.peak.ants.length) selected = candidate;
  }
  const selectedRun = runs.find((run) => run.seed === selected!.initial.seed)!;
  const duration = durationChecks(runs.map((run) => ({ seed: run.seed, endTick: run.candidate.endTick, reason: run.candidate.result?.reason ?? null })), candidateConfig);
  const exitCode = Object.values(duration.checks).every(Boolean) && runs.every((run) => Object.values(run.checks).every(Boolean)) ? 0 : 1;
  const sourceFiles = ["src/sim/config.ts", "src/sim/forage.ts", "src/sim/step.ts", "src/sim/houseBot.ts", "src/sim/view.ts", "src/mcp/tools.ts", "test/tools/colonyScale.ts", "test/tools/hatchVariants.ts"];
  const sources = Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  recording(selected!.initial, "out/recordings/colony-start.bin", 10);
  recording(selected!.peak, "out/recordings/colony-peak.bin", 100);
  const recordings = Object.fromEntries(["colony-start", "colony-peak"].map((name) => [name, createHash("sha256").update(readFileSync(`out/recordings/${name}.bin`)).digest("hex")]));
  const interval = PUBLIC_CONFIG.groundFoodIntervalTicks!;
  const report = { exitCode, declaredHead: values.head, hatchArm, baselineHead: BASELINE_HEAD,
    seed: selectedRun.seed, seeds, privateInProcess: true, sources, recordings, duration,
    groundRate: { foodPerTilePerPayout: 1, intervalTicks: interval, intervalSeconds: interval / PUBLIC_CONFIG.ticksPerSecond, foodPerTilePerSecond: PUBLIC_CONFIG.ticksPerSecond / interval },
    earliestEndTick: Math.min(...runs.map((run) => run.candidate.endTick)),
    peakBenchmark: { seed: selectedRun.seed, ...selectedRun.candidate.totalPeak, ...selectedRun.candidate.peakTiming },
    baseline: selectedRun.baseline, candidate: selectedRun.candidate, runs,
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Exit code ${exitCode}`);
  console.log(JSON.stringify(report));
  process.exitCode = exitCode;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error("Exit code 1");
  console.error(error);
  process.exitCode = 1;
});
