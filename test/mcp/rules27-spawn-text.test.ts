import { afterEach, describe, expect, it } from "vitest";
import { rulesConfig, type SimConfig } from "../../src/sim/config.js";
import type { SimInput } from "../../src/sim/types.js";
import { briefing, joinBriefing, queenSpawnOwnerText, spawnRemoveText } from "../../src/mcp/briefing.js";
import { renderRules, ruleSections } from "../../web/rules.js";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS, MAX_REPLY_BYTES, MAX_RULES_REPLY_BYTES, MAX_RULES_TEXT_CHARS, MAX_TEXT_CHARS } from "../../src/mcp/replies.js";
import { spawnRemoveReply } from "../../src/mcp/tools.js";
import { startHarness, type Harness, type TestAgent } from "./harness.js";
import { NEW_MATCH_REPLY_MAP_IDS, measureReplies, replyFixtureConfig } from "./response-size-fixture.js";
import { playable } from "../playable.ts";

// Agent text for spawn points and count-mark removal.
const RULES_27: SimConfig = playable(rulesConfig("redesign"));

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function seat(config: SimConfig): Promise<{ agent: TestAgent; agentId: string }> {
  h = await startHarness({ simConfig: config });
  const agent = await h.connect();
  const joined = await agent.call("join", { colony: "Very Large Colony" });
  expect(joined.isError, joined.text).toBe(false);
  return { agent, agentId: joined.data.agentId as string };
}

async function countMarkTool(agent: TestAgent) {
  return (await agent.client.listTools()).tools.find(tool => tool.name === "count_mark")!;
}

function countMarkInputs(agentId: string): SimInput[] {
  return h!.inputsOf(agentId).filter(input => input.type === "count_mark");
}

