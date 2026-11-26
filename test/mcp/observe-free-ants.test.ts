import { expect, it } from "vitest";
import { observeInfo } from "../../src/mcp/game.js";
import { applyInput, defaultAllocator } from "../../src/sim/agents.js";
import { COLONY_NAMES, rulesConfig } from "../../src/sim/config.js";
import type { SimInput } from "../../src/sim/types.js";
import { addAnt, emptyMatch } from "../sim/fixtures.js";
import { startHarness, TEST_MCP_CONFIG } from "./harness.js";

const rules = rulesConfig("redesign");
const site = { tileX: 8, tileY: 24 };

it("reports the same free pool as each kind of count mark from the same tick", () => {
  const state = emptyMatch(100, { ...rules, localAnts: undefined }); // Planner guards cannot be recruited.
  const agentId = "seat";
  applyInput(state, { type: "join", agentId, colony: 0 }, state.tick, defaultAllocator, []);
  addAnt(state, 0, 8, 24, { caste: undefined }); // Pre-caste ants recruit as workers.
  addAnt(state, 0, 8, 24, { caste: "worker", claim: 999 }); // Its mark is gone.
  addAnt(state, 0, 8, 24, { caste: "soldier" });
  addAnt(state, 0, 8, 24, { caste: "worker", flyer: true });
  addAnt(state, 0, 8, 24, { caste: "worker", flyer: true, air: { destX: 0, destY: 0, hovering: false, released: true } });
  addAnt(state, 0, 8, 24, { role: "guard" });
  addAnt(state, 0, 8, 24, { hp: 0 });
  addAnt(state, 0, 8, 24, { squad: "mate" });
  addAnt(state, 1, 8, 24, { caste: "soldier" });
  const free = observeInfo(state, agentId, state.config).freeAntsByCaste!;
  expect(free).toEqual({ worker: 2, soldier: 1, flyer: 1 });
  for (const [verb, caste, eligible] of [
    ["ATTACK", "soldier", free.soldier], ["GATHER", "worker", free.worker], ["DEFEND", "flyer", free.flyer],
    ["FORAGE", "any", free.worker], ["ATTACK", "any", free.worker + free.soldier],
  ] as const) {
    const input: SimInput = { type: "count_mark", agentId, ...site, verb, caste, count: 64 };
    const reply = applyInput(structuredClone(state), input, state.tick, defaultAllocator, []);
    expect(reply.error).toBeNull();
    expect(reply.countMarkAcceptance?.availability.freeAntsNow).toBe(eligible);
  }
});

it("reports only the seated colony's free ants and its own marks on successive observes", async () => {
  const config = { ...rules, squadSize: 0, antSpeedTilesPerSecond: 0, commandFloorTicks: 1 };
  const state = emptyMatch(0, config);
  for (let i = 0; i < 7; i++) addAnt(state, 0, 8, 24, { caste: "soldier" });
  for (let i = 0; i < 3; i++) addAnt(state, 1, 40, 20, { caste: "worker" });
  const h = await startHarness({ simConfig: config, state });
  try {
    const own = await h.connect(), mate = await h.connect(), other = await h.connect();
    for (const [seat, colony] of [[own, 0], [mate, 0], [other, 1]] as const) {
      const joined = await seat.call("join", { colony: COLONY_NAMES[colony] });
      expect(joined.isError, joined.text).toBe(false);
    }
    const defend = await mate.call("count_mark", { ...site, verb: "DEFEND", caste: "soldier", count: 5 });
    expect(defend.isError, defend.text).toBe(false);
    const before = await own.call("observe");
    expect(before.data.freeAntsByCaste).toEqual({ worker: 0, soldier: 2, flyer: 0 });
    expect(before.data.view.myMarks).toEqual([]);
    const attack = await own.call("count_mark", { ...site, verb: "ATTACK", caste: "soldier", count: 64 });
    expect(attack.data.countMark).toMatchObject({ claimed: 2, claimedAnts: 5, freeAntsNow: before.data.freeAntsByCaste.soldier });
    const lastCommand = h.game.match!.state.agents[0]!.lastCommandTick;
    for (const args of [{}, { map: true, since: 0 }]) {
      const after = await own.call("observe", args);
      expect(after.data.freeAntsByCaste).toEqual({ worker: 0, soldier: 0, flyer: 0 });
      expect(after.data.view.myMarks).toMatchObject([{ markId: attack.data.countMark.markId, count: 64, claimed: 2 }]);
      expect(h.game.match!.state.agents[0]!.lastCommandTick).toBe(lastCommand);
    }
    const opposite = await other.call("observe");
    expect(opposite.data.freeAntsByCaste).toEqual({ worker: 3, soldier: 0, flyer: 0 });
    expect(opposite.data.view.myMarks).toEqual([]);
  } finally { await h.close(); }
});

it("withholds the free pool when rate limited and reports the current pool on the next admitted observe", async () => {
  const config = { ...rules, squadSize: 0 };
  const state = emptyMatch(0, config);
  addAnt(state, 0, 8, 24, { caste: "worker" });
  const h = await startHarness({ state, simConfig: config, mcpConfig: { ...TEST_MCP_CONFIG, callsPerSecond: 2 } });
  try {
    const seat = await h.connect();
    await seat.call("join", { colony: COLONY_NAMES[0] });
    const first = await seat.call("observe");
    expect(first.data.freeAntsByCaste).toEqual({ worker: 1, soldier: 0, flyer: 0 });
    addAnt(h.game.match!.state, 0, 8, 24, { caste: "soldier" });
    const refused = await seat.call("observe");
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ error: { code: "call_rate" }, retryAfterMs: 1000,
      tick: first.data.view.tick, nextCommandTick: first.data.view.nextCommandTick,
      status: first.data.status, houseIdleSeconds: first.data.houseIdleSeconds });
    expect(refused.data).not.toHaveProperty("freeAntsByCaste");
    h.clock.now += refused.data.retryAfterMs;
    const next = await seat.call("observe");
    expect(next.isError, next.text).toBe(false);
    expect(next.data.freeAntsByCaste).toEqual({ worker: 1, soldier: 1, flyer: 0 });
  } finally { await h.close(); }
});
