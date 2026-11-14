// One tuning-harness job in a fresh process, on one materialised source tree. Run by harness.ts, never by hand:
//   node --max-semi-space-size=8 --import <tree>/src/ts-resolve.mjs scripts/tuning/worker.ts '<job JSON>'
// The tree's own simulation modules are imported, so each tree runs its own code. Prints one JSON line.
//
// Every job plays production's tick: the configuration the game server builds for an ordinary scheduled match
// (comparisonOptions with no comparison variables set), createMatch(seed, config) as Game.startMatch does, then
// advance(state, inputs, …, houseActive = true) per tick as Game.tick does. No agent is seated and no input is sent.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { GCProfiler } from "node:v8";
import { tickSummary } from "./stats.ts";

export interface WorkerJob {
  readonly tree: string;
  readonly mode: "workload" | "time" | "exact";
  readonly seedsPerMap?: number;
  readonly map?: string;
  readonly seed?: number;
  /** Tick path: advance (the live server's) or step (replay verification's). */
  readonly path?: "advance" | "step";
  /** Start from this saved state instead of tick 0 (time mode). */
  readonly checkpoint?: string;
  /** Stop after this many ticks; absent: play until the match ends by its own rule. */
  readonly ticks?: number;
  /** Exact mode: save the state after these ticks into checkpointDir. */
  readonly checkpointsAt?: readonly number[];
  readonly checkpointDir?: string;
  /** Time mode: these segments in order, in this one process (else the single map/seed/checkpoint/ticks above). */
  readonly segments?: readonly { readonly map?: string; readonly seed?: number; readonly checkpoint?: string; readonly ticks?: number }[];
  /** Time mode: CPU-profile the ticks only (not start-up) and write the V8 profile here. */
  readonly profileOut?: string;
  /** Exact mode: write the per-tick digests here. */
  readonly out?: string;
}

const job = JSON.parse(process.argv[2]!) as WorkerJob;
const src = (file: string) => import(join(job.tree, "src", file));
const [Server, Map_, Step, Terrain] = await Promise.all([src("server.ts"), src("sim/map.ts"), src("sim/step.ts"), src("sim/terrain.ts")]);
// The live config exactly as the server builds it; McpConfig is not read when no comparison variable is set.
const liveConfig = Server.comparisonOptions({}, {}).simConfig;

/** What this process actually loaded: rules, the no-bot-moves flag, map, seats and population. */
function loaded(state: any, seed: number) {
  const c = state.config;
  return { rules: c.rules ?? "public", noBotMovesFlag: c.localAnts?.everyColony === true, map: state.terrain?.mapId ?? null, seed,
    colonies: state.colonies.length, playersSetting: c.players ?? null, seatedAgents: state.agents.length,
    population: { startAntsPerColony: c.startAnts, colonyCap: c.colonyCap, antsAtStart: state.ants.length },
    matchTicks: c.matchTicks, tick: state.tick, node: process.version };
}

function tick(state: any): any {
  return job.path === "step" ? Step.step(state, [], undefined, undefined, undefined, false, true) : Step.advance(state, [], undefined, undefined, undefined, false, true);
}

function start(): any {
  return job.checkpoint !== undefined ? JSON.parse(readFileSync(job.checkpoint, "utf8")) : Map_.createMatch(job.seed!, liveConfig);
}

