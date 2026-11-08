import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import { replay, stateHash } from "../../src/sim/log.js";
import { startHarness, TEST_MCP_CONFIG, type Harness } from "./harness.js";

/**
 * Rules-27 queen owners, live game path:
 * Game.tick calls step with houseActive true, so the command-idle lapse never runs and an idle
 * seat ends the match instead (idle is source-policy dependent). An owner that leaves keeps its queen on that path too; the offline lapse path is in
 * test/sim/rules27-queen-owner-draw.test.ts.
 */

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const config = { ...rulesConfig("redesign"), startAnts: 0, squadSize: 0, commandFloorTicks: 1, hatchIntervalTicks: 1_000_000 };

describe("rules-27 queen owner on the live game path", () => {
  it("keeps the drawn owner's queen after the owner leaves, until the idle end, and the log replays the same owner", async () => {
    h = await startHarness({ start: false, simConfig: config, mcpConfig: { ...TEST_MCP_CONFIG, houseIdleSeconds: 10 } });
    const first = await h.connect(), second = await h.connect();
    const ids = [(await first.call("join", { colony: COLONY_NAMES[0] })).data.agentId as string,
      (await second.call("join", { colony: COLONY_NAMES[0] })).data.agentId as string];
    h.game.startMatch(23);
    h.advance(1);
    const state = () => h!.game.match!.state;
    expect(state().config.rules27).toBe(true);
    expect(state().agents.map((agent) => agent.id).sort()).toEqual([...ids].sort());
    const queen = () => state().colonies[0].queens![0]!;
    const owner = queen().owner!;
    expect(ids).toContain(owner);
    expect(state().colonies[1].queens![0]!.owner).toBeUndefined(); // the house colony has no agent
    // The owner leaves: its session ends and it never calls again. Its teammate keeps calling.
    const [leaver, teammate] = owner === ids[0] ? [first, second] : [second, first];
    await leaver.end();
    while (state().result === null) {
      expect((await teammate.call("observe")).isError).toBe(false);
      h.advance(9);
      expect(queen().owner).toBe(owner);
      // No lapse on this path: no seat is ever marked idle.
      expect(state().agents.every((agent) => !agent.idle)).toBe(true);
    }
    // The leaving owner's colony ends the match idle; the queen was never reassigned.
    expect(state().result).toMatchObject({ reason: "idle", winner: 1 });
    expect(queen().owner).toBe(owner);
    const end = state();
    const replayed = replay(h.log, end.tick);
    expect(replayed.colonies[0].queens![0]!.owner).toBe(owner);
    expect(replayed.result).toEqual(end.result);
    expect(stateHash(replayed)).toBe(stateHash(end));
  });
});
