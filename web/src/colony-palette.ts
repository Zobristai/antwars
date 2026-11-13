/**
 * The colours of the match on this page, by colony id: each colony shows its name's colour from the shared table
 * (src/sim/colonyNames.ts) on both boards and in the HUD. A page shows one match, so the boards set it once from the
 * match's setup before they draw; until then, and for a match that carries no names, it is the rated names' colours.
 */
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { colonyAgentShades, colonyColours, colourCss, supercolony, type ColonyNamePair } from "../../src/sim/colonyNames.ts";
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

let names: ColonyNamePair = COLONY_NAMES;

/** Sets the page's match; with a document, also its colony CSS colours (--aw-k0, --aw-k1). */
export function setMatchColonies(pair: ColonyNamePair, doc?: Document): void {
  names = pair;
  if (!doc) return;
  const [c0, c1] = colonyColours(pair);
  doc.documentElement.style.setProperty("--aw-k0", colourCss(c0));
  doc.documentElement.style.setProperty("--aw-k1", colourCss(c1));
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

/** A colony's agents' shades, in join order within the colony. */
export function colonyShades(colony: number): readonly number[] {
  return colonyAgentShades(names)[colony === 1 ? 1 : 0];
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
