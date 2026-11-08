/**
 * When the stream setup carries commandIdleTicks, an accepted set_brood
 * leaves a streamed or replayed agent's projected command tick alone, as observe does, while its ordinary call
 * clocks advance. Every other call, the refused-join exemption, clock seeding and the clock wire keep their existing
 * rule (apply call branch, constructor and initialFull).
 *
 * The set_brood call event is added to the recorded tick at the stream level, as the recorder's agent_call mapping
 * passes the sim's call kind through unchanged (src/live/model.ts); the sim input itself is tested with the set_brood
 * command.
 */
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, isIdle, type StreamAgent, type StreamMessage } from "../../src/live/format.ts";
import { SpectatorRecorder, SpectatorState } from "../../src/live/model.ts";
import { rulesConfig } from "../../src/sim/config.ts";
import { createMatch } from "../../src/sim/map.ts";
import { step } from "../../src/sim/step.ts";
import type { SimConfig } from "../../src/sim/config.ts";
import type { SimInput, SimState } from "../../src/sim/types.ts";

import { playable } from "../playable.ts";

const roundTrip = (message: StreamMessage) => decodeMessage(encodeMessage(message));

/** The call event the recorder emits for a set_brood agent_call by agent 0. */
const setBrood = (accepted: boolean) => ({ kind: "call" as const, agent: 0, call: "set_brood" as const, accepted });

/** One scripted tick: the sim inputs, and any set_brood call events the recorded tick carries. */
type ScriptTick = { readonly inputs: readonly SimInput[]; readonly setBrood?: readonly boolean[] };

/** Plays the script live: each recorded tick goes over the wire and onto the board, which is returned with every encoded message. */
function play(config: SimConfig, script: readonly ScriptTick[], check?: (board: SpectatorState, state: SimState) => void) {
  let state = createMatch(51, playable(config));
  const recorder = new SpectatorRecorder(state);
  const opening: StreamMessage = { ...recorder.initial(), full: recorder.initialFull() };
  const encoded = [encodeMessage(opening)];
  const first = decodeMessage(encoded[0]!);
  const board = new SpectatorState(first.full!, first.tick, first.ants);
  for (const row of script) {
    const out = step(state, row.inputs);
    state = out.state;
    const rec = recorder.record(out);
    const bytes = encodeMessage({ tick: rec.tick, ants: rec.ants, full: null, events: [...rec.events, ...(row.setBrood ?? []).map(setBrood)] });
    encoded.push(bytes);
    board.apply(decodeMessage(bytes));
    check?.(board, state);
  }
  return { board, state, encoded };
}

/** A replay: every stored message decoded and applied to a board opened on the first. */
function replay(encoded: readonly Uint8Array[]): SpectatorState {
  const first = decodeMessage(encoded[0]!);
  const board = new SpectatorState(first.full!, first.tick, first.ants);
  for (const bytes of encoded.slice(1)) board.apply(decodeMessage(bytes));
  return board;
}

const clocks = (a: StreamAgent) => ({ lastCallTick: a.lastCallTick, prevCallTick: a.prevCallTick, lastCommandTick: a.lastCommandTick });

