// The keep rule keeps a timed candidate only when it beats its lane's baseline
// by more than the noise, its replays match the lane version exactly, and the scoped replay tests pass.
//
// The candidate checkout is a scratch git repository holding a copy of src/ and the real seated/checkpoint
// loop modules with the benchmark front agent they seat, so real simulation edits are replayed in separate
// module graphs. Timings are injected as the try result, bound like try.ts's to the candidate's src tree and the
// checkpoint and ticks timed; the start, seeds and tick counts are reduced here, and the defaults the entry uses
// are asserted separately.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordCheckpoint } from "./checkpoint.ts";
import { decideKeep, REPLAY_SEEDS, REPLAY_START, REPLAY_TICKS, SCOPED_REPLAY_TESTS, TRY_TICKS, type KeepOptions } from "./keep.ts";
import { startSeated, tickSeated } from "./seated.ts";
import { openStore, type NoiseVerdict, type Store } from "./store.ts";
import { SHARED_CHECKPOINT, srcTree, tryWorkload, type TryResult } from "./timing.ts";

const ROOT = join(import.meta.dirname, "..", "..");
/** The files the loop modules run on, copied into the candidate checkout. */
const LOOP_FILES = ["test/tuning/seated.ts", "test/tuning/checkpoint.ts", "test/benchmark/agents.ts", "test/benchmark/match.ts"];
/** A small seated start, so the real loop runs quickly here. */
const SMALL_START = { map: "wide-plain", perSide: 24 } as const;

let repo = "", base = "", checkpointText = "";
const stores: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "keep test", GIT_AUTHOR_EMAIL: "keep@test", GIT_COMMITTER_NAME: "keep test", GIT_COMMITTER_EMAIL: "keep@test" } });
/** Replaces one exact text in a working-tree file of the candidate checkout. */
function edit(file: string, from: string, to: string): void {
  const path = join(repo, file), text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`${file} lacks ${from}`);
  writeFileSync(path, text.replace(from, to));
}
/** The patch an edit makes from the base commit, with the working tree restored. */
function patchOf(file: string, from: string, to: string): string {
  edit(file, from, to);
  const patch = git("diff", "--binary");
  git("checkout", "--", file);
  return patch;
}
const DELAY_FROM = "  // Point rests are prepared only for a tick-0 state";
const DELAY_TO = `  for (const until = performance.now() + 0.05; performance.now() < until;);\n${DELAY_FROM}`;
const RNG_LINE = "/** Seeded PRNG (mulberry32). Pure: no clock, I/O or global randomness. */";

/** The ticks the noise check and every injected try timed, and so the try replay's length. */
const TRY = 10;
/** The noise verdict, on the checkpoint and ticks every injected try times; its runs' median, version 0's baseline, is 10 ms. */
let VERDICT: NoiseVerdict;
const LANE = "soft-separation" as const;
const PASSING_TESTS = { command: process.execPath, args: ["-e", "process.exit(0)"] };

