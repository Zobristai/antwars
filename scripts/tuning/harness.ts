// Simulator tuning harness. Run from the repository root (see docs/tuning-harness.md):
//   npm run tune -- <command> [options]        (or: node --import ./src/ts-resolve.mjs scripts/tuning/harness.ts …)
// Commands: regen, exact, time, noise, profile, test. Every command reads and writes the shared store given by
// --store <dir> or the ANTWARS_TUNING_STORE environment variable; nothing is written inside the checkout.
// Commits are any commit-ish of this checkout; --patch / --reference-patch apply a patch file on top, only when its
// SHA-256 equals --patch-sha256 / --reference-patch-sha256. Each tree runs from a private copy that is removed on exit.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { functionTimes, type CpuProfile } from "./profile.ts";
import { median, noiseBar, repetitionsFor, roundGain, sideOrder, type PairedSegment } from "./stats.ts";
import { materialise, resolveCommit, type PatchInput, type Tree } from "./trees.ts";
import type { WorkerJob } from "./worker.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const WORKER = join(ROOT, "scripts", "tuning", "worker.ts");
/** The scoped simulator tests: simulation goldens, advance/step agreement, grid, combat, and every replay/recording test. */
export const SCOPED_TESTS = ["test/sim/golden.test.ts", "test/sim/advance.test.ts", "test/sim/grid-tracker.test.ts", "test/sim/combat.test.ts",
  "test/replays/recording-goldens.test.ts", "test/replays/recording.test.ts", "test/replays/pre-compression-replays.test.ts",
  "test/replays/corrected-recordings.test.ts", "test/replays/recordings-across-change.test.ts"];
export const DEFAULT_ROUNDS = 8;
/** Saved states per scenario that regen writes by default: at 0, ¼, ½ and ¾ of each full match. */
export const DEFAULT_CHECKPOINTS = 4;
/** Ticks timed from each saved state by default. */
export const DEFAULT_WINDOW = 200;

