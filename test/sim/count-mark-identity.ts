/**
 * Explicitly scheduled identity proof, never part of the ordinary test suite.
 * node --import ./src/ts-resolve.mjs test/sim/count-mark-identity.ts --run --candidate FULL_SHA --out out/FRESH_DIRECTORY
 * Runs the real pinned balance driver, feeding the identical input trace to two
 * independent candidate states. A test-only loader observes baseline step calls;
 * no production hook, copied strategy, state normalization or digest-only equality.
 */
import { strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BalanceStrategy } from "../tools/balance.ts";
import type { SimConfig } from "../../src/sim/config.ts";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.ts";

export const IDENTITY_BASELINE = "2762dc3d40306b175bc22c7c1ce3bda5ab97deb5";
const OBSERVER = "antwar.count-mark-identity.baseline-step";
type Observer = (args: [state: SimState, inputs?: readonly SimInput[]], out: StepOutput) => void;
const observers = globalThis as typeof globalThis & { [OBSERVER]?: Observer };
export interface IdentityCase {
  seed: number;
  strategies: readonly [BalanceStrategy, BalanceStrategy];
  handicap?: 0 | 1;
  scripted?: boolean;
  swapped?: boolean;
}

/** Same normal/handicap pairings as the existing sweep, plus explicit mark scripts. */
export function identityCases(strategies: readonly BalanceStrategy[], seeds: readonly number[] = [7001, 7002, 7003, 7004]): IdentityCase[] {
  const cases: IdentityCase[] = [];
  for (let i = 0; i < strategies.length; i++) for (let j = i + 1; j < strategies.length; j++) {
    for (const seed of seeds) for (const swapped of [false, true]) cases.push({ seed,
      strategies: swapped ? [strategies[j]!, strategies[i]!] : [strategies[i]!, strategies[j]!] });
  }
  for (const pair of [["workers", "soldier-heavy"], ["mixed", "strike"], ["count-mark army", "rush"]] as const) {
    for (const seed of seeds) for (const swapped of [false, true]) cases.push({ seed,
      strategies: swapped ? [pair[1], pair[0]] : pair, handicap: swapped ? 1 : 0 });
  }
  for (const seed of seeds) for (const swapped of [false, true]) cases.push({ seed,
    strategies: ["count-mark army", "count-mark army"], scripted: true, swapped });
  return cases;
}

export function assertStateBytes(baseline: SimState, candidate: SimState, context: string): string {
  const expected = JSON.stringify(baseline), actual = JSON.stringify(candidate);
  strictEqual(actual, expected, context);
  return expected;
}

export function extractBaseline(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync("git", ["archive", IDENTITY_BASELINE, "src", "package.json"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
}

export async function proveCases(baselineRoot: string, cases: readonly IdentityCase[], options: {
  /** Only for the local harness smoke test, never acceptance evidence. */
  diagnosticTicks?: number;
  completed?: (record: Record<string, unknown>) => void;
  mismatch?: (evidence: Record<string, unknown>) => void;
} = {}): Promise<void> {
  const candidate = await import("../../src/sim/step.ts");
  const candidateMap = await import("../../src/sim/map.ts");
  const baselineStepUrl = pathToFileURL(join(baselineRoot, "src/sim/step.ts")).href;
  const hook = registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== baselineStepUrl) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    const signature = "export function step(";
    if (source.split(signature).length !== 2) throw new Error("Baseline step signature changed; refuse instrumentation");
    return { ...loaded, source: source.replace(signature, "function identityObservedStep(") + `\nexport function step(...args) {\n  const out = identityObservedStep(...args);\n  globalThis[${JSON.stringify(OBSERVER)}]?.(args, out);\n  return out;\n}\n` };
  } });
  try {
    const baselineConfig = await import(pathToFileURL(join(baselineRoot, "src/sim/config.ts")).href) as typeof import("../../src/sim/config.ts");
    const baselineMap = await import(pathToFileURL(join(baselineRoot, "src/sim/map.ts")).href) as typeof import("../../src/sim/map.ts");
    const baselineEngine = await import(baselineStepUrl) as typeof import("../../src/sim/step.ts");
    const balance = await import(pathToFileURL(join(baselineRoot, "src/playtest/balance.ts")).href) as typeof import("../tools/balance.ts");
    for (const spec of cases) {
      const config: SimConfig = baselineConfig.rulesConfig("redesign");
      if (options.diagnosticTicks !== undefined) Object.assign(config, { matchTicks: options.diagnosticTicks });
      let omitted: SimState | undefined, explicit: SimState | undefined;
      let ticks = 0, countInputs = 0;
      const chain = createHash("sha256");
      observers[OBSERVER] = ([before, inputs = []], out) => {
        if (omitted === undefined || explicit === undefined) {
          omitted = candidateMap.createMatch(spec.seed, before.config);
          if (spec.handicap !== undefined) {
            let n = 0;
            omitted.ants = omitted.ants.filter(ant => ant.colony !== spec.handicap || n++ % 2 === 0);
          }
          explicit = structuredClone(omitted);
          assertStateBytes(before, omitted, "initial state must match without normalization");
          assertStateBytes(before, explicit, "explicit-any initial state must match");
        }
        countInputs += inputs.filter(input => input.type === "count_mark").length;
        omitted = candidate.step(omitted, inputs).state;
        explicit = candidate.step(explicit, inputs.map(input => input.type === "count_mark" ? { ...input, caste: "any" } : input)).state;
        try {
          const bytes = assertStateBytes(out.state, omitted, `omitted differs at tick ${out.state.tick}`);
          assertStateBytes(out.state, explicit, `explicit any differs at tick ${out.state.tick}`);
          chain.update(bytes).update("\n");
        } catch (error) {
          options.mismatch?.({ spec, tick: out.state.tick, inputs, baseline: out.state, omitted, explicit });
          throw error;
        }
        ticks++;
      };
      if (spec.scripted) {
        let state = baselineMap.createMatch(spec.seed, config);
        const verbs = ["GATHER", "FORAGE", "DEFEND", "ATTACK"] as const;
        while (state.result === null) {
          const inputs: SimInput[] = [];
          for (const side of [0, 1] as const) {
            const placement = spec.swapped ? (1 - side) as 0 | 1 : side;
            const agentId = `script-${side}`;
            if (state.tick === 0) inputs.push({ type: "join", agentId, placement });
            if (state.tick % config.commandFloorTicks === 1) inputs.push({ type: "count_mark", agentId,
              verb: verbs[(Math.floor(state.tick / config.commandFloorTicks) + side) % verbs.length]!, count: 12 });
          }
          state = baselineEngine.step(state, inputs).state;
        }
      } else balance.playBalanceMatch({ ...spec, config, founding: "shared" });
      if (ticks === 0) throw new Error("No baseline ticks observed; refuse an empty identity proof");
      options.completed?.({ ...spec, ticks, countInputs, stateChainSha256: chain.digest("hex"),
        diagnostic: options.diagnosticTicks !== undefined, finalResult: omitted!.result });
    }
  } finally { delete observers[OBSERVER]; hook.deregister(); }
}

