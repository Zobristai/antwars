import { expect, it } from "vitest";
import { MAX_OBSERVE_REPLY_BYTES, MAX_OBSERVE_TEXT_CHARS } from "../../src/mcp/replies.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { comparisonOptions } from "../../src/server.js";
import { createMatch } from "../../src/sim/map.js";
import { isRockTile, isWaterTile } from "../../src/sim/terrain.js";
import { prepareLargestView } from "./response-size-fixture.js";
import { startHarness, type TestAgent } from "./harness.js";

const shipped = comparisonOptions({}, DEFAULT_MCP_CONFIG).simConfig!;
const seats = Array.from({ length: 8 }, (_, i) => ({
  identityId: `identity-${i}`, displayName: `${i}${"名".repeat(31)}`, colony: (i % 2) as 0 | 1,
}));

async function bounded(agent: TestAgent, name: string, args: Record<string, unknown>, withView = false) {
  const reply = await agent.client.callTool({ name, arguments: args }) as CallToolResult;
  const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
  // Pin independently of production exports: never bless raising a limit. The rules pin
  // follows the documented rules budget (49,000 characters / 102,380 bytes, as in
  // response-size.test.ts); every other reply without a view keeps the command budget.
  const bytes = Buffer.byteLength(JSON.stringify(reply));
  const measured = `${name}: ${text.length} characters / ${bytes} bytes`;
  const [textCap, byteCap] = withView ? [MAX_OBSERVE_TEXT_CHARS, MAX_OBSERVE_REPLY_BYTES]
    : name === "rules" ? [49_000, 102_380] : [20_000, 40_960];
  expect(text.length, measured).toBeLessThanOrEqual(textCap);
  expect(bytes, measured).toBeLessThanOrEqual(byteCap);
  expect(JSON.parse(text)).toEqual(reply.structuredContent);
  return reply;
}

/** This exercises the real slot MCP adapter, not store authentication or lobby scheduling. */
it.each(shipped.terrain!.maps)("$name: slot replies fit at the production grid with eight seats and 512 ants per colony", async map => {
  const config = { ...shipped, terrain: { ...shipped.terrain!, mapId: map.id } };
  const h = await startHarness({ simConfig: config, start: false, slot: {
    identityOf: async key => seats.find(seat => `key-${seat.identityId}` === key)?.identityId,
    locate: async id => id === "budget-lobby" ? { slot: "public-0", mcpUrl: "http://localhost/mcp", spectatorUrl: "http://localhost/" } : undefined,
  } });
  try {
    h.game.seatLobby("budget-lobby", seats);
    const clients: TestAgent[] = [];
    for (const seat of seats) {
      const agent = await h.connect();
      clients.push(agent);
      const queued = await bounded(agent, "join", { key: `key-${seat.identityId}` });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent).not.toHaveProperty("reconnectToken");
      expect(queued.structuredContent).toHaveProperty("matchStarts");
    }
    h.game.startMatch(23);
    h.advance(1);
    expect(h.game.match!.state.agents).toHaveLength(8);
    for (const [index, agent] of clients.entries()) {
      const key = `key-${seats[index]!.identityId}`;
      const calls: { name: string; args: Record<string, unknown>; withView?: boolean; error?: boolean }[] = [
        { name: "join", args: { key }, withView: true },
        { name: "observe", args: {}, withView: true },
        { name: "observe", args: { map: true }, withView: true },
        { name: "rules", args: {} },
        { name: "order", args: { kind: "hold" } },
        { name: "count_mark", args: { verb: "GATHER", count: 1 } },
        { name: "count_mark", args: { verb: "GATHER", count: 20 } },
        { name: "found_queen", args: { tileX: -1, tileY: -1 }, error: true },
        { name: "locate_match", args: { lobbyId: "budget-lobby" } },
      ];
      for (const call of calls) {
        prepareLargestView(h, true);
        for (const colony of [0, 1]) expect(h.game.match!.state.ants.filter(ant => ant.colony === colony)).toHaveLength(512);
        const reply = await bounded(agent, call.name, call.args, call.withView);
        expect(reply.isError === true, call.name).toBe(call.error ?? false);
        if (call.withView) {
          expect(reply.structuredContent).toHaveProperty("view.terrain.mapId", map.id);
          expect(reply.structuredContent).toHaveProperty("view.cells");
          expect(reply.structuredContent).toHaveProperty("view.marks");
        }
      }
      // A fresh SDK connection takes the same identity seat, never a token seat.
      prepareLargestView(h, true);
      const again = await h.connect();
      const rejoined = await bounded(again, "join", { key }, true);
      expect(rejoined.isError).not.toBe(true);
      expect(rejoined.structuredContent).not.toHaveProperty("reconnectToken");
      expect(h.game.match!.state.agents).toHaveLength(8);
    }
    const stranger = await h.connect();
    for (const args of [{}, { key: "unknown-key" }, { key: "unknown-key", colony: "VLC" }]) {
      expect((await bounded(stranger, "join", args)).isError).toBe(true);
    }
  } finally { await h.close(); }
}, 60_000);

