import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MapDefinition, type SimConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { createMatch, matchConfigForMap } from "../../src/sim/map.ts";
import { colonyCountOf } from "../../src/sim/mapBoard.ts";
import { quadrantMatchMaps } from "../../src/sim/mapShapes.ts";
import { selectMap } from "../../src/sim/terrain.ts";
import { readRulesAssets, startSpectatedServer, type SpectatedServer } from "../../src/spectator.ts";
import { comparison, startComparisonMatch } from "../server/helpers.ts";
import { renderRules, ruleSections } from "../../web/rules.ts";
import { rules27Redesign } from "../rules27.ts";

/** Test-only quadrant geometry (as in test/sim/four-colony.test.ts): nest, water, start area and food off both mirror axes. */
const QUADRANTS: MapDefinition = {
  id: "fixture-quadrants", name: "Fixture Quadrants",
  water: [{ x: 16, y: 2, width: 3, height: 9 }, { x: 4, y: 24, width: 10, height: 2 }],
  quadrant: {
    referenceWidth: 64, referenceHeight: 64, centreHalfWidth: 8, centreHalfHeight: 6, nestTileX: 7, nestTileY: 11,
    startArea: { x: 2, y: 4, width: 12, height: 15 },
    foodPatches: [{ tileX: 10, tileY: 20, radius: 2, perTile: 3 }, { tileX: 20, tileY: 14, radius: 1, perTile: 5 }],
    centreFood: [{ radius: 2, perTile: 4 }, { radius: 1, perTile: 2 }],
  },
};

/** A second, wider test-only quadrant map with no water, so an undrawn rotation has two board sizes. */
const WIDE_QUADRANTS: MapDefinition = {
  id: "fixture-wide-quadrants", name: "Fixture Wide Quadrants", water: [],
  quadrant: {
    referenceWidth: 80, referenceHeight: 48, centreHalfWidth: 6, centreHalfHeight: 4, nestTileX: 8, nestTileY: 8,
    startArea: { x: 2, y: 2, width: 12, height: 12 },
    foodPatches: [{ tileX: 16, tileY: 10, radius: 2, perTile: 3 }],
    centreFood: [{ radius: 1, perTile: 2 }],
  },
};

// The rules-27 redesign (test/rules27.ts), whose four-colony text these tests state; rules 28 is test/sim/four-colony-rules28.test.ts.
const LIVE = newMatchConfig(rules27Redesign());
const quadrantRotation = (maps: readonly MapDefinition[], change: Partial<SimConfig> = {}): SimConfig =>
  ({ ...LIVE, ...change, terrain: { ...LIVE.terrain!, maps } });
const ROTATION = quadrantRotation([QUADRANTS]);
const SEED = 404;
const DRAWN = matchConfigForMap(SEED, ROTATION);

/** The two-colony phrasing the four-colony page must not carry, anywhere outside Battle balance. */
const TWO_COLONY_PHRASES = ["opponent", "times the opponent's territory", "the two colonies add to 100%", "two ant colonies",
  "both colonies", "either colony", "Warm or cool = colony", "mirrored left to right.", "mirrored rock pair", "Frontline food"];

/** The page's own sections: everything but Battle balance, whose lines come from the agent briefing. */
function ownText(config: SimConfig, context: { readonly undrawn?: boolean } = {}): string {
  return ruleSections(config, context).filter(section => section.title !== "Battle balance").flatMap(section => section.lines).join("\n");
}

function sectionText(config: SimConfig, title: string, context: { readonly undrawn?: boolean } = {}): string {
  const section = ruleSections(config, context).find(s => s.title === title);
  if (section === undefined) throw new Error(`no ${title} section`);
  return section.lines.join("\n");
}

/** The HTML outside the Battle balance section. A built page also carries every section as JSON for its browser
 * enhancement; that copy is the same ruleSections output the page renders, so it is left out here too. */
const outsideBalance = (html: string): string => html.replace(/<section id="battle-balance">.*?<\/section>/s, "")
  .replace(/<script id="aw-rules-data" type="application\/json">.*?<\/script>/s, "");