function sourceDigests(root: string): Record<string, string> {
  const paths = readdirSync(join(root, "src/sim")).filter(path => path.endsWith(".ts")).map(path => `src/sim/${path}`);
  paths.push("test/tools/balance.ts", "test/tools/balance-sweep.mjs");
  return Object.fromEntries(paths.map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
}

async function main(): Promise<void> {
  if (process.argv.includes("--smoke")) {
    const root = resolve(process.argv[process.argv.indexOf("--smoke") + 1]!);
    extractBaseline(root);
    await proveCases(root, [{ seed: 7001, strategies: ["count-mark army", "count-mark army"], scripted: true }],
      { diagnosticTicks: 4, completed: record => console.log(JSON.stringify(record)) });
    return;
  }
  if (!process.argv.includes("--run")) {
    console.log("Requires a scheduled resource window: --run --candidate FULL_SHA --out out/FRESH_DIRECTORY [--from-case N --case-count N]. No proof started.");
    return;
  }
  const arg = (name: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
    return process.argv[index + 1]!;
  };
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  strictEqual(arg("candidate"), head, "candidate must be the exact committed head");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src", "test/sim/count-mark-identity.ts", "test/tools/balance.ts", "test/tools/balance-sweep.mjs"]);
  const out = resolve(arg("out"));
  if (existsSync(out)) throw new Error("Use a fresh output directory; never mix evidence or automatically retry a failed proof");
  mkdirSync(out, { recursive: true });
  const baselineRoot = join(out, "baseline");
  extractBaseline(baselineRoot);
  const { BALANCE_STRATEGIES } = await import("../tools/balance.ts");
  const allCases = identityCases(BALANCE_STRATEGIES);
  const integer = (name: string, fallback: number): number => {
    const value = process.argv.includes(`--${name}`) ? Number(arg(name)) : fallback;
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid --${name}`);
    return value;
  };
  const from = integer("from-case", 0), count = integer("case-count", allCases.length - from);
  if (count < 1 || from + count > allCases.length) throw new Error("Case range exceeds the proof manifest");
  const selected = allCases.slice(from, from + count);
  const source = sourceDigests(process.cwd());
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ baseline: IDENTITY_BASELINE, candidate: head,
    startedAt: new Date().toISOString(), from, totalCases: allCases.length, selected, source,
    comparisons: ["omitted", "explicit any"], equality: "complete JSON.stringify(SimState) bytes every tick; no normalization",
    identicalBaselineConfig: true, founding: "shared", maxConcurrentCases: 1 }, null, 2));
  let completed = 0;
  try {
    await proveCases(baselineRoot, selected, {
      mismatch: evidence => writeFileSync(join(out, "mismatch.json"), JSON.stringify(evidence)),
      completed: record => {
        strictEqual(JSON.stringify(sourceDigests(process.cwd())), JSON.stringify(source), "Source changed during proof");
        appendFileSync(join(out, "cases.jsonl"), JSON.stringify(record) + "\n");
        console.log(JSON.stringify({ completed: ++completed, requested: count, ...record }));
      },
    });
    writeFileSync(join(out, "done.json"), JSON.stringify({ passed: true, completed, requested: count,
      totalCases: allCases.length, completeCoverage: from === 0 && count === allCases.length, endedAt: new Date().toISOString() }));
  } catch (error) {
    writeFileSync(join(out, "done.json"), JSON.stringify({ passed: false, completed, requested: count,
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error), endedAt: new Date().toISOString() }));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
