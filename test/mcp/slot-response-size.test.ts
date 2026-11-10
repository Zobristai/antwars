import { describe, expect, it } from "vitest";
import { houseIdleText } from "../../src/mcp/briefing.js";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS, MAX_RULES_REPLY_BYTES, MAX_RULES_TEXT_CHARS } from "../../src/mcp/replies.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { MAPS, type SimConfig } from "../../src/sim/config.js";
import { startHarness } from "./harness.js";
import { NEW_MATCH_REPLY_MAP_IDS, measureReplies, replyFixtureConfig } from "./response-size-fixture.js";

// Independent ceilings; slot-key joins have the same full-view budget as token
// joins. These exercise the real HTTP/SDK adapter with deterministic lookup,
// not Firestore authorization. Candidate dimensions isolate wire-size effects.
describe("slot MCP reply budgets", () => {
  it.each(MAPS.flatMap((map, i) => [
    { mapId: NEW_MATCH_REPLY_MAP_IDS[i]!, grid: undefined as { width: number; height: number } | undefined, name: "shipped physical" },
    ...[{ width: 128, height: 96 }, { width: 256, height: 192 }].map(grid => ({ mapId: map.id, grid, name: `${grid.width}×${grid.height}` })),
  ]))("bounds every slot tool on $mapId ($name)", async ({ mapId, grid }) => {
    for (const spread of [false, true]) {
      const result = await measureReplies("redesign", spread, mapId, grid, true);
      if (grid === undefined) expect(result.config).toMatchObject({ gridScale: 2, mapWidth: 128, mapHeight: 96 });
      expect(result.maxima).toHaveProperty("locate_match");
      expect(result.samples).toHaveLength(Object.keys(result.maxima).length * 8);
      for (const sample of result.samples) {
        const full = sample.tool === "join" || sample.tool === "observe";
        expect(sample.textChars, JSON.stringify(sample)).toBeLessThanOrEqual(full ? MAX_OBSERVE_TEXT_CHARS : sample.tool === "rules" ? MAX_RULES_TEXT_CHARS : 20_000);
        expect(sample.completeBytes, JSON.stringify(sample)).toBeLessThanOrEqual(full ? MAX_OBSERVE_REPLY_BYTES : sample.tool === "rules" ? MAX_RULES_REPLY_BYTES : 40_960);
        if (full) {
          expect(sample.isError, JSON.stringify(sample)).toBe(false);
          expect(sample.eventCount).toBeGreaterThan(0);
          expect(sample.eventCount).toBeLessThanOrEqual(20);
        }
        if (sample.tool === "locate_match" || sample.tool === "rules") expect(sample.isError).toBe(false);
      }
      // The normal full-view budget must actually be available to slot joins,
      // not the smaller command budget or forced mark-table fallback at 40 KiB.
      if (spread) expect(result.samples.some(sample => sample.tool === "join" && sample.completeBytes > 40_960)).toBe(true);
      console.log(`Slot MCP budget ${mapId} ${grid?.width ?? "current"} spread=${spread}: ${JSON.stringify(result.maxima)}`);
    }
  }, 30_000);
});

it.each(NEW_MATCH_REPLY_MAP_IDS.map(id => ({ id })))("bounds slot lifecycle replies at the shipped physical grid on $id", async map => {
  const h = await startHarness({ start: false, simConfig: replyFixtureConfig("redesign", map.id),
    slot: { identityOf: async key => key === "local-fixture-key" ? "budget-seat" : undefined,
      locate: async () => ({ slot: "public-0", mcpUrl: "http://local.test/mcp", spectatorUrl: "http://local.test/" }) } });
  try {
    h.game.seatLobby("budget-lobby", [{ identityId: "budget-seat", displayName: "Budget", colony: 0 }]);
    let agent = await h.connect();
    const check = async (tool: string, args: Record<string, unknown> = {}) => {
      const reply = await agent.client.callTool({ name: tool, arguments: args });
      const text = (reply.content as { text: string }[])[0]!.text;
      const full = tool === "join" || tool === "observe";
      expect(text.length, `${tool}: ${text.length}`).toBeLessThanOrEqual(full ? MAX_OBSERVE_TEXT_CHARS : 20_000);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(full ? MAX_OBSERVE_REPLY_BYTES : 40_960);
      expect(JSON.parse(text)).toEqual(reply.structuredContent);
      return reply;
    };
    await check("join");
    await check("join", { key: "unknown" });
    await check("join", { token: "not-accepted" });
    await check("join", { key: "local-fixture-key" });
    await check("observe");
    await check("rules");
    h.game.startMatch(1);
    await check("join", { key: "local-fixture-key" });
    await check("observe");
    await check("observe", { map: true });
    await agent.end();
    agent = await h.connect();
    await check("join", { key: "local-fixture-key" });
    h.game.match!.state.tick = h.game.match!.state.config.matchTicks - 1;
    h.advance(1);
    for (const tool of ["rules", "order", "count_mark", "found_queen", "locate_match"]) await check(tool, tool === "locate_match" ? { lobbyId: "budget-lobby" } : {});
    await check("observe", { map: true });
    await check("join", { key: "local-fixture-key" });
  } finally { await h.close(); }
});