describe("rules-27 agent text for spawn points and count-mark removal", () => {
  it("describes setting, moving and clearing a spawn point, the walk of both castes, queen death and mark removal", () => {
    const text = spawnRemoveText(RULES_27);
    // Set and move, on any passable tile with no sight requirement; clear by omitting the tile.
    // Re-pinned for a queen the caller owns, followed by the owner-only statement.
    expect(text).toContain(`SPAWN {queenId,tileX,tileY}: set/move the spawn point of a live queen you own (observe queens) on any passable tile, sight not needed; omit both coordinates to clear. ${queenSpawnOwnerText(RULES_27)}`);
    expect(text).toContain("One per queen, no expiry; clears when she dies.");
    // Her later hatchlings of both castes walk there, then follow the free-ant defaults the briefing states.
    expect(text).toContain("her later hatchlings, workers and soldiers, walk there, then follow the free-ant defaults from there");
    expect(text).toContain(`(a soldier holds within ${RULES_27.localAnts!.defendTiles} tiles of it)`);
    expect(text).toContain("a move/clear changes only later hatchlings");
    expect(text).toContain("If she dies, her walkers take the defaults where they stand.");
    // Removal of the agent's own count mark.
    expect(text).toContain("REMOVE {markId}: remove your own count mark (myMarks); its ants take the defaults at once where they stand.");
    expect(text).toContain("uses the command allowance");
    expect(briefing(RULES_27)).toContain("Free ants follow these defaults until a count mark claims them.");
  });

  it("puts that text in the rules briefing, the join briefing and the count_mark tool", async () => {
    const text = spawnRemoveText(RULES_27);
    expect(briefing(RULES_27).split("\n")).toContain(`  ${text}`);
    expect(joinBriefing(RULES_27)).toContain(text);
    const { agent } = await seat(RULES_27);
    const tool = await countMarkTool(agent);
    expect(tool.description).toContain(text);
    expect(tool.description).toContain("Accepted SPAWN replies give spawnPoint {queenId,tileX,tileY} or {queenId,cleared:true}; REMOVE gives removedMark {markId}.");
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }>; required?: string[] };
    expect(schema.properties.queenId?.description).toContain("SPAWN only");
    expect(schema.properties.markId?.description).toContain("REMOVE only");
    expect(schema.properties.verb?.description).toContain("Or SPAWN (set, move or clear a queen's spawn point) or REMOVE (remove your own count mark).");
    expect(schema.required ?? []).not.toContain("count");
    expect((await agent.call("rules")).data.rules).toContain(text);
  });

  it("sends SPAWN and REMOVE as count_mark inputs with count 0 and still requires a count for mark verbs", async () => {
    const { agent, agentId } = await seat(RULES_27);
    const queenId = h!.game.match!.state.colonies[0]!.queens![0]!.id;
    await agent.call("count_mark", { verb: "SPAWN", queenId, tileX: 20, tileY: 30 });
    h!.advance(RULES_27.commandFloorTicks);
    await agent.call("count_mark", { verb: "SPAWN", queenId, count: 5 });
    h!.advance(RULES_27.commandFloorTicks);
    await agent.call("count_mark", { verb: "REMOVE", markId: 7 });
    expect(countMarkInputs(agentId)).toEqual([
      { type: "count_mark", agentId, verb: "SPAWN", count: 0, tileX: 20, tileY: 30, queenId },
      { type: "count_mark", agentId, verb: "SPAWN", count: 0, queenId },
      { type: "count_mark", agentId, verb: "REMOVE", count: 0, markId: 7 },
    ]);
    h!.advance(RULES_27.commandFloorTicks);
    const missing = await agent.call("count_mark", { verb: "GATHER" });
    expect(missing.data.error).toMatchObject({ code: "bad_arguments", message: "count must be a number: a whole count of ants." });
    const badQueen = await agent.call("count_mark", { verb: "SPAWN", queenId: "first" });
    expect(badQueen.data.error).toMatchObject({ code: "bad_arguments", message: "queenId must be a number: the queenId of a live queen you own." });
    expect(countMarkInputs(agentId)).toHaveLength(3);
  });

  it("names the changed spawn point or removed mark in an accepted reply", async () => {
    expect(spawnRemoveReply(RULES_27, { type: "count_mark", agentId: "a", verb: "SPAWN", count: 0, queenId: 2, tileX: 5, tileY: 6 }))
      .toEqual({ spawnPoint: { queenId: 2, tileX: 5, tileY: 6 } });
    expect(spawnRemoveReply(RULES_27, { type: "count_mark", agentId: "a", verb: "SPAWN", count: 0, queenId: 2 }))
      .toEqual({ spawnPoint: { queenId: 2, cleared: true } });
    expect(spawnRemoveReply(RULES_27, { type: "count_mark", agentId: "a", verb: "REMOVE", count: 0, markId: 9 }))
      .toEqual({ removedMark: { markId: 9 } });
    expect(spawnRemoveReply(RULES_27, { type: "count_mark", agentId: "a", verb: "GATHER", count: 3 })).toEqual({});
    // The SPAWN and REMOVE branches of the simulation are tested elsewhere:
    // here the simulation's acceptance is stood in by an admitted observe, so only the reply path is under test.
    const { agent } = await seat(RULES_27);
    const call = h!.game.call.bind(h!.game);
    h!.game.call = ((agentId, input, ...rest) => call(agentId, input.type === "count_mark" ? { type: "observe", agentId } : input, ...rest)) as Harness["game"]["call"];
    const set = await agent.call("count_mark", { verb: "SPAWN", queenId: 0, tileX: 20, tileY: 30 });
    expect(set.isError, set.text).toBe(false);
    expect(set.data).toMatchObject({ accepted: true, spawnPoint: { queenId: 0, tileX: 20, tileY: 30 } });
    const removed = await agent.call("count_mark", { verb: "REMOVE", markId: 4 });
    expect(removed.data).toMatchObject({ accepted: true, removedMark: { markId: 4 } });
    expect(removed.data).not.toHaveProperty("spawnPoint");
  });
});

