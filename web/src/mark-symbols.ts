/** Board-only command symbols. Agent identity glyphs and the stream stay unchanged. */
import type { CountVerb } from "../../src/sim/types.ts";

/** The verbs with a board symbol: the four count verbs and the rules-26 LINE mark. PATROL keeps the owner glyph. */
export type MarkSymbol = CountVerb | "LINE";

/** Notched battlement, asymmetric leaf, lightning bolt, flag and slanted bar, within a unit radius. */
const SYMBOLS = {
  // A broad square notch and flat base survive at phone size, unlike the old diamond-like shield.
  DEFEND: [-1, -0.9, -0.4, -0.9, -0.4, 0.1, 0.4, 0.1, 0.4, -0.9, 1, -0.9, 1, 0.85, -1, 0.85],
  FORAGE: [-0.9, 0.95, -0.65, 0.15, -0.85, -0.35, -0.25, -0.85, 0.8, -0.95, 0.9, -0.15, 0.55, 0.55, -0.15, 0.65, -0.5, 0.4, -0.65, 1],
  ATTACK: [0.2, -1, -0.8, 0.2, -0.15, 0.2, -0.35, 1, 0.85, -0.25, 0.2, -0.25],
  GATHER: [-0.85, -1, 0.85, -1, 0.5, -0.35, 0.85, 0.3, -0.5, 0.3, -0.5, 1, -0.85, 1],
  // A thick bar corner to corner: the line the mark's ants stand along.
  LINE: [-1, 0.55, 0.55, -1, 1, -0.55, -0.55, 1],
} as const satisfies Record<MarkSymbol, readonly number[]>;

/** Unknown or absent verbs from older recordings keep the owner glyph, not a guessed command. */
export function markSymbol(verb: string | undefined): MarkSymbol | null {
  switch (verb) {
    case "DEFEND": case "FORAGE": case "ATTACK": case "GATHER": case "LINE": return verb;
    default: return null;
  }
}

/** The same vector is drawn inside the marker and beside the compact count; no font-dependent glyphs. */
export function markSymbolPolygon(verb: MarkSymbol, radius: number): number[] {
  return SYMBOLS[verb].map((v) => v * radius);
}
