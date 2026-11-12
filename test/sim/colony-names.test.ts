// Unrated matches' colony names: only pairs measured hostile, drawn per match; rated matches keep the rated names.
import { describe, expect, it } from "vitest";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import {
  HOSTILE_PAIRS, SUPERCOLONY_NAMES, colonyNameNote, colonyNamesOf, drawColonyNames, isClassicColonyNames, lobbyColonyNames, measuredHostile,
} from "../../src/sim/colonyNames.ts";

const key = (a: string, b: string) => [a, b].sort().join(" | ");

/** Every measured-hostile pair, written out by hand from the published aggression tests. */
const EXPECTED = [
  // California: all five mutually antagonistic.
  ["Californian Large Colony", "Lake Hodges Colony"], ["Californian Large Colony", "Sweetwater Colony"],
  ["Californian Large Colony", "Lake Skinner Colony"], ["Californian Large Colony", "Cottonwood Colony"],
  ["Lake Hodges Colony", "Sweetwater Colony"], ["Lake Hodges Colony", "Lake Skinner Colony"], ["Lake Hodges Colony", "Cottonwood Colony"],
  ["Sweetwater Colony", "Lake Skinner Colony"], ["Sweetwater Colony", "Cottonwood Colony"], ["Lake Skinner Colony", "Cottonwood Colony"],
  // Japan: every pair of the four.
  ["Japanese Main Colony", "Kobe A Colony"], ["Japanese Main Colony", "Kobe B Colony"], ["Japanese Main Colony", "Kobe C Colony"],
  ["Kobe A Colony", "Kobe B Colony"], ["Kobe A Colony", "Kobe C Colony"], ["Kobe B Colony", "Kobe C Colony"],
  // Across continents.
  ["European Main Colony", "Kobe A Colony"], ["European Main Colony", "Kobe B Colony"], ["European Main Colony", "Kobe C Colony"],
  ["Californian Large Colony", "Kobe A Colony"], ["Californian Large Colony", "Kobe B Colony"], ["Californian Large Colony", "Kobe C Colony"],
  ["Catalonian Colony", "Japanese Main Colony"], ["Catalonian Colony", "Kobe A Colony"], ["Catalonian Colony", "Kobe B Colony"],
  ["Catalonian Colony", "Kobe C Colony"], ["European Main Colony", "Catalonian Colony"],
] as const;

/** Never opponents: the non-aggressive unit, and a pair no paper tested. */
const FORBIDDEN = [
  ["European Main Colony", "Californian Large Colony"], ["European Main Colony", "Japanese Main Colony"],
  ["Californian Large Colony", "Japanese Main Colony"], ["Californian Large Colony", "Catalonian Colony"],
] as const;

describe("supercolony names", () => {
  it("has the 11 sourced names, each with a one-line note giving where it is and its source", () => {
    expect(SUPERCOLONY_NAMES.map(n => n.label)).toEqual([
      "Californian Large Colony", "Lake Hodges Colony", "Sweetwater Colony", "Lake Skinner Colony", "Cottonwood Colony",
      "European Main Colony", "Catalonian Colony", "Japanese Main Colony", "Kobe A Colony", "Kobe B Colony", "Kobe C Colony",
    ]);
    for (const { label, note } of SUPERCOLONY_NAMES) {
      expect(colonyNameNote(label)).toBe(note);
      expect(note).not.toMatch(/\n/);
      expect(note).toMatch(/\(.+\d{4}.*\)$/);
    }
    expect(colonyNameNote("Very Large Colony")).toBeNull();
  });

  it("allows exactly the 27 measured-hostile pairs", () => {
    expect(new Set(HOSTILE_PAIRS.map(([a, b]) => key(a, b)))).toEqual(new Set(EXPECTED.map(([a, b]) => key(a, b))));
    expect(HOSTILE_PAIRS).toHaveLength(27);
    for (const [a, b] of EXPECTED) expect(measuredHostile(a, b) && measuredHostile(b, a)).toBe(true);
  });

  it("never allows a forbidden or untested pair", () => {
    for (const [a, b] of FORBIDDEN) expect(measuredHostile(a, b) || measuredHostile(b, a)).toBe(false);
    const allowed = new Set(EXPECTED.map(([a, b]) => key(a, b)));
    const labels = SUPERCOLONY_NAMES.map(n => n.label);
    for (const a of labels) for (const b of labels) {
      expect(measuredHostile(a, b)).toBe(a !== b && allowed.has(key(a, b)));
    }
  });

  it("draws per match, seeded by its key: the same key always draws the same ordered pair, and only allowed pairs", () => {
    const seen = new Set<string>(), orders = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const [a, b] = drawColonyNames(id);
      expect(drawColonyNames(id)).toEqual([a, b]);
      expect(measuredHostile(a, b)).toBe(true);
      seen.add(key(a, b)); orders.add(`${a} | ${b}`);
    }
    expect(seen.size).toBe(27);
    expect(orders.size).toBe(54);
  });

  it("keeps the rated names for a rated lobby and for anything carrying no names", () => {
    expect(lobbyColonyNames("any-lobby", true)).toBe(COLONY_NAMES);
    expect(isClassicColonyNames(lobbyColonyNames("any-lobby", true))).toBe(true);
    expect(lobbyColonyNames("any-lobby", false)).toEqual(drawColonyNames("any-lobby"));
    expect(isClassicColonyNames(drawColonyNames("any-lobby"))).toBe(false);
    expect(colonyNamesOf(undefined)).toBe(COLONY_NAMES);
    expect(colonyNamesOf({})).toBe(COLONY_NAMES);
    expect(colonyNamesOf({ colonyNames: ["Kobe A Colony", "Kobe B Colony"] })).toEqual(["Kobe A Colony", "Kobe B Colony"]);
  });
});
