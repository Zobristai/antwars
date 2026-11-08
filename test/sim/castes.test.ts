import { describe, expect, it } from "vitest";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { resolveCombat } from "../../src/sim/combat.js";
import { Game } from "../../src/mcp/game.js";
import { CASTE_RULES, DEFAULT_CONFIG, PUBLIC_CONFIG, RULES_VERSION, SUB, damagePerTick } from "../../src/sim/config.js";
import { colonyBrood, forageDirection, hatch, pickupAndDeliver } from "../../src/sim/forage.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { rebalanceRoles } from "../../src/sim/houseBot.js";
import { headerLine, parseLog, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { buildGrid, createMatch, tileIndex } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import { WORDS, type Agent, type Brood, type ColonyId, type SimEvent, type SimInput, type SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch, setOwner, HISTORICAL_CASTE_CONFIG } from "./fixtures.js";
import { playable } from "../playable.ts";

const V4 = HISTORICAL_CASTE_CONFIG;

function seat(state: SimState, id: string, colony: ColonyId, brood?: Brood, idle = false): Agent {
  const agent: Agent = {
    id,
    colony,
    joinSeq: state.agents.length,
    modelLabel: null,
    parentAgentId: null,
    squad: [],
    order: { kind: "forage" },
    lastCallTick: state.tick,
    lastCommandTick: null,
    idle,
    pendingEvents: [],
    ...(brood === undefined ? {} : { brood }),
  };
  state.agents.push(agent);
  return agent;
}

/** A v4 match with no ants and colony 0 ready to hatch from the given store. */
function readyToHatch(store: number): SimState {
  const state = emptyMatch(1000, V4);
  state.colonies[0].foodStore = store;
  state.colonies[0].lastHatchTick = -V4.hatchIntervalTicks;
  return state;
}

function hatchOnce(state: SimState): SimEvent[] {
  const events: SimEvent[] = [];
  hatch(state, state.tick, events);
  state.colonies[0].lastHatchTick = -V4.hatchIntervalTicks;
  return events.filter((e) => e.type === "hatch" && e.colony === 0);
}

describe("the two castes", () => {
  it("starts every ant as a worker, and gives no ant a caste with the switch off", () => {
    expect(createMatch(5, playable(V4)).ants.every((a) => a.caste === "worker")).toBe(true);
    expect(createMatch(5, playable(DEFAULT_CONFIG)).ants.every((a) => !("caste" in a))).toBe(true);
  });

  it("charges the configured worker and soldier costs, waiting while the store is short", () => {
    const workers = readyToHatch(V4.hatchCost);
    seat(workers, "a", 0, "workers");
    expect(hatchOnce(workers)).toMatchObject([{ caste: "worker" }]);
    expect(workers.colonies[0].foodStore).toBe(0);

    const soldiers = readyToHatch(CASTE_RULES.soldierCost - 1);
    seat(soldiers, "a", 0, "soldiers");
    expect(hatchOnce(soldiers)).toEqual([]);
    soldiers.colonies[0].foodStore = CASTE_RULES.soldierCost + 1;
    expect(hatchOnce(soldiers)).toMatchObject([{ caste: "soldier" }]);
    expect(soldiers.colonies[0].foodStore).toBe(1);
    expect(CASTE_RULES.soldierCost).toBe(2 * V4.hatchCost);
  });

  it("gives a soldier twice a worker's HP", () => {
    const state = readyToHatch(6);
    seat(state, "a", 0, "soldiers");
    hatchOnce(state);
    expect(state.ants[0]).toMatchObject({ caste: "soldier", hp: 2 * V4.antHp });
  });

  it("has a soldier deal 1.5 times a worker's damage, with the defender bonus on top", () => {
    const state = emptyMatch(1000, V4);
    const soldier = addAnt(state, 0, 30, 20, { caste: "soldier", hp: 8000 });
    const worker = addAnt(state, 1, 31, 20, { caste: "worker" });
    resolveCombat(state, buildGrid(state), state.tick, []);
    const base = damagePerTick(V4);
    expect(V4.antHp - worker.hp).toBe((base * 3) / 2);
    expect(8000 - soldier.hp).toBe(base);

    const own = emptyMatch(1000, V4);
    addAnt(own, 0, 30, 20, { caste: "soldier", hp: 8000 });
    const struck = addAnt(own, 1, 31, 20, { caste: "worker" });
    setOwner(own, 30, 20, 0);
    resolveCombat(own, buildGrid(own), own.tick, []);
    expect(V4.antHp - struck.hp).toBe(Math.trunc((((base * 3) / 2) * V4.defenderBonusPermille) / 1000));
  });

  it("never lets a soldier pick up food, and sends a foraging soldier to its queen", () => {
    const state = emptyMatch(1000, V4);
    const queen = state.colonies[0];
    // Grid scale 2: six reference tiles east of the queen's reference tile, at the first fine tile of
    // that reference cell, where the cell's food lives.
    const tx = 2 * (Math.floor(queen.queenX / SUB / 2) + 6);
    const ty = 2 * Math.floor(queen.queenY / SUB / 2);
    state.food[tileIndex(state.config, tx, ty)] = 5;
    const soldier = addAnt(state, 0, tx, ty, { caste: "soldier", squad: "a" });
    const worker = addAnt(state, 0, tx, ty, { caste: "worker", squad: "a" });
    pickupAndDeliver(state, new Set([soldier.id, worker.id]));
    expect(soldier.carrying).toBe(false);
    expect(worker.carrying).toBe(true);
    expect(state.food[tileIndex(state.config, tx, ty)]).toBe(4);

    const tiles = [tileIndex(state.config, tx + 4, ty)];
    state.food[tiles[0]!] = 3;
    expect(forageDirection(state, soldier, tiles).x).toBeLessThan(0);
    expect(forageDirection(state, { ...worker, carrying: false }, tiles).x).toBeGreaterThan(0);
  });

  it("counts both castes against the colony cap", () => {
    const state = readyToHatch(30);
    for (let i = 0; i < V4.colonyCap; i += 1) addAnt(state, 0, 5 + (i % 10), 5 + Math.floor(i / 10), { caste: i % 2 === 0 ? "worker" : "soldier" });
    expect(hatchOnce(state)).toEqual([]);
    state.ants.pop();
    expect(hatchOnce(state)).toHaveLength(1);
  });

  it("keeps the sixteen-word marks vocabulary", () => {
    expect(WORDS).toHaveLength(16);
  });
});

describe("the brood vote", () => {
  it("is mixed with no agents, with every choice unset, and on a tie", () => {
    const none = emptyMatch(1000, V4);
    expect(colonyBrood(none, 0)).toBe("mixed");
    seat(none, "a", 0);
    seat(none, "b", 0);
    expect(colonyBrood(none, 0)).toBe("mixed");
    seat(none, "c", 0, "workers");
    seat(none, "d", 0, "soldiers");
    expect(colonyBrood(none, 0)).toBe("mixed");
  });

  it("follows the most common choice among seated agents that set one", () => {
    const state = emptyMatch(1000, V4);
    seat(state, "a", 0, "soldiers");
    seat(state, "b", 0);
    seat(state, "c", 0);
    expect(colonyBrood(state, 0)).toBe("soldiers");
    seat(state, "d", 0, "workers", true);
    seat(state, "e", 0, "workers", true);
    seat(state, "f", 1, "workers");
    expect(colonyBrood(state, 0)).toBe("soldiers");
    expect(colonyBrood(state, 1)).toBe("workers");
  });

  it("alternates worker and soldier under mixed", () => {
    const state = readyToHatch(30);
    const castes = [0, 1, 2, 3].map(() => (hatchOnce(state)[0] as { caste?: string }).caste);
    expect(castes).toEqual(["worker", "soldier", "worker", "soldier"]);
    expect(state.colonies[0].foodStore).toBe(30 - 2 * V4.hatchCost - 2 * CASTE_RULES.soldierCost);
  });
});

describe("the brood order field", () => {
  const order = (brood: unknown): SimInput =>
    ({ type: "order", agentId: "a", order: { kind: "forage" }, brood }) as SimInput;

  it("sets the agent's brood, and refuses an unknown one", () => {
    const state = emptyMatch(1000, V4);
    const agent = seat(state, "a", 0);
    expect(applyInput(state, order("soldiers"), 1000, defaultAllocator, []).error).toBeNull();
    expect(agent.brood).toBe("soldiers");
    agent.lastCommandTick = null;
    expect(applyInput(state, order("queens"), 1000, defaultAllocator, []).error?.code).toBe("bad_order");
    expect(agent.brood).toBe("soldiers");
  });

  it("is ignored with the switch off", () => {
    const state = emptyMatch(1000, DEFAULT_CONFIG);
    const agent = seat(state, "a", 0);
    expect(applyInput(state, order("soldiers"), 1000, defaultAllocator, []).error).toBeNull();
    expect("brood" in agent).toBe(false);
  });
});

describe("soldiers outside a squad are guards or fighters, never foragers", () => {
  it("holds through role rebalancing early and late in the match", () => {
    for (const tick of [0, V4.matchTicks - 1]) {
      const state = emptyMatch(tick, V4);
      for (let i = 0; i < 12; i += 1) addAnt(state, 0, 6 + (i % 4), 20 + Math.floor(i / 4), { caste: "soldier", role: i % 3 === 0 ? "guard" : "forager" });
      for (let i = 0; i < 4; i += 1) addAnt(state, 0, 12, 20 + i, { caste: "worker" });
      rebalanceRoles(state);
      const soldiers = state.ants.filter((a) => a.caste === "soldier");
      expect(soldiers.every((a) => a.role === "guard" || a.role === "fighter")).toBe(true);
      expect(soldiers.filter((a) => a.role === "guard").length).toBeLessThanOrEqual(V4.guardCount);
      expect(state.ants.some((a) => a.caste === "worker" && a.role === "forager")).toBe(true);
    }
  });

  it("hatches a soldier as a fighter", () => {
    const state = readyToHatch(V4.castes!.soldierCost);
    seat(state, "a", 0, "soldiers");
    hatchOnce(state);
    expect(state.ants).toHaveLength(1);
    expect(state.ants[0]).toMatchObject({ caste: "soldier", role: "fighter" });
  });

  it("sends a surplus soldier guard to fighter, not forager", () => {
    const state = emptyMatch(0, V4);
    const qx = Math.floor(state.colonies[0].queenX / SUB);
    const qy = Math.floor(state.colonies[0].queenY / SUB);
    for (let i = 0; i < 5; i += 1) addAnt(state, 0, qx + 1 + i, qy, { caste: "soldier", role: "guard" });
    rebalanceRoles(state);
    expect(state.ants.filter((a) => a.role === "guard")).toHaveLength(V4.guardCount);
    expect(state.ants.filter((a) => a.role === "fighter")).toHaveLength(5 - V4.guardCount);
  });

  it("keeps soldiers fighting when fighters are in surplus, and steps workers back to forage", () => {
    const state = emptyMatch(0, V4);
    const qx = Math.floor(state.colonies[0].queenX / SUB);
    const qy = Math.floor(state.colonies[0].queenY / SUB);
    for (let i = 0; i < V4.guardCount; i += 1) addAnt(state, 0, qx, qy + i, { caste: "worker", role: "guard" });
    const soldiers = [0, 1, 2, 3].map((i) => addAnt(state, 0, qx + 8, qy + i, { caste: "soldier", role: "fighter" }));
    const workers = [0, 1, 2, 3].map((i) => addAnt(state, 0, qx + 9, qy + i, { caste: "worker", role: "fighter" }));
    rebalanceRoles(state);
    expect(soldiers.every((a) => a.role === "fighter")).toBe(true);
    expect(workers.every((a) => a.role === "forager")).toBe(true);
  });
});

describe("the public rules", () => {
  it("is what a Game plays by default", () => {
    expect(new Game().simConfig).toEqual(newMatchConfig(PUBLIC_CONFIG));
  });
});

describe("a caste config's log round trip", () => {
  it("writes the caste config's header, parses it, and replays to the same state hash", () => {
    const seed = 21, config = playable(V4);
    let state = createMatch(seed, config);
    const lines = [headerLine(seed, config)];
    const script: Record<number, SimInput[]> = {
      0: [
        { type: "join", agentId: "a", colony: 0 },
        { type: "join", agentId: "b", colony: 1 },
      ],
      10: [{ type: "order", agentId: "a", order: { kind: "forage" }, brood: "soldiers" }],
      20: [{ type: "order", agentId: "b", order: { kind: "hold" }, brood: "workers" }],
    };
    while (state.tick < 1500) {
      const inputs = script[state.tick] ?? (state.tick % 300 === 0 ? [{ type: "observe", agentId: "a" }, { type: "observe", agentId: "b" }] : []);
      if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
      state = step(state, inputs).state;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ rulesVersion: RULES_VERSION });
    expect(parseLog(lines).header.config.castes).toEqual(CASTE_RULES);
    expect(stateHash(replay(lines, state.tick))).toBe(stateHash(state));
    expect(state.ants.some((a) => a.caste === "soldier")).toBe(true);
  }, 60_000);

  it("refuses a header whose version disagrees with its config", () => {
    const bad = JSON.stringify({ ...JSON.parse(headerLine(1, playable(V4))), rulesVersion: 3 });
    expect(() => parseLog([bad])).toThrow(/rules version 3/);
  });
});
