/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import type { SimInput } from "../../src/sim/types.js";
import { startHarness, type Harness } from "../mcp/harness.js";
import { shortConfig } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** The inputs logged for match seq, the seq-th match in the harness's one log. */
function matchInputs(log: readonly string[], seq: number): SimInput[] {
  let match = 0;
  const inputs: SimInput[] = [];
  for (const line of log) {
    const entry = JSON.parse(line) as { type?: string; inputs?: SimInput[] };
    if (entry.type === "header") match += 1;
    else if (match === seq) inputs.push(...(entry.inputs ?? []));
  }
  return inputs;
}

describe("an agent and its token belong to one match", () => {
  it("after the next match starts, a late order and an old-token rejoin get the match-ended error and change nothing in it", async () => {
    // A short squad timer, so a timer carried into the second match would show within it.
    const SQUAD_TIMER = 5;
    h = await startHarness({ start: false, simConfig: shortConfig(20, { squadTimerTicks: SQUAD_TIMER }) });
    const game = h.game;
    const agent = await h.connect();
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(false);
    const { agentId, reconnectToken } = joined.data;

    game.startMatch(1);
    h.advance(1);
    expect(game.match!.state.agents.map((a) => a.id)).toEqual([agentId]);
    expect((await agent.call("order", { kind: "hold" })).isError).toBe(false);

    while (game.match!.result === null) h.advance(1);
    game.startMatch(2);
    expect(game.match!.seq).toBe(2);
    const endedError = (r: { isError: boolean; text: string; data: any }): void => {
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe("match_over");
      expect(r.text).toMatch(/match has ended/);
      expect(r.text).toMatch(/call join/i);
    };
    endedError(await agent.call("order", { kind: "forage" }));
    const stale = await h.connect();
    endedError(await stale.call("join", { token: reconnectToken }));

    // Past a squad timer's length into the second match, it still carries nothing from the first.
    h.advance(SQUAD_TIMER + 5);
    expect(game.match!.seq).toBe(2);
    expect(game.match!.state.agents).toEqual([]);
    expect(matchInputs(h.log, 2)).toEqual([]);
    expect(matchInputs(h.log, 1).some((input) => input.agentId === agentId)).toBe(true);
  });
});
