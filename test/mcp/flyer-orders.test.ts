import { afterEach, describe, expect, it } from "vitest";
import { startHarness, type CallResult } from "./harness.js";
import { SEAT_MODES, SERVED, nextCommand, obstacleBeside, scoutAt, seatFlyers, seenLand, sightEdge, type FlyerSeat, type Tile } from "./flyer-seat.js";
import type { SimConfig } from "../../src/sim/config.js";

/** Breeding and ordering flyers through the MCP tools, in rated and unrated matches alike. */

let seat: FlyerSeat | undefined;
afterEach(async () => { await seat?.h.close(); seat = undefined; });

const at = (tile: Tile) => ({ tileX: tile.tileX, tileY: tile.tileY });
const ends = (from: Tile, to: Tile) => ({ ...at(from), toTileX: to.tileX, toTileY: to.tileY });

/** A refused count_mark: the reply says why, and the marks and the command allowance are unchanged. */
async function refused(s: FlyerSeat, args: Record<string, unknown>, code: string, why: RegExp): Promise<CallResult> {
  const marks = structuredClone(s.state().marks);
  const agent = s.state().agents.find(a => a.id === s.agentId)!, lastCommandTick = agent.lastCommandTick;
  const reply = await s.agent.call("count_mark", args);
  expect(reply.isError, reply.text).toBe(true);
  expect(reply.data.error.code, reply.text).toBe(code);
  expect(reply.data.error.message, reply.text).toMatch(why);
  expect(reply.data.error.howToFix.length).toBeGreaterThan(0);
  expect(s.state().marks).toEqual(marks);
  expect(agent.lastCommandTick).toBe(lastCommandTick);
  return reply;
}

/** An accepted flyer count mark, named in the reply and in myMarks with caste flyer. */
async function accepted(s: FlyerSeat, args: Record<string, unknown>): Promise<number> {
  const reply = await s.agent.call("count_mark", { caste: "flyer", ...args });
  expect(reply.isError, reply.text).toBe(false);
  expect(reply.data.mark, reply.text).toMatchObject({ verb: args.verb, count: args.count, caste: "flyer", tileX: args.tileX, tileY: args.tileY });
  const markId = reply.data.mark.markId as number;
  expect(s.state().marks.find(m => m.id === markId)).toMatchObject({ verb: args.verb, count: args.count, caste: "flyer" });
  nextCommand(s);
  return markId;
}

