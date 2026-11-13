import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PUBLIC_CONFIG } from "../../src/sim/config.js";
import { hatch, regrow } from "../../src/sim/forage.js";
import { guardBudget, rebalanceRoles } from "../../src/sim/houseBot.js";
import { createMatch, newAnt } from "../../src/sim/map.js";
import type { SimEvent } from "../../src/sim/types.js";
import { BASELINE_CONFIG, counts, DURATION_SEEDS, durationChecks, observeBytes, timing } from "../tools/colonyScale.js";
import { addAnt, emptyMatch } from "./fixtures.js";
import { playable } from "../playable.ts";
import { boardPixelCheck, boundedCapture } from "../../web/capture/colony-scale.ts";

/** The public config as every match plays it, at grid scale 2. */
const PUBLIC = playable(PUBLIC_CONFIG);

/** A retune must change real growth, not just the cap or a display counter. */
describe("30-minute larger colonies", () => {
  it("ships 30 minutes at 10 Hz and a 512 cap for both configurations", () => {
    for (const config of [DEFAULT_CONFIG, PUBLIC_CONFIG]) {
      expect(config.matchTicks).toBe(30 * 60 * config.ticksPerSecond);
      expect(config.colonyCap).toBe(512);
    }
  });

  it("charges three food for a worker and six for the next mixed soldier, one second apart", () => {
    const state = createMatch(7, PUBLIC);
    state.ants = [];
    state.colonies[0].foodStore = 9;
    const events: SimEvent[] = [];
    hatch(state, 0, events);
    hatch(state, 9, events);
    expect(state.ants.map((a) => a.caste)).toEqual(["worker"]);
    hatch(state, 10, events);
    expect(state.ants.map((a) => a.caste)).toEqual(["worker", "soldier"]);
    expect(state.colonies[0].foodStore).toBe(0);
    hatch(state, 20, events);
    expect(state.ants).toHaveLength(2);
  });

  it("does not let either mixed caste hatch the 513th ant", () => {
    const state = createMatch(8, PUBLIC);
    const queen = state.colonies[0];
    state.ants = Array.from({ length: 512 }, (_, id) => newAnt(PUBLIC, id, 0, queen.queenX, queen.queenY, "worker"));
    queen.foodStore = 100;
    for (const caste of ["worker", "soldier"] as const) {
      queen.mixedNext = caste;
      hatch(state, 100, []);
      expect(counts(state)).toEqual([512, 0]);
      expect(queen.foodStore).toBe(100);
    }
  });

  it("regrows patches on their own cadence, never over the original tile ceiling", () => {
    const state = createMatch(9, PUBLIC);
    const tile = state.food.findIndex((n) => n > 0);
    state.food[tile] = 0;
    regrow(state, 0);
    regrow(state, 149);
    expect(state.food[tile]).toBe(0);
    regrow(state, 150);
    expect(state.food[tile]).toBe(1);
    state.food[tile] = state.foodCap[tile]!;
    regrow(state, 300);
    expect(state.food[tile]).toBe(state.foodCap[tile]);
  });
});

describe("colony-wide guard budget", () => {
  it("rounds the living-ant share down and preserves the minimum", () => {
    expect(guardBudget(9, { guardCount: 2, guardSharePermille: 200 })).toBe(2);
    expect(guardBudget(19, { guardCount: 2, guardSharePermille: 200 })).toBe(3);
    expect(guardBudget(512, { guardCount: 2, guardSharePermille: 200 })).toBe(102);
  });

  it("falls back to the legacy fixed count when share is absent or zero", () => {
    expect(guardBudget(512, { guardCount: 2 })).toBe(2);
    expect(guardBudget(512, { guardCount: 2, guardSharePermille: 0 })).toBe(2);
    expect(guardBudget(512, { guardCount: 0 })).toBe(0);
  });

  it("counts squad ants but assigns only eligible ants nearest their own queen", () => {
    const state = emptyMatch(0, { ...PUBLIC_CONFIG, guardSharePermille: 200 });
    for (let i = 0; i < 20; i++) addAnt(state, 0, 16 + 2 * i, 48, { squad: i < 10 ? "held" : null, role: "forager" });
    for (let i = 0; i < 10; i++) addAnt(state, 1, 110 - 2 * i, 48, { role: "forager" });
    rebalanceRoles(state);
    expect(state.ants.filter((ant) => ant.colony === 0 && ant.role === "guard").map((ant) => ant.id)).toEqual(state.ants.slice(10, 14).map((ant) => ant.id));
    expect(state.ants.filter((ant) => ant.colony === 1 && ant.role === "guard")).toHaveLength(2);
    expect(state.ants.filter((ant) => ant.squad !== null).every((ant) => ant.role === "forager")).toBe(true);
  });

  it("clamps the budget to eligible ants and replaces a drafted guard", () => {
    const state = emptyMatch(0, { ...PUBLIC_CONFIG, guardSharePermille: 200 });
    for (let i = 0; i < 20; i++) addAnt(state, 0, 16, 48, { squad: i < 19 ? "held" : null, role: "forager" });
    rebalanceRoles(state);
    expect(state.ants.filter((ant) => ant.role === "guard").map((ant) => ant.id)).toEqual([state.ants[19]!.id]);
    state.ants[19]!.squad = "held";
    state.ants[18]!.squad = null;
    rebalanceRoles(state);
    expect(state.ants[19]!.role).toBe("guard"); // The house bot never rewrites a squad ant.
    expect(state.ants[18]!.role).toBe("guard");
  });
});