if (job.mode === "workload") {
  // Every map the live rotation can draw, with the first seedsPerMap seeds that draw it and its share of matches.
  const maps: string[] = liveConfig.terrain.maps.map((m: { id: string }) => m.id), per = job.seedsPerMap ?? 2;
  const seeds = new Map<string, number[]>(maps.map(m => [m, []]));
  for (let seed = 0; seed < 1_000_000 && [...seeds.values()].some(s => s.length < per); seed++) {
    const list = seeds.get(Terrain.selectMap(seed, liveConfig.terrain).id)!;
    if (list.length < per) list.push(seed);
  }
  const scenarios = maps.filter((m, i) => maps.indexOf(m) === i).flatMap(map => seeds.get(map)!.map(seed => {
    const state = Map_.createMatch(seed, liveConfig);
    return { id: `${map}-${seed}`, map, seed, weight: maps.filter(m => m === map).length / maps.length / per, loaded: loaded(state, seed) };
  }));
  console.log(JSON.stringify({ source: "server default config (comparisonOptions, no comparison variables)", seedsPerMap: per, scenarios }));
} else if (job.mode === "time") {
  // One process times every segment in order (all of one side's round), so start-up is paid once per side per round.
  const segments = job.segments ?? [{ map: job.map, seed: job.seed, checkpoint: job.checkpoint, ticks: job.ticks }];
  const session = job.profileOut === undefined ? null : new Session();
  if (session !== null) { session.connect(); await session.post("Profiler.enable"); }
  const runs = [];
  for (const seg of segments) {
    let state = seg.checkpoint !== undefined ? JSON.parse(readFileSync(seg.checkpoint, "utf8")) : Map_.createMatch(seg.seed!, liveConfig);
    const before = loaded(state, seg.seed ?? -1), tickMs: number[] = [];
    if (session !== null) await session.post("Profiler.start");
    const profiler = new GCProfiler();
    profiler.start();
    let peak = state.ants.length;
    while (state.result === null && (seg.ticks === undefined || tickMs.length < seg.ticks)) {
      const t = performance.now();
      state = tick(state).state;
      tickMs.push(performance.now() - t);
      if (state.ants.length > peak) peak = state.ants.length;
    }
    const gc = (profiler.stop()?.statistics ?? []).map(e => e.cost / 1000);
    if (session !== null) { const { profile } = await session.post("Profiler.stop"); writeFileSync(job.profileOut!, JSON.stringify(profile)); }
    const totalMs = tickMs.reduce((a, b) => a + b, 0);
    runs.push({ loaded: before, path: job.path ?? "advance", ticks: tickMs.length, endTick: state.tick, result: state.result?.reason ?? null,
      peakAnts: peak, totalMs, meanMs: totalMs / Math.max(1, tickMs.length), tick: tickMs.length > 0 ? tickSummary(tickMs) : null,
      gc: { count: gc.length, totalMs: gc.reduce((a, b) => a + b, 0), maxMs: gc.length > 0 ? Math.max(...gc) : 0 } });
  }
  session?.disconnect();
  console.log(JSON.stringify(job.segments === undefined ? runs[0] : { runs }));
} else {
  // Exactness: a chained SHA-256 per stream — full state, events, results, and the recorded/sent spectator
  // message bytes — compared byte for byte; nothing is normalised.
  const [Model, Format] = await Promise.all([src("live/model.ts"), src("live/format.ts")]);
  let state = start();
  const before = loaded(state, job.seed!);
  const recorder = new Model.SpectatorRecorder(state);
  const chain: Record<string, Buffer> = {}, perTick: Record<string, string[]> = { state: [], events: [], results: [], recorded: [] };
  const link = (stream: string, data: string | Uint8Array) => {
    const h = createHash("sha256");
    if (chain[stream] !== undefined) h.update(chain[stream]!);
    chain[stream] = h.update(data).digest();
  };
  link("state", JSON.stringify(state));
  link("recorded", Format.encodeMessage({ ...recorder.initial(), full: recorder.initialFull() }));
  link("events", ""); link("results", "");
  const at = new Set(job.checkpointsAt ?? []);
  if (at.size > 0) mkdirSync(job.checkpointDir!, { recursive: true });
  let ticks = 0;
  while (state.result === null && (job.ticks === undefined || ticks < job.ticks)) {
    const out = tick(state);
    state = out.state; ticks++;
    link("state", JSON.stringify(out.state));
    link("events", JSON.stringify(out.events));
    link("results", JSON.stringify(out.results));
    const rec = recorder.record(out);
    link("recorded", Format.encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: rec.events }));
    for (const s of Object.keys(perTick)) perTick[s]!.push(chain[s]!.toString("hex", 0, 8));
    if (at.has(state.tick)) writeFileSync(join(job.checkpointDir!, `${state.tick}.json`), JSON.stringify(state));
  }
  const final = Object.fromEntries(Object.keys(perTick).map(s => [s, chain[s]!.toString("hex")]));
  if (job.out !== undefined) writeFileSync(job.out, JSON.stringify({ loaded: before, path: job.path ?? "advance", ticks, endTick: state.tick, result: state.result?.reason ?? null, final, perTick }));
  console.log(JSON.stringify({ loaded: before, path: job.path ?? "advance", ticks, endTick: state.tick, result: state.result?.reason ?? null, final }));
}
