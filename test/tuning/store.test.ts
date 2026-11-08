import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANES, type LaneId } from "./lanes.ts";
import { NOISE_CHECK_AGENT, openStore, type NoiseVerdict, type Store, type TryRecord } from "./store.ts";

// The shared lane store ("Shared lane store"): lanes, bindings, one baseline per lane and
// kept edits, exercised in one process with two handles on the same directory.

function storeDir(): string {
  return mkdtempSync(join(tmpdir(), "antwar-tuning-store-"));
}

const RUNS = [
  { agentId: "noise-a", medianTickMs: 101 },
  { agentId: "noise-b", medianTickMs: 99 },
  { agentId: "noise-c", medianTickMs: 100 },
  { agentId: "noise-d", medianTickMs: 104 },
];

function verdict(pass: boolean, at = "2026-10-29T08:00:00.000Z"): NoiseVerdict {
  return { runs: RUNS, spread: 0.05, limit: pass ? 0.1 : 0.01, pass, at };
}

/** A store whose noise check passed at base commit "base", with the given agents bound. */
function settledStore(bind: Record<string, LaneId> = {}, dir = storeDir()): Store {
  const store = openStore(dir);
  for (const [agentId, lane] of Object.entries(bind)) store.bindAgent(agentId, lane);
  store.settleNoise(verdict(true), "base");
  return store;
}

function tryRecord(agentId: string, lane: LaneId, decision: "keep" | "drop", over: Partial<TryRecord> = {}): TryRecord {
  return {
    agentId, lane, baselineVersion: 0, medianTickMs: 95, baselineMedianTickMs: 100.5, relative: 95 / 100.5,
    noise: 0.05, decision, reasons: decision === "keep" ? [] : ["within noise"], at: "2026-10-29T08:01:00.000Z", ...over,
  };
}

describe("lanes", () => {
  it("are the five named lanes, freeform with no hot-spot direction", () => {
    expect(LANES.map((lane) => [lane.id, lane.name])).toEqual([
      ["seated-local-steering", "Seated local steering"],
      ["neighbour-scan", "Neighbour scan"],
      ["adjacent-enemy", "Adjacent-enemy check"],
      ["soft-separation", "Soft separation"],
      ["freeform", "Freeform"],
    ]);
    const freeform = LANES.find((lane) => lane.id === "freeform")!;
    expect(freeform.hotSpots).toEqual([]);
    for (const lane of LANES.filter((l) => l.id !== "freeform")) expect(lane.hotSpots.length).toBeGreaterThan(0);
  });
});

describe("agent binding", () => {
  it("gives each agent the one lane it is bound to, refusing another lane", () => {
    const dir = storeDir();
    const store = openStore(dir);
    expect(store.bindAgent("agent-1", "neighbour-scan")).toBe(LANES[1]);
    expect(store.bindAgent("agent-1", "neighbour-scan").id).toBe("neighbour-scan");
    expect(() => store.bindAgent("agent-1", "freeform")).toThrow(/already bound to lane neighbour-scan/);
    // Another handle on the same directory (another agent's process) sees the same binding.
    expect(() => openStore(dir).bindAgent("agent-1", "soft-separation")).toThrow(/already bound/);
    expect(openStore(dir).bindAgent("agent-2", "freeform").hotSpots).toEqual([]);
  });

  it("refuses unknown lanes and unsafe agent ids", () => {
    const store = openStore(storeDir());
    expect(() => store.bindAgent("agent-1", "everything" as LaneId)).toThrow(/unknown lane/);
    expect(() => store.bindAgent("../agent", "freeform")).toThrow(/invalid agent id/);
    expect(() => store.bindAgent("", "freeform")).toThrow(/invalid agent id/);
  });
});

describe("checkpoint", () => {
  it("is stored once and read back by every agent", () => {
    const dir = storeDir();
    const store = openStore(dir);
    expect(store.checkpoint("wide-plain-768")).toBeNull();
    expect(store.putCheckpoint("wide-plain-768", "first")).toBe(true);
    expect(openStore(dir).putCheckpoint("wide-plain-768", "second")).toBe(false);
    expect(openStore(dir).checkpoint("wide-plain-768")).toBe("first");
  });
});

describe("noise check records", () => {
  it("numbers arrivals in order, once per agent, and stores each run once", () => {
    const dir = storeDir();
    const store = openStore(dir);
    expect(store.arriveForNoise("noise-b")).toBe(1);
    expect(openStore(dir).arriveForNoise("noise-a")).toBe(2);
    expect(store.arriveForNoise("noise-b")).toBe(1);
    expect(store.noiseArrivals()).toEqual(["noise-b", "noise-a"]);
    store.writeNoiseRun("noise-b", 99);
    store.writeNoiseRun("noise-a", 101);
    expect(() => store.writeNoiseRun("noise-a", 50)).toThrow(/already written/);
    expect(store.noiseRuns()).toEqual([{ agentId: "noise-a", medianTickMs: 101 }, { agentId: "noise-b", medianTickMs: 99 }]);
  });

  it("keeps the first verdict, and a pass writes version 0 of every lane from the four runs' median", () => {
    const dir = storeDir();
    const store = openStore(dir);
    expect(store.noise()).toBeNull();
    for (const lane of LANES) expect(store.baseline(lane.id)).toBeNull();
    expect(store.settleNoise(verdict(true), "base")).toEqual(verdict(true));
    // A later settler, even with another verdict and commit, gets the stored one back.
    expect(openStore(dir).settleNoise(verdict(false, "2026-10-29T09:00:00.000Z"), "other")).toEqual(verdict(true));
    expect(store.noise()).toEqual(verdict(true));
    for (const lane of LANES) {
      expect(store.baseline(lane.id)).toEqual({
        lane: lane.id, version: 0, baseCommit: "base", patches: [], medianTickMs: 100.5,
        agentId: NOISE_CHECK_AGENT, at: "2026-10-29T08:00:00.000Z",
      });
      expect(store.keptEdits(lane.id)).toEqual([]);
    }
  });

  it("writes no baseline when the check fails", () => {
    const store = openStore(storeDir());
    expect(store.settleNoise(verdict(false), "base").pass).toBe(false);
    for (const lane of LANES) expect(store.baseline(lane.id)).toBeNull();
  });
});