function freshStore(verdict: NoiseVerdict | null = VERDICT): Store {
  const dir = mkdtempSync(join(tmpdir(), "antwar-keep-store-"));
  stores.push(dir);
  const store = openStore(dir);
  if (verdict !== null) store.settleNoise(verdict, base);
  store.putCheckpoint(SHARED_CHECKPOINT, checkpointText);
  // The other agents whose keeps these tests place directly; a store only advances a lane for its bound agents.
  for (const agentId of ["slow-agent", "agent-2"]) store.bindAgent(agentId, LANE);
  return store;
}
function tried(store: Store, over: Partial<TryResult> = {}): TryResult {
  const baseline = store.baseline(LANE)!, medianTickMs = over.medianTickMs ?? baseline.medianTickMs * 0.9;
  return { agentId: "agent-1", lane: LANE, baselineVersion: baseline.version, baselineMedianTickMs: baseline.medianTickMs, medianTickMs,
    relative: medianTickMs / baseline.medianTickMs, gain: 1 - medianTickMs / baseline.medianTickMs, noise: VERDICT.spread,
    candidate: srcTree(repo), workload: tryWorkload(checkpointText, TRY), ...over };
}
const options = (store: Store, over: Partial<KeepOptions> = {}): KeepOptions =>
  ({ repo, store, seeds: [7], replayTicks: 15, start: SMALL_START, scopedTests: PASSING_TESTS, ...over, tried: over.tried ?? tried(store) });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "antwar-keep-candidate-"));
  cpSync(join(ROOT, "src"), join(repo, "src"), { recursive: true });
  for (const file of LOOP_FILES) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    cpSync(join(ROOT, file), join(repo, file));
  }
  git("init", "-q", "-b", "main");
  git("add", "--all");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD").trim();
  // A real mid-match checkpoint: a small seated start played 20 ticks, with its seats' next 30 ticks of inputs.
  const match = startSeated({ ...SMALL_START, seed: 11 });
  for (let i = 0; i < 20; i += 1) tickSeated(match);
  checkpointText = recordCheckpoint(match, 30);
  VERDICT = { runs: [10, 10.1, 9.9, 10].map((medianTickMs, i) => ({ agentId: `noise-${i}`, medianTickMs })), spread: 0.02, limit: 0.05, pass: true,
    at: "2026-10-29T08:00:00.000Z", workload: tryWorkload(checkpointText, TRY) };
});
afterEach(() => {
  git("checkout", "--", ".");
  git("clean", "-fdq");
});
afterAll(() => {
  for (const dir of [repo, ...stores]) rmSync(dir, { recursive: true, force: true });
});

