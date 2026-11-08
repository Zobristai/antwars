import { describe, expect, it } from "vitest";
import { WATER_GLSL } from "../../web/src/terrain.ts";

// Numeric albedo guardrails, not rendered pixel proof. A browser check covers the
// assembled palette in Chromium/WebKit on both boards and at both sizes.
describe("shared water palette", () => {
  it("keeps the original ripple and composition, changing only the two RGB endpoints", () => {
    const withoutColours = WATER_GLSL.replace(/vec3\([\d., ]+\)/g, "vec3(RGB)");
    expect(withoutColours.trim()).toBe(`vec3 awWaterColour(vec2 tile) {
  float ripple = 0.5 + 0.5 * sin(tile.y * 12.0 + sin(tile.x * 3.0));
  return mix(vec3(RGB), vec3(RGB), ripple * 0.35);
}`);
  });

  it("keeps every ripple shade muted blue and darker than the light ground", () => {
    const endpoints = [...WATER_GLSL.matchAll(/vec3\(([\d., ]+)\)/g)]
      .map((match) => match[1].split(",").map(Number));
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toEqual([0.09, 0.24, 0.30]);
    expect(endpoints[1]).toEqual([0.14, 0.34, 0.41]);

    // ripple is in [0,1], scaled by 0.35. Channel differences and weighted
    // brightness are linear, so checking both ends bounds every shade.
    for (const mix of [0, 0.35]) {
      const [r, g, b] = endpoints[0].map((v, i) => v + (endpoints[1][i] - v) * mix);
      expect(r).toBeGreaterThan(0);
      expect(b).toBeLessThan(0.4);
      expect(g - r).toBeGreaterThan(0.12);
      expect(b - g).toBeGreaterThan(0.05);
      expect(b - r).toBeGreaterThan(0.18);
      // Albedo brightness only, not a display contrast ratio or lighting claim.
      // The 2D deep ground before vignette is [0.44,0.46,0.37]; 3D's base is identical.
      const waterBrightness = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const groundBrightness = (0.2126 * 0.44 + 0.7152 * 0.46 + 0.0722 * 0.37) * 0.78;
      expect(groundBrightness - waterBrightness).toBeGreaterThan(0.08);
    }
  });
});
