/**
 * Faded metadata computed to about 2.4:1 on the
 * surface at the reviewed head, the metadata ink under an extra 0.6 opacity on faded feed lines.
 * The metadata ink itself now clears 4.5:1 wherever metadata sits at rest, and no rule fades a
 * feed line or an idle agent's order by opacity on top of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(html);
  expect(m, `--${name} in web/index.html`).not.toBeNull();
  return m![1]!.trim();
}

/** A hex colour or rgba() as [r, g, b, a]. */
function parse(css: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) return [parseInt(hex[1]!.slice(0, 2), 16), parseInt(hex[1]!.slice(2, 4), 16), parseInt(hex[1]!.slice(4, 6), 16), 1];
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(css);
  expect(rgba, css).not.toBeNull();
  return [Number(rgba![1]), Number(rgba![2]), Number(rgba![3]), Number(rgba![4])];
}

const channel = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast of a translucent ink composited over an opaque background, against that background. */
function contrast(ink: string, background: string): number {
  const [r, g, b, a] = parse(ink);
  const bg = parse(background);
  const over = [r, g, b].map((v, i) => a * v + (1 - a) * bg[i]!);
  const [hi, lo] = [luminance(over), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("metadata ink is readable", () => {
  it("the metadata ink clears 4.5:1 on the surface, a raised row and the page; the secondary ink clears 7:1", () => {
    for (const bg of ["aw-surface", "aw-raise", "aw-bg"]) expect(contrast(token("aw-ink-3"), token(bg)), `--aw-ink-3 on --${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("aw-ink-2"), token("aw-surface"))).toBeGreaterThanOrEqual(7);
  });

  it("a fallen colony's words keep at least 3:1 at 0.6", () => {
    // The 2D HUD dims a fallen colony's name and figures to 0.6 (web/src/ui/ui.css .is-fallen) in these tokens.
    // Hatched and lost are in the secondary ink too.
    expect(html).toMatch(/\.aw-tally-side \{[^}]*color: var\(--aw-ink-2\);/);
    expect(html).not.toMatch(/\.aw-fallen-0 \.aw-bug \.c0/);
    // Each colony's colour at 0.6 over the surface, as its dimmed name reads, and the bright ink at 0.6, as its share reads.
    const at = (css: string, alpha: number) => {
      const [r, g, b] = parse(css);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    for (const colour of ["aw-c0", "aw-c1", "aw-ink-bright"]) expect(contrast(at(token(colour), 0.6), token("aw-surface")), `--${colour} at 0.6`).toBeGreaterThanOrEqual(3);
    // A share not leading reads in the secondary ink (the leader's share bright), itself translucent.
    expect(contrast(at(token("aw-ink-2"), parse(token("aw-ink-2"))[3] * 0.6), token("aw-surface")), "--aw-ink-2 at 0.6").toBeGreaterThanOrEqual(3);
  });

  it("no rule fades a feed line, or an idle agent's order in the Agents list, by opacity on top of its ink", () => {
    expect(html).not.toMatch(/\.aw-chat[^{}]*\{[^}]*\bopacity\s*:/);
    expect(html).not.toMatch(/\.is-faded[^{}]*\{[^}]*\bopacity\s*:/);
    // An agent's order is its Agents row's; an idle agent's order steps back to the metadata ink, never by opacity.
    expect(html).not.toMatch(/\.aw-order[^{}]*\{[^}]*\bopacity\s*:/);
  });
});
