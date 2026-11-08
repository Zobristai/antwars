// Keep rule: decides whether a timed candidate becomes its lane's next version.
//
// A try's timing is judged only for the candidate and workload it timed: the try names the src tree
// it timed and the checkpoint, ticks and timing method, and a keep refuses (drops) it when this
// checkout's src is another tree, when its checkpoint, ticks or timing method are not the noise check's, or
// when the keep would replay another checkpoint. Every baseline it is judged against is the lane version the
// store holds, never a figure the try carries.
//
// A candidate is kept only if all three hold, checked cheapest first and stopping at the first failure:
//  1. its try's median tick time is lower than the lane's current baseline by more than the stored noise;
//  2. its replays match the lane version exactly, every tick's full state, events and results compared
//     with keys sorted (compareTicks): over the try's ticks from the shared checkpoint, and then over
//     ticks 0-2,399 of a seated Wide Plain 768 start (redesign rules, server policy) on seeds 7, 8 and 9.
//     A replay whose match ends before all its ticks are compared is not a match;
//  3. the existing scoped replay tests (the first quality gate) pass.
// A candidate that is unchanged, slower, within the noise, or changes any simulated value is dropped.
//
// The candidate's edit is its working tree's change under src/ from the lane version (the lane's base
// commit plus its kept patches, in order). Both versions are checked out to scratch directories from
// git objects, so what is checked is exactly what is kept: the agent's own index, branch and other files
// are never read into the patch or touched. Each version runs its own test/tuning loop modules, imported
// from its own scratch checkout, so the two simulations are separate module graphs in one process and
// are compared tick by tick, with no stored digests. A keep advances the lane by compare-and-swap; when
// another keep has won, the candidate is re-applied and re-tried on the new lane version, or dropped if
// its patch no longer applies. Every keep or drop is recorded as the agent's try record.
//
// Run from the candidate checkout's root (the seated front agent needs type transforms):
//   node --experimental-transform-types --no-warnings --import ./src/ts-resolve.mjs test/tuning/keep.ts \
//     --store <dir> --try <try-result.json> [--checkpoint <name>]
// where the try result is try.ts's JSON and the checkpoint defaults to the store's shared one. It prints
// the outcome as JSON. Exit status: 0 kept, 2 dropped, 3 re-try on the new lane version, 1 error.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.ts";
import { compareTicks, type TickMismatch } from "./equality.ts";
import { openStore, type LaneBaseline, type Store, type TryRecord, type TryWorkload } from "./store.ts";
import { describeMethod, SHARED_CHECKPOINT, TRY_TICKS, tryWorkload, type TryResult } from "./timing.ts";

export const REPLAY_SEEDS: readonly number[] = [7, 8, 9];
export const REPLAY_TICKS = 2_400;
export const REPLAY_START = { map: "wide-plain", perSide: 768 } as const;
/** The try's ticks, as timed tries run them: the try replay covers exactly the ticks that were timed. */
export { TRY_TICKS };
/** The edit a candidate contributes: its change under these paths. */
export const EDIT_PATHS: readonly string[] = ["src"];
/** First quality gate: the existing scoped replay tests. */
export const SCOPED_REPLAY_TESTS: { readonly command: string; readonly args: readonly string[] } = {
  command: "./node_modules/.bin/vitest",
  args: ["run", "--maxWorkers=2", ...["neighbour-search", "grid-tracker", "world", "point-rest-intent", "fighter-priorities", "soft-movement",
    "finer-grid-physics", "replay", "assignment-hold", "food-target-hold", "worker-guards", "advance"].map(name => `test/sim/${name}.test.ts`)],
};

/** One version's loop modules, in the shapes fixed for seated.ts and checkpoint.ts. */
interface SeatedModule {
  startSeated(start: { map: string; perSide: number; seed: number }): { state: SimState };
  tickSeated(match: { state: SimState }): StepOutput & { readonly inputs: readonly SimInput[] };
}
interface CheckpointModule {
  loadCheckpoint(text: string): { readonly state: SimState; readonly inputs: readonly (readonly SimInput[])[] };
  advanceCheckpoint(checkpoint: { readonly state: SimState; readonly inputs: readonly (readonly SimInput[])[] }, index: number): StepOutput;
}
export interface Version { readonly dir: string; readonly seated: SeatedModule; readonly checkpoint: CheckpointModule }

/** A version's own loop modules, imported from its checkout, so it runs its own simulation code. */
export async function loadVersion(dir: string): Promise<Version> {
  const load = (file: string) => import(pathToFileURL(join(dir, "test", "tuning", file)).href);
  return { dir, seated: await load("seated.ts") as SeatedModule, checkpoint: await load("checkpoint.ts") as CheckpointModule };
}

