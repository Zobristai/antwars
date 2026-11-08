import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShard, shardUnits } from "../../web/capture/stills.ts";

// stills --shard I/N: N shards share the whole run. Every unit must run in
// exactly one shard: a unit in two shards renders twice, and one in none is silently dropped from the evidence.
describe("stills --shard", () => {
  // A 3D run with every fixture and the WebKit pass, in the run's order (stills.ts main: units).
  const viewports = ["1080p", "desktop", "phone", "landscape", "phone360", "result360x800", "territory360x800", "territory1280x800", "phone664"];
  const passes = ["tablet1024x768", "tablet1133x744", "house-models", "first-impression", "queens", "empty-server", "feed-drop", "result-screen", "motion-countdown", "motion", "fallback-3d-code-fails-to-load", "fallback-3d-context-lost", "fallback-3d-too-slow", "emulated-phone", "board-area"];
  const webkit = ["phone", "landscape", "phone360", "result360x800", "territory360x800", "territory1280x800", "phone664", "house-models", "tablet1024x768", "tablet1133x744", "first-impression", "empty-server", "feed-drop", "result-screen", "motion-countdown", "motion"].map((unit) => `webkit-${unit}`);
  const units = [...viewports, ...passes, ...webkit, "webgl-off"];

  it("covers the whole run exactly once, with no overlap, for several N", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 10, 16, units.length, units.length + 3]) {
      const shards = Array.from({ length: count }, (_, k) => shardUnits(units, { index: k + 1, count }));
      const all = shards.flat();
      expect(all).toHaveLength(units.length);
      expect(new Set(all).size).toBe(units.length);
      expect([...all].sort()).toEqual([...units].sort());
      for (const [a, left] of shards.entries()) for (const right of shards.slice(a + 1)) expect(left.filter((unit) => right.includes(unit))).toEqual([]);
      // Dealt in turn, so the heavy viewports spread and no shard holds more than one unit above its share.
      for (const part of shards) expect(part.length).toBeLessThanOrEqual(Math.ceil(units.length / count));
    }
  });

  it("runs the whole run without the flag, and reads I/N", () => {
    expect(parseShard(undefined)).toBeNull();
    expect(shardUnits(units, null)).toEqual(units);
    expect(parseShard("2/4")).toEqual({ index: 2, count: 4 });
    expect(parseShard(" 1/1 ")).toEqual({ index: 1, count: 1 });
    for (const bad of ["0/3", "4/3", "1/0", "3", "a/b", "1/2/3", "-1/2"]) expect(() => parseShard(bad)).toThrow(/--shard/);
  });

  it("guards every unit of the run with its shard", () => {
    const source = readFileSync(new URL("../../web/capture/stills.ts", import.meta.url), "utf8");
    for (const unit of ["house-models", "first-impression", "queens", "empty-server", "feed-drop", "result-screen", "motion-countdown", "motion", "emulated-phone", "board-area", "webgl-off", "webkit-house-models", "webkit-first-impression", "webkit-empty-server", "webkit-feed-drop", "webkit-result-screen", "webkit-motion-countdown", "webkit-motion"]) {
      expect(source).toContain(`mine("${unit}")`);
    }
    expect(source).toContain("for (const [label, vp, phone] of viewports) if (mine(label)) await viewportScenes(browser, label, vp, phone);");
    expect(source).toContain("for (const [label, vp, phone] of phones) if (mine(`webkit-${label}`)) await viewportScenes(wk, label, vp, phone);");
    expect(source).toContain("if (!mine(name)) continue;");
  });
});
