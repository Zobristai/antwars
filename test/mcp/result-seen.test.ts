import { describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { startHarness, TEST_CONFIG, TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

describe("Which answers carry the match result", () => {
  it("an answer after the end carries the result, a refused call's too", async () => {
    const game = new Game({ simConfig: playable({ ...TEST_CONFIG, matchTicks: 20 }), mcpConfig: TEST_MCP_CONFIG });
    const a = await game.join({});
    const b = await game.join({});

    game.startMatch(7);
    while (game.match!.result === null) game.tick();

    const seen = await game.call(a.agentId!, { type: "observe", agentId: a.agentId! });
    expect(seen.kind === "view" && seen.view.result !== null).toBe(true);

    // A refused call after the end carries the result too.
    const refused = await game.call(b.agentId!, { type: "rejoin", agentId: b.agentId! });
    expect(refused).toMatchObject({ kind: "error", code: "match_over", view: { result: game.match!.result } });
  });

  it("a rate-limited answer carries the final result, but not a live refusal", async () => {
    const h = await startHarness({
      simConfig: { ...TEST_CONFIG, matchTicks: 20 },
      mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 1 },
    });
    try {
      const a = await h.connect();
      const b = await h.connect();
      expect((await a.call("join")).isError).toBe(false);
      expect((await b.call("join")).isError).toBe(false);

      // The admitted join consumed the window; the injected clock stays frozen.
      const live = await a.call("observe");
      expect(live.isError).toBe(true);
      expect(live.data.error.code).toBe("call_rate");
      expect(live.data.matchOver).toBeUndefined();

      h.advance(20 - h.game.match!.state.tick);
      expect(h.game.match!.result).not.toBeNull();
      const ended = await a.call("observe");
      expect(ended.isError).toBe(true);
      expect(ended.data.error.code).toBe("call_rate");
      expect(ended.data.matchOver).toBe(true);
      expect(ended.data.result).toEqual(h.game.match!.result);
      expect(h.clock.now).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("an order rejected on the final tick does not carry it: its public error omits the winner", async () => {
    const h = await startHarness({ simConfig: { ...TEST_CONFIG, matchTicks: 20 } });
    try {
      const agent = await h.connect();
      const joined = await agent.call("join");
      expect(joined.isError, joined.text).toBe(false);
      h.advance(20 - 1 - h.game.match!.state.tick);
      expect(h.game.match!.result).toBeNull();

      // Submitted on the last tick: the sim refuses the mark and that tick ends the match.
      const refused = await agent.call("mark", { tileX: 1, tileY: 1, words: ["X"] });
      expect(refused.isError, refused.text).toBe(true);
      expect(refused.data.error.code).toBe("bad_mark_words");
      expect(h.game.match!.result).not.toBeNull();
      expect(refused.data.matchOver).toBeUndefined();
      expect(refused.data.winner).toBeUndefined();

      const seen = await agent.call("observe");
      expect(seen.data.matchOver).toBe(true);
    } finally {
      await h.close();
    }
  });
});