it.each(NEW_MATCH_REPLY_MAP_IDS.map(id => ({ id })))("bounds the physical-grid pick window with maximum names and all picks on $id", async map => {
  await boundPickWindow(replyFixtureConfig("redesign", map.id), map.id);
});

// The longest drawn map values the formats accept, an ant cap of 2^53 - 1 and a near-maximal
// 9,999,997-tick length (its decimal minutes are the longest duration text), on every rotation map.
const EXTREME = { colonyCap: Number.MAX_SAFE_INTEGER, matchTicks: 9_999_997 };
it.each(replyFixtureConfig("redesign").terrain!.maps.map(map => map.id))("bounds the pick window on %s with the longest ant cap and match length", async mapId => {
  const base = replyFixtureConfig("redesign", mapId);
  const config = { ...base, terrain: { ...base.terrain!, maps: base.terrain!.maps.map(map => ({ ...map, ...EXTREME })) } };
  const rules = await boundPickWindow(config, mapId);
  expect(rules.split(` Ant cap ${Number.MAX_SAFE_INTEGER}/colony.`)).toHaveLength(2);
  expect(rules).toContain("999999.7 s (16666.661666666667 minutes)");
});

/** Eight maximum-name seats pick nests; join, observe, rules and pick_nest stay inside their caps. Returns a rules reply. */
async function boundPickWindow(config: SimConfig, mapId: string): Promise<string> {
  let rules = "";
  const map = { id: mapId };
  const seats = Array.from({ length: 8 }, (_, i) => ({ identityId: `max-${i}`, displayName: `${i}${"名".repeat(31)}`, colony: (i % 2) as 0 | 1 }));
  const h = await startHarness({ start: false, simConfig: config, slot: {
    identityOf: async key => seats.find(s => s.identityId === key)?.identityId,
    locate: async () => undefined,
  } });
  try {
    h.game.seatLobby("max-name-lobby", seats);
    h.game.beginLobbyStart(7001);
    const agents = [];
    for (const seat of seats) {
      const agent = await h.connect(); agents.push(agent);
      const joined = await agent.call("join", { key: seat.identityId });
      const box = joined.data.nestSelection.box;
      let accepted = false;
      for (let y = box.y; y < box.y + box.height && !accepted; y++) {
        for (let x = box.x; x < box.x + box.width && !accepted; x++) {
          accepted = h.game.pickNest(joined.data.agentId, x, y).ok;
        }
      }
      expect(accepted).toBe(true);
    }
    for (const [i, agent] of agents.entries()) {
      const joined = await agent.call("join", { key: seats[i]!.identityId });
      const ownPick = joined.data.nestSelection.picks.find((pick: { mine: boolean }) => pick.mine);
      for (const tool of ["join", "observe", "rules", "pick_nest"]) {
        const args = tool === "join" ? { key: seats[i]!.identityId }
          : tool === "pick_nest" ? { tileX: ownPick.tileX, tileY: ownPick.tileY } : {};
        const result = await agent.client.callTool({ name: tool, arguments: args });
        const text = (result.content as { text: string }[])[0]!.text;
        const full = tool === "join" || tool === "observe";
        const size = { map: map.id, tool, textChars: text.length, completeBytes: Buffer.byteLength(JSON.stringify(result)) };
        expect(JSON.parse(text)).toEqual(result.structuredContent);
        expect(result.isError).not.toBe(true);
        if (tool === "pick_nest") expect((result.structuredContent as any).accepted).toBe(true);
        if (tool === "rules") rules = (result.structuredContent as { rules: string }).rules;
        if (i === 0 || tool === "rules") console.log(`Physical pick-window budget: ${JSON.stringify(size)}`);
        expect((result.structuredContent as any).nestSelection.picks).toHaveLength(4);
        expect(size.textChars, JSON.stringify(size)).toBeLessThanOrEqual(full ? MAX_OBSERVE_TEXT_CHARS : tool === "rules" ? MAX_RULES_TEXT_CHARS : 20_000);
        expect(size.completeBytes, JSON.stringify(size)).toBeLessThanOrEqual(full ? MAX_OBSERVE_REPLY_BYTES : tool === "rules" ? MAX_RULES_REPLY_BYTES : 40_960);
      }
    }
  } finally { await h.close(); }
  return rules;
}

