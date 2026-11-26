/**
 * The two typefaces every surface is judged in, Roboto and Liberation Sans, bound to system-ui and sans-serif
 * through a per-run fontconfig, so the site's own font stacks resolve to the named typeface. Roboto comes from the
 * pinned @expo-google-fonts/roboto package (OFL); Liberation Sans from the image (fonts-liberation, which the
 * Playwright image carries). The browser's own report of the fonts it drew with proves the binding on every render.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "playwright-core";

export const TYPEFACES = ["Roboto", "Liberation Sans"] as const;
export type Typeface = (typeof TYPEFACES)[number];
export const typefaceSlug = (t: Typeface): string => t.toLowerCase().replace(/ /g, "-");

/** Browser default text sizes (px) judged on every standard surface: default (16 px) and doubled (32 px). */
export const DEFAULT_TEXT_SIZE = 16 as const;
export const TEXT_SIZES = [DEFAULT_TEXT_SIZE, 32] as const;
export type TextSize = (typeof TEXT_SIZES)[number] | 40 | 64;

const ROBOTO_DIR = resolve(import.meta.dirname, "../../node_modules/@expo-google-fonts/roboto");
const LIBERATION_DIRS = ["/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype/liberation2", "/usr/share/fonts/liberation"];

/** The typeface's own font files (and no other family's), or an error naming what is missing. */
function fontFiles(typeface: Typeface): string[] {
  if (typeface === "Roboto") {
    if (!existsSync(ROBOTO_DIR)) throw new Error(`Roboto not found at ${ROBOTO_DIR}: run npm ci (devDependency @expo-google-fonts/roboto)`);
    return readdirSync(ROBOTO_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d00/.test(d.name))
      .flatMap(d => readdirSync(join(ROBOTO_DIR, d.name)).filter(f => f.endsWith(".ttf")).map(f => join(ROBOTO_DIR, d.name, f)));
  }
  const dir = LIBERATION_DIRS.find(d => existsSync(join(d, "LiberationSans-Regular.ttf")));
  if (!dir) throw new Error(`Liberation Sans not found in ${LIBERATION_DIRS.join(", ")}: install fonts-liberation`);
  return readdirSync(dir).filter(f => /^LiberationSans-.*\.ttf$/.test(f)).map(f => join(dir, f));
}

/**
 * Write a fontconfig file that offers only this typeface (and no other family), and return its
 * path for FONTCONFIG_FILE. Web fonts the site ships itself (IBM Plex Mono) are unaffected.
 */
export async function fontconfigFor(typeface: Typeface, root?: string): Promise<string> {
  const dir = root ?? await mkdtemp(join(tmpdir(), "render-check-fonts-"));
  const cache = join(dir, `cache-${typefaceSlug(typeface)}`);
  await mkdir(cache, { recursive: true });
  // A directory holding only this typeface: with a sibling family present (Liberation Mono), fontconfig may prefer it.
  const faces = join(dir, `faces-${typefaceSlug(typeface)}`);
  await rm(faces, { recursive: true, force: true });
  await mkdir(faces, { recursive: true });
  for (const file of fontFiles(typeface)) await symlink(file, join(faces, file.split("/").at(-1)!));
  const alias = (family: string) => `  <alias binding="strong"><family>${family}</family><prefer><family>${typeface}</family></prefer></alias>`;
  const xml = [
    '<?xml version="1.0"?>', '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">', "<fontconfig>",
    `  <dir>${faces}</dir>`, `  <cachedir>${cache}</cachedir>`,
    ...["system-ui", "sans-serif", "Arial", "Helvetica", "-apple-system", "BlinkMacSystemFont", "Segoe UI"].map(alias),
    "</fontconfig>", "",
  ].join("\n");
  const file = join(dir, `${typefaceSlug(typeface)}.conf`);
  await writeFile(file, xml);
  return file;
}

/** Glyph counts per platform font the page drew its text with, from the browser itself (DevTools CSS domain). */
export async function drawnFonts(page: Page): Promise<Record<string, number>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "body *" });
    const fonts: Record<string, number> = {};
    for (const nodeId of nodeIds) {
      try {
        const { fonts: used } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        for (const f of used) {
          const name = f.familyName + (f.isCustomFont ? " (web font)" : "");
          fonts[name] = (fonts[name] ?? 0) + f.glyphCount;
        }
      } catch { /* a node removed while reading */ }
    }
    return fonts;
  } finally { await cdp.detach(); }
}

/**
 * The render is valid only when every system-font glyph was drawn in the named typeface. Web fonts are the site's
 * own; a fallback for a symbol (an emoji, an arrow the face lacks) is allowed up to 2% of glyphs and listed.
 */
export function fontProblem(typeface: Typeface, fonts: Record<string, number>): string | null {
  const system = Object.entries(fonts).filter(([name]) => !name.endsWith("(web font)"));
  const total = system.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return null;
  const named = system.filter(([name]) => name.startsWith(typeface)).reduce((n, [, c]) => n + c, 0);
  if (named / total >= 0.98) return null;
  return `only ${named} of ${total} system-font glyphs were drawn in ${typeface}: ${system.map(([n, c]) => `${n} ${c}`).join(", ")}`;
}

/**
 * Set the browser's default font size (px) through DevTools Page.setFontSizes before navigation. Keep the returned
 * session attached until the page closes so Chromium keeps the preference.
 */
export async function applyTextSize(page: Page, textSize: TextSize): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: textSize } });
  return cdp;
}

/** Read the document root's computed font size in px, or NaN if unreadable. */
export async function rootFontSize(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
}

/**
 * The render is valid only when the document root's computed font size matches the requested browser default text
 * size (within 0.1 px for subpixel rounding).
 */
export function textSizeProblem(expected: TextSize, actualPx: number): string | null {
  if (Number.isFinite(actualPx) && Math.abs(actualPx - expected) <= 0.1) return null;
  return `document root font-size was ${Number.isFinite(actualPx) ? `${actualPx} px` : "unreadable"}, expected ${expected} px`;
}
