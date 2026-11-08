import { describe, expect, it } from "vitest";
import { createMatch } from "../../src/sim/map.js";
import type { SimState } from "../../src/sim/types.js";
import { addAnt, emptyMatch, run, send, squadOf } from "./fixtures.js";

function colonyWith(counts: [number, number]): SimState {
  const state = emptyMatch(0);
  state.food.fill(0);
  for (const colony of [0, 1] as const) {
    for (let i = 0; i < counts[colony]; i += 1) addAnt(state, colony, colony === 0 ? 5 : 58, 5 + i);
  }
  return state;
}

function squadTotals(state: SimState): [number, number] {
  const totals: [number, number] = [0, 0];
  for (const agent of state.agents) totals[agent.colony] += agent.squad.length;
  return totals;
}

function living(state: SimState): [number, number] {
  return [state.ants.filter((a) => a.colony === 0).length, state.ants.filter((a) => a.colony === 1).length];
}

describe("joins, colony choice and squad supply", () => {
  it("gives squads of up to six from existing ants, never more than half the colony, filling in join order", () => {
    const state = colonyWith([10, 10]);
    const before = state.nextAntId;
    let out = send(state, [
      { type: "join", agentId: "a", colony: 0 },
      { type: "join", agentId: "b", colony: 1 },
      { type: "join", agentId: "c", colony: 0 },
    ]);
    let s = out.state;
    expect(s.agents.map((a) => [a.id, a.colony])).toEqual([["a", 0], ["b", 1], ["c", 0]]);
    expect(squadOf(s, "a")).toHaveLength(5);
    expect(squadOf(s, "c")).toHaveLength(0);
    expect(s.nextAntId).toBe(before);

    // Spare ants become available: a fills to six first, then c.
    for (let i = 0; i < 2; i += 1) addAnt(s, 0, 5, 30 + i);
    s = send(s, []).state;
    expect(squadOf(s, "a")).toHaveLength(6);
    expect(squadOf(s, "c")).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) addAnt(s, 0, 5, 33 + i);
    s = send(s, []).state;
    expect(squadOf(s, "c")).toHaveLength(1);

    for (let i = 0; i < 50; i += 1) {
      out = send(s, []);
      s = out.state;
      const totals = squadTotals(s);
      const alive = living(s);
      expect(totals[0]).toBeLessThanOrEqual(Math.floor(alive[0] / 2));
      expect(totals[1]).toBeLessThanOrEqual(Math.floor(alive[1] / 2));
    }
  });

  it("gives no squad when a colony has no spare ants", () => {
    const state = colonyWith([0, 10]);
    const s = send(state, [{ type: "join", agentId: "a", colony: 0 }]).state;
    expect(s.agents[0]?.colony).toBe(0);
    expect(squadOf(s, "a")).toHaveLength(0);
  });

  it("releases the latest squad's ants when deaths would leave squads above half the colony", () => {
    const state = colonyWith([12, 0]);
    let s = send(state, [{ type: "join", agentId: "a" }]).state;
    expect(squadOf(s, "a")).toHaveLength(6);
    const spare = s.ants.filter((a) => a.colony === 0 && a.squad === null).slice(0, 4).map((a) => a.id);
    s.ants = s.ants.filter((a) => !spare.includes(a.id));
    s = send(s, []).state;
    expect(squadTotals(s)[0]).toBeLessThanOrEqual(Math.floor(living(s)[0] / 2));
    expect(squadOf(s, "a")).toHaveLength(4);
  });

  it("honours named colonies regardless of balance", () => {
    const s = send(colonyWith([20, 20]), [
      { type: "join", agentId: "x", colony: 1 },
      { type: "join", agentId: "y", colony: 1 },
      { type: "join", agentId: "z", colony: 1 },
      { type: "join", agentId: "w", colony: 1 },
    ]).state;
    expect(s.agents.map((a) => a.colony)).toEqual([1, 1, 1, 1]);
  });

  it("keeps unnamed joins balanced with colony 0 on every tie", () => {
    const s = send(colonyWith([20, 20]), Array.from({ length: 8 }, (_, i) => ({ type: "join" as const, agentId: `unnamed-${i}` }))).state;
    expect(s.agents.map((a) => a.colony)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    const afterNamed = send(s, [
      { type: "join", agentId: "named", colony: 0 },
      { type: "join", agentId: "balanced" },
    ]).state;
    expect(afterNamed.agents.at(-1)?.colony).toBe(1);
  });

  it("keeps operator placement ahead of named colony and balance", () => {
    const s = send(colonyWith([20, 20]), [
      { type: "join", agentId: "first", placement: 1, colony: 0 },
      { type: "join", agentId: "second", placement: 1, colony: 0 },
    ]).state;
    expect(s.agents.map((a) => a.colony)).toEqual([1, 1]);
  });

  it("balances a sub-agent join carrying parentAgentId by the same rule", () => {
    const s = send(colonyWith([20, 20]), [
      { type: "join", agentId: "a", colony: 0 },
      { type: "join", agentId: "b", parentAgentId: "a" },
      { type: "join", agentId: "c", parentAgentId: "a", colony: 0 },
    ]).state;
    expect(s.agents.map((a) => a.colony)).toEqual([0, 1, 0]);
    expect(s.agents[1]?.parentAgentId).toBe("a");
  });

  it("assigns agents queued before the match their colony and squad at match start by the same rule", () => {
    const out = send(createMatch(5), [
      { type: "join", agentId: "q1", colony: 1, modelLabel: "model-one" },
      { type: "join", agentId: "q2" },
    ]);
    expect(out.state.tick).toBe(1);
    expect(out.state.agents.map((a) => a.colony)).toEqual([1, 0]);
    expect(squadOf(out.state, "q1")).toHaveLength(6);
    expect(squadOf(out.state, "q2")).toHaveLength(6);
    expect(out.results.every((r) => r.ok)).toBe(true);
  });

  it("reports joins with their model label and every call in step events, never in a view", () => {
    let out = send(createMatch(5), [{ type: "join", agentId: "a", modelLabel: "secret-model-9" }]);
    expect(out.events).toContainEqual(expect.objectContaining({ type: "agent_join", agentId: "a", modelLabel: "secret-model-9" }));
    expect(out.events).toContainEqual(expect.objectContaining({ type: "agent_call", agentId: "a", call: "join" }));
    const views = [out.results[0]!.view];
    out = send(out.state, [{ type: "observe", agentId: "a" }]);
    expect(out.events).toContainEqual(expect.objectContaining({ type: "agent_call", agentId: "a", call: "observe" }));
    views.push(out.results[0]!.view);
    for (const view of views) {
      const text = JSON.stringify(view);
      expect(text).not.toContain("secret-model-9");
      expect(text).not.toContain("agent_call");
      expect(text).not.toContain("agent_join");
    }
  });
});

