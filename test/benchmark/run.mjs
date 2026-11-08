// Agency and balance benchmark. Not part of the repository test suite.
//
//   npx tsc -p test/benchmark && node test/benchmark/run.mjs [--seeds final|rerun|tuning|final1|rerun1|final2|rerun2|final3|rerun3]
//                                                            [--suite all|balance|agency|control|idle]
//                                                            [--config '{"sightTiles":6}']
//
// --seeds final (the default) is the reported run, each suite on its own fresh
// set: balance and win types on
// final5-house, idle join on final5-idle, agency on final5-agency, control on
// final5-control. --seeds rerun is the one near-miss rerun of agency on rerun5,
// run only by hand after a near miss of agency at 10 s; nothing reruns
// automatically. The report prints the commit and the git tree ids of src/sim
// and test/benchmark it ran from.
// Any other set name runs --suite (default all) on that set. --config overlays
// values on the config module's DEFAULT_CONFIG for tuning sweeps only; reported
// results use the committed config. Exits 1 if any check fails.
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../../dist/benchmark/src/sim/config.js";
import { SEED_SETS, runSuites } from "../../dist/benchmark/test/benchmark/suites.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const seedsArg = arg("seeds", "final");
const patch = JSON.parse(arg("config", "{}"));
const config = { ...DEFAULT_CONFIG, ...patch };

/** The runs to make: [suite, seed set] pairs. */
const plan =
  seedsArg === "final"
    ? [["balance", "final5-house"], ["idle", "final5-idle"], ["agency", "final5-agency"], ["control", "final5-control"]]
    : seedsArg === "rerun"
      ? [["agency", "rerun5"]]
      : [[arg("suite", "all"), seedsArg]];
for (const [, name] of plan) {
  if (SEED_SETS[name] === undefined) throw new Error(`unknown seed set ${name}; use final, rerun or one of ${Object.keys(SEED_SETS).join(", ")}`);
}

const started = Date.now();
const reports = plan.flatMap(([suite, name]) =>
  runSuites(suite, {
    seeds: SEED_SETS[name],
    config,
    onMatch: (label, done, total) => {
      if (done === total || done % 10 === 0) process.stderr.write(`  ${label}: ${done}/${total}\n`);
    },
  }),
);

/** git in the working directory, or "unavailable" when no repository is there. */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

const span = (xs) => (xs.length === 0 ? "none" : `${xs[0]}-${xs[xs.length - 1]}`);
const describe = (set) => `house-only ${span(set.house)}, agency/control/idle-join ${span(set.paired)}`;
console.log(`benchmark: seeds ${seedsArg}, config ${Object.keys(patch).length ? `default + ${JSON.stringify(patch)}` : "default"}`);
const dirty = git("status", "--porcelain", "--", "src/sim", "test/benchmark");
console.log(`commit ${git("rev-parse", "HEAD")}; tree src/sim ${git("rev-parse", "HEAD:src/sim")}, test/benchmark ${git("rev-parse", "HEAD:test/benchmark")}${dirty === "" || dirty === "unavailable" ? "" : " (UNCOMMITTED CHANGES in src/sim or test/benchmark)"}`);
console.log(`seed sets (agency, control and idle-join seeds are each played with the agents on colony 0 and on colony 1):`);
console.log(`  tuning (used in tuning, never reported): ${describe(SEED_SETS.tuning)}; earlier probes also used 1-50, 201-250, 1001-1020`);
console.log(`  final1 (held out; reported at head ed3f297, before the mark-refresh fix): ${describe(SEED_SETS.final1)}`);
console.log(`  rerun1 (held out; near-miss rerun of agency at head ed3f297): ${describe(SEED_SETS.rerun1)}`);
console.log(`  final2 (held out; reported at head 8772000, after the mark-refresh fix; retired): ${describe(SEED_SETS.final2)}`);
console.log(`  rerun2 (held out; retired, never played): ${describe(SEED_SETS.rerun2)}`);
console.log(`  final3 (held out; reported after the hold fix: balance, win types and idle join stay on final1, agency and control play here): ${describe(SEED_SETS.final3)}`);
console.log(`  rerun3 (held out; the near-miss rerun of agency at 10 s after final3; spent): ${describe(SEED_SETS.rerun3)}`);
console.log(`  final4 (held out; balance, win types and idle join at head 9711f62; spent): ${describe(SEED_SETS.final4)}`);
for (const name of ["final5-house", "final5-idle", "final5-agency", "final5-control", "rerun5"]) {
  const use = name === "rerun5" ? "reserved for one near-miss rerun of agency at 10 s" : "the reported run";
  console.log(`  ${name} (held out; ${use}): ${describe(SEED_SETS[name])}`);
}
console.log(`earlier held-out runs, labelled by head and seed set (every run kept, as it ran; final1, rerun1 and final2 are VOID):`);
console.log(`  at head ed3f297 (scripted agents did not refresh their marks at 150 s):`);
console.log(`    final1: balance colony 0 24 (48%), colony 1 26 (52%); win types overrun 52%, territory 48%; agency 15/20 at 0 s, 13/20 at 10 s, 18/20 at 30 s; control 0/20; idle join 9/20, 0 squad lapses (VOID: marks not refreshed)`);
console.log(`    rerun1: agency 14/20 at 0 s, 14/20 at 10 s, 19/20 at 30 s (VOID: marks not refreshed)`);
console.log(`  at head 8772000 (marks refreshed; the economy squad stayed on hold after a refresh):`);
console.log(`    final2: agency 17/20 at 0 s, 17/20 at 10 s, 20/20 at 30 s; control 0/20 (VOID: economy squad held)`);
console.log(`    final1: balance colony 0 24 (48%), colony 1 26 (52%); win types overrun 52%, territory 48%; idle join 9/20, 0 squad lapses (VOID: economy squad held)`);
console.log(`  at head 1e99320 (every agent re-plans from every squad state; guardCount 1):`);
console.log(`    final3 (paired 9301-9310): agency 17/20 at 0 s, 13/20 at 10 s (near miss), 20/20 at 30 s; control 0/20`);
console.log(`    balance, win types and idle join: credited to final1 in this run's report, but no output was kept to show they were re-measured at 1e99320; not counted`);
console.log(`  at head 9711f62 (same agents, suites and config as 1e99320; guardCount 1):`);
console.log(`    rerun3 (paired 9801-9810): agency 14/20 at 0 s, 13/20 at 10 s (MISS), 16/20 at 30 s`);
console.log(`    final4 (house 9401-9450, paired 9901-9910): balance colony 0 30 (60%), colony 1 20 (40%); win types overrun 54%, territory 46%; idle join 10/20, 0 squad lapses`);
console.log(`  results of record come from the final5 sets at the head that integrates (guardCount 2)`);
console.log(`this run: ${plan.map(([suite, name]) => `${suite} on ${name}`).join(", ")}`);
let failed = 0;
for (const report of reports) {
  console.log(`\n${report.name}`);
  for (const line of report.lines) console.log(line);
  for (const check of report.checks) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.label}`);
    if (!check.pass) failed += 1;
  }
}
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
process.exitCode = failed === 0 ? 0 : 1;