describe("private scale measurements", () => {
  it("rejects clear, transparent and sparsely marked primary boards", () => {
    const background = [11, 8, 5, 255] as const;
    const blank = Array.from({ length: 192 }, () => background);
    expect(boardPixelCheck(blank, background).nonblank).toBe(false);
    expect(boardPixelCheck(blank.map(() => [0, 0, 0, 0]), background).nonblank).toBe(false);
    expect(boardPixelCheck([], background).nonblank).toBe(false);
    const markers = blank.map((pixel, i) => i < 5 ? [255, 176, 0, 255] as const : pixel);
    const sparse = boardPixelCheck(markers, background);
    expect(sparse.rgbDeviation).toBeGreaterThan(4);
    expect(sparse.groundFraction).toBeLessThan(0.4);
    expect(sparse.nonblank).toBe(false);
  });

  it("accepts broadly painted ground but refuses too few or transparent samples", () => {
    const background = [11, 8, 5, 255] as const;
    const ground = Array.from({ length: 192 }, (_, i): [number, number, number, number] => [30 + i % 23, 19 + i % 17, 10 + i % 11, 255]);
    expect(boardPixelCheck(ground, background)).toMatchObject({ nonblank: true, opaqueFraction: 1, groundFraction: 1 });
    expect(boardPixelCheck(ground.slice(0, 31), background).nonblank).toBe(false);
    expect(boardPixelCheck(ground.map((pixel, i) => i < 20 ? [0, 0, 0, 0] : pixel), background).nonblank).toBe(false);
  });

  it("bounds capture work on the real Node clock and preserves operation failures", async () => {
    await expect(boundedCapture(Promise.resolve("painted"), "ready", 100)).resolves.toBe("painted");
    await expect(boundedCapture(Promise.reject(new Error("renderer failed")), "failed", 100)).rejects.toThrow("renderer failed");
    await expect(boundedCapture(new Promise<never>(() => {}), "blank", 20)).rejects.toThrow("blank: primary-board capture timed out after 20 ms");
  });

  it("enforces all duration requirements across the fixed four seeds", () => {
    const runs = DURATION_SEEDS.map((seed, index) => ({ seed, endTick: [7200, 12000, 13000, 18000][index]!, reason: index === 3 ? "time_up" as const : "overrun" as const }));
    expect(durationChecks(runs, PUBLIC_CONFIG)).toEqual({ medianEndTick: 12500, checks: { completeSeedSet: true, noneBeforeTwelveMinutes: true, medianAtLeastTwentyMinutes: true, includesTimeUp: true } });
    expect(durationChecks(runs.slice(1), PUBLIC_CONFIG).checks.completeSeedSet).toBe(false);
    expect(durationChecks(runs.map((run) => ({ ...run, seed: 10 })), PUBLIC_CONFIG).checks.completeSeedSet).toBe(false);
    expect(durationChecks(runs.map((run) => ({ ...run, endTick: 7300, reason: "overrun" })), PUBLIC_CONFIG).checks).toMatchObject({ medianAtLeastTwentyMinutes: false, includesTimeUp: false });
    expect(durationChecks([{ ...runs[0]!, endTick: 7199 }, ...runs.slice(1)], PUBLIC_CONFIG).checks.noneBeforeTwelveMinutes).toBe(false);
    expect(durationChecks([], PUBLIC_CONFIG).medianEndTick).toBeNull();
  });
  it("retains the baseline public economy for comparison", () => {
    expect(BASELINE_CONFIG).toMatchObject({ matchTicks: 7200, colonyCap: 150, hatchCost: 3, hatchIntervalTicks: 18, foodRegrowTicks: 150, castes: { soldierCost: 6 } });
  });

  it("reports mean, nearest-rank p95, median and max without discarding slow ticks", () => {
    expect(timing([4, 1, 3, 2])).toEqual({ samples: 4, meanMs: 2.5, p95Ms: 4, medianMs: 2.5, maxMs: 4 });
    expect(timing(Array.from({ length: 20 }, (_, i) => i + 1))).toMatchObject({ p95Ms: 19, maxMs: 20 });
    expect(timing([1, 1, 1, 101])).toMatchObject({ meanMs: 26, maxMs: 101 });
    expect(() => timing([])).toThrow("no timing samples");
  });

  it("runs the actual observe tool privately and includes the optional map only when asked", async () => {
    const result = await observeBytes(createMatch(7, PUBLIC), 1);
    expect(result.colony).toBe(1);
    expect(result.results.map((r) => r.map)).toEqual([false, true]);
    expect(result.results[0]!.textUtf8Bytes).toBeGreaterThan(100);
    // Consecutive observes also move the squad, so assert map structure rather
    // than treating their byte difference as a fixed map-only size.
    expect(result.results.map((r) => r.mapRows)).toEqual([0, PUBLIC_CONFIG.mapHeight * 2]);
    expect(result.results[1]!.textUtf8Bytes).toBeGreaterThan(result.results[0]!.textUtf8Bytes);
    expect(result.results.every((r) => r.toolResultUtf8Bytes > r.textUtf8Bytes)).toBe(true);
  });
});