describe("the 90 s squad timer", () => {
  it("keeps the squad on its last orders for 90 s after a call, then returns it and leaves the agent idle", () => {
    let s = send(createMatch(5), [
      { type: "join", agentId: "a" },
      { type: "order", agentId: "a", order: { kind: "hold" } },
    ]).state;
    const held = squadOf(s, "a").map((a) => ({ id: a.id, x: a.x, y: a.y }));
    expect(held).toHaveLength(6);
    // The call was on tick 0; ticks 1 to 899 pass without one.
    s = run(s, 899).state;
    expect(s.tick).toBe(900);
    // Still held, unmoved, on its last order, untouched by the house bot.
    for (const ant of held) {
      const now = s.ants.find((a) => a.id === ant.id)!;
      expect(now.squad).toBe("a");
      expect([now.x, now.y]).toEqual([ant.x, ant.y]);
    }
    expect(s.agents[0]?.order).toEqual({ kind: "hold" });
    // Tick 900 is 90 s after the call: the squad returns to the colony.
    const lapse = send(s, []);
    s = lapse.state;
    expect(lapse.events).toContainEqual(expect.objectContaining({ type: "squad_released", agentId: "a" }));
    expect(squadOf(s, "a")).toHaveLength(0);
    expect(s.agents[0]?.idle).toBe(true);
    for (const ant of held) expect(s.ants.find((a) => a.id === ant.id)?.squad ?? null).toBeNull();
  });

  it("gives a fresh squad on the next call, or on a rejoin with the token", () => {
    for (const call of ["observe", "rejoin"] as const) {
      let s = send(createMatch(5), [{ type: "join", agentId: "a" }]).state;
      s = run(s, 900).state;
      expect(s.agents[0]?.idle).toBe(true);
      const out = send(s, [{ type: call, agentId: "a" }]);
      expect(out.results[0]?.ok).toBe(true);
      expect(out.state.agents[0]?.idle).toBe(false);
      expect(squadOf(out.state, "a")).toHaveLength(6);
    }
  });
});

describe("refill", () => {
  it("refills toward six from existing non-squad ants only, in join order, keeping fewer when none are spare", () => {
    const state = colonyWith([14, 14]);
    let s = send(state, [
      { type: "join", agentId: "first", colony: 0 },
      { type: "join", agentId: "other", colony: 1 },
      { type: "join", agentId: "second", colony: 0 },
    ]).state;
    expect(squadOf(s, "first")).toHaveLength(6);
    expect(squadOf(s, "second")).toHaveLength(1);
    const nextId = s.nextAntId;
    // Two of first's ants die: the colony falls to 12, so squads may hold 6.
    const dead = squadOf(s, "first").slice(0, 2).map((a) => a.id);
    s.ants = s.ants.filter((a) => !dead.includes(a.id));
    s = run(s, 2).state;
    expect(squadOf(s, "first")).toHaveLength(5);
    expect(squadOf(s, "second")).toHaveLength(1);
    expect(s.nextAntId).toBe(nextId);
    for (const ant of squadOf(s, "first")) expect(ant.id).toBeLessThan(nextId);
  });
});