describe("the keep rule's checks", () => {
  it("uses the numbers: the try's ticks, ticks 0-2,399 of the seated Wide Plain 768 start on three seeds, and the scoped replay tests", () => {
    expect({ TRY_TICKS, REPLAY_SEEDS, REPLAY_TICKS, REPLAY_START }).toEqual({ TRY_TICKS: 50, REPLAY_SEEDS: [7, 8, 9], REPLAY_TICKS: 2_400, REPLAY_START: { map: "wide-plain", perSide: 768 } });
    expect([SCOPED_REPLAY_TESTS.command, ...SCOPED_REPLAY_TESTS.args].join(" ")).toBe("./node_modules/.bin/vitest run --maxWorkers=2 test/sim/neighbour-search.test.ts test/sim/grid-tracker.test.ts test/sim/world.test.ts test/sim/point-rest-intent.test.ts test/sim/fighter-priorities.test.ts test/sim/soft-movement.test.ts test/sim/finer-grid-physics.test.ts test/sim/replay.test.ts test/sim/assignment-hold.test.ts test/sim/food-target-hold.test.ts test/sim/worker-guards.test.ts test/sim/advance.test.ts");
  });

  it("keeps a faster candidate whose replays match and whose tests pass, advancing its lane to it", async () => {
    // The lane's version 1 carries an injected delay; the candidate removes it, so it plays identically.
    const store = freshStore(), delay = patchOf("src/sim/step.ts", DELAY_FROM, DELAY_TO);
    store.advanceLane(LANE, 0, { patch: delay, medianTickMs: 12, agentId: "slow-agent" });
    writeFileSync(join(repo, "try-result.json"), "{}"); // outside src/: never part of the edit
    const outcome = await decideKeep(options(store));
    expect(outcome.decision).toBe("keep");
    expect(outcome.reasons).toEqual([]);
    expect(outcome.patch).toContain("src/sim/step.ts");
    expect(outcome.patch).not.toContain("try-result.json");
    expect(outcome.replays.map(run => [run.name, run.ticks, run.mismatch])).toEqual([["try", 10, null], ["seed 7", 15, null]]);
    expect(outcome.scopedTests?.status).toBe(0);
    expect(outcome.kept).toMatchObject({ lane: LANE, version: 2, baseCommit: base, patches: [delay, outcome.patch], medianTickMs: outcome.medianTickMs, agentId: "agent-1" });
    expect(store.baseline(LANE)).toEqual(outcome.kept);
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "keep", baselineVersion: 1, baselineMedianTickMs: 12, patch: outcome.patch })]);
    // The new baseline and the try record carry the workload, timing method included, the kept tick time was measured on.
    expect(outcome.kept!.workload).toEqual(VERDICT.workload);
    expect(store.tries({ agentId: "agent-1" })[0]!.workload).toEqual(VERDICT.workload);
  }, 60_000);

  it.each([
    ["slower", 10.5, /^slower: median tick 10.5 ms against the lane version 0 baseline 10 ms$/],
    ["unchanged in time", 10, /^within the noise: .* gain of 0.00%, not more than the noise 2.00%$/],
    ["faster but within the noise", 9.85, /^within the noise: .* gain of 1.50%, not more than the noise 2.00%$/],
  ])("drops a %s candidate without replaying it", async (_name, medianTickMs, reason) => {
    const store = freshStore();
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const outcome = await decideKeep(options(store, { tried: tried(store, { medianTickMs }) }));
    expect(outcome.decision).toBe("drop");
    expect(outcome.reasons).toEqual([expect.stringMatching(reason)]);
    expect([outcome.replays, outcome.scopedTests]).toEqual([[], null]);
    expect(store.baseline(LANE)!.version).toBe(0);
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "drop", reasons: outcome.reasons, medianTickMs })]);
  });

  it("drops a candidate with no change under src/ from the lane version, however fast it timed", async () => {
    const store = freshStore();
    writeFileSync(join(repo, "notes.md"), "not simulation code");
    const outcome = await decideKeep(options(store));
    expect(outcome).toMatchObject({ decision: "drop", reasons: ["unchanged: no change under src from lane version 0"], patch: "", replays: [] });
    expect(store.tries({ agentId: "agent-1" })[0]).toMatchObject({ decision: "drop" });
  });

  it("drops a candidate that changes a simulated value during the try, naming the tick and path", async () => {
    const store = freshStore();
    // The checkpoint is at tick 20; the try replays ticks 20-29.
    edit("src/sim/step.ts", "  state.tick = tick + 1;\n", "  state.tick = tick + 1;\n  if (tick === 25) state.nextMarkId += 1;\n");
    const outcome = await decideKeep(options(store));
    expect(outcome.decision).toBe("drop");
    expect(outcome.replays.map(run => [run.name, run.ticks, run.mismatch])).toEqual([["try", 6, { tick: 25, part: "state", path: "/nextMarkId" }]]);
    expect(outcome.reasons).toEqual(["changes a simulated value: try replay differs from the lane version at tick 25, state /nextMarkId"]);
    expect(outcome.scopedTests).toBeNull();
    expect(store.baseline(LANE)!.version).toBe(0);
    expect(store.tries({ agentId: "agent-1" })[0]).toMatchObject({ decision: "drop", reasons: outcome.reasons, patch: outcome.patch });
  }, 60_000);

  it("drops a candidate that matches over the try but changes a value on a seed replay", async () => {
    // Only the match start differs, which a reloaded checkpoint never runs.
    const store = freshStore();
    edit("src/sim/map.ts", "      foodStore: 0,\n", "      foodStore: 1,\n");
    const outcome = await decideKeep(options(store, { seeds: [7, 8] }));
    expect(outcome.decision).toBe("drop");
    expect(outcome.replays.map(run => [run.name, run.mismatch])).toEqual([["try", null], ["seed 7", { tick: 0, part: "state", path: "/colonies/0/foodStore" }]]);
    expect(outcome.reasons).toEqual(["changes a simulated value: seed 7 replay differs from the lane version at tick 0, state /colonies/0/foodStore"]);
    expect(outcome.scopedTests?.status).toBe(0);
  }, 60_000);

  it("drops a candidate whose scoped replay tests fail, before the seed replays", async () => {
    const store = freshStore();
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const outcome = await decideKeep(options(store, { scopedTests: { command: process.execPath, args: ["-e", "process.exit(1)"] } }));
    expect(outcome.decision).toBe("drop");
    expect(outcome.reasons).toEqual([expect.stringMatching(/^the scoped replay tests failed \(exit 1\): /)]);
    expect(outcome.replays.map(run => run.name)).toEqual(["try"]);
    expect(store.baseline(LANE)!.version).toBe(0);
  }, 60_000);
});