// Only a queen's owner sets, moves or clears her spawn point, on the surfaces this statement
// covers (join and rules briefings, count_mark description, /rules page), replacing the earlier any-colony-agent
// wording.
describe("rules-27 owner-only spawn-point statement", () => {
  const statement = "Only a queen's owner sets, moves or clears her spawn point.";

  it("states it in the join and rules briefings, the count_mark description and the /rules page", async () => {
    expect(queenSpawnOwnerText(RULES_27)).toBe(statement);
    for (const undrawn of [false, true]) {
      expect(briefing(RULES_27, undefined, { house: false, undrawn })).toContain(statement);
      expect(joinBriefing(RULES_27, undefined, false, { house: false, undrawn })).toContain(statement);
      // The served page escapes the apostrophe.
      expect(renderRules(RULES_27, { undrawn })).toContain(statement.replace("'", "&#39;"));
    }
    expect(ruleSections(RULES_27).find(section => section.title === "Queens")!.lines).toContain(statement);
    h = await startHarness({ simConfig: RULES_27 });
    const agent = await h.connect();
    const joined = await agent.call("join", { colony: "Very Large Colony" });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.data.briefing).toContain(statement);
    expect((await agent.call("rules")).data.rules).toContain(statement);
    const tool = await countMarkTool(agent);
    expect(tool.description).toContain(statement);
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }> };
    expect(schema.properties.queenId?.description).toBe("SPAWN only: the queenId of a live queen you own (observe queens).");
  });

  it("no longer carries the any-colony-agent spawn wording on those surfaces", async () => {
    const { agent } = await seat(RULES_27);
    const tool = await countMarkTool(agent);
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }> };
    const page = ruleSections(RULES_27).flatMap(section => section.lines).join("\n");
    for (const text of [briefing(RULES_27), joinBriefing(RULES_27), page, tool.description!, schema.properties.queenId!.description!, (await agent.call("rules")).data.rules as string]) {
      expect(text).not.toContain("that live own queen");
      expect(text).not.toContain("one of your colony's live queens");
    }
  });

  it("keeps the rules reply within its limit, before the map is drawn and on every drawable map", async () => {
    const measure = async (agent: TestAgent) => {
      const reply = await agent.client.callTool({ name: "rules", arguments: {} });
      const text = (reply.content as { text?: string }[]).map(c => c.text ?? "").join("");
      return { isError: reply.isError === true, rules: JSON.parse(text).rules as string, chars: text.length, bytes: Buffer.byteLength(JSON.stringify(reply)) };
    };
    const within = (sample: Awaited<ReturnType<typeof measure>>, label: string) => {
      expect(sample.isError, label).toBe(false);
      expect(sample.rules, label).toContain(statement);
      expect(sample.chars, label).toBeLessThanOrEqual(MAX_RULES_TEXT_CHARS);
      expect(sample.bytes, label).toBeLessThanOrEqual(MAX_RULES_REPLY_BYTES);
      console.log(`rules-27 rules reply, ${label}: ${sample.chars} chars / ${sample.bytes} bytes`);
    };
    // The new-match config the size tests use (response-size-fixture.ts).
    const sized: SimConfig = replyFixtureConfig("redesign");
    // Before join the reply states every map the seed can draw: the largest rules reply.
    h = await startHarness({ simConfig: sized });
    within(await measure(await h.connect()), "undrawn");
    await h.close();
    h = undefined;
    for (const map of sized.terrain!.maps) {
      const { agent } = await seat({ ...sized, terrain: { ...sized.terrain!, mapId: map.id } });
      within(await measure(agent), `${map.name} drawn`);
      await h!.close();
      h = undefined;
    }
  }, 60_000);
});


describe("rules-27 replies stay within the reply caps", () => {
  // New-match configs measure the current maps in MAPS' three positions.
  it.each(NEW_MATCH_REPLY_MAP_IDS.flatMap(mapId => [false, true].map(slot => ({ mapId, slot }))))("every tool on $mapId (slot $slot)", async ({ mapId, slot }) => {
    for (const spread of [false, true]) {
      const result = await measureReplies("redesign", spread, mapId, undefined, slot, config => ({ ...config, rules27: true }));
      expect(result.config.rules27).toBe(true);
      for (const sample of result.samples) {
        const full = sample.tool === "join" || sample.tool === "observe";
        expect(sample.textChars, JSON.stringify(sample)).toBeLessThanOrEqual(full ? MAX_OBSERVE_TEXT_CHARS : sample.tool === "rules" ? MAX_RULES_TEXT_CHARS : MAX_TEXT_CHARS);
        expect(sample.completeBytes, JSON.stringify(sample)).toBeLessThanOrEqual(full ? MAX_OBSERVE_REPLY_BYTES : sample.tool === "rules" ? MAX_RULES_REPLY_BYTES : MAX_REPLY_BYTES);
        if (sample.tool === "rules" || full) expect(sample.isError, JSON.stringify(sample)).toBe(false);
      }
      console.log(`Rules-27 MCP size ${mapId} slot=${slot} spread=${spread}: ${JSON.stringify(result.maxima)}`);
    }
  }, 60_000);
});
