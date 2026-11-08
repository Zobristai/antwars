// The live tick and replay re-run advance the match in place, with play identical to the pure step.
import { describe, expect, it } from "vitest";
import { SpectatorRecorder } from "../../src/live/model.js";
import { playScripted } from "../../src/live/record.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/config.js";
import { Game } from "../../src/mcp/game.js";
import { PUBLIC_CONFIG, rulesConfig, type SimConfig } from "../../src/sim/config.js";
import { parseLog, stateHash, terminalAt } from "../../src/sim/log.js";
import { cloneState, createMatch } from "../../src/sim/map.js";
import { advance, prepareInitialPointRests, step } from "../../src/sim/step.js";
import { playable } from "../playable.js";
import { HISTORICAL_CONFIG } from "./fixtures.js";

const CONFIGS: readonly [string, SimConfig][] = [
  ["public rules", playable(PUBLIC_CONFIG)],
  ["redesign rules (soft separation, point arrival, local ants)", playable(rulesConfig("redesign"))],
];

describe("advance runs step's tick in place", () => {
  it.each(CONFIGS)("%s: every tick's state, events and results equal step's, and step leaves its input unchanged", (_name, config) => {
    const lines = playScripted({ seed: 642, config, agents: 2, ticks: 600, attack: true }).lines;
    const log = parseLog(lines);
    let pure = createMatch(log.header.seed, log.header.config);
    const live = createMatch(log.header.seed, log.header.config);
    prepareInitialPointRests(pure);
    prepareInitialPointRests(live);
    while (pure.result === null && pure.tick < 600) {
      const tick = pure.tick, inputs = log.ticks.get(tick) ?? [];
      const before = stateHash(pure);
      const expected = step(pure, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      expect(stateHash(pure)).toBe(before);
      const actual = advance(live, inputs, undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
      expect(actual.state).toBe(live);
      expect(stateHash(live)).toBe(stateHash(expected.state));
      expect(actual.events).toEqual(expected.events);
      expect(actual.results).toEqual(expected.results);
      pure = expected.state;
    }
    expect(pure.tick).toBeGreaterThan(100);
  }, 120_000);

  it("a spectator recorder's starting board is unchanged after its state advances", () => {
    const state = createMatch(7, playable(PUBLIC_CONFIG));
    const recorder = new SpectatorRecorder(state);
    const full = recorder.initialFull();
    for (let i = 0; i < 50; i += 1) recorder.record(advance(state));
    expect(state.tick).toBe(50);
    expect(recorder.initialFull()).toEqual(full);
  });
});

describe("the live tick's idle end, advanced in place", () => {
  async function seated() {
    const logs: string[] = [];
    const game = new Game({ mcpConfig: { ...DEFAULT_MCP_CONFIG, callsPerSecond: 100 },
      simConfig: { ...playable(HISTORICAL_CONFIG), ticksPerSecond: 10, commandIdleTicks: 1800, matchTicks: 10_000, startAnts: 0 }, onLogLine: line => logs.push(line),
      slot: { identityOf: async () => undefined, locate: async () => undefined } });
    const seats = ([0, 1] as const).map(colony => ({ identityId: `team-${colony}`, displayName: `Team ${colony}`, colony, seat: 1 }));
    game.seatLobby("idle-lobby", seats, "1v1");
    for (const seat of seats) await game.joinSeated(seat.identityId, undefined, seat.seat);
    game.startMatch(429);
    game.tick();
    // The default 300 s idle allowance at 10 ticks per second: a seat silent since tick 0 reaches it at tick 3000.
    game.match!.state.tick = 2999;
    const [silent, active] = game.match!.state.agents;
    // Only the active seat calls before the deadline tick; the silent seat last counted at tick 0.
    const first = game.call(active!.id, { type: "observe", agentId: active!.id });
    expect(game.tick()!.state.result).toBeNull();
    await first;
    return { game, logs, silent: silent!, active: active! };
  }

  /** The deadline tick replayed with the pure step from a copy of its start state, as logged. */
  function expectedFrom(start: ReturnType<typeof cloneState>, logs: readonly string[]) {
    const log = parseLog(logs), tick = start.tick;
    return step(start, log.ticks.get(tick) ?? [], undefined, undefined, undefined, terminalAt(log, tick), log.houseActive.has(tick));
  }

  it("a seat that stays silent through its deadline tick goes idle and its colony loses, from the tick's true start state", async () => {
    const { game, logs, silent, active } = await seated();
    const start = cloneState(game.match!.state);
    const call = game.call(active.id, { type: "observe", agentId: active.id });
    const terminal = game.tick()!;
    await call;
    expect(terminal.state.result).toEqual({ winner: active.colony, reason: "idle", decidedBy: "idle", tick: 3000 });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ tick: 3000, idle: [silent.colony] });
    expect(stateHash(terminal.state)).toBe(stateHash(expectedFrom(start, logs).state));
    expect(game.tick()).toBeNull();
  });

  it("a seat whose call is accepted on its deadline tick is saved and the match plays on unchanged", async () => {
    const { game, logs, silent, active } = await seated();
    const start = cloneState(game.match!.state);
    const calls = [silent, active].map(agent => game.call(agent.id, { type: "observe", agentId: agent.id }));
    const out = game.tick()!;
    await Promise.all(calls);
    expect(out.state.result).toBeNull();
    expect(JSON.parse(logs.at(-1)!)).not.toHaveProperty("idle");
    expect(out.state.tick).toBe(3001);
    expect(stateHash(out.state)).toBe(stateHash(expectedFrom(start, logs).state));
  });
});
