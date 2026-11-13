/**
 * The four colonies a match can be named after, each with its own colour: Argentine ant supercolonies of southern
 * California, every pair of which is mutually hostile ("All supercolonies are mutually antagonistic to one another",
 * Thomas, Payne-Makris, Suarez, Tsutsui and Holway 2006, Molecular Ecology).
 *
 * Rated matches always name their colonies COLONY_NAMES ("Very Large Colony" against "Lake Hodges Colony") in their
 * colours, so they look as they always have. An unrated lobby match draws one pair of the four. Colony ids stay 0 and
 * 1: only the label and its colour change. A mode with four colonies can use all four.
 */
import { COLONY_NAMES } from "./config.js";
import { createRng } from "./rng.js";

export interface SupercolonyName {
  /** The label shown wherever the match names the colony. */
  readonly label: string;
  /** One line: where the supercolony is and the source naming it. */
  readonly note: string;
  /**
   * The colony's one colour (0xRRGGBB) wherever its name appears: its ants, territory, name and score. Every one of its
   * agents shows this same colour, in every match; agents within a colony are told apart by their glyph and name.
   */
  readonly colour: number;
}

/**
 * The four, in table order, and the one place their colours are defined: one colour per colony. Very Large and Lake
 * Hodges keep the colours colonies 0 and 1 have always had. Sweetwater's and Lake Skinner's colours must stay apart
 * from those two, from each other and from the board's own colours (food greens, the ants' light body, white
 * highlights), and read as text on the page's dark background; test/sim/colony-names.test.ts checks each of these for
 * whatever value is set here.
 */
export const SUPERCOLONY_NAMES = [
  {
    label: "Very Large Colony",
    note: "The Californian large supercolony: coastal California, roughly 900 to 1,000 km (Thomas et al. 2006, Molecular Ecology; Sunamura et al. 2009, Insectes Sociaux)",
    colour: 0xffb000,
  },
  {
    label: "Lake Hodges Colony",
    note: "Southern California, about 11 km² (Thomas et al. 2006, Molecular Ecology)",
    colour: 0x00c2ff,
  },
  {
    label: "Sweetwater Colony",
    note: "Southern California (Thomas et al. 2006, Molecular Ecology)",
    colour: 0xff1e1e,
  },
  {
    label: "Lake Skinner Colony",
    note: "Southern California, under 1 km² (Thomas et al. 2006, Molecular Ecology)",
    colour: 0x009078,
  },
] as const satisfies readonly SupercolonyName[];

export type SupercolonyLabel = (typeof SUPERCOLONY_NAMES)[number]["label"];

/** A match's two colony labels, index = colony id. */
export type ColonyNamePair = readonly [string, string];

/** Every pair of the four, unordered: all are mutually hostile, so any can be drawn. */
export const HOSTILE_PAIRS: readonly (readonly [SupercolonyLabel, SupercolonyLabel])[] = SUPERCOLONY_NAMES.flatMap((a, i) =>
  SUPERCOLONY_NAMES.slice(i + 1).map(b => [a.label, b.label] as const));

/** The table row of a label; undefined for any other name. */
export function supercolony(label: string): SupercolonyName | undefined {
  return SUPERCOLONY_NAMES.find(n => n.label === label);
}

/** The one-line source note of one of the four; null for any other name. */
export function colonyNameNote(label: string): string | null {
  return supercolony(label)?.note ?? null;
}

/** 32-bit FNV-1a of a string's UTF-16 code units. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * The pair an unrated match draws, seeded by its match key (the lobby id): the same key always draws the same pair and
 * order. Any of the six pairs can be drawn. Very Large with Lake Hodges is always drawn as Lake Hodges for colony 0, so
 * a drawn pair is never the rated names in the rated order and always reads as the match's own.
 */
export function drawColonyNames(matchKey: string): ColonyNamePair {
  const rng = createRng(hash32(matchKey));
  const [a, b] = HOSTILE_PAIRS[Math.floor(rng.next() * HOSTILE_PAIRS.length)]!;
  const pair: ColonyNamePair = rng.next() < 0.5 ? [a, b] : [b, a];
  return isClassicColonyNames(pair) ? [pair[1], pair[0]] : pair;
}

/**
 * A lobby match's colony names: rated (a ranked mode) keeps COLONY_NAMES; unrated draws from its lobby id.
 * Matches outside a lobby keep COLONY_NAMES.
 */
export function lobbyColonyNames(lobbyId: string, rated: boolean): ColonyNamePair {
  return rated ? COLONY_NAMES : drawColonyNames(lobbyId);
}

/** Whether a pair is the rated names, which streams and records leave implicit. */
export function isClassicColonyNames(names: ColonyNamePair): boolean {
  return names[0] === COLONY_NAMES[0] && names[1] === COLONY_NAMES[1];
}

/** A match's names from what it carries (a stream setup, a listed row): its drawn pair, or COLONY_NAMES when it carries none. */
export function colonyNamesOf(match: { readonly colonyNames?: readonly [string, string] | null } | null | undefined): ColonyNamePair {
  return match?.colonyNames ?? COLONY_NAMES;
}

/**
 * A colony's table row by its name, or by its id when the name is not one of the four (a match outside the table keeps
 * colony 0's and colony 1's own colours).
 */
function rowOf(names: ColonyNamePair, colony: 0 | 1): SupercolonyName {
  return supercolony(names[colony]) ?? SUPERCOLONY_NAMES[colony];
}

/** Each colony's colour in a match named `names`, index = colony id. */
export function colonyColours(names: ColonyNamePair): readonly [number, number] {
  return [rowOf(names, 0).colour, rowOf(names, 1).colour];
}

/** A colour as CSS (#rrggbb). */
export function colourCss(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}
