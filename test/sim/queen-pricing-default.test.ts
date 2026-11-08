import { describe, expect, it } from "vitest";
import { LobbyStart } from "../../src/mcp/lobbyStart.js";
import { PUBLIC_CONFIG, QUEEN_RULES, RULES_NAMES, rulesConfig, type QueenRules } from "../../src/sim/config.js";
import { applyInput, defaultAllocator, foundQueen } from "../../src/sim/agents.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, parseLog, replay, stateHash } from "../../src/sim/log.js";
import { createMatch, queenFoundingCost } from "../../src/sim/map.js";
import type { SimEvent } from "../../src/sim/types.js";
import { setOwner } from "./fixtures.js";
import { playable } from "../playable.ts";

describe("new-match queen pricing defaults", () => {
  it.each([undefined, ...RULES_NAMES])("uses founded-live for %s and its server new-match config", name => {
    const config = rulesConfig(name);
    expect(config.queenFounding!.costBasis).toBe("founded-live");
    for (const selected of [playable(config), newMatchConfig(config)]) {
      const state = createMatch(7001, selected);
      for (const colony of state.colonies) {
        expect(colony.queens![0].starting).toBe(true);
        expect(queenFoundingCost(colony, state.config.queenFounding!)).toBe(400);
      }
    }
  });

  it.each([1, 2, 4])("excludes all %i lobby starting queens from the default price", count => {
    const seats = Array.from({ length: count }, (_, n) => [
      { identityId: `left-${n}`, colony: 0 as const }, { identityId: `right-${n}`, colony: 1 as const },
    ]).flat();
    const lobby = new LobbyStart(7001, playable(PUBLIC_CONFIG), seats, 0);
    const state = lobby.finish(lobby.closesAt);
    expect(state.config.queenFounding!.costBasis).toBe("founded-live");
    for (const colony of state.colonies) {
      expect(colony.queens).toHaveLength(count);
      expect(colony.queens!.every(q => q.starting === true)).toBe(true);
      expect(queenFoundingCost(colony, state.config.queenFounding!)).toBe(400);
    }
    // Explicit live pricing remains playable with the same multi-nest layout.
    const live = createMatch(7001, { ...state.config,
      queenFounding: { ...state.config.queenFounding!, costBasis: "live" } });
    expect(queenFoundingCost(live.colonies[0], live.config.queenFounding!)).toBe(400 * 2 ** (count - 1));
  });

  it.each([1, 2, 4])("charges the colony, not each of its %i agents, and counts only living founded queens", agents => {
    const state = createMatch(10, playable({ ...PUBLIC_CONFIG, startAnts: 0 }));
    state.tick = QUEEN_RULES.firstFoundTick!;
    for (let n = 0; n < agents; n++) {
      expect(applyInput(state, { type: "join", agentId: `left-${n}`, placement: 0 }, state.tick, defaultAllocator, []).error).toBeNull();
    }
    expect(state.agents.filter(a => a.colony === 0)).toHaveLength(agents);
    state.colonies[0].foodStore = 1200;
    const events: SimEvent[] = [];
    for (const [x, y] of [[36, 20], [36, 76]]) {
      setOwner(state, x!, y!, 0);
      expect(foundQueen(state, 0, x!, y!, state.tick, events)).toBeNull();
      state.tick += QUEEN_RULES.cooldownTicks;
    }
    expect(events.map(e => e.type === "queen_founded" ? e.foodCost : null)).toEqual([400, 800]);
    expect(state.colonies[0].foodStore).toBe(0);
    expect(queenFoundingCost(state.colonies[0], QUEEN_RULES)).toBe(1600);
    expect(queenFoundingCost(state.colonies[1], QUEEN_RULES)).toBe(400);
    state.colonies[0].queens![0].lostTick = state.tick;
    expect(queenFoundingCost(state.colonies[0], QUEEN_RULES)).toBe(1600);
    state.colonies[0].queens![1].lostTick = state.tick;
    expect(queenFoundingCost(state.colonies[0], QUEEN_RULES)).toBe(800);
  });

  it.each([undefined, "historical", "live", "founded-live"] as const)("retains the saved %s basis without defaulting it during replay", costBasis => {
    const { costBasis: _default, ...rules } = QUEEN_RULES;
    const queenFounding: QueenRules = { ...rules, ...(costBasis === undefined ? {} : { costBasis }) };
    const config = playable({ ...PUBLIC_CONFIG, queenFounding });
    const state = createMatch(7001, config);
    const lines = [headerLine(state.seed, state.config)];
    expect(config.queenFounding!.costBasis).toBe(queenFounding.costBasis);
    expect(parseLog(lines).header.config.queenFounding).toEqual(config.queenFounding);
    expect(stateHash(replay(lines, 0))).toBe(stateHash(state));
    expect(state.colonies[0].queens![0].starting).toBe(costBasis === "founded-live" ? true : undefined);
    if (costBasis === undefined) expect(parseLog(lines).header.config.queenFounding).not.toHaveProperty("costBasis");
  });

  it("keeps live pricing unlisted as a rules selection", () => {
    expect(RULES_NAMES).toEqual(["v4", "count-marks", "redesign"]);
    expect(() => rulesConfig("live")).toThrow("ANTWAR_RULES");
    expect(() => rulesConfig("founded-live")).toThrow("ANTWAR_RULES");
  });
});
