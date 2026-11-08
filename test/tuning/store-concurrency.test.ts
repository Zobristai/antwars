/// <reference types="node" />
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { median } from "../../src/tickStats.ts";
import { LANES, type LaneId } from "./lanes.ts";
import { openStore } from "./store.ts";
import { BASE_COMMIT, CHECKPOINT, type WorkerSummary } from "./store-worker.ts";

// 30 or more loop processes on one store at once ("Shared lane store"), with measurement
// and the keep decision injected (test/tuning/store-worker.ts). This shows the store keeps every
// agent's own keep-or-drop record against its lane's shared baseline and every kept edit against
// its lane under real concurrency. It is not by itself the evidence for a run of 30 or more
// real agents: that needs the assembled loop run with 30 or more real agents on one host.

const ROOT = join(import.meta.dirname, "..", "..");
const AGENTS_PER_LANE = 6;
const TRIES = 20;

function runWorker(args: readonly string[]): Promise<WorkerSummary> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "test/tuning/store-worker.ts", ...args], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(JSON.parse(stdout) as WorkerSummary);
      else reject(new Error(`worker ${args.join(" ")} exited with ${code}:\n${stderr}`));
    });
  });
}

describe("shared lane store under concurrent agents", () => {
  it("gives each of 30 concurrent agents its own keep-or-drop records against its lane's shared baseline, and records every kept edit once against its lane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "antwar-tuning-concurrency-"));
    const plan: { agentId: string; lane: LaneId }[] = LANES.flatMap((lane) =>
      Array.from({ length: AGENTS_PER_LANE }, (_, i) => ({ agentId: `${lane.id}-agent-${i + 1}`, lane: lane.id })));
    expect(plan.length).toBeGreaterThanOrEqual(30);

    const summaries = await Promise.all(plan.map(({ agentId, lane }) => runWorker([
      "--store", dir, "--agent", agentId, "--lane", lane, "--agents", String(plan.length), "--tries", String(TRIES),
    ])));
    const store = openStore(dir);

    // Each agent ran in the one lane it was given; another lane is refused.
    for (const [i, { agentId, lane }] of plan.entries()) {
      expect(summaries[i]).toMatchObject({ agentId, lane, tries: TRIES });
      expect(() => store.bindAgent(agentId, lane === "freeform" ? "neighbour-scan" : "freeform")).toThrow(/already bound/);
    }

    // One checkpoint writer won, and every agent read that one checkpoint.
    const writers = summaries.filter((s) => s.checkpointStored);
    expect(writers).toHaveLength(1);
    for (const s of summaries) expect(s.checkpoint).toBe(`checkpoint stored by ${writers[0]!.agentId}`);

    // Noise check: every agent arrived once, the first four ran, one verdict was kept and seen by all.
    expect(summaries.map((s) => s.position).sort((a, b) => a - b)).toEqual(plan.map((_, i) => i + 1));
    expect(new Set(store.noiseArrivals()).size).toBe(plan.length);
    const runners = summaries.filter((s) => s.position <= 4).map((s) => s.agentId).sort();
    expect(store.noiseRuns().map((run) => run.agentId)).toEqual(runners);
    const verdict = store.noise()!;
    expect(verdict.pass).toBe(true);
    for (const s of summaries) expect(s.verdict).toEqual(verdict);
    const versionZeroMs = median(store.noiseRuns().map((run) => run.medianTickMs).sort((a, b) => a - b));

    let totalKeeps = 0;
    for (const lane of LANES) {
      const laneAgents = new Set(plan.filter((p) => p.lane === lane.id).map((p) => p.agentId));
      const kept = store.keptEdits(lane.id);
      const head = store.baseline(lane.id)!;
      // One baseline chain for the lane: version 0 from the noise check, then one version per kept edit.
      const chain = [{ version: 0, medianTickMs: versionZeroMs, agentId: "noise-check" }, ...kept];
      expect(chain.map((v) => v.version)).toEqual(chain.map((_, i) => i));
      expect(head.version).toBe(chain.length - 1);
      expect(head.baseCommit).toBe(BASE_COMMIT);
      expect(head.patches).toEqual(kept.map((v) => v.patches.at(-1)));
      expect(new Set(head.patches).size).toBe(kept.length);
      for (const version of kept) expect(laneAgents.has(version.agentId)).toBe(true);

      const records = store.tries({ lane: lane.id });
      expect(records).toHaveLength(AGENTS_PER_LANE * TRIES);
      const keeps = records.filter((r) => r.decision === "keep");
      // Every kept edit is recorded once, against its lane, by the keep record of the agent that made it.
      expect(keeps.map((r) => r.patch).sort()).toEqual([...head.patches].sort());
      for (const record of records) {
        expect(laneAgents.has(record.agentId)).toBe(true);
        // Compared with the lane's shared baseline at the version it read, not a baseline of its own.
        expect(record.baselineMedianTickMs).toBe(chain[record.baselineVersion]!.medianTickMs);
        if (record.decision === "keep") {
          const made = kept.find((v) => v.patches.at(-1) === record.patch)!;
          expect(made).toMatchObject({ version: record.baselineVersion + 1, agentId: record.agentId, medianTickMs: record.medianTickMs });
        }
      }
      totalKeeps += keeps.length;
    }

    // Every agent has its own complete set of results, each either keep or drop.
    for (const { agentId, lane } of plan) {
      const own = store.tries({ agentId });
      expect(own).toHaveLength(TRIES);
      for (const record of own) {
        expect(record).toMatchObject({ agentId, lane });
        expect(["keep", "drop"]).toContain(record.decision);
      }
    }
    expect(totalKeeps).toBe(summaries.reduce((sum, s) => sum + s.keeps, 0));
    expect(totalKeeps).toBeGreaterThan(0);
    // Keeps really raced: some lost the compare-and-swap and were re-tried on the newer version.
    expect(summaries.reduce((sum, s) => sum + s.stale, 0)).toBeGreaterThan(0);
  }, 120_000);
});
