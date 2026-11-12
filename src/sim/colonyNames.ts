/**
 * Colony names from the named Argentine ant supercolonies, for unrated matches.
 *
 * Rated matches always name their colonies COLONY_NAMES ("Very Large Colony" against
 * "Lake Hodges Colony"); nothing here changes them. An unrated lobby match draws one pair
 * of these names that published aggression tests found hostile to each other. Colony ids
 * stay 0 and 1: only the label changes.
 *
 * Hostility evidence:
 * - California: every pair of the five supercolonies is mutually antagonistic (Thomas,
 *   Payne-Makris, Suarez, Tsutsui and Holway 2006, Molecular Ecology).
 * - Japan: every pair of Japanese main, Kobe A, Kobe B and Kobe C fought (Sunamura et al.
 *   2009, Insectes Sociaux, Table 2).
 * - Across continents: European main and Californian large fought Kobe A, B and C;
 *   Catalonian fought Japanese main and Kobe A, B and C (Sunamura et al. 2009); European main
 *   fought Catalonian (Giraud, Pedersen and Keller 2002, PNAS).
 * Never opponents: European main, Californian large and Japanese main, which behave as one
 * non-aggressive unit (Sunamura et al. 2009), and Californian large with Catalonian, which no
 * paper read tested. Any pair not listed in HOSTILE_PAIRS is treated as untested.
 */
import { COLONY_NAMES } from "./config.js";
import { createRng } from "./rng.js";

export interface SupercolonyName {
  /** The label shown wherever the match names the colony. */
  readonly label: string;
  /** One line: where the supercolony is and the source naming it. */
  readonly note: string;
}

export const SUPERCOLONY_NAMES = [
  { label: "Californian Large Colony", note: "Coastal California, roughly 900 to 1,000 km (Thomas et al. 2006, Molecular Ecology; Sunamura et al. 2009, Insectes Sociaux)" },
  { label: "Lake Hodges Colony", note: "Southern California, about 11 km² (Thomas et al. 2006, Molecular Ecology)" },
  { label: "Sweetwater Colony", note: "Southern California (Thomas et al. 2006, Molecular Ecology)" },
  { label: "Lake Skinner Colony", note: "Southern California, under 1 km² (Thomas et al. 2006, Molecular Ecology)" },
  { label: "Cottonwood Colony", note: "Southern California (Thomas et al. 2006, Molecular Ecology)" },
  { label: "European Main Colony", note: "Italy to the Spanish Atlantic coast (Giraud, Pedersen and Keller 2002, PNAS; Sunamura et al. 2009, Insectes Sociaux)" },
  { label: "Catalonian Colony", note: "Eastern Spain (Giraud, Pedersen and Keller 2002, PNAS)" },
  { label: "Japanese Main Colony", note: "About 400 km of western Japan's coast (Sunamura et al. 2009, Insectes Sociaux)" },
  { label: "Kobe A Colony", note: "Kobe Port, Japan (Sunamura et al. 2009, Insectes Sociaux)" },
  { label: "Kobe B Colony", note: "Kobe Port, Japan (Sunamura et al. 2009, Insectes Sociaux)" },
  { label: "Kobe C Colony", note: "Kobe Port, Japan (Sunamura et al. 2009, Insectes Sociaux)" },
] as const satisfies readonly SupercolonyName[];

export type SupercolonyLabel = (typeof SUPERCOLONY_NAMES)[number]["label"];

/** A match's two colony labels, index = colony id. */
export type ColonyNamePair = readonly [string, string];

const CALIFORNIA = ["Californian Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony", "Cottonwood Colony"] as const;
const JAPAN = ["Japanese Main Colony", "Kobe A Colony", "Kobe B Colony", "Kobe C Colony"] as const;
const KOBE = ["Kobe A Colony", "Kobe B Colony", "Kobe C Colony"] as const;

function allPairs(names: readonly SupercolonyLabel[]): [SupercolonyLabel, SupercolonyLabel][] {
  return names.flatMap((a, i) => names.slice(i + 1).map(b => [a, b] as [SupercolonyLabel, SupercolonyLabel]));
}

/** Every pair measured hostile, unordered; the only pairs an unrated match can draw. */
export const HOSTILE_PAIRS: readonly (readonly [SupercolonyLabel, SupercolonyLabel])[] = [
  ...allPairs(CALIFORNIA),
  ...allPairs(JAPAN),
  ...KOBE.map(k => ["European Main Colony", k] as const),
  ...KOBE.map(k => ["Californian Large Colony", k] as const),
  ...(["Japanese Main Colony", ...KOBE] as const).map(j => ["Catalonian Colony", j] as const),
  ["European Main Colony", "Catalonian Colony"],
];

const hostileKeys = new Set(HOSTILE_PAIRS.map(([a, b]) => pairKey(a, b)));

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** Whether two labels were measured hostile to each other; also usable to check a larger set pair by pair. */
export function measuredHostile(a: string, b: string): boolean {
  return hostileKeys.has(pairKey(a, b));
}

/** The one-line note for a sourced label; null for any other name, including the rated "Very Large Colony". */
export function colonyNameNote(label: string): string | null {
  return SUPERCOLONY_NAMES.find(n => n.label === label)?.note ?? null;
}

/** 32-bit FNV-1a of a string's UTF-16 code units. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The pair an unrated match draws, seeded by its match key (the lobby id): the same key always draws the same pair and order. */
export function drawColonyNames(matchKey: string): ColonyNamePair {
  const rng = createRng(hash32(matchKey));
  const [a, b] = HOSTILE_PAIRS[Math.floor(rng.next() * HOSTILE_PAIRS.length)]!;
  return rng.next() < 0.5 ? [a, b] : [b, a];
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