const { positionals, values: o } = parseArgs({ allowPositionals: true, options: {
  store: { type: "string" }, commit: { type: "string" }, patch: { type: "string" }, reference: { type: "string" }, "reference-patch": { type: "string" },
  "patch-sha256": { type: "string" }, "reference-patch-sha256": { type: "string" },
  candidate: { type: "string" }, base: { type: "string" }, rounds: { type: "string" }, window: { type: "string" }, scenarios: { type: "string" },
  "seeds-per-map": { type: "string" }, paths: { type: "string" }, checkpoints: { type: "string" }, jobs: { type: "string" }, ticks: { type: "string" },
  session: { type: "string" }, participant: { type: "string" }, expect: { type: "string" }, wait: { type: "string" }, "finish-wait": { type: "string" },
  local: { type: "string" }, whole: { type: "boolean" }, scenario: { type: "string" }, at: { type: "string" }, top: { type: "string" },
} });
const command = positionals[0];
const storeArg = o.store ?? process.env.ANTWARS_TUNING_STORE;
if (storeArg === undefined) throw new Error("give the shared store with --store <dir> or ANTWARS_TUNING_STORE");
const STORE = resolve(storeArg);
mkdirSync(STORE, { recursive: true });
const int = (v: string | undefined, fallback: number, name: string): number => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
};
const required = (v: string | undefined, name: string): string => { if (v === undefined) throw new Error(`--${name} is required`); return v; };
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const host = () => ({ hostname: hostname(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, loadavg: loadavg() });

// ---- workload ----------------------------------------------------------------------------------------------------
interface Scenario { readonly id: string; readonly map: string; readonly seed: number; readonly weight: number; readonly loaded: Record<string, unknown> }
interface Workload {
  readonly commit: string; readonly source: string; readonly seedsPerMap: number; readonly horizon: string; readonly paths: readonly ("advance" | "step")[];
  readonly scenarios: readonly Scenario[]; readonly checkpoints: Record<string, readonly number[]>;
}
const workloadFile = (commit: string) => join(STORE, "workloads", `${commit}.json`);
function loadWorkload(commit: string): Workload {
  const file = workloadFile(commit);
  if (!existsSync(file)) throw new Error(`no workload for ${commit}: run regen --commit ${commit} first`);
  return JSON.parse(readFileSync(file, "utf8")) as Workload;
}
function selectScenarios(w: Workload): readonly Scenario[] {
  if (o.scenarios === undefined) return w.scenarios;
  const ids = o.scenarios.split(","), chosen = w.scenarios.filter(s => ids.includes(s.id));
  if (chosen.length !== ids.length) throw new Error(`unknown scenario in --scenarios; known: ${w.scenarios.map(s => s.id).join(", ")}`);
  return chosen;
}

// ---- worker processes -------------------------------------------------------------------------------------------
/** The node flags production starts the game server with (the tree's npm start), so timing sees the same heap settings. */
function productionFlags(tree: Tree): string[] {
  const pkg = JSON.parse(readFileSync(join(tree.dir, "package.json"), "utf8")) as { scripts?: { start?: string } };
  return (pkg.scripts?.start ?? "").split(" ").filter(a => a.startsWith("--max-"));
}
function workerArgs(tree: Tree, job: Omit<WorkerJob, "tree">): string[] {
  return [...productionFlags(tree), "--import", join(tree.dir, "src", "ts-resolve.mjs"), WORKER, JSON.stringify({ ...job, tree: tree.dir })];
}
function parseLast(stdout: string, what: string): any {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line === "") throw new Error(`${what} printed nothing`);
  return JSON.parse(line);
}
function runWorker(tree: Tree, job: Omit<WorkerJob, "tree">): any {
  const r = spawnSync(process.execPath, workerArgs(tree, job), { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, NODE_OPTIONS: "" } });
  if (r.status !== 0) throw new Error(`worker failed (${tree.key}, ${JSON.stringify(job)}): ${r.stderr.slice(-2000)}`);
  return parseLast(r.stdout, "worker");
}
function runWorkerAsync(tree: Tree, job: Omit<WorkerJob, "tree">): Promise<any> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, workerArgs(tree, job), { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: "" } });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => { if (code === 0) { try { done(parseLast(out, "worker")); } catch (e) { fail(e); } } else fail(new Error(`worker failed (${tree.key}): ${err.slice(-2000)}`)); });
  });
}
async function pool<T>(jobs: readonly (() => Promise<T>)[], width: number): Promise<T[]> {
  const results: T[] = Array.from({ length: jobs.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, jobs.length)) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await jobs[i]!(); }
  }));
  return results;
}
const defaultJobs = () => int(o.jobs, Math.max(1, cpus().length - 1), "jobs");
function patchInput(path: string | undefined, digest: string | undefined, flag: string): PatchInput | undefined {
  if (path === undefined) { if (digest !== undefined) throw new Error(`--${flag}-sha256 needs --${flag}`); return undefined; }
  return { path, sha256: required(digest, `${flag}-sha256`) };
}
const tree = (ref: string, patch?: PatchInput) => materialise(ROOT, ref, patch);
const candidatePatch = () => patchInput(o.patch, o["patch-sha256"], "patch");
const referencePatch = () => patchInput(o["reference-patch"], o["reference-patch-sha256"], "reference-patch");

// ---- exactness --------------------------------------------------------------------------------------------------
const STREAMS = ["state", "events", "results", "recorded"] as const;
function referenceFile(t: Tree, path: string, scenario: string, ticks?: number) {
  return join(STORE, "references", t.key, ticks === undefined ? "full" : `ticks-${ticks}`, path, `${scenario}.json`);
}
/** Digests for every scenario and path of a tree, reusing any already in the store (keyed by commit and patch digest). */
async function digests(t: Tree, w: Workload, scenarios: readonly Scenario[], paths: readonly string[], ticks: number | undefined, checkpoints = false): Promise<void> {
  // Longest matches first, so the parallel runs finish together.
  const longestFirst = [...scenarios].sort((a, b) => (b.loaded.matchTicks as number) - (a.loaded.matchTicks as number));
  const jobs = longestFirst.flatMap(s => paths.map(path => async () => {
    const out = referenceFile(t, path, s.id, ticks);
    if (existsSync(out)) return;
    mkdirSync(join(out, ".."), { recursive: true });
    const at = checkpoints && path === "advance" ? (w.checkpoints[s.id] ?? []).filter(x => x > 0) : [];
    const scratch = `${out}.${randomUUID()}`;
    await runWorkerAsync(t, { mode: "exact", map: s.map, seed: s.seed, path: path as "advance" | "step", ticks, out: scratch,
      checkpointsAt: at, checkpointDir: join(STORE, "checkpoints", t.commit, s.id) });
    renameSync(scratch, out);
  }));
  await pool(jobs, defaultJobs());
}
function compareDigests(ref: any, cand: any): { readonly match: boolean; readonly firstDifference: { readonly tick: number; readonly streams: string[] } | null } {
  const same = STREAMS.every(s => ref.final[s] === cand.final[s]) && ref.ticks === cand.ticks && ref.endTick === cand.endTick && ref.result === cand.result;
  if (same) return { match: true, firstDifference: null };
  const n = Math.max(ref.ticks, cand.ticks);
  for (let i = 0; i < n; i++) {
    const streams = STREAMS.filter(s => ref.perTick[s][i] !== cand.perTick[s][i]);
    if (streams.length > 0) return { match: false, firstDifference: { tick: (ref.loaded.tick as number) + i + 1, streams } };
  }
  return { match: false, firstDifference: { tick: Math.min(ref.endTick, cand.endTick), streams: ["result"] } };
}