describe("projected command clock ignores set_brood", () => {
  // The redesign constructor supplies commandIdleTicks; a short window lets the IDLE rail lapse within the test.
  const redesign = { ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: 5, commandFloorTicks: 1 };

  it("the redesign constructor supplies the clock; rules27 alone does not", () => {
    expect(rulesConfig("redesign").rules27).toBe(true);
    expect(rulesConfig("redesign").commandIdleTicks).toBeGreaterThan(0);
    const bare = { ...rulesConfig("redesign"), commandIdleTicks: undefined };
    expect(bare.rules27).toBe(true);
    expect(new SpectatorRecorder(createMatch(52, playable(bare))).initialFull().setup).not.toHaveProperty("commandIdleTicks");
  });

  it("an accepted set_brood advances the call clocks but not the command clock, streamed and replayed", () => {
    const script: ScriptTick[] = [
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] }, // record tick 1, event tick 0
      { inputs: [{ type: "order", agentId: "a", order: { kind: "hold" } }] }, // command at 1
      { inputs: [], setBrood: [true] }, // set_brood at 2
      { inputs: [], setBrood: [true] }, // set_brood at 3
      { inputs: [{ type: "observe", agentId: "a" }] }, // observe at 4
      { inputs: [], setBrood: [true] }, // set_brood at 5
    ];
    const seen: ReturnType<typeof clocks>[] = [];
    const { board, encoded } = play(redesign, script, (b) => seen.push(clocks(b.full.agents[0]!)));
    expect(seen).toEqual([
      { lastCallTick: 0, prevCallTick: -1, lastCommandTick: -1 },
      { lastCallTick: 1, prevCallTick: 0, lastCommandTick: 1 },
      { lastCallTick: 2, prevCallTick: 1, lastCommandTick: 1 },
      { lastCallTick: 3, prevCallTick: 2, lastCommandTick: 1 },
      { lastCallTick: 4, prevCallTick: 3, lastCommandTick: 1 },
      { lastCallTick: 5, prevCallTick: 4, lastCommandTick: 1 },
    ]);
    expect(replay(encoded).full.agents).toEqual(board.full.agents);
  });

  it("set_brood calls do not keep an agent off the IDLE rail; the next accepted command does", () => {
    const script: ScriptTick[] = [
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] },
      { inputs: [{ type: "order", agentId: "a", order: { kind: "hold" } }] }, // command at 1
      ...Array.from({ length: 6 }, (): ScriptTick => ({ inputs: [], setBrood: [true] })), // set_brood at 2..7
      { inputs: [{ type: "order", agentId: "a", order: { kind: "hold" } }] }, // command at 8
    ];
    const idle: boolean[] = [];
    const { board } = play(redesign, script, (b, s) => {
      const agent = b.full.agents[0]!;
      // set_brood never reads or writes the simulation's command clock, so the projection stays equal to it on every tick,
      // and the IDLE rail, which reads that clock, stays equal to the simulation's idleness.
      expect(agent.lastCommandTick).toBe(s.agents[0]!.lastCommandTick ?? -1);
      expect(isIdle(agent, b.tick, b.full.setup.idleTicks)).toBe(s.agents[0]!.idle);
      idle.push(isIdle(agent, b.tick, b.full.setup.idleTicks));
    });
    // The window lapsed during the set_brood calls, which did not hold it off.
    expect(idle).toContain(true);
    expect(board.full.agents[0]!.lastCallTick).toBe(8);
  });

  it("a refused set_brood advances only the call clocks, as any refused call does", () => {
    const script: ScriptTick[] = [
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] },
      { inputs: [{ type: "order", agentId: "a", order: { kind: "hold" } }] },
      { inputs: [], setBrood: [false] },
    ];
    const { board } = play(redesign, script);
    expect(clocks(board.full.agents[0]!)).toEqual({ lastCallTick: 2, prevCallTick: 1, lastCommandTick: 1 });
  });

  it("every other call, the refused-join exemption and the clock wire keep the captured rule", () => {
    const script: ScriptTick[] = [
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] },
      { inputs: [{ type: "observe", agentId: "a" }] },
      { inputs: [{ type: "rejoin", agentId: "a" }] },
      { inputs: [{ type: "mark", agentId: "a", words: ["INVALID"] }] },
      { inputs: [], setBrood: [true] },
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] }, // a duplicate join is refused and leaves the clocks alone
      { inputs: [{ type: "order", agentId: "a", order: { kind: "hold" } }] },
      { inputs: [], setBrood: [true] },
      { inputs: [] },
    ];
    const { board, encoded } = play(redesign, script, (b, s) => {
      const agent = b.full.agents[0]!;
      expect(agent.lastCommandTick).toBe(s.agents[0]!.lastCommandTick ?? -1);
      expect(isIdle(agent, b.tick, b.full.setup.idleTicks)).toBe(s.agents[0]!.idle);
      // The clock wire: a reconnect snapshot carries the projected clocks as they stand.
      const reconnect = roundTrip(b.message());
      expect(reconnect.full!.agents).toEqual(b.full.agents);
    });
    expect(clocks(board.full.agents[0]!)).toEqual({ lastCallTick: 7, prevCallTick: 6, lastCommandTick: 6 });
    expect(replay(encoded).full.agents).toEqual(board.full.agents);
  });

  it("clock seeding: a recorder opened on a populated state seeds the command clock from the simulation", () => {
    let state = step(createMatch(53, playable(rulesConfig("redesign"))), [{ type: "join", agentId: "a" }]).state;
    state = step(state, [{ type: "order", agentId: "a", order: { kind: "hold" } }]).state;
    state = step(state, [{ type: "observe", agentId: "a" }]).state;
    const recorder = new SpectatorRecorder(state);
    const opening = roundTrip({ ...recorder.initial(), full: recorder.initialFull() });
    expect(opening.full!.agents[0]).toMatchObject({ joinTick: 0, lastCallTick: 2, prevCallTick: -1, lastCommandTick: 1 });
    const board = new SpectatorState(opening.full!, opening.tick, opening.ants);
    const out = step(state, []);
    const rec = recorder.record(out);
    board.apply(roundTrip({ tick: rec.tick, ants: rec.ants, full: null, events: [...rec.events, setBrood(true)] }));
    expect(clocks(board.full.agents[0]!)).toEqual({ lastCallTick: 3, prevCallTick: 2, lastCommandTick: 1 });
  });

  it("without commandIdleTicks, set_brood advances the call clocks and no command clock is projected", () => {
    const bare = { ...rulesConfig("redesign"), terrain: undefined, commandIdleTicks: undefined };
    const script: ScriptTick[] = [
      { inputs: [{ type: "join", agentId: "a", placement: 0 }] },
      { inputs: [], setBrood: [true] },
    ];
    const { board, encoded } = play(bare, script);
    const agent = board.full.agents[0]!;
    expect(agent).not.toHaveProperty("lastCommandTick");
    expect(clocks(agent)).toEqual({ lastCallTick: 1, prevCallTick: 0, lastCommandTick: undefined });
    expect(replay(encoded).full.agents).toEqual(board.full.agents);
  });
});
