import type { SimConfig } from "../../src/sim/config.js";
import { economyScoutAgent, frontAgent, idleAgent, randomMarkAgent } from "./agents.js";
import { playMatch, type AgentSpec, type MatchRecord, type MatchSpec } from "./match.js";
import { agentSideLines, agentWins, endTypeLines, houseMirrorLines, pct, type SuiteReport } from "./report.js";

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

export interface SeedSet {
  readonly name: string;
  /** House-only mirror seeds (balance and win types). */
  readonly house: readonly number[];
  /** Seeds for the agency, control and idle-join runs; each is played twice with sides swapped. */
  readonly paired: readonly number[];
}

/**
 * Tuning uses one seed set; final reported runs and near-miss reruns use sets
 * never used in tuning. Seeds 1-50, 201-250 and
 * 1001-1020 were used in pre-implementation probes and are in no set.
 *
 * final1/rerun1 were the held-out sets at head ed3f297, before the scripted
 * agents refreshed their marks. After that fix
 * the suites the fix can affect
 * (agency, control) are played on the fresh final2 set, and a near miss of
 * agency at 10 s on rerun2. Balance, win types and idle join involve no
 * scripted agent, so they stay on final1. rerun2 has no house seeds.
 *
 * final2 was in turn examined for a defect (the economy squad left on hold
 * after a refresh), so after that fix agency and control play on final3, and a
 * near miss of agency at 10 s on rerun3 (the same principle). final2 and rerun2 are retired; rerun2 was never played.
 *
 * final4 (house 9401-9450, paired 9901-9910) was played once at head 9711f62
 * for balance, win types and idle join, and is spent. A later decision
 * moves guardCount to 2, so every suite
 * gets its own fresh set, disjoint from tuning, the probe seeds and every 9xxx
 * set: final5-house (balance and win types), final5-idle, final5-agency,
 * final5-control, and rerun5, reserved for one near-miss rerun of agency.
 */
export const SEED_SETS: Readonly<Record<string, SeedSet>> = {
  tuning: { name: "tuning", house: range(3001, 50), paired: range(3101, 10) },
  final1: { name: "final1", house: range(9001, 50), paired: range(9101, 10) },
  rerun1: { name: "rerun1", house: range(9501, 50), paired: range(9601, 10) },
  final2: { name: "final2", house: range(9001, 50), paired: range(9201, 10) },
  rerun2: { name: "rerun2", house: [], paired: range(9701, 10) },
  final3: { name: "final3", house: range(9001, 50), paired: range(9301, 10) },
  rerun3: { name: "rerun3", house: [], paired: range(9801, 10) },
  final4: { name: "final4", house: range(9401, 50), paired: range(9901, 10) },
  "final5-house": { name: "final5-house", house: range(5001, 50), paired: [] },
  "final5-idle": { name: "final5-idle", house: [], paired: range(5101, 10) },
  "final5-agency": { name: "final5-agency", house: [], paired: range(5201, 10) },
  "final5-control": { name: "final5-control", house: [], paired: range(5301, 10) },
  rerun5: { name: "rerun5", house: [], paired: range(5401, 10) },
};

export interface SuiteOptions {
  readonly seeds: SeedSet;
  readonly config: SimConfig;
  /** Called after each match, for progress output. */
  readonly onMatch?: (suite: string, done: number, total: number) => void;
}

function play(options: SuiteOptions, suite: string, specs: readonly MatchSpec[]): MatchRecord[] {
  return specs.map((spec, i) => {
    const record = playMatch(spec);
    options.onMatch?.(suite, i + 1, specs.length);
    return record;
  });
}

/** House-only mirror and the win-type spread over the same matches. */
export function balanceSuites(options: SuiteOptions): SuiteReport[] {
  const records = play(
    options,
    "balance",
    options.seeds.house.map((seed) => ({ seed, config: options.config, agentColony: null, agents: [], delayTicks: 0 })),
  );
  const n = records.length;
  const mirror = houseMirrorLines(records);
  const inRange = (w: number): boolean => w * 100 >= n * 40 && w * 100 <= n * 60;
  const types = endTypeLines(records);
  return [
    {
      name: `Balance: house-only mirror, ${n} seeds (${options.seeds.name} set)`,
      lines: mirror.lines,
      checks: [
        { label: `colony 0 wins 40-60% (${pct(mirror.wins[0], n)})`, pass: inRange(mirror.wins[0]) },
        { label: `colony 1 wins 40-60% (${pct(mirror.wins[1], n)})`, pass: inRange(mirror.wins[1]) },
      ],
    },
    {
      name: `Win types: the same ${n} house-only matches`,
      lines: types.lines,
      checks: [
        { label: "at least 20 house-only matches", pass: n >= 20 },
        { label: `no way of ending exceeds 70% (largest ${(types.maxShare * 100).toFixed(0)}%)`, pass: types.maxShare <= 0.7 },
      ],
    },
  ];
}

