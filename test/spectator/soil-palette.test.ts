/** Colour-range and unchanged-renderer checks, not browser pixel proof. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../web/src/soil.ts", import.meta.url), "utf8");
const triple = (name: string): number[] => {
  const match = new RegExp(`vec3 ${name} = vec3\\(([^)]+)\\);`).exec(source);
  expect(match, `${name} colour in the actual soil shader`).not.toBeNull();
  const values = match![1]!.split(",").map(Number);
  expect(values).toHaveLength(3);
  return values;
};
const edge = (): number => {
  const match = /col \*= mix\(([\d.]+), 1\.0, vig\);/.exec(source);
  expect(match).not.toBeNull();
  return Number(match![1]);
};

// Source snapshot at 8a1815bec17decf53d5c161e437bf1d85879d6f0 plus the board-look branch, with only the
// two base RGB values and vignette attenuation masked. This catches accidental
// changes to noise coordinates, geometry, uniforms, bake dimensions and disposal.
function nonColourSource(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/vec3 (deep|warm) = vec3\([^;]+;/g, "vec3 $1 = PALETTE;")
    .replace(/col \*= mix\([\d.]+, 1\.0, vig\);/, "col *= mix(PALETTE, 1.0, vig);")
    .replace(/\s+/g, " ").trim();
}

describe("lighter 2D soil palette", () => {
  it("preserves every non-colour part of the captured soil renderer", () => {
    expect(createHash("sha256").update(nonColourSource(source)).digest("hex"))
      .toBe("61f126a884b2c22e95e957a0014e899f0a33ef6ae028ebf1be8a7e32e38d55c8");
  });

  it("uses bounded, desaturated grey-green earth rather than the old red-dominant brown", () => {
    for (const rgb of [triple("deep"), triple("warm")]) {
      for (const channel of rgb) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThan(1);
      }
      expect(rgb[1]!).toBeGreaterThanOrEqual(rgb[0]!);
      expect(rgb[0]!).toBeGreaterThan(rgb[2]!);
      expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(0.15);
    }
  });

  it("keeps even the dimmest new soil above the brightest old soil in every channel", () => {
    // Conservative bounds from the unchanged shader: mid is in [0,1], grain
    // contributes +/-0.008, and pebble contributes at most 0.25 * its RGB.
    // The old endpoint and pebble values come from the pinned source, not a
    // recaptured image. Bounds establish colour arithmetic only, not rendered style.
    const oldWarm = [0.150, 0.102, 0.066];
    const pebble = [0.06, 0.05, 0.04];
    const deep = triple("deep"), warm = triple("warm");
    expect(edge()).toBeGreaterThan(0);
    expect(edge()).toBeLessThanOrEqual(1);
    for (let c = 0; c < 3; c++) {
      const oldMax = oldWarm[c]! * 1.05 + 0.008 + 0.25 * pebble[c]!;
      const newMin = (Math.min(deep[c]!, warm[c]!) * 0.9 - 0.008) * edge();
      const newMax = Math.max(deep[c]!, warm[c]!) * 1.05 + 0.008 + 0.25 * pebble[c]!;
      expect(newMin, `channel ${c} at the vignette edge`).toBeGreaterThan(oldMax);
      expect(newMax, `channel ${c} without clipping`).toBeLessThan(1);
    }
  });
});
