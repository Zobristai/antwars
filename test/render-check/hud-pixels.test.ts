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
  it.each([[500, 5], [599, 5], [600, 6]])("uses one percent of %i device pixels (limit %i)", (width, limit) => {
    const background = row(() => 0, width);
    const painted = row(() => 1, width);
    for (const n of [limit, limit + 1]) {
      const toggled = row(x => x < n ? 2 : 1, width);
      expect(measureHudProbe("hidden", cycles(painted, background, toggled))).toMatchObject({ pixelLimit: limit,
        variablePixels: n, stableDifferences: width - n, verdict: n === limit ? "shown" : "screen not still" });
      // Stable changes at or below the same floor cannot establish visibility, even with maximal allowed noise.
      const visible = row(x => x < limit + n ? 1 : 0, width);
      const flicker = row(x => x < limit ? 2 : x < limit + n ? 1 : 0, width);
      expect(measureHudProbe("hidden", cycles(visible, background, flicker))).toMatchObject({ pixelLimit: limit,
        variablePixels: limit, stableDifferences: n, verdict: n === limit ? "insufficient HUD paint" : "shown" });
    }
    const tiny = row(x => x === 0 ? 1 : 0, width);
    expect(measureHudProbe("hidden", cycles(tiny, background)).verdict).toBe("insufficient HUD paint");
    expect(measureHudProbe("hidden", cycles(background, background)).verdict).toBe("not shown");
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
    expect(measureHudProbe("unclipped", cycles(empty, dot, row(x => x < 5 ? 1 : 0))).verdict).toBe("clipped");
    expect(measureHudProbe("unclipped", cycles(empty, dot, row(x => x < 6 ? 1 : 0))).verdict).toBe("screen not still");
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
