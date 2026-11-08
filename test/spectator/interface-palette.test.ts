/** Interface palette relationships; browser coverage is recorded separately. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLEAR_RGB } from "../../web/src/board3d/ground.ts";

const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
const token = (name: string) => new RegExp(`--aw-${name}:\\s*([^;]+);`).exec(html)![1]!.trim();
const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16));
const luminance = (channels: number[]) => channels.map(v => v / 255)
  .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: number[], b: number[]) => {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
};

describe("matching interface palette", () => {
  it("keeps page, Pixi clear and 3D clear in the same sRGB representation", () => {
    expect(main).toContain(`background: "${token("bg")}"`);
    expect(CLEAR_RGB).toEqual(rgb(token("bg")).map(v => v / 255));
  });

  it("uses near-neutral surfaces with an ordered raised and hover hierarchy", () => {
    const colours = ["bg", "surface", "raise", "raise-hover"].map(name => rgb(token(name)));
    for (const colour of colours) expect(Math.max(...colour) - Math.min(...colour)).toBeLessThanOrEqual(16);
    for (let i = 1; i < colours.length; i++) expect(luminance(colours[i]!)).toBeGreaterThan(luminance(colours[i - 1]!));
  });

  it("keeps metadata legible even on hover, and primary words on every neutral surface", () => {
    const metadata = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(token("ink-3"))!;
    const ink = metadata.slice(1, 4).map(Number), alpha = Number(metadata[4]);
    for (const name of ["bg", "surface", "raise", "raise-hover"]) {
      const background = rgb(token(name));
      expect(contrast(ink.map((v, i) => alpha * v + (1 - alpha) * background[i]!), background), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(token("ink")), background), name).toBeGreaterThanOrEqual(7);
    }
  });

  it("keeps no legacy warm neutrals", () => {
    expect(html).not.toContain("rgba(240, 230, 214,");
    expect(html).not.toContain("rgba(23, 18, 12,");
  });
});
