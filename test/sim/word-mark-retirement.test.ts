import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { CASTE_RULES, DEFAULT_CONFIG } from "../../src/sim/config.js";
import { createMatch } from "../../src/sim/map.js";
import type { SimEvent, SimInput } from "../../src/sim/types.js";
import { playable } from "../playable.ts";

const retiredInputs: SimInput[] = [
  { type: "mark", agentId: "a", words: ["FOOD"] },
  { type: "order", agentId: "a", order: { kind: "hold" }, mark: { words: ["FOOD"] }, brood: "soldiers", intent: "must not apply" },
  { type: "order", agentId: "a", order: { kind: "follow_trail" }, brood: "soldiers", intent: "must not apply" },
];

describe("retired commands in new matches", () => {
  it.each(retiredInputs)("refuses $type atomically before waking an idle seat or changing any state", input => {
    const state = createMatch(11, playable({ ...DEFAULT_CONFIG, castes: CASTE_RULES, wordMarksDisabled: true, commandIdleTicks: 20 }));
    const events: SimEvent[] = [];
    applyInput(state, { type: "join", agentId: "a" }, 0, defaultAllocator, events);
    state.agents[0]!.idle = true;
    const before = JSON.stringify(state);
    const result = applyInput(state, input, 5, defaultAllocator, []);
    expect(result.error).not.toBeNull();
    expect(JSON.stringify(state)).toBe(before);
  });

  it("leaves the ordinary order kinds and their brood and intent intact", () => {
    for (const kind of ["go_to", "attack", "forage", "hold"] as const) {
      const state = createMatch(11, playable({ ...DEFAULT_CONFIG, castes: CASTE_RULES, wordMarksDisabled: true }));
      applyInput(state, { type: "join", agentId: "a" }, 0, defaultAllocator, []);
      const order = kind === "go_to" || kind === "attack" ? { kind, tileX: 40, tileY: 40 } : { kind };
      const events: SimEvent[] = [];
      expect(applyInput(state, { type: "order", agentId: "a", order, brood: "workers", intent: "scout" }, 1, defaultAllocator, events).error).toBeNull();
      expect(state.agents[0]!.order).toEqual(order);
      expect(state.agents[0]!.brood).toBe("workers");
      expect(events).toContainEqual({ type: "order", tick: 1, agentId: "a", order, intent: "scout" });
    }
  });

});
