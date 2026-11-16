/**
 * The colours of the match on this page, by colony id: each of its colonies (two, or four) shows its name's colour from
 * the shared table (src/sim/colonyNames.ts) on both boards and in the HUD. A page shows one match, so the boards set it
 * once from the match's setup before they draw; until then, and for a match that carries no names, it is the rated
 * names' colours.
 */
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { SUPERCOLONY_NAMES, colonyColours, colourCss, supercolony } from "../../src/sim/colonyNames.ts";
import type { Rgb } from "./board-look.ts";

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

let names: readonly string[] = COLONY_NAMES;
let colours: readonly number[] = colonyColours(names);

/** The most colonies a match has, so the most colony CSS colours a page sets (--aw-k0 to --aw-k3). */
const MAX_COLONIES = SUPERCOLONY_NAMES.length;

/** Sets the page's match and its colony CSS colours, one per colony (--aw-k0 to --aw-k3). */
export function setMatchColonies(matchNames: readonly string[], doc?: Document): void {
  names = matchNames;
  colours = colonyColours(matchNames);
  if (!doc) return;
  const root = doc.documentElement;
  for (let c = 0; c < MAX_COLONIES; c++) {
    if (c < colours.length) root.style.setProperty(`--aw-k${c}`, colourCss(colours[c]));
    else root.style.removeProperty(`--aw-k${c}`);
  }
}

/** A colony of the page's match by its id; any other value reads as colony 0, as it always has. */
const colonyOf = (colony: number) => (Number.isInteger(colony) && colony > 0 && colony < colours.length ? colony : 0);

/** A colony's colour as 0xRRGGBB. */
export function colonyTint(colony: number): number {
  return colours[colonyOf(colony)];
}

/** A colony's colour as 0..1 channels. */
export function colonyRgb(colony: number): readonly [number, number, number] {
  const c = colonyTint(colony);
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/** Every colony's colour in the page's match as 0..1 channels, one per colony, index = colony id. */
export function colonyRgbs(): readonly (readonly [number, number, number])[] {
  return colours.map((_, c) => colonyRgb(c));
}

/** A colony's territory wash on the steppe look. */
export function colonyWash(colony: number): { readonly hue: Rgb; readonly depth: number } {
  const id = colonyOf(colony);
  // Own entries only, so a name such as "constructor" never reads an inherited member; a name outside the table keeps
  // its colony's own table wash, as colonyColours keeps its own table colour.
  const name = supercolony(names[id]) ? names[id] : SUPERCOLONY_NAMES[id].label;
  const own = Object.hasOwn(WASH, name) ? WASH[name] : undefined;
  if (own) return own;
  const [r, g, b] = colonyRgb(colony);
  return { hue: [r * WASH_SHADE, g * WASH_SHADE, b * WASH_SHADE], depth: WASH_DEPTH };
}