describe("lane baselines", () => {
  it("are one per lane, read alike by every agent in it, with no per-agent baseline", () => {
    const store = settledStore({ a: "soft-separation", b: "soft-separation", c: "freeform" });
    store.advanceLane("soft-separation", 0, { patch: "soft edit", medianTickMs: 90, agentId: "a" });
    const seenByA = store.baseline("soft-separation");
    // Agent b never kept anything, yet its lane's baseline is a's kept version; c's lane is untouched.
    expect(seenByA).toMatchObject({ version: 1, medianTickMs: 90, agentId: "a" });
    expect(store.baseline("soft-separation")).toEqual(seenByA);
    expect(store.baseline("freeform")).toMatchObject({ version: 0, medianTickMs: 100.5 });
  });

  it("advance by compare-and-swap: a kept edit becomes the lane's next baseline, a racing keep gets stale", () => {
    const store = settledStore({ a: "neighbour-scan", b: "neighbour-scan" });
    const v1 = store.advanceLane("neighbour-scan", 0, { patch: "edit a", medianTickMs: 95, agentId: "a" });
    expect(v1).toMatchObject({ lane: "neighbour-scan", version: 1, baseCommit: "base", patches: ["edit a"], medianTickMs: 95, agentId: "a" });
    // b was timed against version 0 too: its keep is stale and changes nothing.
    expect(store.advanceLane("neighbour-scan", 0, { patch: "edit b", medianTickMs: 94, agentId: "b" })).toBe("stale");
    expect(store.baseline("neighbour-scan")).toEqual(v1);
    // Re-applied and re-timed against version 1, it is kept on top of a's edit.
    const v2 = store.advanceLane("neighbour-scan", 1, { patch: "edit b", medianTickMs: 91, agentId: "b" });
    expect(v2).toMatchObject({ version: 2, patches: ["edit a", "edit b"], medianTickMs: 91, agentId: "b" });
    expect(store.baseline("neighbour-scan")).toEqual(v2);
    expect(store.keptEdits("neighbour-scan")).toEqual([v1, v2]);
    expect(store.keptEdits("adjacent-enemy")).toEqual([]);
  });

  it("refuse a keep from an agent in another lane, before the noise check, or from a version that does not exist", () => {
    const store = settledStore({ a: "neighbour-scan", b: "freeform" });
    expect(() => store.advanceLane("neighbour-scan", 0, { patch: "p", medianTickMs: 90, agentId: "b" })).toThrow(/bound to lane freeform/);
    expect(() => store.advanceLane("neighbour-scan", 0, { patch: "p", medianTickMs: 90, agentId: "nobody" })).toThrow(/not bound/);
    expect(() => store.advanceLane("neighbour-scan", 3, { patch: "p", medianTickMs: 90, agentId: "a" })).toThrow(/no version 3/);
    expect(() => store.advanceLane("neighbour-scan", 0, { patch: "", medianTickMs: 90, agentId: "a" })).toThrow(/patch/);
    const unchecked = openStore(storeDir());
    unchecked.bindAgent("a", "neighbour-scan");
    expect(() => unchecked.advanceLane("neighbour-scan", 0, { patch: "p", medianTickMs: 90, agentId: "a" })).toThrow(/no version 0/);
  });
});

describe("try records", () => {
  it("keep every agent's own results, against its own lane", () => {
    const dir = storeDir();
    const store = settledStore({ a: "adjacent-enemy", b: "freeform" }, dir);
    const first = tryRecord("a", "adjacent-enemy", "drop");
    const second = tryRecord("a", "adjacent-enemy", "keep", { patch: "edit", baselineVersion: 0 });
    const other = tryRecord("b", "freeform", "drop");
    store.recordTry(first);
    store.recordTry(other);
    store.recordTry(second);
    expect(store.tries()).toEqual([first, second, other]);
    expect(store.tries({ agentId: "a" })).toEqual([first, second]);
    expect(store.tries({ lane: "freeform" })).toEqual([other]);
    expect(store.tries({ lane: "freeform", agentId: "a" })).toEqual([]);
    expect(openStore(dir).tries()).toEqual([first, second, other]);
  });

  it("refuse a record for a lane its agent is not bound to", () => {
    const store = settledStore({ a: "adjacent-enemy" });
    expect(() => store.recordTry(tryRecord("a", "freeform", "drop"))).toThrow(/bound to lane adjacent-enemy/);
    expect(() => store.recordTry(tryRecord("nobody", "freeform", "drop"))).toThrow(/not bound/);
    expect(store.tries()).toEqual([]);
  });
});