describe("a try's timing is judged only for its own candidate and workload", () => {
  /** A refused try is dropped before anything is replayed, and the lane stays where it was. */
  function expectRefused(store: Store, outcome: Awaited<ReturnType<typeof decideKeep>>, reason: RegExp): void {
    expect(outcome.decision).toBe("drop");
    expect(outcome.reasons).toEqual([expect.stringMatching(reason)]);
    expect([outcome.replays, outcome.scopedTests, outcome.kept]).toEqual([[], null, null]);
    expect(store.baseline(LANE)!.version).toBe(0);
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "drop", reasons: outcome.reasons })]);
  }

  it("refuses a try timed on a different edit: src changed after timing, even in a way that plays the same", async () => {
    const store = freshStore();
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const timed = tried(store);
    edit("src/sim/geometry.ts", "export", "// edited after the try\nexport");
    const outcome = await decideKeep(options(store, { tried: timed }));
    expectRefused(store, outcome, /^refused: the try timed src tree [0-9a-f]{40}, but this candidate's src is tree [0-9a-f]{40}; time this candidate with try\.ts before keeping it$/);
    expect(outcome.reasons[0]).toContain(timed.candidate);
  });

  it.each([
    ["a different tick window", () => tryWorkload(checkpointText, TRY - 1), /^refused: the try timed 9 ticks of checkpoint [0-9a-f]{64}, but the noise check that the lane baselines rest on timed 10 ticks of checkpoint [0-9a-f]{64}; /],
    ["a different checkpoint", () => tryWorkload(`${checkpointText}\n`, TRY), /^refused: the try timed 10 ticks of checkpoint [0-9a-f]{64}, but the noise check that the lane baselines rest on timed 10 ticks of checkpoint [0-9a-f]{64}; /],
  ])("refuses a try timed on %s from the noise check's", async (_name, workload, reason) => {
    const store = freshStore();
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    expectRefused(store, await decideKeep(options(store, { tried: tried(store, { workload: workload() }) })), reason);
  });

  it("refuses a try timed with another timing method than the noise check's", async () => {
    const store = freshStore();
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const cold = tryWorkload(checkpointText, TRY, { warmup: 0, repeats: 1 });
    expectRefused(store, await decideKeep(options(store, { tried: tried(store, { workload: cold }) })),
      /^refused: the try's timing method \(0 discarded runs, then the median of 1 timed runs\) is not that of the noise check the lane baselines rest on \(10 discarded runs, then the median of 5 timed runs\); time this candidate with try\.ts before keeping it$/);
  });

  it("refuses a try when the keep would replay another checkpoint than the one it timed", async () => {
    const store = freshStore();
    store.putCheckpoint("other", `${checkpointText}\n`);
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const outcome = await decideKeep(options(store, { checkpointName: "other" }));
    expectRefused(store, outcome, /^refused: the try timed checkpoint [0-9a-f]{64}, but this keep replays checkpoint [0-9a-f]{64}; /);
  });

  it.each([
    ["one from before try results named their candidate and workload", (result: TryResult) => { const { candidate: _c, workload: _w, ...old } = result; return old as TryResult; }, /\(candidate, workload missing or invalid\)/],
    ["a non-positive tick time", (result: TryResult) => ({ ...result, medianTickMs: 0 }), /\(medianTickMs missing or invalid\)/],
    ["one whose workload records no timing method", (result: TryResult) => ({ ...result, workload: { checkpoint: result.workload.checkpoint, ticks: result.workload.ticks } as TryResult["workload"] }), /\(workload missing or invalid\)/],
  ])("does not judge a malformed try result: %s", async (_name, malform, reason) => {
    const store = freshStore();
    await expect(decideKeep(options(store, { tried: malform(tried(store)) }))).rejects.toThrow(reason);
    expect(store.tries()).toEqual([]);
  });

  it("refuses every try when the noise verdict recorded no workload", async () => {
    const { workload: _w, ...unbound } = VERDICT;
    const store = freshStore(unbound);
    await expect(decideKeep(options(store))).rejects.toThrow(/the noise check recorded no workload/);
  });

  it.each([
    ["at the lane's current version", false],
    ["at a version another keep has since advanced past", true],
  ])("judges a try %s against the baseline the store holds, never the baseline figure the try carries", async (_name, advanced) => {
    const store = freshStore(), other = patchOf("src/sim/geometry.ts", "export", "// other agent's edit\nexport");
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    // Against the stored version 0 baseline (10 ms) this is a 0.5% gain, inside the 2% noise; against the figure it carries it would be 99%.
    const timed = tried(store, { baselineMedianTickMs: 1_000, medianTickMs: 9.95 });
    if (advanced) store.advanceLane(LANE, 0, { patch: other, medianTickMs: 9, agentId: "agent-2" });
    const outcome = await decideKeep(options(store, { tried: timed }));
    expect(outcome.decision).toBe("drop");
    expect(outcome.reasons).toEqual(["within the noise: median tick 9.95 ms against the lane version 0 baseline 10 ms is a gain of 0.50%, not more than the noise 2.00%"]);
    expect(outcome.baseline).toMatchObject({ version: 0, medianTickMs: 10, agentId: "noise-check" });
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "drop", baselineVersion: 0, baselineMedianTickMs: 10 })]);
  });

  it.each([
    // Lane version 1 shortens the loop's Wide Plain to 5 ticks: a reloaded checkpoint keeps its own match length, a seated
    // start does not. The loop pins its Wide Plain limits in seated.ts, so that is where the lane shortens it.
    ["a seed replay", "test/tuning/seated.ts", "colonyCap: 768, matchTicks: 27_000 }", "colonyCap: 768, matchTicks: 5 }",
      [["try", 10, null], ["seed 7", 5, null]], "incomplete: the seed 7 replay ended after 5 of its 15 ticks, when the match ended; a replay that does not complete its ticks is not a match"],
    // Lane version 1 ends every match at tick 24, inside the try's ticks 20-29.
    ["the try replay", "src/sim/step.ts", "(stopNow || tick + 1 >= config.matchTicks)", "(stopNow || tick + 1 >= config.matchTicks || tick === 24)",
      [["try", 5, null]], "incomplete: the try replay ended after 5 of its 10 ticks, when the match ended; a replay that does not complete its ticks is not a match"],
  ])("drops a candidate when %s ends before all its ticks are compared, though no value differs", async (_name, file, from, to, runs, reason) => {
    const store = freshStore(), ending = patchOf(file, from, to);
    store.advanceLane(LANE, 0, { patch: ending, medianTickMs: 12, agentId: "slow-agent" });
    edit(file, from, to); // the candidate is the lane version plus its own edit
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const outcome = await decideKeep(options(store));
    expect(outcome.decision).toBe("drop");
    expect(outcome.replays.map(run => [run.name, run.ticks, run.mismatch])).toEqual(runs);
    expect(outcome.reasons).toEqual([reason]);
    expect(store.baseline(LANE)!.version).toBe(1);
  }, 60_000);
});

