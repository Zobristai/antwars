// The watch view's icon set, "Field Stencil" (ported): its registration and its masks.
// Asset checks only; how the masks look on the boards and HUDs is evidence from the served build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng } from "../../../scripts/favicon.ts";
import { iconKeys, iconSet, type IconKey } from "../../../web/src/icons/set.ts";

/** Twice each key's largest 1x draw size, so linear sampling without mipmaps averages cleanly where it is drawn. */
const SIZE: Record<IconKey, readonly [number, number]> = {
  close: [32, 32], "zoom-out": [36, 36], "zoom-in": [36, 36], whole: [32, 32], chevron: [28, 16], info: [32, 32], idle: [28, 28],
  flag: [40, 40], worker: [24, 24], soldier: [24, 24],
  "order-attack": [28, 28], "order-forage": [28, 28], "order-hold": [28, 28], "order-follow_trail": [28, 28], "order-go_to": [28, 28], "order-guard": [28, 28],
  crown: [28, 28], "mark-DEFEND": [24, 24], "mark-FORAGE": [24, 24], "mark-ATTACK": [24, 24], "mark-GATHER": [24, 24], "mark-LINE": [24, 24],
  "glyph-diamond": [18, 18], "glyph-triangle": [18, 18], "glyph-square": [18, 18], "glyph-circle": [18, 18], "glyph-star": [18, 18],
  "glyph-hexagon": [18, 18], "glyph-chevron": [18, 18], "glyph-cross": [18, 18],
};

const path = (src: string) => fileURLToPath(src);
const read = (src: string) => decodePng(readFileSync(path(src)));
const masks = (key: IconKey) => ({ fill: read(iconSet[key]!.src), second: read(iconSet[key]!.second!.src) });

describe("Field Stencil icon set", () => {
  it("registers a fill and a second mask for every semantic key, including − + ×, each a PNG named for its key", () => {
    expect(Object.keys(iconSet).sort()).toEqual([...iconKeys].sort());
    for (const key of iconKeys) {
      const { src, second } = iconSet[key]!;
      expect(second, key).toBeDefined();
      for (const [folder, file] of [["fill", path(src)], ["second", path(second!.src)]] as const) {
        expect(basename(file)).toBe(`${key}.png`);
        expect(basename(dirname(file))).toBe(folder);
      }
    }
  });

  it.each(iconKeys)("%s: both masks are white on transparent at the pre-filtered size, with a clear edge", key => {
    for (const [name, { width, height, data }] of Object.entries(masks(key))) {
      expect([width, height], name).toEqual(SIZE[key]);
      let coloured = 0, edge = 0, solid = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4, a = data[o + 3]!;
        if (a > 0 && (data[o] !== 255 || data[o + 1] !== 255 || data[o + 2] !== 255)) coloured++;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = Math.max(edge, a);
        if (a >= 250) solid++;
      }
      expect(coloured, name).toBe(0); // hue only ever comes from the runtime tint
      expect(edge, name).toBeLessThanOrEqual(8); // nothing touches the quad's edge, which the boards draw without antialiasing
      expect(solid, name).toBeGreaterThan(0);
    }
  });

  it.each(iconKeys)("%s: the darker part is a solid part inside the opaque footprint, never a see-through pass", key => {
    const { fill, second } = masks(key);
    let outside = 0, fillArea = 0, secondArea = 0;
    for (let i = 3; i < fill.data.length; i += 4) {
      const f = fill.data[i]!, s = second.data[i]!;
      if (s > f) outside++;
      fillArea += f; secondArea += s;
    }
    // Solid second-mask pixels lie over fill pixels at least as opaque, so the seam's 70% shade covers the ground.
    expect(outside).toBe(0);
    // Two tones on every icon, the chevron included: the darker part is a real share of the footprint.
    expect(secondArea / fillArea).toBeGreaterThan(0.25);
    expect(secondArea / fillArea).toBeLessThan(0.9);
  });

  it.each(["chevron", "zoom-out"] as const)("%s: the full-shade part is the left half and the darker part the right", key => {
    const { fill, second } = masks(key);
    const half = { working: [0, 0], darker: [0, 0] };
    for (let y = 0; y < fill.height; y++) for (let x = 0; x < fill.width; x++) {
      const i = (y * fill.width + x) * 4 + 3, side = x < fill.width / 2 ? 0 : 1;
      half.working[side]! += fill.data[i]! - second.data[i]!;
      half.darker[side]! += second.data[i]!;
    }
    expect(half.working[1]).toBe(0);
    expect(half.darker[0]).toBe(0);
    expect(half.working[0]).toBeGreaterThan(0);
    expect(half.darker[1]).toBeGreaterThan(0);
  });

  it("keeps the disclosure chevron's 14 by 8 proportion, so its masks are not stretched", () => {
    const { fill, second } = masks("chevron");
    expect(fill.width / fill.height).toBeCloseTo(14 / 8, 5);
    expect([second.width, second.height]).toEqual([fill.width, fill.height]);
  });
});