describe("the public rules page in a four-colony match", () => {
  it("plays four colonies on these configs", () => {
    expect(colonyCountOf(ROTATION)).toBe(4);
    expect(colonyCountOf(DRAWN)).toBe(4);
    expect(createMatch(SEED, ROTATION).colonies).toHaveLength(4);
  });

  it.each([["before the draw", ROTATION, { undrawn: true }], ["after the draw", DRAWN, {}]] as const)(
    "states the four-colony rules %s", (_when, config, context) => {
      const text = ownText(config, context);
      // Four colonies, each against the other three.
      expect(text).toContain("AI agents command four ant colonies, each against the other three.");
      // Elimination for either cause, its ants removed and its territory neutral; the match goes on.
      expect(text).toContain("A colony is eliminated when it loses its last queen or its seat goes idle: its ants are removed, its territory turns neutral, and the match continues for the other colonies.");
      expect(text).toContain("A joined seat that goes idle has its colony eliminated: its ants are removed, its territory turns neutral, and the match continues for the other colonies.");
      expect(text).toContain("No colony is credited with kills for the removed ants.");
      // The last-queen win.
      expect(text).toContain("the last colony with a living queen wins");
      expect(text).toContain("The last colony with a living queen wins before time-up");
      // The territory win: more than half of all owned territory, from minute 10, at least 100 tile areas, for 5 minutes.
      expect(text).toContain("From 10 minutes, hold more than half of all owned territory, and at least 100 original-size tile areas, for 5 minutes without a break.");
      expect(text).toContain("An eliminated colony's territory no longer counts toward all owned territory.");
      // Time-up ranking, eliminated colonies below every survivor.
      expect(text).toContain("At time-up the surviving colonies rank by kills; ties go to more territory, then more living ants, then more food delivered. The top colony wins; if the top two are still equal, the match is a draw. Eliminated colonies rank below every survivor, the latest eliminated highest.");
      // Kill credit (src/sim/combat.ts): queens count, the finishing hit's colony scores, and it is not the count-mark telemetry.
      expect(text).toContain("Killing an enemy ant or an enemy queen scores one kill, for the colony whose hit finishes it off. This score is separate from the kills shown on count marks, which go to the biggest hit.");
      // Same-tick cases, on scores just before that tick's removal.
      expect(text).toContain("When every remaining colony is eliminated on the same tick, by losing its last queen or going idle, the time-up order decides among them. Colonies eliminated on the same tick rank among themselves by the same order. Both read each colony's scores as they stood just before that tick's removal of ants and territory.");
      expect(text).toContain("If every remaining colony goes idle on the same tick, the time-up order decides among them.");
      expect(text).toContain("idleSecondsLeft: seconds left before the seat goes idle and its colony is eliminated");
      // Founding spacing counts every colony's nests (src/sim/agents.ts tooCloseToNest).
      expect(text).toContain("from every standing nest of any colony;");
      for (const phrase of TWO_COLONY_PHRASES) expect(text).not.toContain(phrase);
      expect(text).not.toMatch(/flyer/i);
    });

  it("takes every territory-win and match figure from the config", () => {
    const changed = quadrantRotation([QUADRANTS], { matchTicks: 45 * 60 * LIVE.ticksPerSecond,
      earlyWin: { ...LIVE.earlyWin!, minTick: 12 * 60 * LIVE.ticksPerSecond, holdTicks: 3 * 60 * LIVE.ticksPerSecond, minHeldTiles: 140 } });
    const text = ownText(changed, { undrawn: true });
    expect(text).toContain("From 12 minutes, hold more than half of all owned territory, and at least 140 original-size tile areas, for 3 minutes without a break.");
    expect(text).toContain("At 45 minutes, the surviving colony with the most kills wins.");
    expect(text).not.toContain("10 minutes");
    expect(text).not.toContain("100 original-size tile areas");
  });

  it("describes the quadrant board as the match lays it out", () => {
    const maps = sectionText(DRAWN, "Maps");
    expect(maps).toContain("The playable board is 128 tiles wide and 128 tiles high.");
    expect(maps).toContain("1 map mirrored left to right and top to bottom into four quadrants, one colony starting in each, around a contested centre.");
    expect(maps).toContain("each with a mirror image in every quadrant");
    // Every water rectangle the match's terrain holds, in its fine tiles.
    const water = createMatch(SEED, ROTATION).terrain!.water;
    expect(water).toHaveLength(8);
    expect(maps).toContain(`Fixture Quadrants: water obstacles; use the water rectangles to find land routes. Its board is 128 tiles wide and 128 tiles high. Water rectangles (top-left tile, width and height): ${water.map(r => `(${r.x}, ${r.y}), ${r.width} tiles wide and ${r.height} tiles high`).join("; ")}.`);
    // Before the draw, a rotation of two board sizes states both, and each map's own size.
    const undrawn = sectionText(quadrantRotation([QUADRANTS, WIDE_QUADRANTS]), "Maps", { undrawn: true });
    expect(undrawn).toContain("The map the seed selects sets the playable board: 128x128 or 160x96 tiles, width by height.");
    expect(undrawn).toContain("2 maps mirrored left to right and top to bottom into four quadrants");
    expect(undrawn).toContain("Fixture Wide Quadrants: open ground with no water. Its board is 160 tiles wide and 96 tiles high. Open land, with no water.");
  });

  it("leaves out the two-colony display sentences and the seeded two-colony food layout", () => {
    expect(ROTATION.foodLayout).toBeDefined();
    for (const [config, context] of [[ROTATION, { undrawn: true }], [DRAWN, {}]] as const) {
      expect(sectionText(config, "Food and hatching", context)).toContain("A colony's ants alive are the ants it started with, plus those it hatched, less those it lost.");
      const text = ownText(config, context);
      expect(text).not.toContain("Territory held:");
      expect(text).not.toContain("Key:");
      expect(text).not.toContain("The score panel");
      expect(text).not.toContain("Frontline food");
    }
  });

  it("renders the page with the four-colony sections and no two-colony phrasing outside Battle balance", () => {
    for (const [config, context] of [[ROTATION, { undrawn: true }], [DRAWN, {}]] as const) {
      const html = renderRules(config, context);
      expect(html).toContain("<section id=\"how-to-win\" class=\"aw-summary\"><h2>How to win</h2><ul><li>Be the last colony left: kill every enemy queen.");
      expect(html).toContain("<p>AI agents command four ant colonies, each against the other three.");
      const own = outsideBalance(html);
      expect(own).toContain("<h2>Winning</h2>");
      for (const phrase of TWO_COLONY_PHRASES) expect(own).not.toContain(phrase.replace(/'/g, "&#39;"));
    }
  });
});

let server: SpectatedServer | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("the public rules page on the shipped Quadrants pool", () => {
  const POOL = quadrantMatchMaps();
  const SHIPPED = quadrantRotation(POOL);
  const LINES: Readonly<Record<string, string>> = {
    "four-coves": "Four Coves: each start area sits in a corner cove behind a curved lake, with exits toward both neighbouring quadrants; open centre.",
    "crossroads": "Crossroads: a plus-shaped river along the centre lines splits four islands, with one ford on each arm; the arms meet an open central plaza.",
    "strait": "Strait: a winding east-west strait runs from each side edge to the open central plaza, the only crossing between north and south; an oval pond on the border between each pair of side-by-side quadrants leaves two routes past it.",
  };
  const seedFor = (id: string) => {
    for (let seed = 1; ; seed++) if (selectMap(seed, SHIPPED.terrain!).id === id) return seed;
  };

  it("does not call the mode by its retired name on any shipped map's public rules page", () => {
    // Lowercase quadrants describes the map's geometry, not the mode's name.
    for (const config of [SHIPPED, ...POOL.map(map => matchConfigForMap(seedFor(map.id), SHIPPED))]) {
      expect(renderRules(config, { undrawn: config === SHIPPED })).not.toMatch(/\bQuadrants\b/);
    }
  });

  it("before the draw, describes each pool map in its one layout line, in pool order", () => {
    expect(POOL.map(map => map.id)).toEqual(["four-coves", "crossroads", "strait"]);
    const maps = sectionText(SHIPPED, "Maps", { undrawn: true });
    expect(maps).toContain("3 maps mirrored left to right and top to bottom into four quadrants");
    const at = POOL.map(map => maps.indexOf(LINES[map.id]!));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const line of Object.values(LINES)) expect(maps.split(line).length - 1, line).toBe(1);
  });

  it.each([["Four Coves", "four-coves", 128, 96], ["Crossroads", "crossroads", 192, 128], ["Strait", "strait", 224, 128]] as const)(
    "after %s (%s) is drawn, states its %ix%i board and still gives each pool map's layout line once", (_name, id, width, height) => {
    const seed = seedFor(id);
    const drawn = matchConfigForMap(seed, SHIPPED);
    expect(createMatch(seed, SHIPPED).terrain!.mapId).toBe(id);
    const maps = sectionText(drawn, "Maps");
    expect(maps).toContain(`The playable board is ${width} tiles wide and ${height} tiles high.`);
    for (const line of Object.values(LINES)) expect(maps.split(line).length - 1, line).toBe(1);
  });

  it.each(POOL.map(map => [map.name, map] as const))("%s with changed geometry falls back to the generic water line", (name, map) => {
    const changed: MapDefinition[] = [
      { ...map, water: map.water.slice(1) },
      { ...map, quadrant: { ...map.quadrant!, nestTileX: map.quadrant!.nestTileX + 1 } },
    ];
    for (const variant of changed) {
      const maps = sectionText(quadrantRotation([variant]), "Maps", { undrawn: true });
      expect(maps).toContain(`${name}: water obstacles; use the water rectangles to find land routes.`);
      for (const line of Object.values(LINES)) expect(maps).not.toContain(line);
    }
  });
});

describe("GET /rules on a server playing four colonies", () => {
  it("serves the undrawn four-colony page, then the running match's", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "antwar-quadrant-rules-"));
    server = await startSpectatedServer({ port: 0, host: "127.0.0.1", ...comparison(0), dataDir, simConfig: ROTATION });
    const url = `http://127.0.0.1:${server.port}/rules`;
    const assets = readRulesAssets();
    const before = await (await fetch(url)).text();
    expect(before).toBe(renderRules(ROTATION, { undrawn: true, assets }));
    expect(before).toContain("AI agents command four ant colonies, each against the other three.");
    for (const phrase of TWO_COLONY_PHRASES) expect(outsideBalance(before)).not.toContain(phrase.replace(/'/g, "&#39;"));
    await startComparisonMatch(server, 0);
    const running = server.game.match!.state;
    expect(running.colonies).toHaveLength(4);
    const during = await (await fetch(url)).text();
    expect(during).toBe(renderRules(running.config, { assets }));
    expect(during).toContain("At time-up the surviving colonies rank by kills;");
    for (const phrase of TWO_COLONY_PHRASES) expect(outsideBalance(during)).not.toContain(phrase.replace(/'/g, "&#39;"));
  });
});
