// Tuning loop, "Timed tries and noise check": a try times about 50 ticks from the shared
// reloaded checkpoint against its lane's stored baseline, which it never re-times; the four-agent
// noise check runs once, before any try, and decides whether that shared baseline may be used.
// Each try and each noise-check run is timed by timeWindows: discarded warm-up runs, then the median
// of repeated timed runs, every run the same ticks from a fresh reload.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { advanceCheckpoint, loadCheckpoint, recordCheckpoint } from "./checkpoint.js";
import type { LaneId } from "./lanes.js";
import { DEFAULT_START, playToBattle, startSeated } from "./seated.js";
import type { NoiseRun, NoiseVerdict, Store, TryWorkload } from "./store.js";

/** The store name of the one checkpoint every try and the noise check time. */
export const SHARED_CHECKPOINT = "shared";
/** Ticks per try (about 50). */
export const TRY_TICKS = 50;
/**
 * How every tick time the loop measures is taken: `warmup` discarded runs, then the median of `repeats`
 * timed runs, each run the same ticks from a fresh reload of the checkpoint.
 */
export interface TimingMethod { readonly warmup: number; readonly repeats: number }
/**
 * Default method, from the single-machine diagnostic from 2026-10-29T12:32:18Z to 2026-10-29T12:34:26Z
 *: one cold run spread 26.7%; after 5 discarded runs, single runs spread
 * 17.18%; medians of 5 runs spread 10.97% after 5 discarded runs and about 5% once 10 had run. So 10 discarded runs,
 * then the median of 5: 15 runs of about 1.1 s each at Wide Plain 768, about 17 s a try.
 */
export const DEFAULT_METHOD: TimingMethod = { warmup: 10, repeats: 5 };
/** Agents in the noise check. */
export const NOISE_AGENTS = 4;
/**
 * Default noise limit (--max-noise): the widest four-agent spread at which a gain larger than the noise is
 * still worth detecting. Set from the spread measured on a shared machine, 20 four-agent checks at
 * 2026-10-29T08:15Z: 2.2% to 23.4%, median 7.9%, 18 of 20 within 15%. Kept with DEFAULT_METHOD:
 * four processes at once on one machine spread 3.9% to 6.2% over four checks from 2026-10-29T12:47:04Z to
 * 2026-10-29T12:48:59Z.
 */
export const DEFAULT_MAX_NOISE = 0.15;
/** The shared checkpoint's default start and tape when the noise check has to build it. */
export const SHARED_SEED = 7, SHARED_TAPE = 200;

export interface TryResult {
  readonly agentId: string; readonly lane: LaneId; readonly baselineVersion: number; readonly medianTickMs: number; readonly baselineMedianTickMs: number;
  readonly relative: number; readonly gain: number; readonly noise: number;
  /** The candidate this timing belongs to: the git tree of the timed checkout's src (srcTree). */
  readonly candidate: string;
  /** The checkpoint and ticks this timing covers. */
  readonly workload: TryWorkload;
}

/** A check result the loop reports and stops on, rather than a fault in the harness. */
export class LoopRefusal extends Error {}

/** The checkout whose loop and simulation modules this process runs. */
const LOOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The workload timed: the checkpoint text's SHA-256, the number of ticks timed from it, and the timing method's counts. */
export function tryWorkload(checkpointText: string, ticks: number, method: TimingMethod = DEFAULT_METHOD): TryWorkload {
  return { checkpoint: createHash("sha256").update(checkpointText).digest("hex"), ticks, warmup: method.warmup, repeats: method.repeats };
}

/** A timing method as the loop reports it; "none recorded" for a workload recorded without one. */
export function describeMethod(m: Partial<TimingMethod>): string {
  return m.warmup === undefined || m.repeats === undefined ? "none recorded" : `${m.warmup} discarded runs, then the median of ${m.repeats} timed runs`;
}

/** A workload as the loop reports it. */
function describeWorkload(w: TryWorkload): string {
  return `${w.ticks} ticks of checkpoint ${w.checkpoint} (timing method: ${describeMethod(w)})`;
}

/**
 * The git tree of a checkout's working-tree src, untracked files included and ignored files excluded: the
 * candidate code a try times and a keep replays. The checkout's own index is copied, never written.
 */
