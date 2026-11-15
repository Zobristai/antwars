import { afterEach, describe, expect, it } from "vitest";
import { briefing, flyerRulesLines, joinBriefing } from "../../src/mcp/briefing.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { createMatch } from "../../src/sim/map.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { ruleSections } from "../../web/rules.js";
import { SEAT_MODES, SERVED, seatFlyers, type FlyerSeat } from "./flyer-seat.js";

/** The flyer as the rules set it, in every text a rules-28 seat is served. */

/** Each decided fact, as the served text states it. */
const FACTS: readonly [string, RegExp][] = [
  ["2 HP", /A flyer has 2 HP/],
  ["5 HP per second, x1.25 on own ground", /deals 5 HP per second \(x1\.25 on your own territory\)/],
  ["12 food", /costs 12 food/],
  ["one every 6 s per queen, from match start", /Each queen on brood flyers hatches one every 6 s, from match start/],
  ["no lifetime and no cap of its own", /Flyers have no lifetime and no cap of their own/],
  ["ordered only by flyer marks", /Only flyer count marks \(caste flyer\) order flyers/],
  ["to land in current sight, never water or rock", /must be land, never water or rock, inside your colony's current sight when the mark is laid or moved/],
  ["movable to a new tile", /Move one of your flyer marks with count_mark \{markId, its own verb, count, the new tileX\/tileY/],
  ["8 tiles per second over water, rock and ants", /Flight is straight at 8 tiles per second over water, rock and ants/],
  ["ATTACK and DEFEND fly, land and fight on the ground", /ATTACK and DEFEND: fly there, land, then walk and fight on the ground/],
  ["GATHER hovers", /GATHER: hover over its tile/],
  ["PATROL flies the chain without landing or pausing", /PATROL: fly the chain without landing or pausing/],
  ["LINE hovers as a spread wall", /LINE: hover spread evenly end to end as a wall/],
  ["FORAGE refused", /FORAGE with caste flyer is refused/],
  ["no take-off for 3 s after landing", /A flyer cannot take off for 3 s after landing/],
  ["airborne flyers fight only airborne enemy flyers", /Airborne flyers, flying or hovering, bite only airborne enemy flyers in reach/],
  ["ground ants and queens cannot hit them", /ground ants and queens cannot hit them/],
  ["an order ending in the air finishes its flight, lands and stays put", /a flying flyer finishes its flight, lands and stays put/],
];

const PATROL_NOTE = /Flyer and ground PATROL marks never link with each other; flyer patrols do not pause\./;

/** What no served text may say of flyers. */
const RETIRED: readonly RegExp[] = [
  /knock/i, /single flight/i, /one flight/i, /flies once/i, /flown/i,
  /flyer switch/i, /per-colony/i, /flyers (?:are )?(?:on|off)\b/i, /colony'?s? flyers? (?:setting|switch)/i,
  /flyer lifetime/i, /flyer cap/i, /dies? of age/i, /age death/i, /lifetime of \d/i, /life ring/i,
  /flyers? (?:last|lives?|expires?)\b/i, /cap of \d+ flyers/i, /at most \d+ flyers/i,
];

function expectFlyerText(text: string): void {
  for (const [fact, pattern] of FACTS) expect(text, fact).toMatch(pattern);
  for (const pattern of RETIRED) expect(text, String(pattern)).not.toMatch(pattern);
  // The only lifetime or cap a flyer sentence names is the one it has not got.
  for (const sentence of text.split(/(?<=[.:;])\s+/).filter(s => /flyer/i.test(s) && /lifetime|\bcap\b/.test(s))) {
    expect(sentence).toMatch(/no lifetime and no cap of their own|keeps its id, members, lifetime and laid order|ant cap/);
  }
}

let seat: FlyerSeat | undefined;
afterEach(async () => { await seat?.h.close(); seat = undefined; });

describe.each(SEAT_MODES)("the flyer in the texts served to a $label rules-28 seat", ({ mode }) => {
  it("states every decided fact in the join briefing and the rules, and nothing retired anywhere", async () => {
    seat = await seatFlyers(mode);
    const joined = seat.joined;
    const rules = await seat.agent.call("rules");
    expect(rules.isError, rules.text).toBe(false);
    for (const text of [joined.data.briefing as string, rules.data.rules as string]) {
      expectFlyerText(text);
      expect(text).toMatch(PATROL_NOTE);
    }
    const tools = (await seat.agent.client.listTools()).tools;
    const served = JSON.stringify(tools);
    for (const pattern of RETIRED) expect(served, String(pattern)).not.toMatch(pattern);
    const countMark = tools.find(t => t.name === "count_mark")!;
    expect(countMark.description).toMatch(PATROL_NOTE);
    expect(countMark.description).toMatch(/To move one of your flyer marks, send its markId with its own verb, a count and the new tile/);
    expect(tools.find(t => t.name === "set_brood")!.description).toMatch(/workers, soldiers, flyers or mixed/);
    expect(tools.find(t => t.name === "observe")!.description).toMatch(/view\.flyers/);
  });
});

describe("the flyer in the rules texts before and after the map draw, and on the rules page", () => {
  const undrawn = newMatchConfig(SERVED), drawn = createMatch(6006, undrawn).config;
  for (const [name, config, context] of [["undrawn", undrawn, { undrawn: true }], ["drawn", drawn, { undrawn: false }]] as const) {
    it(`states the decided flyer in every briefing and on /rules (${name})`, () => {
      for (const house of [false, true]) {
        expectFlyerText(briefing(config, DEFAULT_MCP_CONFIG, { house, ...context }));
        expectFlyerText(joinBriefing(config, DEFAULT_MCP_CONFIG, false, { house, ...context }));
        expectFlyerText(joinBriefing(config, DEFAULT_MCP_CONFIG, true, { house, ...context }));
      }
      const page = ruleSections(config, context);
      expect(page.find(section => section.title === "Flyers")?.lines).toEqual(flyerRulesLines(config));
      const text = page.flatMap(section => section.lines).join(" ");
      expectFlyerText(text);
      expect(text).toMatch(PATROL_NOTE);
    });
  }
});
