import { describe, expect, it } from "vitest";
import { Game } from "../../src/mcp/game.js";
import { startHarness, TEST_CONFIG, TEST_MCP_CONFIG } from "./harness.js";
import { playable } from "../playable.ts";

describe("The game records which agents have seen the result, and reports each token it issues", () => {
  it("marks an agent once an answer to it carries the result, and only that agent", async () => {
    const issued: string[] = [];
    const game = new Game({ simConfig: playable({ ...TEST_CONFIG, matchTicks: 20 }), mcpConfig: TEST_MCP_CONFIG, onTokenIssued: (t) => issued.push(t) });
    const a = await game.join({});
    const b = await game.join({});
    expect(issued).toEqual([a.token, b.token]);

    game.startMatch(7);
    while (game.match!.result === null) game.tick();
    expect(game.matchAgents().map((m) => m.sawResult)).toEqual([false, false]);

    const seen = await game.call(a.agentId!, { type: "observe", agentId: a.agentId! });
    expect(seen.kind === "view" && seen.view.result !== null).toBe(true);
    expect(game.matchAgents()).toEqual([
      { agentId: a.agentId, key: null, displayName: null, sawResult: true },
      { agentId: b.agentId, key: null, displayName: null, sawResult: false },
    ]);

    // A refused call after the end carries the result too, so it counts.
    const refused = await game.call(b.agentId!, { type: "rejoin", agentId: b.agentId! });
    expect(refused.kind).toBe("error");
    expect(game.matchAgents().every((m) => m.sawResult)).toBe(true);
  });

  it("counts a rate-limited final result only for its recipient, but not a live refusal", async () => {
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
      expect(h.game.matchAgents().map((m) => m.sawResult)).toEqual([false, false]);

      h.advance(20 - h.game.match!.state.tick);
      expect(h.game.match!.result).not.toBeNull();
      const ended = await a.call("observe");
      expect(ended.isError).toBe(true);
      expect(ended.data.error.code).toBe("call_rate");
      expect(ended.data.matchOver).toBe(true);
      expect(ended.data.result).toEqual(h.game.match!.result);
      expect(h.game.matchAgents().map((m) => m.sawResult)).toEqual([true, false]);
      expect(h.clock.now).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("an order rejected on the final tick does not count: its public error omits the winner", async () => {
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
      expect(h.game.matchAgents().map((m) => m.sawResult)).toEqual([false]);

      const seen = await agent.call("observe");
      expect(seen.data.matchOver).toBe(true);
      expect(h.game.matchAgents().map((m) => m.sawResult)).toEqual([true]);
    } finally {
      await h.close();
    }
  });
});