describe("two keeps racing in one lane", () => {
  it("a candidate timed against an older lane version is re-tried on the new one when its edit still applies", async () => {
    const store = freshStore(), other = patchOf("src/sim/geometry.ts", "export", "// other agent's edit\nexport");
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const timed = tried(store);
    store.advanceLane(LANE, 0, { patch: other, medianTickMs: 9, agentId: "agent-2" });
    const outcome = await decideKeep(options(store, { tried: timed }));
    expect(outcome).toMatchObject({ decision: "retry", record: null, kept: null, retryOn: { version: 1, agentId: "agent-2" }, replays: [] });
    expect(outcome.patch).toContain("src/sim/rng.ts");
    expect(store.tries({ agentId: "agent-1" })).toEqual([]);
  });

  it("a candidate timed against an older lane version is dropped when its edit no longer applies on the new one", async () => {
    const store = freshStore(), other = patchOf("src/sim/rng.ts", RNG_LINE, `${RNG_LINE} (other agent)`);
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE} (this agent)`);
    const timed = tried(store);
    store.advanceLane(LANE, 0, { patch: other, medianTickMs: 9, agentId: "agent-2" });
    const outcome = await decideKeep(options(store, { tried: timed }));
    expect(outcome).toMatchObject({ decision: "drop", reasons: ["lane soft-separation advanced to version 1 and the patch no longer applies on it"] });
    expect(store.baseline(LANE)!.agentId).toBe("agent-2");
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "drop", baselineVersion: 0 })]);
  });

  it("a keep that loses the compare-and-swap after its checks is re-tried on the winner's version", async () => {
    const store = freshStore(), other = patchOf("src/sim/geometry.ts", "export", "// other agent's edit\nexport");
    const racing: Store = { ...store, advanceLane: (lane, from, kept) => {
      store.advanceLane(lane, from, { patch: other, medianTickMs: 9, agentId: "agent-2" });
      return store.advanceLane(lane, from, kept);
    } };
    edit("src/sim/rng.ts", RNG_LINE, `${RNG_LINE}\n// faster`);
    const outcome = await decideKeep(options(racing));
    expect(outcome).toMatchObject({ decision: "retry", kept: null, retryOn: { version: 1, agentId: "agent-2", patches: [other] } });
    expect(outcome.replays.map(run => run.mismatch)).toEqual([null, null]);
    expect(store.keptEdits(LANE).map(version => version.agentId)).toEqual(["agent-2"]);
  }, 60_000);
});

