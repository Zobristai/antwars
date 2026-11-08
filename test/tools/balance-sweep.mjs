// Node 24: node --import ./src/ts-resolve.mjs test/tools/balance-sweep.mjs --phase preliminary|acceptance --workers 32 --seeds 7001,7002,7003,7004 --expected-head FULL_SHA --out DIRECTORY [--floor-sha FULL_SHA]
// Tuning/acceptance run the committed rules. Diagnostic replay uses a prior completed manifest and must reproduce its measurements.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BALANCE_FOUNDING_POLICY, BALANCE_STRATEGIES, SOLDIER_HEAVY_DEFINITION, balanceActivityTable, balanceSummary, configDigest, earlyCandidates, playBalanceMatch } from "./balance.ts";
import { MAPS, rulesConfig } from "../../src/sim/config.ts";
import { parseHatchArm, selectHatchArm } from "./hatchVariants.ts";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const integer = (name, fallback, max) => {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be a whole number from 1 to ${max}`);
  return value;
};
if (process.argv.includes("--help")) {
  console.log("node --import ./src/ts-resolve.mjs test/tools/balance-sweep.mjs --phase preliminary|acceptance --workers 32 --seeds 7001,7002,7003,7004 --expected-head FULL_SHA --out DIRECTORY [--floor-sha FULL_SHA] [--match-timeout-seconds 3600] [--map open-field|three-crossings|central-lake] [--hatch-arm main|A] [--founding shared|off] [--new-match-config]");
  console.log("All seven strategies and both sides run for every requested seed. The match horizon is always 18000 ticks; natural queen elimination remains a terminal result and is reported at its real tick. Final acceptance requires the merged floor SHA (--floor-sha) and eight matches per pairing. Outputs: manifest.json, matches.jsonl, per-match/*.json, failures/*.json, summary.json, table.md, done.json.");
  console.log("--phase diagnostic --diagnose-existing DIRECTORY replays only anomalous records from a completed sweep using its recorded config; add --diagnose-comebacks to replay all lopsided starts instead. It must reproduce each original result and metric and can never establish acceptance.");
} else if (process.argv.includes("--single")) {
  const spec = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(playBalanceMatch(spec)));
} else {
  const phase = arg("phase", "preliminary");
  if (!["preliminary", "acceptance", "diagnostic"].includes(phase)) throw new Error("Unknown phase");
  const diagnosticDirectory = arg("diagnose-existing", null);
  if ((phase === "diagnostic") !== (diagnosticDirectory !== null)) throw new Error("Diagnostic replay requires both --phase diagnostic and --diagnose-existing DIRECTORY");
  const newMatchDefaults = process.argv.includes("--new-match-config");
  if (phase === "diagnostic" && newMatchDefaults) throw new Error("Diagnostic replay uses its recorded config, not --new-match-config");
  const diagnoseComebacks = process.argv.includes("--diagnose-comebacks");
  if (diagnoseComebacks && phase !== "diagnostic") throw new Error("--diagnose-comebacks requires diagnostic mode and a completed source sweep");
  const workers = integer("workers", "1", 96);
  const timeoutMs = integer("match-timeout-seconds", "3600", 86400) * 1000;
  const seedText = arg("seeds", "7001,7002,7003,7004");
  if (!/^\d+(,\d+)*$/.test(seedText)) throw new Error("--seeds must be a comma-separated list of unsigned integer seeds");
  let seeds = seedText.split(",").map(Number);
  if (seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) || new Set(seeds).size !== seeds.length) throw new Error("Seeds must be unique uint32 values");
  if (phase === "acceptance" && (seeds.length !== 4 || ![7001, 7002, 7003, 7004].every((seed) => seeds.includes(seed)))) {
    throw new Error("Acceptance keeps the fixed seeds 7001,7002,7003,7004, both sides: eight matches per pairing");
  }
  const out = resolve(arg("out", `out/balance-results-${phase}`));
  if (existsSync(out)) throw new Error("Use a fresh output directory; never mix evidence from different heads or passes");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const expectedHead = arg("expected-head", "");
  if (!/^[0-9a-f]{40}$/.test(expectedHead) || head !== expectedHead) throw new Error("--expected-head must name this checkout's exact full HEAD");
  const floorSha = arg("floor-sha", null);
  if (phase === "acceptance") {
    if (!/^[0-9a-f]{40}$/.test(floorSha ?? "")) throw new Error("Acceptance requires the exact merged floor SHA (--floor-sha)");
    execFileSync("git", ["merge-base", "--is-ancestor", floorSha, head]);
  }
  const sourceFiles = [...readdirSync("src/sim").filter((f) => f.endsWith(".ts")).map((f) => `src/sim/${f}`), "test/tools/balance.ts", "test/tools/hatchVariants.ts", "test/tools/balance-sweep.mjs"];
  // The sweep must run committed bytes, not a dirty checkout with a matching label.
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...sourceFiles]);
  const manifest = () => Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  const source = manifest();
  const hatchArm = parseHatchArm(arg("hatch-arm", "A"));
  if (phase === "diagnostic" && process.argv.includes("--hatch-arm")) throw new Error("Diagnostic replay uses its recorded config, not --hatch-arm");
  let founding = arg("founding", "shared");
  if (!["shared", "off"].includes(founding)) throw new Error("--founding must be shared or off");
  if (phase === "diagnostic" && process.argv.includes("--founding")) throw new Error("Diagnostic replay uses its recorded founding policy, not --founding");
  let config = selectHatchArm(rulesConfig("redesign"), hatchArm);
  const mapId = arg("map", null);
  if (mapId !== null) {
    if (!MAPS.some(map => map.id === mapId)) throw new Error(`Unknown --map ${mapId}`);
    config = { ...config, terrain: { ...config.terrain, mapId } };
  }
  // Explicit opt-in: historical and unchanged-main sweeps retain their exact
  // config. The live factory composes physical scaling and the final map shapes.
  if (newMatchDefaults) config = (await import("../../src/sim/gridScale.ts")).newMatchConfig(config);
  let diagnosticSource = null;
  const priorBySpec = new Map();
  const specKey = (entry) => JSON.stringify([entry.seed, entry.strategies, entry.handicap ?? null]);
  const plan = [];
  if (phase === "diagnostic") {
    const priorManifestBytes = readFileSync(join(diagnosticDirectory, "manifest.json"));
    const priorMatchBytes = readFileSync(join(diagnosticDirectory, "matches.jsonl"));
    const priorManifest = JSON.parse(priorManifestBytes.toString());
    const priorDone = JSON.parse(readFileSync(join(diagnosticDirectory, "done.json"), "utf8"));
    const priorRecords = priorMatchBytes.toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (priorDone.disposition !== "complete" || priorDone.exitCode !== 0 || priorRecords.length !== priorManifest.expectedMatches ||
        priorRecords.some((r) => r.configDigest !== configDigest(priorManifest.config)) ||
        priorManifest.configDigest !== configDigest(priorManifest.config)) throw new Error("Diagnostic source is not a complete, consistently pinned successful sweep");
    if (priorManifest.config.countMarks?.releaseEmptyWithReason) throw new Error("This source used retired automatic-release tuning rules; replay it at its original head, not as current acceptance evidence");
    config = priorManifest.config;
    founding = priorManifest.founding ?? "off";
    if (!["shared", "off"].includes(founding)) throw new Error("Unknown founding policy in diagnostic manifest");
    const observedTen = 600 * config.ticksPerSecond;
    for (const record of priorRecords) {
      if (!Number.isInteger(record.seed) || record.strategies.length !== 2 || record.strategies.some((s) => !BALANCE_STRATEGIES.includes(s)) ||
          ![null, 0, 1].includes(record.handicap)) throw new Error("Invalid diagnostic match coordinates");
      if (priorBySpec.has(specKey(record))) throw new Error("Duplicate diagnostic source match");
      priorBySpec.set(specKey(record), record);
      const earlyElimination = record.naturalResult.reason === "queens_killed" && record.naturalEndTick < observedTen;
      if (diagnoseComebacks ? record.handicap !== null :
          record.countMarkAssessment.zeroClaimed > 0 || (!earlyElimination && record.offLaneAtTen.some((v) => v === null)) ||
          record.early.some((e) => e.laterLeadChange)) {
        plan.push({ seed: record.seed, strategies: record.strategies, ...(record.handicap === null ? {} : { handicap: record.handicap }) });
      }
    }
    if (plan.length === 0) throw new Error("No anomalous source matches to diagnose");
    seeds = [...new Set(plan.map((entry) => entry.seed))].sort((a, b) => a - b);
    diagnosticSource = { head: priorManifest.head, configDigest: priorManifest.configDigest,
      manifestDigest: createHash("sha256").update(priorManifestBytes).digest("hex"),
      matchesDigest: createHash("sha256").update(priorMatchBytes).digest("hex") };
  } else {
    for (let i = 0; i < BALANCE_STRATEGIES.length; i++) for (let j = i + 1; j < BALANCE_STRATEGIES.length; j++) {
      for (const seed of seeds) for (const swapped of [false, true]) plan.push({ seed,
        strategies: swapped ? [BALANCE_STRATEGIES[j], BALANCE_STRATEGIES[i]] : [BALANCE_STRATEGIES[i], BALANCE_STRATEGIES[j]] });
    }
    for (const pair of [["workers", "soldier-heavy"], ["mixed", "strike"], ["count-mark army", "rush"]]) {
      for (const seed of seeds) for (const swapped of [false, true]) plan.push({ seed,
        strategies: swapped ? [...pair].reverse() : pair, handicap: swapped ? 1 : 0 });
    }
  }
  if (config.matchTicks !== 18000 || config.ticksPerSecond !== 10) throw new Error("Sweep rules must have a full 18000-tick, 30-minute game horizon");
  mkdirSync(join(out, "per-match"), { recursive: true });
  mkdirSync(join(out, "failures"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ phase, head, floorSha, startedAt: new Date().toISOString(), workers, seeds,
    horizonTicks: 18000, naturalEliminationEndsEarlier: true, minuteTenPopulationFloor: 50, earlyEliminationMinuteTen: "not applicable; excluded from off-lane measurements", soldierHeavy: SOLDIER_HEAVY_DEFINITION,
    source, config, newMatchDefaults, founding, foundingPolicy: BALANCE_FOUNDING_POLICY, mapId, hatchArm: phase === "diagnostic" ? null : hatchArm, configDigest: configDigest(config), diagnosticSource, expectedMatches: plan.length, plan }, null, 2));
  const started = performance.now();
  const records = new Array(plan.length);
  const failures = [];
  let next = 0;
  let completed = 0;
  let disposition = "complete";
  const cleanSource = () => JSON.stringify(source) === JSON.stringify(manifest());
  const checkpoint = (state) => {
    const collected = records.filter(Boolean);
    const summary = { phase, head, floorSha, disposition: state, endedAt: state === "running" ? null : new Date().toISOString(),
      elapsedSeconds: (performance.now() - started) / 1000, workers, seeds, mapId, hatchArm: phase === "diagnostic" ? null : hatchArm, expectedMatches: plan.length, completed: collected.length,
      sourceUnchanged: cleanSource(), failures, config, founding, foundingPolicy: BALANCE_FOUNDING_POLICY, diagnosticSource, ...balanceSummary(collected, config) };
    writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    const table = ["# Battle balance sweep", "", `Head: ${head}`, `Phase: ${phase}; disposition: ${state}; completed: ${collected.length}/${plan.length}.`,
      `Map: ${mapId ?? "seed-selected"}.`, "Game horizon: 18000 ticks (30 minutes); natural eliminations retain their real end tick.", SOLDIER_HEAVY_DEFINITION, "",
      "| Row wins / matches played | " + BALANCE_STRATEGIES.join(" | ") + " |",
      "|---|" + BALANCE_STRATEGIES.map(() => "---:").join("|") + "|",
      ...BALANCE_STRATEGIES.map((row) => "| " + row + " | " + BALANCE_STRATEGIES.map((column) => {
        if (row === column) return "—";
        const cell = summary.cells.find((cell) => cell.row === row && cell.column === column);
        return `${cell.wins}/${cell.played}`;
      }).join(" | ") + " |"), "",
      `Hatch arm: ${phase === "diagnostic" ? "recorded config" : hatchArm}. Dominant strategies (>6/8 against every other): ${JSON.stringify(summary.dominatedBy)}. Complete 8-match cells: ${summary.complete}.`,
      `Strategy win shares: ${JSON.stringify(summary.strategyWins)}.`,
      `Founding: ${founding}. ${BALANCE_FOUNDING_POLICY}`,
      `Founding exposure: ${summary.hatchExperiment.founding.measuredMatches} regular matches measured, ${summary.hatchExperiment.founding.unmeasuredMatches} unmeasured. Per-colony attempts, refusals, live queen histories and additional-queen hatches are retained in summary.json hatchExperiment.founding.colonies and each match's founding field. Zero additional-queen hatches means the founding policy did not exercise extra nests.`,
      `Additional-queen hatches across regular matches: ${summary.hatchExperiment.founding.colonies.reduce((sum, row) => sum + row.additionalQueenHatches, 0)}.`,
      `Match length, completed ticks (median/min/max), effective: ${JSON.stringify(summary.hatchExperiment.effectiveMatchTicks)}; natural: ${JSON.stringify(summary.hatchExperiment.naturalMatchTicks)}.`,
      `Tick-${summary.hatchExperiment.checkpointTick} soldier share and unspent food: retained per colony in summary.json hatchExperiment.colonies and per-match minuteFivePopulation; null is unobserved or zero live ants, never an invented zero.`,
      `Old raw late strict lead changes: ${summary.lateChangesOld}; old raw lopsided comebacks: ${summary.comebacksOld}/${summary.lopsidedMatches}.`,
      `30-second-held late lead changes: ${summary.lateChanges ?? "unmeasured"}; held lopsided comebacks: ${summary.comebacks ?? "unmeasured"}/${summary.lopsidedMatches}. ${summary.leadMeasurement.measuredMatches} matches measured. Lopsided holds: ${JSON.stringify(summary.leadMeasurement.lopsided)}. Ties interrupt a hold; these held counts now govern lead-change acceptance.`,
      ...summary.offLaneByColony.map((c) => `Off-lane failure: seed ${c.seed}, ${c.strategies.join(" / ")}, colony ${c.colony}, share ${c.share ?? "undefined"}; population ${JSON.stringify(c.checkpoint)}.`),
      `Minute-10 off-lane failures: ${summary.offLaneFailures} colonies in ${summary.offLaneFailingMatches} matches; matches missing that checkpoint: ${summary.offLaneMissing}; colonies under 50 ants (separately counted): ${summary.smallColonyCount}; zero-ant checkpoints included in that count: ${summary.zeroAntCheckpoints.length}; early eliminations not applicable and excluded: ${summary.offLaneNotApplicable}.`,
      `Soldier-heavy median longest zero-worker stretch: ${summary.medianHeavyZeroSeconds ?? "unmeasured"} seconds.`,
      `Early-win fire rate: ${summary.earlyFireRate ?? "unmeasured"} (${summary.earlyFired}/${summary.earlyAssessed}); later 30-second-held reversals: ${summary.earlyLaterLeadChanges}. Old raw later lost leads: ${summary.earlyOldLaterLeadChanges} (${summary.earlyOldFired}/${summary.earlyOldAssessed} fired). Game thresholds and firing are unchanged.`,
      `Accepted count marks still unclaimed after 30 seconds: ${summary.countMarkAssessment.zeroClaimed}/${summary.countMarkAssessment.assessed}; share ${summary.countMarkAssessment.zeroClaimedShare ?? "unmeasured"}. Withdrawn: ${summary.countMarkAssessment.withdrawn}; unfinished: ${summary.countMarkAssessment.unfinished}.`,
      `Count-mark refusals: ${summary.countMarkAssessment.dispositions?.refused ?? "unmeasured"}; reasons ${JSON.stringify(summary.countMarkAssessment.dispositions?.refusalReasons ?? null)}. Accepted observations withdrawn by reason: ${JSON.stringify(summary.countMarkAssessment.dispositions?.withdrawalReasons ?? null)} (expiry, replacement, coincident/uncertain or unknown; included in withdrawn above, never counted as claims).`,
      `Unclaimed marks without a matching acceptance-time reason: ${summary.countMarkAssessment.noReason?.unexplained ?? "unmeasured"}; share of assessed accepted marks ${summary.countMarkAssessment.noReason?.shareOfAssessed ?? "unmeasured"}; share of zero-claimed marks ${summary.countMarkAssessment.noReason?.shareOfUnclaimed ?? "unmeasured"}. Cap cases require reported cap room; no-free cases require the exact zero-free message at acceptance. Later deaths, newly eligible ants and missing notices remain unexplained.`,
      summary.silentCountMarkFinding ?? "No assessed unexplained zero-claimed count-mark finding.",
      `Zero-claimed diagnostics: ${summary.zeroClaimedDiagnosed}; previously claimed during observation: ${summary.zeroClaimedPreviouslyClaimed}; post-step availability: ${JSON.stringify(summary.zeroClaimedAvailability)}. Full samples retain colony, mark, acceptance/assessment ticks and population/cap counts. These are post-step snapshots, not inferred claim-pass causes.`,
      ...summary.zeroAntCheckpoints.map((c) => `Zero-ant minute-10 checkpoint: seed ${c.seed}, ${c.strategies.join(" / ")}, colony ${c.colony}, live ${c.live}, off lane ${c.offLane}, live queens ${c.queens}. The ratio is undefined; this colony is counted separately under the 50-ant floor, not assigned a passing ratio.`),
      ...balanceActivityTable(summary.seatActivity),
      `Early-win candidates (each keeps the same no-reversal criterion): ${JSON.stringify(summary.earlyCandidateSummary)}.`,
      `Acceptance: ${phase === "acceptance" && state === "complete" && summary.accepted ? "criteria satisfied" : "not established"}.`,
      "Full per-colony checkpoint and zero-worker measurements are retained in matches.jsonl and per-match/*.json.", "",
      "## Natural eliminations", "",
      "| Seed | Strategies (colony 0 / colony 1) | Handicapped colony | End event tick | Completed ticks | Minute-10 measurement |",
      "|---:|---|---|---:|---:|---|",
      ...summary.eliminationMatches.map((match) => `| ${match.seed} | ${match.strategies.join(" / ")} | ${match.handicap ?? "none"} | ${match.endTick} | ${match.completedTicks} | ${match.minuteTenStatus === "not_applicable_elimination" ? "not applicable: eliminated before minute 10" : match.minuteTenStatus} |`),
      ...(summary.eliminationMatches.length === 0 ? ["No natural eliminations in the completed matches."] : []), ""];
    writeFileSync(join(out, "table.md"), table.join("\n"));
    return summary;
  };
  async function runOne(index, entry) {
    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tools/balance-sweep.mjs", "--single"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false, failure = null;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text) => { stdout += text; if (stdout.length > 4 * 1024 * 1024) { failure = "output_limit"; child.kill("SIGTERM"); } });
      child.stderr.on("data", (text) => { stderr = (stderr + text).slice(-65536); });
      child.on("error", (error) => { failure = error.message; });
      child.on("close", (status, signal) => { clearTimeout(timer); resolveResult({ status, signal, stdout, stderr, timedOut, failure }); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ ...entry, config, founding, earlyCandidates: earlyCandidates(config) }));
    });
    let record;
    try {
      if (result.status !== 0 || result.failure !== null || result.timedOut) throw new Error(result.failure ?? (result.timedOut ? "match_timeout" : "execution_failed"));
      if (!cleanSource()) throw new Error("source_changed");
      record = JSON.parse(result.stdout);
      if (record.founding?.policy !== founding || record.seed !== entry.seed || record.configDigest !== configDigest(config) || JSON.stringify(record.strategies) !== JSON.stringify(entry.strategies) || record.handicap !== (entry.handicap ?? null)) throw new Error("result_pin_mismatch");
      if (config.terrain?.mapId !== undefined && record.mapId !== config.terrain.mapId) throw new Error("result_map_mismatch");
      if (phase === "diagnostic") {
        const prior = priorBySpec.get(specKey(entry));
        for (const field of ["naturalResult", "naturalEndTick", "early", "leadChangesAfterTen", "handicapComebackAfterTen", "offLaneAtTen", "longestZeroWorkerTicks", "acceptedCommands", "rejectedCommands", "countMarkAssessment", ...(prior.founding === undefined ? [] : ["founding"])]) {
          if (JSON.stringify(record[field]) !== JSON.stringify(prior[field])) throw new Error(`diagnostic_replay_mismatch:${field}`);
        }
      }
    } catch (error) {
      const failure = { index, entry, status: result.status, signal: result.signal, timedOut: result.timedOut, error: String(error), stderr: result.stderr };
      failures.push(failure);
      disposition = result.timedOut ? "match_timeout" : "execution_failed";
      writeFileSync(join(out, "failures", `${index}.json`), JSON.stringify(failure, null, 2));
      return;
    }
    records[index] = record;
    completed++;
    writeFileSync(join(out, "per-match", `${index}.json`), JSON.stringify({ index, ...record }, null, 2));
    appendFileSync(join(out, "matches.jsonl"), JSON.stringify({ index, ...record }) + "\n");
    process.stdout.write(`${completed}/${plan.length} ${entry.strategies.join(" vs ")} seed=${entry.seed} handicap=${entry.handicap ?? "none"} seconds=${record.computeSeconds.toFixed(2)}\n`);
    checkpoint("running");
  }
  async function worker() {
    while (disposition === "complete") {
      const index = next++;
      if (index >= plan.length) return;
      if (!cleanSource()) { disposition = "source_changed"; return; }
      await runOne(index, plan[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, plan.length) }, worker));
  const summary = checkpoint(disposition);
  const accepted = phase === "acceptance" && disposition === "complete" && summary.accepted;
  const exitCode = disposition !== "complete" ? 2 : phase === "acceptance" && !accepted ? 1 : 0;
  writeFileSync(join(out, "done.json"), JSON.stringify({ disposition, endedAt: summary.endedAt, exitCode, accepted }));
  process.stdout.write(JSON.stringify({ disposition, completed, expected: plan.length, elapsedSeconds: summary.elapsedSeconds, out, exitCode }) + "\n");
  process.exitCode = exitCode;
}
