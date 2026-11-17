import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient as CurrentClient } from "../../packages/antwars-seat/lib/mcp.mjs";
import { renderView as currentRenderView } from "../../packages/antwars-seat/lib/board.mjs";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.ts";
import { TEST_CONFIG, startHarness } from "./harness.ts";

// An optional extracted release exercises the same scenario without changing client code.
const seatRoot = process.env.ANTWARS_TEST_SEAT_ROOT;
const { McpClient } = seatRoot
  ? await import(/* @vite-ignore */ pathToFileURL(resolve(seatRoot, "lib/mcp.mjs")).href)
  : { McpClient: CurrentClient };
const { renderView } = seatRoot
  ? await import(/* @vite-ignore */ pathToFileURL(resolve(seatRoot, "lib/board.mjs")).href)
  : { renderView: currentRenderView };
const clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
let harness;
afterEach(async () => { await harness?.close(); harness = undefined; });

async function accepted(client, name, args = {}) {
  const reply = await client.callTool(name, args);
  expect(reply.ok, `${name}: ${JSON.stringify(reply.data)}`).toBe(true);
  return reply.data;
}

describe("unchanged seat clients play with the revised instructions", () => {
  for (const wordMarks of [true, false]) {
    it(`finishes a short two-client match (${wordMarks ? "word marks" : "current count marks"})`, async () => {
      const config = { ...(wordMarks ? TEST_CONFIG : rulesConfig("redesign")), matchTicks: 80, commandFloorTicks: 1 };
      harness = await startHarness({ simConfig: config });
      const clients = [new McpClient({ url: harness.url, clock }), new McpClient({ url: harness.url, clock })];
      for (const [index, client] of clients.entries()) {
        await client.initialize();
        const tools = await client.listTools();
        expect(tools.some(tool => tool.name === "observe")).toBe(true);
        const joined = await accepted(client, "join", { colony: COLONY_NAMES[index] });
        expect(joined.briefing).not.toMatch(/\bsteer\w*\b/i);
        expect((await accepted(client, "rules")).rules).not.toMatch(/\bsteer\w*\b/i);
        if (wordMarks) {
          await accepted(client, "order", { kind: "follow_trail", mark: { words: ["HOLD"] } });
        } else {
          await accepted(client, "order", { kind: "hold" });
          await accepted(client, "count_mark", { verb: "GATHER", count: 1 });
        }
        const observed = await accepted(client, "observe");
        expect(observed.view.myMarks).toHaveLength(1);
        expect(observed.view.myMarks[0].steering).toEqual(expect.any(Number));
        if (wordMarks) expect(observed.view.myMarks[0].steering).toBe(observed.view.squad.length);
        else expect(observed.view.myMarks[0].steering).toBe(0);
        expect(renderView(observed)).toContain("myMarks (1):");
      }
      for (let round = 0; round < 3; round += 1) {
        harness.advance(5);
        for (const client of clients) {
          const observed = await accepted(client, "observe");
          expect(renderView(observed)).toContain("squad (");
        }
      }
      harness.advance(config.matchTicks);
      expect(harness.game.match.result).not.toBeNull();
      for (const client of clients) {
        const final = await accepted(client, "observe");
        expect(final.matchOver).toBe(true);
        expect(final.result).toEqual(harness.game.match.result);
        const command = await client.callTool("order", { kind: "hold" });
        expect(command.ok).toBe(false);
        expect(command.data.error.code).toBe("match_over");
      }
    }, 30_000);
  }
});
