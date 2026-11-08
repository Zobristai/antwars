// The once-only four-agent noise check can pass and fail, and a try reports
// its tick time relative to its lane's stored baseline without timing that baseline again.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordCheckpoint } from "./checkpoint.js";
import { LANES } from "./lanes.js";
import { startSeated, tickSeated } from "./seated.js";
import { openStore, type Store } from "./store.js";
import { DEFAULT_METHOD, LoopRefusal, NOISE_AGENTS, noiseVerdict, runNoiseCheck, SHARED_CHECKPOINT, srcTree, timeAgainstBaseline, timeTry, timeWindows, TRY_TICKS, tryWorkload } from "./timing.js";

const ROOT = resolve(import.meta.dirname, "../..");
const run = promisify(execFile);
const dirs: string[] = [];
const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `tuning-${name}-`)); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A clean git checkout to stand for an agent's unchanged loop; returns its HEAD. */
function cleanCheckout(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return git("rev-parse", "HEAD");
}

// A small seated match (24 per side, seats joined) so the timed ticks are cheap; the loop's own checkpoint is Wide Plain at 768.
let checkpoint = "";
beforeAll(() => {
  const match = startSeated({ map: "wide-plain", perSide: 24, seed: 7 });
  for (let i = 0; i < 40; i++) tickSeated(match);
  checkpoint = recordCheckpoint(match, TRY_TICKS + 10);
});

function seeded(): { store: Store; dir: string } {
  const dir = temp("store"), store = openStore(dir);
  store.putCheckpoint(SHARED_CHECKPOINT, checkpoint);
  return { store, dir };
}
const runs = (...ms: number[]) => ms.map((medianTickMs, i) => ({ agentId: `n${i + 1}`, medianTickMs }));

