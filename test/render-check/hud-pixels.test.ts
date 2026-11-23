import { describe, expect, it } from "vitest";
import { encodePng } from "../../scripts/favicon.ts";
import { measureHudProbe, type HudTriplet } from "../../web/render-check/hud-pixels.ts";

// Differences of just one channel level (including at the first and last pixel) must not be rounded away.
function row(value: (x: number) => number, width = 513): Buffer {
  const data = Buffer.alloc(width * 4, 255);
  for (let x = 0; x < width; x++) data[4 * x] = value(x);
  return encodePng({ width, height: 1, data });
}
const empty = row(() => 0);
const cycles = (before: Buffer, altered: Buffer, after = before): HudTriplet[] =>
  Array.from({ length: 3 }, () => ({ before, altered, after }));

describe("HUD pixel evidence", () => {
  it("counts stable witnesses, not the union of witnesses and changing pixels", () => {
    const painted = row(() => 1);
    for (const n of [256, 257]) {
      const toggled = row(x => x < n ? 2 : 1);
      const m = measureHudProbe("hidden", cycles(painted, empty, toggled));
      expect(m).toMatchObject({ variablePixels: n, stableDifferences: 513 - n, alteredVariablePixels: 0,
        verdict: n === 256 ? "shown" : "screen not still" });
    }
    // Exactly 256 phase-locked stray pixels plus 256 unstable ones do not certify a nonpainting HUD.
    const sparse = row(x => x < 512 ? 1 : 0);
    const flicker = row(x => x < 256 ? 2 : x < 512 ? 1 : 0);
    expect(measureHudProbe("hidden", cycles(sparse, empty, flicker))).toMatchObject({
      variablePixels: 256, stableDifferences: 256, verdict: "insufficient HUD paint" });
    expect(measureHudProbe("hidden", cycles(empty, empty)).verdict).toBe("not shown");
  });

  it("rejects even one changing hidden pixel or a varying visible pixel that sometimes matches its background", () => {
    const painted = row(() => 1), dot = row(x => x === 512 ? 1 : 0);
    const shots = cycles(painted, empty);
    shots[1]!.altered = dot;
    expect(measureHudProbe("hidden", shots)).toMatchObject({ stableDifferences: 512, variablePixels: 1, alteredVariablePixels: 1, verdict: "screen not still" });
    // Only the middle restored shot reveals the background at x=512.
    shots[1]!.altered = empty;
    shots[1]!.after = row(x => x === 512 ? 0 : 1);
    expect(measureHudProbe("hidden", shots)).toMatchObject({ variableTouchingBackground: 1, verdict: "screen not still" });
    expect(measureHudProbe("hidden", cycles(empty, dot)).verdict).toBe("insufficient HUD paint");
  });

  it("detects one stable pixel of clipping and never accepts a cut for which all evidence is unstable", () => {
    const dot = row(x => x === 512 ? 1 : 0);
    expect(measureHudProbe("unclipped", cycles(empty, dot))).toMatchObject({ stableDifferences: 1, variablePixels: 0, verdict: "clipped" });
    const shots = cycles(empty, dot); shots[2]!.altered = empty;
    expect(measureHudProbe("unclipped", shots)).toMatchObject({ stableDifferences: 0, variablePixels: 1, verdict: "screen not still" });
    expect(measureHudProbe("unclipped", cycles(empty, dot, row(x => x < 256 ? 1 : 0))).verdict).toBe("clipped");
    expect(measureHudProbe("unclipped", cycles(empty, dot, row(x => x < 257 ? 1 : 0))).verdict).toBe("screen not still");
    expect(measureHudProbe("unclipped", cycles(dot, dot)).verdict).toBe("shown");
  });

  it("rejects incomplete, malformed and differently sized evidence", () => {
    expect(() => measureHudProbe("hidden", [])).toThrow(/complete screenshot triplets/);
    const shots = cycles(empty, empty); delete shots[1]!.after;
    expect(() => measureHudProbe("hidden", shots)).toThrow(/complete screenshot triplets/);
    expect(() => measureHudProbe("hidden", cycles(empty, Buffer.from("not a PNG")))).toThrow(/decode replay HUD screenshot/);
    expect(() => measureHudProbe("hidden", cycles(empty, row(() => 0, 512)))).toThrow(/dimensions changed/);
  });
});
