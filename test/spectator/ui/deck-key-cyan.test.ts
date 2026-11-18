// Score Band keeps the match Key in its footer, and Bring your agent stays the emblem's
// cyan with the page's dark text. Visual evidence comes from browser captures, never these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const CSS = read("web/src/ui/deck/deck.css");
const HUD = read("web/src/ui/deck/hud.ts");
const INDEX = read("web/index.html");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at + selector.length + 2, CSS.indexOf("}", at));
}
/** A page colour token's hex value from web/index.html. */
function token(name: string): string {
  const m = new RegExp(`${name}: (#[0-9a-fA-F]{6});`).exec(INDEX);
  expect(m, `token ${name}`).not.toBeNull();
  return m![1]!.toLowerCase();
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
/** WCAG 2 relative luminance and contrast ratio. */
function luminance(c: number[]): number {
  const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("deck: a footer Key and a cyan Bring your agent", () => {
  it("places the existing Key beside Rules with a controlled expanding explanation", () => {
    expect(HUD).toContain('rulesKey.append(rules, keyToggle)');
    expect(HUD).toContain('foot.append(rulesKey, inspired, teams.offer,');
    expect(HUD).toContain('keyToggle.type = "button"');
    expect(HUD).toContain('keyToggle.setAttribute("aria-controls", "score-band-key")');
    expect(HUD).toContain('setAttr(keyToggle, "aria-expanded", String(!key.hidden))');
    expect(HUD).toContain('keyText(VISUAL_KEY)');
    expect(HUD).toContain('config ? logExplainer(config) : LOG_EXPLAINER');
    expect(rule(".sb-rules-key")).toContain("white-space: nowrap");
    expect(rule(".sb-key")).toContain("white-space: normal");
  });

  it("paints the button the emblem's cyan with the page's dark text, at least 4.5:1", () => {
    expect(token("--aw-c1")).toBe("#00c2ff");
    const button = rule(".d1-agent-button");
    expect(button).toMatch(/background: var\(--aw-c1\);/);
    expect(button).toMatch(/color: var\(--aw-bg\);/);
    expect(rule(".d1 .d1-agent-button")).toMatch(/color: var\(--aw-bg\);/);
    expect(contrast(rgb(token("--aw-c1")), rgb(token("--aw-bg")))).toBeGreaterThanOrEqual(4.5);
  });

  it("lightens the cyan on hover, and keeps the deck's focus ring", () => {
    const hover = rule(".d1-agent-button:hover");
    const mix = /background: color-mix\(in srgb, var\(--aw-c1\) (\d+)%, #fff\);/.exec(hover);
    expect(mix, "hover mixes the cyan with white").not.toBeNull();
    const cyan = Number(mix![1]);
    expect(cyan).toBeGreaterThan(0);
    expect(cyan).toBeLessThanOrEqual(80);
    // The lighter cyan still carries the dark text.
    const lighter = rgb(token("--aw-c1")).map(v => Math.round((v * cyan + 255 * (100 - cyan)) / 100));
    expect(contrast(lighter, rgb(token("--aw-bg")))).toBeGreaterThanOrEqual(4.5);
    expect(rule(".d1 :focus-visible")).toMatch(/outline: 2px solid var\(--aw-ink-bright\)/);
  });

  // The dialog's Copy takes the same cyan button style.
  it("paints the dialog's Copy in the Bring your agent cyan, with the same hover", () => {
    const copy = rule(".d1-dialog .aw-byoa-copy");
    expect(copy).toMatch(/background: var\(--aw-c1\);/);
    expect(copy).toMatch(/color: var\(--aw-bg\);/);
    expect(rule(".d1-dialog .aw-byoa-copy:hover")).toBe(rule(".d1-agent-button:hover"));
    // The phone rule sets size only, so the cyan holds on phones too.
    const phone = /\.d1-dialog \.aw-byoa-copy \{ min-height: 44px;[^}]*\}/.exec(CSS);
    expect(phone, "phone Copy rule").not.toBeNull();
    expect(phone![0]).not.toMatch(/background|color/);
    // Copy prompt carries .aw-byoa-copy (agent.test.ts, top-bar.test.ts), so this one rule paints it; nothing repaints it.
    expect(rule(".d1-dialog .aw-byoa-prompt")).not.toMatch(/background|color/);
    expect(CSS).not.toMatch(/\.aw-byoa-prompt-copy/);
  });
});