describe("noiseVerdict", () => {
  it("reports the spread of the four runs as (slowest − fastest) / median and passes within the limit", () => {
    const v = noiseVerdict(runs(10, 10.5, 11, 11.5), 0.15);
    expect(v.spread).toBeCloseTo(1.5 / 10.75, 12);
    expect(v.limit).toBe(0.15);
    expect(v.pass).toBe(true);
    expect(v.runs).toEqual(runs(10, 10.5, 11, 11.5));
  });

  it("fails when the spread is wider than the limit", () => {
    const v = noiseVerdict(runs(10, 10.5, 11, 13), 0.15);
    expect(v.spread).toBeCloseTo(3 / 10.75, 12);
    expect(v.pass).toBe(false);
  });

  it("needs exactly four runs and a usable limit", () => {
    expect(() => noiseVerdict(runs(10, 10, 10), 0.15)).toThrow(RangeError);
    expect(() => noiseVerdict(runs(10, 10, 10, 10, 10), 0.15)).toThrow(RangeError);
    expect(() => noiseVerdict(runs(10, 10, 10, 10), Number.NaN)).toThrow(RangeError);
    expect(() => noiseVerdict(runs(10, 10, 10, 10), -0.1)).toThrow(RangeError);
  });

  it("settles a workload only when every run timed exactly it, and refuses runs of another or an unrecorded workload", () => {
    const workload = tryWorkload(checkpoint, TRY_TICKS);
    const timed = (w: typeof workload | undefined) => runs(10, 10.5, 11, 11.5).map((r, i) => (i === 2 ? { ...r, workload: w } : { ...r, workload }));
    expect(noiseVerdict(timed(workload), 0.15, workload).workload).toEqual(workload);
    expect(() => noiseVerdict(timed(tryWorkload(checkpoint, TRY_TICKS + 10)), 0.15, workload)).toThrow(LoopRefusal);
    expect(() => noiseVerdict(timed(tryWorkload(`${checkpoint}\n`, TRY_TICKS)), 0.15, workload)).toThrow(/n3's run timed 50 ticks of checkpoint/);
    expect(() => noiseVerdict(timed(undefined), 0.15, workload)).toThrow(/n3's run timed an unrecorded workload/);
  });

  it("refuses a run timed with another timing method, naming both methods", () => {
    const workload = tryWorkload(checkpoint, TRY_TICKS), cold = tryWorkload(checkpoint, TRY_TICKS, { warmup: 0, repeats: 1 });
    const timed = runs(10, 10.5, 11, 11.5).map((r, i) => ({ ...r, workload: i === 1 ? cold : workload }));
    expect(() => noiseVerdict(timed, 0.15, workload)).toThrow(new RegExp(`^noise check stopped: n2's run timed 50 ticks of checkpoint ${workload.checkpoint} \\(timing method: 0 discarded runs, then the median of 1 timed runs\\), not the 50 ticks of checkpoint ${workload.checkpoint} \\(timing method: 10 discarded runs, then the median of 5 timed runs\\) this agent timed`));
  });
});

describe("timeWindows", () => {
  /** A stand-in for timeTry that records each run it is asked for and answers from a script of run medians. */
  function scripted(medians: readonly number[]) {
    const calls: { text: string; ticks: number }[] = [];
    return { calls, run: (text: string, ticks: number) => { calls.push({ text, ticks }); return { medianTickMs: medians[calls.length - 1]! }; } };
  }

  it("discards the warm-up runs and reports the median of the timed runs, every run the same ticks of the same checkpoint", () => {
    // Slow warm-up runs that would move the median if they were counted.
    const { calls, run } = scripted([900, 800, 700, 5, 1, 3]);
    expect(timeWindows(checkpoint, 7, { warmup: 3, repeats: 3 }, run)).toEqual({ runMs: [5, 1, 3], medianTickMs: 3 });
    expect(calls).toEqual(Array.from({ length: 6 }, () => ({ text: checkpoint, ticks: 7 })));
  });

  it("by default runs about 50 ticks: 10 discarded runs, then the median of 5 timed runs", () => {
    expect(DEFAULT_METHOD).toEqual({ warmup: 10, repeats: 5 });
    const { calls, run } = scripted([...Array(10).fill(99), 4, 2, 6, 1, 3]);
    expect(timeWindows(checkpoint, undefined, undefined, run)).toEqual({ runMs: [4, 2, 6, 1, 3], medianTickMs: 3 });
    expect(calls).toHaveLength(15);
    expect(calls.every(c => c.text === checkpoint && c.ticks === TRY_TICKS)).toBe(true);
  });

  it("times real runs, each a fresh reload of the checkpoint (timeTry)", () => {
    const { runMs, medianTickMs } = timeWindows(checkpoint, 7, { warmup: 1, repeats: 3 });
    expect(runMs).toHaveLength(3);
    expect(runMs.every(ms => ms > 0)).toBe(true);
    expect(medianTickMs).toBe([...runMs].sort((a, b) => a - b)[1]);
  });

  it("refuses a method that is not whole counts with at least one timed run", () => {
    for (const method of [{ warmup: 0, repeats: 0 }, { warmup: -1, repeats: 5 }, { warmup: 1.5, repeats: 5 }, { warmup: 10, repeats: Number.NaN }]) {
      expect(() => timeWindows(checkpoint, 7, method)).toThrow(RangeError);
    }
  });
});

describe("timeTry", () => {
  it("times the first 50 ticks of the reloaded checkpoint by default and reports their median", () => {
    const { tickMs, medianTickMs } = timeTry(checkpoint);
    expect(tickMs).toHaveLength(TRY_TICKS);
    expect(tickMs.every(ms => ms > 0)).toBe(true);
    const s = [...tickMs].sort((a, b) => a - b);
    expect(medianTickMs).toBe((s[24]! + s[25]!) / 2);
    expect(timeTry(checkpoint, 7).tickMs).toHaveLength(7);
  });

  it("refuses to run past the checkpoint's recorded tape", () => {
    expect(() => timeTry(checkpoint, TRY_TICKS + 11)).toThrow(RangeError);
  });
});

describe("the four-agent noise check", () => {
  it("four agents at once on one host: each times the unchanged checkout, all report one stored verdict, and a pass sets every lane's version 0 to the runs' median", async () => {
    const { store, dir } = seeded(), checkout = temp("checkout"), head = cleanCheckout(checkout);
    const agents = Array.from({ length: NOISE_AGENTS }, (_, i) => `agent-${i + 1}`);
    const outputs = await Promise.all(agents.map(agent => run(process.execPath,
      ["--experimental-transform-types", "--no-warnings", "--import", join(ROOT, "src/ts-resolve.mjs"), join(ROOT, "test/tuning/noise.ts"), "--store", dir, "--agent", agent, "--max-noise", "1000"],
      { cwd: checkout })));
    const reports = outputs.map(o => JSON.parse(o.stdout) as { agentId: string; timed: boolean; runs: { agentId: string; medianTickMs: number }[]; spread: number; limit: number; pass: boolean; at: string; workload: unknown; message: string });
    const verdict = store.noise()!;
    expect(verdict.pass).toBe(true);
    expect(verdict.limit).toBe(1000);
    expect(verdict.runs.map(r => r.agentId).sort()).toEqual(agents);
    // The verdict names the workload its runs timed, which every try a keep judges must share.
    expect(verdict.workload).toEqual(tryWorkload(checkpoint, TRY_TICKS));
    // Each run was timed by the default method, which the workload records.
    expect(verdict.workload).toMatchObject(DEFAULT_METHOD);
    // Each run is stored with the workload it timed, and the verdict settles only because all four timed that one.
    for (const run of store.noiseRuns()) expect(run.workload).toEqual(verdict.workload);
    for (const report of reports) {
      expect(report.timed).toBe(true);
      expect({ runs: report.runs, spread: report.spread, limit: report.limit, pass: report.pass, at: report.at, workload: report.workload }).toEqual(verdict);
      expect(report.message).toMatch(/^noise check passed: spread \d+\.\d\d% is within the limit 100000\.00%/);
    }
    const ms = verdict.runs.map(r => r.medianTickMs).sort((a, b) => a - b);
    expect(verdict.spread).toBeCloseTo((ms[3]! - ms[0]!) / ((ms[1]! + ms[2]!) / 2), 12);
    for (const lane of LANES) expect(store.baseline(lane.id)).toMatchObject({ lane: lane.id, version: 0, baseCommit: head, patches: [], medianTickMs: (ms[1]! + ms[2]!) / 2, workload: verdict.workload });
  }, 60_000);

  it("times every run by the method it is given and records it with each run, the verdict and every lane's version 0", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    const method = { warmup: 2, repeats: 3 }, workload = tryWorkload(checkpoint, 7, method);
    const reports = await Promise.all(Array.from({ length: NOISE_AGENTS }, (_, i) =>
      runNoiseCheck({ store, agentId: `m${i + 1}`, cwd: checkout, limit: 1000, ticks: 7, method })));
    expect(reports.every(r => r.timed && r.verdict.pass)).toBe(true);
    expect(store.noise()!.workload).toEqual(workload);
    expect(store.noiseRuns().map(r => r.workload)).toEqual(Array(NOISE_AGENTS).fill(workload));
    for (const lane of LANES) expect(store.baseline(lane.id)!.workload).toEqual(workload);
  }, 60_000);

  it("runs once: after a kept edit gives a lane a new baseline, a later agent gets the stored verdict and nothing is timed again", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    const stored = store.settleNoise(noiseVerdict(runs(10, 10.5, 11, 11.5), 0.15), "c0ffee");
    store.bindAgent("keeper", "freeform");
    expect(store.advanceLane("freeform", 0, { patch: "diff --git a/x b/x", medianTickMs: 9, agentId: "keeper" })).toMatchObject({ version: 1, medianTickMs: 9 });
    const later = await runNoiseCheck({ store, agentId: "late", cwd: checkout });
    expect(later).toEqual({ verdict: stored, timed: false, message: expect.stringMatching(/^noise check passed/) });
    expect(store.noiseArrivals()).toEqual([]);
    expect(store.noiseRuns()).toEqual([]);
    expect(store.baseline("freeform")).toMatchObject({ version: 1, medianTickMs: 9 });
    expect(store.baseline("neighbour-scan")).toMatchObject({ version: 0, medianTickMs: 10.75 });
  });

  it("fails when the spread is too wide: no lane gets a baseline, every try is refused with the failure, and the check is not repeated", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    const failed = store.settleNoise(noiseVerdict(runs(10, 10.5, 11, 13), 0.15), "c0ffee");
    expect(failed.pass).toBe(false);
    for (const lane of LANES) expect(store.baseline(lane.id)).toBeNull();
    const message = "noise check failed: spread 27.91% is wider than the limit 15.00%, so a gain larger than the noise cannot be detected; the shared baseline is not used";
    expect(() => timeAgainstBaseline(store, "agent", "neighbour-scan")).toThrow(new LoopRefusal(message));
    expect(await runNoiseCheck({ store, agentId: "again", cwd: checkout })).toEqual({ verdict: failed, timed: false, message });
  });

  it("a check stopped at a barrier cannot be settled by later one-at-a-time retries: no verdict, no baseline", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    const attempt = (agentId: string) => runNoiseCheck({ store, agentId, cwd: checkout, limit: 1000, waitMs: 50 });
    // Three agents arrive one after another and each stops waiting for the others.
    for (const agent of ["n1", "n2", "n3"]) await expect(attempt(agent)).rejects.toThrow(/4 agents did not arrive/);
    // The fourth completes the arrivals alone, so it times its run, then stops waiting for the other three runs.
    await expect(attempt("n4")).rejects.toThrow(/4 runs were not written/);
    expect(store.noiseRuns().map(r => r.agentId)).toEqual(["n4"]);
    // Every retry is refused rather than adding a run timed apart from the others.
    for (const agent of ["n1", "n2", "n3", "n4"]) await expect(attempt(agent)).rejects.toThrow(/already joined this store's noise check, which has not settled.*fresh store/);
    expect(store.noiseRuns().map(r => r.agentId)).toEqual(["n4"]);
    expect(store.noise()).toBeNull();
    for (const lane of LANES) expect(store.baseline(lane.id)).toBeNull();
    expect(() => timeAgainstBaseline(store, "agent", "freeform")).toThrow(/noise check has not run/);
  });

  it("a fifth agent is refused rather than joining the four", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    for (let i = 1; i <= NOISE_AGENTS; i++) store.arriveForNoise(`n${i}`);
    await expect(runNoiseCheck({ store, agentId: "n5", cwd: checkout })).rejects.toThrow(/already has its 4 agents/);
  });

  it("times only the unchanged loop: a checkout whose src has uncommitted changes is refused", async () => {
    const { store } = seeded(), checkout = temp("checkout");
    cleanCheckout(checkout);
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "edit.ts"), "export {};\n");
    await expect(runNoiseCheck({ store, agentId: "n1", cwd: checkout })).rejects.toThrow(/src has uncommitted changes/);
    expect(store.noiseArrivals()).toEqual([]);
  });
});

