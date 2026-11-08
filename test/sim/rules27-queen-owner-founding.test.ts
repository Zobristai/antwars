import { describe, expect, it } from "vitest";
import { SUB, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { newMatchConfig } from "../../src/sim/gridScale.js";
import { headerLine, replay, stateHash, tickLine } from "../../src/sim/log.js";
import { createMatch } from "../../src/sim/map.js";
import { step } from "../../src/sim/step.js";
import type { QueenState, SimInput, SimState } from "../../src/sim/types.js";

/**
 * In rules 27 a queen founded with found_queen is owned by
 * the agent whose call founded her, and replaying the match log reproduces that owner.
 * Today's founding path is in the capture at d332b049 (foundQueen takes the
 * colony, not the founder, and appends a queen with no owner field). Rules 26 keeps that
 * queen record exactly. Starting and house-founded queens are tested elsewhere (draw and seat
 * claim), so nothing here depends on who owns them.
 */

const SEED = 4590;
const TICKS = 30;

/** Founding opens at once, costs nothing and needs only one tile of spacing, so a log of inputs alone reaches it. */
function config(): SimConfig {
  const base = rulesConfig("redesign");
  return newMatchConfig({ ...base, commandFloorTicks: 1, matchTicks: 1000,
    queenFounding: { ...base.queenFounding!, firstFoundTick: 0, cost: 0, minDistanceTiles: 1, cooldownTicks: 2 } });
}

/** A tile colony 0 holds at the start, at least the founding spacing from its first queen. */
function heldSite(state: SimState): { tileX: number; tileY: number } {
  const c = state.config, queen = state.colonies[0].queens![0]!;
  const qx = Math.floor(queen.queenX / SUB), qy = Math.floor(queen.queenY / SUB);
  const t = state.owner.findIndex((owner, i) => owner === 0 &&
    (i % c.mapWidth - qx) ** 2 + (Math.floor(i / c.mapWidth) - qy) ** 2 >= (c.queenFounding!.minDistanceTiles + 1) ** 2);
  expect(t).toBeGreaterThanOrEqual(0);
  return { tileX: t % c.mapWidth, tileY: Math.floor(t / c.mapWidth) };
}

const joins: SimInput[] = [{ type: "join", agentId: "a", placement: 0 }, { type: "join", agentId: "b", placement: 0 }, { type: "join", agentId: "c", placement: 1 }];
const founded = (state: SimState): QueenState[] => state.colonies[0].queens!.filter((q) => q.starting !== true && q.id > 0);

/** Play TICKS ticks with b founding at tick 1, recording every non-empty tick as the server's log does. */
function play(cfg: SimConfig) {
  const lines = [headerLine(SEED, cfg)];
  let state = createMatch(SEED, cfg);
  let site: { tileX: number; tileY: number } | null = null;
  const results: { tick: number; ok: boolean }[] = [];
  while (state.tick < TICKS) {
    let inputs: SimInput[] = [];
    if (state.tick === 0) inputs = joins;
    if (state.tick === 1) { site = heldSite(state); inputs = [{ type: "found_queen", agentId: "b", ...site }]; }
    if (inputs.length > 0) lines.push(tickLine(state.tick, inputs));
    const out = step(state, inputs);
    if (state.tick === 1) results.push({ tick: 1, ok: out.results[0]!.ok });
    state = out.state;
  }
  return { lines, state, site: site!, results };
}

describe("rules 27: the founder owns a founded queen (founding part)", () => {
  it("records the agent whose found_queen call founded her as her owner", () => {
    const live = play(config());
    expect(live.results).toEqual([{ tick: 1, ok: true }]);
    const queens = founded(live.state);
    expect(queens).toHaveLength(1);
    expect(queens[0]!.owner).toBe("b");
    expect(queens[0]!.foundedTick).toBe(1);
  });

  it("gives a refused found_queen no owner and creates no queen", () => {
    let state = createMatch(SEED, config());
    state = step(state, joins).state;
    const before = state.colonies[0].queens!.length;
    const out = step(state, [{ type: "found_queen", agentId: "a", tileX: -1, tileY: -1 }]);
    expect(out.results[0]).toMatchObject({ ok: false, error: { code: "bad_order" } });
    expect(out.state.colonies[0].queens).toHaveLength(before);
  });

  it("each founder owns the queen it founded when two agents of one colony found", () => {
    const cfg = config();
    let state = step(createMatch(SEED, cfg), joins).state;
    const first = heldSite(state);
    state = step(state, [{ type: "found_queen", agentId: "a", ...first }]).state;
    state.tick += cfg.queenFounding!.cooldownTicks;
    // A second site for colony 0, clear of both of its queens.
    const c = cfg, second = state.owner.findIndex((owner, i) => owner === 0 && state.colonies[0].queens!.every((q) =>
      (i % c.mapWidth - Math.floor(q.queenX / SUB)) ** 2 + (Math.floor(i / c.mapWidth) - Math.floor(q.queenY / SUB)) ** 2 >= (c.queenFounding!.minDistanceTiles + 1) ** 2));
    expect(second).toBeGreaterThanOrEqual(0);
    const out = step(state, [{ type: "found_queen", agentId: "b", tileX: second % c.mapWidth, tileY: Math.floor(second / c.mapWidth) }]);
    expect(out.results[0]!.ok).toBe(true);
    expect(founded(out.state).map((q) => q.owner)).toEqual(["a", "b"]);
  });

  it("replaying the match log reproduces the same owner and state", () => {
    const live = play(config());
    const replayed = replay(live.lines, TICKS);
    expect(founded(replayed).map((q) => q.owner)).toEqual(["b"]);
    expect(stateHash(replayed)).toBe(stateHash(live.state));
  });
});

