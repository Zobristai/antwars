import { describe, expect, it, vi } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { defaultAllocator, type Allocator } from "../../src/sim/agents.js";
import { DEFAULT_CONFIG } from "../../src/sim/config.js";
import { HISTORICAL_CONFIG } from "./fixtures.js";
import { playable } from "../playable.ts";
import { replay, stateHash } from "../../src/sim/log.js";
import type { SimInput, SimState, StepOutput } from "../../src/sim/types.js";
import { namedColonyAllocator } from "../benchmark/match.js";
import { agencySuite, controlSuite, idleSuite, type SeedSet } from "../benchmark/suites.js";

/**
 * A pass-through of the sim's step(). In "placement"
 * mode it drops the allocator it is given, steps with the default allocator,
 * and moves each join's named colony into its placement; nothing else changes.
 * Every mode records what it saw so the equivalence test cannot pass vacuously.
 */
const hook = vi.hoisted(() => ({
  mode: "pass" as "pass" | "benchmark" | "placement",
  tickHashes: false,
  /** Per match: final state hash, and per-tick hashes when tickHashes is on. */
  matches: [] as { final: string | null; ticks: string[] }[],
  received: new Set<unknown>(),
  forwarded: new Set<unknown>(),
  convertedJoins: 0,
  /** Per placement-mode match: placed colonies, and an unnamed join control without placement or colony. */
  joinChecks: [] as { placed: number[]; withoutPlacement: number[] }[],
  /** Set below from the real modules: importing them in the factory would cycle back into step.js. */
  hash: null as ((state: SimState) => string) | null,
  fallback: null as Allocator | null,
}));

vi.mock("../../src/sim/step.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/sim/step.js")>();
  const step = (state: SimState, inputs: readonly SimInput[] = [], allocator?: Allocator): StepOutput => {
    if (hook.mode === "pass") return real.step(state, inputs, allocator);
    if (state.tick === 0) hook.matches.push({ final: null, ticks: [] });
    hook.received.add(allocator);
    let out: StepOutput;
    if (hook.mode === "benchmark") {
      hook.forwarded.add(allocator);
      out = real.step(state, inputs, allocator);
    } else {
      const fallback = hook.fallback!;
      const moved = inputs.map((input): SimInput => {
        if (input.type !== "join" || input.colony === undefined) return input;
        hook.convertedJoins += 1;
        const { colony, ...rest } = input;
        return { ...rest, placement: colony };
      });
      hook.forwarded.add(fallback);
      out = real.step(state, moved, fallback);
      if (moved.some((i) => i.type === "join")) {
        const unplaced = moved.map((i): SimInput => {
          if (i.type !== "join") return i;
          const { placement, ...rest } = i;
          // Named colonies now honour the request too; use unnamed joins to
          // retain the independent balancing control, not the old named rule.
          return rest;
        });
        hook.joinChecks.push({
          placed: out.state.agents.map((a) => a.colony),
          withoutPlacement: real.step(state, unplaced, fallback).state.agents.map((a) => a.colony),
        });
      }
    }
    const match = hook.matches[hook.matches.length - 1]!;
    if (hook.tickHashes) match.ticks.push(hook.hash!(out.state));
    if (out.state.result !== null) match.final = hook.hash!(out.state);
    return out;
  };
  return { ...real, step };
});

hook.hash = stateHash;
hook.fallback = defaultAllocator;

/** A held match with the given number of joins, played for ticks; returns the live state and its log lines. */
async function play(joins: number, ticks: number) {
  const lines: string[] = [];
  const game = new Game({ simConfig: playable({ ...DEFAULT_CONFIG, matchTicks: 600 }), onLogLine: (line) => lines.push(line) });
  for (let i = 0; i < joins; i += 1) await game.join({});
  game.startMatch(4242);
  for (let i = 0; i < ticks; i += 1) game.tick();
  return { state: game.match!.state, lines };
}

describe("shared-address joins replay from their log", () => {
  it("joins without a placement log no placement field and replay to the same hash, balanced as before", async () => {
    const { state, lines } = await play(2, 300);
    expect(lines.join("\n")).not.toContain("placement");
    expect(state.agents.map((a) => a.colony)).toEqual([0, 1]);
    expect(stateHash(replay(lines, state.tick))).toBe(stateHash(state));
  });
});

/** One seed each of the agent suites, as test/benchmark/suites.ts plays them (final5 seeds). */
const SUITES = [
  { name: "agency", seed: 5201, run: agencySuite },
  { name: "idle join", seed: 5101, run: idleSuite },
  { name: "control", seed: 5301, run: controlSuite },
] as const;

function playSuite(suite: (typeof SUITES)[number], mode: "benchmark" | "placement", tickHashes = false) {
  hook.mode = mode;
  hook.tickHashes = tickHashes;
  hook.matches = [];
  const seeds: SeedSet = { name: `equivalence-${suite.seed}`, house: [], paired: [suite.seed] };
  try {
    const report = suite.run({ seeds, config: playable(HISTORICAL_CONFIG) });
    return { report, matches: hook.matches };
  } finally {
    hook.mode = "pass";
  }
}

describe("Equivalence: the benchmark's named-colony allocator and the placement field play the same match", () => {
  for (const suite of SUITES) {
    it(`${suite.name}, seed ${suite.seed}: identical final state hash and report for every match`, () => {
      hook.received.clear();
      hook.forwarded.clear();
      const bench = playSuite(suite, "benchmark");
      expect([...hook.received]).toEqual([namedColonyAllocator]);
      expect([...hook.forwarded]).toEqual([namedColonyAllocator]);

      hook.received.clear();
      hook.forwarded.clear();
      hook.convertedJoins = 0;
      hook.joinChecks = [];
      const placed = playSuite(suite, "placement");
      // The placement run was handed the benchmark allocator, dropped it, and stepped on the default allocator.
      expect([...hook.received]).toEqual([namedColonyAllocator]);
      expect([...hook.forwarded]).toEqual([defaultAllocator]);
      // Every match's two agent joins went through placement onto one colony.
      // Control joins with neither placement nor colony still balance apart.
      expect(hook.convertedJoins).toBe(2 * placed.matches.length);
      expect(hook.joinChecks).toHaveLength(placed.matches.length);
      for (const check of hook.joinChecks) {
        expect(check.placed[0]).toBe(check.placed[1]);
        expect(check.withoutPlacement[0]).not.toBe(check.withoutPlacement[1]);
      }

      expect(placed.matches.length).toBe(bench.matches.length);
      expect(bench.matches.every((m) => m.final !== null)).toBe(true);
      const finals = (r: typeof bench) => r.matches.map((m) => m.final);
      if (JSON.stringify(finals(placed)) !== JSON.stringify(finals(bench))) {
        // Name the first match and tick that differ (adjust nothing).
        const a = playSuite(suite, "benchmark", true).matches;
        const b = playSuite(suite, "placement", true).matches;
        const index = a.findIndex((m, i) => m.final !== b[i]!.final);
        const tick = a[index]!.ticks.findIndex((h, t) => h !== b[index]!.ticks[t]);
        expect.fail(`seed ${suite.seed}, ${suite.name} match ${index + 1}: first differing state after tick ${tick}`);
      }
      expect(placed.report).toEqual(bench.report);
    }, 120_000);
  }
});
