import { afterEach, describe, expect, it } from "vitest";
import { applyInput, defaultAllocator, LINE_FROM_END_NOT_VISIBLE, LINE_TO_END_NOT_VISIBLE } from "../../src/sim/agents.js";
import { COLONY_NAMES, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import type { Agent, SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness, type Harness } from "./harness.js";
import { playable } from "../playable.ts";

// Under rules 27 a LINE count mark refused for reach names the end that is out of
// reach and offers a tile for it. Placement codes and order are unchanged.
const RULES_27: SimConfig = { ...playable(rulesConfig("redesign")), commandFloorTicks: 1, antSpeedTilesPerSecond: 0 };
const SEEN = { x: 8, y: 24 };
const far = (config: SimConfig) => ({ x: SEEN.x + config.sightTiles + 5, y: SEEN.y });

function scene(config: SimConfig): SimState {
  const s = emptyMatch(0, config);
  const agent: Agent = { id: "a", colony: 0, joinSeq: 0, modelLabel: null, parentAgentId: null, squad: [], order: { kind: "hold" }, lastCallTick: 0, lastCommandTick: null, idle: false, pendingEvents: [] };
  agent.squad.push(addAnt(s, 0, SEEN.x, SEEN.y, { squad: "a" }).id); s.agents.push(agent);
  return s;
}
function line(s: SimState, from: { x: number; y: number }, to: { x: number; y: number }) {
  return applyInput(s, { type: "count_mark", agentId: "a", verb: "LINE", count: 2, tileX: from.x, tileY: from.y, toTileX: to.x, toTileY: to.y }, s.tick++, defaultAllocator, []);
}

describe("rules-27 LINE reach refusals name the end", () => {
  it("a second end out of reach names toTileX/toTileY, carries nearestTile, and the same LINE is accepted there", () => {
    const s = scene(RULES_27);
    const refused = line(s, SEEN, far(RULES_27)).error;
    expect(refused).toMatchObject({ code: "count_mark_not_visible", message: LINE_TO_END_NOT_VISIBLE });
    expect(refused?.message).toContain("toTileX/toTileY");
    expect(refused?.nearestTile).not.toBeNull();
    expect(refused?.nearestTile).toBeDefined();
    expect(s.marks).toHaveLength(0);
    expect(s.agents[0]!.lastCommandTick).toBeNull();
    expect(line(s, SEEN, { x: refused!.nearestTile!.tileX, y: refused!.nearestTile!.tileY }).error).toBeNull();
  });

  it("a first end out of reach names tileX/tileY and carries nearestTile", () => {
    const s = scene(RULES_27);
    const refused = line(s, far(RULES_27), SEEN).error;
    expect(refused).toMatchObject({ code: "count_mark_not_visible", message: LINE_FROM_END_NOT_VISIBLE });
    expect(refused?.message).toContain("tileX/tileY");
    expect(refused?.nearestTile).not.toBeNull();
    expect(s.marks).toHaveLength(0);
    expect(s.agents[0]!.lastCommandTick).toBeNull();
  });

});

describe("rules-27 LINE reach in MCP replies and the count_mark description", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  async function seat(config: SimConfig) {
    const s = emptyMatch(0, config);
    for (let i = 0; i < 12; i++) addAnt(s, 0, SEEN.x, SEEN.y);
    h = await startHarness({ simConfig: config, state: s });
    const agent = await h.connect();
    expect((await agent.call("join", { colony: COLONY_NAMES[0] })).isError).toBe(false);
    return agent;
  }

  it("rules 27: the reply names the out-of-reach end and gives its nearestTile; the description says both ends must be in reach", async () => {
    const agent = await seat(RULES_27);
    const to = far(RULES_27);
    const second = await agent.call("count_mark", { verb: "LINE", count: 2, tileX: SEEN.x, tileY: SEEN.y, toTileX: to.x, toTileY: to.y });
    expect(second.data.error).toMatchObject({ code: "count_mark_not_visible", message: LINE_TO_END_NOT_VISIBLE });
    expect(second.data.nearestTile).toEqual(expect.objectContaining({ tileX: expect.any(Number), tileY: expect.any(Number) }));
    expect(second.data.error.howToFix).toContain("(nearestTile)");
    expect(second.data.error.howToFix).not.toContain("Omit both coordinates");
    const first = await agent.call("count_mark", { verb: "LINE", count: 2, tileX: to.x, tileY: to.y, toTileX: SEEN.x, toTileY: SEEN.y });
    expect(first.data.error).toMatchObject({ code: "count_mark_not_visible", message: LINE_FROM_END_NOT_VISIBLE });
    expect(first.data.nearestTile).toEqual(expect.objectContaining({ tileX: expect.any(Number), tileY: expect.any(Number) }));
    expect(h!.game.match!.state.marks).toHaveLength(0);
    const tool = (await agent.client.listTools()).tools.find(t => t.name === "count_mark")!;
    expect(tool.description).toContain(`currently within ${RULES_27.sightTiles} tiles of any living ant of your colony`);
    expect(tool.description).toContain(`currently within ${RULES_27.sightTiles} tiles of any living ant of your colony. LINE: both ends must be in reach under that same placement rule, each like a single tile.`);
  });

  it("rules 27: a second-end nearestTile equal to the first end is offered only as a candidate, and that retry is refused for identical ends", async () => {
    const agent = await seat(RULES_27);
    // The inner-margin tile nearest the far second end is the first end itself.
    const from = { x: SEEN.x + RULES_27.sightTiles - 2, y: SEEN.y };
    const to = far(RULES_27);
    const refused = await agent.call("count_mark", { verb: "LINE", count: 2, tileX: from.x, tileY: from.y, toTileX: to.x, toTileY: to.y });
    expect(refused.data.error).toMatchObject({ code: "count_mark_not_visible", message: LINE_TO_END_NOT_VISIBLE });
    expect(refused.data.nearestTile).toEqual({ tileX: from.x, tileY: from.y });
    expect(refused.data.error.howToFix).toContain(`Nearest in-reach tile for that end now: (${from.x},${from.y}) (nearestTile), a candidate only: the two LINE ends must still be different tiles and the other checks still apply.`);
    expect(refused.data.error.howToFix).not.toContain("would be accepted");
    const retry = await agent.call("count_mark", { verb: "LINE", count: 2, tileX: from.x, tileY: from.y, toTileX: from.x, toTileY: from.y });
    expect(retry.data.error.code).toBe("bad_count_mark");
  });

  it("squad-ant placement (count-marks rules) states the both-ends rule", async () => {
    const countMarks = rulesConfig("count-marks");
    expect(countMarks.rules27).toBe(true);
    expect(countMarks.countMarks?.placement).not.toBe("colony_sight");
    const describe = async (config: SimConfig) => {
      h = await startHarness({ simConfig: config });
      const tool = (await (await h.connect()).client.listTools()).tools.find(t => t.name === "count_mark")!;
      await h.close(); h = undefined;
      return tool.description!;
    };
    expect(await describe(countMarks)).toContain("Place it on a tile where one of your squad ants stands. LINE: both ends must be in reach under that same placement rule, each like a single tile.");
  });

});