export function srcTree(dir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "antwar-src-tree-")), index = join(scratch, "index");
  const git = (args: readonly string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
  try {
    const own = resolve(dir, execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: dir, encoding: "utf8" }).trim());
    if (existsSync(own)) copyFileSync(own, index);
    git(["add", "--all", "--", "src"]);
    return git(["write-tree", "--prefix=src/"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One run: reload the checkpoint and time each of the first `ticks` ticks; only the simulation call is inside the timer. */
export function timeTry(checkpointText: string, ticks = TRY_TICKS): { readonly tickMs: readonly number[]; readonly medianTickMs: number } {
  const cp = loadCheckpoint(checkpointText);
  const tickMs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const start = performance.now();
    advanceCheckpoint(cp, i);
    tickMs.push(performance.now() - start);
  }
  return { tickMs, medianTickMs: median(tickMs) };
}

/** Refuses a method that is not whole numbers, at least one timed run. */
function checkMethod(m: TimingMethod): TimingMethod {
  if (!Number.isInteger(m.warmup) || m.warmup < 0) throw new RangeError(`warm-up runs must be a whole number >= 0, got ${m.warmup}`);
  if (!Number.isInteger(m.repeats) || m.repeats < 1) throw new RangeError(`timed runs must be a whole number >= 1, got ${m.repeats}`);
  return m;
}

/**
 * The loop's tick time for a workload: `method.warmup` runs whose times are discarded, then `method.repeats`
 * timed runs, each a fresh reload of the checkpoint and the same first `ticks` ticks (timeTry). The tick time is the
 * median of the timed runs' medians; runMs lists those, in order. Every noise-check run and every try is taken so.
 */
export function timeWindows(checkpointText: string, ticks = TRY_TICKS, method: TimingMethod = DEFAULT_METHOD,
  run: (text: string, ticks: number) => { readonly medianTickMs: number } = timeTry): { readonly runMs: readonly number[]; readonly medianTickMs: number } {
  checkMethod(method);
  for (let i = 0; i < method.warmup; i++) run(checkpointText, ticks);
  const runMs = Array.from({ length: method.repeats }, () => run(checkpointText, ticks).medianTickMs);
  return { runMs, medianTickMs: median(runMs) };
}

/**
 * Spread = (slowest − fastest) / median of the agents' medians; the check passes when it is within the limit.
 * The workload the runs timed is recorded with the verdict, so tries are judged only on that same workload;
 * given one, every run must have timed exactly it, or the check is refused rather than settled.
 */
export function noiseVerdict(runs: readonly NoiseRun[], limit: number, workload?: TryWorkload): NoiseVerdict {
  if (runs.length !== NOISE_AGENTS) throw new RangeError(`the noise check needs ${NOISE_AGENTS} runs, got ${runs.length}`);
  if (!(limit >= 0) || !Number.isFinite(limit)) throw new RangeError(`noise limit must be a finite number >= 0, got ${limit}`);
  const other = workload === undefined ? undefined
    : runs.find(r => r.workload?.checkpoint !== workload.checkpoint || r.workload?.ticks !== workload.ticks
      || r.workload?.warmup !== workload.warmup || r.workload?.repeats !== workload.repeats);
  if (other !== undefined) {
    const timed = other.workload === undefined ? "an unrecorded workload" : describeWorkload(other.workload);
    throw new LoopRefusal(`noise check stopped: ${other.agentId}'s run timed ${timed}, not the ${describeWorkload(workload!)} this agent timed; the four runs must time one workload. Start all four agents again on a fresh store with the same --ticks`);
  }
  const ms = runs.map(r => r.medianTickMs);
  const spread = (Math.max(...ms) - Math.min(...ms)) / median(ms);
  return { runs: runs.map(r => ({ agentId: r.agentId, medianTickMs: r.medianTickMs })), spread, limit, pass: spread <= limit, at: new Date().toISOString(),
    ...(workload === undefined ? {} : { workload }) };
}

/** The sentence the loop reports for a stored verdict. */
export function describeNoise(v: NoiseVerdict): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return v.pass
    ? `noise check passed: spread ${pct(v.spread)} is within the limit ${pct(v.limit)}; a try must gain more than ${pct(v.spread)} on its lane baseline`
    : `noise check failed: spread ${pct(v.spread)} is wider than the limit ${pct(v.limit)}, so a gain larger than the noise cannot be detected; the shared baseline is not used`;
}

/** The stored verdict, refusing unless it passed. */
function passedNoise(store: Store): NoiseVerdict {
  const verdict = store.noise();
  if (verdict === null) throw new LoopRefusal("the four-agent noise check has not run; run test/tuning/noise.ts on four agents first");
  if (!verdict.pass) throw new LoopRefusal(describeNoise(verdict));
  return verdict;
}

/**
 * One try in the agent's own checkout, reported against its lane's stored baseline, which is not timed again.
 * Its tick time is taken by timeWindows with the given method. The result names what it timed: the src tree of
 * the checkout whose modules this process runs, read before timing, and the checkpoint, ticks and method timed.
 * A keep refuses it for any other candidate or workload.
 */