it.each(NEW_MATCH_REPLY_MAP_IDS.flatMap(mapId => [180, 45].map(houseIdleSeconds => ({ mapId, houseIdleSeconds }))))(
  "house-4v4 rules with maximum UTF-8 names and every pick fit the unchanged caps on $mapId (limit $houseIdleSeconds s)", async ({ mapId, houseIdleSeconds }) => {
    // Four-byte Unicode maximizes name bytes. A multi-seat identity also adds
    // the public " #seat" suffix, beyond the maximum stored display name.
    const seats = Array.from({ length: 8 }, (_, i) => ({ identityId: `max-${i % 2}`,
      displayName: `${i % 2}${"𠀀".repeat(31)}`, colony: (i % 2) as 0 | 1, seat: 1 + Math.floor(i / 2) }));
    const h = await startHarness({ start: false, simConfig: replyFixtureConfig("redesign", mapId),
      mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 1_000_000, houseIdleSeconds },
      slot: { identityOf: async key => seats.find(seat => seat.identityId === key)?.identityId, locate: async () => undefined } });
    try {
      h.game.seatLobby("max-name-lobby", seats, "house-4v4");
      h.game.beginLobbyStart(7001);
      const agents = [];
      for (const seat of seats) {
        expect([...seat.displayName]).toHaveLength(DEFAULT_MCP_CONFIG.displayNameMaxChars);
        const agent = await h.connect(); agents.push(agent);
        const joined = await agent.call("join", { key: seat.identityId, seat: seat.seat });
        expect(joined.isError, joined.text).toBe(false);
        const box = joined.data.nestSelection.box;
        let accepted = false;
        for (let y = box.y; y < box.y + box.height && !accepted; y++) for (let x = box.x; x < box.x + box.width && !accepted; x++) {
          accepted = h.game.pickNest(joined.data.agentId, x, y).ok;
        }
        expect(accepted).toBe(true);
      }
      for (const agent of agents) {
        const result = await agent.client.callTool({ name: "rules", arguments: {} });
        expect(result.isError).not.toBe(true);
        const text = (result.content as { text: string }[])[0]!.text;
        const data = result.structuredContent as { rules: string; nestSelection: { required: boolean; picks: unknown[] } };
        expect(JSON.parse(text)).toEqual(data);
        expect(data.nestSelection.required).toBe(true);
        expect(data.nestSelection.picks).toHaveLength(4);
        // The one idle rule opens the rules for every match type.
        expect(data.rules.split("\n")[0]).toBe(houseIdleText({ ...DEFAULT_MCP_CONFIG, houseIdleSeconds }));
        expect(data.rules).toContain(`for ${houseIdleSeconds} s is idle; no bot takeover. Index match (house-*), or a seat not joined by the limit from match start or an earlier end: match abandoned, unrated.`);
        const size = { map: mapId, houseIdleSeconds, textChars: text.length, completeBytes: Buffer.byteLength(JSON.stringify(result)) };
        console.log(`House rules budget: ${JSON.stringify(size)}`);
        expect(size.textChars).toBeLessThanOrEqual(MAX_RULES_TEXT_CHARS);
        expect(size.completeBytes).toBeLessThanOrEqual(MAX_RULES_REPLY_BYTES);
      }
    } finally { await h.close(); }
  });