/** Each paired seed twice: agents on colony 0, then on colony 1. */
function paired(
  options: SuiteOptions,
  delayTicks: number,
  agents: (seed: number, colony: 0 | 1) => AgentSpec[],
): MatchSpec[] {
  return options.seeds.paired.flatMap((seed) =>
    ([0, 1] as const).map((colony) => ({ seed, config: options.config, agentColony: colony, agents: agents(seed, colony), delayTicks })),
  );
}

function scripted(options: SuiteOptions): AgentSpec[] {
  const { markLifetimeTicks, mapWidth, mapHeight } = options.config;
  return [
    { id: "front", brain: frontAgent(markLifetimeTicks, mapWidth, mapHeight) },
    { id: "economy", brain: economyScoutAgent(markLifetimeTicks, mapWidth, mapHeight) },
  ];
}

/** Agency: the two scripted agents at 0, 10 and 30 s per call; 14 of 20 at 10 s. */
export function agencySuite(options: SuiteOptions): SuiteReport {
  const tps = options.config.ticksPerSecond;
  const lines: string[] = [];
  let atTen = 0;
  let total = 0;
  for (const seconds of [0, 10, 30]) {
    const records = play(options, `agency ${seconds} s`, paired(options, seconds * tps, () => scripted(options)));
    const wins = agentWins(records);
    total = records.length;
    if (seconds === 10) atTen = wins;
    lines.push(`  ${seconds} s per call: agent colony wins ${wins}/${records.length}`, ...agentSideLines(records));
  }
  return {
    name: `Agency: front + economy-and-scout agents vs house-only, ${options.seeds.paired.length} seeds x 2 sides (${options.seeds.name} set)`,
    lines,
    checks: [{ label: `at 10 s per call the agent colony wins at least 14 of 20 (${atTen}/${total})`, pass: atTen >= 14 }],
  };
}

/** Control: random-mark agents at 10 s per call must not reach 14 of 20. */
export function controlSuite(options: SuiteOptions): SuiteReport {
  const { mapWidth, mapHeight, ticksPerSecond } = options.config;
  const records = play(
    options,
    "control",
    paired(options, 10 * ticksPerSecond, (seed, colony) =>
      [0, 1].map((i) => ({ id: `random-${i}`, brain: randomMarkAgent(seed * 4 + colony * 2 + i, mapWidth, mapHeight) })),
    ),
  );
  const wins = agentWins(records);
  return {
    name: `Control: random-mark agents at 10 s per call vs house-only, ${options.seeds.paired.length} seeds x 2 sides (${options.seeds.name} set)`,
    lines: [`  agent colony wins ${wins}/${records.length}`, ...agentSideLines(records)],
    checks: [{ label: `the control colony wins fewer than 14 of 20 (${wins}/${records.length})`, pass: wins < 14 }],
  };
}

/** Idle join: two agents that only observe every 10 s; 7 to 13 of 20. */
export function idleSuite(options: SuiteOptions): SuiteReport {
  const every = 10 * options.config.ticksPerSecond;
  const records = play(
    options,
    "idle join",
    paired(options, 0, () => [0, 1].map((i) => ({ id: `idle-${i}`, brain: idleAgent, observeEveryTicks: every }))),
  );
  const wins = agentWins(records);
  const lapses = records.reduce((n, r) => n + r.squadLapses, 0);
  return {
    name: `Idle join: two agents join one colony and only observe every 10 s, ${options.seeds.paired.length} seeds x 2 sides (${options.seeds.name} set)`,
    lines: [`  idle-join colony wins ${wins}/${records.length}`, ...agentSideLines(records)],
    checks: [
      { label: `the idle-join colony wins between 7 and 13 (${wins}/${records.length})`, pass: wins >= 7 && wins <= 13 },
      { label: `each idle agent holds its squad all match (squad lapses ${lapses})`, pass: lapses === 0 },
    ],
  };
}

/** Run the named suite ("all", "balance", "agency", "control" or "idle"). */
export function runSuites(suite: string, options: SuiteOptions): SuiteReport[] {
  const reports: SuiteReport[] = [];
  if (suite === "all" || suite === "balance") reports.push(...balanceSuites(options));
  if (suite === "all" || suite === "agency") reports.push(agencySuite(options));
  if (suite === "all" || suite === "control") reports.push(controlSuite(options));
  if (suite === "all" || suite === "idle") reports.push(idleSuite(options));
  if (reports.length === 0) throw new Error(`unknown suite ${suite}`);
  return reports;
}