it.each(shipped.terrain!.maps)("$name: complete nest-window replies fit with every maximum-name seat picked", async map => {
  const config = { ...shipped, terrain: { ...shipped.terrain!, mapId: map.id } };
  const h = await startHarness({ simConfig: config, start: false, slot: {
    identityOf: async key => seats.find(seat => `key-${seat.identityId}` === key)?.identityId,
    locate: async () => undefined,
  } });
  try {
    const board = createMatch(23, config);
    h.game.seatLobby("budget-lobby", seats);
    h.game.beginLobbyStart(23);
    const selected = new Map<string, { tileX: number; tileY: number }>();
    const used = new Set<number>();
    for (const seat of seats) {
      expect([...seat.displayName]).toHaveLength(32);
      const agent = await h.connect();
      const joined = await bounded(agent, "join", { key: `key-${seat.identityId}` }, true);
      expect(joined.isError).not.toBe(true);
      const window = joined.structuredContent!.nestSelection as { box: { x: number; y: number; width: number; height: number } };
      const { box } = window;
      let pick: { tileX: number; tileY: number } | undefined;
      for (let y = box.y; y < box.y + box.height && pick === undefined; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
          const index = y * config.mapWidth + x;
          if (used.has(index) || board.food[index]! > 0 || isWaterTile(board.terrain, x, y) || isRockTile(board.terrain, x, y)) continue;
          pick = { tileX: x, tileY: y };
          used.add(index);
          break;
        }
      }
      expect(pick, seat.identityId).toBeDefined();
      const picked = await bounded(agent, "pick_nest", pick!);
      expect(picked.isError).not.toBe(true);
      expect(picked.structuredContent!.accepted).toBe(true);
      selected.set(seat.identityId, pick!);
    }
    for (const seat of seats) {
      const agent = await h.connect();
      for (const name of ["join", "observe", "rules"]) {
        const reply = await bounded(agent, name, name === "join" ? { key: `key-${seat.identityId}` } : {}, name !== "rules");
        expect(reply.isError).not.toBe(true);
        if (name === "rules") {
          const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("");
          console.log(`Nest-window rules budget: ${JSON.stringify({ map: map.id, textChars: text.length, completeBytes: Buffer.byteLength(JSON.stringify(reply)) })}`);
        }
        const window = reply.structuredContent!.nestSelection as { picks: { displayName: string; mine: boolean; tileX: number; tileY: number }[] };
        const expected = seats.filter(other => other.colony === seat.colony).map(other => ({
          displayName: other.displayName, mine: other.identityId === seat.identityId, ...selected.get(other.identityId)!,
        }));
        expect(window.picks).toHaveLength(expected.length);
        expect(window.picks).toEqual(expect.arrayContaining(expected));
        expect(JSON.stringify(reply)).not.toContain("identityId");
        expect(JSON.stringify(reply)).not.toContain("key-identity");
      }
    }
    expect(h.game.match).toBeNull();
  } finally { await h.close(); }
}, 60_000);