describe("a try", () => {
  it("is refused until the noise check has run", () => {
    const { store } = seeded();
    expect(() => timeAgainstBaseline(store, "agent", "freeform")).toThrow(/noise check has not run/);
  });

  it("reports its tick time relative to its lane's stored baseline, which it does not time again", () => {
    const { store } = seeded();
    // The stored runs are far from what this small checkpoint takes, so a re-timed baseline could not match them.
    const verdict = store.settleNoise(noiseVerdict(runs(500, 510, 520, 530), 0.15), "c0ffee");
    const before = store.baseline("soft-separation")!;
    const result = timeAgainstBaseline(store, "agent-7", "soft-separation");
    expect(before.medianTickMs).toBe(515);
    // It names what it timed: this checkout's src tree, and the shared checkpoint and ticks.
    expect(result).toEqual({ agentId: "agent-7", lane: "soft-separation", baselineVersion: 0, medianTickMs: result.medianTickMs,
      baselineMedianTickMs: 515, relative: result.medianTickMs / 515, gain: 1 - result.medianTickMs / 515, noise: verdict.spread,
      candidate: srcTree(ROOT), workload: tryWorkload(checkpoint, TRY_TICKS) });
    expect(result.medianTickMs).toBeGreaterThan(0);
    expect(result.medianTickMs).toBeLessThan(500);
    expect(store.baseline("soft-separation")).toEqual(before);
  });

  it("is timed by the method it is given, which its workload records, and still does not time the baseline again", () => {
    const { store } = seeded();
    store.settleNoise(noiseVerdict(runs(500, 510, 520, 530), 0.15), "c0ffee");
    const before = store.baseline("freeform")!, method = { warmup: 2, repeats: 3 };
    const result = timeAgainstBaseline(store, "agent-9", "freeform", 7, method);
    expect(result.workload).toEqual(tryWorkload(checkpoint, 7, method));
    expect(result).toMatchObject({ baselineMedianTickMs: 515, relative: result.medianTickMs / 515 });
    expect(result.medianTickMs).toBeLessThan(500);
    expect(store.baseline("freeform")).toEqual(before);
  });

  it("runs as an entry and prints the try result", async () => {
    const { store, dir } = seeded();
    store.settleNoise(noiseVerdict(runs(500, 510, 520, 530), 0.15), "c0ffee");
    const out = await run(process.execPath, ["--experimental-transform-types", "--no-warnings", "--import", join(ROOT, "src/ts-resolve.mjs"),
      join(ROOT, "test/tuning/try.ts"), "--store", dir, "--agent", "agent-8", "--lane", "freeform", "--ticks", "20"], { cwd: ROOT });
    expect(JSON.parse(out.stdout)).toMatchObject({ agentId: "agent-8", lane: "freeform", baselineVersion: 0, baselineMedianTickMs: 515 });
  }, 30_000);
});
