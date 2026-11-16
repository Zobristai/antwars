/**
 * Test plan check 10, whole matches: house-only matches (no agent seats), three fixed seeds on every map of the
 * new-match rotation, under the served rules (rules 28, Kain's unit numbers) and, with the same maps and seeds, under
 * today's rules (rules 27, test/rules27.ts). Every match must end by today's ending rules, the existing win and
 * time-up rules, without an engine error. Each match's length and margin are reported against today's, not
 * asserted: every unit's numbers change, so they are expected to differ. House colonies never set flyer brood, so
 * this measures the unit numbers, not flyers.
 *
 * The 42 matches take hours of CPU time, beyond a scoped run's limit and the full suite's budget, so they play only
 * when ANTWAR_CHECK10=1 is set, each in its own process (check10-match.ts), ANTWAR_CHECK10_WORKERS at a time
 * (default: one per CPU):
 *   ANTWAR_CHECK10=1 npx vitest run test/sim/check10-house-matches.test.ts
 * The rules-28-against-27 table is printed when they finish. With ANTWAR_CHECK10_DIR set, each finished match's
 * summary is kept there and a rerun with the same directory plays only the matches it does not hold, so an
 * interrupted run resumes; use a fresh directory for each tree.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rulesConfig, rulesVersionOf } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { newMatchMaps } from "../../src/sim/mapShapes.js";
import type { WinReason } from "../../src/sim/types.js";
import { rules27Redesign } from "../rules27.ts";
import type { MatchSummary } from "./check10-match.ts";

const RUN = process.env.ANTWAR_CHECK10 === "1";
const WORKERS = Number(process.env.ANTWAR_CHECK10_WORKERS ?? availableParallelism());
const KEEP_DIR = process.env.ANTWAR_CHECK10_DIR;
const SEEDS = [1, 2, 3] as const;
const RULES = [28, 27] as const;
/** Today's ending rules: the win and time-up results a match with no seats can reach. */
const TODAYS_END_REASONS: readonly WinReason[] = ["overrun", "double_overrun", "queens_killed", "sustained_territory", "time_up"];
const TODAYS_DECIDED_BY = ["overrun", "territory", "ants_alive", "food_delivered", "draw", "queens_killed", "kills"];

interface Match { readonly rules: 28 | 27; readonly mapId: string; readonly matchTicks: number; readonly seed: number }
type Outcome = { readonly summary: MatchSummary } | { readonly error: string };

/** Each map with its own match length, longest first so the longest matches start first. */
const MAPS = newMatchMaps().map(map => ({ id: map.id, matchTicks: map.matchTicks ?? rulesConfig("redesign").matchTicks }))
  .sort((a, b) => b.matchTicks - a.matchTicks);
const MATCHES: readonly Match[] = MAPS.flatMap(map => SEEDS.flatMap(seed => RULES.map(rules => ({ rules, mapId: map.id, matchTicks: map.matchTicks, seed }))));
const key = (m: { rules: number; mapId: string; seed: number }) => `${m.mapId} seed ${m.seed} rules ${m.rules}`;
const outcomes = new Map<string, Outcome>();

const runner = fileURLToPath(new URL("./check10-match.ts", import.meta.url));
const tsResolve = fileURLToPath(new URL("../../src/ts-resolve.mjs", import.meta.url));

function play(match: Match): Promise<Outcome> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", tsResolve, runner, String(match.rules), match.mapId, String(match.seed)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-16_384); });
    child.on("error", error => resolve({ error: error.message }));
    child.on("close", (status, signal) => resolve(status === 0
      ? { summary: JSON.parse(stdout) as MatchSummary }
      : { error: `exit ${status ?? signal}: ${stderr.trim()}` }));
  });
}

/** A match's kept summary in ANTWAR_CHECK10_DIR, if it holds one; otherwise plays it and keeps a finished summary. */
async function keptOrPlay(match: Match): Promise<Outcome> {
  if (KEEP_DIR === undefined) return play(match);
  const file = join(KEEP_DIR, `${match.mapId}-seed${match.seed}-rules${match.rules}.json`);
  if (existsSync(file)) return { summary: JSON.parse(readFileSync(file, "utf8")) as MatchSummary };
  const outcome = await play(match);
  if ("summary" in outcome) writeFileSync(file, `${JSON.stringify(outcome.summary)}\n`);
  return outcome;
}

async function playAll(): Promise<void> {
  if (KEEP_DIR !== undefined) mkdirSync(KEEP_DIR, { recursive: true });
  const queue = [...MATCHES];
  const worker = async () => {
    for (let match = queue.shift(); match !== undefined; match = queue.shift()) outcomes.set(key(match), await keptOrPlay(match));
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(WORKERS, queue.length)) }, worker));
}

const pair = (values: readonly [number, number]) => `${values[0]} / ${values[1]}`;

/** The rules-28-against-27 report: per map and seed, each rule set's length, result, margin and end state. */
function report(): string {
  const lines = [
    "Check 10: house-only matches, rules 28 (Kain's numbers) against rules 27 (today's)",
    "| Map | Seed | Rules | Length (ticks) | Winner | Reason | Decided by | Margin | Territory (0 / 1) | Ants alive (0 / 1) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const map of newMatchMaps()) for (const seed of SEEDS) for (const rules of RULES) {
    const outcome = outcomes.get(key({ rules, mapId: map.id, seed }));
    const cells = outcome === undefined ? ["not played"]
      : "error" in outcome ? [`engine error: ${outcome.error.split("\n")[0]}`]
        : [outcome.summary.ticks, outcome.summary.result.winner ?? "draw", outcome.summary.result.reason, outcome.summary.result.decidedBy,
          `${outcome.summary.margin} ${outcome.summary.quantity}`, pair(outcome.summary.territory), pair(outcome.summary.antsAlive)];
    lines.push(`| ${map.id} | ${seed} | ${rules} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

describe.runIf(RUN)("check 10: house-only matches under Kain's numbers against today's", () => {
  beforeAll(playAll, 12 * 3_600_000);
  afterAll(() => console.log(report()));

  it("plays the served rules as rules 28 and today's rules as rules 27", () => {
    expect(rulesVersionOf(newMatchConfig(rulesConfig("redesign")))).toBe(28);
    expect(rulesVersionOf(newMatchConfig(rules27Redesign()))).toBe(27);
  });

  for (const match of MATCHES) {
    it(`${key(match)} ends by today's rules without an engine error`, () => {
      const outcome = outcomes.get(key(match));
      expect(outcome).toBeDefined();
      if (outcome === undefined || "error" in outcome) throw new Error(`${key(match)}: ${outcome?.error ?? "not played"}`);
      const { summary } = outcome;
      expect([summary.rulesVersion, summary.mapId, summary.seed, summary.matchTicks]).toEqual([match.rules, match.mapId, match.seed, match.matchTicks]);
      expect(summary.matchEnds).toBe(1);
      expect(TODAYS_END_REASONS).toContain(summary.result.reason);
      expect(TODAYS_DECIDED_BY).toContain(summary.result.decidedBy);
      expect(summary.result.tick).toBe(summary.ticks - 1);
      expect(summary.ticks).toBeLessThanOrEqual(summary.matchTicks);
      if (summary.result.reason === "time_up") expect(summary.ticks).toBe(summary.matchTicks);
    });
  }
});