export function timeAgainstBaseline(store: Store, agentId: string, lane: LaneId, ticks = TRY_TICKS, method: TimingMethod = DEFAULT_METHOD): TryResult {
  const verdict = passedNoise(store);
  store.bindAgent(agentId, lane);
  const base = store.baseline(lane);
  if (base === null) throw new LoopRefusal(`lane ${lane} has no baseline`);
  const text = store.checkpoint(SHARED_CHECKPOINT);
  if (text === null) throw new LoopRefusal(`the store has no ${SHARED_CHECKPOINT} checkpoint`);
  const candidate = srcTree(LOOP_ROOT);
  const { medianTickMs } = timeWindows(text, ticks, method);
  const relative = medianTickMs / base.medianTickMs;
  return { agentId, lane, baselineVersion: base.version, medianTickMs, baselineMedianTickMs: base.medianTickMs, relative, gain: 1 - relative, noise: verdict.spread,
    candidate, workload: tryWorkload(text, ticks, method) };
}

export interface NoiseOptions {
  readonly store: Store;
  readonly agentId: string;
  /** Root of the unchanged checkout being timed. */
  readonly cwd: string;
  readonly limit?: number;
  readonly ticks?: number;
  /** How each agent's run is timed (timeWindows); every try a keep judges must use the same. */
  readonly method?: TimingMethod;
  /** Longest wait for the other agents at each barrier. */
  readonly waitMs?: number;
}

export interface NoiseReport { readonly verdict: NoiseVerdict; readonly timed: boolean; readonly message: string }

async function waitFor(what: string, waitMs: number, ready: () => boolean): Promise<void> {
  const until = Date.now() + waitMs;
  while (!ready()) {
    if (Date.now() > until) throw new LoopRefusal(`noise check stopped: ${what} within ${Math.round(waitMs / 1000)} s`);
    await sleep(25);
  }
}

/**
 * The once-only noise check, run by each of four agents at the same time. Each arrives, waits for
 * the other three, times the unchanged checkout on the shared checkpoint, and waits for all four
 * runs; the first verdict stored is the one every agent reports. Once a verdict exists it is reported
 * and nothing is timed again, so a new lane baseline after a kept edit never repeats it.
 *
 * Each agent arrives once. A run is written only by an agent still waiting when the fourth arrives, so
 * the four runs start together. An agent that arrives again, after its earlier attempt stopped at a
 * barrier, is refused: reusing that attempt's arrival or run would let separate, one-at-a-time attempts
 * settle a check whose runs were never timed at the same time. A stopped check is restarted on a fresh store.
 */
export async function runNoiseCheck(o: NoiseOptions): Promise<NoiseReport> {
  const settled = o.store.noise();
  if (settled !== null) return { verdict: settled, timed: false, message: describeNoise(settled) };
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: o.cwd, encoding: "utf8" });
  if (dirty !== "") throw new LoopRefusal(`the noise check times the unchanged loop, but src has uncommitted changes:\n${dirty}`);
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: o.cwd, encoding: "utf8" }).trim();
  const waitMs = o.waitMs ?? 600_000;
  if (o.store.checkpoint(SHARED_CHECKPOINT) === null) {
    const match = startSeated({ ...DEFAULT_START, seed: SHARED_SEED });
    playToBattle(match);
    o.store.putCheckpoint(SHARED_CHECKPOINT, recordCheckpoint(match, SHARED_TAPE)); // create-once: a concurrent agent's identical copy may win
  }
  const text = o.store.checkpoint(SHARED_CHECKPOINT)!;
  if (o.store.noiseArrivals().includes(o.agentId)) {
    throw new LoopRefusal(`${o.agentId} already joined this store's noise check, which has not settled; its four runs must be timed at the same time, so an earlier attempt's arrival and run are not reused. Start all four agents again on a fresh store`);
  }
  const place = o.store.arriveForNoise(o.agentId);
  if (place > NOISE_AGENTS) throw new LoopRefusal(`the noise check already has its ${NOISE_AGENTS} agents; ${o.agentId} arrived ${place}th`);
  await waitFor(`${NOISE_AGENTS} agents did not arrive`, waitMs, () => o.store.noiseArrivals().length >= NOISE_AGENTS);
  const ticks = o.ticks ?? TRY_TICKS, method = o.method ?? DEFAULT_METHOD, workload = tryWorkload(text, ticks, method);
  o.store.writeNoiseRun(o.agentId, timeWindows(text, ticks, method).medianTickMs, workload);
  await waitFor(`${NOISE_AGENTS} runs were not written`, waitMs, () => o.store.noiseRuns().length >= NOISE_AGENTS);
  const verdict = o.store.settleNoise(noiseVerdict(o.store.noiseRuns().slice(0, NOISE_AGENTS), o.limit ?? DEFAULT_MAX_NOISE, workload), baseCommit);
  return { verdict, timed: true, message: describeNoise(verdict) };
}
