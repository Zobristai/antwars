/**
 * The colours of the match on this page, by colony id: each colony shows its name's colour from the shared table
 * (src/sim/colonyNames.ts) on both boards and in the HUD. A page shows one match, so the boards set it once from the
 * match's setup before they draw; until then, and for a match that carries no names, it is the rated names' colours.
 */
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { colonyColours, colourCss, supercolony, type ColonyNamePair } from "../../src/sim/colonyNames.ts";
import type { Rgb } from "./board-look.ts";
import "./colony-ground.css";

/**
 * The rated names' territory washes on the steppe look, as they have always been: amber toward orange and cyan toward
 * blue, so both read on warm earth, and cyan's a little deeper because it greys sooner there. Any other name washes in
 * its own colour, slightly darkened, at a depth between the two (colonyWash), so its colour is still set in one place.
 */
const WASH: Readonly<Record<string, { readonly hue: Rgb; readonly depth: number }>> = {
  "Very Large Colony": { hue: [0.96, 0.55, 0.05], depth: 1.0 },
  "Lake Hodges Colony": { hue: [0.0, 0.58, 0.98], depth: 1.3 },
};
const WASH_SHADE = 0.92, WASH_DEPTH = 1.2;

let names: ColonyNamePair = COLONY_NAMES;

/**
 * The lightest panel colour a colony's coloured text sits on: --aw-raise (web/index.html), a list row under the pointer
 * or keyboard focus. The page's surface and background are darker.
 */
export const TEXT_PANEL_MAX = 0x293337;
/** The dark ground behind a colony's coloured text where its colour needs one (colony-ground.css). */
export const TEXT_GROUND = 0x0b0f10;

const channel = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb: number) => 0.2126 * channel((rgb >> 16) & 255) + 0.7152 * channel((rgb >> 8) & 255) + 0.0722 * channel(rgb & 255);
/** WCAG contrast ratio of two colours, 0xRRGGBB. */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whether a colony colour's text needs a dark ground to keep 4.5:1: it does when the colour falls short of 4.5:1 on the
 * lightest panel it sits on. The rated colours never do, so a rated match's text is drawn exactly as before.
 */
export function needsTextGround(rgb: number): boolean {
  return contrastRatio(rgb, TEXT_PANEL_MAX) < 4.5;
}

/**
 * Sets the page's match; with a document, also its colony CSS colours (--aw-k0, --aw-k1) and, for each colony whose
 * colour needs one, the dark ground under its coloured text: the root's data-aw-ground lists those colonies ("0", "1")
 * and --aw-ink-ground is the ground's colour (colony-ground.css). A match that needs none carries neither.
 */
export function setMatchColonies(pair: ColonyNamePair, doc?: Document): void {
  names = pair;
  if (!doc) return;
  const root = doc.documentElement;
  const colours = colonyColours(pair);
  root.style.setProperty("--aw-k0", colourCss(colours[0]));
  root.style.setProperty("--aw-k1", colourCss(colours[1]));
  const grounded = ([0, 1] as const).filter(c => needsTextGround(colours[c]));
  if (grounded.length > 0) {
    root.setAttribute("data-aw-ground", grounded.join(" "));
    root.style.setProperty("--aw-ink-ground", colourCss(TEXT_GROUND));
  } else {
    root.removeAttribute("data-aw-ground");
    root.style.removeProperty("--aw-ink-ground");
  }
}

/** A colony's colour as 0xRRGGBB. */
export function colonyTint(colony: number): number {
  return colonyColours(names)[colony === 1 ? 1 : 0];
}

/** A colony's colour as 0..1 channels. */
export function colonyRgb(colony: number): readonly [number, number, number] {
  const c = colonyTint(colony);
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/** Both colonies' colours as 0..1 channels, index = colony id. */
export function colonyRgbs(): readonly [readonly [number, number, number], readonly [number, number, number]] {
  return [colonyRgb(0), colonyRgb(1)];
}

/** A colony's territory wash on the steppe look. */
export function colonyWash(colony: number): { readonly hue: Rgb; readonly depth: number } {
  const id = colony === 1 ? 1 : 0;
  // Own entries only, so a name such as "constructor" never reads an inherited member; a name outside the table keeps
  // its colony's classic wash, as colonyColours keeps its classic colour.
  const name = supercolony(names[id]) ? names[id] : COLONY_NAMES[id];
  const own = Object.hasOwn(WASH, name) ? WASH[name] : undefined;
  if (own) return own;
  const [r, g, b] = colonyRgb(colony);
  return { hue: [r * WASH_SHADE, g * WASH_SHADE, b * WASH_SHADE], depth: WASH_DEPTH };
}
