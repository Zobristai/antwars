// Unrated matches' colony names: four mutually hostile supercolonies, each with its own colour, drawn as a pair per
// match; rated matches keep the rated names and colours.
import { describe, expect, it } from "vitest";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import {
  HOSTILE_PAIRS, SUPERCOLONY_NAMES, colonyAgentShades, colonyColours, colonyNameNote, colonyNamesOf, drawColonyNames, isClassicColonyNames,
  lobbyColonyNames,
} from "../../src/sim/colonyNames.ts";

const key = (a: string, b: string) => [a, b].sort().join(" | ");
const LABELS = ["Very Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony"];
// The two added colours, read from the table: the one place they are set.
const SWEETWATER = SUPERCOLONY_NAMES[2].colour, LAKE_SKINNER = SUPERCOLONY_NAMES[3].colour;

// Colour distance: OKLab (Ottosson), in linear sRGB.
const linear = (rgb: number) => [16, 8, 0].map(s => { const c = ((rgb >> s) & 255) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const oklab = ([r, g, b]: number[]) => {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const distance = (a: number, b: number) => {
  const p = oklab(linear(a)), q = oklab(linear(b));
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
};
const luminance = (rgb: number) => { const [r, g, b] = linear(rgb); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const contrast = (a: number, b: number) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("the colony names", () => {
  it("are the four supercolonies, each a label ending in ' Colony' with a one-line source note", () => {
    expect(SUPERCOLONY_NAMES.map(n => n.label)).toEqual(LABELS);
    for (const { label, note } of SUPERCOLONY_NAMES) {
      expect(label.endsWith(" Colony")).toBe(true);
      expect(colonyNameNote(label)).toBe(note);
      expect(note).not.toContain("\n");
      expect(note).toMatch(/\(.*20\d\d.*\)$/);
    }
    expect(colonyNameNote("Some Other Colony")).toBeNull();
  });

  it("are all mutually hostile, so the six pairs are the allowed pairs", () => {
    expect(new Set(HOSTILE_PAIRS.map(([a, b]) => key(a, b)))).toEqual(new Set(LABELS.flatMap((a, i) => LABELS.slice(i + 1).map(b => key(a, b)))));
    expect(HOSTILE_PAIRS).toHaveLength(6);
  });

  it("draws per match, seeded by its key: the same key always draws the same ordered pair, and every pair can be drawn", () => {
    const pairs = new Set<string>(), orders = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const [a, b] = drawColonyNames(id);
      expect(drawColonyNames(id)).toEqual([a, b]);
      expect(a).not.toBe(b);
      expect(LABELS).toContain(a);
      expect(LABELS).toContain(b);
      expect(isClassicColonyNames([a, b])).toBe(false);
      pairs.add(key(a, b)); orders.add(`${a} | ${b}`);
    }
    expect(pairs.size).toBe(6);
    // Both orders of every pair, except the rated names in the rated order.
    expect(orders.size).toBe(11);
    expect(orders.has(`${COLONY_NAMES[1]} | ${COLONY_NAMES[0]}`)).toBe(true);
  });

  it("keeps the rated names for a rated lobby and for anything carrying no names", () => {
    expect(lobbyColonyNames("any-lobby", true)).toBe(COLONY_NAMES);
    expect(isClassicColonyNames(lobbyColonyNames("any-lobby", true))).toBe(true);
    expect(lobbyColonyNames("any-lobby", false)).toEqual(drawColonyNames("any-lobby"));
    expect(colonyNamesOf(undefined)).toBe(COLONY_NAMES);
    expect(colonyNamesOf({})).toBe(COLONY_NAMES);
    expect(colonyNamesOf({ colonyNames: ["Sweetwater Colony", "Lake Skinner Colony"] })).toEqual(["Sweetwater Colony", "Lake Skinner Colony"]);
  });
});

describe("the colony colours", () => {
  it("keep the rated names' colours and agent shades exactly as they were", () => {
    expect(colonyColours(COLONY_NAMES)).toEqual([0xffb000, 0x00c2ff]);
    expect(colonyAgentShades(COLONY_NAMES)).toEqual([[0xf4af38, 0xed7668, 0xebd14d, 0xf38c48], [0x4bc6fa, 0x9f85e5, 0x47d6cf, 0x77a4f6]]);
  });

  it("follow the name wherever it stands, and a name outside the table keeps its colony's own colour", () => {
    expect(colonyColours(["Lake Hodges Colony", "Very Large Colony"])).toEqual([0x00c2ff, 0xffb000]);
    expect(colonyColours(["Sweetwater Colony", "Lake Skinner Colony"])).toEqual([SWEETWATER, LAKE_SKINNER]);
    expect(colonyAgentShades(["Lake Skinner Colony", "Very Large Colony"])).toEqual([[LAKE_SKINNER], [0xf4af38, 0xed7668, 0xebd14d, 0xf38c48]]);
    expect(colonyColours(["Some Colony", "Other Colony"])).toEqual([0xffb000, 0x00c2ff]);
  });

  it("are clearly apart from each other and readable on the page background", () => {
    const colours = SUPERCOLONY_NAMES.map(n => n.colour);
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        expect(distance(colours[i]!, colours[j]!), `${LABELS[i]} / ${LABELS[j]}`).toBeGreaterThanOrEqual(0.11);
      }
      // As text on the page's #121719.
      expect(contrast(colours[i]!, 0x121719)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keep the two new colours apart from the board's food, ant body, highlight and the rated colonies' agent shades", () => {
    // Food (web/src/food.ts FOOD, FOOD_LIGHT), the ants' chitin (web/src/ants.ts CHITIN), white highlights.
    const board = [0x9ccc4a, 0xc4e27c, 0xece4d4, 0xffffff];
    const shades = [...SUPERCOLONY_NAMES[0].agentShades, ...SUPERCOLONY_NAMES[1].agentShades];
    for (const added of [SWEETWATER, LAKE_SKINNER]) {
      for (const other of board) expect(distance(added, other)).toBeGreaterThanOrEqual(0.15);
      for (const other of shades) expect(distance(added, other)).toBeGreaterThanOrEqual(0.07);
    }
  });
});