export interface ReplayRun { readonly name: string; readonly ticks: number; readonly firstContactTick: number | null; readonly mismatch: TickMismatch | null }

/** The try's ticks from the shared checkpoint, lane version against candidate. */
export function replayTry(lane: Version, candidate: Version, checkpointText: string, ticks = TRY_TICKS): ReplayRun {
  const expected = lane.checkpoint.loadCheckpoint(checkpointText), actual = candidate.checkpoint.loadCheckpoint(checkpointText);
  if (ticks > expected.inputs.length) throw new Error(`the checkpoint records ${expected.inputs.length} ticks of inputs; the try replay needs ${ticks}`);
  return compareRun("try", ticks, index => [lane.checkpoint.advanceCheckpoint(expected, index), candidate.checkpoint.advanceCheckpoint(actual, index)]);
}

/** Ticks 0 to ticks - 1 of a seated match on one seed, lane version against candidate. */
export function replaySeed(lane: Version, candidate: Version, seed: number, ticks = REPLAY_TICKS, start: { map: string; perSide: number } = REPLAY_START): ReplayRun {
  const expected = lane.seated.startSeated({ ...start, seed }), actual = candidate.seated.startSeated({ ...start, seed });
  return compareRun(`seed ${seed}`, ticks, () => [lane.seated.tickSeated(expected), candidate.seated.tickSeated(actual)]);
}

/** Compares every tick; the first death is reported as first contact. A match that ends stops the run short (see notMatched). */
function compareRun(name: string, ticks: number, next: (index: number) => readonly [StepOutput, StepOutput]): ReplayRun {
  let firstContactTick: number | null = null;
  for (let index = 0; index < ticks; index += 1) {
    const [expected, actual] = next(index);
    const mismatch = compareTicks(expected, actual);
    if (mismatch !== null) return { name, ticks: index + 1, firstContactTick, mismatch };
    if (firstContactTick === null && expected.events.some(event => event.type === "death")) firstContactTick = expected.state.tick - 1;
    if (expected.state.result !== null) return { name, ticks: index + 1, firstContactTick, mismatch: null };
  }
  return { name, ticks, firstContactTick, mismatch: null };
}

function git(cwd: string, args: readonly string[], options: { input?: string; index?: string } = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input: options.input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"],
    env: options.index === undefined ? process.env : { ...process.env, GIT_INDEX_FILE: options.index } });
}