describe.each(SEAT_MODES)("flyer orders through MCP, $label seat, rules 28", ({ mode }) => {
  it("accepts set_brood flyers from match start", async () => {
    seat = await seatFlyers(mode);
    const set = await seat.agent.call("set_brood", { brood: "flyers" });
    expect(set.isError, set.text).toBe(false);
    expect(set.data).toMatchObject({ accepted: true, brood: "flyers" });
    // The seat's first command after joining: the third tick of the match.
    expect(set.data.tick).toBeLessThanOrEqual(3);
    const queen = seat.state().colonies[0].queens!.find(q => q.id === set.data.queenId)!;
    expect(queen.owner).toBe(seat.agentId);
    expect(queen.brood).toBe("flyers");
    const observed = await seat.agent.call("observe");
    expect(observed.data.view.queens.find((q: { queenId: number }) => q.queenId === queen.id)).toMatchObject({ brood: "flyers" });
  });

  it("accepts caste flyer with DEFEND, ATTACK, GATHER, PATROL and LINE, and refuses FORAGE changing nothing", async () => {
    seat = await seatFlyers(mode);
    const tiles = seenLand(seat.state(), 0, 7);
    const ids = [];
    for (const [i, verb] of (["DEFEND", "ATTACK", "GATHER", "PATROL"] as const).entries()) ids.push(await accepted(seat, { verb, count: 3, ...at(tiles[i]!) }));
    const line = await seat.agent.call("count_mark", { verb: "LINE", count: 3, caste: "flyer", ...ends(tiles[4]!, tiles[5]!) });
    expect(line.isError, line.text).toBe(false);
    expect(line.data.mark).toMatchObject({ verb: "LINE", count: 3, caste: "flyer", ...ends(tiles[4]!, tiles[5]!) });
    ids.push(line.data.mark.markId as number);
    nextCommand(seat);
    await refused(seat, { verb: "FORAGE", count: 3, caste: "flyer", ...at(tiles[6]!) }, "bad_count_mark", /FORAGE/);
    const observed = await seat.agent.call("observe");
    const mine = observed.data.view.myMarks as { markId: number; verb: string; caste?: string }[];
    expect(mine.map(m => [m.markId, m.verb, m.caste])).toEqual(ids.map((id, i) => [id, ["DEFEND", "ATTACK", "GATHER", "PATROL", "LINE"][i], "flyer"]));
  });

  for (const kind of ["water", "rock"] as const) it(`refuses a flyer mark on ${kind} (LINE: either end) and accepts the land tile beside it`, async () => {
    seat = await seatFlyers(mode);
    const { obstacle, land } = obstacleBeside(seat.state(), kind);
    const code = `${kind}_tile`, why = kind === "water" ? /water/i : /rock/i;
    scoutAt(seat.state(), 0, land);
    for (const verb of ["DEFEND", "ATTACK", "GATHER", "PATROL"]) await refused(seat, { verb, count: 1, caste: "flyer", ...at(obstacle) }, code, why);
    await refused(seat, { verb: "LINE", count: 2, caste: "flyer", ...ends(obstacle, land) }, code, why);
    await refused(seat, { verb: "LINE", count: 2, caste: "flyer", ...ends(land, obstacle) }, code, why);
    await accepted(seat, { verb: "GATHER", count: 1, ...at(land) });
  });

  it("refuses a flyer mark outside current colony sight (LINE: either end) and accepts the last seen tile", async () => {
    seat = await seatFlyers(mode);
    const { scout, lastSeen, firstUnseen } = sightEdge(seat.state(), 0);
    scoutAt(seat.state(), 0, scout);
    for (const verb of ["DEFEND", "ATTACK", "GATHER", "PATROL"]) await refused(seat, { verb, count: 1, caste: "flyer", ...at(firstUnseen) }, "count_mark_not_visible", /out of reach/);
    await refused(seat, { verb: "LINE", count: 2, caste: "flyer", ...ends(firstUnseen, scout) }, "count_mark_not_visible", /first end .*out of reach/);
    await refused(seat, { verb: "LINE", count: 2, caste: "flyer", ...ends(scout, firstUnseen) }, "count_mark_not_visible", /second end .*out of reach/);
    await accepted(seat, { verb: "GATHER", count: 1, ...at(lastSeen) });
  });

  it("accepts counts 1 and 10,000 and refuses 0 and 10,001", async () => {
    seat = await seatFlyers(mode);
    const tiles = seenLand(seat.state(), 0, 4);
    await accepted(seat, { verb: "GATHER", count: 1, ...at(tiles[0]!) });
    await accepted(seat, { verb: "GATHER", count: 10_000, ...at(tiles[1]!) });
    await refused(seat, { verb: "GATHER", count: 0, caste: "flyer", ...at(tiles[2]!) }, "bad_count_mark", /count/);
    await refused(seat, { verb: "GATHER", count: 10_001, caste: "flyer", ...at(tiles[3]!) }, "bad_count_mark", /count/);
  });
});

/** Every tool's argument schema without its descriptions, as a lobby slot server lists it. */
async function schemasOf(config: SimConfig): Promise<Record<string, unknown>> {
  const h = await startHarness({ start: false, simConfig: config, slot: { identityOf: async () => undefined, locate: async () => undefined } });
  try {
    const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, v]) => [key, strip(v)])) : value;
    return Object.fromEntries((await (await h.connect()).client.listTools()).tools.map(tool => [tool.name, strip(tool.inputSchema)]));
  } finally {
    await h.close();
  }
}

describe("flyer argument schemas", () => {
  it("add only the flyer caste for brood and marks; verbs and fields are otherwise unchanged", async () => {
    const withFlyers = await schemasOf(SERVED);
    const without = await schemasOf({ ...SERVED, flyers: undefined });
    const prop = (schemas: Record<string, unknown>, tool: string, field: string) =>
      (schemas[tool] as { properties: Record<string, { enum?: string[]; anyOf?: { enum?: string[] }[] }> }).properties[field]!;
    const enumOf = (p: { enum?: string[]; anyOf?: { enum?: string[] }[] }) => p.enum ?? p.anyOf?.find(o => o.enum !== undefined)?.enum;
    expect(enumOf(prop(withFlyers, "set_brood", "brood"))).toEqual([...enumOf(prop(without, "set_brood", "brood"))!, "flyers"]);
    expect(enumOf(prop(withFlyers, "count_mark", "caste"))).toEqual([...enumOf(prop(without, "count_mark", "caste"))!, "flyer"]);
    // With those two enums put back, every tool's schema is the one served without flyers.
    const restored = structuredClone(withFlyers);
    for (const [tool, field, extra] of [["set_brood", "brood", "flyers"], ["count_mark", "caste", "flyer"]] as const) {
      const p = prop(restored, tool, field), list = enumOf(p)!;
      list.splice(list.indexOf(extra), 1);
    }
    expect(restored).toEqual(without);
  });
});
