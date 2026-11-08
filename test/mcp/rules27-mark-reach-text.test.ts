import { afterEach, describe, expect, it } from "vitest";
import { briefing, markReachText } from "../../src/mcp/briefing.js";
import { ruleSections } from "../../web/rules.js";
import { COLONY_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

// Under rules 27, the rules reply, /rules and the out-of-reach refusal say mark reach is sight
// from the colony's living ants when the mark is placed; placement is unchanged.
const RULES_27: SimConfig = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
const REACH = "Mark reach is the same as sight, measured from your colony's living ants when the mark is placed, so a tile or queen seen earlier may no longer be in reach.";

const marksLine = (config: SimConfig) => ruleSections(config).flatMap(section => section.lines).find(line => line.startsWith("Use count_mark with verb"))!;

describe("rules-27 mark reach text", () => {
  it("states reach equals sight from living ants at placement in the rules reply's placement line and on /rules", () => {
    expect(markReachText(RULES_27)).toBe(REACH);
    const placement = briefing(RULES_27).split("\n").find(line => line.includes(`within ${RULES_27.sightTiles} tiles of any living ant of your colony`))!;
    expect(placement).toContain(REACH);
    expect(briefing(RULES_27).split(REACH)).toHaveLength(2);
    expect(marksLine(RULES_27)).toContain(`omitting coordinates still requires a squad ant. ${REACH}`);
  });

});

describe("rules-27 out-of-reach refusal", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  async function refuse(config: SimConfig) {
    const s = emptyMatch(0, config);
    for (let i = 0; i < 12; i++) addAnt(s, 0, 8, 24);
    h = await startHarness({ simConfig: config, state: s });
    const agent = await h.connect();
    expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
    const reply = await agent.call("count_mark", { verb: "ATTACK", count: 2, tileX: 8 + config.sightTiles + 5, tileY: 24 });
    expect(h.game.match!.state.marks).toHaveLength(0);
    return reply.data;
  }

  it("rules 27 states the rule, names no other cause, and still carries nearestTile", async () => {
    const data = await refuse(RULES_27);
    expect(data.error.code).toBe("count_mark_not_visible");
    expect(data.error.message).toBe("That count-mark tile is out of reach of your colony's living ants now.");
    expect(data.error.howToFix).toContain(`${REACH} Count marks may target any whole-number tile currently inside a circle of radius ${RULES_27.sightTiles} tiles`);
    expect(data.nearestTile).toEqual(expect.objectContaining({ tileX: expect.any(Number), tileY: expect.any(Number) }));
  });

});