/** A scratch directory removed by dispose(); its index file lives outside the checkout. */
interface Scratch { readonly root: string; readonly index: string; readonly dir: string; dispose(): void }
function scratch(label: string): Scratch {
  const root = mkdtempSync(join(tmpdir(), `antwar-keep-${label}-`)), dir = join(root, "checkout");
  return { root, index: join(root, "index"), dir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** The lane version's tree: its base commit with its kept patches applied in order. */
function laneTree(repo: string, baseline: Pick<LaneBaseline, "baseCommit" | "patches">, index: string): string {
  git(repo, ["read-tree", baseline.baseCommit], { index });
  for (const patch of baseline.patches) git(repo, ["apply", "--cached", "--binary", "-"], { index, input: patch });
  return git(repo, ["write-tree"], { index }).trim();
}

/** The candidate checkout's working tree, untracked files included and ignored files excluded. */
function workingTree(repo: string, index: string): string {
  copyFileSync(resolve(repo, git(repo, ["rev-parse", "--git-path", "index"]).trim()), index);
  git(repo, ["add", "--all"], { index });
  return git(repo, ["write-tree"], { index }).trim();
}

/**
 * The candidate's edit from the lane version: its working tree's change under EDIT_PATHS, with the src tree
 * of that same working-tree snapshot (as timing.ts srcTree names a timed candidate).
 */
export function candidateEdit(repo: string, baseline: Pick<LaneBaseline, "baseCommit" | "patches">): { readonly patch: string; readonly src: string } {
  const work = scratch("edit");
  try {
    const from = laneTree(repo, baseline, work.index), to = workingTree(repo, `${work.index}-work`);
    return { patch: git(repo, ["diff", "--binary", "--no-color", "--no-ext-diff", from, to, "--", ...EDIT_PATHS]), src: git(repo, ["rev-parse", `${to}:src`]).trim() };
  } finally {
    work.dispose();
  }
}

/** Whether an edit applies on a lane version. */
export function editApplies(repo: string, baseline: Pick<LaneBaseline, "baseCommit" | "patches">, patch: string): boolean {
  const work = scratch("apply");
  try {
    laneTree(repo, baseline, work.index);
    git(repo, ["apply", "--cached", "--check", "--binary", "-"], { index: work.index, input: patch });
    return true;
  } catch {
    return false;
  } finally {
    work.dispose();
  }
}

/** A scratch checkout of a lane version, optionally with an edit applied, with the candidate's node_modules linked in for the tests. */
export function checkoutVersion(repo: string, baseline: Pick<LaneBaseline, "baseCommit" | "patches">, edit?: string): Scratch {
  const work = scratch(edit === undefined ? "lane" : "candidate");
  try {
    laneTree(repo, baseline, work.index);
    if (edit !== undefined) git(repo, ["apply", "--cached", "--binary", "-"], { index: work.index, input: edit });
    mkdirSync(work.dir);
    git(repo, ["checkout-index", "--all", `--prefix=${work.dir}/`], { index: work.index });
    const modules = join(repo, "node_modules");
    if (existsSync(modules)) symlinkSync(modules, join(work.dir, "node_modules"), "dir");
    return work;
  } catch (error) {
    work.dispose();
    throw error;
  }
}

export interface ScopedTestRun { readonly command: string; readonly status: number | null; readonly outputTail: string }

function runScopedTests(dir: string, tests: { readonly command: string; readonly args: readonly string[] }): ScopedTestRun {
  const run = spawnSync(tests.command, tests.args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error === undefined ? "" : String(run.error)}`;
  return { command: [tests.command, ...tests.args].join(" "), status: run.status, outputTail: output.slice(-4_000) };
}

export interface KeepOptions {
  /** The candidate checkout: the agent's repository root. */
  readonly repo: string;
  readonly store: Store;
  /** The try that timed this candidate, as try.ts reports it; the try replay covers exactly its timed ticks. */
  readonly tried: TryResult;
  readonly checkpointName?: string;
  /** Overrides for repository tests only; the entry always uses the defaults. */
  readonly seeds?: readonly number[];
  readonly replayTicks?: number;
  readonly start?: { readonly map: string; readonly perSide: number };
  readonly scopedTests?: { readonly command: string; readonly args: readonly string[] };
  readonly log?: (line: string) => void;
}

export interface KeepOutcome {
  /** retry: another keep advanced the lane first; re-apply the patch on the new lane version and try again. */
  readonly decision: "keep" | "drop" | "retry";
  readonly reasons: readonly string[];
  readonly agentId: string;
  readonly lane: TryResult["lane"];
  /** The lane version the candidate was judged against. */
  readonly baseline: LaneBaseline;
  readonly medianTickMs: number;
  /** (baseline median - candidate median) / baseline median. */
  readonly gain: number;
  /** The stored noise verdict's spread. */
  readonly noise: number;
  readonly patch: string | null;
  readonly replays: readonly ReplayRun[];
  readonly scopedTests: ScopedTestRun | null;
  /** The lane's new version, when kept. */
  readonly kept: LaneBaseline | null;
  /** The lane version a retry must re-apply on. */
  readonly retryOn: LaneBaseline | null;
  readonly record: TryRecord | null;
}

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const mismatchText = (run: ReplayRun) => `changes a simulated value: ${run.name} replay differs from the lane version at tick ${run.mismatch!.tick}, ${run.mismatch!.part} ${run.mismatch!.path || "/"}`;

/** Why a replay is not a match over its ticks: a changed simulated value, or a match that ended before all its ticks; null when it matched. */
function notMatched(run: ReplayRun, ticks: number): string | null {
  if (run.mismatch !== null) return mismatchText(run);
  if (run.ticks < ticks) return `incomplete: the ${run.name} replay ended after ${run.ticks} of its ${ticks} ticks, when the match ended; a replay that does not complete its ticks is not a match`;
  return null;
}

/** Refuses a try result that is not in try.ts's shape before any of it is used. */
function checkTry(tried: TryResult): void {
  const invalid = [
    typeof tried.agentId === "string" ? null : "agentId",
    Number.isInteger(tried.baselineVersion) && tried.baselineVersion >= 0 ? null : "baselineVersion",
    typeof tried.medianTickMs === "number" && Number.isFinite(tried.medianTickMs) && tried.medianTickMs > 0 ? null : "medianTickMs",
    typeof tried.candidate === "string" && tried.candidate !== "" ? null : "candidate",
    typeof tried.workload?.checkpoint === "string" && Number.isInteger(tried.workload.ticks) && tried.workload.ticks > 0
      && Number.isInteger(tried.workload.warmup) && tried.workload.warmup >= 0 && Number.isInteger(tried.workload.repeats) && tried.workload.repeats > 0 ? null : "workload",
  ].filter(field => field !== null);
  if (invalid.length > 0) throw new Error(`not a try result this keep can judge (${invalid.join(", ")} missing or invalid): time the candidate with try.ts`);
}

/**
 * Why a try's timing is not this candidate's on the workload the lane baselines rest on, or null when it is: the
 * try must have timed the noise check's checkpoint and ticks with its timing method, the checkpoint this keep
 * replays, and this src tree.
 */
function refusal(tried: TryResult, noiseWorkload: TryWorkload, replayedCheckpoint: string, src: string): string | null {
  const timed = tried.workload, again = "time this candidate with try.ts before keeping it";
  if (timed.checkpoint !== noiseWorkload.checkpoint || timed.ticks !== noiseWorkload.ticks) {
    return `refused: the try timed ${timed.ticks} ticks of checkpoint ${timed.checkpoint}, but the noise check that the lane baselines rest on timed ${noiseWorkload.ticks} ticks of checkpoint ${noiseWorkload.checkpoint}; ${again}`;
  }
  if (timed.warmup !== noiseWorkload.warmup || timed.repeats !== noiseWorkload.repeats) {
    return `refused: the try's timing method (${describeMethod(timed)}) is not that of the noise check the lane baselines rest on (${describeMethod(noiseWorkload)}); ${again}`;
  }
  if (timed.checkpoint !== replayedCheckpoint) return `refused: the try timed checkpoint ${timed.checkpoint}, but this keep replays checkpoint ${replayedCheckpoint}; ${again}`;
  if (tried.candidate !== src) return `refused: the try timed src tree ${tried.candidate}, but this candidate's src is tree ${src}; ${again}`;
  return null;
}

/** Judges one timed candidate against its lane's current version and records the result. */
export async function decideKeep(options: KeepOptions): Promise<KeepOutcome> {
  const { store, tried } = options, log = options.log ?? (() => {});
  checkTry(tried);
  const repo = git(options.repo, ["rev-parse", "--show-toplevel"]).trim();
  const verdict = store.noise();
  if (verdict === null) throw new Error("the four-run noise check has not settled: no shared baseline can be used yet");
  if (!verdict.pass) throw new Error(`the four-run noise check failed (spread ${percent(verdict.spread)} against limit ${percent(verdict.limit)}): the shared baseline is not used`);
  if (verdict.workload === undefined) throw new Error("the noise check recorded no workload, so no try can be judged against the shared baseline");
  store.bindAgent(tried.agentId, tried.lane);
  const current = store.baseline(tried.lane);
  if (current === null) throw new Error(`lane ${tried.lane} has no baseline`);
  // The version the try was timed against, as the store holds it: the lane's current one, unless another keep has since advanced it.
  const against = store.laneVersion(tried.lane, tried.baselineVersion);
  if (against === null) throw new Error(`the try names lane version ${tried.baselineVersion}, but lane ${tried.lane} is at version ${current.version}`);
  const checkpointName = options.checkpointName ?? SHARED_CHECKPOINT, checkpointText = store.checkpoint(checkpointName);
  if (checkpointText === null) throw new Error(`the store holds no shared checkpoint named ${checkpointName}`);
  // The candidate as it is now, read once: the src tree the timing must belong to, and the patch judged and kept.
  const edit = candidateEdit(repo, against);

  const noise = verdict.spread;
  const gain = (against.medianTickMs - tried.medianTickMs) / against.medianTickMs;
  const replays: ReplayRun[] = [];
  let patch: string | null = null, scopedTests: ScopedTestRun | null = null;
  const outcome = (decision: KeepOutcome["decision"], reasons: readonly string[], kept: LaneBaseline | null = null, retryOn: LaneBaseline | null = null): KeepOutcome => {
    const record: TryRecord | null = decision === "retry" ? null : {
      agentId: tried.agentId, lane: tried.lane, baselineVersion: against.version, medianTickMs: tried.medianTickMs, baselineMedianTickMs: against.medianTickMs,
      relative: tried.medianTickMs / against.medianTickMs, noise, workload: tried.workload, decision, reasons, ...(patch === null ? {} : { patch }), at: new Date().toISOString() };
    if (record !== null) store.recordTry(record);
    return { decision, reasons, agentId: tried.agentId, lane: tried.lane, baseline: against, medianTickMs: tried.medianTickMs, gain, noise,
      patch, replays, scopedTests, kept, retryOn, record };
  };
  /** Another keep advanced the lane: re-try on the new version if the edit still applies, else drop. */
  const raced = (): KeepOutcome => {
    const latest = store.baseline(tried.lane)!;
    patch ??= edit.patch;
    if (patch === "") return outcome("drop", [unchanged(against)]);
    if (editApplies(repo, latest, patch)) return outcome("retry", [`lane ${tried.lane} advanced to version ${latest.version}: re-apply the patch on it and try again`], null, latest);
    return outcome("drop", [`lane ${tried.lane} advanced to version ${latest.version} and the patch no longer applies on it`]);
  };

  // 0. The timing must be this candidate's, on the workload the lane baselines were timed on; otherwise it is refused.
  const refused = refusal(tried, verdict.workload, tryWorkload(checkpointText, tried.workload.ticks).checkpoint, edit.src);
  if (refused !== null) return outcome("drop", [refused]);

  // 1. The measured gain must exceed the noise.
  if (!(gain > noise)) {
    const timing = `median tick ${tried.medianTickMs} ms against the lane version ${against.version} baseline ${against.medianTickMs} ms`;
    return outcome("drop", [gain < 0 ? `slower: ${timing}` : `within the noise: ${timing} is a gain of ${percent(gain)}, not more than the noise ${percent(noise)}`]);
  }
  if (against.version !== current.version) return raced();

  patch = edit.patch;
  if (patch === "") return outcome("drop", [unchanged(current)]);

  const lane = checkoutVersion(repo, current), candidate = checkoutVersion(repo, current, patch);
  try {
    const versions = { lane: await loadVersion(lane.dir), candidate: await loadVersion(candidate.dir) };

    // 2a. The try's timed ticks from the checkpoint it timed.
    log(`replaying the try (${tried.workload.ticks} ticks) from checkpoint ${checkpointName}`);
    replays.push(replayTry(versions.lane, versions.candidate, checkpointText, tried.workload.ticks));
    const tryFailure = notMatched(replays.at(-1)!, tried.workload.ticks);
    if (tryFailure !== null) return outcome("drop", [tryFailure]);

    // 3. The existing scoped replay tests, in the candidate checkout (cheaper than the long replays).
    log("running the scoped replay tests in the candidate checkout");
    scopedTests = runScopedTests(candidate.dir, options.scopedTests ?? SCOPED_REPLAY_TESTS);
    if (scopedTests.status !== 0) return outcome("drop", [`the scoped replay tests failed (exit ${scopedTests.status}): ${scopedTests.command}`]);

    // 2b. Ticks 0-2,399 from the seated start on each seed, every one of them compared.
    const replayTicks = options.replayTicks ?? REPLAY_TICKS;
    for (const seed of options.seeds ?? REPLAY_SEEDS) {
      log(`replaying seed ${seed} for ${replayTicks} ticks`);
      replays.push(replaySeed(versions.lane, versions.candidate, seed, replayTicks, options.start ?? REPLAY_START));
      const run = replays.at(-1)!;
      log(`seed ${seed}: ${run.ticks} ticks, first contact at tick ${run.firstContactTick ?? "none"}`);
      const seedFailure = notMatched(run, replayTicks);
      if (seedFailure !== null) return outcome("drop", [seedFailure]);
    }
  } finally {
    lane.dispose();
    candidate.dispose();
  }

  const kept = store.advanceLane(tried.lane, current.version, { patch, medianTickMs: tried.medianTickMs, agentId: tried.agentId, workload: tried.workload });
  if (kept === "stale") return raced();
  return outcome("keep", [], kept);
}

const unchanged = (version: LaneBaseline) => `unchanged: no change under ${EDIT_PATHS.join(", ")} from lane version ${version.version}`;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}

async function main(args: readonly string[]): Promise<number> {
  const storeDir = option(args, "store"), tryFile = option(args, "try");
  if (storeDir === undefined || tryFile === undefined) throw new Error("usage: keep.ts --store <dir> --try <try-result.json> [--checkpoint <name>]");
  const tried = JSON.parse(readFileSync(tryFile, "utf8")) as TryResult;
  const result = await decideKeep({ repo: process.cwd(), store: openStore(storeDir), tried, checkpointName: option(args, "checkpoint"), log: line => process.stderr.write(`${line}\n`) });
  let patchFile: string | undefined;
  if (result.decision === "retry" && result.patch !== null) {
    patchFile = join(tmpdir(), `antwar-keep-${encodeURIComponent(result.agentId)}-${Date.now()}.patch`);
    writeFileSync(patchFile, result.patch);
  }
  const { patch, record: _record, ...shown } = result;
  process.stdout.write(`${JSON.stringify({ ...shown, patchBytes: patch?.length ?? 0, ...(patchFile === undefined ? {} : { patchFile }) }, null, 2)}\n`);
  return result.decision === "keep" ? 0 : result.decision === "drop" ? 2 : 3;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