describe("the keep.ts entry", () => {
  const entry = (args: string[]) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--import", join(ROOT, "src", "ts-resolve.mjs"), join(ROOT, "test", "tuning", "keep.ts"), ...args],
    { cwd: repo, encoding: "utf8" });

  it("judges the try file against the store, prints the outcome and exits 2 for a drop", () => {
    const store = freshStore(), tryFile = join(stores.at(-1)!, "try-result.json");
    writeFileSync(tryFile, JSON.stringify(tried(store, { medianTickMs: 11 })));
    const run = entry(["--store", stores.at(-1)!, "--try", tryFile]);
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({ decision: "drop", reasons: [expect.stringMatching(/^slower: /)], agentId: "agent-1", lane: LANE, patchBytes: 0 });
    expect(store.tries({ agentId: "agent-1" })).toEqual([expect.objectContaining({ decision: "drop" })]);
  });

  it("exits 1 with its usage when the store or try file is missing", () => {
    const run = entry([]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^usage: keep.ts --store <dir> --try <try-result.json>/);
  });
});

describe("the shared baseline", () => {
  it("is not used before the four-run noise check has settled, or when it failed", async () => {
    const unsettled = freshStore(null);
    await expect(decideKeep(options(unsettled, { tried: tried(freshStore()) }))).rejects.toThrow(/noise check has not settled/);
    const failed = freshStore({ ...VERDICT, spread: 0.08, pass: false });
    await expect(decideKeep(options(failed, { tried: tried(freshStore()) }))).rejects.toThrow(/noise check failed \(spread 8.00% against limit 5.00%\): the shared baseline is not used/);
  });
});
