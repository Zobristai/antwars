/** CPU albedo and upload-normalization checks, not rendered pixel proof. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { soilAt } from "../../web/src/board3d/noise.ts";

const groundSource = readFileSync(new URL("../../web/src/board3d/ground.ts", import.meta.url), "utf8");

// The previous base albedo at 8a1815bec17decf53d5c161e437bf1d85879d6f0.
const oldBase = [0.12, 0.105, 0.09];

describe("lighter 3D ground palette", () => {
  it("keeps every sampled channel lighter than the old maximum without clipping or saturated green", () => {
    const rgb = [0, 0, 0];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let maxChroma = 0, greenOrder = true;
    for (let y = -16; y <= 144; y += 1.625) for (let x = -16; x <= 144; x += 1.375) {
      soilAt(x, y, rgb);
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c]!, rgb[c]!);
        max[c] = Math.max(max[c]!, rgb[c]!);
      }
      maxChroma = Math.max(maxChroma, Math.max(...rgb) - Math.min(...rgb));
      greenOrder &&= rgb[1]! >= rgb[0]! && rgb[0]! > rgb[2]!;
    }
    expect(greenOrder).toBe(true);
    expect(maxChroma).toBeLessThan(0.15);
    for (let c = 0; c < 3; c++) {
      expect(min[c]).toBeGreaterThan(oldBase[c]! + 0.012);
      expect(max[c]).toBeLessThan(1);
    }
  });

  it("normalizes quantized soil around the new albedo rather than saturating at the old baseline", () => {
    const match = /float grain = clamp\(\(soil\.r - ([\d.]+)\) \/ ([\d.]+), -0\.10, 0\.10\);/.exec(groundSource);
    expect(match).not.toBeNull();
    const centre = Number(match![1]), divisor = Number(match![2]);
    expect(centre).toBe(0.44);
    expect(divisor).toBe(centre);
    const rgb = [0, 0, 0];
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < 16; y += 0.125) for (let x = 0; x < 16; x += 0.125) {
      soilAt(x, y, rgb);
      // Same 8-bit truncation as the unchanged Uint8Array upload, before the
      // texture's linear interpolation. Interpolation stays within these bounds.
      const uploadedRed = Math.floor(rgb[0]! * 255) / 255;
      const normalized = (uploadedRed - centre) / divisor;
      lo = Math.min(lo, normalized);
      hi = Math.max(hi, normalized);
    }
    expect(lo).toBeGreaterThan(-0.04);
    expect(lo).toBeLessThan(-0.01);
    expect(hi).toBeGreaterThan(0.01);
    expect(hi).toBeLessThan(0.04);
  });
});