// ---- paired timing ------------------------------------------------------------------------------------------------
interface Segment { readonly scenario: Scenario; readonly weight: number; readonly checkpoint?: string; readonly startTick: number; readonly ticks?: number }
function segments(w: Workload, scenarios: readonly Scenario[], window: number | undefined, cap: number | undefined): Segment[] {
  if (window === undefined) return scenarios.map(s => ({ scenario: s, weight: s.weight, startTick: 0, ticks: cap }));
  return scenarios.flatMap(s => {
    const at = w.checkpoints[s.id];
    if (at === undefined || at.length === 0) throw new Error(`--window needs checkpoints: run regen --commit ${w.commit} --checkpoints <k>`);
    return at.map(tick => ({ scenario: s, weight: s.weight / at.length, startTick: tick, ticks: window,
      ...(tick === 0 ? {} : { checkpoint: join(STORE, "checkpoints", w.commit, s.id, `${tick}.json`) }) }));
  });
}
interface PairedTiming {
  readonly rounds: number; readonly segments: number; readonly window: number | null; readonly roundGains: readonly number[]; readonly medianPairedGain: number;
  readonly perSegment: Record<string, { reference: unknown; candidate: unknown }>; readonly slowSegments: readonly unknown[]; readonly loaded: Record<string, unknown>; readonly wallMs: number;
}
function pairedTiming(reference: Tree, candidate: Tree, w: Workload, rounds: number, window: number | undefined, label: string): PairedTiming {
  const segs = segments(w, selectScenarios(w), window, tickCap()), t0 = Date.now();
  const gains: number[] = [], loaded: Record<string, unknown> = {};
  const runs: Record<string, { reference: any[]; candidate: any[] }> = {};
  for (let r = 0; r < rounds; r++) {
    const paired: PairedSegment[] = [];
    // Each side's whole round runs in one fresh process; the side that goes first alternates by round.
    const means = { reference: [] as number[], candidate: [] as number[] };
    for (const side of sideOrder(r)) {
      const t = side === "reference" ? reference : candidate;
      const out = runWorker(t, { mode: "time", segments: segs.map(seg => ({ map: seg.scenario.map, seed: seg.scenario.seed, checkpoint: seg.checkpoint, ticks: seg.ticks })) });
      (out.runs as any[]).forEach((run, i) => {
        const seg = segs[i]!;
        means[side][i] = run.meanMs;
        loaded[`${seg.scenario.id}@${seg.startTick}`] = run.loaded;
        (runs[`${seg.scenario.id}@${seg.startTick}`] ??= { reference: [], candidate: [] })[side].push(run);
      });
    }
    segs.forEach((seg, i) => paired.push({ weight: seg.weight, referenceMeanMs: means.reference[i]!, candidateMeanMs: means.candidate[i]! }));
    gains.push(roundGain(paired));
    console.error(`${label} round ${r + 1}/${rounds}: paired gain ${(gains.at(-1)! * 100).toFixed(2)}%`);
  }
  const side = (list: any[]) => ({ meanMs: median(list.map(x => x.meanMs)), tickMedianMs: median(list.map(x => x.tick.median)),
    tickP99Ms: median(list.map(x => x.tick.p99)), tickMaxMs: median(list.map(x => x.tick.max)), gcTotalMs: median(list.map(x => x.gc.totalMs)),
    slowTicks: median(list.map(x => x.slowTicks)), ticks: list[0].ticks, result: list[0].result, peakAnts: list[0].peakAnts });
  const perSegment = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { reference: side(v.reference), candidate: side(v.candidate) }]));
  // Segments whose reference runs had ticks over the slow-tick limit: the redesign point-rest stretches.
  const slowSegments = Object.entries(perSegment).filter(([, v]) => v.reference.slowTicks > 0).map(([k, v]) => ({ segment: k, slowTicks: v.reference.slowTicks, meanMs: v.reference.meanMs }));
  return { rounds, segments: segs.length, window: window ?? null, roundGains: gains, medianPairedGain: median(gains), perSegment, slowSegments, loaded, wallMs: Date.now() - t0 };
}
function writeRun(kind: string, report: unknown): string {
  const dir = join(STORE, "runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}-${stamp()}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
const describeTree = (t: Tree) => ({ commit: t.commit, patchDigest: t.patchDigest });
/** --ticks: stop each run after this many ticks instead of the full match (smoke runs; stated in every report). */
/** Ticks timed from each saved state: --window, else DEFAULT_WINDOW when the workload has saved states; --whole times whole matches. */
function windowFor(w: Workload): number | undefined {
  if (o.whole === true) return undefined;
  if (o.window !== undefined) return int(o.window, 0, "window");
  return Object.values(w.checkpoints).some(c => c.length > 0) ? DEFAULT_WINDOW : undefined;
}
const tickCap = () => (o.ticks === undefined ? undefined : int(o.ticks, 0, "ticks"));
function horizonText(w: Workload, window: number | undefined): string {
  if (window !== undefined) return `${window} ticks from each of the workload's checkpoints`;
  return tickCap() === undefined ? w.horizon : `the first ${tickCap()} ticks of each match`;
}

// ---- noise rendezvous ---------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function createOnce(file: string, text: string): boolean {
  try { writeFileSync(file, text, { flag: "wx" }); return true; } catch (e: any) { if (e.code === "EEXIST") return false; throw e; }
}

async function noise(): Promise<void> {
  const base = tree(required(o.base, "base")), w = loadWorkload(base.commit);
  const session = required(o.session, "session"), me = required(o.participant, "participant"), expect = int(o.expect, 3, "expect");
  const waitMs = int(o.wait, 600, "wait") * 1000, finishMs = int(o["finish-wait"], 172_800, "finish-wait") * 1000;
  const rounds = int(o.rounds, DEFAULT_ROUNDS, "rounds"), window = windowFor(w);
  const dir = join(STORE, "noise", session);
  mkdirSync(join(dir, "arrivals"), { recursive: true });
  mkdirSync(join(dir, "results"), { recursive: true });
  const admittedFile = join(dir, "admitted.json");
  if (existsSync(admittedFile)) throw new Error(`noise session ${session} has already closed admission`);
  const t0 = Date.now();
  createOnce(join(dir, "arrivals", me), new Date().toISOString());
  // Admission closes when the expected participants have arrived or the wait runs out; the first to see it writes the list.
  while (!existsSync(admittedFile)) {
    const arrived = readdirSync(join(dir, "arrivals")).sort();
    if (arrived.length >= expect || Date.now() - t0 >= waitMs) createOnce(admittedFile, JSON.stringify({ admitted: arrived, closedAt: new Date().toISOString() }));
    else await sleep(500);
  }
  const { admitted } = JSON.parse(readFileSync(admittedFile, "utf8")) as { admitted: string[] };
  const waitedMs = Date.now() - t0;
  if (!admitted.includes(me)) { print({ session, participant: me, refused: "arrived after admission closed", admitted }); process.exitCode = 1; return; }
  const repetitions = repetitionsFor(admitted.length);
  const medians: number[] = [], timings: PairedTiming[] = [];
  for (let i = 0; i < repetitions; i++) {
    const t = pairedTiming(base, base, w, rounds, window, `noise ${me} repetition ${i + 1}/${repetitions}`);
    timings.push(t);
    medians.push(t.medianPairedGain);
  }
  writeFileSync(join(dir, "results", `${me}.json`), JSON.stringify({ participant: me, medians, loaded: timings[0]!.loaded, roundGains: timings.map(t => t.roundGains) }));
  // Wait for every admitted participant before reporting, so the verdict covers the whole concurrent load.
  const t1 = Date.now();
  while (readdirSync(join(dir, "results")).length < admitted.length) {
    if (Date.now() - t1 > finishMs) throw new Error(`noise session ${session}: not every admitted participant finished within ${finishMs / 1000} s`);
    await sleep(2000);
  }
  const all = admitted.map(p => JSON.parse(readFileSync(join(dir, "results", `${p}.json`), "utf8")) as { participant: string; medians: number[] });
  const verdict = noiseBar(all.flatMap(r => r.medians));
  const report = { session, participant: me, base: describeTree(base), host: host(), admitted, expected: expect, waitLimitS: waitMs / 1000, waitedS: waitedMs / 1000,
    repetitionsPerParticipant: repetitions, rounds, window: window ?? null, horizon: horizonText(w, window),
    participantMedians: Object.fromEntries(all.map(r => [r.participant, r.medians])), ...verdict, loaded: timings[0]!.loaded, myRunWallMs: timings.map(t => t.wallMs) };
  writeRun(`noise-${session}-${me}`, report);
  print(report);
}

// ---- commands ---------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  switch (command) {
    case "regen": {
      // Workload and exactness references at a commit: the live config's maps, seedsPerMap seeds each, full matches.
      const t = tree(required(o.commit, "commit")), per = int(o["seeds-per-map"], 2, "seeds-per-map");
      const paths = (o.paths ?? "advance,step").split(",") as ("advance" | "step")[], k = int(o.checkpoints, DEFAULT_CHECKPOINTS, "checkpoints"), t0 = Date.now();
      const found = runWorker(t, { mode: "workload", seedsPerMap: per }), cap = tickCap();
      const checkpoints = Object.fromEntries((found.scenarios as Scenario[]).map(s => {
        const ticks = s.loaded.matchTicks as number;
        return [s.id, k === 0 || cap !== undefined ? [] : Array.from({ length: k }, (_, i) => Math.floor((i * ticks) / k))];
      }));
      const w: Workload = { commit: t.commit, source: found.source, seedsPerMap: per, paths, scenarios: found.scenarios, checkpoints,
        horizon: "each match plays until it ends by its own match-end rule (its map's match length, or an earlier result)" };
      mkdirSync(join(STORE, "workloads"), { recursive: true });
      writeFileSync(workloadFile(t.commit), JSON.stringify(w, null, 2));
      await digests(t, w, w.scenarios, paths, cap, k > 0 && cap === undefined);
      print({ commit: t.commit, wallMs: Date.now() - t0, workload: workloadFile(t.commit), scenarios: w.scenarios.map(s => ({ id: s.id, weight: s.weight, loaded: s.loaded })), paths, checkpoints });
      return;
    }
    case "exact": {
      const ref = tree(required(o.reference, "reference"), referencePatch()), cand = tree(required(o.candidate, "candidate"), candidatePatch());
      const w = loadWorkload(ref.commit), scenarios = selectScenarios(w), ticks = o.ticks === undefined ? undefined : int(o.ticks, 0, "ticks");
      const paths = o.paths === undefined ? w.paths : o.paths.split(",");
      const t0 = Date.now();
      await Promise.all([digests(ref, w, scenarios, paths, ticks), digests(cand, w, scenarios, paths, ticks)]);
      const results = scenarios.flatMap(s => paths.map(path => {
        const r = JSON.parse(readFileSync(referenceFile(ref, path, s.id, ticks), "utf8")), c = JSON.parse(readFileSync(referenceFile(cand, path, s.id, ticks), "utf8"));
        return { scenario: s.id, map: s.map, seed: s.seed, path, ticks: r.ticks, endTick: r.endTick, result: r.result, ...compareDigests(r, c) };
      }));
      const report = { reference: describeTree(ref), candidate: describeTree(cand), compares: [...STREAMS], normalisation: "none: raw bytes of each stream, chained SHA-256 per tick",
        horizon: ticks === undefined ? w.horizon : `${ticks} ticks`, seeds: scenarios.map(s => `${s.map}:${s.seed}`), paths, pass: results.every(r => r.match), wallMs: Date.now() - t0, results };
      if (!report.pass) process.exitCode = 1;
      print({ ...report, file: writeRun("exact", report) });
      return;
    }
    case "time": {
      const ref = tree(required(o.reference, "reference"), referencePatch()), cand = tree(required(o.candidate, "candidate"), candidatePatch());
      const w = loadWorkload(ref.commit), rounds = int(o.rounds, DEFAULT_ROUNDS, "rounds"), window = windowFor(w);
      const before = host(), t = pairedTiming(ref, cand, w, rounds, window, "time");
      const report = { reference: describeTree(ref), candidate: describeTree(cand), host: { before, after: host() },
        horizon: horizonText(w, window), gain: "1 − candidate / reference weighted mean tick time per round", ...t };
      print({ ...report, file: writeRun("time", report) });
      return;
    }
    case "noise": {
      const local = o.local === undefined ? 0 : int(o.local, 0, "local");
      if (local === 0) return noise();
      // Local mode: start `local` participants at once on this host and show the first one's report.
      const session = o.session ?? `local-${stamp()}`;
      const argv = process.argv.slice(2).filter((a, i, all) => a !== "--local" && all[i - 1] !== "--local" && a !== "--session" && all[i - 1] !== "--session");
      const children = Array.from({ length: local }, (_, i) => new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, ["--import", join(ROOT, "src", "ts-resolve.mjs"), import.meta.filename, ...argv, "--session", session,
          "--participant", `local-${i + 1}`, "--expect", String(local), "--store", STORE], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", d => { out += d; });
        child.on("close", code => code === 0 ? done(out) : fail(new Error(`participant local-${i + 1} exited ${code}`)));
      }));
      console.log((await Promise.all(children))[0]);
      return;
    }
    case "profile": {
      const t = tree(required(o.commit, "commit"), candidatePatch()), w = loadWorkload(resolveCommit(ROOT, o.commit!));
      const s = o.scenario === undefined ? w.scenarios.find(x => x.map === "wide-plain") ?? w.scenarios[0]! : w.scenarios.find(x => x.id === o.scenario);
      if (s === undefined) throw new Error(`unknown --scenario; known: ${w.scenarios.map(x => x.id).join(", ")}`);
      const at = int(o.at, 0, "at"), ticks = o.ticks === undefined ? undefined : int(o.ticks, 0, "ticks");
      if (at > 0 && !(w.checkpoints[s.id] ?? []).includes(at)) throw new Error(`--at must be a checkpoint tick of ${s.id}: ${(w.checkpoints[s.id] ?? []).join(", ") || "none (regen --checkpoints)"}`);
      mkdirSync(join(STORE, "profiles"), { recursive: true });
      const file = join(STORE, "profiles", `${t.key}-${s.id}-${stamp()}.cpuprofile`);
      const run = runWorker(t, { mode: "time", map: s.map, seed: s.seed, ticks, profileOut: file,
        ...(at > 0 ? { checkpoint: join(STORE, "checkpoints", w.commit, s.id, `${at}.json`) } : {}) });
      const times = functionTimes(JSON.parse(readFileSync(file, "utf8")) as CpuProfile, `${t.dir}/`), top = int(o.top, 30, "top");
      const bySelf = [...times.functions].sort((a, b) => b.selfMs - a.selfMs).slice(0, top);
      const byInclusive = [...times.functions].sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, top);
      const report = { tree: describeTree(t), loaded: run.loaded, scenario: s.id, fromTick: at, ticks: run.ticks, endTick: run.endTick, tickSummary: run.tick,
        profiledMs: times.totalMs, profile: file, bySelf, byInclusive };
      print({ ...report, file: writeRun("profile", report) });
      return;
    }
    case "test": {
      const t = tree(required(o.commit, "commit"), candidatePatch());
      console.error(`scoped simulator tests in ${t.key}: ${SCOPED_TESTS.join(" ")}`);
      const r = spawnSync(join(t.dir, "node_modules", ".bin", "vitest"), ["run", "--maxWorkers=2", ...SCOPED_TESTS], { cwd: t.dir, stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    default:
      throw new Error("command must be one of: regen, exact, time, noise, profile, test (see docs/tuning-harness.md)");
  }
}
await main();
